// @vitest-environment happy-dom
/**
 * uiScale の Electron 分岐（設計書 §3.4）: main 経由の setZoomFactor に
 * 統一し、成功時は CSS zoom を外す。失敗時は CSS zoom にフォールバック。
 * （uiScale.test.ts と違い @/lib/tauri は mock しない —
 *  実 isTauri()=false / 実 isElectron()=true の分岐順で通す）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { syncUiScaleFromGlobalSettings } from "./uiScale";

const html = document.documentElement;

beforeEach(() => {
  html.style.removeProperty("--ui-scale");
  html.style.removeProperty("zoom");
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("syncUiScaleFromGlobalSettings electron 分岐", () => {
  it("bridge.setZoomFactor を呼び、CSS zoom は使わない", async () => {
    const setZoomFactor = vi.fn().mockResolvedValue(undefined);
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      setZoomFactor,
    };
    await syncUiScaleFromGlobalSettings({ uiScale: 125 } as never);
    expect(setZoomFactor).toHaveBeenCalledWith(1.25);
    expect(html.style.getPropertyValue("--ui-scale")).toBe("1.25");
    expect(html.style.zoom).toBe("");
  });

  it("setZoomFactor が reject したら CSS zoom にフォールバックする", async () => {
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      setZoomFactor: vi.fn().mockRejectedValue(new Error("ipc down")),
    };
    await syncUiScaleFromGlobalSettings({ uiScale: 125 } as never);
    expect(html.style.zoom).toBe("1.25");
  });

  it("abort 後は DOM に触らない", async () => {
    const abort = { cancelled: false };
    const setZoomFactor = vi.fn(async () => {
      abort.cancelled = true;
    });
    (window as unknown as Record<string, unknown>).grimodex = {
      shell: "electron",
      setZoomFactor,
    };
    html.style.zoom = "9";
    await syncUiScaleFromGlobalSettings({ uiScale: 125 } as never, abort);
    // cancelled 後は removeProperty("zoom") へ到達しない
    expect(html.style.zoom).toBe("9");
  });
});
