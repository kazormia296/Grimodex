import { describe, expect, it } from "vitest";
import { normalizeZenThemeColor } from "./zenThemePalette";

describe("Zen theme palette color normalization", () => {
  it("passes Paper-compatible hex colors through unchanged", () => {
    expect(normalizeZenThemeColor("#8FB4D6", "#000000")).toBe("#8FB4D6");
  });

  it("converts OKLCH colors without a canvas or pixel readback", () => {
    expect(normalizeZenThemeColor("oklch(1 0 0)", "#000000")).toBe(
      "rgba(255, 255, 255, 1)",
    );
    expect(normalizeZenThemeColor("oklch(0 0 0)", "#ffffff")).toBe(
      "rgba(0, 0, 0, 1)",
    );
    expect(normalizeZenThemeColor("oklch(0.5 0 0)", "#000000")).toBe(
      "rgba(99, 99, 99, 1)",
    );
  });

  it("falls back when a theme color is outside the supported static formats", () => {
    expect(normalizeZenThemeColor("var(--dynamic)", "#123456")).toBe("#123456");
  });
});
