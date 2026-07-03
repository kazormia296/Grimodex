import { create } from "zustand";

/**
 * オンデマンド埋め込みモデル DL の進行表示用 store。
 * Rust 側 `semantic:model_download_progress` event を `useModelDownloadListener`
 * が受け取り本 store に流し込む。`ModelDownloadToast` が読んで描画する。
 * `done=true`(error=null) で成功、`error` 有りで失敗 (FTS degrade)。
 * `reindexProgressStore` と同型 (done 後 AUTO_CLEAR_MS で自動リセット)。
 */

export interface ModelDownloadPayload {
  dirName: string;
  downloaded: number;
  total: number;
  done: boolean;
  error: string | null;
}

interface ModelDownloadState {
  active: boolean;
  current: ModelDownloadPayload | null;
  setProgress: (payload: ModelDownloadPayload) => void;
  clear: () => void;
}

export const AUTO_CLEAR_MS = 4000;

let clearTimer: ReturnType<typeof setTimeout> | null = null;

export const useModelDownloadStore = create<ModelDownloadState>()((set) => ({
  active: false,
  current: null,
  setProgress: (payload) => {
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    set({ active: true, current: payload });
    if (payload.done) {
      clearTimer = setTimeout(() => {
        clearTimer = null;
        set({ active: false, current: null });
      }, AUTO_CLEAR_MS);
    }
  },
  clear: () => {
    if (clearTimer !== null) {
      clearTimeout(clearTimer);
      clearTimer = null;
    }
    set({ active: false, current: null });
  },
}));

/** テスト用: 内部の自動消滅タイマーを強制クリアする。 */
export function _resetModelDownloadForTests(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
  useModelDownloadStore.setState({ active: false, current: null });
}
