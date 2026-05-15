/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCREENSHOT_CAPTURE_UI_SCALE_MAX_PCT } from "@/screenshot-scenes/captureManifest";
import { SCREENSHOT_MODE_LOCALSTORAGE_KEY } from "@/screenshot-scenes/screenshotMode";
import {
  UI_SCALE_MAX_PCT,
  UI_SCALE_MIN_PCT,
  clampUiScalePercent,
  uiScalePercentToFactor,
} from "./uiScale";

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

  it(`clamps above ${UI_SCALE_MAX_PCT}`, () => {
    expect(clampUiScalePercent(200)).toBe(UI_SCALE_MAX_PCT);
    expect(clampUiScalePercent(151)).toBe(UI_SCALE_MAX_PCT);
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
    expect(uiScalePercentToFactor(200)).toBe(UI_SCALE_MAX_PCT / 100);
  });
});
