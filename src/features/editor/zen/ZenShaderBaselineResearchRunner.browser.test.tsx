import {
  createRef,
  forwardRef,
  type RefObject,
  type ReactElement,
} from "react";
import { cleanup, render } from "@testing-library/react";
import type {
  PaperShaderElement,
  ShaderMount,
  ShaderMountUniforms,
} from "@paper-design/shaders";
import { afterEach, describe, it } from "vitest";
import {
  ZenBlurResearchCanvas,
  type ZenMultipassPerformanceReport,
  type ZenMultipassPerformanceStats,
} from "./ZenBlurResearchCanvas";
import { ZenShaderResearchSurface } from "./ZenShaderResearchSurface";
import {
  DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
  type ZenBlurResearchOptions,
} from "./zenBlurResearchConfig";
import {
  ZEN_SHADER_RESEARCH_SOLID_FRAGMENT,
  buildZenShaderResearchResolutionSchedule,
  parseZenShaderResearchResolution,
  resolveZenShaderResearchWorkloadPlan,
  type ZenShaderResearchResolution,
  type ZenShaderResearchWorkload,
  type ZenShaderResearchWorkloadPlan,
} from "./zenShaderResearchBaseline";
import {
  assertZenShaderResearchRenderSize,
  resolveZenShaderResearchShaderIds,
  ZEN_SHADER_RESEARCH_PALETTE,
} from "./zenShaderResearchConfig";
import { ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT } from "./zenShaderResearchPipeline";
import {
  getPaperShaderDefinition,
  type PaperShaderId,
} from "./paperShaderCatalog";
import type { ZenWebGlMetadata } from "./zenWebGlDiagnostics";

type RequestedWorkload = ZenShaderResearchWorkload | "all";

