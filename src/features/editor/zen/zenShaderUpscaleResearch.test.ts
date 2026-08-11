import { describe, expect, it } from "vitest";
import {
  buildZenShaderUpscaleResearchMatrix,
  buildZenShaderUpscaleResearchSchedule,
  resolveZenShaderUpscaleDimensions,
} from "./zenShaderUpscaleResearch";

describe("Zen shader upscale research", () => {
  it("builds the fixed 4x4 scale and upscaler comparison matrix", () => {
    const matrix = buildZenShaderUpscaleResearchMatrix();

    expect(matrix).toHaveLength(16);
    expect(matrix.map(({ sceneScale }) => sceneScale)).toEqual([
      1,
      1,
      1,
      1,
      5 / 6,
      5 / 6,
      5 / 6,
      5 / 6,
      3 / 4,
      3 / 4,
      3 / 4,
      3 / 4,
      2 / 3,
      2 / 3,
      2 / 3,
      2 / 3,
    ]);
    expect(matrix.slice(0, 4).map(({ upscaler }) => upscaler)).toEqual([
      "linear",
      "catmull-rom",
      "easu",
      "easu-rcas",
    ]);
    expect(new Set(matrix.map(({ id }) => id)).size).toBe(matrix.length);
  });

  it("resolves exact Full HD research dimensions without exceeding the canvas", () => {
    expect(resolveZenShaderUpscaleDimensions(1_920, 1_080, 1)).toEqual({
      width: 1_920,
      height: 1_080,
    });
    expect(resolveZenShaderUpscaleDimensions(1_920, 1_080, 5 / 6)).toEqual({
      width: 1_600,
      height: 900,
    });
    expect(resolveZenShaderUpscaleDimensions(1_920, 1_080, 3 / 4)).toEqual({
      width: 1_440,
      height: 810,
    });
    expect(resolveZenShaderUpscaleDimensions(1_920, 1_080, 2 / 3)).toEqual({
      width: 1_280,
      height: 720,
    });
  });

  it("rejects invalid dimensions and scales", () => {
    expect(() => resolveZenShaderUpscaleDimensions(0, 1_080, 3 / 4)).toThrow(
      /width/i,
    );
    expect(() => resolveZenShaderUpscaleDimensions(1_920, 1.5, 3 / 4)).toThrow(
      /height/i,
    );
    expect(() => resolveZenShaderUpscaleDimensions(1_920, 1_080, 0)).toThrow(
      /scale/i,
    );
    expect(() => resolveZenShaderUpscaleDimensions(1_920, 1_080, 1.01)).toThrow(
      /scale/i,
    );
  });

  it("builds alternating same-context native/candidate ABBA and BAAB cycles", () => {
    expect(buildZenShaderUpscaleResearchSchedule(4, "ABBA")).toEqual([
      {
        runIndex: 0,
        sequence: "ABBA",
        variants: ["native", "candidate", "candidate", "native"],
      },
      {
        runIndex: 1,
        sequence: "BAAB",
        variants: ["candidate", "native", "native", "candidate"],
      },
      {
        runIndex: 2,
        sequence: "ABBA",
        variants: ["native", "candidate", "candidate", "native"],
      },
      {
        runIndex: 3,
        sequence: "BAAB",
        variants: ["candidate", "native", "native", "candidate"],
      },
    ]);
  });
});
