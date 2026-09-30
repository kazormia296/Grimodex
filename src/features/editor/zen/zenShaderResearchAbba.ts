export type ZenShaderResearchAbbaSequence = "ABBA" | "BAAB";
export type ZenShaderResearchAbbaVariant = "raw" | "full";

export interface ZenShaderResearchAbbaFramePercentiles {
  p50: number;
  p95: number;
}

export interface ZenShaderResearchAbbaBlock {
  blockIndex: number;
  variant: ZenShaderResearchAbbaVariant;
  frameGpuTimeMs: ZenShaderResearchAbbaFramePercentiles;
}

export interface ZenShaderResearchAbbaRun {
  runIndex: number;
  sequence: ZenShaderResearchAbbaSequence;
  contextId: string;
  resourceEpoch: number;
  blocks: readonly ZenShaderResearchAbbaBlock[];
}

export interface ZenShaderResearchAbbaScheduleRun {
  runIndex: number;
  sequence: ZenShaderResearchAbbaSequence;
  variants: ZenShaderResearchAbbaVariant[];
}

export interface ZenShaderResearchAbbaPairedTiming {
  rawFrameGpuTimeMs: ZenShaderResearchAbbaFramePercentiles;
  fullFrameGpuTimeMs: ZenShaderResearchAbbaFramePercentiles;
  fullMinusRawFrameGpuTimeMs: ZenShaderResearchAbbaFramePercentiles;
}

export interface ZenShaderResearchAbbaSummarizedRun extends ZenShaderResearchAbbaRun {
  paired: ZenShaderResearchAbbaPairedTiming;
}

export interface ZenShaderResearchAbbaConfidenceInterval {
  method: "paired-bootstrap-percentile";
  confidenceLevel: number;
  iterations: number;
  seed: number;
  lower: number;
  upper: number;
}

export interface ZenShaderResearchAbbaDeltaSummary {
  median: number;
  ci: ZenShaderResearchAbbaConfidenceInterval;
  signs: {
    positive: number;
    negative: number;
    zero: number;
  };
}

export interface ZenShaderResearchAbbaSummary {
  runs: ZenShaderResearchAbbaSummarizedRun[];
  aggregate: {
    frameGpuTimeDeltaMs: {
      p50: ZenShaderResearchAbbaDeltaSummary;
      p95: ZenShaderResearchAbbaDeltaSummary;
    };
  };
}

export interface ZenShaderResearchAbbaSummaryInput {
  runs: readonly ZenShaderResearchAbbaRun[];
  confidenceLevel?: number;
  bootstrapIterations?: number;
  bootstrapSeed?: number;
}

const VARIANTS_BY_SEQUENCE = {
  ABBA: ["raw", "full", "full", "raw"],
  BAAB: ["full", "raw", "raw", "full"],
} as const satisfies Readonly<
  Record<ZenShaderResearchAbbaSequence, readonly ZenShaderResearchAbbaVariant[]>
>;

const DEFAULT_CONFIDENCE_LEVEL = 0.95;
const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
const DEFAULT_BOOTSTRAP_SEED = 492;
const MAX_BOOTSTRAP_ITERATIONS = 1_000_000;

export function buildZenShaderResearchAbbaSchedule(
  runCount: number,
  firstSequence: ZenShaderResearchAbbaSequence = "ABBA",
): ZenShaderResearchAbbaScheduleRun[] {
  if (!Number.isSafeInteger(runCount) || runCount < 2 || runCount % 2 !== 0) {
    throw new TypeError(
      "ABBA research runCount must be a positive even integer",
    );
  }
  if (firstSequence !== "ABBA" && firstSequence !== "BAAB") {
    throw new TypeError("ABBA research first sequence must be ABBA or BAAB");
  }

  return Array.from({ length: runCount }, (_, runIndex) => {
    const startsWithFirst = runIndex % 2 === 0;
    const sequence = startsWithFirst
      ? firstSequence
      : firstSequence === "ABBA"
        ? "BAAB"
        : "ABBA";
    return {
      runIndex,
      sequence,
      variants: [...VARIANTS_BY_SEQUENCE[sequence]],
    };
  });
}

function finiteNumber(value: number, path: string) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}

