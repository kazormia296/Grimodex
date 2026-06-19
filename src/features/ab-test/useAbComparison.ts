import { useCallback, useRef, useState } from "react";
import {
  runAbComparison,
  type AbConfig,
  type AbDispatcher,
  type AbRequest,
  type AbRunResult,
  type AbSurface,
} from "./abHarness";
import { createAbComparison, setAbChosen, type AbChoice } from "./api";

export interface UseAbComparisonOptions {
  surface: AbSurface;
  /** 永続化先プロジェクト。空なら履歴記録をスキップ (生成・比較は可能)。 */
  projectId?: string | null;
  /** surface 別の実行アダプタ (chat=非ストリーミング / inline=streaming)。 */
  dispatch: AbDispatcher;
}

export interface AbComparisonState {
  running: boolean;
  resultA: AbRunResult | null;
  resultB: AbRunResult | null;
  chosen: AbChoice | null;
  /** 永続化した履歴行 id (記録できた場合のみ)。 */
  recordId: string | null;
}

const IDLE: AbComparisonState = {
  running: false,
  resultA: null,
  resultB: null,
  chosen: null,
  recordId: null,
};

/**
 * A/B 比較の orchestration フック。
 * - run(): 2 構成を並列実行 → 結果を state へ → 履歴へ保存 (best-effort)
 * - adopt(): 採用列を記録し、採用テキストを返す (呼び出し側が挿入/送信)
 *
 * 履歴保存の失敗は比較体験を止めない (recordId が null のまま採用も可能)。
 */
export function useAbComparison({
  surface,
  projectId,
  dispatch,
}: UseAbComparisonOptions) {
  const [state, setState] = useState<AbComparisonState>(IDLE);
  // 最新 run の config / result を adopt 時に参照するための ref。
  const lastRunRef = useRef<{
    configA: AbConfig;
    configB: AbConfig;
    resultA: AbRunResult;
    resultB: AbRunResult;
    recordId: string | null;
  } | null>(null);

  const reset = useCallback(() => {
    setState(IDLE);
    lastRunRef.current = null;
  }, []);

  const run = useCallback(
    async (request: AbRequest, configA: AbConfig, configB: AbConfig) => {
      setState({ ...IDLE, running: true });
      // inline-ai は共有ストリームイベント (inline-ai:stream-*) と共有 abort flag を
      // 使うため、2 本同時に走らせると chunk が混線する → 逐次実行に倒す。
      // chat は非ストリーミングで応答が独立しているので並列で安全。
      const parallel = surface !== "inline";
      const { a, b } = await runAbComparison(
        request,
        configA,
        configB,
        dispatch,
        { parallel },
      );

      // 両側成功で projectId があるときだけ履歴を残す (片側失敗は記録しない)。
      let recordId: string | null = null;
      if (projectId && a.ok && b.ok) {
        try {
          const row = await createAbComparison({
            projectId,
            surface,
            prompt: request.promptSummary ?? summarize(request),
            modelA: configA.model ?? null,
            modelB: configB.model ?? null,
            promptVariantA: configA.promptVariant ?? null,
            promptVariantB: configB.promptVariant ?? null,
            responseA: a.text,
            responseB: b.text,
          });
          recordId = row.id;
        } catch {
          recordId = null; // best-effort
        }
      }

      lastRunRef.current = {
        configA,
        configB,
        resultA: a,
        resultB: b,
        recordId,
      };
      setState({
        running: false,
        resultA: a,
        resultB: b,
        chosen: null,
        recordId,
      });
    },
    [dispatch, projectId, surface],
  );

  /**
   * 採用列を記録し、その列のテキストを返す。失敗列を採用しようとしたら null。
   * 履歴保存は best-effort (recordId が無ければ DB 記録はスキップ)。
   */
  const adopt = useCallback(
    async (side: AbChoice): Promise<string | null> => {
      const last = lastRunRef.current;
      if (!last) return null;
      const result = side === "a" ? last.resultA : last.resultB;
      if (!result.ok) return null;

      setState((s) => ({ ...s, chosen: side }));
      if (projectId && last.recordId) {
        try {
          await setAbChosen(projectId, last.recordId, side);
        } catch {
          /* best-effort */
        }
      }
      return result.text;
    },
    [projectId],
  );

  return { state, run, adopt, reset };
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
