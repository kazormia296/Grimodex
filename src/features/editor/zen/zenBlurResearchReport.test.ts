import { describe, expect, it } from "vitest";
import type {
  ZenMultipassPerformanceReport,
  ZenTimingPercentiles,
} from "./ZenMultipassCanvas";
import {
  DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
  type ZenBlurResearchOptions,
} from "./zenBlurResearchConfig";
import { buildZenBlurResearchArtifact } from "./zenBlurResearchReport";
import type { ZenGpuPassTimesMs } from "./zenGpuTimerSampler";
import type { ZenWebGlMetadata } from "./zenWebGlDiagnostics";

const GPU_METADATA: ZenWebGlMetadata = {
  vendor: "Chromium",
  renderer: "WebKit WebGL",
  unmaskedVendor: "NVIDIA Corporation",
  unmaskedRenderer: "ANGLE (NVIDIA, RTX 2070 SUPER, D3D11)",
  version: "WebGL 2.0",
  shadingLanguageVersion: "WebGL GLSL ES 3.00",
  maxTextureSize: 16_384,
  maxTextureImageUnits: 16,
  userAgent: "Grimodex benchmark agent",
  platform: "Win32",
};

const PASS_MULTIPLIERS: Readonly<ZenGpuPassTimesMs> = {
  scene: 1,
  downsample: 2,
  gaussianHorizontal: 3,
  gaussianVertical: 4,
  kawaseDown: 5,
  kawaseUp: 6,
  composite: 7,
};

function passTimes(factor: number): ZenGpuPassTimesMs {
  return {
    scene: factor,
    downsample: factor * 2,
    gaussianHorizontal: factor * 3,
    gaussianVertical: factor * 4,
    kawaseDown: factor * 5,
    kawaseUp: factor * 6,
    composite: factor * 7,
  };
}

function researchOptions(): ZenBlurResearchOptions {
  return {
    ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
    backend: "dual-kawase-planned",
    dualKawase: { passes: 3, offset: 3 },
    displayNoise: { mode: "none", strength: 0, seed: 0 },
    rgba8Dither: { strength: 0, seed: 0 },
    gpuTiming: {
      sampleIntervalDraws: 1,
      maxPendingSamples: 4,
      maxRecordedSamples: 600,
    },
  };
}

function benchmarkRun({
  capturedAtEpochMs,
  gpuFactors,
  cpuSubmitTimesMs,
  drawCallCount,
  intermediateTextureBytes,
  reallocationCount,
  gpuMetadata = GPU_METADATA,
}: {
  capturedAtEpochMs: number;
  gpuFactors: readonly number[];
  cpuSubmitTimesMs: readonly number[];
  drawCallCount: number;
  intermediateTextureBytes: number;
  reallocationCount: number;
  gpuMetadata?: ZenWebGlMetadata;
}): ZenMultipassPerformanceReport {
  const options = researchOptions();
  const gpuSamples = gpuFactors.map((factor, index) => ({
    drawCount: index + 1,
    gpuTimeMs: factor * 10,
    blurGpuTimeMs: factor * 3,
    gpuPassTimesMs: passTimes(factor),
  }));
  const cpuSamples = cpuSubmitTimesMs.map((cpuSubmitTimeMs, index) => ({
    drawCount: index + 1,
    drawCallCount,
    cpuSubmitTimeMs,
  }));
  const lastGpuSample = gpuSamples.at(-1) ?? null;
  const lastCpuSample = cpuSamples.at(-1) ?? null;

  return {
    schemaVersion: 1,
    capturedAtEpochMs,
    backend: options.backend,
    researchOptions: options,
    gpuMetadata: { ...gpuMetadata },
    performanceStats: {
      drawCount: gpuSamples.length,
      drawCallCount,
      backend: options.backend,
      gpuTimeMs: lastGpuSample?.gpuTimeMs ?? null,
      gpuPassTimesMs: lastGpuSample?.gpuPassTimesMs ?? null,
      gpuTimingStatus: lastGpuSample ? "ready" : "idle",
      gpuTimingSampleCount: gpuSamples.length,
      gpuTimingSampleDrawCount: lastGpuSample?.drawCount ?? null,
      isStaticFrameReady: true,
      blurFormat: "rgba8",
      blurTargetAFormat: "rgba8",
      blurTargetBFormat: "rgba8",
      sceneTargetWidth: 1_920,
      sceneTargetHeight: 1_080,
      blurTargetWidth: 524,
      blurTargetHeight: 295,
      gaussianPairCount: 0,
      kawaseDownsamplePassCount: 3,
      kawaseUpsamplePassCount: 3,
      blurTargetLevels: [
        {
          level: 0,
          width: 524,
          height: 295,
          format: "rgba8",
          bytes: 524 * 295 * 4,
        },
      ],
      intermediateTextureBytes,
      blurTargetReallocationCount: reallocationCount,
      cpuSubmitTimeMs: lastCpuSample?.cpuSubmitTimeMs ?? null,
      cpuSubmitSampleCount: cpuSamples.length,
      cpuSubmitSummary: null,
      displayNoise: { ...options.displayNoise },
      rgba8Dither: { ...options.rgba8Dither },
    },
    gpuBenchmark: {
      samples: gpuSamples,
      // The artifact must aggregate raw samples, not trust a per-run summary.
      summary: null,
    },
    cpuSubmit: {
      samples: cpuSamples,
      summary: null,
    },
  };
}

