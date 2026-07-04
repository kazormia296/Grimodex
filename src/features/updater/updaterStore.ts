import { create } from "zustand";

/**
 * Tauri アプリ更新 (tauri-plugin-updater) の進行表示用 store。
 * `useUpdateChecker` が起動後にサイレント check() を投げ、`api.ts` が
 * downloadAndInstall のイベントを本 store に流し込む。`UpdateToast` が読んで
 * 描画する。終端状態のうち `upToDate` / `error` のみ AUTO_CLEAR_MS 後に
 * トーストを自動で畳む (available / downloading / ready はユーザー操作を待つため
 * 自動で消さない)。
 *
 * `availableVersion` は「更新が保留中」を表す永続マーカー。更新発見〜更新完了
 * (再起動) まで保持し、トーストを「後で」で閉じても・DL 失敗しても消えない。
 * 設定ボタン (⚙) と About タブのインジケーター (UpdateDot)、および About の
 * 更新ボタンがこれを読む。「更新なし」(setUpToDate) と完全リセット (reset) で
 * のみ null に戻る。
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
  /**
   * 保留中の更新バージョン。更新発見〜更新完了 (再起動) まで保持する永続マーカー。
   * トーストを「後で」で閉じても・DL 失敗しても残す (=インジケーター/更新ボタン用)。
   */
  availableVersion: string | null;
  downloaded: number;
  total: number;
  error: string | null;
  setChecking: () => void;
  setAvailable: (version: string | null, notes: string | null) => void;
  setDownloading: (downloaded: number, total: number) => void;
  setReady: () => void;
  setUpToDate: () => void;
  setError: (message: string) => void;
  /** トーストだけ閉じる (「後で」)。availableVersion は残しインジケーターを維持する。 */
  dismissToast: () => void;
  /** すべて初期状態に戻す (完全 dismiss / テスト用)。 */
  reset: () => void;
}

export const AUTO_CLEAR_MS = 4000;

const IDLE = {
  phase: "idle" as UpdaterPhase,
  version: null,
  notes: null,
  availableVersion: null,
  downloaded: 0,
  total: 0,
  error: null,
};

// トーストの表示状態だけを畳む (upToDate/error の自動消滅・「後で」)。
// version/notes/availableVersion は残すのでインジケーターは維持される。
const TOAST_CLEAR = {
  phase: "idle" as UpdaterPhase,
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
      set({ ...TOAST_CLEAR });
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
        availableVersion: version,
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
      set({ phase: "upToDate", availableVersion: null, error: null });
      scheduleAutoClear();
    },
    setError: (message) => {
      set({ phase: "error", error: message });
      scheduleAutoClear();
    },
    dismissToast: () => {
      cancelTimer();
      set({ ...TOAST_CLEAR });
    },
    reset: () => {
      cancelTimer();
      set({ ...IDLE });
    },
  };
});

/** 保留中の更新があるか (⚙ / About タブのインジケーター用)。 */
export function useUpdatePending(): boolean {
  return useUpdaterStore((s) => s.availableVersion !== null);
}

/** テスト用: 内部の自動消滅タイマーを強制クリアし初期状態へ戻す。 */
export function _resetUpdaterForTests(): void {
  cancelTimer();
  useUpdaterStore.setState({ ...IDLE });
}
