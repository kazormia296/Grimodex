import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { isPackaged: true } }));
vi.mock("electron-updater", () => ({ autoUpdater: {} }));

import {
  PACKAGE_CHANNEL_MARKER,
  createElectronUpdaterManager,
  resolveElectronUpdaterAvailability,
  type AutoUpdaterLike,
  type ElectronUpdaterManager,
} from "./updater.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(cause: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeAutoUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  quitAndInstallCalled = false;
  readonly checkForUpdates = vi.fn<() => Promise<unknown>>();
  readonly downloadUpdate = vi.fn<() => Promise<ReadonlyArray<string>>>();
  readonly quitAndInstall =
    vi.fn<(isSilent?: boolean, isForceRunAfter?: boolean) => void>();
}

interface Harness {
  updater: FakeAutoUpdater;
  manager: ElectronUpdaterManager;
  broadcast: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  quitApplication: ReturnType<typeof vi.fn>;
  stopObservingBeforeQuit: ReturnType<typeof vi.fn>;
  triggerBeforeQuit(): void;
}

const managers: ElectronUpdaterManager[] = [];

function createHarness(isPackaged = true): Harness {
  const updater = new FakeAutoUpdater();
  const broadcast = vi.fn();
  const warn = vi.fn();
  const quitApplication = vi.fn();
  const stopObservingBeforeQuit = vi.fn();
  let beforeQuitListener: (() => void) | null = null;
  const manager = createElectronUpdaterManager(broadcast, {
    updater: updater as unknown as AutoUpdaterLike,
    isPackaged,
    warn,
    quitApplication,
    subscribeBeforeQuit: (listener) => {
      beforeQuitListener = listener;
      return stopObservingBeforeQuit;
    },
  });
  managers.push(manager);
  return {
    updater,
    manager,
    broadcast,
    warn,
    quitApplication,
    stopObservingBeforeQuit,
    triggerBeforeQuit(): void {
      beforeQuitListener?.();
    },
  };
}

function availableResult(
  version = "2.0.0",
  releaseNotes: string | Array<{ note: string | null }> | null = "新機能",
) {
  return {
    isUpdateAvailable: true,
    updateInfo: { version, releaseNotes },
  };
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  vi.restoreAllMocks();
});

describe("resolveElectronUpdaterAvailability", () => {
  it("enables packaged electron-builder artifacts without a channel marker", () => {
    expect(
      resolveElectronUpdaterAvailability({
        isPackaged: true,
        resourcesPath: "/opt/Grimodex/resources",
        readMarker: (markerPath) => {
          expect(markerPath).toBe(
            `/opt/Grimodex/resources/${PACKAGE_CHANNEL_MARKER}`,
          );
          throw Object.assign(new Error("missing"), { code: "ENOENT" });
        },
      }),
    ).toEqual({ enabled: true, reason: "Electron updater is available" });
  });

  it("disables the deb updater inside an Arch-repackaged payload", () => {
    expect(
      resolveElectronUpdaterAvailability({
        isPackaged: true,
        resourcesPath: "/opt/Grimodex/resources",
        readMarker: () => "arch\n",
      }),
    ).toEqual({
      enabled: false,
      reason:
        "Electron updater is disabled for Arch packages; update with pacman or an AUR helper",
    });
  });

  it("fails closed for an unknown or unreadable package marker", () => {
    expect(
      resolveElectronUpdaterAvailability({
        isPackaged: true,
        resourcesPath: "/opt/Grimodex/resources",
        readMarker: () => "future-channel",
      }),
    ).toMatchObject({
      enabled: false,
      reason: expect.stringContaining("unsupported"),
    });
    expect(
      resolveElectronUpdaterAvailability({
        isPackaged: true,
        resourcesPath: "/locked/resources",
        readMarker: () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" });
        },
      }),
    ).toEqual({
      enabled: false,
      reason: `Electron updater package marker cannot be read: /locked/resources/${PACKAGE_CHANNEL_MARKER}`,
    });
  });
});

