import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimePerformanceAttemptPaths,
  classifyTransientPerformanceRetry,
  runRuntimePerformanceWithRetry,
} from "../electron/scripts/runtime-performance-retry.mjs";
import { parsePerformanceBenchmarkArguments } from "../electron/scripts/performance-benchmark.mjs";

function buildGestureMetrics(
  interaction = "chroniclePan",
  {
    count = 1,
    duration = 6_736,
    unattributedMs = 6_735.8,
    entries = null,
  } = {},
) {
  return {
    interactions: {
      [interaction]: {
        gestureLongTaskCount: count,
        gestureLongTaskMaxMs: duration,
        gestureLongTaskEntries:
          entries ??
          Array.from({ length: count }, (_, index) => ({
            startTime: 54_086.6 + index,
            duration,
            overlappingMarks: [
              {
                label: `chronicle.pan.commit`,
                start: 54_087,
                duration: Math.max(0, duration - unattributedMs),
              },
            ],
            unattributedMs,
          })),
      },
    },
  };
}

function buildEvaluation(interaction = "chroniclePan", extraFailedChecks = []) {
  const prefix = `interactions.${interaction}`;
  return {
    ok: false,
    checks: [
      { name: "fixture.id", ok: true },
      { name: `${prefix}.targetVerified`, ok: true },
      { name: `${prefix}.p95FrameMs`, ok: true },
      { name: `${prefix}.meanFrameMs`, ok: true },
      { name: `${prefix}.maxFrameMs`, ok: true },
      { name: `${prefix}.frameCount`, ok: true },
      { name: `${prefix}.workFrameCount`, ok: true },
      { name: `${prefix}.workCoverage`, ok: true },
      { name: `${prefix}.gestureLongTaskCount`, ok: false },
      { name: `${prefix}.gestureLongTaskMaxMs`, ok: false },
      ...extraFailedChecks.map((name) => ({ name, ok: false })),
    ],
  };
}

function eligibleFailure(interaction = "chroniclePan") {
  return {
    status: 1,
    phase: "budget",
    metrics: buildGestureMetrics(interaction),
    evaluation: buildEvaluation(interaction),
  };
}

const passingAttempt = Object.freeze({
  status: 0,
  phase: "complete",
  metrics: {},
  evaluation: { ok: true, checks: [] },
});

test("CI retry flag is explicit and disabled for the default benchmark", () => {
  assert.deepEqual(
    parsePerformanceBenchmarkArguments([
      "node",
      "performance-benchmark.mjs",
      "--output",
      "runtime-metrics.json",
    ]),
    {
      outputPath: new URL("../runtime-metrics.json", import.meta.url).pathname,
      reviewFixtureId: null,
      retryTransientOnce: false,
    },
  );

  const parsed = parsePerformanceBenchmarkArguments([
    "node",
    "performance-benchmark.mjs",
    "--retry-transient-once",
    "--output",
    "runtime-metrics.json",
  ]);
  assert.equal(parsed.retryTransientOnce, true);
  assert.throws(
    () =>
      parsePerformanceBenchmarkArguments([
        "node",
        "performance-benchmark.mjs",
        "--retry-transient-once",
        "--retry-transient-once",
      ]),
    /--retry-transient-once may only be specified once/,
  );
});

test("only one strongly unattributed gesture Long Task is retryable", () => {
  for (const interaction of ["timelineDrag", "chroniclePan"]) {
    const decision = classifyTransientPerformanceRetry(
      buildGestureMetrics(interaction),
      buildEvaluation(interaction),
    );
    assert.deepEqual(decision, {
      eligible: true,
      reason: "single-unattributed-gesture-longtask",
      interaction,
      durationMs: 6_736,
      unattributedMs: 6_735.8,
      unattributedRatio: 6_735.8 / 6_736,
    });
  }
});

test("attributable, repeated, malformed, and mixed regressions are not retryable", () => {
  const attributable = classifyTransientPerformanceRetry(
    buildGestureMetrics("chroniclePan", {
      unattributedMs: 6_736 * 0.94,
    }),
    buildEvaluation("chroniclePan"),
  );
  assert.equal(attributable.eligible, false);
  assert.equal(attributable.reason, "longtask-attribution-too-high");

  const repeated = classifyTransientPerformanceRetry(
    buildGestureMetrics("chroniclePan", { count: 2 }),
    buildEvaluation("chroniclePan"),
  );
  assert.equal(repeated.eligible, false);
  assert.equal(repeated.reason, "longtask-count-not-single");

  const malformed = classifyTransientPerformanceRetry(
    buildGestureMetrics("chroniclePan", { entries: [] }),
    buildEvaluation("chroniclePan"),
  );
  assert.equal(malformed.eligible, false);
  assert.equal(malformed.reason, "longtask-evidence-incomplete");

  const mixed = classifyTransientPerformanceRetry(
    buildGestureMetrics("chroniclePan"),
    buildEvaluation("chroniclePan", ["interactions.chroniclePan.p95FrameMs"]),
  );
  assert.equal(mixed.eligible, false);
  assert.equal(mixed.reason, "non-longtask-budget-failure");
});

