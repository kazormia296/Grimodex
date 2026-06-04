import { describe, it, expect } from "vitest";
import { expandPreset, inferPreset } from "./preset";

describe("expandPreset", () => {
  it("full → all true", () => {
    expect(expandPreset("full")).toEqual({
      chat: true,
      bodyWrite: true,
      analysis: true,
      structureWrite: true,
    });
  });

  it("assist-off → bodyWrite false, structureWrite stays true", () => {
    expect(expandPreset("assist-off")).toEqual({
      chat: true,
      bodyWrite: false,
      analysis: true,
      structureWrite: true,
    });
  });

  it("review-only → only analysis", () => {
    expect(expandPreset("review-only")).toEqual({
      chat: false,
      bodyWrite: false,
      analysis: true,
      structureWrite: false,
    });
  });

  it("off → all false", () => {
    expect(expandPreset("off")).toEqual({
      chat: false,
      bodyWrite: false,
      analysis: false,
      structureWrite: false,
    });
  });

  it("custom → falls back to full toggles", () => {
    expect(expandPreset("custom")).toEqual({
      chat: true,
      bodyWrite: true,
      analysis: true,
      structureWrite: true,
    });
  });
});

describe("inferPreset", () => {
  it("all true → full", () => {
    expect(
      inferPreset({
        chat: true,
        bodyWrite: true,
        analysis: true,
        structureWrite: true,
      }),
    ).toBe("full");
  });

  it("assist-off pattern", () => {
    expect(
      inferPreset({
        chat: true,
        bodyWrite: false,
        analysis: true,
        structureWrite: true,
      }),
    ).toBe("assist-off");
  });

  it("review-only pattern", () => {
    expect(
      inferPreset({
        chat: false,
        bodyWrite: false,
        analysis: true,
        structureWrite: false,
      }),
    ).toBe("review-only");
  });

  it("all false → off", () => {
    expect(
      inferPreset({
        chat: false,
        bodyWrite: false,
        analysis: false,
        structureWrite: false,
      }),
    ).toBe("off");
  });

  it("full toggles but structureWrite off → custom", () => {
    expect(
      inferPreset({
        chat: true,
        bodyWrite: true,
        analysis: true,
        structureWrite: false,
      }),
    ).toBe("custom");
  });

  it("undefined combination → custom", () => {
    expect(
      inferPreset({
        chat: true,
        bodyWrite: true,
        analysis: false,
        structureWrite: true,
      }),
    ).toBe("custom");
  });
});