function scaledPercentiles(multiplier: number): ZenTimingPercentiles {
  return {
    p50: multiplier * 2,
    p95: multiplier * 4,
    p99: multiplier * 4,
  };
}

describe("Zen blur research artifact", () => {
  it("pools raw run samples into reproducible nearest-rank aggregates", () => {
    const scenario = {
      id: "zen-glass-1080p-blur-22",
      cssWidth: 1_920,
      cssHeight: 1_080,
      blurRadiusPx: 22,
      glassCoverage: 0.4,
    };
    const candidate = {
      backend: "dual-kawase-planned",
      passes: 3,
      offset: 3,
      textureFormat: "rgba8",
    };
    const runs = [
      benchmarkRun({
        capturedAtEpochMs: 1_725_000_000_000,
        gpuFactors: [1, 4],
        cpuSubmitTimesMs: [0.1, 0.4],
        drawCallCount: 7,
        intermediateTextureBytes: 812_000,
        reallocationCount: 2,
      }),
      benchmarkRun({
        capturedAtEpochMs: 1_725_000_000_100,
        gpuFactors: [2, 3],
        cpuSubmitTimesMs: [0.2, 0.3],
        drawCallCount: 9,
        intermediateTextureBytes: 936_000,
        reallocationCount: 1,
      }),
    ];
    const before = Date.now();

    const artifact = buildZenBlurResearchArtifact({
      scenario,
      candidate,
      runs,
    });

    expect(artifact).toMatchObject({
      schemaVersion: 1,
      scenario,
      candidate,
      gpuMetadata: GPU_METADATA,
      aggregate: {
        runCount: 2,
        sampleCount: 4,
        cpuSubmitSampleCount: 4,
        gpuTimeMs: scaledPercentiles(10),
        blurGpuTimeMs: scaledPercentiles(3),
        gpuPassTimesMs: Object.fromEntries(
          Object.entries(PASS_MULTIPLIERS).map(([pass, multiplier]) => [
            pass,
            scaledPercentiles(multiplier),
          ]),
        ),
        cpuSubmitTimeMs: {
          p50: 0.2,
          p95: 0.4,
          p99: 0.4,
        },
        drawCallCountMedian: 8,
        intermediateTextureBytesMax: 936_000,
        reallocationCountTotal: 3,
      },
    });
    expect(artifact.capturedAtEpochMs).toBeGreaterThanOrEqual(before);
    expect(artifact.capturedAtEpochMs).toBeLessThanOrEqual(Date.now());
    expect(artifact.runs).toEqual(runs);
    expect(artifact.runs).not.toBe(runs);
    expect(artifact.runs[0]).not.toBe(runs[0]);
    expect(artifact.runs[0]?.gpuBenchmark.samples).not.toBe(
      runs[0]?.gpuBenchmark.samples,
    );
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
  });

  it("requires at least one run and one stable GPU identity", () => {
    expect(() =>
      buildZenBlurResearchArtifact({
        scenario: { id: "empty" },
        candidate: { backend: "gaussian-current" },
        runs: [],
      }),
    ).toThrow(/run/i);

    const first = benchmarkRun({
      capturedAtEpochMs: 1,
      gpuFactors: [1],
      cpuSubmitTimesMs: [0.1],
      drawCallCount: 5,
      intermediateTextureBytes: 1_000,
      reallocationCount: 0,
    });
    const differentGpu = benchmarkRun({
      capturedAtEpochMs: 2,
      gpuFactors: [2],
      cpuSubmitTimesMs: [0.2],
      drawCallCount: 5,
      intermediateTextureBytes: 1_000,
      reallocationCount: 0,
      gpuMetadata: {
        ...GPU_METADATA,
        unmaskedRenderer: "ANGLE (Intel, UHD Graphics 770, D3D11)",
      },
    });

    expect(() =>
      buildZenBlurResearchArtifact({
        scenario: { id: "mixed-gpu" },
        candidate: { backend: "gaussian-current" },
        runs: [first, differentGpu],
      }),
    ).toThrow(/GPU|metadata|identity/i);
  });

  it("rejects values that cannot be represented as stable JSON", () => {
    const invalidRun = benchmarkRun({
      capturedAtEpochMs: 1,
      gpuFactors: [1],
      cpuSubmitTimesMs: [0.1],
      drawCallCount: 5,
      intermediateTextureBytes: Number.NaN,
      reallocationCount: 0,
    });

    expect(() =>
      buildZenBlurResearchArtifact({
        scenario: { id: "nan-run" },
        candidate: { backend: "gaussian-current" },
        runs: [invalidRun],
      }),
    ).toThrow(/JSON|finite|NaN/i);
    expect(() =>
      buildZenBlurResearchArtifact({
        scenario: { id: "undefined-scenario", blurRadiusPx: undefined },
        candidate: { backend: "gaussian-current" },
        runs: [
          benchmarkRun({
            capturedAtEpochMs: 1,
            gpuFactors: [1],
            cpuSubmitTimesMs: [0.1],
            drawCallCount: 5,
            intermediateTextureBytes: 1_000,
            reallocationCount: 0,
          }),
        ],
      }),
    ).toThrow(/JSON|undefined/i);
  });
});
