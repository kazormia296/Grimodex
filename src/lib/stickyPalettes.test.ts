import { describe, it, expect } from "vitest";
import {
  POST_IT_PLAYFUL,
  PALETTES,
  DEFAULT_PALETTE_ID,
  getPalette,
  resolveStickyHex,
} from "./stickyPalettes";

describe("stickyPalettes", () => {
  it("post-it-playful has 10 distinct colors (iris dup collapsed)", () => {
    expect(POST_IT_PLAYFUL.colors).toHaveLength(10);
    const hexes = POST_IT_PLAYFUL.colors.map((c) => c.hex);
    expect(new Set(hexes).size).toBe(hexes.length);
  });

  it("default palette is registered", () => {
    expect(PALETTES[DEFAULT_PALETTE_ID]).toBe(POST_IT_PLAYFUL);
  });

  describe("resolveStickyHex", () => {
    it("returns the hex of a valid (palette, slot)", () => {
      expect(resolveStickyHex("post-it-playful", 0)).toBe("#FFD93D");
      expect(resolveStickyHex("post-it-playful", 5)).toBe("#7B5FA8");
    });

    it("falls back to slot 0 when slot is out of range", () => {
      expect(resolveStickyHex("post-it-playful", 999)).toBe(
        POST_IT_PLAYFUL.colors[0].hex,
      );
      expect(resolveStickyHex("post-it-playful", -1)).toBe(
        POST_IT_PLAYFUL.colors[0].hex,
      );
    });

    it("falls back to default palette when paletteId is unknown", () => {
      expect(resolveStickyHex("does-not-exist", 0)).toBe(
        POST_IT_PLAYFUL.colors[0].hex,
      );
    });
  });

  describe("getPalette", () => {
    it("returns the named palette when it exists", () => {
      expect(getPalette("post-it-playful")).toBe(POST_IT_PLAYFUL);
    });
    it("falls back to default when paletteId is unknown", () => {
      expect(getPalette("nope")).toBe(POST_IT_PLAYFUL);
    });
  });
});
