import { describe, it, expect } from "vitest";
import { laneColorFor, tintColor, ringColor } from "./laneColor";

describe("laneColorFor", () => {
  it("is deterministic for the same id", () => {
    expect(laneColorFor("c1")).toBe(laneColorFor("c1"));
    expect(laneColorFor("aya")).toBe(laneColorFor("aya"));
  });

  it("produces stable known outputs", () => {
    expect(laneColorFor("c1")).toBe("oklch(0.58 0.13 137)");
    expect(laneColorFor("c2")).toBe("oklch(0.58 0.13 320)");
    expect(laneColorFor("aya")).toBe("oklch(0.58 0.13 154)");
  });

  it("returns neutral gray for null/undefined/empty", () => {
    expect(laneColorFor(null)).toBe("oklch(0.62 0 0)");
    expect(laneColorFor(undefined)).toBe("oklch(0.62 0 0)");
    expect(laneColorFor("")).toBe("oklch(0.62 0 0)");
  });

  it("always emits an oklch(...) string", () => {
    for (const id of ["c1", "c2", "aya", "x", "long-entity-id"]) {
      expect(laneColorFor(id)).toMatch(/^oklch\(/);
    }
    expect(laneColorFor(null)).toMatch(/^oklch\(/);
  });

  it("produces generally distinct hues for different ids", () => {
    const hues = ["c1", "c2", "aya"].map((id) => laneColorFor(id));
    const unique = new Set(hues);
    // At least 2 of 3 should differ.
    expect(unique.size).toBeGreaterThanOrEqual(2);
  });
});

describe("tintColor / ringColor", () => {
  it("tintColor mixes toward white", () => {
    expect(tintColor("oklch(0.58 0.13 218)", 60)).toBe(
      "color-mix(in oklch, oklch(0.58 0.13 218) 60%, #ffffff)",
    );
  });

  it("ringColor mixes toward transparent", () => {
    expect(ringColor("oklch(0.58 0.13 218)", 40)).toBe(
      "color-mix(in oklch, oklch(0.58 0.13 218) 40%, transparent)",
    );
  });
});
