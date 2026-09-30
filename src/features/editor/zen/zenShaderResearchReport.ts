import type { ZenMultipassPerformanceReport } from "./ZenBlurResearchCanvas";
import {
  buildZenBlurResearchArtifact,
  type ZenBlurResearchAggregate,
} from "./zenBlurResearchReport";
import type { PaperShaderId } from "./paperShaderCatalog";
import type {
  ZenGpuTimingMode,
  ZenGpuTimingPercentiles,
} from "./zenGpuTimerSampler";
import type { ZenShaderResearchPipeline } from "./zenShaderResearchPipeline";
import type { ZenWebGlMetadata } from "./zenWebGlDiagnostics";

export type ZenShaderResearchTimingMode = Extract<
  ZenGpuTimingMode,
  "pass-breakdown" | "frame"
>;

type JsonPrimitive = string | number | boolean | null;
export type ZenShaderResearchJson =
  | JsonPrimitive
  | ZenShaderResearchJson[]
  | { [key: string]: ZenShaderResearchJson };

export interface ZenShaderResearchCondition {
  pipeline: ZenShaderResearchPipeline;
  dither: boolean;
  ditherStrength: number;
  halftone: boolean;
  halftoneStrength: number;
  contrast: boolean;
  contrastStrength: number;
  glass: boolean;
  blurRadiusPx: number;
  glassRefraction: number;
  glassSaturation: number;
  glassShine: number;
  compositeFixtureId: string;
  uiSurfaceCapacity: number;
  activeUiSurfaceCount: number;
  fixedFrame: number;
}

export interface ZenShaderResearchDescriptor {
  id: PaperShaderId;
  name: string;
  animated: boolean;
  imageSource: boolean;
}

export interface ZenShaderResearchMeasurement {
  shader: ZenShaderResearchDescriptor;
  executionOrdinal: number;
  effectiveProps: Record<string, unknown>;
  passBreakdownRuns?: readonly ZenMultipassPerformanceReport[];
  frameRuns?: readonly ZenMultipassPerformanceReport[];
}

interface ZenShaderResearchCandidate extends ZenShaderResearchCondition {
  shader: PaperShaderId;
  shaderName: string;
  animated: boolean;
  imageSource: boolean;
  executionOrdinal: number;
  effectiveProps: Record<string, unknown>;
  backend: ZenMultipassPerformanceReport["backend"];
  textureFormat: "rgba16f" | "rgba8";
  gpuTimingMode: ZenShaderResearchTimingMode;
}

export interface ZenShaderResearchTimingResult {
  timingMode: ZenShaderResearchTimingMode;
  runs: ZenMultipassPerformanceReport[];
  aggregate: ZenBlurResearchAggregate;
}

export interface ZenShaderResearchResult {
  shader: ZenShaderResearchDescriptor;
  executionOrdinal: number;
  effectiveProps: Record<string, unknown>;
  passBreakdown: ZenShaderResearchTimingResult | null;
  frame: ZenShaderResearchTimingResult | null;
}

export interface ZenShaderResearchRankingRow {
  rank: number;
  shader: PaperShaderId;
  name: string;
  animated: boolean;
  frameGpuTimeMs: ZenGpuTimingPercentiles | null;
  sceneGpuTimeMs: ZenGpuTimingPercentiles | null;
  compositeGpuTimeMs: ZenGpuTimingPercentiles | null;
  drawCallCountMedian: number;
  renderWidth: number;
  renderHeight: number;
  sceneTargetBytes: number;
  totalIntermediateTextureBytes: number;
  imageTextureCount: number;
}

export interface ZenShaderResearchArtifact<Scenario> {
  schemaVersion: 1;
  capturedAtEpochMs: number;
  scenario: Scenario;
  condition: ZenShaderResearchCondition;
  gpuMetadata: ZenWebGlMetadata;
  rankingMetric: "frame-gpu-p95" | "pass-query-sum-p95";
  ranking: ZenShaderResearchRankingRow[];
  results: ZenShaderResearchResult[];
}

