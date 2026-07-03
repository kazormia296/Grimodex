import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Update, DownloadEvent } from "@tauri-apps/plugin-updater";

vi.mock("@/lib/tauri", () => ({
  isTauri: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({
  check: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-process", () => ({
  relaunch: vi.fn(),
}));

import { isTauri } from "@/lib/tauri";
import { check } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import {
  checkForUpdate,
  startUpdateDownload,
  restartApp,
  _resetUpdaterApiForTests,
} from "./api";
import { useUpdaterStore, _resetUpdaterForTests } from "./updaterStore";

const mockIsTauri = vi.mocked(isTauri);
const mockCheck = vi.mocked(check);
const mockRelaunch = vi.mocked(relaunch);

/** downloadAndInstall が Started/Progress/Progress/Finished を順に発火する擬似 Update */
function fakeUpdate(): Update {
  return {
    version: "2.0.0",
    body: "新機能",
    downloadAndInstall: vi.fn(
      async (onEvent?: (e: DownloadEvent) => void): Promise<void> => {
        onEvent?.({ event: "Started", data: { contentLength: 100 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 40 } });
        onEvent?.({ event: "Progress", data: { chunkLength: 60 } });
        onEvent?.({ event: "Finished" });
      },
    ),
  } as unknown as Update;
}

describe("updater/api", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetUpdaterApiForTests();
    _resetUpdaterForTests();
    mockRelaunch.mockResolvedValue(undefined);
  });

  describe("checkForUpdate", () => {
    it("returns the Update when one is available (Tauri)", async () => {
      mockIsTauri.mockReturnValue(true);
      const update = fakeUpdate();
      mockCheck.mockResolvedValueOnce(update);
      const result = await checkForUpdate();
      expect(result).toBe(update);
      expect(mockCheck).toHaveBeenCalledTimes(1);
    });

    it("returns null when up to date (check resolves null)", async () => {
      mockIsTauri.mockReturnValue(true);
      mockCheck.mockResolvedValueOnce(null);
      const result = await checkForUpdate();
      expect(result).toBeNull();
      expect(mockCheck).toHaveBeenCalledTimes(1);
    });

    it("is a no-op returning null outside Tauri (check not called)", async () => {
      mockIsTauri.mockReturnValue(false);
      const result = await checkForUpdate();
      expect(result).toBeNull();
      expect(mockCheck).not.toHaveBeenCalled();
    });
  });

  describe("startUpdateDownload", () => {
    it("streams download events into the store and relaunches", async () => {
      mockIsTauri.mockReturnValue(true);
      const update = fakeUpdate();
      mockCheck.mockResolvedValueOnce(update);
      await checkForUpdate(); // pendingUpdate をセット

      await startUpdateDownload();

      const s = useUpdaterStore.getState();
      expect(s.phase).toBe("ready");
      expect(s.downloaded).toBe(100); // 40 + 60
      expect(s.total).toBe(100);
      expect(mockRelaunch).toHaveBeenCalledTimes(1);
    });

    it("is a no-op when no update is pending", async () => {
      // pendingUpdate は reset 済み
      await startUpdateDownload();
      expect(useUpdaterStore.getState().phase).toBe("idle");
      expect(mockRelaunch).not.toHaveBeenCalled();
    });
  });

  describe("restartApp", () => {
    it("swallows a relaunch rejection (installer handles restart)", async () => {
      mockIsTauri.mockReturnValue(true);
      mockRelaunch.mockRejectedValueOnce(
        new Error("no relaunch on this target"),
      );
      await expect(restartApp()).resolves.toBeUndefined();
    });

    it("does not call relaunch outside Tauri", async () => {
      mockIsTauri.mockReturnValue(false);
      await restartApp();
      expect(mockRelaunch).not.toHaveBeenCalled();
    });
  });
});