declare const __ZEN_SHADER_RESEARCH_SCENARIO__: {
  experiment: "pipeline" | "cadence" | "baselines" | "abba";
  shader: string;
  workload: RequestedWorkload;
  resolutions: readonly { width: number; height: number }[];
  dither: boolean;
  ditherStrength: number;
  halftone: boolean;
  halftoneStrength: number;
  contrast: boolean;
  glass: boolean;
  blur: number;
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

const MAX_ARTIFACT_BYTES = 60 * 1024 * 1024;
const SOFTWARE_RENDERER_PATTERN =
  /swiftshader|llvmpipe|softpipe|lavapipe|microsoft basic render driver|\bwarp\b|software rasterizer/i;
const BASELINE_WORKLOADS = [
  "clear-only",
  "solid-fullscreen",
  "texture-copy",
] as const satisfies readonly ZenShaderResearchWorkload[];
const WEBGL_CONTEXT_ATTRIBUTES = {
  alpha: true,
  antialias: false,
  powerPreference: "default",
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
} satisfies WebGLContextAttributes;
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
const COPY_UNIFORMS: ShaderMountUniforms = {
  u_zenGlassEnabled: 0,
  u_zenGlassBlur: 0,
};

interface CellDefinition {
  id: string;
  workload: ZenShaderResearchWorkload;
  shader: PaperShaderId | null;
  plan: ZenShaderResearchWorkloadPlan;
}

interface CellSurfaceProps {
  cell: CellDefinition;
  resolution: ZenShaderResearchResolution;
  pixelBudget: number;
  options: ZenBlurResearchOptions;
}

interface TimingPercentiles {
  p50: number;
  p95: number;
  p99: number;
}

interface RecordedMeasurement {
  executionOrdinal: number;
  runIndex: number;
  withinRunOrdinal: number;
  resolution: ZenShaderResearchResolution;
  contextId: string;
  resourceEpoch: number;
  frameGpuTimeMs: {
    samples: number[];
    summary: TimingPercentiles;
  };
  actualTopology: {
    renderPipeline: ZenMultipassPerformanceStats["renderPipeline"];
    drawCallsPerFrame: number;
    clearCallsPerFrame: number;
    sceneDrawCallsPerFrame: number;
    compositeDrawCallsPerFrame: number;
    sceneTargetBytes: number;
    totalIntermediateTextureBytes: number;
    residentIntermediateTextureBytes: number;
    imageTextureCount: number;
  };
}

interface ExecutionOrderEntry {
  ordinal: number;
  cellId: string;
  phase: "prime" | "recorded";
  runIndex: number;
  withinRunOrdinal: number;
  resolutionId: string;
}

type ResearchMount = Omit<ShaderMount, "getPerformanceStats"> & {
  getPerformanceStats(): ZenMultipassPerformanceStats;
  getPerformanceReport(): ZenMultipassPerformanceReport;
  resetPerformanceStats(): void;
};

const BaselineCellSurface = forwardRef<PaperShaderElement, CellSurfaceProps>(
  function BaselineCellSurface(
    { cell, resolution, pixelBudget, options },
    forwardedRef,
  ) {
    if (cell.shader !== null) {
      return (
        <ZenShaderResearchSurface
          ref={forwardedRef}
          shader={cell.shader}
          pipeline={cell.plan.pipeline}
          dither={__ZEN_SHADER_RESEARCH_SCENARIO__.dither}
          ditherStrength={__ZEN_SHADER_RESEARCH_SCENARIO__.ditherStrength}
          halftone={__ZEN_SHADER_RESEARCH_SCENARIO__.halftone}
          halftoneStrength={__ZEN_SHADER_RESEARCH_SCENARIO__.halftoneStrength}
          contrast={false}
          glass={false}
          blur={__ZEN_SHADER_RESEARCH_SCENARIO__.blur}
          frame={__ZEN_SHADER_RESEARCH_SCENARIO__.frame}
          width={resolution.width}
          height={resolution.height}
          pixelBudget={pixelBudget}
          sceneOperation={cell.plan.sceneOperation}
          researchOptions={options}
        />
      );
    }

    return (
      <ZenBlurResearchCanvas
        ref={forwardedRef}
        data-paper-shader={`zen-shader-baseline:${cell.workload}`}
        sceneFragment={ZEN_SHADER_RESEARCH_SOLID_FRAGMENT}
        sceneUniforms={SIZING_UNIFORMS}
        compositeFragment={ZEN_SHADER_RESEARCH_COPY_COMPOSITE_FRAGMENT}
        compositeUniforms={COPY_UNIFORMS}
        minPixelRatio={1}
        maxPixelCount={pixelBudget}
        webGlContextAttributes={WEBGL_CONTEXT_ATTRIBUTES}
        researchOptions={options}
        renderPipeline={cell.plan.renderPipeline}
        sceneOperation={cell.plan.sceneOperation}
        speed={0}
        style={{
          position: "relative",
          width: resolution.width,
          height: resolution.height,
        }}
      />
    );
  },
);

function currentMount(ref: RefObject<PaperShaderElement | null>) {
  const mount = ref.current?.paperShaderMount as ResearchMount | undefined;
  if (!mount) throw new Error("Zen shader baseline mount is unavailable");
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

function benchmarkOptions(frames: number): ZenBlurResearchOptions {
  return {
    ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS,
    dualKawase: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.dualKawase },
    displayNoise: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.displayNoise },
    rgba8Dither: { ...DEFAULT_ZEN_BLUR_RESEARCH_OPTIONS.rgba8Dither },
    gpuTiming: {
      measurementMode: "frame",
      sampleIntervalDraws: 1,
      maxPendingSamples: Math.max(64, frames),
      maxRecordedSamples: frames,
    },
  };
}

function nearestRank(values: readonly number[], percentile: number) {
  if (values.length === 0) {
    throw new TypeError("Cannot summarize an empty GPU timing set");
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)]!;
}

function percentiles(values: readonly number[]): TimingPercentiles {
  return {
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
  };
}

