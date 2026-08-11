import type { ZenShaderCadenceMode } from "./zenShaderCadenceResearch";

export interface ZenShaderCadenceRunInput {
  cadenceMode: ZenShaderCadenceMode;
  wallStartedAtMs: number;
  wallEndedAtMs: number;
  rafCallbackCount: number;
  rafTimestampsMs: readonly number[];
  schedulerWakeupCount: number;
  drawCount: number;
  drawCallCount: number;
  drawTimestampsMs: readonly number[];
  frameStart: number;
  frameEnd: number;
  animationElapsedMs: number;
  animationSpeed: number;
  visibilityState: DocumentVisibilityState;
  focused: boolean;
}

export interface ZenShaderCadencePercentiles {
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export interface ZenShaderCadenceIntervals {
  samples: number[];
  summary: ZenShaderCadencePercentiles;
}

export interface ZenShaderCadenceRunReport {
  cadenceMode: ZenShaderCadenceMode;
  wallDurationMs: number;
  displayRaf: {
    callbackCount: number;
    timestampsMs: number[];
    intervalMs: ZenShaderCadenceIntervals | null;
    inferredHz: number;
  };
  schedulerWakeupCount: number;
  draw: {
    count: number;
    drawCallCount: number;
    timestampsMs: number[];
    effectiveHz: number;
    intervalMs: ZenShaderCadenceIntervals | null;
  };
  skippedRafCount: number;
  skippedRafRatio: number;
  frame: {
    start: number;
    end: number;
    advance: number;
    accountedDurationMs: number;
    wallCoveragePercent: number;
    expectedAdvance: number;
    driftPercent: number;
  };
  lifecycle: {
    visibilityState: DocumentVisibilityState;
    focused: boolean;
  };
}

export interface ZenShaderCadenceRange {
  median: number;
  min: number;
  max: number;
}

export interface ZenShaderCadenceRunAggregate {
  cadenceMode: ZenShaderCadenceMode;
  runCount: number;
  displayRafHz: ZenShaderCadenceRange;
  effectiveDrawHz: ZenShaderCadenceRange;
  drawIntervalP95Ms: ZenShaderCadenceRange | null;
  skippedRafRatio: ZenShaderCadenceRange;
  frameDriftPercent: ZenShaderCadenceRange;
}

function assertFinite(value: number, label: string) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
}

