import { describe, it, expect } from "vitest";
import {
  resolveCodexColor,
  activeCodexPaletteSlots,
  codexHighlightBackground,
  contrastTextColor,
} from "./resolveCodexColors";
import { PALETTE_SIZE } from "./colorThemes";

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

describe("activeCodexPaletteSlots", () => {
  it("undefined テーマ + light で既定(simple) light パレット全 PALETTE_SIZE スロットを返す", () => {
    const slots = activeCodexPaletteSlots(undefined, false);
    expect(slots).toHaveLength(PALETTE_SIZE);
    // simple light slot0 = Blue（resolveCodexColor の既定テストと整合）
    expect(slots[0].fg).toBe("#2045AA");
  });

  it("指定テーマ light/dark で resolveCodexColor と同じスロットを返す", () => {
    const light = activeCodexPaletteSlots("dark-academia", false);
    expect(light[0]).toMatchObject({
      hl: "#EDE0F5",
      tx: "#5B3080",
      fg: "#6B3D99",
    });
    const dark = activeCodexPaletteSlots("dark-academia", true);
    expect(dark[0].fg).toBe("#B8A0D8");
  });

  it("未知テーマは既定(simple)へフォールバック", () => {
    const slots = activeCodexPaletteSlots("nonexistent-theme", false);
    expect(slots[0].fg).toBe("#2045AA");
  });
});

describe("contrastTextColor", () => {
  it("暗い背景には白文字", () => {
    expect(contrastTextColor("#2045AA")).toBe("#ffffff"); // simple blue
    expect(contrastTextColor("#1a1a1a")).toBe("#ffffff");
  });
  it("明るい背景には濃い文字", () => {
    expect(contrastTextColor("#D8C070")).toBe("#1a1a1a"); // dark theme Topaz
    expect(contrastTextColor("#ffffff")).toBe("#1a1a1a");
  });
  it("hex でない（CSS 変数等）は白にフォールバック", () => {
    expect(contrastTextColor("var(--primary)")).toBe("#ffffff");
  });
});

describe("codexHighlightBackground", () => {
  const colors = { hl: "#E8F0FF", tx: "#1A3A8F", fg: "#2045AA" };

  it("既定レベル 10 はパレット設計値 (hl) をそのまま返す", () => {
    expect(codexHighlightBackground(colors, 10)).toBe("#E8F0FF");
  });

  it("10 未満は hl を透明側へ薄める (レベル×10%)", () => {
    expect(codexHighlightBackground(colors, 5)).toBe(
      "color-mix(in srgb, #E8F0FF 50%, transparent)",
    );
  });

  it("10 超は fg を混ぜて濃くする ((レベル-10)×2%)", () => {
    expect(codexHighlightBackground(colors, 25)).toBe(
      "color-mix(in srgb, #2045AA 30%, #E8F0FF)",
    );
  });

  it("範囲外・非数は 5〜25 にクランプ / 既定 10 扱い", () => {
    expect(codexHighlightBackground(colors, 0)).toBe(
      "color-mix(in srgb, #E8F0FF 50%, transparent)",
    );
    expect(codexHighlightBackground(colors, 100)).toBe(
      "color-mix(in srgb, #2045AA 30%, #E8F0FF)",
    );
    expect(codexHighlightBackground(colors, Number.NaN)).toBe("#E8F0FF");
  });
});