describe("ElectronUpdaterManager check", () => {
  it("disables automatic download/install and returns null when up to date", async () => {
    const h = createHarness();
    h.updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: "1.0.0" },
    });

    await expect(h.manager.handlers.updater_check({})).resolves.toBeNull();

    expect(h.updater.autoDownload).toBe(false);
    expect(h.updater.autoInstallOnAppQuit).toBe(true);
    expect(h.updater.checkForUpdates).toHaveBeenCalledOnce();
  });

  it("normalizes available update metadata and release-note arrays", async () => {
    const h = createHarness();
    h.updater.checkForUpdates.mockResolvedValue(
      availableResult("2.1.0", [
        { note: "機能 A" },
        { note: null },
        { note: " 機能 B " },
      ]),
    );

    await expect(h.manager.handlers.updater_check({})).resolves.toEqual({
      version: "2.1.0",
      body: "機能 A\n\n機能 B",
    });
  });

  it("deduplicates concurrent checks and permits a later check", async () => {
    const h = createHarness();
    const firstResult = deferred<ReturnType<typeof availableResult>>();
    h.updater.checkForUpdates
      .mockReturnValueOnce(firstResult.promise)
      .mockResolvedValueOnce({
        isUpdateAvailable: false,
        updateInfo: { version: "2.0.0" },
      });

    const first = h.manager.handlers.updater_check({});
    const duplicate = h.manager.handlers.updater_check({});
    await vi.waitFor(() =>
      expect(h.updater.checkForUpdates).toHaveBeenCalledOnce(),
    );
    firstResult.resolve(availableResult());
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      { version: "2.0.0", body: "新機能" },
      { version: "2.0.0", body: "新機能" },
    ]);

    await expect(h.manager.handlers.updater_check({})).resolves.toBeNull();
    expect(h.updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});

