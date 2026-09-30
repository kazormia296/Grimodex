import { createRef, type RefObject } from "react";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { PaperShaderElement, ShaderMount } from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ZenMultipassPerformanceReport,
  type ZenMultipassPerformanceStats,
} from "./ZenBlurResearchCanvas";
import { ZenShaderResearchSurface } from "./ZenShaderResearchSurface";
import {
  ZEN_SHADER_RESEARCH_COMPOSITE_FIXTURE_ID,
  ZEN_SHADER_RESEARCH_COMPOSITE_RUNTIME,
  ZEN_SHADER_RESEARCH_REFERENCE_UI_SURFACES,
  ZEN_SHADER_RESEARCH_UI_SURFACE_CAPACITY,
} from "./zenShaderResearchCompositeFixture";
import {
  DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
  type ZenBlurResearchOptions,
} from "./zenBlurResearchConfig";
import {
  getPaperShaderDefinition,
  type PaperShaderId,
} from "./paperShaderCatalog";
import {
  assertZenShaderResearchRenderSize,
  buildZenShaderResearchConfig,
  resolveZenShaderResearchShaderIds,
  ZEN_SHADER_RESEARCH_PALETTE,
} from "./zenShaderResearchConfig";
import {
  buildZenShaderResearchArtifact,
  type ZenShaderResearchMeasurement,
  type ZenShaderResearchTimingMode,
} from "./zenShaderResearchReport";
import type { ZenShaderResearchPipeline } from "./zenShaderResearchPipeline";
import { buildZenShaderProps } from "./zenShaderConfig";

declare const __ZEN_SHADER_RESEARCH_SCENARIO__: {
  shader: string;
  pipeline: ZenShaderResearchPipeline;
  dither: boolean;
  ditherStrength: number;
  halftone: boolean;
  halftoneStrength: number;
  contrast: boolean;
  glass: boolean;
  blur: number;
  width: number;
  height: number;
  warmup: number;
  frames: number;
  runs: number;
  primeRuns: number;
  frame: number;
  orderSeed: number;
  timing: "both" | ZenShaderResearchTimingMode;
  headed: boolean;
  sourceRevision: string | null;
  sourceDirty: boolean | null;
  paperPackages: {
    shaders: { version: string; patchSha256: string };
    shadersReact: { version: string; patchSha256: string };
  };
};
declare const __ZEN_SHADER_RESEARCH_REPORT_ENDPOINT__: string;
declare const __ZEN_SHADER_RESEARCH_WRITE_TOKEN__: string;

const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render driver|\bwarp\b|software rasterizer/i;

type ResearchMount = ShaderMount & {
  getPerformanceStats(): ZenMultipassPerformanceStats;
  getPerformanceReport(): ZenMultipassPerformanceReport;
};

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as ResearchMount | undefined;
  if (!mount) throw new Error("Zen shader research mount is unavailable");
  return mount;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = 30_000,
) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error(message);
    await nextAnimationFrame();
  }
}

async function drawFixedFrame(
  mount: ResearchMount,
  frame: number,
  sampleIndex: number,
) {
  const before = mount.getPerformanceStats().drawCount;
  mount.setFrame(frame);
  await waitUntil(
    () => mount.getPerformanceStats().drawCount > before,
    `Zen shader research sample ${sampleIndex} did not render`,
  );
}

function assertHardwareTimer(report: ZenMultipassPerformanceReport) {
  const renderer = report.gpuMetadata.unmaskedRenderer;
  if (!renderer) {
    throw new Error("Unmasked hardware GPU renderer metadata is required");
  }
  const gpuIdentity = [
    report.gpuMetadata.vendor,
    report.gpuMetadata.renderer,
    report.gpuMetadata.unmaskedVendor,
    renderer,
  ]
    .filter(Boolean)
    .join(" ");
  if (SOFTWARE_RENDERER_PATTERN.test(gpuIdentity)) {
    throw new Error(
      `Software WebGL renderer is not a valid benchmark: ${renderer}`,
    );
  }
  if (
    /^win/i.test(report.gpuMetadata.platform ?? "") &&
    !/d3d11|direct3d11/i.test(renderer)
  ) {
    throw new Error(
      `Windows Zen shader research requires ANGLE D3D11: ${renderer}`,
    );
  }
  if (report.performanceStats.gpuTimingStatus === "unsupported") {
    throw new Error("EXT_disjoint_timer_query_webgl2 is required");
  }
}

async function completedGpuReport(
  mount: ResearchMount,
  expectedSamples: number,
) {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= 30_000) {
    const report = mount.getPerformanceReport();
    const status = report.performanceStats.gpuTimingStatus;
    if (status === "ready") {
      if (report.gpuBenchmark.samples.length !== expectedSamples) {
        throw new Error(
          `GPU timer captured ${report.gpuBenchmark.samples.length}/${expectedSamples} frames`,
        );
      }
      return report;
    }
    if (
      status === "unsupported" ||
      status === "error" ||
      status === "context-lost" ||
      status === "disjoint"
    ) {
      throw new Error(`GPU timer ended in ${status} state`);
    }
    await nextAnimationFrame();
  }
  throw new Error("Timed out while draining GPU timer queries");
}

