import { createRef, type RefObject } from "react";
import { cleanup, render } from "@testing-library/react";
import type { PaperShaderElement } from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import type {
  ZenMultipassPerformanceReport,
  ZenMultipassPerformanceStats,
  ZenResearchRenderPipeline,
} from "./ZenBlurResearchCanvas";
import { ZenShaderResearchSurface } from "./ZenShaderResearchSurface";
import {
  DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
  type ZenBlurResearchOptions,
} from "./zenBlurResearchConfig";
import {
  getPaperShaderDefinition,
  type PaperShaderId,
} from "./paperShaderCatalog";
import {
  resolveZenShaderResearchShaderIds,
  ZEN_SHADER_RESEARCH_PALETTE,
} from "./zenShaderResearchConfig";
import {
  buildZenShaderResearchAbbaSummary,
  type ZenShaderResearchAbbaRun,
} from "./zenShaderResearchAbba";
import {
  buildZenShaderUpscaleResearchMatrix,
  buildZenShaderUpscaleResearchSchedule,
  resolveZenShaderUpscaleDimensions,
  ZEN_SHADER_UPSCALE_RESEARCH_SHADER_IDS,
  type ZenShaderUpscaleResearchCandidate,
  type ZenShaderUpscaleResearchSequence,
  type ZenShaderUpscaleResearchVariant,
} from "./zenShaderUpscaleResearch";

declare const __ZEN_SHADER_RESEARCH_SCENARIO__: {
  experiment: "pipeline" | "cadence" | "baselines" | "abba" | "upscale";
  shader: string;
  cycles: number;
  sequenceStart: "abba" | "baab";
  width: number;
  height: number;
  warmup: number;
  frames: number;
  frame: number;
  orderSeed: number;
  timing: "both" | "pass-breakdown" | "frame";
  headed: boolean;
  dither: boolean;
  ditherStrength: number;
  halftone: boolean;
  halftoneStrength: number;
  contrast: boolean;
  glass: boolean;
  blur: number;
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
const GPU_QUERY_TIMEOUT_MS = 30_000;
const MAX_MEASURED_FRAMES = 64;

interface UpscaleResearchMount {
  setFrame(frame: number): void;
  getPerformanceStats(): ZenMultipassPerformanceStats;
  getPerformanceReport(): ZenMultipassPerformanceReport;
  resetPerformanceStats(): void;
  setResearchRenderPipeline(pipeline: ZenResearchRenderPipeline): void;
}

interface ResourceIdentity {
  contextId: string;
  resourceEpoch: number;
  residentIntermediateTextureBytes: number;
  gpuMetadata: ZenMultipassPerformanceReport["gpuMetadata"];
}

interface CapturedBlock {
  blockIndex: number;
  variant: ZenShaderUpscaleResearchVariant;
  frameGpuTimeMs: { p50: number; p95: number };
  cpuSubmitTimeMs: { p50: number; p95: number } | null;
  drawCallsPerFrame: number;
}

interface CapturedRun {
  runIndex: number;
  sequence: ZenShaderUpscaleResearchSequence;
  contextId: string;
  resourceEpoch: number;
  blocks: CapturedBlock[];
}

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as
    | UpscaleResearchMount
    | undefined;
  if (!mount)
    throw new Error("Zen shader upscale research mount is unavailable");
  return mount;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitUntil(predicate: () => boolean, message: string) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > GPU_QUERY_TIMEOUT_MS) {
      throw new Error(message);
    }
    await nextAnimationFrame();
  }
}

function benchmarkOptions(): ZenBlurResearchOptions {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  return {
    ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
    dualKawase: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.dualKawase },
    displayNoise: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.displayNoise },
    rgba8Dither: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.rgba8Dither },
    gpuTiming: {
      measurementMode: "frame",
      sampleIntervalDraws: 1,
      maxPendingSamples: MAX_MEASURED_FRAMES,
      maxRecordedSamples: Math.max(
        1,
        Math.min(
          MAX_MEASURED_FRAMES,
          Math.max(scenario.warmup, scenario.frames),
        ),
      ),
    },
  };
}

function assertHardwareTimer(report: ZenMultipassPerformanceReport) {
  const renderer = report.gpuMetadata.unmaskedRenderer;
  if (!renderer) throw new Error("Unmasked hardware GPU renderer is required");
  const identity = [
    report.gpuMetadata.vendor,
    report.gpuMetadata.renderer,
    report.gpuMetadata.unmaskedVendor,
    renderer,
  ]
    .filter(Boolean)
    .join(" ");
  if (SOFTWARE_RENDERER_PATTERN.test(identity)) {
    throw new Error(
      `Software WebGL renderer is not a valid benchmark: ${renderer}`,
    );
  }
  if (
    /^win/i.test(report.gpuMetadata.platform ?? "") &&
    !/d3d11|direct3d11/i.test(renderer)
  ) {
    throw new Error(
      `Windows upscale research requires ANGLE D3D11: ${renderer}`,
    );
  }
  if (report.performanceStats.gpuTimingStatus === "unsupported") {
    throw new Error("EXT_disjoint_timer_query_webgl2 is required");
  }
}

