import { useCallback, useRef, useState } from "react";
import {
  applyPromptVariant,
  buildAbReuseIdentity,
  buildAbSettingsAuthority,
  runAbComparison,
  type AbConfig,
  type AbDispatcher,
  type AbRequest,
  type AbRunResult,
  type AbSurface,
} from "./abHarness";
import { createAbRun, setAbRunChosen, type AbRunSlotRecord } from "./api";
import { snapshotAiAuditWorkspacePath } from "@/features/ai-audit/api";
import { useAiSettingsStore } from "@/features/chat/store";

export interface UseAbComparisonOptions {
  surface: AbSurface;
  /** 永続化先プロジェクト。空なら履歴記録をスキップ (生成・比較は可能)。 */
  projectId?: string | null;
  /** surface 別の実行アダプタ (chat=非ストリーミング / inline=streaming)。 */
  dispatch: AbDispatcher;
}

/** run() に渡す枠 (安定 id + 構成)。基準枠 id は "baseline"。 */
export interface AbRunSlot {
  id: string;
  config: AbConfig;
}

export interface AbComparisonState {
  running: boolean;
  /** 枠 id → 結果。null = まだ結果なし (実行中 / 未生成 / 編集で破棄)。 */
  results: Record<string, AbRunResult | null>;
  /** 採用済みの枠 id。 */
  chosenId: string | null;
  /** 永続化した履歴行 id (記録できた場合のみ)。 */
  recordId: string | null;
}

const IDLE: AbComparisonState = {
  running: false,
  results: {},
  chosenId: null,
  recordId: null,
};

/**
 * N 枠 A/B 比較の orchestration フック。
 * - run(slots): 各枠を (chat=並列 / inline=逐次) 実行 → 結果を id で state へ →
 *   履歴へ保存 (best-effort)。前回と構成が同じ ok 枠は再生成せず使い回す。
 * - adopt(id): 採用枠を記録し、採用テキストを返す (呼び出し側が挿入/送信)。
 * - invalidate(id): その枠の表示結果を破棄する (構成編集で stale 化したとき)。
 *
 * 履歴保存の失敗は比較体験を止めない (recordId が null のまま採用も可能)。
 */