function benchmarkOptions(
  timingMode: ZenShaderResearchTimingMode,
): ZenBlurResearchOptions {
  return {
    ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
    dualKawase: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.dualKawase },
    displayNoise: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.displayNoise },
    rgba8Dither: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.rgba8Dither },
    gpuTiming: {
      measurementMode: timingMode,
      sampleIntervalDraws: 1,
      maxPendingSamples: 64,
      maxRecordedSamples: __ZEN_SHADER_RESEARCH_SCENARIO__.frames,
    },
  };
}

function expectedDrawCalls(pipeline: ZenShaderResearchPipeline) {
  if (pipeline === "raw") return { minimum: 1, maximum: 1 };
  if (pipeline === "scene") return { minimum: 2, maximum: 2 };
  return { minimum: 2, maximum: Infinity };
}

function assertDrawTopology(
  report: ZenMultipassPerformanceReport,
  pipeline: ZenShaderResearchPipeline,
) {
  const expectedRenderPipeline = pipeline === "raw" ? "direct" : "multipass";
  expect(report.performanceStats.renderPipeline).toBe(expectedRenderPipeline);
  const { minimum, maximum } = expectedDrawCalls(pipeline);
  for (const sample of report.cpuSubmit.samples) {
    expect(sample.drawCallCount).toBeGreaterThanOrEqual(minimum);
    expect(sample.drawCallCount).toBeLessThanOrEqual(maximum);
  }
  if (pipeline === "raw") {
    expect(report.performanceStats.sceneTargetBytes).toBe(0);
  } else {
    expect(report.performanceStats.sceneTargetBytes).toBe(
      __ZEN_SHADER_RESEARCH_SCENARIO__.width *
        __ZEN_SHADER_RESEARCH_SCENARIO__.height *
        4,
    );
  }
}

