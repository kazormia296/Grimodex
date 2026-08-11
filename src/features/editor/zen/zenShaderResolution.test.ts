import { describe, expect, it } from "vitest";
import {
  resolveZenShaderSceneScale,
  ZEN_SHADER_RESOLUTION_MODES,
} from "./zenShaderResolution";

describe("Zen shader product resolution", () => {
  it("offers only Native, Balanced and Performance", () => {
    expect(ZEN_SHADER_RESOLUTION_MODES).toEqual([
      "native",
      "balanced",
      "performance",
    ]);
  });

  it.each([
    ["native", 1],
    ["balanced", 3 / 4],
    ["performance", 2 / 3],
  ] as const)("maps %s to its product Scene scale", (mode, expected) => {
    expect(resolveZenShaderSceneScale(mode)).toBe(expected);
  });
});
