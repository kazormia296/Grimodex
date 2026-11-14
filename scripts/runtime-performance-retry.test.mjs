import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRuntimePerformanceAttemptPaths,
  classifyTransientPerformanceRetry,
  createGpuChannelFailureScanner,
  describeRecoveredPerformanceRetry,
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

test("CI package-script forwarding delimiter preserves the run-scoped output", () => {
  const argv = [
    "node",
    "performance-benchmark.mjs",
    "--retry-transient-once",
    "--output",
    ".artifacts/electron-runtime-performance/runtime-metrics.json",
    "--",
    "--output",
    ".artifacts/local-ci/runs/run-id/runtime-metrics.json",
  ];
  const parsed = parsePerformanceBenchmarkArguments(argv);

  assert.equal(parsed.retryTransientOnce, true);
  assert.equal(
    parsed.outputPath,
    new URL(
      "../.artifacts/local-ci/runs/run-id/runtime-metrics.json",
      import.meta.url,
    ).pathname,
  );
  assert.throws(
    () => parsePerformanceBenchmarkArguments([...argv, "--"]),
    /-- may only be specified once/,
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

// Observed on an AWS-hosted runner (ci.yml 43551562907, 2026-11-14): coldStart
// 4106.8 ms, first frame 4102.9 ms, two GPU channel failure lines.
const GPU_CHANNEL_FAILURE =
  "[3341:1114/041239.926553:ERROR:gpu/ipc/client/command_buffer_proxy_impl.cc:285] ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer.";

function buildColdStartMetrics({
  coldStartMs = 4_106.799999999988,
  firstFrameMs = 4_102.9,
  count = 2,
} = {}) {
  return {
    coldStartMs,
    coldStartFirstFrameMs: firstFrameMs,
    coldStartGpuChannelFailureCount: count,
  };
}

function buildColdStartEvaluation(extraFailedChecks = []) {
  return {
    ok: false,
    checks: [
      { name: "fixture.id", ok: true },
      { name: "coldStartMs", ok: false },
      { name: "projectOpenMs", ok: true },
      ...extraFailedChecks.map((name) => ({ name, ok: false })),
    ],
  };
}

test("a first-frame-bound cold start after a GPU channel failure is retryable", () => {
  const decision = classifyTransientPerformanceRetry(
    buildColdStartMetrics(),
    buildColdStartEvaluation(),
  );
  assert.deepEqual(decision, {
    eligible: true,
    reason: "coldstart-gpu-channel-first-frame",
    gpuChannelFailureCount: 2,
    coldStartMs: 4_106.799999999988,
    firstFrameMs: 4_102.9,
    firstFrameShare: 4_102.9 / 4_106.799999999988,
  });
  assert.equal(
    describeRecoveredPerformanceRetry(decision),
    "Recovered after one transient performance retry: coldStart 4106.799999999988ms with first frame at 4102.9ms after 2 GPU channel failure(s). Both attempt artifacts were retained.",
  );
});

test("cold starts without the GPU evidence, not bound by the first frame, or mixed are not retryable", () => {
  const cases = [
    [buildColdStartMetrics({ count: 0 }), buildColdStartEvaluation(), "coldstart-without-gpu-channel-failure"],
    [buildColdStartMetrics({ count: null }), buildColdStartEvaluation(), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ count: 1.5 }), buildColdStartEvaluation(), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ firstFrameMs: null }), buildColdStartEvaluation(), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ firstFrameMs: 4_200 }), buildColdStartEvaluation(), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ firstFrameMs: 1_093.5 }), buildColdStartEvaluation(), "coldstart-not-first-frame-bound"],
    [buildColdStartMetrics(), buildColdStartEvaluation(["projectOpenMs"]), "non-longtask-budget-failure"],
    [buildColdStartMetrics(), buildColdStartEvaluation(["memory.peakBytes"]), "non-longtask-budget-failure"],
  ];
  for (const [metrics, evaluation, reason] of cases) {
    const decision = classifyTransientPerformanceRetry(metrics, evaluation);
    assert.equal(decision.eligible, false, reason);
    assert.equal(decision.reason, reason);
  }
});

test("an eligible cold start retries once and cannot rescue a second failure", () => {
  const first = {
    status: 1,
    phase: "budget",
    metrics: buildColdStartMetrics(),
    evaluation: buildColdStartEvaluation(),
  };
  const attempts = [];
  const result = runRuntimePerformanceWithRetry({
    outputPath: "/tmp/runtime-metrics.json",
    retryTransientOnce: true,
    executeAttempt: (attempt) => {
      attempts.push(attempt.attempt);
      return first;
    },
    copyMetrics: () => {},
    onRecovered: () => assert.fail("a second failure is not a recovery"),
  });
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(result.status, 1);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.recovered, false);
  assert.equal(result.retryDecision.reason, "coldstart-gpu-channel-first-frame");
});

test("the Long Task recovery wording is unchanged", () => {
  assert.equal(
    describeRecoveredPerformanceRetry({
      reason: "single-unattributed-gesture-longtask",
      interaction: "chroniclePan",
      durationMs: 6_736,
      unattributedRatio: 6_735.8 / 6_736,
    }),
    "Recovered after one transient performance retry: chroniclePan 6736ms Long Task, 100.00% unattributed. Both attempt artifacts were retained.",
  );
});

test("the GPU channel scanner counts one signature across split and joined chunks", () => {
  const scanner = createGpuChannelFailureScanner();
  const line = `${GPU_CHANNEL_FAILURE}\n`;
  scanner.scan("stderr", line.slice(0, 60));
  assert.equal(scanner.count, 0, "a partial line is not counted yet");
  scanner.scan("stderr", line.slice(60) + line);
  assert.equal(scanner.count, 2, "a split line and a joined line");
  scanner.scan("stdout", line);
  assert.equal(scanner.count, 3, "stdout is scanned too");
  // A partial stdout line must not join a stderr chunk.
  scanner.scan("stdout", GPU_CHANNEL_FAILURE.slice(0, 40));
  scanner.scan("stderr", `${GPU_CHANNEL_FAILURE.slice(40)}\n`);
  assert.equal(scanner.count, 3);
  for (const healthy of [
    "[3248:1114/033303.278940:ERROR:gpu/command_buffer/service/context_group.cc:148] ContextResult::kFatalFailure: WebGL2 blocklisted",
    "[3729:1114/041341.962393:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.",
    "[grimodex-electron] renderer loaded: app://bundle/index.html",
  ]) {
    scanner.scan("stderr", `${healthy}\n`);
  }
  assert.equal(scanner.count, 3, "other GPU lines never qualify");
});
