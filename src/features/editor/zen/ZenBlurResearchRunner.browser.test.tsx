import { createRef, type RefObject } from "react";
import { cleanup, render } from "@testing-library/react";
import type {
  PaperShaderElement,
  ShaderMount,
  ShaderMountUniforms,
} from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import {
  ZenBlurResearchCanvas,
  type ZenMultipassPerformanceReport,
} from "./ZenBlurResearchCanvas";
import {
  buildZenMultipassCompositeFragment,
  buildZenMultipassCompositeUniforms,
} from "./zenBlurResearchPipeline";
import {
  resolveZenBlurResearchOptions,
  type ZenBlurResearchOptions,
} from "./zenBlurResearchConfig";
import { buildZenBlurResearchArtifact } from "./zenBlurResearchReport";
import { ZEN_SHADER_DEFAULTS } from "./zenShaderConfig";
import type { ZenPostProcessRuntime } from "./zenPostProcessing";
import { ZenUiSurfaceUniformBuffer } from "./zenShaderUniformBuffer";

declare const __ZEN_BLUR_RESEARCH_SCENARIO__: {
  blur: number;
  width: number;
  height: number;
  warmup: number;
  frames: number;
  runs: number;
  primeRuns: number;
  timing: "pass-breakdown" | "frame" | "blur";
  headed: boolean;
  sourceRevision: string | null;
  sourceDirty: boolean | null;
};
declare const __ZEN_BLUR_RESEARCH_REPORT_ENDPOINT__: string;
declare const __ZEN_BLUR_RESEARCH_WRITE_TOKEN__: string;

const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render driver|\bwarp\b|software rasterizer/i;