describe("ElectronUpdaterManager download/install", () => {
  it("deduplicates download, broadcasts progress, and installs only afterward", async () => {
    const h = createHarness();
    const download = deferred<ReadonlyArray<string>>();
    h.updater.checkForUpdates.mockResolvedValue(availableResult());
    h.updater.downloadUpdate.mockReturnValue(download.promise);

    await h.manager.handlers.updater_check({});
    await expect(h.manager.handlers.updater_install({})).rejects.toThrow(
      "No downloaded update is ready to install",
    );
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
    expect(h.quitApplication).not.toHaveBeenCalled();

    const first = h.manager.handlers.updater_download({});
    const duplicate = h.manager.handlers.updater_download({});
    await vi.waitFor(() =>
      expect(h.updater.downloadUpdate).toHaveBeenCalledOnce(),
    );
    h.updater.emit("download-progress", {
      transferred: 150.9,
      total: 100.8,
    });
    expect(h.broadcast).toHaveBeenCalledWith("updater:download-progress", {
      downloaded: 100,
      total: 100,
    });
    await expect(h.manager.handlers.updater_install({})).rejects.toThrow(
      "operation is in progress",
    );

    download.resolve(["/tmp/update"]);
    await expect(Promise.all([first, duplicate])).resolves.toEqual([
      null,
      null,
    ]);
    await expect(h.manager.handlers.updater_install({})).resolves.toBeNull();
    expect(h.updater.quitAndInstall).toHaveBeenCalledWith(false, true);
    h.triggerBeforeQuit();
    await expect(h.manager.handlers.updater_install({})).resolves.toBeNull();
    expect(h.quitApplication).toHaveBeenCalledOnce();
  });

  it("surfaces method/error-event failures without poisoning a retry", async () => {
    const h = createHarness();
    const firstDownload = deferred<ReadonlyArray<string>>();
    h.updater.checkForUpdates.mockResolvedValue(availableResult());
    h.updater.downloadUpdate
      .mockReturnValueOnce(firstDownload.promise)
      .mockResolvedValueOnce(["/tmp/update"]);
    await h.manager.handlers.updater_check({});

    const failed = h.manager.handlers.updater_download({});
    await vi.waitFor(() =>
      expect(h.updater.downloadUpdate).toHaveBeenCalledOnce(),
    );
    h.updater.emit("error", new Error("network disconnected"));
    await expect(failed).rejects.toThrow(
      "Update download failed: network disconnected",
    );
    firstDownload.resolve([]);

    await expect(h.manager.handlers.updater_download({})).resolves.toBeNull();
    await expect(h.manager.handlers.updater_install({})).resolves.toBeNull();
  });

  it("keeps an available update retryable after downloadUpdate rejects", async () => {
    const h = createHarness();
    h.updater.checkForUpdates.mockResolvedValue(availableResult());
    h.updater.downloadUpdate
      .mockRejectedValueOnce(new Error("signature invalid"))
      .mockResolvedValueOnce(["/tmp/update"]);
    await h.manager.handlers.updater_check({});

    await expect(h.manager.handlers.updater_download({})).rejects.toThrow(
      "Update download failed: signature invalid",
    );
    await expect(h.manager.handlers.updater_download({})).resolves.toBeNull();
  });

  it("surfaces electron-updater install error events and permits retry", async () => {
    const h = createHarness();
    h.updater.checkForUpdates.mockResolvedValue(availableResult());
    h.updater.downloadUpdate.mockResolvedValue(["/tmp/update"]);
    h.updater.quitAndInstall
      .mockImplementationOnce(() => {
        h.updater.quitAndInstallCalled = true;
        setImmediate(() => {
          h.updater.emit("error", new Error("installer spawn failed"));
        });
      })
      .mockImplementationOnce(() => undefined);
    await h.manager.handlers.updater_check({});
    await h.manager.handlers.updater_download({});

    await expect(h.manager.handlers.updater_install({})).rejects.toThrow(
      "Update install failed: installer spawn failed",
    );
    expect(h.updater.quitAndInstallCalled).toBe(false);
    await expect(h.manager.handlers.updater_install({})).resolves.toBeNull();
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it("keeps the artifact retryable when a later install error arrives", async () => {
    const h = createHarness();
    h.updater.checkForUpdates.mockResolvedValue(availableResult());
    h.updater.downloadUpdate.mockResolvedValue(["/tmp/update"]);
    await h.manager.handlers.updater_check({});
    await h.manager.handlers.updater_download({});
    await h.manager.handlers.updater_install({});

    h.updater.quitAndInstallCalled = true;
    h.updater.emit("error", new Error("late installer failure"));
    await expect(h.manager.handlers.updater_install({})).resolves.toBeNull();

    expect(h.warn).toHaveBeenCalledWith(
      "Electron updater failed after the install request; the update remains retryable",
      expect.objectContaining({ message: "late installer failure" }),
    );
    expect(h.updater.quitAndInstall).toHaveBeenCalledTimes(2);
    expect(h.updater.quitAndInstallCalled).toBe(false);
    expect(h.quitApplication).not.toHaveBeenCalled();
  });

  it("keeps downloaded readiness and retries app quit after a close veto", async () => {
    const h = createHarness();
    h.updater.checkForUpdates.mockResolvedValue(availableResult());
    h.updater.downloadUpdate.mockResolvedValue(["/tmp/update"]);
    await h.manager.handlers.updater_check({});
    await h.manager.handlers.updater_download({});

    // quitAndInstall が戻っても process 終了は非同期。ここでは close veto により
    // アプリが残った状態を模し、同じ handler をもう一度呼ぶ。
    await expect(h.manager.handlers.updater_install({})).resolves.toBeNull();
    // Squirrel.Mac の native update 取得中は before-quit が未発火なので待つ。
    await expect(h.manager.handlers.updater_install({})).resolves.toBeNull();
    expect(h.quitApplication).not.toHaveBeenCalled();
    h.triggerBeforeQuit();
    await expect(h.manager.handlers.updater_install({})).resolves.toBeNull();
    await expect(h.manager.handlers.updater_install({})).resolves.toBeNull();

    expect(h.updater.quitAndInstall).toHaveBeenCalledOnce();
    expect(h.quitApplication).toHaveBeenCalledTimes(2);
    // readiness を保持するため再 check/download も再取得せず同じ update を使う。
    await expect(h.manager.handlers.updater_check({})).resolves.toEqual({
      version: "2.0.0",
      body: "新機能",
    });
    await expect(h.manager.handlers.updater_download({})).resolves.toBeNull();
    expect(h.updater.checkForUpdates).toHaveBeenCalledOnce();
    expect(h.updater.downloadUpdate).toHaveBeenCalledOnce();
  });
});

describe("ElectronUpdaterManager lifecycle guards", () => {
  it("rejects updates for an external package-manager channel without constructing the singleton", async () => {
    const manager = createElectronUpdaterManager(vi.fn(), {
      isPackaged: true,
      availability: {
        enabled: false,
        reason:
          "Electron updater is disabled for Arch packages; update with pacman or an AUR helper",
      },
      subscribeBeforeQuit: () => () => undefined,
    });
    managers.push(manager);

    await expect(
      Promise.resolve().then(() => manager.handlers.updater_check({})),
    ).rejects.toThrow("update with pacman or an AUR helper");
  });

  it("does not construct the real updater in an unpackaged app", async () => {
    const manager = createElectronUpdaterManager(vi.fn(), {
      isPackaged: false,
      subscribeBeforeQuit: () => () => undefined,
    });
    managers.push(manager);

    await expect(
      Promise.resolve().then(() => manager.handlers.updater_check({})),
    ).rejects.toThrow("Electron updater is unavailable in development builds");
  });

  it("rejects every updater operation in development builds", async () => {
    const h = createHarness(false);

    for (const command of [
      "updater_check",
      "updater_download",
      "updater_install",
    ] as const) {
      await expect(
        Promise.resolve().then(() => h.manager.handlers[command]({})),
      ).rejects.toThrow(
        "Electron updater is unavailable in development builds",
      );
    }
    expect(h.updater.checkForUpdates).not.toHaveBeenCalled();
    expect(h.updater.downloadUpdate).not.toHaveBeenCalled();
    expect(h.updater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("disposes listeners, rejects an active operation, and blocks later use", async () => {
    const h = createHarness();
    const check = deferred<ReturnType<typeof availableResult>>();
    h.updater.checkForUpdates.mockReturnValue(check.promise);

    const pending = h.manager.handlers.updater_check({});
    await vi.waitFor(() =>
      expect(h.updater.checkForUpdates).toHaveBeenCalledOnce(),
    );
    expect(h.updater.listenerCount("error")).toBe(1);
    expect(h.updater.listenerCount("download-progress")).toBe(1);
    h.manager.dispose();

    await expect(pending).rejects.toThrow(
      "Update check failed: Electron updater manager has been disposed",
    );
    expect(h.updater.listenerCount("error")).toBe(0);
    expect(h.updater.listenerCount("download-progress")).toBe(0);
    expect(h.stopObservingBeforeQuit).toHaveBeenCalledOnce();
    expect(() => h.manager.handlers.updater_check({})).toThrow(
      "Electron updater manager has been disposed",
    );
    check.resolve(availableResult());
  });

  it("handles an idle error event without latching it into the next check", async () => {
    const h = createHarness();
    h.updater.emit("error", new Error("idle failure"));
    expect(h.warn).toHaveBeenCalledWith(
      "Electron updater emitted an error outside an active operation",
      expect.objectContaining({ message: "idle failure" }),
    );

    h.updater.checkForUpdates.mockResolvedValue({
      isUpdateAvailable: false,
      updateInfo: { version: "1.0.0" },
    });
    await expect(h.manager.handlers.updater_check({})).resolves.toBeNull();
  });
});
