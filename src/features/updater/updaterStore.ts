import { create } from "zustand";

/**
 * Tauri アプリ更新 (tauri-plugin-updater) の進行表示用 store。
 * `useUpdateChecker` が起動後にサイレント check() を投げ、`api.ts` が
 * downloadAndInstall のイベントを本 store に流し込む。`UpdateToast` が読んで
 * 描画する。`modelDownloadStore` と同型で、終端状態のうち `upToDate` / `error`
 * のみ AUTO_CLEAR_MS 後に自動リセットする (available / downloading / ready は
 * ユーザー操作を待つため自動で消さない)。
 */

export type UpdaterPhase =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "upToDate"
  | "error";

interface UpdaterState {
  phase: UpdaterPhase;
  /** 取得した新バージョン (available 以降) */
  version: string | null;
  /** リリースノート (update.body) */
  notes: string | null;
  downloaded: number;
  total: number;
  error: string | null;
  setChecking: () => void;
  setAvailable: (version: string | null, notes: string | null) => void;
  setDownloading: (downloaded: number, total: number) => void;
  setReady: () => void;
  setUpToDate: () => void;
  setError: (message: string) => void;
  /** すべて初期状態に戻す (「後で」ボタン / 明示的な dismiss) */
  reset: () => void;
}

export const AUTO_CLEAR_MS = 4000;

const IDLE = {
  phase: "idle" as UpdaterPhase,
  version: null,
  notes: null,
  downloaded: 0,
  total: 0,
  error: null,
};

let clearTimer: ReturnType<typeof setTimeout> | null = null;

function cancelTimer(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

export const useUpdaterStore = create<UpdaterState>()((set) => {
  const scheduleAutoClear = () => {
    cancelTimer();
    clearTimer = setTimeout(() => {
      clearTimer = null;
      set({ ...IDLE });
    }, AUTO_CLEAR_MS);
  };
  return {
    ...IDLE,
    setChecking: () => {
      cancelTimer();
      set({ phase: "checking", error: null });
    },
    setAvailable: (version, notes) => {
      cancelTimer();
      set({
        phase: "available",
        version,
        notes,
        downloaded: 0,
        total: 0,
        error: null,
      });
    },
    setDownloading: (downloaded, total) => {
      cancelTimer();
      set({ phase: "downloading", downloaded, total });
    },
    setReady: () => {
      cancelTimer();
      set({ phase: "ready" });
    },
    setUpToDate: () => {
      set({ phase: "upToDate", error: null });
      scheduleAutoClear();
    },
    setError: (message) => {
      set({ phase: "error", error: message });
      scheduleAutoClear();
    },
    reset: () => {
      cancelTimer();
      set({ ...IDLE });
    },
  };
});

/** テスト用: 内部の自動消滅タイマーを強制クリアし初期状態へ戻す。 */
export function _resetUpdaterForTests(): void {
  cancelTimer();
  useUpdaterStore.setState({ ...IDLE });
}