function median(values: readonly number[]) {
  if (values.length === 0) throw new TypeError("Cannot median an empty set");
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function metadataMatches(left: ZenWebGlMetadata, right: ZenWebGlMetadata) {
  return (Object.keys(left) as (keyof ZenWebGlMetadata)[]).every((key) =>
    Object.is(left[key], right[key]),
  );
}

function requiredResourceIdentity(stats: ZenMultipassPerformanceStats) {
  if (
    typeof stats.contextId !== "string" ||
    stats.contextId === "" ||
    !Number.isSafeInteger(stats.resourceEpoch) ||
    (stats.resourceEpoch ?? -1) < 0 ||
    typeof stats.residentIntermediateTextureBytes !== "number" ||
    !Number.isFinite(stats.residentIntermediateTextureBytes) ||
    stats.residentIntermediateTextureBytes < 0
  ) {
    throw new Error("Baseline renderer resource identity is unavailable");
  }
  return {
    contextId: stats.contextId,
    resourceEpoch: stats.resourceEpoch as number,
    residentIntermediateTextureBytes: stats.residentIntermediateTextureBytes,
  };
}

function assertHardwareTimer(report: ZenMultipassPerformanceReport) {
  const renderer = report.gpuMetadata.unmaskedRenderer;
  if (!renderer) {
    throw new Error("Unmasked hardware GPU renderer metadata is required");
  }
  const identity = [
    report.gpuMetadata.vendor,
    report.gpuMetadata.renderer,
    report.gpuMetadata.unmaskedVendor,
    renderer,
  ]
    .filter(Boolean)
    .join(" ");
  if (SOFTWARE_RENDERER_PATTERN.test(identity)) {
    throw new Error(`Software WebGL renderer is invalid: ${renderer}`);
  }
  if (
    /^win/i.test(report.gpuMetadata.platform ?? "") &&
    !/d3d11|direct3d11/i.test(renderer)
  ) {
    throw new Error(`Windows baseline research requires D3D11: ${renderer}`);
  }
  if (report.performanceStats.gpuTimingStatus === "unsupported") {
    throw new Error("EXT_disjoint_timer_query_webgl2 is required");
  }
}

async function drawFixedFrame(
  mount: ResearchMount,
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
          `GPU timer captured ${report.gpuBenchmark.samples.length}/${expectedSamples} samples`,
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
  throw new Error("Timed out draining baseline GPU timer queries");
}

function assertTopology(
  report: ZenMultipassPerformanceReport,
  cell: CellDefinition,
  resolution: ZenShaderResearchResolution,
) {
  const stats = report.performanceStats;
  const topology = cell.plan.expectedTopology;
  const expectedSceneBytes =
    resolution.pixelCount * topology.sceneTargetBytesPerPixel;
  assertZenShaderResearchRenderSize(stats, resolution);
  if (stats.renderPipeline !== cell.plan.renderPipeline) {
    throw new Error(
      `${cell.id} rendered ${stats.renderPipeline}, expected ${cell.plan.renderPipeline}`,
    );
  }
  if (stats.sceneTargetBytes !== expectedSceneBytes) {
    throw new Error(
      `${cell.id} Scene bytes ${stats.sceneTargetBytes}, expected ${expectedSceneBytes}`,
    );
  }
  if (
    stats.intermediateTextureBytes !== 0 ||
    stats.totalIntermediateTextureBytes !== expectedSceneBytes
  ) {
    throw new Error(`${cell.id} allocated unexpected intermediate textures`);
  }
  if (
    stats.drawCount !== __ZEN_SHADER_RESEARCH_SCENARIO__.frames ||
    stats.drawCallCount !==
      topology.totalDrawCallsPerFrame * __ZEN_SHADER_RESEARCH_SCENARIO__.frames
  ) {
    throw new Error(`${cell.id} recorded an unexpected aggregate topology`);
  }
  if (
    stats.clearCallCount !==
      topology.clearCallsPerFrame * __ZEN_SHADER_RESEARCH_SCENARIO__.frames ||
    stats.sceneDrawCallCount !==
      topology.sceneDrawCallsPerFrame *
        __ZEN_SHADER_RESEARCH_SCENARIO__.frames ||
    stats.compositeDrawCallCount !==
      topology.compositeDrawCallsPerFrame *
        __ZEN_SHADER_RESEARCH_SCENARIO__.frames
  ) {
    throw new Error(`${cell.id} recorded an unexpected pass topology`);
  }
  for (const sample of report.cpuSubmit.samples) {
    if (sample.drawCallCount !== topology.totalDrawCallsPerFrame) {
      throw new Error(
        `${cell.id} drew ${sample.drawCallCount} calls, expected ${topology.totalDrawCallsPerFrame}`,
      );
    }
  }
  if (topology.sceneTargetBytesPerPixel === 0) {
    if (stats.sceneTargetWidth !== 0 || stats.sceneTargetHeight !== 0) {
      throw new Error(`${cell.id} unexpectedly allocated a Scene target`);
    }
  } else if (
    stats.sceneTargetWidth !== resolution.width ||
    stats.sceneTargetHeight !== resolution.height
  ) {
    throw new Error(`${cell.id} Scene target dimensions do not match output`);
  }
  if (
    cell.shader !== null &&
    getPaperShaderDefinition(cell.shader).imageSource &&
    stats.imageTextureCount < 1
  ) {
    throw new Error(`${cell.shader} did not upload its required image texture`);
  }
}

async function captureTimedRun(
  mount: ResearchMount,
  cell: CellDefinition,
  resolution: ZenShaderResearchResolution,
) {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  for (let sample = 0; sample < scenario.warmup; sample += 1) {
    await drawFixedFrame(
      mount,
      scenario.frame,
      `${cell.id} ${resolution.id} warmup ${sample}`,
    );
  }
  mount.resetPerformanceStats();
  for (let sample = 0; sample < scenario.frames; sample += 1) {
    await drawFixedFrame(
      mount,
      scenario.frame,
      `${cell.id} ${resolution.id} sample ${sample}`,
    );
  }
  const report = await completedGpuReport(mount, scenario.frames);
  if (report.gpuTimingMode !== "frame") {
    throw new Error(`${cell.id} did not use exact frame GPU timing`);
  }
  if (report.cpuSubmit.samples.length !== scenario.frames) {
    throw new Error(`${cell.id} CPU sample count is incomplete`);
  }
  assertHardwareTimer(report);
  assertTopology(report, cell, resolution);
  return report;
}

function seededShuffle<T>(values: readonly T[], seed: number) {
  const result = [...values];
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [result[index], result[swapIndex]] = [result[swapIndex]!, result[index]!];
  }
  return result;
}