export function useAbComparison({
  surface,
  projectId,
  dispatch,
}: UseAbComparisonOptions) {
  const [state, setState] = useState<AbComparisonState>(IDLE);
  // 最新 run の構成 / 結果を adopt・使い回し判定で参照する ref。
  const lastRunRef = useRef<{
    byId: Record<
      string,
      { config: AbConfig; result: AbRunResult; reuseIdentity: string | null }
    >;
    recordId: string | null;
  } | null>(null);
  // 同期的な実行中フラグ。state.running は setState が非同期なので、連打で run() が
  // 二重発火すると両方が走り N×2 回 LLM を叩いてしまう。ref で即時にガードする。
  const runningRef = useRef(false);

  const reset = useCallback(() => {
    setState(IDLE);
    lastRunRef.current = null;
  }, []);

  /**
   * 1 枠の表示結果を破棄する (構成編集で stale 化したとき)。採用済みだった枠なら
   * 選択も解除する。次の run でその枠だけ再生成される (構成が変わるので使い回されない)。
   */
  const invalidate = useCallback((id: string) => {
    setState((s) => {
      if (s.results[id] == null && s.chosenId !== id) return s;
      const results = { ...s.results, [id]: null };
      return {
        ...s,
        results,
        chosenId: s.chosenId === id ? null : s.chosenId,
      };
    });
    if (lastRunRef.current) {
      const byId = { ...lastRunRef.current.byId };
      delete byId[id];
      // 表示中の枠構成が記録時 (recordId) と乖離する → 採用記録は次の run まで保留する
      // (stale な recordId へ chosen を書き込まない。永続化は best-effort)。
      lastRunRef.current = { byId, recordId: null };
    }
  }, []);

  const run = useCallback(
    async (request: AbRequest, slots: AbRunSlot[]) => {
      // 二重発火ガード: state.running は非同期更新なので、連打で run() が並走しないよう
      // 同期 ref で弾く (並走すると N×2 回 LLM を叩いて課金が倍になる)。
      if (runningRef.current) return;
      runningRef.current = true;
      try {
        const expectedWorkspacePath = snapshotAiAuditWorkspacePath();
        const auditProjectId = projectId?.trim() || null;
        const currentAiSettings = useAiSettingsStore.getState().settings;
        const settingsAuthority =
          currentAiSettings === null
            ? null
            : buildAbSettingsAuthority(currentAiSettings);
        // Reuse is authorized only by the exact project/workspace/final
        // messages/config tuple. Slot id or config equality alone is unsafe
        // when the base prompt or active workspace changed.
        const prev = lastRunRef.current?.byId;
        const reuse = slots.map((slot) => {
          const cached = prev?.[slot.id];
          const messages = applyPromptVariant(
            request.messages,
            slot.config.promptVariant,
          );
          const identity =
            settingsAuthority === null
              ? null
              : buildAbReuseIdentity({
                  projectId: auditProjectId,
                  expectedWorkspacePath,
                  pathId: surface === "chat" ? "ab_chat" : "ab_inline",
                  settingsAuthority,
                  messages,
                  config: slot.config,
                });
          return identity !== null &&
            cached?.result.ok &&
            cached.reuseIdentity === identity
            ? { result: cached.result, identity }
            : null;
        });

        // 使い回す枠は実行中も表示を維持する。
        const initialResults: Record<string, AbRunResult | null> = {};
        slots.forEach((slot, i) => {
          initialResults[slot.id] = reuse[i]?.result ?? null;
        });
        setState({
          running: true,
          results: initialResults,
          chosenId: null,
          recordId: null,
        });

        // inline-ai は共有ストリームイベント (inline-ai:stream-*) と共有 abort flag を
        // 使うため、複数同時に走らせると chunk が混線する → 逐次実行に倒す。
        // chat は非ストリーミングで応答が独立しているので並列で安全。
        const parallel = surface !== "inline";
        let settingsDriftedDuringRun = false;
        const unsubscribeSettings = useAiSettingsStore.subscribe((next) => {
          const nextAuthority =
            next.settings === null
              ? null
              : buildAbSettingsAuthority(next.settings);
          if (nextAuthority !== settingsAuthority) {
            settingsDriftedDuringRun = true;
          }
        });
        const out = await (async () => {
          try {
            return await runAbComparison(
              request,
              slots.map((s) => s.config),
              dispatch,
              {
                parallel,
                reuse,
                audit: {
                  projectId: auditProjectId,
                  pathId: surface === "chat" ? "ab_chat" : "ab_inline",
                  expectedWorkspacePath,
                  settingsAuthority,
                },
              },
            );
          } finally {
            unsubscribeSettings();
          }
        })();

        // Defaults may be consulted lazily by each provider dispatch. If AI
        // settings drifted while slots were running, no single start snapshot
        // can prove the effective route of every result. Keep the results for
        // comparison/history, but make them ineligible for later reuse.
        const settingsAfterRun = useAiSettingsStore.getState().settings;
        const settingsAuthorityStayedStable =
          !settingsDriftedDuringRun &&
          settingsAuthority !== null &&
          settingsAfterRun !== null &&
          buildAbSettingsAuthority(settingsAfterRun) === settingsAuthority;

        const byId: Record<
          string,
          {
            config: AbConfig;
            result: AbRunResult;
            reuseIdentity: string | null;
          }
        > = {};
        const results: Record<string, AbRunResult | null> = {};
        slots.forEach((slot, i) => {
          byId[slot.id] = {
            config: slot.config,
            result: out[i].result,
            reuseIdentity: settingsAuthorityStayedStable
              ? out[i].reuseIdentity
              : null,
          };
          results[slot.id] = out[i].result;
        });

        // 成功枠が 2 つ以上あり projectId があるときだけ履歴を残す (比較が成立した記録)。
        let recordId: string | null = null;
        const okCount = out.filter((s) => s.result.ok).length;
        if (projectId && okCount >= 2) {
          try {
            const row = await createAbRun({
              projectId,
              surface,
              prompt: request.promptSummary ?? summarize(request),
              slots: slots.map((slot, i): AbRunSlotRecord => {
                const result = out[i].result;
                return {
                  slotId: slot.id,
                  provider: slot.config.provider ?? null,
                  model: slot.config.model ?? null,
                  promptVariant: slot.config.promptVariant ?? null,
                  ok: result.ok,
                  response: result.ok ? result.text : result.error,
                };
              }),
            });
            recordId = row.id;
          } catch {
            recordId = null; // best-effort
          }
        }

        lastRunRef.current = { byId, recordId };
        setState({ running: false, results, chosenId: null, recordId });
      } finally {
        runningRef.current = false;
      }
    },
    [dispatch, projectId, surface],
  );

  /**
   * 採用枠を記録し、その枠のテキストを返す。失敗枠を採用しようとしたら null。
   * 履歴保存は best-effort (recordId が無ければ DB 記録はスキップ)。
   */
  const adopt = useCallback(
    async (id: string): Promise<string | null> => {
      const last = lastRunRef.current;
      const entry = last?.byId[id];
      // invalidate 後など、最新 run に無い / 失敗した枠は採用不可。
      if (!entry || !entry.result.ok) return null;

      setState((s) => ({ ...s, chosenId: id }));
      if (projectId && last?.recordId) {
        try {
          await setAbRunChosen(projectId, last.recordId, id);
        } catch {
          /* best-effort */
        }
      }
      return entry.result.text;
    },
    [projectId],
  );

  return { state, run, adopt, reset, invalidate };
}

/** promptSummary 未指定時の簡易要約 (最後の user メッセージ先頭 120 字)。 */
function summarize(request: AbRequest): string {
  const lastUser = [...request.messages]
    .reverse()
    .find((m) => m.role === "user");
  const text = (lastUser?.content ?? request.messages.at(-1)?.content ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 120 ? `${text.slice(0, 120)}…` : text;
}
