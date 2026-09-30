import { createRef, type RefObject } from "react";
import { cleanup, render } from "@testing-library/react";
import type { PaperShaderElement } from "@paper-design/shaders";
import { afterEach, describe, expect, it } from "vitest";
import {
  type ZenMultipassPerformanceReport,
  type ZenMultipassPerformanceStats,
  type ZenResearchRenderPipeline,
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
  assertZenShaderResearchRenderSize,
  resolveZenShaderResearchShaderIds,
  ZEN_SHADER_RESEARCH_PALETTE,
} from "./zenShaderResearchConfig";
import {
  buildZenShaderResearchAbbaSchedule,
  buildZenShaderResearchAbbaSummary,
  type ZenShaderResearchAbbaBlock,
  type ZenShaderResearchAbbaRun,
  type ZenShaderResearchAbbaSequence,
  type ZenShaderResearchAbbaVariant,
} from "./zenShaderResearchAbba";

declare const __ZEN_SHADER_RESEARCH_SCENARIO__: {
  experiment: "pipeline" | "cadence" | "baselines" | "abba";
  shader: string;
  pipeline: "raw" | "scene" | "full";
  workload:
    | "all"
    | "paper"
    | "clear-only"
    | "solid-fullscreen"
    | "texture-copy";
  resolutions: Array<{ width: number; height: number }>;
  cadence:
    | "all"
    | "native-raf"
    | "timer-60"
    | "raf-skip-60"
    | "stopped-retained";
  durationMs: number;
  cycles: number;
  sequenceStart: "abba" | "baab";
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
  timing: "both" | "pass-breakdown" | "frame";
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
const GPU_QUERY_TIMEOUT_MS = 30_000;
const MAX_ABBA_MEASURED_FRAMES = 64;

interface AbbaResearchMount {
  setFrame(frame: number): void;
  getPerformanceStats(): ZenMultipassPerformanceStats;
  getPerformanceReport(): ZenMultipassPerformanceReport;
  resetPerformanceStats(): void;
  setResearchRenderPipeline(pipeline: ZenResearchRenderPipeline): void;
}

interface AbbaResourceIdentity {
  contextId: string;
  resourceEpoch: number;
  residentIntermediateTextureBytes: number;
  gpuMetadata: ZenMultipassPerformanceReport["gpuMetadata"];
}

type CapturedAbbaBlock = ZenShaderResearchAbbaBlock & {
  report: ZenMultipassPerformanceReport;
};

type CapturedAbbaRun = Omit<ZenShaderResearchAbbaRun, "blocks"> & {
  blocks: CapturedAbbaBlock[];
};

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as AbbaResearchMount | undefined;
  if (!mount) throw new Error("Zen shader ABBA research mount is unavailable");
  return mount;
}

function nextAnimationFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = GPU_QUERY_TIMEOUT_MS,
) {
  const startedAt = performance.now();
  while (!predicate()) {
    if (performance.now() - startedAt > timeoutMs) throw new Error(message);
    await nextAnimationFrame();
  }
}

async function drawFixedFrame(
  mount: AbbaResearchMount,
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

function assertGpuTimerDidNotFail(report: ZenMultipassPerformanceReport) {
  const status = report.performanceStats.gpuTimingStatus;
  if (
    status === "unsupported" ||
    status === "error" ||
    status === "context-lost" ||
    status === "disjoint"
  ) {
    throw new Error(`GPU timer ended in ${status} state`);
  }
}

async function fullyDrainGpuQueries(mount: AbbaResearchMount, label: string) {
  const startedAt = performance.now();
  while (performance.now() - startedAt <= GPU_QUERY_TIMEOUT_MS) {
    const report = mount.getPerformanceReport();
    assertHardwareTimer(report);
    assertGpuTimerDidNotFail(report);
    const status = report.performanceStats.gpuTimingStatus;
    if (status === "idle" || status === "ready") return report;
    await nextAnimationFrame();
  }
  throw new Error(`${label} timed out while fully draining GPU timer queries`);
}

async function completedGpuReport(
  mount: AbbaResearchMount,
  expectedSamples: number,
  label: string,
) {
  const report = await fullyDrainGpuQueries(mount, label);
  if (report.performanceStats.gpuTimingStatus !== "ready") {
    throw new Error(`${label} completed without a ready GPU timer sample`);
  }
  if (report.gpuBenchmark.samples.length !== expectedSamples) {
    throw new Error(
      `${label} captured ${report.gpuBenchmark.samples.length}/${expectedSamples} GPU frames`,
    );
  }
  if (!report.gpuBenchmark.summary) {
    throw new Error(`${label} did not produce a GPU timing summary`);
  }
  return report;
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
      maxPendingSamples: MAX_ABBA_MEASURED_FRAMES,
      maxRecordedSamples: Math.max(
        1,
        Math.min(
          MAX_ABBA_MEASURED_FRAMES,
          Math.max(scenario.warmup, scenario.frames),
        ),
      ),
    },
  };
}

