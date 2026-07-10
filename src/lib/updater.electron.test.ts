// @vitest-environment happy-dom
/**
 * updater の Electron 挙動（設計書 §3.4）: Phase 2 は非 Tauri と同挙動
 * （check → null / relaunch → no-op）。plugin を import しないことも確認する。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { check, relaunch } from "./updater";

const { pluginCheck, pluginRelaunch } = vi.hoisted(() => ({
  pluginCheck: vi.fn(),
  pluginRelaunch: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-updater", () => ({ check: pluginCheck }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: pluginRelaunch }));

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("updater electron 挙動（Phase 2 は null / no-op）", () => {
  it("check は null（=更新なし）で plugin を呼ばない", async () => {
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
    };
    await expect(check()).resolves.toBeNull();
    expect(pluginCheck).not.toHaveBeenCalled();
  });

  it("relaunch は no-op で plugin を呼ばない", async () => {
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
    };
    await expect(relaunch()).resolves.toBeUndefined();
    expect(pluginRelaunch).not.toHaveBeenCalled();
  });
});
