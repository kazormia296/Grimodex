import { create } from "zustand";

/**
 * `semantic_reindex_all` の進行表示用 store。
 * Rust 側 `semantic:reindex_progress` event を `useReindexProgressListener` が
 * 受け取り、本 store に流し込む。`ReindexProgressToast` が読んで描画する。
 *
 * `done=true` を受けても即座に消さず、`AUTO_CLEAR_MS` だけ完了メッセージを
 * 出してから状態をリセットする。失敗/エラー時は呼び出し側が `clear()` する。
 */

export interface ReindexProgressPayload {
  /** Added in the Electron semantic migration. Missing on older Tauri builds. */
  projectId?: string;
  /** Caller-generated token used to reject delayed progress from an older run. */
  runId?: string;
  sceneIndex: number;
  sceneId: string;
  totalScenes: number;
  chunksIndexed: number;
  done: boolean;
}

interface ReindexProgressState {
  /** event を 1 度も受け取っていない / 既に消えた状態。 */
  active: boolean;
  current: ReindexProgressPayload | null;
  /** done=true を受けたかどうか。Toast 内の完了テキスト切替に使う。 */
  finished: boolean;
  /** semantic_reindex_all の invoke が in-flight かどうか。呼び出し側
   * (設定の再構築ボタン) が invoke 前後に set する。コンポーネントローカル
   * state だと設定パネルの閉じ開き (再マウント) で多重起動ガードが外れる
   * ため、グローバル store に置く。 */
  running: boolean;
  /** Workspace path captured when the active run started. Never sent over IPC. */
  activeWorkspaceKey: string | null;
  /** Distinguishes a newly opened DB at the same workspace path. */
  activeWorkspaceOpenRevision: number | null;
  activeProjectId: string | null;
  activeRunId: string | null;
  /** Claim the single foreground reindex slot. Returns false when already busy. */
  begin: (
    workspaceKey: string,
    workspaceOpenRevision: number,
    projectId: string,
    runId: string,
  ) => boolean;
  /** Mark only the matching run as no longer in-flight. */
  finish: (runId: string) => void;
  /** Clear only the matching failed run; delayed failures are ignored. */
  fail: (runId: string) => void;
  /** Compatibility helper for older callers/tests. New code should use begin/finish. */
  setRunning: (running: boolean) => void;
  setProgress: (payload: ReindexProgressPayload) => void;
  clear: () => void;
}

export const AUTO_CLEAR_MS = 4000;

/** Generate a renderer-owned correlation token before invoking native reindex. */
export function createReindexRunId(): string {
  const randomUuid = globalThis.crypto?.randomUUID;
  if (typeof randomUuid === "function")
    return randomUuid.call(globalThis.crypto);
  return `semantic-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let clearTimer: ReturnType<typeof setTimeout> | null = null;

function cancelClearTimer(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

const CLEARED_STATE = {
  active: false,
  current: null,
  finished: false,
  running: false,
  activeWorkspaceKey: null,
  activeWorkspaceOpenRevision: null,
  activeProjectId: null,
  activeRunId: null,
} as const;

export const useReindexProgressStore = create<ReindexProgressState>()(
  (set, get) => ({
    ...CLEARED_STATE,
    begin: (workspaceKey, workspaceOpenRevision, projectId, runId) => {
      let claimed = false;
      set((state) => {
        if (state.running) return state;
        claimed = true;
        cancelClearTimer();
        return {
          active: false,
          current: null,
          finished: false,
          running: true,
          activeWorkspaceKey: workspaceKey,
          activeWorkspaceOpenRevision: workspaceOpenRevision,
          activeProjectId: projectId,
          activeRunId: runId,
        };
      });
      return claimed;
    },
    finish: (runId) => {
      set((state) => {
        if (state.activeRunId !== runId) return state;
        // EventQueue / TSFn delivery may lag behind invoke resolution. Keep the
        // correlation token so a delayed terminal progress event is accepted.
        // begin/clear/auto-clear owns the eventual token release.
        return { running: false };
      });
    },
    fail: (runId) => {
      if (get().activeRunId !== runId) return;
      cancelClearTimer();
      set(CLEARED_STATE);
    },
    setRunning: (running) => set({ running }),
    setProgress: (payload) => {
      cancelClearTimer();
      set({
        active: true,
        current: payload,
        finished: payload.done,
      });
      if (payload.done) {
        const scheduledRunId = get().activeRunId;
        clearTimer = setTimeout(() => {
          clearTimer = null;
          set((state) => {
            if (state.activeRunId !== scheduledRunId) return state;
            const displayCleared = {
              active: false,
              current: null,
              finished: false,
            };
            if (state.running) return displayCleared;
            return {
              ...displayCleared,
              activeWorkspaceKey: null,
              activeWorkspaceOpenRevision: null,
              activeProjectId: null,
              activeRunId: null,
            };
          });
        }, AUTO_CLEAR_MS);
      }
    },
    clear: () => {
      cancelClearTimer();
      set(CLEARED_STATE);
    },
  }),
);

/** テスト用: 内部の自動消滅タイマーを強制クリアする。 */
export function _resetReindexProgressForTests(): void {
  cancelClearTimer();
  useReindexProgressStore.setState(CLEARED_STATE);
}