export interface ZenShaderResearchArtifactInput<Scenario> {
  scenario: Scenario;
  condition: ZenShaderResearchCondition;
  measurements: readonly ZenShaderResearchMeasurement[];
  requiredTimingModes?: readonly ZenShaderResearchTimingMode[];
}

function validateCondition(condition: ZenShaderResearchCondition) {
  for (const [label, value] of [
    ["uiSurfaceCapacity", condition.uiSurfaceCapacity],
    ["activeUiSurfaceCount", condition.activeUiSurfaceCount],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new TypeError(`${label} must be a non-negative safe integer`);
    }
  }
  if (condition.activeUiSurfaceCount > condition.uiSurfaceCapacity) {
    throw new TypeError("activeUiSurfaceCount exceeds uiSurfaceCapacity");
  }
  if (
    condition.pipeline !== "full" &&
    (condition.uiSurfaceCapacity !== 0 || condition.activeUiSurfaceCount !== 0)
  ) {
    throw new TypeError("Non-full pipelines cannot execute UI surfaces");
  }
  if (!condition.glass && condition.activeUiSurfaceCount !== 0) {
    throw new TypeError("Glass-off conditions cannot have active UI surfaces");
  }
}

function timingRuns(
  measurement: ZenShaderResearchMeasurement,
  mode: ZenShaderResearchTimingMode,
) {
  return mode === "frame"
    ? measurement.frameRuns
    : measurement.passBreakdownRuns;
}

function buildTimingResult<Scenario>(
  scenario: Scenario,
  condition: ZenShaderResearchCondition,
  measurement: ZenShaderResearchMeasurement,
  mode: ZenShaderResearchTimingMode,
): ZenShaderResearchTimingResult | null {
  const runs = timingRuns(measurement, mode);
  if (!runs || runs.length === 0) return null;

  const first = runs[0];
  if (!first) return null;
  for (const [index, run] of runs.entries()) {
    if (run.gpuTimingMode !== mode) {
      throw new TypeError(
        `${measurement.shader.id} ${mode} runs[${index}] has ${run.gpuTimingMode} timing`,
      );
    }
  }

  const candidate: ZenShaderResearchCandidate = {
    ...condition,
    shader: measurement.shader.id,
    shaderName: measurement.shader.name,
    animated: measurement.shader.animated,
    imageSource: measurement.shader.imageSource,
    executionOrdinal: measurement.executionOrdinal,
    effectiveProps: measurement.effectiveProps,
    backend: first.backend,
    textureFormat: first.performanceStats.blurFormat,
    gpuTimingMode: mode,
  };
  const nested = buildZenBlurResearchArtifact({
    scenario,
    candidate,
    runs,
  });
  return {
    timingMode: mode,
    runs: nested.runs,
    aggregate: nested.aggregate,
  };
}

function metadataMatches(left: ZenWebGlMetadata, right: ZenWebGlMetadata) {
  return (Object.keys(left) as (keyof ZenWebGlMetadata)[]).every((key) =>
    Object.is(left[key], right[key]),
  );
}

function firstRun(result: ZenShaderResearchResult) {
  return result.frame?.runs[0] ?? result.passBreakdown?.runs[0] ?? null;
}