function buildCells() {
  const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
  const cells: CellDefinition[] = [];
  if (scenario.workload === "all" || scenario.workload !== "paper") {
    for (const workload of BASELINE_WORKLOADS) {
      if (scenario.workload !== "all" && scenario.workload !== workload) {
        continue;
      }
      cells.push({
        id: `baseline:${workload}`,
        workload,
        shader: null,
        plan: resolveZenShaderResearchWorkloadPlan(workload),
      });
    }
  }
  if (scenario.workload === "all" || scenario.workload === "paper") {
    const shaders = resolveZenShaderResearchShaderIds(
      scenario.shader,
      scenario.orderSeed,
    );
    for (const shader of shaders) {
      for (const pipeline of ["raw", "scene"] as const) {
        cells.push({
          id: `paper:${shader}:${pipeline}`,
          workload: "paper",
          shader,
          plan: resolveZenShaderResearchWorkloadPlan("paper", pipeline),
        });
      }
    }
  }
  if (cells.length === 0) throw new Error("No baseline cells were selected");
  return seededShuffle(cells, scenario.orderSeed ^ 0x9e37_79b9);
}

function normalizedResolutions() {
  const requested = __ZEN_SHADER_RESEARCH_SCENARIO__.resolutions;
  if (!Array.isArray(requested) || requested.length === 0) {
    throw new Error("Baseline research requires at least one resolution");
  }
  const resolutions = requested.map(({ width, height }) =>
    parseZenShaderResearchResolution(`${width}x${height}`),
  );
  if (new Set(resolutions.map(({ id }) => id)).size !== resolutions.length) {
    throw new Error("Baseline research resolutions must be unique");
  }
  return resolutions;
}

function renderCell(
  ref: RefObject<PaperShaderElement | null>,
  cell: CellDefinition,
  resolution: ZenShaderResearchResolution,
  pixelBudget: number,
  options: ZenBlurResearchOptions,
): ReactElement {
  return (
    <BaselineCellSurface
      ref={ref}
      cell={cell}
      resolution={resolution}
      pixelBudget={pixelBudget}
      options={options}
    />
  );
}

function summarizeByResolution(
  resolutions: readonly ZenShaderResearchResolution[],
  measurements: readonly RecordedMeasurement[],
) {
  return resolutions.map((resolution) => {
    const matching = measurements.filter(
      ({ resolution: measured }) => measured.id === resolution.id,
    );
    if (matching.length !== __ZEN_SHADER_RESEARCH_SCENARIO__.runs) {
      throw new Error(`${resolution.id} has incomplete recorded runs`);
    }
    const samples = matching.flatMap(
      ({ frameGpuTimeMs }) => frameGpuTimeMs.samples,
    );
    const perRunP95 = matching.map(
      ({ frameGpuTimeMs }) => frameGpuTimeMs.summary.p95,
    );
    return {
      resolution,
      runCount: matching.length,
      sampleCount: samples.length,
      frameGpuTimeMs: percentiles(samples),
      perRunP95Ms: {
        median: median(perRunP95),
        min: Math.min(...perRunP95),
        max: Math.max(...perRunP95),
      },
    };
  });
}

afterEach(cleanup);

const describeBaselines =
  __ZEN_SHADER_RESEARCH_SCENARIO__.experiment === "baselines"
    ? describe
    : describe.skip;