const SCENE_FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 u_resolution;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / max(u_resolution, vec2(1.0));
  vec2 cell = floor(uv * vec2(64.0, 36.0));
  float checker = mod(cell.x + cell.y, 2.0);
  vec3 lowFrequency = mix(
    vec3(0.035, 0.075, 0.14),
    vec3(0.9, 0.58, 0.24),
    uv.x
  );
  vec3 detail = mix(vec3(0.08), vec3(0.92), checker);
  fragColor = vec4(mix(lowFrequency, detail, 0.32), 1.0);
}`;

const SIZING_UNIFORMS: ShaderMountUniforms = {
  u_fit: 2,
  u_scale: 1,
  u_rotation: 0,
  u_offsetX: 0,
  u_offsetY: 0,
  u_originX: 0.5,
  u_originY: 0.5,
  u_worldWidth: 0,
  u_worldHeight: 0,
  u_imageAspectRatio: 1,
};

const FULL_GLASS_RUNTIME: ZenPostProcessRuntime = {
  rect: [0, 0, 1, 1],
  feather: [0, 0, 0, 0],
  glassRect: [0, 0, 1, 1],
  glassCornerRadius: 0,
  uiSurfaces: [],
  textColor: [1, 1, 1],
  uiTextColor: [1, 1, 1],
  backdropColor: [0, 0, 0],
};

const WEBGL_CONTEXT_ATTRIBUTES = {
  alpha: true,
  antialias: false,
  powerPreference: "default",
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
} satisfies WebGLContextAttributes;

type ResearchMount = ShaderMount & {
  getPerformanceReport(): ZenMultipassPerformanceReport;
};

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as ResearchMount | undefined;
  if (!mount) throw new Error("Zen blur research mount is unavailable");
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

async function drawFrame(mount: ResearchMount, frame: number) {
  const before = mount.getPerformanceStats().drawCount;
  mount.setFrame(frame);
  await waitUntil(
    () => mount.getPerformanceStats().drawCount > before,
    `Zen blur research frame ${frame} did not render`,
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
      `Windows Zen blur research requires ANGLE D3D11: ${renderer}`,
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

function benchmarkOptions(): ZenBlurResearchOptions {
  const resolved = resolveZenBlurResearchOptions(import.meta.env);
  return {
    ...resolved,
    gpuTiming: {
      measurementMode: __ZEN_BLUR_RESEARCH_SCENARIO__.timing,
      sampleIntervalDraws: 1,
      maxPendingSamples: 64,
      maxRecordedSamples: __ZEN_BLUR_RESEARCH_SCENARIO__.frames,
    },
  };
}

async function captureTimedRun(
  mount: ResearchMount,
  scenario: typeof __ZEN_BLUR_RESEARCH_SCENARIO__,
) {
  for (let frame = 0; frame < scenario.warmup; frame += 1) {
    await drawFrame(mount, frame);
  }
  mount.resetPerformanceStats();
  for (let frame = 0; frame < scenario.frames; frame += 1) {
    await drawFrame(mount, frame);
  }
  const report = await completedGpuReport(mount, scenario.frames);
  expect(report.cpuSubmit.samples).toHaveLength(scenario.frames);
  assertHardwareTimer(report);
  return report;
}

afterEach(cleanup);

describe("Zen blur real-GPU research runner", () => {
  it("writes pooled raw GPU and CPU measurements as a JSON artifact", async () => {
    const scenario = __ZEN_BLUR_RESEARCH_SCENARIO__;
    const options = benchmarkOptions();
    const precision =
      import.meta.env.VITE_ZEN_BLUR_PRECISION === "rgba8" ? "rgba8" : "auto";
    const compositeUniforms = buildZenMultipassCompositeUniforms(
      {
        ...ZEN_SHADER_DEFAULTS,
        opacity: 100,
        glass: {
          ...ZEN_SHADER_DEFAULTS.glass,
          enabled: true,
          blur: scenario.blur,
          saturation: 1,
          refraction: 0,
          shine: 0,
        },
        contrastGuard: {
          mode: "none",
          strength: 0,
          toolMix: 0,
        },
      },
      FULL_GLASS_RUNTIME,
      new ZenUiSurfaceUniformBuffer(1),
    );
    const ref = createRef<PaperShaderElement>();
    render(
      <ZenBlurResearchCanvas
        ref={ref}
        data-paper-shader="zen-blur-real-gpu-research"
        sceneFragment={SCENE_FRAGMENT}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={buildZenMultipassCompositeFragment(1)}
        compositeUniforms={compositeUniforms}
        minPixelRatio={1}
        maxPixelCount={scenario.width * scenario.height}
        blurTargetPrecision={precision}
        researchOptions={options}
        speed={0}
        style={{
          position: "relative",
          width: scenario.width,
          height: scenario.height,
        }}
        webGlContextAttributes={WEBGL_CONTEXT_ATTRIBUTES}
      />,
    );

    await waitUntil(
      () => currentMount(ref).getPerformanceStats().isStaticFrameReady,
      "Zen blur research canvas did not become ready",
    );
    assertHardwareTimer(currentMount(ref).getPerformanceReport());

    const mount = currentMount(ref);
    for (let primeIndex = 0; primeIndex < scenario.primeRuns; primeIndex += 1) {
      await captureTimedRun(mount, scenario);
    }

    const runs: ZenMultipassPerformanceReport[] = [];
    for (let runIndex = 0; runIndex < scenario.runs; runIndex += 1) {
      runs.push(await captureTimedRun(mount, scenario));
    }

    const resolvedTextureFormats = new Set(
      runs.map(({ performanceStats }) => performanceStats.blurFormat),
    );
    expect(resolvedTextureFormats.size).toBe(1);
    const artifact = buildZenBlurResearchArtifact({
      scenario: {
        id: `zen-glass-${scenario.width}x${scenario.height}-blur-${scenario.blur}`,
        cssWidth: scenario.width,
        cssHeight: scenario.height,
        blurRadiusPx: scenario.blur,
        glassCoverage: 1,
        warmupFrames: scenario.warmup,
        measuredFrames: scenario.frames,
        requestedRuns: scenario.runs,
        primeRuns: scenario.primeRuns,
        sourceRevision: scenario.sourceRevision,
        sourceDirty: scenario.sourceDirty,
        seed: options.displayNoise.seed,
        headed: scenario.headed,
      },
      candidate: {
        backend: options.backend,
        passes: options.dualKawase.passes,
        offset: options.dualKawase.offset,
        requestedPrecision: precision,
        textureFormat: runs[0]?.performanceStats.blurFormat,
        gpuTimingMode: options.gpuTiming.measurementMode,
        displayNoise: options.displayNoise,
        rgba8Dither: options.rgba8Dither,
      },
      runs,
    });
    const response = await fetch(__ZEN_BLUR_RESEARCH_REPORT_ENDPOINT__, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zen-blur-research-token": __ZEN_BLUR_RESEARCH_WRITE_TOKEN__,
      },
      body: JSON.stringify(artifact),
    });
    if (!response.ok) {
      throw new Error(
        `Could not write Zen blur research artifact: ${await response.text()}`,
      );
    }
  });
});
