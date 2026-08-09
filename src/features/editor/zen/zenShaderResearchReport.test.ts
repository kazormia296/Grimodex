import { describe, expect, it } from "vitest";
import type { ZenMultipassPerformanceReport } from "./ZenBlurResearchCanvas";
import {
  DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
  type ZenBlurResearchOptions,
} from "./zenBlurResearchConfig";
import { buildZenShaderResearchArtifact } from "./zenShaderResearchReport";
import type { ZenGpuPassTimesMs, ZenGpuTimingMode } from "./zenGpuTimerSampler";
import type { ZenWebGlMetadata } from "./zenWebGlDiagnostics";

const GPU_METADATA: ZenWebGlMetadata = {
  vendor: "Chromium",
  renderer: "WebKit WebGL",
  unmaskedVendor: "NVIDIA Corporation",
  unmaskedRenderer: "ANGLE (NVIDIA, RTX 4090, D3D11)",
  version: "WebGL 2.0",
  shadingLanguageVersion: "WebGL GLSL ES 3.00",
  maxTextureSize: 16_384,
  maxTextureImageUnits: 16,
  userAgent: "Grimodex shader benchmark",
  platform: "Win32",
};

const EMPTY_PASSES: ZenGpuPassTimesMs = {
  scene: 0,
  downsample: 0,
  gaussianHorizontal: 0,
  gaussianVertical: 0,
  kawaseDown: 0,
  kawaseUp: 0,
  composite: 0,
};

function report({
  timingMode,
  gpuTimeMs,
  sceneGpuTimeMs = 0,
  compositeGpuTimeMs = 0,
  drawCallCount,
}: {
  timingMode: Extract<ZenGpuTimingMode, "frame" | "pass-breakdown">;
  gpuTimeMs: number;
  sceneGpuTimeMs?: number;
  compositeGpuTimeMs?: number;
  drawCallCount: number;
}): ZenMultipassPerformanceReport {
  const options: ZenBlurResearchOptions = {
    ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
    dualKawase: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.dualKawase },
    displayNoise: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.displayNoise },
    rgba8Dither: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.rgba8Dither },
    gpuTiming: {
      measurementMode: timingMode,
      sampleIntervalDraws: 1,
      maxPendingSamples: 4,
      maxRecordedSamples: 1,
    },
  };
  const gpuPassTimesMs = {
    ...EMPTY_PASSES,
    scene: sceneGpuTimeMs,
    composite: compositeGpuTimeMs,
  };
  const gpuSample = {
    drawCount: 1,
    gpuTimeMs,
    blurGpuTimeMs: 0,
    gpuPassTimesMs,
  };
  const cpuSample = {
    drawCount: 1,
    drawCallCount,
    cpuSubmitTimeMs: 0.1,
  };

  return {
    schemaVersion: 1,
    capturedAtEpochMs: 1,
    backend: "gaussian-current",
    gpuTimingMode: timingMode,
    researchOptions: options,
    gpuMetadata: GPU_METADATA,
    performanceStats: {
      drawCount: 1,
      drawCallCount,
      clearCallCount: 1,
      sceneDrawCallCount: 1,
      compositeDrawCallCount: 1,
      renderPipeline: "multipass",
      renderWidth: 1_920,
      renderHeight: 1_080,
      backend: "gaussian-current",
      gpuTimeMs,
      gpuPassTimesMs,
      gpuTimingStatus: "ready",
      gpuTimingSampleCount: 1,
      gpuTimingSampleDrawCount: 1,
      isStaticFrameReady: true,
      blurFormat: "rgba8",
      blurTargetAFormat: "rgba8",
      blurTargetBFormat: "rgba8",
      sceneTargetWidth: 1_920,
      sceneTargetHeight: 1_080,
      blurTargetWidth: 0,
      blurTargetHeight: 0,
      gaussianPairCount: 0,
      kawaseDownsamplePassCount: 0,
      kawaseUpsamplePassCount: 0,
      blurTargetLevels: [],
      intermediateTextureBytes: 0,
      sceneTargetBytes: 1_920 * 1_080 * 4,
      totalIntermediateTextureBytes: 1_920 * 1_080 * 4,
      imageTextureCount: 0,
      blurTargetReallocationCount: 0,
      cpuSubmitTimeMs: 0.1,
      cpuSubmitSampleCount: 1,
      cpuSubmitSummary: { p50: 0.1, p95: 0.1, p99: 0.1 },
      displayNoise: { ...options.displayNoise },
      rgba8Dither: { ...options.rgba8Dither },
    },
    gpuBenchmark: {
      samples: [gpuSample],
      summary: null,
    },
    cpuSubmit: {
      samples: [cpuSample],
      summary: null,
    },
  };
}