async function drainGpuQueries(mount: UpscaleResearchMount, label: string) {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= GPU_QUERY_TIMEOUT_MS) {
    const report = mount.getPerformanceReport();
    assertHardwareTimer(report);
    const status = report.performanceStats.gpuTimingStatus;
    if (["error", "context-lost", "disjoint", "unsupported"].includes(status)) {
      throw new Error(`${label} GPU timer ended in ${status}`);
    }
    if (status === "idle" || status === "ready") return report;
    await nextAnimationFrame();
  }
  throw new Error(`${label} timed out while draining GPU timer queries`);
}

async function drawFixedFrame(
  mount: UpscaleResearchMount,
  frame: number,
  label: string,
) {
  const before = mount.getPerformanceStats().drawCount;
  mount.setFrame(frame);
  await waitUntil(
    () => mount.getPerformanceStats().drawCount > before,
    `${label} did not render`,
  );
}

function resourceIdentity(
  report: ZenMultipassPerformanceReport,
): ResourceIdentity {
  const stats = report.performanceStats;
  if (!stats.contextId || !Number.isSafeInteger(stats.resourceEpoch)) {
    throw new Error("Upscale research requires stable resource identity");
  }
  if ((stats.residentIntermediateTextureBytes ?? 0) <= 0) {
    throw new Error("Upscale candidate resources were not allocated");
  }
  return {
    contextId: stats.contextId,
    resourceEpoch: stats.resourceEpoch ?? 0,
    residentIntermediateTextureBytes:
      stats.residentIntermediateTextureBytes ?? 0,
    gpuMetadata: { ...report.gpuMetadata },
  };
}

function assertResourceIdentity(
  stats: ZenMultipassPerformanceStats,
  identity: ResourceIdentity,
  label: string,
) {
  if (stats.contextId !== identity.contextId) {
    throw new Error(`${label} replaced its WebGL context`);
  }
  if (stats.resourceEpoch !== identity.resourceEpoch) {
    throw new Error(`${label} reallocated its resources`);
  }
  if (
    stats.residentIntermediateTextureBytes !==
    identity.residentIntermediateTextureBytes
  ) {
    throw new Error(`${label} changed its resident resource bytes`);
  }
}

async function selectVariant(
  mount: UpscaleResearchMount,
  variant: ZenShaderUpscaleResearchVariant,
  identity: ResourceIdentity,
  label: string,
) {
  await drainGpuQueries(mount, `${label} pre-switch`);
  const pipeline = variant === "native" ? "direct" : "multipass";
  const before = mount.getPerformanceStats();
  mount.setResearchRenderPipeline(pipeline);
  if (before.renderPipeline !== pipeline) {
    await waitUntil(() => {
      const stats = mount.getPerformanceStats();
      return (
        stats.renderPipeline === pipeline &&
        stats.drawCount > before.drawCount &&
        stats.isStaticFrameReady
      );
    }, `${label} pipeline switch did not render`);
  }
  await drainGpuQueries(mount, `${label} switch`);
  assertResourceIdentity(mount.getPerformanceStats(), identity, label);
}

function assertTopology(
  stats: ZenMultipassPerformanceStats,
  candidate: ZenShaderUpscaleResearchCandidate,
  variant: ZenShaderUpscaleResearchVariant,
  frames: number,
) {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  const scene = resolveZenShaderUpscaleDimensions(
    scenario.width,
    scenario.height,
    candidate.sceneScale,
  );
  const candidateDraws = candidate.upscaler === "easu-rcas" ? 3 : 2;
  expect(stats.renderPipeline).toBe(
    variant === "native" ? "direct" : "multipass",
  );
  expect(stats.drawCount).toBe(frames);
  expect(stats.drawCallCount).toBe(
    frames * (variant === "native" ? 1 : candidateDraws),
  );
  expect(stats.sceneTargetWidth).toBe(scene.width);
  expect(stats.sceneTargetHeight).toBe(scene.height);
  expect(stats.sceneTargetBytes).toBe(
    variant === "candidate" ? scene.width * scene.height * 4 : 0,
  );
  expect(stats.upscaleTargetBytes).toBe(
    variant === "candidate" && candidate.upscaler === "easu-rcas"
      ? scenario.width * scenario.height * 4
      : 0,
  );
}