function finiteStat(
  stats: ZenMultipassPerformanceReport["performanceStats"],
  key: string,
  fallback: number,
) {
  const value = (stats as unknown as Record<string, unknown>)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function buildRankingRow(
  result: ZenShaderResearchResult,
): Omit<ZenShaderResearchRankingRow, "rank"> {
  const frameGpuTimeMs = result.frame?.aggregate.gpuTimeMs ?? null;
  const passAggregate = result.passBreakdown?.aggregate ?? null;
  const run = firstRun(result);
  if (!run) throw new TypeError(`${result.shader.id} has no benchmark run`);
  const stats = run.performanceStats;
  const renderWidth = finiteStat(stats, "renderWidth", stats.sceneTargetWidth);
  const renderHeight = finiteStat(
    stats,
    "renderHeight",
    stats.sceneTargetHeight,
  );
  const sceneTargetBytes = finiteStat(
    stats,
    "sceneTargetBytes",
    stats.sceneTargetWidth * stats.sceneTargetHeight * 4,
  );
  const totalIntermediateTextureBytes = finiteStat(
    stats,
    "totalIntermediateTextureBytes",
    sceneTargetBytes + stats.intermediateTextureBytes,
  );

  return {
    shader: result.shader.id,
    name: result.shader.name,
    animated: result.shader.animated,
    frameGpuTimeMs,
    sceneGpuTimeMs: passAggregate?.gpuPassTimesMs.scene ?? null,
    compositeGpuTimeMs: passAggregate?.gpuPassTimesMs.composite ?? null,
    drawCallCountMedian:
      result.frame?.aggregate.drawCallCountMedian ??
      passAggregate?.drawCallCountMedian ??
      0,
    renderWidth,
    renderHeight,
    sceneTargetBytes,
    totalIntermediateTextureBytes,
    imageTextureCount: finiteStat(stats, "imageTextureCount", 0),
  };
}

export function buildZenShaderResearchArtifact<Scenario>({
  scenario,
  condition,
  measurements,
  requiredTimingModes = ["pass-breakdown", "frame"],
}: ZenShaderResearchArtifactInput<Scenario>): ZenShaderResearchArtifact<Scenario> {
  if (!Array.isArray(measurements) || measurements.length === 0) {
    throw new TypeError("At least one shader measurement is required");
  }
  validateCondition(condition);

  const seenShaders = new Set<PaperShaderId>();
  const seenOrdinals = new Set<number>();
  const results = [...measurements]
    .sort((left, right) => left.executionOrdinal - right.executionOrdinal)
    .map((measurement) => {
      if (seenShaders.has(measurement.shader.id)) {
        throw new TypeError(
          `Duplicate shader measurement: ${measurement.shader.id}`,
        );
      }
      if (seenOrdinals.has(measurement.executionOrdinal)) {
        throw new TypeError(
          `Duplicate execution ordinal: ${measurement.executionOrdinal}`,
        );
      }
      seenShaders.add(measurement.shader.id);
      seenOrdinals.add(measurement.executionOrdinal);

      for (const mode of requiredTimingModes) {
        if (!timingRuns(measurement, mode)?.length) {
          throw new TypeError(
            `${measurement.shader.id} is missing required ${mode} timing runs`,
          );
        }
      }

      return {
        shader: { ...measurement.shader },
        executionOrdinal: measurement.executionOrdinal,
        effectiveProps: { ...measurement.effectiveProps },
        passBreakdown: buildTimingResult(
          scenario,
          condition,
          measurement,
          "pass-breakdown",
        ),
        frame: buildTimingResult(scenario, condition, measurement, "frame"),
      } satisfies ZenShaderResearchResult;
    });

  const first = firstRun(results[0]!);
  if (!first) throw new TypeError("At least one benchmark run is required");
  for (const result of results) {
    for (const timing of [result.passBreakdown, result.frame]) {
      for (const run of timing?.runs ?? []) {
        if (!metadataMatches(first.gpuMetadata, run.gpuMetadata)) {
          throw new TypeError("GPU metadata identity differs between shaders");
        }
      }
    }
  }

  const hasExactFrameTiming = results.every((result) => result.frame !== null);
  const rankingMetric = hasExactFrameTiming
    ? "frame-gpu-p95"
    : "pass-query-sum-p95";
  const ranking = results
    .map(buildRankingRow)
    .sort((left, right) => {
      const leftP95 =
        left.frameGpuTimeMs?.p95 ??
        results.find(({ shader }) => shader.id === left.shader)?.passBreakdown
          ?.aggregate.gpuTimeMs.p95 ??
        0;
      const rightP95 =
        right.frameGpuTimeMs?.p95 ??
        results.find(({ shader }) => shader.id === right.shader)?.passBreakdown
          ?.aggregate.gpuTimeMs.p95 ??
        0;
      return rightP95 - leftP95 || left.shader.localeCompare(right.shader);
    })
    .map((row, index) => ({ ...row, rank: index + 1 }));

  return {
    schemaVersion: 1,
    capturedAtEpochMs: Date.now(),
    scenario,
    condition: { ...condition },
    gpuMetadata: { ...first.gpuMetadata },
    rankingMetric,
    ranking,
    results,
  };
}