async function captureTimedRun(
  mount: ResearchMount,
  shader: PaperShaderId,
  timingMode: ZenShaderResearchTimingMode,
) {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  for (let sample = 0; sample < scenario.warmup; sample += 1) {
    await drawFixedFrame(mount, scenario.frame, sample);
  }
  mount.resetPerformanceStats();
  for (let sample = 0; sample < scenario.frames; sample += 1) {
    await drawFixedFrame(mount, scenario.frame, sample);
  }
  const report = await completedGpuReport(mount, scenario.frames);
  expect(report.cpuSubmit.samples).toHaveLength(scenario.frames);
  expect(report.gpuTimingMode).toBe(timingMode);
  assertHardwareTimer(report);
  assertDrawTopology(report, scenario.pipeline);
  if (
    getPaperShaderDefinition(shader).imageSource &&
    report.performanceStats.imageTextureCount < 1
  ) {
    throw new Error(`${shader} did not upload its required image texture`);
  }
  try {
    assertZenShaderResearchRenderSize(report.performanceStats, scenario);
  } catch (error) {
    throw new Error(
      `${shader}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return report;
}

async function captureShaderTiming(
  shader: PaperShaderId,
  timingMode: ZenShaderResearchTimingMode,
) {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  const ref = createRef<PaperShaderElement>();
  const view = render(
    <ZenShaderResearchSurface
      ref={ref}
      shader={shader}
      pipeline={scenario.pipeline}
      dither={scenario.dither}
      ditherStrength={scenario.ditherStrength}
      halftone={scenario.halftone}
      halftoneStrength={scenario.halftoneStrength}
      contrast={scenario.contrast}
      glass={scenario.glass}
      blur={scenario.blur}
      frame={scenario.frame}
      width={scenario.width}
      height={scenario.height}
      researchOptions={benchmarkOptions(timingMode)}
    />,
  );

  try {
    await waitFor(
      () => {
        expect(
          ref.current?.paperShaderMount?.getPerformanceStats()
            .isStaticFrameReady,
        ).toBe(true);
      },
      {
        timeout: 30_000,
        onTimeout: () =>
          new Error(`${shader} ${timingMode} canvas did not become ready`),
      },
    );
    const mount = currentMount(ref);
    assertHardwareTimer(mount.getPerformanceReport());

    for (let prime = 0; prime < scenario.primeRuns; prime += 1) {
      await captureTimedRun(mount, shader, timingMode);
    }

    const runs: ZenMultipassPerformanceReport[] = [];
    for (let run = 0; run < scenario.runs; run += 1) {
      runs.push(await captureTimedRun(mount, shader, timingMode));
    }
    return runs;
  } finally {
    view.unmount();
  }
}

function requestedTimingModes(): ZenShaderResearchTimingMode[] {
  const requested = __ZEN_SHADER_RESEARCH_SCENARIO__.timing;
  return requested === "both" ? ["pass-breakdown", "frame"] : [requested];
}

function jsonSafeProps(value: Record<string, unknown>) {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

afterEach(cleanup);

describe("Zen shader real-GPU research runner", () => {
  it("writes 29-shader pass attribution and exact frame rankings", async () => {
    const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
    const shaderIds = resolveZenShaderResearchShaderIds(
      scenario.shader,
      scenario.orderSeed,
    );
    const timingModes = requestedTimingModes();
    const measurements: ZenShaderResearchMeasurement[] = [];

    for (const [executionOrdinal, shader] of shaderIds.entries()) {
      const timingRuns = new Map<
        ZenShaderResearchTimingMode,
        ZenMultipassPerformanceReport[]
      >();
      for (const timingMode of timingModes) {
        timingRuns.set(
          timingMode,
          await captureShaderTiming(shader, timingMode),
        );
      }

      const definition = getPaperShaderDefinition(shader);
      const config = buildZenShaderResearchConfig(shader, scenario);
      const effectiveProps = jsonSafeProps({
        ...buildZenShaderProps(config, ZEN_SHADER_RESEARCH_PALETTE),
        frame: scenario.frame,
        speed: 0,
      });
      measurements.push({
        shader: {
          id: shader,
          name: definition.name,
          animated: definition.animated,
          imageSource: definition.imageSource ?? false,
        },
        executionOrdinal,
        effectiveProps,
        passBreakdownRuns: timingRuns.get("pass-breakdown"),
        frameRuns: timingRuns.get("frame"),
      });
    }

    const referenceConfig = buildZenShaderResearchConfig(
      shaderIds[0]!,
      scenario,
    );
    const artifact = buildZenShaderResearchArtifact({
      scenario: {
        id: `zen-shaders-${scenario.pipeline}-${scenario.width}x${scenario.height}`,
        cssWidth: scenario.width,
        cssHeight: scenario.height,
        devicePixelRatio: 1,
        warmupFrames: scenario.warmup,
        measuredFrames: scenario.frames,
        requestedRuns: scenario.runs,
        primeRuns: scenario.primeRuns,
        forcedFixedFrame: true,
        fixedFrame: scenario.frame,
        shaderRequest: scenario.shader,
        shaderOrder: shaderIds,
        orderSeed: scenario.orderSeed,
        timingModes,
        headed: scenario.headed,
        sourceRevision: scenario.sourceRevision,
        sourceDirty: scenario.sourceDirty,
        paperPackages: scenario.paperPackages,
        palette: ZEN_SHADER_RESEARCH_PALETTE,
        compositeFixture: {
          id: ZEN_SHADER_RESEARCH_COMPOSITE_FIXTURE_ID,
          uiSurfaceCapacity: ZEN_SHADER_RESEARCH_UI_SURFACE_CAPACITY,
          ...ZEN_SHADER_RESEARCH_COMPOSITE_RUNTIME,
          uiSurfaces: scenario.glass
            ? ZEN_SHADER_RESEARCH_REFERENCE_UI_SURFACES
            : [],
        },
      },
      condition: {
        pipeline: scenario.pipeline,
        dither: scenario.dither,
        ditherStrength: scenario.ditherStrength,
        halftone: scenario.halftone,
        halftoneStrength: scenario.halftoneStrength,
        contrast: scenario.contrast,
        contrastStrength: referenceConfig.contrastGuard.strength,
        glass: scenario.glass,
        blurRadiusPx: scenario.blur,
        glassRefraction: referenceConfig.glass.refraction,
        glassSaturation: referenceConfig.glass.saturation,
        glassShine: referenceConfig.glass.shine,
        compositeFixtureId:
          scenario.pipeline === "full"
            ? ZEN_SHADER_RESEARCH_COMPOSITE_FIXTURE_ID
            : "none",
        uiSurfaceCapacity:
          scenario.pipeline === "full"
            ? ZEN_SHADER_RESEARCH_UI_SURFACE_CAPACITY
            : 0,
        activeUiSurfaceCount:
          scenario.pipeline === "full" && scenario.glass
            ? ZEN_SHADER_RESEARCH_REFERENCE_UI_SURFACES.length
            : 0,
        fixedFrame: scenario.frame,
      },
      measurements,
      requiredTimingModes: timingModes,
    });

    const response = await fetch(__ZEN_SHADER_RESEARCH_REPORT_ENDPOINT__, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zen-shader-research-token": __ZEN_SHADER_RESEARCH_WRITE_TOKEN__,
      },
      body: JSON.stringify(artifact),
    });
    if (!response.ok) {
      throw new Error(
        `Could not write Zen shader research artifact: ${await response.text()}`,
      );
    }
  });
});