async function captureBlock(
  mount: UpscaleResearchMount,
  candidate: ZenShaderUpscaleResearchCandidate,
  variant: ZenShaderUpscaleResearchVariant,
  identity: ResourceIdentity,
  runIndex: number,
  blockIndex: number,
) {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  const label = `${candidate.id} run ${runIndex} block ${blockIndex} (${variant})`;
  await selectVariant(mount, variant, identity, label);
  mount.resetPerformanceStats();
  for (let sample = 0; sample < scenario.warmup; sample += 1) {
    await drawFixedFrame(mount, scenario.frame, `${label} warmup ${sample}`);
  }
  await drainGpuQueries(mount, `${label} warmup`);
  mount.resetPerformanceStats();
  for (let sample = 0; sample < scenario.frames; sample += 1) {
    await drawFixedFrame(mount, scenario.frame, `${label} sample ${sample}`);
  }
  const report = await drainGpuQueries(mount, `${label} measurement`);
  if (
    report.performanceStats.gpuTimingStatus !== "ready" ||
    report.gpuBenchmark.samples.length !== scenario.frames ||
    !report.gpuBenchmark.summary
  ) {
    throw new Error(`${label} did not capture ${scenario.frames} GPU frames`);
  }
  assertResourceIdentity(report.performanceStats, identity, label);
  assertTopology(report.performanceStats, candidate, variant, scenario.frames);
  return {
    blockIndex,
    variant,
    frameGpuTimeMs: {
      p50: report.gpuBenchmark.summary.gpuTimeMs.p50,
      p95: report.gpuBenchmark.summary.gpuTimeMs.p95,
    },
    cpuSubmitTimeMs: report.performanceStats.cpuSubmitSummary
      ? {
          p50: report.performanceStats.cpuSubmitSummary.p50,
          p95: report.performanceStats.cpuSubmitSummary.p95,
        }
      : null,
    drawCallsPerFrame: report.performanceStats.drawCallCount / scenario.frames,
  } satisfies CapturedBlock;
}

function summarizeRuns(runs: readonly CapturedRun[]) {
  const compatibleRuns: ZenShaderResearchAbbaRun[] = runs.map((run) => ({
    runIndex: run.runIndex,
    sequence: run.sequence,
    contextId: run.contextId,
    resourceEpoch: run.resourceEpoch,
    blocks: run.blocks.map((block) => ({
      blockIndex: block.blockIndex,
      variant: block.variant === "native" ? "raw" : "full",
      frameGpuTimeMs: { ...block.frameGpuTimeMs },
    })),
  }));
  const summary = buildZenShaderResearchAbbaSummary({ runs: compatibleRuns });
  return {
    comparison: "candidate-minus-native" as const,
    runs: summary.runs.map(({ runIndex, sequence, paired }) => ({
      runIndex,
      sequence,
      paired: {
        nativeFrameGpuTimeMs: paired.rawFrameGpuTimeMs,
        candidateFrameGpuTimeMs: paired.fullFrameGpuTimeMs,
        candidateMinusNativeFrameGpuTimeMs: paired.fullMinusRawFrameGpuTimeMs,
      },
    })),
    aggregate: {
      candidateMinusNativeFrameGpuTimeMs: summary.aggregate.frameGpuTimeDeltaMs,
    },
  };
}

async function captureCandidate(
  shader: PaperShaderId,
  candidate: ZenShaderUpscaleResearchCandidate,
  firstSequence: ZenShaderUpscaleResearchSequence,
) {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  const ref = createRef<PaperShaderElement>();
  const view = render(
    <ZenShaderResearchSurface
      ref={ref}
      shader={shader}
      pipeline="scene"
      dither={false}
      ditherStrength={scenario.ditherStrength}
      halftone={false}
      halftoneStrength={scenario.halftoneStrength}
      contrast={false}
      glass={false}
      blur={scenario.blur}
      frame={scenario.frame}
      width={scenario.width}
      height={scenario.height}
      sceneScale={candidate.sceneScale}
      upscaler={candidate.upscaler}
      researchOptions={benchmarkOptions()}
    />,
  );
  try {
    await waitUntil(
      () => currentMount(ref).getPerformanceStats().isStaticFrameReady,
      `${shader}/${candidate.id} did not become ready`,
    );
    const mount = currentMount(ref);
    const initialReport = await drainGpuQueries(
      mount,
      `${shader}/${candidate.id} initial candidate`,
    );
    const identity = resourceIdentity(initialReport);
    const runs: CapturedRun[] = [];
    for (const scheduled of buildZenShaderUpscaleResearchSchedule(
      scenario.cycles,
      firstSequence,
    )) {
      const blocks: CapturedBlock[] = [];
      for (const [blockIndex, variant] of scheduled.variants.entries()) {
        blocks.push(
          await captureBlock(
            mount,
            candidate,
            variant,
            identity,
            scheduled.runIndex,
            blockIndex,
          ),
        );
      }
      runs.push({
        runIndex: scheduled.runIndex,
        sequence: scheduled.sequence,
        contextId: identity.contextId,
        resourceEpoch: identity.resourceEpoch,
        blocks,
      });
    }
    return { identity, runs, summary: summarizeRuns(runs) };
  } finally {
    view.unmount();
  }
}

