/**
 * Electron の自動更新を main process に閉じ込める manager。
 *
 * renderer には update metadata と byte progress だけを渡し、更新ファイルの
 * 取得・検証・install は electron-updater に委ねる。開発 build では updater を
 * 起動せず、check / download / install の全操作を明示的に拒否する。
 */
import { app } from "electron";
import { autoUpdater } from "electron-updater";

import type { ShellCommandHandlers } from "../shared/ipcContract.js";

const UPDATE_PROGRESS_CHANNEL = "updater:download-progress";

type Broadcast = (channel: string, payload: unknown) => void;
type UpdaterListener = (...args: unknown[]) => void;

interface ReleaseNoteLike {
  note?: string | null;
}

interface UpdateInfoLike {
  version: string;
  releaseNotes?: string | ReadonlyArray<ReleaseNoteLike> | null;
}

interface UpdateCheckResultLike {
  isUpdateAvailable: boolean;
  updateInfo: UpdateInfoLike;
}

interface DownloadProgressLike {
  transferred: number;
  total: number;
}

/** electron-updater のテスト可能な最小構造。 */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: string, listener: UpdaterListener): unknown;
  removeListener(event: string, listener: UpdaterListener): unknown;
  checkForUpdates(): Promise<UpdateCheckResultLike | null>;
  downloadUpdate(): Promise<ReadonlyArray<string>>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface ElectronUpdateInfo {
  version: string;
  body: string | null;
}

export interface ElectronUpdaterManager {
  handlers: ShellCommandHandlers;
  /** will-quit 向け。listener と進行中 operation の待機を回収する。 */
  dispose(): void;
}

interface ElectronUpdaterDependencies {
  updater?: AutoUpdaterLike;
  isPackaged?: boolean;
  warn?: (message: string, cause?: unknown) => void;
  /** quitAndInstall が起動済みだが close veto された場合の再終了要求。 */
  quitApplication?: () => void;
  subscribeBeforeQuit?: (listener: () => void) => () => void;
}