function resourceIdentity(
  stats: ZenMultipassPerformanceStats,
  gpuMetadata: ZenMultipassPerformanceReport["gpuMetadata"],
): AbbaResourceIdentity {
  const contextId = stats.contextId;
  const resourceEpoch = stats.resourceEpoch;
  const residentIntermediateTextureBytes =
    stats.residentIntermediateTextureBytes;
  if (typeof contextId !== "string" || contextId.trim() === "") {
    throw new Error("Zen shader ABBA contextId is required");
  }
  if (
    typeof resourceEpoch !== "number" ||
    !Number.isSafeInteger(resourceEpoch) ||
    resourceEpoch < 1
  ) {
    throw new Error("Zen shader ABBA resourceEpoch must be a positive integer");
  }
  if (
    typeof residentIntermediateTextureBytes !== "number" ||
    residentIntermediateTextureBytes < 1
  ) {
    throw new Error(
      "Zen shader ABBA initial full pipeline must retain an intermediate texture",
    );
  }
  return {
    contextId,
    resourceEpoch,
    residentIntermediateTextureBytes,
    gpuMetadata: { ...gpuMetadata },
  };
}

function assertResourceIdentity(
  stats: ZenMultipassPerformanceStats,
  expected: AbbaResourceIdentity,
  label: string,
) {
  if (stats.contextId !== expected.contextId) {
    throw new Error(`${label} replaced its WebGL context`);
  }
  if (stats.resourceEpoch !== expected.resourceEpoch) {
    throw new Error(`${label} reallocated its intermediate resources`);
  }
  if (
    stats.residentIntermediateTextureBytes !==
    expected.residentIntermediateTextureBytes
  ) {
    throw new Error(`${label} changed its resident intermediate texture bytes`);
  }
}

function renderPipelineForVariant(
  variant: ZenShaderResearchAbbaVariant,
): ZenResearchRenderPipeline {
  return variant === "raw" ? "direct" : "multipass";
}

function assertDrawTopology(
  report: ZenMultipassPerformanceReport,
  variant: ZenShaderResearchAbbaVariant,
  expectedFrames: number,
) {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  const expectedPipeline = renderPipelineForVariant(variant);
  const expectedDrawCalls = variant === "raw" ? 1 : 2;
  const expectedSceneBytes = scenario.width * scenario.height * 4;
  const stats = report.performanceStats;

  expect(stats.renderPipeline).toBe(expectedPipeline);
  expect(stats.drawCount).toBe(expectedFrames);
  expect(stats.drawCallCount).toBe(expectedFrames * expectedDrawCalls);
  expect(stats.sceneTargetBytes).toBe(
    variant === "raw" ? 0 : expectedSceneBytes,
  );
  expect(report.cpuSubmit.samples).toHaveLength(expectedFrames);
  for (const [sampleIndex, sample] of report.cpuSubmit.samples.entries()) {
    expect(sample.drawCount).toBe(sampleIndex + 1);
    expect(sample.drawCallCount).toBe(expectedDrawCalls);
  }
  for (const [sampleIndex, sample] of report.gpuBenchmark.samples.entries()) {
    expect(sample.drawCount).toBe(sampleIndex + 1);
  }
}

function assertScenario() {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  if (scenario.experiment !== "abba") {
    throw new Error("Zen shader ABBA runner requires experiment=abba");
  }
  if (scenario.timing !== "frame") {
    throw new Error("Zen shader ABBA runner requires timing=frame");
  }
  if (scenario.contrast || scenario.glass) {
    throw new Error("Zen shader ABBA runner requires Contrast and Glass off");
  }
  if (
    !Number.isSafeInteger(scenario.frames) ||
    scenario.frames < 1 ||
    scenario.frames > MAX_ABBA_MEASURED_FRAMES
  ) {
    throw new Error(
      `Zen shader ABBA frames must be between 1 and ${MAX_ABBA_MEASURED_FRAMES}`,
    );
  }
  if (!Number.isSafeInteger(scenario.warmup) || scenario.warmup < 0) {
    throw new Error("Zen shader ABBA warmup must be a non-negative integer");
  }
  if (
    !Number.isSafeInteger(scenario.width) ||
    scenario.width < 1 ||
    !Number.isSafeInteger(scenario.height) ||
    scenario.height < 1
  ) {
    throw new Error("Zen shader ABBA render size must use positive integers");
  }
}