test("attempt paths preserve both samples without changing the canonical path", () => {
  assert.deepEqual(
    buildRuntimePerformanceAttemptPaths(
      "/tmp/electron-runtime-performance/runtime-metrics.json",
    ),
    {
      canonical: "/tmp/electron-runtime-performance/runtime-metrics.json",
      firstEvidence:
        "/tmp/electron-runtime-performance/runtime-metrics-attempt-1.json",
      secondEvidence:
        "/tmp/electron-runtime-performance/runtime-metrics-attempt-2.json",
    },
  );
});

test("a clean first attempt never retries", () => {
  const executed = [];
  const copied = [];
  const recovered = [];
  const result = runRuntimePerformanceWithRetry({
    outputPath: "/tmp/perf/runtime-metrics.json",
    retryTransientOnce: true,
    executeAttempt: (attempt) => {
      executed.push(attempt);
      return passingAttempt;
    },
    copyMetrics: (...paths) => copied.push(paths),
    onRecovered: (decision) => recovered.push(decision),
  });

  assert.equal(result.status, 0);
  assert.equal(result.attemptCount, 1);
  assert.equal(result.recovered, false);
  assert.deepEqual(executed, [
    { attempt: 1, metricsPath: "/tmp/perf/runtime-metrics.json" },
  ]);
  assert.deepEqual(copied, []);
  assert.deepEqual(recovered, []);
});

test("an eligible failure retries once, preserves both samples, and warns on recovery", () => {
  const responses = [eligibleFailure(), passingAttempt];
  const executed = [];
  const copied = [];
  const recovered = [];
  const result = runRuntimePerformanceWithRetry({
    outputPath: "/tmp/perf/runtime-metrics.json",
    retryTransientOnce: true,
    executeAttempt: (attempt) => {
      executed.push(attempt);
      return responses.shift();
    },
    copyMetrics: (...paths) => copied.push(paths),
    onRecovered: (decision) => recovered.push(decision),
  });

  assert.equal(result.status, 0);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.recovered, true);
  assert.equal(result.retryDecision.interaction, "chroniclePan");
  assert.deepEqual(executed, [
    { attempt: 1, metricsPath: "/tmp/perf/runtime-metrics.json" },
    {
      attempt: 2,
      metricsPath: "/tmp/perf/runtime-metrics-attempt-2.json",
    },
  ]);
  assert.deepEqual(copied, [
    [
      "/tmp/perf/runtime-metrics.json",
      "/tmp/perf/runtime-metrics-attempt-1.json",
    ],
    [
      "/tmp/perf/runtime-metrics-attempt-2.json",
      "/tmp/perf/runtime-metrics.json",
    ],
  ]);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].reason, "single-unattributed-gesture-longtask");
});

test("retry is bounded and cannot rescue a second failure", () => {
  const responses = [eligibleFailure(), eligibleFailure("timelineDrag")];
  const copied = [];
  const recovered = [];
  const result = runRuntimePerformanceWithRetry({
    outputPath: "/tmp/perf/runtime-metrics.json",
    retryTransientOnce: true,
    executeAttempt: () => responses.shift(),
    copyMetrics: (...paths) => copied.push(paths),
    onRecovered: (decision) => recovered.push(decision),
  });

  assert.equal(result.status, 1);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.recovered, false);
  assert.equal(copied.length, 2);
  assert.deepEqual(recovered, []);
});

test("measurement errors, mixed regressions, and disabled policy never retry", () => {
  const cases = [
    {
      retryTransientOnce: true,
      first: {
        status: 1,
        phase: "measurement",
        metrics: null,
        evaluation: null,
      },
    },
    {
      retryTransientOnce: true,
      first: {
        status: 1,
        phase: "measurement-timeout",
        metrics: null,
        evaluation: null,
      },
    },
    {
      retryTransientOnce: true,
      first: {
        ...eligibleFailure(),
        evaluation: buildEvaluation("chroniclePan", ["projectOpenMs"]),
      },
    },
    { retryTransientOnce: false, first: eligibleFailure() },
  ];

  for (const testCase of cases) {
    let attemptCount = 0;
    const result = runRuntimePerformanceWithRetry({
      outputPath: "/tmp/perf/runtime-metrics.json",
      retryTransientOnce: testCase.retryTransientOnce,
      executeAttempt: () => {
        attemptCount += 1;
        return testCase.first;
      },
      copyMetrics: () => assert.fail("non-retryable failures are not copied"),
      onRecovered: () => assert.fail("non-retryable failures cannot recover"),
    });
    assert.equal(result.status, 1);
    assert.equal(result.attemptCount, 1);
    assert.equal(attemptCount, 1);
  }
});