function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function releaseNotesToBody(
  notes: UpdateInfoLike["releaseNotes"],
): string | null {
  if (typeof notes === "string") return notes || null;
  if (!Array.isArray(notes)) return null;
  const body = notes
    .map((entry) => entry.note?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n");
  return body || null;
}

function normalizeProgress(info: DownloadProgressLike): {
  downloaded: number;
  total: number;
} {
  const total =
    Number.isFinite(info.total) && info.total > 0 ? Math.floor(info.total) : 0;
  const transferred =
    Number.isFinite(info.transferred) && info.transferred > 0
      ? Math.floor(info.transferred)
      : 0;
  return {
    downloaded: total > 0 ? Math.min(transferred, total) : transferred,
    total,
  };
}

function createDevelopmentUpdater(): AutoUpdaterLike {
  return {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    on: () => undefined,
    removeListener: () => undefined,
    checkForUpdates: () =>
      Promise.reject(
        new Error("Electron updater is unavailable in development builds"),
      ),
    downloadUpdate: () =>
      Promise.reject(
        new Error("Electron updater is unavailable in development builds"),
      ),
    quitAndInstall: () => undefined,
  };
}

/**
 * 操作単位の single-flight と error event のスコープを持つ updater manager。
 * electron-updater の `error` は次の操作へ持ち越さず、その時点で進行中の操作だけを
 * reject する（EventEmitter の未処理 error による main process crash も防ぐ）。
 */
export function createElectronUpdaterManager(
  broadcast: Broadcast,
  dependencies: ElectronUpdaterDependencies = {},
): ElectronUpdaterManager {
  const isPackaged = dependencies.isPackaged ?? app.isPackaged;
  // Accessing electron-updater's singleton constructs a platform updater and
  // validates app.getVersion(). A development Electron CLI reports `0.0`, so
  // even touching the singleton would throw before the first window exists.
  const updater =
    dependencies.updater ??
    (isPackaged
      ? (autoUpdater as unknown as AutoUpdaterLike)
      : createDevelopmentUpdater());
  const warn =
    dependencies.warn ??
    ((message: string, cause?: unknown) => {
      console.warn(message, cause);
    });
  const quitApplication = dependencies.quitApplication ?? (() => app.quit());
  const subscribeBeforeQuit =
    dependencies.subscribeBeforeQuit ??
    ((listener: () => void) => {
      app.on("before-quit", listener);
      return () => app.removeListener("before-quit", listener);
    });

  // download 開始だけは main manager が明示操作に限定する。install-on-quit は
  // electron-updater の platform 固有フロー（特に Squirrel.Mac）を維持する。
  updater.autoDownload = false;

  let disposed = false;
  let availableUpdate: ElectronUpdateInfo | null = null;
  let downloaded = false;
  let installerStarted = false;
  let quitAttemptObserved = false;
  let downloadActive = false;
  let checkInFlight: Promise<ElectronUpdateInfo | null> | null = null;
  let downloadInFlight: Promise<null> | null = null;
  let installInFlight: Promise<null> | null = null;
  const errorWaiters = new Set<(cause: Error) => void>();

  const onUpdaterError: UpdaterListener = (cause) => {
    const error = toError(cause);
    if (errorWaiters.size === 0) {
      if (installerStarted && downloaded) {
        // NSIS の spawn/openPath 失敗は quitAndInstall が戻った後に届く場合がある。
        // installer 起動済みフラグだけを戻し、downloaded artifact は再試行用に保持。
        installerStarted = false;
        quitAttemptObserved = false;
        resetElectronUpdaterInstallGuard();
        warn(
          "Electron updater failed after the install request; the update remains retryable",
          error,
        );
        return;
      }
      warn(
        "Electron updater emitted an error outside an active operation",
        error,
      );
      return;
    }
    for (const reject of [...errorWaiters]) reject(error);
  };

  const onDownloadProgress: UpdaterListener = (value) => {
    if (disposed || !isPackaged || !downloadActive) return;
    if (typeof value !== "object" || value === null) return;
    const info = value as Partial<DownloadProgressLike>;
    if (
      typeof info.transferred !== "number" ||
      typeof info.total !== "number"
    ) {
      return;
    }
    broadcast(
      UPDATE_PROGRESS_CHANNEL,
      normalizeProgress(info as DownloadProgressLike),
    );
  };

  updater.on("error", onUpdaterError);
  updater.on("download-progress", onDownloadProgress);
  const unsubscribeBeforeQuit = subscribeBeforeQuit(() => {
    quitAttemptObserved = true;
  });

  function ensureActive(): void {
    if (disposed) throw new Error("Electron updater manager has been disposed");
  }

  function ensurePackaged(): void {
    ensureActive();
    if (!isPackaged) {
      throw new Error("Electron updater is unavailable in development builds");
    }
  }

  function resetElectronUpdaterInstallGuard(): void {
    // electron-updater 6.8.x の BaseUpdater は async spawn error で
    // quitAndInstallCalled を戻さない。package は exact pin 済み。error 後に同じ
    // downloaded artifact を再試行できるよう、存在する実装だけ guard を戻す。
    const internal = updater as AutoUpdaterLike & {
      quitAndInstallCalled?: unknown;
    };
    if (internal.quitAndInstallCalled === true) {
      internal.quitAndInstallCalled = false;
    }
  }

  async function runWithUpdaterErrors<T>(
    action: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    ensureActive();
    let rejectForUpdaterError: ((cause: Error) => void) | null = null;
    const updaterError = new Promise<never>((_resolve, reject) => {
      rejectForUpdaterError = (cause) => reject(cause);
    });
    const rejectOperation = rejectForUpdaterError;
    if (!rejectOperation) {
      throw new Error(`Update ${action} failed to initialize`);
    }
    errorWaiters.add(rejectOperation);
    try {
      return await Promise.race([
        Promise.resolve().then(() => {
          ensureActive();
          return operation();
        }),
        updaterError,
      ]);
    } catch (cause) {
      throw new Error(`Update ${action} failed: ${toError(cause).message}`, {
        cause,
      });
    } finally {
      errorWaiters.delete(rejectOperation);
    }
  }

  function check(): Promise<ElectronUpdateInfo | null> {
    ensurePackaged();
    if (downloadInFlight) {
      return Promise.reject(
        new Error("Cannot check for updates while a download is in progress"),
      );
    }
    if (checkInFlight) return checkInFlight;
    // quitAndInstall 後に close veto でアプリが残った場合も、downloaded state を
    // 新しい check で消さない。再終了要求に使う同じ update metadata を返す。
    if (downloaded) return Promise.resolve(availableUpdate);

    const operation = (async (): Promise<ElectronUpdateInfo | null> => {
      const result = await runWithUpdaterErrors("check", () =>
        updater.checkForUpdates(),
      );
      ensureActive();
      if (!result?.isUpdateAvailable) {
        availableUpdate = null;
        downloaded = false;
        installerStarted = false;
        quitAttemptObserved = false;
        return null;
      }
      const update = {
        version: result.updateInfo.version,
        body: releaseNotesToBody(result.updateInfo.releaseNotes),
      };
      availableUpdate = update;
      downloaded = false;
      installerStarted = false;
      quitAttemptObserved = false;
      return update;
    })();
    checkInFlight = operation;
    void operation.then(
      () => {
        if (checkInFlight === operation) checkInFlight = null;
      },
      () => {
        if (checkInFlight === operation) checkInFlight = null;
      },
    );
    return operation;
  }

  function download(): Promise<null> {
    ensurePackaged();
    if (downloadInFlight) return downloadInFlight;
    if (checkInFlight) {
      return Promise.reject(
        new Error("Cannot download an update while a check is in progress"),
      );
    }
    if (!availableUpdate) {
      return Promise.reject(new Error("No update is available to download"));
    }
    if (downloaded) return Promise.resolve(null);

    downloadActive = true;
    const operation = (async (): Promise<null> => {
      try {
        await runWithUpdaterErrors("download", () => updater.downloadUpdate());
        ensureActive();
        downloaded = true;
        return null;
      } catch (cause) {
        downloaded = false;
        throw cause;
      } finally {
        downloadActive = false;
      }
    })();
    downloadInFlight = operation;
    void operation.then(
      () => {
        if (downloadInFlight === operation) downloadInFlight = null;
      },
      () => {
        if (downloadInFlight === operation) downloadInFlight = null;
      },
    );
    return operation;
  }

  function install(): Promise<null> {
    ensurePackaged();
    if (installInFlight) return installInFlight;
    if (checkInFlight || downloadInFlight) {
      return Promise.reject(
        new Error("Cannot install an update while an operation is in progress"),
      );
    }
    if (!downloaded) {
      return Promise.reject(
        new Error("No downloaded update is ready to install"),
      );
    }

    const operation = (async (): Promise<null> => {
      if (installerStarted) {
        // 最初の quitAndInstall は installer を既に spawn 済み。close veto 後の
        // 再試行で同メソッドを呼ぶと electron-updater 内部 guard に無視されるため、
        // app.quit だけを再要求する。downloaded state は process 終了まで保持する。
        // macOS は quitAndInstall 後に Squirrel が update を取得してから quit する。
        // before-quit がまだ一度も来ていない間は「veto」と誤認して先に終了しない。
        if (!quitAttemptObserved) return null;
        try {
          quitApplication();
        } catch (cause) {
          throw new Error(
            `Update quit retry failed: ${toError(cause).message}`,
            {
              cause,
            },
          );
        }
        return null;
      }

      // electron-updater は install spawn 失敗を throw せず同期 `error` event で
      // 通知する実装もある。NSIS の ChildProcess error は次の event-loop turn に
      // 届くため、そこまで operation scope を保って caller の reject へ変換する。
      quitAttemptObserved = false;
      try {
        await runWithUpdaterErrors("install", async () => {
          updater.quitAndInstall(false, true);
          await new Promise<void>((resolve) => setImmediate(resolve));
        });
      } catch (cause) {
        quitAttemptObserved = false;
        resetElectronUpdaterInstallGuard();
        throw cause;
      }
      ensureActive();
      installerStarted = true;
      return null;
    })();
    installInFlight = operation;
    void operation.then(
      () => {
        if (installInFlight === operation) installInFlight = null;
      },
      () => {
        if (installInFlight === operation) installInFlight = null;
      },
    );
    return operation;
  }

  return {
    handlers: {
      updater_check: () => check(),
      updater_download: () => download(),
      updater_install: () => install(),
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      downloadActive = false;
      const error = new Error("Electron updater manager has been disposed");
      for (const reject of [...errorWaiters]) reject(error);
      errorWaiters.clear();
      updater.removeListener("error", onUpdaterError);
      updater.removeListener("download-progress", onDownloadProgress);
      unsubscribeBeforeQuit();
    },
  };
}