function assertCount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer`);
  }
}

function validatedTimestamps(
  values: readonly number[],
  expectedCount: number,
  label: string,
  wallStartedAtMs: number,
  wallEndedAtMs: number,
) {
  if (values.length !== expectedCount) {
    throw new TypeError(
      `${label} timestamp count ${values.length} does not match ${expectedCount}`,
    );
  }
  const result = [...values];
  for (const [index, value] of result.entries()) {
    assertFinite(value, `${label} timestamp[${index}]`);
    if (value < wallStartedAtMs || value > wallEndedAtMs) {
      throw new TypeError(`${label} timestamp is outside the wall range`);
    }
    if (index > 0 && value <= result[index - 1]!) {
      throw new TypeError(`${label} timestamps must be strictly increasing`);
    }
  }
  return result;
}

function nearestRank(values: readonly number[], percentile: number) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentile * sorted.length) - 1);
  return sorted[index] as number;
}

function intervals(timestampsMs: readonly number[]) {
  if (timestampsMs.length < 2) return null;
  const samples = timestampsMs.slice(1).map((timestamp, index) => {
    const intervalMs = timestamp - timestampsMs[index]!;
    if (!(intervalMs > 0) || !Number.isFinite(intervalMs)) {
      throw new TypeError("Cadence intervals must be positive and finite");
    }
    return intervalMs;
  });
  return {
    samples,
    summary: {
      p50: nearestRank(samples, 0.5),
      p95: nearestRank(samples, 0.95),
      p99: nearestRank(samples, 0.99),
      max: Math.max(...samples),
    },
  } satisfies ZenShaderCadenceIntervals;
}

function assertStoppedInvariant(input: ZenShaderCadenceRunInput) {
  if (input.cadenceMode !== "stopped-retained") return;
  if (
    input.schedulerWakeupCount !== 0 ||
    input.drawCount !== 0 ||
    input.drawCallCount !== 0 ||
    input.drawTimestampsMs.length !== 0 ||
    input.frameEnd !== input.frameStart ||
    input.animationElapsedMs !== 0 ||
    input.animationSpeed !== 0
  ) {
    throw new TypeError(
      "stopped-retained must remain quiescent with zero scheduler, draw, and frame activity",
    );
  }
}

export function buildZenShaderCadenceRunReport(
  input: Readonly<ZenShaderCadenceRunInput>,
): ZenShaderCadenceRunReport {
  for (const [label, value] of [
    ["wallStartedAtMs", input.wallStartedAtMs],
    ["wallEndedAtMs", input.wallEndedAtMs],
    ["frameStart", input.frameStart],
    ["frameEnd", input.frameEnd],
    ["animationElapsedMs", input.animationElapsedMs],
    ["animationSpeed", input.animationSpeed],
  ] as const) {
    assertFinite(value, label);
  }
  if (input.wallEndedAtMs <= input.wallStartedAtMs) {
    throw new TypeError("wall end must be greater than wall start");
  }
  if (input.animationSpeed < 0) {
    throw new TypeError("animationSpeed must be non-negative");
  }
  if (
    input.animationElapsedMs < 0 ||
    input.animationElapsedMs > input.wallEndedAtMs - input.wallStartedAtMs
  ) {
    throw new TypeError(
      "animationElapsedMs must be within the outer wall duration",
    );
  }
  for (const [label, value] of [
    ["rAF callback count", input.rafCallbackCount],
    ["scheduler wakeup count", input.schedulerWakeupCount],
    ["draw count", input.drawCount],
    ["draw call count", input.drawCallCount],
  ] as const) {
    assertCount(value, label);
  }

  const rafTimestampsMs = validatedTimestamps(
    input.rafTimestampsMs,
    input.rafCallbackCount,
    "rAF",
    input.wallStartedAtMs,
    input.wallEndedAtMs,
  );
  const drawTimestampsMs = validatedTimestamps(
    input.drawTimestampsMs,
    input.drawCount,
    "draw",
    input.wallStartedAtMs,
    input.wallEndedAtMs,
  );
  assertStoppedInvariant(input);
  if (input.drawCount === 0 && input.drawCallCount !== 0) {
    throw new TypeError("draw call count must be zero when draw count is zero");
  }
  if (input.drawCount > 0 && input.drawCallCount < input.drawCount) {
    throw new TypeError("draw call count cannot be smaller than draw count");
  }

  const wallDurationMs = input.wallEndedAtMs - input.wallStartedAtMs;
  const rafIntervals = intervals(rafTimestampsMs);
  const drawIntervals = intervals(drawTimestampsMs);
  const skippedRafCount = Math.max(0, input.rafCallbackCount - input.drawCount);
  const frameAdvance = input.frameEnd - input.frameStart;
  const expectedFrameAdvance = input.animationElapsedMs * input.animationSpeed;
  let frameDriftPercent = 0;
  if (expectedFrameAdvance === 0) {
    if (frameAdvance !== 0) {
      throw new TypeError(
        "zero-speed cadence cannot have a non-zero frame advance",
      );
    }
  } else {
    frameDriftPercent =
      ((frameAdvance - expectedFrameAdvance) / expectedFrameAdvance) * 100;
  }

  return {
    cadenceMode: input.cadenceMode,
    wallDurationMs,
    displayRaf: {
      callbackCount: input.rafCallbackCount,
      timestampsMs: rafTimestampsMs,
      intervalMs: rafIntervals,
      inferredHz:
        rafIntervals && rafIntervals.summary.p50 > 0
          ? 1_000 / rafIntervals.summary.p50
          : 0,
    },
    schedulerWakeupCount: input.schedulerWakeupCount,
    draw: {
      count: input.drawCount,
      drawCallCount: input.drawCallCount,
      timestampsMs: drawTimestampsMs,
      effectiveHz: (input.drawCount * 1_000) / wallDurationMs,
      intervalMs: drawIntervals,
    },
    skippedRafCount,
    skippedRafRatio:
      input.rafCallbackCount === 0
        ? 0
        : skippedRafCount / input.rafCallbackCount,
    frame: {
      start: input.frameStart,
      end: input.frameEnd,
      advance: frameAdvance,
      accountedDurationMs: input.animationElapsedMs,
      wallCoveragePercent: (input.animationElapsedMs / wallDurationMs) * 100,
      expectedAdvance: expectedFrameAdvance,
      driftPercent: frameDriftPercent,
    },
    lifecycle: {
      visibilityState: input.visibilityState,
      focused: input.focused,
    },
  };
}

function median(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] as number;
  return ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

function range(values: readonly number[]): ZenShaderCadenceRange {
  if (values.length === 0) {
    throw new TypeError("At least one cadence run value is required");
  }
  return {
    median: median(values),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

export function aggregateZenShaderCadenceRunReports(
  runs: readonly ZenShaderCadenceRunReport[],
): ZenShaderCadenceRunAggregate {
  const first = runs[0];
  if (!first) throw new TypeError("At least one cadence run is required");
  if (runs.some(({ cadenceMode }) => cadenceMode !== first.cadenceMode)) {
    throw new TypeError("Cannot aggregate mixed cadence modes");
  }

  const drawIntervalP95Values = runs.flatMap(({ draw }) =>
    draw.intervalMs ? [draw.intervalMs.summary.p95] : [],
  );
  if (
    drawIntervalP95Values.length !== 0 &&
    drawIntervalP95Values.length !== runs.length
  ) {
    throw new TypeError(
      "Cannot aggregate cadence runs with partially missing draw intervals",
    );
  }

  return {
    cadenceMode: first.cadenceMode,
    runCount: runs.length,
    displayRafHz: range(runs.map(({ displayRaf }) => displayRaf.inferredHz)),
    effectiveDrawHz: range(runs.map(({ draw }) => draw.effectiveHz)),
    drawIntervalP95Ms:
      drawIntervalP95Values.length === 0 ? null : range(drawIntervalP95Values),
    skippedRafRatio: range(runs.map(({ skippedRafRatio }) => skippedRafRatio)),
    frameDriftPercent: range(runs.map(({ frame }) => frame.driftPercent)),
  };
}
