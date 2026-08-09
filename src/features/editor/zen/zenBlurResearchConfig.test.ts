import { describe, expect, it } from "vitest";
import {
  DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
  resolveZenBlurResearchOptions,
} from "./zenBlurResearchConfig";

describe("Zen blur research configuration", () => {
  it("keeps the production renderer on the current Gaussian path by default", () => {
    expect(resolveZenBlurResearchOptions({})).toEqual(
      DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
    );
    expect(DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS).toMatchObject({
      backend: "gaussian-current",
      dualKawase: { passes: 3, offset: 3 },
      displayNoise: { mode: "none", strength: 0, seed: 0 },
      rgba8Dither: { strength: 0, seed: 0 },
      gpuTiming: {
        sampleIntervalDraws: 30,
        maxPendingSamples: 1,
        maxRecordedSamples: 600,
      },
    });
  });

  it("parses an explicit internal Dual Kawase benchmark without exposing a user setting", () => {
    expect(
      resolveZenBlurResearchOptions({
        VITE_ZEN_BLUR_BACKEND: "dual-kawase-planned",
        VITE_ZEN_DUAL_KAWASE_PASSES: "4",
        VITE_ZEN_DUAL_KAWASE_OFFSET: "2.5",
        VITE_ZEN_GPU_SAMPLE_INTERVAL_DRAWS: "1",
        VITE_ZEN_GPU_MAX_PENDING_SAMPLES: "8",
        VITE_ZEN_GPU_MAX_RECORDED_SAMPLES: "720",
      }),
    ).toMatchObject({
      backend: "dual-kawase-planned",
      dualKawase: { passes: 4, offset: 2.5 },
      gpuTiming: {
        sampleIntervalDraws: 1,
        maxPendingSamples: 8,
        maxRecordedSamples: 720,
      },
    });
  });

  it("keeps display noise and RGBA8 quantization dither independent", () => {
    const displayOnly = resolveZenBlurResearchOptions({
      VITE_ZEN_GLASS_NOISE_MODE: "procedural-white",
      VITE_ZEN_GLASS_NOISE_STRENGTH: "0.01",
      VITE_ZEN_GLASS_NOISE_SEED: "17",
    });
    const ditherOnly = resolveZenBlurResearchOptions({
      VITE_ZEN_RGBA8_DITHER_STRENGTH: "0.0039215686",
      VITE_ZEN_RGBA8_DITHER_SEED: "29",
    });

    expect(displayOnly.displayNoise).toEqual({
      mode: "procedural-white",
      strength: 0.01,
      seed: 17,
    });
    expect(displayOnly.rgba8Dither.strength).toBe(0);
    expect(ditherOnly.displayNoise.mode).toBe("none");
    expect(ditherOnly.rgba8Dither).toEqual({
      strength: 0.0039215686,
      seed: 29,
    });
  });

  it("rejects unknown, non-finite, and out-of-range experiment values", () => {
    expect(
      resolveZenBlurResearchOptions({
        VITE_ZEN_BLUR_BACKEND: "xray",
        VITE_ZEN_DUAL_KAWASE_PASSES: "12",
        VITE_ZEN_DUAL_KAWASE_OFFSET: "NaN",
        VITE_ZEN_GLASS_NOISE_MODE: "animated-blue",
        VITE_ZEN_GLASS_NOISE_STRENGTH: "-1",
        VITE_ZEN_RGBA8_DITHER_STRENGTH: "4",
        VITE_ZEN_GPU_SAMPLE_INTERVAL_DRAWS: "0",
        VITE_ZEN_GPU_MAX_PENDING_SAMPLES: "-2",
        VITE_ZEN_GPU_MAX_RECORDED_SAMPLES: "Infinity",
      }),
    ).toEqual(DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS);
  });
});
