import type {
  ZenMultipassPerformanceReport,
  ZenTimingPercentiles,
} from "./ZenBlurResearchCanvas";
import type { ZenGpuPass, ZenGpuPassTimingSummary } from "./zenGpuTimerSampler";
import type { ZenWebGlMetadata } from "./zenWebGlDiagnostics";

const GPU_PASSES: readonly ZenGpuPass[] = [
  "scene",
  "downsample",
  "gaussianHorizontal",
  "gaussianVertical",
  "kawaseDown",
  "kawaseUp",
  "composite",
];

const GPU_METADATA_KEYS: readonly (keyof ZenWebGlMetadata)[] = [
  "vendor",
  "renderer",
  "unmaskedVendor",
  "unmaskedRenderer",
  "version",
  "shadingLanguageVersion",
  "maxTextureSize",
  "maxTextureImageUnits",
  "userAgent",
  "platform",
];

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface ZenBlurResearchArtifactInput<Scenario, Candidate> {
  scenario: Scenario;
  candidate: Candidate;
  runs: readonly ZenMultipassPerformanceReport[];
}

export interface ZenPerRunTimingRange {
  median: number;
  min: number;
  max: number;
}

export interface ZenPerRunTimingDistribution {
  p50: ZenPerRunTimingRange;
  p95: ZenPerRunTimingRange;
  p99: ZenPerRunTimingRange;
}

export interface ZenPerRunTimingSummary {
  gpuTimeMs: ZenPerRunTimingDistribution;
  blurGpuTimeMs: ZenPerRunTimingDistribution;
  gpuPassTimesMs: Readonly<Record<ZenGpuPass, ZenPerRunTimingDistribution>>;
  cpuSubmitTimeMs: ZenPerRunTimingDistribution;
}

export interface ZenBlurResearchAggregate {
  runCount: number;
  sampleCount: number;
  cpuSubmitSampleCount: number;
  gpuTimeMs: ZenTimingPercentiles;
  blurGpuTimeMs: ZenTimingPercentiles;
  gpuPassTimesMs: ZenGpuPassTimingSummary;
  cpuSubmitTimeMs: ZenTimingPercentiles;
  drawCallCountMedian: number;
  intermediateTextureBytesMax: number;
  reallocationCountTotal: number;
  perRun: ZenPerRunTimingSummary;
}

export interface ZenBlurResearchArtifact<Scenario, Candidate> {
  schemaVersion: 1;
  capturedAtEpochMs: number;
  scenario: Scenario;
  candidate: Candidate;
  gpuMetadata: ZenWebGlMetadata;
  runs: ZenMultipassPerformanceReport[];
  aggregate: ZenBlurResearchAggregate;
}

function invalidJson(path: string, reason: string): never {
  throw new TypeError(`Value at ${path} is not JSON-safe: ${reason}`);
}

function cloneJsonSafe(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        return invalidJson(path, "numbers must be finite");
      }
      return Object.is(value, -0) ? 0 : value;
    case "undefined":
    case "bigint":
    case "symbol":
    case "function":
      return invalidJson(path, `${typeof value} values are unsupported`);
    case "object":
      break;
  }

  if (ancestors.has(value)) {
    return invalidJson(path, "cyclic references are unsupported");
  }

  const prototype = Object.getPrototypeOf(value);
  if (
    !Array.isArray(value) &&
    prototype !== Object.prototype &&
    prototype !== null
  ) {
    return invalidJson(path, "only arrays and plain objects are supported");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const clone: JsonValue[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) {
          return invalidJson(
            `${path}[${index}]`,
            "sparse arrays are unsupported",
          );
        }
        clone.push(cloneJsonSafe(value[index], `${path}[${index}]`, ancestors));
      }
      return clone;
    }

    const clone: { [key: string]: JsonValue } = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        return invalidJson(path, "symbol keys are unsupported");
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        return invalidJson(
          `${path}.${key}`,
          "properties must be enumerable data properties",
        );
      }
      Object.defineProperty(clone, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: cloneJsonSafe(descriptor.value, `${path}.${key}`, ancestors),
      });
    }
    return clone;
  } finally {
    ancestors.delete(value);
  }
}

function finiteMetric(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}

function checkedAdd(left: number, right: number, path: string): number {
  const sum = left + right;
  if (!Number.isFinite(sum)) {
    throw new TypeError(`${path} overflowed and is not a finite JSON number`);
  }
  return sum;
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => jsonValuesEqual(value, right[index]))
    );
  }
  if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) &&
        jsonValuesEqual(left[key], right[key]),
    )
  );
}

