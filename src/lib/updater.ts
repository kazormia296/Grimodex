import { isElectron } from "./shell";
import { invoke, isTauri, listen } from "./tauri";

/** updater shell 間の共通 download event（Tauri plugin と同形）。 */
export type DownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

/** features/updater が必要とする最小 Update 契約。 */
export interface Update {
  version: string;
  body?: string | null;
  downloadAndInstall(onEvent?: (event: DownloadEvent) => void): Promise<void>;
}

interface ElectronUpdateInfo {
  version: string;
  body: string | null;
}

interface ElectronDownloadProgress {
  downloaded: number;
  total: number;
}

const ELECTRON_PROGRESS_EVENT = "updater:download-progress";

function electronUpdate(info: ElectronUpdateInfo): Update {
  return {
    version: info.version,
    body: info.body,
    async downloadAndInstall(onEvent): Promise<void> {
      let started = false;
      let previousDownloaded = 0;
      const unlisten = await listen<ElectronDownloadProgress>(
        ELECTRON_PROGRESS_EVENT,
        (progress) => {
          const total =
            Number.isFinite(progress.total) && progress.total > 0
              ? progress.total
              : 0;
          const downloaded =
            Number.isFinite(progress.downloaded) && progress.downloaded > 0
              ? progress.downloaded
              : 0;
          if (!started) {
            started = true;
            onEvent?.({ event: "Started", data: { contentLength: total } });
          }
          const chunkLength = Math.max(0, downloaded - previousDownloaded);
          previousDownloaded = Math.max(previousDownloaded, downloaded);
          if (chunkLength > 0) {
            onEvent?.({ event: "Progress", data: { chunkLength } });
          }
        },
      );
      try {
        await invoke<null>("updater_download");
        if (!started) {
          onEvent?.({ event: "Started", data: { contentLength: 0 } });
        }
        onEvent?.({ event: "Finished" });
      } finally {
        unlisten();
      }
    },
  };
}

/**
 * 更新確認。Tauri は plugin-updater、Electron は main の electron-updater、
 * 通常ブラウザは null（更新なし）へ縮退する。
 */
export async function check(): Promise<Update | null> {
  if (isTauri()) {
    const { check: tauriCheck } = await import("@tauri-apps/plugin-updater");
    return tauriCheck();
  }
  if (isElectron()) {
    const update = await invoke<ElectronUpdateInfo | null>("updater_check");
    return update ? electronUpdate(update) : null;
  }
  return null;
}

/**
 * 更新済みアプリへの切り替え。Tauri は plugin-process、Electron は download
 * 完了を検証する main handler へ委譲し、通常ブラウザでは no-op。
 */
export async function relaunch(): Promise<void> {
  if (isTauri()) {
    const { relaunch: tauriRelaunch } =
      await import("@tauri-apps/plugin-process");
    await tauriRelaunch();
    return;
  }
  if (isElectron()) {
    await invoke<null>("updater_install");
  }
}