async function selectPipeline(
  mount: AbbaResearchMount,
  pipeline: ZenResearchRenderPipeline,
  identity: AbbaResourceIdentity,
  label: string,
) {
  await fullyDrainGpuQueries(mount, `${label} pre-switch`);
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
  } else {
    await waitUntil(
      () => mount.getPerformanceStats().isStaticFrameReady,
      `${label} pipeline was not ready`,
    );
  }
  await fullyDrainGpuQueries(mount, `${label} switch draw`);
  assertResourceIdentity(mount.getPerformanceStats(), identity, label);
}

async function captureBlock(
  mount: AbbaResearchMount,
  shader: PaperShaderId,
  runIndex: number,
  blockIndex: number,
  variant: ZenShaderResearchAbbaVariant,
  identity: AbbaResourceIdentity,
): Promise<CapturedAbbaBlock> {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  const label = `${shader} run ${runIndex} block ${blockIndex} (${variant})`;
  await selectPipeline(
    mount,
    renderPipelineForVariant(variant),
    identity,
    label,
  );

  mount.resetPerformanceStats();
  for (let sample = 0; sample < scenario.warmup; sample += 1) {
    await drawFixedFrame(mount, scenario.frame, `${label} warmup ${sample}`);
  }
  await fullyDrainGpuQueries(mount, `${label} warmup`);
  mount.resetPerformanceStats();

  for (let sample = 0; sample < scenario.frames; sample += 1) {
    await drawFixedFrame(mount, scenario.frame, `${label} sample ${sample}`);
  }
  const report = await completedGpuReport(
    mount,
    scenario.frames,
    `${label} measurement`,
  );
  expect(report.gpuTimingMode).toBe("frame");
  assertHardwareTimer(report);
  assertResourceIdentity(report.performanceStats, identity, label);
  expect(report.gpuMetadata).toEqual(identity.gpuMetadata);
  assertDrawTopology(report, variant, scenario.frames);
  try {
    assertZenShaderResearchRenderSize(report.performanceStats, scenario);
  } catch (error) {
    throw new Error(
      `${label}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (
    getPaperShaderDefinition(shader).imageSource &&
    report.performanceStats.imageTextureCount < 1
  ) {
    throw new Error(`${label} did not retain its required image texture`);
  }

  const gpuTimeMs = report.gpuBenchmark.summary?.gpuTimeMs;
  if (!gpuTimeMs) throw new Error(`${label} has no frame GPU summary`);
  return {
    blockIndex,
    variant,
    frameGpuTimeMs: { p50: gpuTimeMs.p50, p95: gpuTimeMs.p95 },
    report,
  };
}

function compactRuns(runs: readonly CapturedAbbaRun[]) {
  return runs.map(
    ({ runIndex, sequence, contextId, resourceEpoch, blocks }) => ({
      runIndex,
      sequence,
      contextId,
      resourceEpoch,
      blocks: blocks.map(({ blockIndex, variant, frameGpuTimeMs }) => ({
        blockIndex,
        variant,
        frameGpuTimeMs: { ...frameGpuTimeMs },
      })),
    }),
  );
}

async function captureShader(
  shader: PaperShaderId,
  firstSequence: ZenShaderResearchAbbaSequence,
) {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  const ref = createRef<PaperShaderElement>();
  const view = render(
    <ZenShaderResearchSurface
      ref={ref}
      shader={shader}
      pipeline="full"
      dither={scenario.dither}
      ditherStrength={scenario.ditherStrength}
      halftone={scenario.halftone}
      halftoneStrength={scenario.halftoneStrength}
      contrast={false}
      glass={false}
      blur={scenario.blur}
      frame={scenario.frame}
      width={scenario.width}
      height={scenario.height}
      researchOptions={benchmarkOptions()}
    />,
  );

  try {
    await waitUntil(() => {
      const mount = ref.current?.paperShaderMount as
        | AbbaResearchMount
        | undefined;
      return mount?.getPerformanceStats().isStaticFrameReady === true;
    }, `${shader} initial full pipeline did not become ready`);
    const mount = currentMount(ref);
    const initialReport = await fullyDrainGpuQueries(
      mount,
      `${shader} initial full pipeline`,
    );
    const initialStats = mount.getPerformanceStats();
    expect(initialStats.renderPipeline).toBe("multipass");
    expect(initialStats.sceneTargetBytes).toBe(
      scenario.width * scenario.height * 4,
    );
    assertZenShaderResearchRenderSize(initialStats, scenario);
    const identity = resourceIdentity(initialStats, initialReport.gpuMetadata);

    const schedule = buildZenShaderResearchAbbaSchedule(
      scenario.cycles,
      firstSequence,
    );
    const runs: CapturedAbbaRun[] = [];
    for (const scheduledRun of schedule) {
      const blocks: CapturedAbbaBlock[] = [];
      for (const [blockIndex, variant] of scheduledRun.variants.entries()) {
        blocks.push(
          await captureBlock(
            mount,
            shader,
            scheduledRun.runIndex,
            blockIndex,
            variant,
            identity,
          ),
        );
      }
      runs.push({
        runIndex: scheduledRun.runIndex,
        sequence: scheduledRun.sequence,
        contextId: identity.contextId,
        resourceEpoch: identity.resourceEpoch,
        blocks,
      });
    }

    const compact = compactRuns(runs);
    return {
      identity,
      runs,
      summary: buildZenShaderResearchAbbaSummary({ runs: compact }),
    };
  } finally {
    view.unmount();
  }
}

function resolveFirstSequence(): ZenShaderResearchAbbaSequence {
  return __ZEN_SHADER_RESEARCH_SCENARIO__.sequenceStart === "abba"
    ? "ABBA"
    : "BAAB";
}

afterEach(cleanup);

describe("Zen shader same-context ABBA research runner", () => {
  it("writes paired raw/full GPU frame timing from alternating blocks", async () => {
    assertScenario();
    const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
    const shaderIds = resolveZenShaderResearchShaderIds(
      scenario.shader,
      scenario.orderSeed,
    );
    const firstSequence = resolveFirstSequence();
    const artifactRuns: Array<
      CapturedAbbaRun & {
        shader: PaperShaderId;
        executionOrdinal: number;
      }
    > = [];
    const summaries = [];
    let canonicalGpuMetadata:
      | ZenMultipassPerformanceReport["gpuMetadata"]
      | null = null;

    for (const [executionOrdinal, shader] of shaderIds.entries()) {
      const captured = await captureShader(shader, firstSequence);
      const definition = getPaperShaderDefinition(shader);
      if (canonicalGpuMetadata) {
        expect(captured.identity.gpuMetadata).toEqual(canonicalGpuMetadata);
      } else {
        canonicalGpuMetadata = { ...captured.identity.gpuMetadata };
      }
      artifactRuns.push(
        ...captured.runs.map((run) => ({
          ...run,
          shader,
          executionOrdinal,
        })),
      );
      summaries.push({
        shader: {
          id: shader,
          name: definition.name,
          animated: definition.animated,
          imageSource: definition.imageSource ?? false,
        },
        executionOrdinal,
        contextId: captured.identity.contextId,
        resourceEpoch: captured.identity.resourceEpoch,
        residentIntermediateTextureBytes:
          captured.identity.residentIntermediateTextureBytes,
        summary: captured.summary,
      });
    }
    if (!canonicalGpuMetadata) {
      throw new Error("Zen shader ABBA research captured no GPU metadata");
    }

    const artifact = {
      schemaVersion: 1,
      capturedAtEpochMs: Date.now(),
      experiment: "abba" as const,
      scenario: {
        shader: scenario.shader,
        shaderOrder: shaderIds,
        cycles: scenario.cycles,
        sequenceStart: scenario.sequenceStart,
        runs: scenario.runs,
        primeRuns: scenario.primeRuns,
        width: scenario.width,
        height: scenario.height,
        warmup: scenario.warmup,
        frames: scenario.frames,
        frame: scenario.frame,
        orderSeed: scenario.orderSeed,
        timing: scenario.timing,
        headed: scenario.headed,
        dither: scenario.dither,
        ditherStrength: scenario.ditherStrength,
        halftone: scenario.halftone,
        halftoneStrength: scenario.halftoneStrength,
        contrast: scenario.contrast,
        glass: scenario.glass,
        blur: scenario.blur,
        palette: ZEN_SHADER_RESEARCH_PALETTE,
      },
      provenance: {
        sourceRevision: scenario.sourceRevision,
        sourceDirty: scenario.sourceDirty,
        paperPackages: scenario.paperPackages,
        gpuMetadata: canonicalGpuMetadata,
        runner: "ZenShaderAbbaResearchRunner.browser.test.tsx",
      },
      runs: artifactRuns,
      summaries,
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
        `Could not write Zen shader ABBA artifact: ${await response.text()}`,
      );
    }
  });
});