function nearestRank(values: readonly number[], percentile: number): number {
  if (values.length === 0) {
    throw new TypeError("Cannot aggregate an empty raw sample set");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index] as number;
}

function percentiles(values: readonly number[]): ZenTimingPercentiles {
  return {
    p50: nearestRank(values, 0.5),
    p95: nearestRank(values, 0.95),
    p99: nearestRank(values, 0.99),
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new TypeError("Cannot calculate a median from an empty sample set");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  const left = sorted[middle - 1] as number;
  const right = sorted[middle] as number;
  const result = left / 2 + right / 2;
  if (!Number.isFinite(result)) {
    throw new TypeError("Median overflowed and is not a finite JSON number");
  }
  return result;
}

function timingRange(values: readonly number[]): ZenPerRunTimingRange {
  if (values.length === 0) {
    throw new TypeError("Cannot summarize an empty per-run timing set");
  }
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function perRunTimingDistribution(
  runPercentiles: readonly ZenTimingPercentiles[],
): ZenPerRunTimingDistribution {
  return {
    p50: timingRange(runPercentiles.map(({ p50 }) => p50)),
    p95: timingRange(runPercentiles.map(({ p95 }) => p95)),
    p99: timingRange(runPercentiles.map(({ p99 }) => p99)),
  };
}

function metadataMatches(expected: ZenWebGlMetadata, actual: ZenWebGlMetadata) {
  return GPU_METADATA_KEYS.every((key) =>
    Object.is(expected[key], actual[key]),
  );
}

type ResearchRun = ZenMultipassPerformanceReport & {
  gpuTimingMode?: unknown;
};

function measuredFrameCount(scenario: unknown): number | null {
  if (
    !isJsonRecord(scenario) ||
    !Object.prototype.hasOwnProperty.call(scenario, "measuredFrames")
  ) {
    return null;
  }
  const measuredFrames = finiteMetric(
    scenario.measuredFrames,
    "scenario.measuredFrames",
  );
  if (!Number.isSafeInteger(measuredFrames) || measuredFrames < 1) {
    throw new TypeError(
      "scenario.measuredFrames must be a positive safe integer",
    );
  }
  return measuredFrames;
}

function validateRunSemantics(
  scenario: unknown,
  candidate: unknown,
  runs: readonly ResearchRun[],
): void {
  const first = runs[0];
  if (!first) throw new TypeError("At least one benchmark run is required");
  if (!isJsonRecord(candidate)) {
    throw new TypeError("candidate must be a JSON object");
  }

  const expectedBackend = first.backend;
  const expectedOptions = first.researchOptions;
  const expectedFormat = first.performanceStats.blurFormat;
  const expectedTimingMode = first.gpuTimingMode;
  const expectedGpuMetadata = first.gpuMetadata;
  const expectedSamples = measuredFrameCount(scenario);

  if (!Object.is(candidate.backend, expectedBackend)) {
    throw new TypeError("candidate backend does not match benchmark runs");
  }
  if (!Object.is(candidate.textureFormat, expectedFormat)) {
    throw new TypeError(
      "candidate texture format does not match the actual blur format",
    );
  }
  if (
    Object.prototype.hasOwnProperty.call(candidate, "gpuTimingMode") &&
    !Object.is(candidate.gpuTimingMode, expectedTimingMode)
  ) {
    throw new TypeError(
      "candidate GPU timing mode does not match benchmark runs",
    );
  }
  const candidateOptionChecks: ReadonlyArray<
    readonly [string, JsonValue | undefined]
  > = [
    ["passes", expectedOptions.dualKawase.passes],
    ["offset", expectedOptions.dualKawase.offset],
    ["displayNoise", expectedOptions.displayNoise as unknown as JsonValue],
    ["rgba8Dither", expectedOptions.rgba8Dither as unknown as JsonValue],
  ];
  for (const [key, expected] of candidateOptionChecks) {
    if (
      Object.prototype.hasOwnProperty.call(candidate, key) &&
      !jsonValuesEqual(candidate[key], expected)
    ) {
      throw new TypeError(
        `candidate ${key} does not match benchmark research options`,
      );
    }
  }

  for (const [runIndex, run] of runs.entries()) {
    const runPath = `runs[${runIndex}]`;
    if (!Object.is(run.backend, expectedBackend)) {
      throw new TypeError(`${runPath} backend differs between benchmark runs`);
    }
    if (!jsonValuesEqual(run.researchOptions, expectedOptions)) {
      throw new TypeError(
        `${runPath} research options configuration differs between benchmark runs`,
      );
    }
    if (!Object.is(run.researchOptions.backend, run.backend)) {
      throw new TypeError(
        `${runPath} research options backend does not match its report backend`,
      );
    }
    if (!Object.is(run.performanceStats.backend, run.backend)) {
      throw new TypeError(
        `${runPath} performance actual backend does not match its report backend`,
      );
    }
    if (!Object.is(run.performanceStats.blurFormat, expectedFormat)) {
      throw new TypeError(
        `${runPath} performance actual blur format differs between benchmark runs`,
      );
    }
    if (!Object.is(run.gpuTimingMode, expectedTimingMode)) {
      throw new TypeError(
        `${runPath} GPU timing mode differs between benchmark runs`,
      );
    }
    const resolvedOptionsTimingMode =
      run.researchOptions.gpuTiming.measurementMode ?? "pass-breakdown";
    if (!Object.is(run.gpuTimingMode, resolvedOptionsTimingMode)) {
      throw new TypeError(
        `${runPath} GPU timing mode does not match its research options`,
      );
    }
    if (!metadataMatches(expectedGpuMetadata, run.gpuMetadata)) {
      throw new TypeError(
        `GPU metadata identity differs between runs[0] and runs[${runIndex}]`,
      );
    }

    const gpuSampleCount = run.gpuBenchmark.samples.length;
    const cpuSampleCount = run.cpuSubmit.samples.length;
    if (gpuSampleCount !== cpuSampleCount) {
      throw new TypeError(
        `${runPath} raw GPU and CPU sample counts must match`,
      );
    }
    if (expectedSamples !== null && gpuSampleCount !== expectedSamples) {
      throw new TypeError(
        `${runPath} sample count does not match scenario.measuredFrames`,
      );
    }
  }
}

function aggregateRuns(
  runs: readonly ZenMultipassPerformanceReport[],
): ZenBlurResearchAggregate {
  const gpuTimeMs: number[] = [];
  const blurGpuTimeMs: number[] = [];
  const cpuSubmitTimeMs: number[] = [];
  const drawCallCounts: number[] = [];
  const passTimes = Object.fromEntries(
    GPU_PASSES.map((pass) => [pass, [] as number[]]),
  ) as Record<ZenGpuPass, number[]>;
  const perRunGpuTimeMs: ZenTimingPercentiles[] = [];
  const perRunBlurGpuTimeMs: ZenTimingPercentiles[] = [];
  const perRunCpuSubmitTimeMs: ZenTimingPercentiles[] = [];
  const perRunPassTimes = Object.fromEntries(
    GPU_PASSES.map((pass) => [pass, [] as ZenTimingPercentiles[]]),
  ) as Record<ZenGpuPass, ZenTimingPercentiles[]>;
  let intermediateTextureBytesMax = 0;
  let reallocationCountTotal = 0;

  for (const [runIndex, run] of runs.entries()) {
    const runPath = `runs[${runIndex}]`;
    const runGpuTimeMs: number[] = [];
    const runBlurGpuTimeMs: number[] = [];
    const runCpuSubmitTimeMs: number[] = [];
    const runPassTimes = Object.fromEntries(
      GPU_PASSES.map((pass) => [pass, [] as number[]]),
    ) as Record<ZenGpuPass, number[]>;
    intermediateTextureBytesMax = Math.max(
      intermediateTextureBytesMax,
      finiteMetric(
        run.performanceStats.intermediateTextureBytes,
        `${runPath}.performanceStats.intermediateTextureBytes`,
      ),
    );
    reallocationCountTotal = checkedAdd(
      reallocationCountTotal,
      finiteMetric(
        run.performanceStats.blurTargetReallocationCount,
        `${runPath}.performanceStats.blurTargetReallocationCount`,
      ),
      "aggregate.reallocationCountTotal",
    );

    for (const [sampleIndex, sample] of run.gpuBenchmark.samples.entries()) {
      const samplePath = `${runPath}.gpuBenchmark.samples[${sampleIndex}]`;
      const sampleGpuTimeMs = finiteMetric(
        sample.gpuTimeMs,
        `${samplePath}.gpuTimeMs`,
      );
      const sampleBlurGpuTimeMs = finiteMetric(
        sample.blurGpuTimeMs,
        `${samplePath}.blurGpuTimeMs`,
      );
      gpuTimeMs.push(sampleGpuTimeMs);
      runGpuTimeMs.push(sampleGpuTimeMs);
      blurGpuTimeMs.push(sampleBlurGpuTimeMs);
      runBlurGpuTimeMs.push(sampleBlurGpuTimeMs);
      for (const pass of GPU_PASSES) {
        const samplePassTime = finiteMetric(
          sample.gpuPassTimesMs[pass],
          `${samplePath}.gpuPassTimesMs.${pass}`,
        );
        passTimes[pass].push(samplePassTime);
        runPassTimes[pass].push(samplePassTime);
      }
    }

    for (const [sampleIndex, sample] of run.cpuSubmit.samples.entries()) {
      const samplePath = `${runPath}.cpuSubmit.samples[${sampleIndex}]`;
      const sampleCpuSubmitTimeMs = finiteMetric(
        sample.cpuSubmitTimeMs,
        `${samplePath}.cpuSubmitTimeMs`,
      );
      cpuSubmitTimeMs.push(sampleCpuSubmitTimeMs);
      runCpuSubmitTimeMs.push(sampleCpuSubmitTimeMs);
      drawCallCounts.push(
        finiteMetric(sample.drawCallCount, `${samplePath}.drawCallCount`),
      );
    }

    perRunGpuTimeMs.push(percentiles(runGpuTimeMs));
    perRunBlurGpuTimeMs.push(percentiles(runBlurGpuTimeMs));
    perRunCpuSubmitTimeMs.push(percentiles(runCpuSubmitTimeMs));
    for (const pass of GPU_PASSES) {
      perRunPassTimes[pass].push(percentiles(runPassTimes[pass]));
    }
  }

  if (gpuTimeMs.length === 0) {
    throw new TypeError("At least one raw GPU timing sample is required");
  }
  if (cpuSubmitTimeMs.length === 0) {
    throw new TypeError("At least one raw CPU submit sample is required");
  }

  return {
    runCount: runs.length,
    sampleCount: gpuTimeMs.length,
    cpuSubmitSampleCount: cpuSubmitTimeMs.length,
    gpuTimeMs: percentiles(gpuTimeMs),
    blurGpuTimeMs: percentiles(blurGpuTimeMs),
    gpuPassTimesMs: Object.fromEntries(
      GPU_PASSES.map((pass) => [pass, percentiles(passTimes[pass])]),
    ) as unknown as ZenGpuPassTimingSummary,
    cpuSubmitTimeMs: percentiles(cpuSubmitTimeMs),
    drawCallCountMedian: median(drawCallCounts),
    intermediateTextureBytesMax,
    reallocationCountTotal,
    perRun: {
      gpuTimeMs: perRunTimingDistribution(perRunGpuTimeMs),
      blurGpuTimeMs: perRunTimingDistribution(perRunBlurGpuTimeMs),
      gpuPassTimesMs: Object.fromEntries(
        GPU_PASSES.map((pass) => [
          pass,
          perRunTimingDistribution(perRunPassTimes[pass]),
        ]),
      ) as unknown as Readonly<Record<ZenGpuPass, ZenPerRunTimingDistribution>>,
      cpuSubmitTimeMs: perRunTimingDistribution(perRunCpuSubmitTimeMs),
    },
  };
}

export function buildZenBlurResearchArtifact<Scenario, Candidate>({
  scenario,
  candidate,
  runs,
}: ZenBlurResearchArtifactInput<Scenario, Candidate>): ZenBlurResearchArtifact<
  Scenario,
  Candidate
> {
  if (!Array.isArray(runs) || runs.length === 0) {
    throw new TypeError("At least one benchmark run is required");
  }

  const scenarioCopy = cloneJsonSafe(scenario, "scenario") as Scenario;
  const candidateCopy = cloneJsonSafe(candidate, "candidate") as Candidate;
  const runsCopy = cloneJsonSafe(runs, "runs") as unknown as ResearchRun[];
  const gpuMetadata = runsCopy[0]?.gpuMetadata;
  if (!gpuMetadata) {
    throw new TypeError("Every benchmark run must include GPU metadata");
  }
  validateRunSemantics(scenarioCopy, candidateCopy, runsCopy);

  const artifact: ZenBlurResearchArtifact<Scenario, Candidate> = {
    schemaVersion: 1,
    capturedAtEpochMs: Date.now(),
    scenario: scenarioCopy,
    candidate: candidateCopy,
    gpuMetadata: { ...gpuMetadata },
    runs: runsCopy,
    aggregate: aggregateRuns(runsCopy),
  };
  return cloneJsonSafe(
    artifact,
    "artifact",
  ) as unknown as ZenBlurResearchArtifact<Scenario, Candidate>;
}
