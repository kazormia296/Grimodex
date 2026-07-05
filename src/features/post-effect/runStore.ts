import { create } from "zustand";

/**
 * runStore.ts — PostEffect 実行中 run のグローバル追跡。
 *
 * 各 kouetsu ビューがローカル useState で `running` を持つと、タブ移動や
 * パネルの閉じ開き（= コンポーネント unmount）で状態が消え、実行中なのに
 * ボタンが通常表示へ戻って「終わったのかな？」という誤解を招く
 * （reindexProgressStore と同じ教訓）。run の生存はビューではなく
 * バックエンド (post_effect_runs) が正なので、FE 側の写像もグローバル
 * store に置く。
 *
 * 書き込み元は post-effect/api.ts の runPostEffectInternal に一元化されて
 * おり、ビューが個別に登録する必要はない。読む側:
 *   - 各ビュー: `useIsPostEffectRunning(effectType, scopeType, scopeTargetId)`
 *   - 右下常駐トースト: `usePostEffectRunStore((s) => s.runs)`
 *   - パネルアイコンバッジ: `useAnyPostEffectRunning()`
 *
 * 終端（done/error）を受けても即座に消さず、`outcome` を付けたまま
 * `AUTO_CLEAR_MS` だけ残してから削除する（トーストの完了表示用）。
 * spinner 判定 (`useIsPostEffectRunning`) は outcome 付きを実行中と
 * 見なさない。
 */

export interface ActivePostEffectRun {
  runId: string;
  projectId: string;
  effectType: string;
  scopeType: string;
  scopeTargetId: string | null;
  /** multi 実行のシーン総数（単一シーンは undefined）。 */
  totalScenes?: number;
  /** 0..1 のベストエフォート進捗。 */
  progress: number;
  stage: string;
  /** multi 実行の "3/12" などの補足。 */
  message: string | null;
  startedAt: number;
  /** 終端状態。undefined = 実行中。 */
  outcome?:
    | { kind: "done"; annotationCount: number; summary?: string }
    // キャッシュ短絡 (from_cache): バックエンドは何も実行していない。
    // 成功トーストを持たないビューでも「何も起きなかった」ように見えない
    // よう、終端済みエントリとして常駐トーストに出す。
    | { kind: "cached" }
    | { kind: "error"; error: string };
}

export const AUTO_CLEAR_MS = 4000;

interface PostEffectRunState {
  runs: Record<string, ActivePostEffectRun>;
  begin: (
    run: Omit<
      ActivePostEffectRun,
      "progress" | "stage" | "message" | "startedAt" | "outcome"
    >,
  ) => void;
  updateProgress: (
    runId: string,
    p: { stage: string; progress: number; message?: string | null },
  ) => void;
  /** summary は multi 実行の部分失敗メッセージ（無ければ完全成功）。 */
  complete: (runId: string, annotationCount: number, summary?: string) => void;
  fail: (runId: string, error: string) => void;
  /**
   * from_cache 短絡を終端済み (cached) エントリとして登録する。
   * begin と違い最初から outcome 付きなので spinner 判定
   * (`useIsPostEffectRunning`) には一切乗らず、AUTO_CLEAR_MS 後に消える。
   */
  recordCacheHit: (
    run: Omit<
      ActivePostEffectRun,
      "progress" | "stage" | "message" | "startedAt" | "outcome"
    >,
  ) => void;
  remove: (runId: string) => void;
}

/** 終端後の自動削除タイマー（runId ごと）。 */
const clearTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleClear(runId: string) {
  const prev = clearTimers.get(runId);
  if (prev !== undefined) clearTimeout(prev);
  clearTimers.set(
    runId,
    setTimeout(() => {
      clearTimers.delete(runId);
      usePostEffectRunStore.getState().remove(runId);
    }, AUTO_CLEAR_MS),
  );
}

export const usePostEffectRunStore = create<PostEffectRunState>()(
  (set, get) => ({
    runs: {},
    begin: (run) =>
      set((s) => ({
        runs: {
          ...s.runs,
          [run.runId]: {
            ...run,
            progress: 0,
            stage: "starting",
            message: null,
            startedAt: Date.now(),
          },
        },
      })),
    updateProgress: (runId, p) =>
      set((s) => {
        const cur = s.runs[runId];
        // 追跡していない run（別ウィンドウ等）や終端後の遅延イベントは無視。
        if (!cur || cur.outcome) return s;
        return {
          runs: {
            ...s.runs,
            [runId]: {
              ...cur,
              stage: p.stage,
              progress: p.progress,
              message: p.message ?? cur.message,
            },
          },
        };
      }),
    complete: (runId, annotationCount, summary) => {
      const cur = get().runs[runId];
      // 終端済み (cached 等) は上書きしない: from_cache の合成 done が
      // recordCacheHit 直後に complete を叩いても cached 表示を保つ。
      if (!cur || cur.outcome) return;
      set((s) => ({
        runs: {
          ...s.runs,
          [runId]: {
            ...cur,
            progress: 1,
            outcome: {
              kind: "done",
              annotationCount,
              ...(summary ? { summary } : {}),
            },
          },
        },
      }));
      scheduleClear(runId);
    },
    fail: (runId, error) => {
      const cur = get().runs[runId];
      if (!cur || cur.outcome) return;
      set((s) => ({
        runs: {
          ...s.runs,
          [runId]: { ...cur, outcome: { kind: "error", error } },
        },
      }));
      scheduleClear(runId);
    },
    recordCacheHit: (run) => {
      set((s) => ({
        runs: {
          ...s.runs,
          [run.runId]: {
            ...run,
            progress: 1,
            stage: "done",
            message: null,
            startedAt: Date.now(),
            outcome: { kind: "cached" },
          },
        },
      }));
      scheduleClear(run.runId);
    },
    remove: (runId) =>
      set((s) => {
        if (!(runId in s.runs)) return s;
        const next = { ...s.runs };
        delete next[runId];
        return { runs: next };
      }),
  }),
);

/**
 * 指定スコープの run が実行中か（outcome 付き = 終端済みは除く）。
 * ビューの spinner / ボタン無効化用。scopeTargetId を省略するとスコープ種別
 * だけで判定する。
 */
export function useIsPostEffectRunning(
  effectType: string,
  scopeType: string,
  scopeTargetId?: string | null,
): boolean {
  return usePostEffectRunStore((s) =>
    Object.values(s.runs).some(
      (r) =>
        r.outcome === undefined &&
        r.effectType === effectType &&
        r.scopeType === scopeType &&
        (scopeTargetId === undefined || r.scopeTargetId === scopeTargetId),
    ),
  );
}

/** いずれかの post-effect run が実行中か（パネルアイコンバッジ用）。 */
export function useAnyPostEffectRunning(): boolean {
  return usePostEffectRunStore((s) =>
    Object.values(s.runs).some((r) => r.outcome === undefined),
  );
}
