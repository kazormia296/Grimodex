import { describe, it, expect } from "vitest";
import { expandPreset, inferPreset } from "./preset";

describe("expandPreset", () => {
  it("full → all true", () => {
    expect(expandPreset("full")).toEqual({
      chat: true,
      bodyWrite: true,
      analysis: true,
    });
  });

  it("assist-off → bodyWrite false", () => {
    expect(expandPreset("assist-off")).toEqual({
      chat: true,
      bodyWrite: false,
      analysis: true,
    });
  });

  it("review-only → chat and bodyWrite false", () => {
    expect(expandPreset("review-only")).toEqual({
      chat: false,
      bodyWrite: false,
      analysis: true,
    });
  });

  it("off → all false", () => {
    expect(expandPreset("off")).toEqual({
      chat: false,
      bodyWrite: false,
      analysis: false,
    });
  });

  it("custom → falls back to full toggles", () => {
    expect(expandPreset("custom")).toEqual({
      chat: true,
      bodyWrite: true,
      analysis: true,
    });
  });
});

describe("inferPreset", () => {
  it("all true → full", () => {
    expect(inferPreset({ chat: true, bodyWrite: true, analysis: true })).toBe(
      "full",
    );
  });

  it("assist-off pattern", () => {
    expect(inferPreset({ chat: true, bodyWrite: false, analysis: true })).toBe(
      "assist-off",
    );
  });

  it("review-only pattern", () => {
    expect(inferPreset({ chat: false, bodyWrite: false, analysis: true })).toBe(
      "review-only",
    );
  });

  it("all false → off", () => {
    expect(
      inferPreset({ chat: false, bodyWrite: false, analysis: false }),
    ).toBe("off");
  });

  it("undefined combination → custom", () => {
    expect(inferPreset({ chat: true, bodyWrite: true, analysis: false })).toBe(
      "custom",
    );
  });

  it("another undefined combination → custom", () => {
    expect(inferPreset({ chat: false, bodyWrite: true, analysis: false })).toBe(
      "custom",
    );
  });
});
