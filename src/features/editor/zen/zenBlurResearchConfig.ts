import type { ZenBlurBackend } from "./zenDualKawase";

export type { ZenBlurBackend } from "./zenDualKawase";

export type ZenDisplayNoiseMode = "none" | "procedural-white";

export interface ZenBlurResearchOptions {
  backend: ZenBlurBackend;
  dualKawase: {
    passes: number;
    offset: number;
  };
  displayNoise: {
    mode: ZenDisplayNoiseMode;
    strength: number;
    seed: number;
  };
  rgba8Dither: {
    strength: number;
    seed: number;
  };
  gpuTiming: {
    sampleIntervalDraws: number;
    maxPendingSamples: number;
    maxRecordedSamples: number;
  };
}

export const DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS: ZenBlurResearchOptions = {
  backend: "gaussian-current",
  dualKawase: {
    passes: 3,
    offset: 3,
  },
  displayNoise: {
    mode: "none",
    strength: 0,
    seed: 0,
  },
  rgba8Dither: {
    strength: 0,
    seed: 0,
  },
  gpuTiming: {
    sampleIntervalDraws: 30,
    maxPendingSamples: 1,
    maxRecordedSamples: 600,
  },
};

type ZenBlurResearchEnvironment = Readonly<Record<string, unknown>>;

function enumValue<Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  fallback: Value,
) {
  return typeof value === "string" && allowed.includes(value as Value)
    ? (value as Value)
    : fallback;
}

function numericValue(
  value: unknown,
  fallback: number,
  {
    minimum,
    maximum,
    integer = false,
  }: {
    minimum: number;
    maximum: number;
    integer?: boolean;
  },
) {
  if (typeof value !== "string" || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < minimum ||
    parsed > maximum ||
    (integer && !Number.isInteger(parsed))
  ) {
    return fallback;
  }
  return parsed;
}

function seedValue(value: unknown, fallback: number) {
  return numericValue(value, fallback, {
    minimum: 0,
    maximum: 0xffff_ffff,
    integer: true,
  });
}

export function resolveZenBlurResearchOptions(
  environment: ZenBlurResearchEnvironment,
): ZenBlurResearchOptions {
  const defaults = DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS;
  return {
    backend: enumValue(
      environment.VITE_ZEN_BLUR_BACKEND,
      ["gaussian-current", "dual-kawase-canonical", "dual-kawase-planned"],
      defaults.backend,
    ),
    dualKawase: {
      passes: numericValue(
        environment.VITE_ZEN_DUAL_KAWASE_PASSES,
        defaults.dualKawase.passes,
        { minimum: 1, maximum: 4, integer: true },
      ),
      offset: numericValue(
        environment.VITE_ZEN_DUAL_KAWASE_OFFSET,
        defaults.dualKawase.offset,
        { minimum: 0.5, maximum: 4 },
      ),
    },
    displayNoise: {
      mode: enumValue(
        environment.VITE_ZEN_GLASS_NOISE_MODE,
        ["none", "procedural-white"],
        defaults.displayNoise.mode,
      ),
      strength: numericValue(
        environment.VITE_ZEN_GLASS_NOISE_STRENGTH,
        defaults.displayNoise.strength,
        { minimum: 0, maximum: 0.02 },
      ),
      seed: seedValue(
        environment.VITE_ZEN_GLASS_NOISE_SEED,
        defaults.displayNoise.seed,
      ),
    },
    rgba8Dither: {
      strength: numericValue(
        environment.VITE_ZEN_RGBA8_DITHER_STRENGTH,
        defaults.rgba8Dither.strength,
        { minimum: 0, maximum: 1 / 255 },
      ),
      seed: seedValue(
        environment.VITE_ZEN_RGBA8_DITHER_SEED,
        defaults.rgba8Dither.seed,
      ),
    },
    gpuTiming: {
      sampleIntervalDraws: numericValue(
        environment.VITE_ZEN_GPU_SAMPLE_INTERVAL_DRAWS,
        defaults.gpuTiming.sampleIntervalDraws,
        { minimum: 1, maximum: 10_000, integer: true },
      ),
      maxPendingSamples: numericValue(
        environment.VITE_ZEN_GPU_MAX_PENDING_SAMPLES,
        defaults.gpuTiming.maxPendingSamples,
        { minimum: 1, maximum: 64, integer: true },
      ),
      maxRecordedSamples: numericValue(
        environment.VITE_ZEN_GPU_MAX_RECORDED_SAMPLES,
        defaults.gpuTiming.maxRecordedSamples,
        { minimum: 1, maximum: 100_000, integer: true },
      ),
    },
  };
}
