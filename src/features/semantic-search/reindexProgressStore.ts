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
  setRunning: (running: boolean) => void;
  setProgress: (payload: ReindexProgressPayload) => void;
  clear: () => void;
}

export const AUTO_CLEAR_MS = 4000;

let clearTimer: ReturnType<typeof setTimeout> | null = null;

export const useReindexProgressStore = create<ReindexProgressState>()(
  (set) => ({
    active: false,
    current: null,
    finished: false,
    running: false,
    setRunning: (running) => set({ running }),
    setProgress: (payload) => {
      if (clearTimer !== null) {
        clearTimeout(clearTimer);
        clearTimer = null;
      }
      set({
        active: true,
        current: payload,
        finished: payload.done,
      });
      if (payload.done) {
        clearTimer = setTimeout(() => {
          clearTimer = null;
          set({ active: false, current: null, finished: false });
        }, AUTO_CLEAR_MS);
      }
    },
    clear: () => {
      if (clearTimer !== null) {
        clearTimeout(clearTimer);
        clearTimer = null;
      }
      set({ active: false, current: null, finished: false });
    },
  }),
);

/** テスト用: 内部の自動消滅タイマーを強制クリアする。 */
export function _resetReindexProgressForTests(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  useReindexProgressStore.setState({
    active: false,
    current: null,
    finished: false,
    running: false,
  });
}