describe("Zen shader research artifact", () => {
  it("keeps pass attribution separate and ranks shaders by the exact frame query", () => {
    const artifact = buildZenShaderResearchArtifact({
      scenario: {
        id: "zen-shader-ranking-1080p",
        cssWidth: 1_920,
        cssHeight: 1_080,
        measuredFrames: 1,
        requestedRuns: 1,
      },
      condition: {
        pipeline: "full",
        dither: false,
        ditherStrength: 0.45,
        halftone: false,
        halftoneStrength: 0.3,
        contrast: false,
        contrastStrength: 0.1,
        glass: false,
        blurRadiusPx: 22,
        glassRefraction: 24,
        glassSaturation: 1,
        glassShine: 1,
        compositeFixtureId: "desktop-reference-v1",
        uiSurfaceCapacity: 16,
        activeUiSurfaceCount: 0,
        fixedFrame: 1_000,
      },
      measurements: [
        {
          shader: {
            id: "mesh-gradient",
            name: "Mesh Gradient",
            animated: true,
            imageSource: false,
          },
          executionOrdinal: 0,
          effectiveProps: { speed: 0, frame: 1_000 },
          passBreakdownRuns: [
            report({
              timingMode: "pass-breakdown",
              gpuTimeMs: 10,
              sceneGpuTimeMs: 9,
              compositeGpuTimeMs: 1,
              drawCallCount: 2,
            }),
          ],
          frameRuns: [
            report({ timingMode: "frame", gpuTimeMs: 1, drawCallCount: 2 }),
          ],
        },
        {
          shader: {
            id: "spiral",
            name: "Spiral",
            animated: true,
            imageSource: false,
          },
          executionOrdinal: 1,
          effectiveProps: { speed: 0, frame: 1_000 },
          passBreakdownRuns: [
            report({
              timingMode: "pass-breakdown",
              gpuTimeMs: 1,
              sceneGpuTimeMs: 0.6,
              compositeGpuTimeMs: 0.4,
              drawCallCount: 2,
            }),
          ],
          frameRuns: [
            report({ timingMode: "frame", gpuTimeMs: 3, drawCallCount: 2 }),
          ],
        },
      ],
    });

    expect(artifact.schemaVersion).toBe(1);
    expect(artifact.gpuMetadata).toEqual(GPU_METADATA);
    expect(artifact.rankingMetric).toBe("frame-gpu-p95");
    expect(artifact.ranking.map(({ shader }) => shader)).toEqual([
      "spiral",
      "mesh-gradient",
    ]);
    expect(artifact.ranking[0]).toMatchObject({
      rank: 1,
      shader: "spiral",
      frameGpuTimeMs: { p50: 3, p95: 3, p99: 3 },
      sceneGpuTimeMs: { p50: 0.6, p95: 0.6, p99: 0.6 },
      compositeGpuTimeMs: { p50: 0.4, p95: 0.4, p99: 0.4 },
      drawCallCountMedian: 2,
      renderWidth: 1_920,
      renderHeight: 1_080,
    });
    expect(artifact.results[0]?.passBreakdown?.runs).toHaveLength(1);
    expect(artifact.results[0]?.frame?.runs).toHaveLength(1);
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact);
  });

  it("rejects duplicate shaders and incomplete requested timing pairs", () => {
    const measurement = {
      shader: {
        id: "spiral" as const,
        name: "Spiral",
        animated: true,
        imageSource: false,
      },
      executionOrdinal: 0,
      effectiveProps: { speed: 0 },
      passBreakdownRuns: [
        report({
          timingMode: "pass-breakdown",
          gpuTimeMs: 1,
          sceneGpuTimeMs: 0.7,
          compositeGpuTimeMs: 0.3,
          drawCallCount: 2,
        }),
      ],
      frameRuns: [
        report({ timingMode: "frame", gpuTimeMs: 1, drawCallCount: 2 }),
      ],
    };
    const base = {
      scenario: { id: "integrity", measuredFrames: 1 },
      condition: {
        pipeline: "full" as const,
        dither: false,
        ditherStrength: 0.45,
        halftone: false,
        halftoneStrength: 0.3,
        contrast: false,
        contrastStrength: 0.1,
        glass: false,
        blurRadiusPx: 22,
        glassRefraction: 24,
        glassSaturation: 1,
        glassShine: 1,
        compositeFixtureId: "desktop-reference-v1",
        uiSurfaceCapacity: 16,
        activeUiSurfaceCount: 0,
        fixedFrame: 1_000,
      },
    };

    expect(() =>
      buildZenShaderResearchArtifact({
        ...base,
        measurements: [measurement, { ...measurement, executionOrdinal: 1 }],
      }),
    ).toThrow(/duplicate|shader/i);

    expect(() =>
      buildZenShaderResearchArtifact({
        ...base,
        measurements: [{ ...measurement, frameRuns: undefined }],
        requiredTimingModes: ["pass-breakdown", "frame"],
      }),
    ).toThrow(/frame|timing|missing/i);

    expect(() =>
      buildZenShaderResearchArtifact({
        ...base,
        condition: {
          ...base.condition,
          activeUiSurfaceCount: 17,
        },
        measurements: [measurement],
      }),
    ).toThrow(/surface|capacity/i);
  });
});
