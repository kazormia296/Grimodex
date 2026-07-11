// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetIpcQueueForTests } from "./ipcQueue";
import { check, relaunch, type DownloadEvent } from "./updater";

const { pluginCheck, pluginRelaunch } = vi.hoisted(() => ({
  pluginCheck: vi.fn(),
  pluginRelaunch: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: pluginCheck }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: pluginRelaunch }));

interface ElectronHarness {
  invoke: ReturnType<typeof vi.fn>;
  listen: ReturnType<typeof vi.fn>;
  unlisten: ReturnType<typeof vi.fn>;
  emitProgress(payload: { downloaded: number; total: number }): void;
}

function installBridge(
  invokeImpl: (cmd: string) => Promise<unknown>,
): ElectronHarness {
  let progressListener: ((payload: unknown) => void) | null = null;
  const unlisten = vi.fn(() => {
    progressListener = null;
  });
  const listen = vi.fn(
    (channel: string, listener: (payload: unknown) => void) => {
      expect(channel).toBe("updater:download-progress");
      progressListener = listener;
      return unlisten;
    },
  );
  const invoke = vi.fn(invokeImpl);
  (window as unknown as Record<string, unknown>).grimodex = {
    shell: "electron",
    invoke,
    listen,
  };
  return {
    invoke,
    listen,
    unlisten,
    emitProgress(payload): void {
      progressListener?.(payload);
    },
  };
}

beforeEach(() => {
  resetIpcQueueForTests();
  vi.clearAllMocks();
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
});

describe("updater Tauri compatibility", () => {
  it("keeps plugin-updater check behavior", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    const update = {
      version: "2.0.0",
      body: "Tauri update",
      downloadAndInstall: vi.fn(),
    };
    pluginCheck.mockResolvedValueOnce(update);

    await expect(check()).resolves.toBe(update);

    expect(pluginCheck).toHaveBeenCalledOnce();
  });

  it("keeps plugin-process relaunch behavior", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    pluginRelaunch.mockResolvedValueOnce(undefined);

    await expect(relaunch()).resolves.toBeUndefined();

    expect(pluginRelaunch).toHaveBeenCalledOnce();
  });
});

describe("updater Electron abstraction", () => {
  it("returns null when main reports no update", async () => {
    const h = installBridge(async () => ({ ok: true, value: null }));

    await expect(check()).resolves.toBeNull();

    expect(h.invoke).toHaveBeenCalledWith("updater_check", undefined);
    expect(pluginCheck).not.toHaveBeenCalled();
  });

  it("wraps update metadata and maps cumulative progress to Tauri events", async () => {
    const h = installBridge(async (cmd) => {
      if (cmd === "updater_check") {
        return {
          ok: true,
          value: { version: "2.0.0", body: "新機能" },
        };
      }
      if (cmd === "updater_download") {
        h.emitProgress({ downloaded: 25, total: 100 });
        h.emitProgress({ downloaded: 100, total: 100 });
        return { ok: true, value: null };
      }
      throw new Error(`unexpected command: ${cmd}`);
    });
    const update = await check();
    expect(update).toMatchObject({ version: "2.0.0", body: "新機能" });

    const events: DownloadEvent[] = [];
    await update?.downloadAndInstall((event) => events.push(event));

    expect(events).toEqual([
      { event: "Started", data: { contentLength: 100 } },
      { event: "Progress", data: { chunkLength: 25 } },
      { event: "Progress", data: { chunkLength: 75 } },
      { event: "Finished" },
    ]);
    expect(h.listen).toHaveBeenCalledOnce();
    expect(h.unlisten).toHaveBeenCalledOnce();
    expect(pluginCheck).not.toHaveBeenCalled();
  });

  it("emits a zero-length start/finish when download has no progress events", async () => {
    const h = installBridge(async (cmd) => ({
      ok: true,
      value: cmd === "updater_check" ? { version: "2.0.0", body: null } : null,
    }));
    const update = await check();
    const events: DownloadEvent[] = [];

    await update?.downloadAndInstall((event) => events.push(event));

    expect(events).toEqual([
      { event: "Started", data: { contentLength: 0 } },
      { event: "Finished" },
    ]);
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("unsubscribes progress when download rejects and does not emit Finished", async () => {
    const h = installBridge(async (cmd) => {
      if (cmd === "updater_check") {
        return {
          ok: true,
          value: { version: "2.0.0", body: null },
        };
      }
      return { ok: false, error: "download failed" };
    });
    const update = await check();
    const events: DownloadEvent[] = [];

    await expect(
      update?.downloadAndInstall((event) => events.push(event)),
    ).rejects.toBe("download failed");

    expect(events).not.toContainEqual({ event: "Finished" });
    expect(h.unlisten).toHaveBeenCalledOnce();
  });

  it("delegates relaunch to guarded main install command", async () => {
    const h = installBridge(async () => ({ ok: true, value: null }));

    await expect(relaunch()).resolves.toBeUndefined();

    expect(h.invoke).toHaveBeenCalledWith("updater_install", undefined);
    expect(pluginRelaunch).not.toHaveBeenCalled();
  });
});
