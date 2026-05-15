/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT } from "@/screenshot-scenes/captureManifest";
import { SCREENSHOT_MODE_LOCALSTORAGE_KEY } from "@/screenshot-scenes/screenshotMode";
import {
  UI_SCALE_MAX_PCT_SETTINGS,
  UI_SCALE_MIN_PCT,
  clampUiScalePercent,
  syncUiScaleFromGlobalSettings,
  uiScalePercentToFactor,
} from "./uiScale";

const setZoomMock = vi.fn(async (_: number) => {});

vi.mock("@/lib/tauri", () => ({
  isTauri: () => false,
}));

vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: setZoomMock }),
}));

describe("clampUiScalePercent (non-staging)", () => {
  beforeEach(() => {
    localStorage.removeItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY);
  });

  it("defaults undefined to 100", () => {
    expect(clampUiScalePercent(undefined)).toBe(100);
  });

  it(`clamps below ${UI_SCALE_MIN_PCT}`, () => {
    expect(clampUiScalePercent(50)).toBe(UI_SCALE_MIN_PCT);
    expect(clampUiScalePercent(79)).toBe(UI_SCALE_MIN_PCT);
  });

  it(`clamps above ${UI_SCALE_MAX_PCT_SETTINGS}`, () => {
    expect(clampUiScalePercent(200)).toBe(UI_SCALE_MAX_PCT_SETTINGS);
    expect(clampUiScalePercent(151)).toBe(UI_SCALE_MAX_PCT_SETTINGS);
  });

  it("preserves in-range values", () => {
    expect(clampUiScalePercent(80)).toBe(80);
    expect(clampUiScalePercent(100)).toBe(100);
    expect(clampUiScalePercent(150)).toBe(150);
  });
});

describe("clampUiScalePercent (screenshot staging)", () => {
  beforeEach(() => {
    localStorage.setItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY, "true");
  });

  afterEach(() => {
    localStorage.removeItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY);
  });

  it("allows percentages above settings max up to screenshot cap", () => {
    expect(clampUiScalePercent(200)).toBe(200);
    expect(clampUiScalePercent(SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT)).toBe(
      SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT,
    );
    expect(clampUiScalePercent(501)).toBe(SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT);
  });
});

describe("uiScalePercentToFactor", () => {
  beforeEach(() => {
    localStorage.removeItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY);
  });

  it("maps 100% to 1", () => {
    expect(uiScalePercentToFactor(100)).toBe(1);
  });

  it("maps bounds to clamped factors", () => {
    expect(uiScalePercentToFactor(50)).toBe(UI_SCALE_MIN_PCT / 100);
    expect(uiScalePercentToFactor(200)).toBe(UI_SCALE_MAX_PCT_SETTINGS / 100);
  });
});

describe("syncUiScaleFromGlobalSettings (non-Tauri)", () => {
  const html = document.documentElement;

  beforeEach(() => {
    localStorage.removeItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY);
    html.style.removeProperty("--ui-scale");
    html.style.removeProperty("zoom");
    setZoomMock.mockClear();
  });

  it("sets --ui-scale to 1 and clears zoom when settings are null", async () => {
    await syncUiScaleFromGlobalSettings(null);
    expect(html.style.getPropertyValue("--ui-scale")).toBe("1");
    expect(html.style.zoom).toBe("");
    expect(setZoomMock).not.toHaveBeenCalled();
  });

  it("sets zoom CSS for non-100% scale", async () => {
    await syncUiScaleFromGlobalSettings({ uiScale: 125 } as never);
    expect(html.style.getPropertyValue("--ui-scale")).toBe("1.25");
    expect(html.style.zoom).toBe("1.25");
  });

  it("removes zoom property at 100%", async () => {
    html.style.zoom = "1.5";
    await syncUiScaleFromGlobalSettings({ uiScale: 100 } as never);
    expect(html.style.getPropertyValue("--ui-scale")).toBe("1");
    expect(html.style.zoom).toBe("");
  });

  it("clamps out-of-range values when not in staging", async () => {
    await syncUiScaleFromGlobalSettings({ uiScale: 999 } as never);
    expect(html.style.getPropertyValue("--ui-scale")).toBe(
      String(UI_SCALE_MAX_PCT_SETTINGS / 100),
    );
  });

  it("honors staging cap when staging flag is set", async () => {
    localStorage.setItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY, "true");
    try {
      await syncUiScaleFromGlobalSettings({ uiScale: 300 } as never);
      expect(html.style.getPropertyValue("--ui-scale")).toBe("3");
      expect(html.style.zoom).toBe("3");
    } finally {
      localStorage.removeItem(SCREENSHOT_MODE_LOCALSTORAGE_KEY);
    }
  });
});
