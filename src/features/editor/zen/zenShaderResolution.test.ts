import { describe, expect, it } from "vitest";
import {
  resolveZenShaderEffectiveSceneScale,
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

  it.each([
    ["balanced", true, false],
    ["performance", false, true],
    ["performance", true, true],
  ] as const)(
    "keeps output-sampled effects native for %s (dither=%s, halftone=%s)",
    (mode, ditherEnabled, halftoneEnabled) => {
      expect(
        resolveZenShaderEffectiveSceneScale({
          mode,
          ditherEnabled,
          halftoneEnabled,
        }),
      ).toBe(1);
    },
  );

  it("keeps the selected scale when output-sampled effects are disabled", () => {
    expect(
      resolveZenShaderEffectiveSceneScale({
        mode: "balanced",
        ditherEnabled: false,
        halftoneEnabled: false,
      }),
    ).toBe(3 / 4);
  });
});