function meanPair(left: number, right: number) {
  const result = left / 2 + right / 2;
  if (!Number.isFinite(result)) {
    throw new TypeError("ABBA paired mean overflowed");
  }
  return result;
}

function median(values: readonly number[]) {
  if (values.length === 0) {
    throw new TypeError("Cannot summarize an empty ABBA sample set");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return meanPair(sorted[middle - 1]!, sorted[middle]!);
}

function nearestRank(values: readonly number[], fraction: number) {
  if (values.length === 0) {
    throw new TypeError("Cannot calculate an ABBA percentile without samples");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[Math.min(index, sorted.length - 1)]!;
}

function seededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b_79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}

function validateRun(run: ZenShaderResearchAbbaRun, expectedRunIndex: number) {
  if (
    !Number.isSafeInteger(run.runIndex) ||
    run.runIndex !== expectedRunIndex
  ) {
    throw new TypeError(
      `ABBA run index ${run.runIndex} must equal its order ${expectedRunIndex}`,
    );
  }
  if (run.sequence !== "ABBA" && run.sequence !== "BAAB") {
    throw new TypeError(`ABBA run ${run.runIndex} has an invalid sequence`);
  }
  if (run.blocks.length !== 4) {
    throw new TypeError(`ABBA run ${run.runIndex} must contain four blocks`);
  }
  if (typeof run.contextId !== "string" || run.contextId.trim() === "") {
    throw new TypeError(`ABBA run ${run.runIndex} contextId is required`);
  }
  if (!Number.isSafeInteger(run.resourceEpoch) || run.resourceEpoch < 0) {
    throw new TypeError(
      `ABBA run ${run.runIndex} resourceEpoch must be a non-negative integer`,
    );
  }

  const expectedVariants = VARIANTS_BY_SEQUENCE[run.sequence];
  for (const [blockIndex, block] of run.blocks.entries()) {
    if (block.blockIndex !== blockIndex) {
      throw new TypeError(
        `ABBA run ${run.runIndex} block order is not contiguous`,
      );
    }
    if (block.variant !== expectedVariants[blockIndex]) {
      throw new TypeError(
        `ABBA run ${run.runIndex} block order does not match ${run.sequence}`,
      );
    }
    finiteNumber(
      block.frameGpuTimeMs.p50,
      `ABBA run ${run.runIndex} blocks[${blockIndex}].p50`,
    );
    finiteNumber(
      block.frameGpuTimeMs.p95,
      `ABBA run ${run.runIndex} blocks[${blockIndex}].p95`,
    );
  }
}

function pairedTiming(
  run: ZenShaderResearchAbbaRun,
): ZenShaderResearchAbbaPairedTiming {
  const raw = run.blocks.filter(({ variant }) => variant === "raw");
  const full = run.blocks.filter(({ variant }) => variant === "full");
  const rawFrameGpuTimeMs = {
    p50: meanPair(raw[0]!.frameGpuTimeMs.p50, raw[1]!.frameGpuTimeMs.p50),
    p95: meanPair(raw[0]!.frameGpuTimeMs.p95, raw[1]!.frameGpuTimeMs.p95),
  };
  const fullFrameGpuTimeMs = {
    p50: meanPair(full[0]!.frameGpuTimeMs.p50, full[1]!.frameGpuTimeMs.p50),
    p95: meanPair(full[0]!.frameGpuTimeMs.p95, full[1]!.frameGpuTimeMs.p95),
  };
  return {
    rawFrameGpuTimeMs,
    fullFrameGpuTimeMs,
    fullMinusRawFrameGpuTimeMs: {
      p50: finiteNumber(
        fullFrameGpuTimeMs.p50 - rawFrameGpuTimeMs.p50,
        `ABBA run ${run.runIndex} p50 delta`,
      ),
      p95: finiteNumber(
        fullFrameGpuTimeMs.p95 - rawFrameGpuTimeMs.p95,
        `ABBA run ${run.runIndex} p95 delta`,
      ),
    },
  };
}

function signCounts(values: readonly number[]) {
  return values.reduce(
    (counts, value) => {
      if (value > 0) counts.positive += 1;
      else if (value < 0) counts.negative += 1;
      else counts.zero += 1;
      return counts;
    },
    { positive: 0, negative: 0, zero: 0 },
  );
}

export function buildZenShaderResearchAbbaSummary({
  runs,
  confidenceLevel = DEFAULT_CONFIDENCE_LEVEL,
  bootstrapIterations = DEFAULT_BOOTSTRAP_ITERATIONS,
  bootstrapSeed = DEFAULT_BOOTSTRAP_SEED,
}: ZenShaderResearchAbbaSummaryInput): ZenShaderResearchAbbaSummary {
  if (!Array.isArray(runs)) {
    throw new TypeError("ABBA research runs must be an array");
  }
  const checkedRuns = runs as readonly ZenShaderResearchAbbaRun[];
  if (checkedRuns.length === 0) {
    throw new TypeError("At least one ABBA research run is required");
  }
  if (
    !Number.isFinite(confidenceLevel) ||
    confidenceLevel <= 0 ||
    confidenceLevel >= 1
  ) {
    throw new TypeError("ABBA confidenceLevel must be between zero and one");
  }
  if (
    !Number.isSafeInteger(bootstrapIterations) ||
    bootstrapIterations < 1 ||
    bootstrapIterations > MAX_BOOTSTRAP_ITERATIONS
  ) {
    throw new TypeError(
      `ABBA bootstrapIterations must be between 1 and ${MAX_BOOTSTRAP_ITERATIONS}`,
    );
  }
  if (
    !Number.isSafeInteger(bootstrapSeed) ||
    bootstrapSeed < 0 ||
    bootstrapSeed > 0xffff_ffff
  ) {
    throw new TypeError("ABBA bootstrapSeed must be a uint32 integer");
  }

  checkedRuns.forEach(validateRun);
  const first = checkedRuns[0]!;
  for (const run of checkedRuns.slice(1)) {
    if (run.contextId !== first.contextId) {
      throw new TypeError("ABBA research runs use mixed WebGL contexts");
    }
    if (run.resourceEpoch !== first.resourceEpoch) {
      throw new TypeError("ABBA research runs use mixed resource epochs");
    }
  }

  const summarizedRuns = checkedRuns.map((run) => ({
    ...run,
    blocks: run.blocks.map((block) => ({
      ...block,
      frameGpuTimeMs: { ...block.frameGpuTimeMs },
    })),
    paired: pairedTiming(run),
  }));
  const p50Deltas = summarizedRuns.map(
    ({ paired }) => paired.fullMinusRawFrameGpuTimeMs.p50,
  );
  const p95Deltas = summarizedRuns.map(
    ({ paired }) => paired.fullMinusRawFrameGpuTimeMs.p95,
  );
  const random = seededRandom(bootstrapSeed);
  const bootstrapP50: number[] = [];
  const bootstrapP95: number[] = [];
  for (let iteration = 0; iteration < bootstrapIterations; iteration += 1) {
    const sampledP50: number[] = [];
    const sampledP95: number[] = [];
    for (let sample = 0; sample < summarizedRuns.length; sample += 1) {
      const index = Math.floor(random() * summarizedRuns.length);
      sampledP50.push(p50Deltas[index]!);
      sampledP95.push(p95Deltas[index]!);
    }
    bootstrapP50.push(median(sampledP50));
    bootstrapP95.push(median(sampledP95));
  }
  const alpha = 1 - confidenceLevel;
  const deltaSummary = (
    values: readonly number[],
    bootstrapValues: readonly number[],
  ): ZenShaderResearchAbbaDeltaSummary => ({
    median: median(values),
    ci: {
      method: "paired-bootstrap-percentile",
      confidenceLevel,
      iterations: bootstrapIterations,
      seed: bootstrapSeed,
      lower: nearestRank(bootstrapValues, alpha / 2),
      upper: nearestRank(bootstrapValues, 1 - alpha / 2),
    },
    signs: signCounts(values),
  });

  return {
    runs: summarizedRuns,
    aggregate: {
      frameGpuTimeDeltaMs: {
        p50: deltaSummary(p50Deltas, bootstrapP50),
        p95: deltaSummary(p95Deltas, bootstrapP95),
      },
    },
  };
}