describeBaselines("Zen shader baseline real-GPU research runner", () => {
  it("writes compact baseline and Paper resolution cells once", async () => {
    const scenario = __ZEN_SHADER_RESEARCH_SCENARIO__;
    if (scenario.contrast || scenario.glass) {
      throw new Error("Baseline research requires Contrast and Glass off");
    }
    if (
      !Number.isSafeInteger(scenario.runs) ||
      scenario.runs < 1 ||
      !Number.isSafeInteger(scenario.primeRuns) ||
      scenario.primeRuns < 0 ||
      !Number.isSafeInteger(scenario.frames) ||
      scenario.frames < 1 ||
      !Number.isSafeInteger(scenario.warmup) ||
      scenario.warmup < 0
    ) {
      throw new Error("Baseline frame and run counts are invalid");
    }

    const resolutions = normalizedResolutions();
    const pixelBudget = Math.max(
      ...resolutions.map(({ pixelCount }) => pixelCount),
    );
    const cells = buildCells();
    const estimatedSamples =
      cells.length * resolutions.length * scenario.runs * scenario.frames;
    if (estimatedSamples > 1_000_000) {
      throw new Error(
        `Baseline request contains ${estimatedSamples} samples; split the artifact`,
      );
    }

    const executionOrder: ExecutionOrderEntry[] = [];
    const artifactCells: Array<Record<string, unknown>> = [];
    let executionOrdinal = 0;
    let canonicalGpuMetadata: ZenWebGlMetadata | null = null;

    for (const [cellOrdinal, cell] of cells.entries()) {
      const options = benchmarkOptions(scenario.frames);
      const ref = createRef<PaperShaderElement>();
      const firstResolution = resolutions[0]!;
      const view = render(
        renderCell(ref, cell, firstResolution, pixelBudget, options),
      );
      await waitUntil(() => {
        const mount = ref.current?.paperShaderMount as
          | ResearchMount
          | undefined;
        return mount?.getPerformanceStats().isStaticFrameReady === true;
      }, `${cell.id} did not become ready`);

      const mount = currentMount(ref);
      const canvas = view.container.querySelector("canvas");
      const context = canvas?.getContext("webgl2");
      if (!canvas || !context) {
        throw new Error(`${cell.id} WebGL2 context is unavailable`);
      }
      const contextId = requiredResourceIdentity(
        mount.getPerformanceStats(),
      ).contextId;
      const recorded: RecordedMeasurement[] = [];

      const executeSchedule = async (
        phase: ExecutionOrderEntry["phase"],
        schedule: readonly (readonly ZenShaderResearchResolution[])[],
      ) => {
        for (const [runIndex, order] of schedule.entries()) {
          for (const [withinRunOrdinal, resolution] of order.entries()) {
            const ordinal = executionOrdinal;
            executionOrdinal += 1;
            executionOrder.push({
              ordinal,
              cellId: cell.id,
              phase,
              runIndex,
              withinRunOrdinal,
              resolutionId: resolution.id,
            });

            view.rerender(
              renderCell(ref, cell, resolution, pixelBudget, options),
            );
            await waitUntil(() => {
              const stats = currentMount(ref).getPerformanceStats();
              return (
                stats.isStaticFrameReady &&
                stats.renderWidth === resolution.width &&
                stats.renderHeight === resolution.height
              );
            }, `${cell.id} did not resize to ${resolution.id}`);
            if (
              currentMount(ref) !== mount ||
              view.container.querySelector("canvas") !== canvas ||
              canvas.getContext("webgl2") !== context ||
              mount.getPerformanceStats().contextId !== contextId
            ) {
              throw new Error(
                `${cell.id} replaced its mount or WebGL context during the sweep`,
              );
            }

            const report = await captureTimedRun(mount, cell, resolution);
            if (context.getError() !== context.NO_ERROR) {
              throw new Error(`${cell.id} produced a WebGL error`);
            }
            if (
              canonicalGpuMetadata !== null &&
              !metadataMatches(canonicalGpuMetadata, report.gpuMetadata)
            ) {
              throw new Error("GPU metadata changed between baseline cells");
            }
            canonicalGpuMetadata ??= { ...report.gpuMetadata };

            if (phase === "recorded") {
              const samples = report.gpuBenchmark.samples.map(
                ({ gpuTimeMs }) => gpuTimeMs,
              );
              if (
                samples.some((value) => !Number.isFinite(value) || value < 0)
              ) {
                throw new Error(`${cell.id} returned invalid GPU timing data`);
              }
              const stats = report.performanceStats;
              const resourceIdentity = requiredResourceIdentity(stats);
              recorded.push({
                executionOrdinal: ordinal,
                runIndex,
                withinRunOrdinal,
                resolution,
                contextId: resourceIdentity.contextId,
                resourceEpoch: resourceIdentity.resourceEpoch,
                frameGpuTimeMs: {
                  samples,
                  summary: percentiles(samples),
                },
                actualTopology: {
                  renderPipeline: stats.renderPipeline,
                  drawCallsPerFrame:
                    cell.plan.expectedTopology.totalDrawCallsPerFrame,
                  clearCallsPerFrame: stats.clearCallCount / scenario.frames,
                  sceneDrawCallsPerFrame:
                    stats.sceneDrawCallCount / scenario.frames,
                  compositeDrawCallsPerFrame:
                    stats.compositeDrawCallCount / scenario.frames,
                  sceneTargetBytes: stats.sceneTargetBytes,
                  totalIntermediateTextureBytes:
                    stats.totalIntermediateTextureBytes,
                  residentIntermediateTextureBytes:
                    resourceIdentity.residentIntermediateTextureBytes,
                  imageTextureCount: stats.imageTextureCount,
                },
              });
            }
          }
        }
      };

      if (scenario.primeRuns > 0) {
        await executeSchedule(
          "prime",
          buildZenShaderResearchResolutionSchedule(
            resolutions,
            scenario.primeRuns,
          ),
        );
      }
      await executeSchedule(
        "recorded",
        buildZenShaderResearchResolutionSchedule(resolutions, scenario.runs),
      );

      artifactCells.push({
        id: cell.id,
        executionOrdinal: cellOrdinal,
        workload: cell.workload,
        pipeline: cell.plan.pipeline,
        shader:
          cell.shader === null
            ? null
            : (() => {
                const definition = getPaperShaderDefinition(cell.shader);
                return {
                  id: definition.id,
                  name: definition.name,
                  animated: definition.animated,
                  imageSource: definition.imageSource ?? false,
                };
              })(),
        plan: cell.plan,
        contextId,
        measurements: recorded,
        summaryByResolution: summarizeByResolution(resolutions, recorded),
      });
      view.unmount();
    }

    if (!canonicalGpuMetadata) {
      throw new Error("Baseline research did not capture GPU metadata");
    }
    const artifact = {
      schemaVersion: 1,
      experiment: "baselines" as const,
      capturedAtEpochMs: Date.now(),
      provenance: {
        sourceRevision: scenario.sourceRevision,
        sourceDirty: scenario.sourceDirty,
        paperPackages: scenario.paperPackages,
        gpuMetadata: canonicalGpuMetadata,
        runner: "ZenShaderBaselineResearchRunner.browser.test.tsx",
      },
      scenario: {
        workloadRequest: scenario.workload,
        shaderRequest: scenario.shader,
        resolutions,
        pixelBudget,
        warmupFrames: scenario.warmup,
        measuredFrames: scenario.frames,
        requestedRuns: scenario.runs,
        primeRuns: scenario.primeRuns,
        fixedFrame: scenario.frame,
        orderSeed: scenario.orderSeed,
        requestedTimingMode: scenario.timing,
        effectiveTimingMode: "frame" as const,
        resolutionOrderPolicy: "forward-rotations-then-reverse-v1",
        dither: {
          enabled: scenario.dither,
          strength: scenario.ditherStrength,
        },
        halftone: {
          enabled: scenario.halftone,
          strength: scenario.halftoneStrength,
        },
        contrast: false,
        glass: false,
        palette: ZEN_SHADER_RESEARCH_PALETTE,
        headed: scenario.headed,
      },
      cells: artifactCells,
      executionOrder,
    };
    const serialized = JSON.stringify(artifact);
    const artifactBytes = new TextEncoder().encode(serialized).byteLength;
    if (artifactBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(
        `Baseline artifact is ${artifactBytes} bytes; split the experiment`,
      );
    }

    const response = await fetch(__ZEN_SHADER_RESEARCH_REPORT_ENDPOINT__, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-zen-shader-research-token": __ZEN_SHADER_RESEARCH_WRITE_TOKEN__,
      },
      body: serialized,
    });
    if (!response.ok) {
      throw new Error(
        `Could not write Zen shader baseline artifact: ${await response.text()}`,
      );
    }
  });
});
