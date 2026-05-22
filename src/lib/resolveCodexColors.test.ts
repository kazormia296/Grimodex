import { describe, it, expect } from "vitest";
import { resolveCodexColor } from "./resolveCodexColors";

describe("resolveCodexColor", () => {
  it("falls back to legacy color when paletteIndex is null", () => {
    const result = resolveCodexColor(null, "#FF0000", "dark-academia", false);
    expect(result).toEqual({
      hl: "#FF000029",
      tx: "#FF0000",
      fg: "#FF0000",
    });
  });

  it("resolves dark-academia light palette slot 0 (Amethyst)", () => {
    const result = resolveCodexColor(0, "#000000", "dark-academia", false);
    expect(result).toEqual({ hl: "#EDE0F5", tx: "#5B3080", fg: "#6B3D99" });
  });

  it("resolves dark-academia dark palette slot 0 (Amethyst)", () => {
    const result = resolveCodexColor(0, "#000000", "dark-academia", true);
    expect(result).toEqual({ hl: "#2D1F40", tx: "#CFC0E8", fg: "#B8A0D8" });
  });

  it("wraps index when >= PALETTE_SIZE", () => {
    // index 10 should map to slot 0
    const base = resolveCodexColor(0, "#000000", "modern-mystic", false);
    const wrapped = resolveCodexColor(10, "#000000", "modern-mystic", false);
    expect(wrapped).toEqual(base);
  });

  it("falls back to legacy color for unknown theme", () => {
    const result = resolveCodexColor(0, "#ABCDEF", "nonexistent-theme", false);
    expect(result).toEqual({
      hl: "#ABCDEF29",
      tx: "#ABCDEF",
      fg: "#ABCDEF",
    });
  });

  it("uses DEFAULT_COLOR_THEME when themeId is undefined", () => {
    const result = resolveCodexColor(0, "#000000", undefined, false);
    // Should use the simple theme (default), light, slot 0 = Blue
    expect(result).toEqual({ hl: "#E8F0FF", tx: "#1A3A8F", fg: "#2045AA" });
  });
});