function assertScenario() {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  if (scenario.experiment !== "upscale") {
    throw new Error("Zen shader upscale runner requires experiment=upscale");
  }
  if (scenario.timing !== "frame") {
    throw new Error("Zen shader upscale runner requires frame timing");
  }
  if (
    scenario.dither ||
    scenario.halftone ||
    scenario.contrast ||
    scenario.glass
  ) {
    throw new Error(
      "Zen shader upscale runner requires all output effects off",
    );
  }
  if (
    scenario.frames < 2 ||
    scenario.frames > MAX_MEASURED_FRAMES ||
    !Number.isSafeInteger(scenario.frames)
  ) {
    throw new Error(
      `Upscale frames must be between 2 and ${MAX_MEASURED_FRAMES}`,
    );
  }
}

afterEach(cleanup);

describe("Zen shader spatial upscale research runner", () => {
  it("writes paired native/candidate timing for the fixed 4x4 matrix", async () => {
    assertScenario();
    const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
    const shaderIds =
      scenario.shader === "representative"
        ? [...ZEN_SHADER_UPSCALE_RESEARCH_SHADER_IDS]
        : resolveZenShaderResearchShaderIds(
            scenario.shader,
            scenario.orderSeed,
          );
    const matrix = buildZenShaderUpscaleResearchMatrix();
    const firstSequence: ZenShaderUpscaleResearchSequence =
      scenario.sequenceStart === "abba" ? "ABBA" : "BAAB";
    const results = [];
    let canonicalGpuMetadata:
      | ZenMultipassPerformanceReport["gpuMetadata"]
      | null = null;
    for (const [shaderOrdinal, shader] of shaderIds.entries()) {
      for (const [candidateOrdinal, candidate] of matrix.entries()) {
        const captured = await captureCandidate(
          shader,
          candidate,
          firstSequence,
        );
        if (canonicalGpuMetadata) {
          expect(captured.identity.gpuMetadata).toEqual(canonicalGpuMetadata);
        } else {
          canonicalGpuMetadata = { ...captured.identity.gpuMetadata };
        }
        results.push({
          shader: {
            id: shader,
            name: getPaperShaderDefinition(shader).name,
          },
          shaderOrdinal,
          candidate: { ...candidate },
          candidateOrdinal,
          contextId: captured.identity.contextId,
          resourceEpoch: captured.identity.resourceEpoch,
          residentIntermediateTextureBytes:
            captured.identity.residentIntermediateTextureBytes,
          runs: captured.runs,
          summary: captured.summary,
        });
      }
    }
    if (!canonicalGpuMetadata) {
      throw new Error("Zen shader upscale research captured no GPU metadata");
    }
    const artifact = {
      schemaVersion: 1,
      capturedAtEpochMs: Date.now(),
      experiment: "upscale" as const,
      scenario: {
        shader: scenario.shader,
        shaderOrder: shaderIds,
        matrix,
        cycles: scenario.cycles,
        sequenceStart: scenario.sequenceStart,
        width: scenario.width,
        height: scenario.height,
        warmup: scenario.warmup,
        frames: scenario.frames,
        frame: scenario.frame,
        orderSeed: scenario.orderSeed,
        timing: scenario.timing,
        headed: scenario.headed,
        palette: ZEN_SHADER_RESEARCH_PALETTE,
      },
      provenance: {
        sourceRevision: scenario.sourceRevision,
        sourceDirty: scenario.sourceDirty,
        paperPackages: scenario.paperPackages,
        gpuMetadata: canonicalGpuMetadata,
        runner: "ZenShaderUpscaleResearchRunner.browser.test.tsx",
        fsr1Reference:
          "https://github.com/GPUOpen-Effects/FidelityFX-FSR/blob/master/ffx-fsr/ffx_fsr1.h",
      },
      results,
    };
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
        `Could not write upscale artifact: ${await response.text()}`,
      );
    }
  });
});
