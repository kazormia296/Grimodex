import assert from "node:assert/strict";
import test from "node:test";

import {
  COLD_START_GPU_RETRY_POLICY,
  buildRuntimePerformanceAttemptPaths,
  classifyTransientPerformanceRetry,
  createGpuChannelFailureScanner,
  describeRecoveredPerformanceRetry,
  describeStartedPerformanceRetry,
  TRANSIENT_PERFORMANCE_RETRY_POLICY,
  runRuntimePerformanceWithRetry,
} from "../electron/scripts/runtime-performance-retry.mjs";
import { DEFAULT_RUNTIME_BUDGETS } from "./runtime-performance-budget.mjs";
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

// Observed on an AWS-hosted runner (ci.yml 43551562907, 2026-11-14): bootstrap
// 280.5 ms, first frame 4102.9 ms, coldStart 4106.8 ms, two GPU channel failure
// lines received ~41 ms before the first frame. The healthy re-run on the same
// VM: bootstrap 274.2, first frame 277.3, ready 1290.1.
const GPU_CHANNEL_FAILURE =
  "[3341:1114/041239.926553:ERROR:gpu/ipc/client/command_buffer_proxy_impl.cc:285] ContextResult::kTransientFailure: Failed to send GpuControl.CreateCommandBuffer.";

function buildColdStartMetrics({
  coldStartMs = 4_106.799999999988,
  bootstrapMs = 280.5,
  firstFrameMs = 4_102.9,
  offsets = [-41.2, -41.1],
} = {}) {
  return {
    coldStartMs,
    coldStartBootstrapMs: bootstrapMs,
    coldStartFirstFrameMs: firstFrameMs,
    coldStartGpuChannelFailureOffsetsMs: offsets,
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

function coldStartFailure(metrics = buildColdStartMetrics()) {
  return {
    status: 1,
    phase: "budget",
    metrics,
    evaluation: buildColdStartEvaluation(),
  };
}

test("a cold start held at the first frame by a GPU channel failure is retryable (DR-PIS-8)", () => {
  const decision = classifyTransientPerformanceRetry(
    buildColdStartMetrics(),
    buildColdStartEvaluation(),
  );
  assert.deepEqual(decision, {
    eligible: true,
    reason: "coldstart-gpu-channel-first-frame",
    gpuChannelFailureCount: 2,
    coldStartMs: 4_106.799999999988,
    bootstrapMs: 280.5,
    firstFrameMs: 4_102.9,
    firstFrameShare: 4_102.9 / 4_106.799999999988,
  });
  assert.equal(
    describeRecoveredPerformanceRetry(decision),
    "Recovered after one transient performance retry: coldStart 4106.799999999988ms with first frame at 4102.9ms after 2 GPU channel failure(s). Both attempt artifacts were retained.",
  );
});

test("cold starts with a slow bootstrap, incomplete evidence, or mixed failures are not retryable", () => {
  const healthyRegression = 2_900; // a regression added to the healthy shape
  const cases = [
    [buildColdStartMetrics({ offsets: [Number.NaN] }), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ offsets: ["-41"] }), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ firstFrameMs: null }), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ firstFrameMs: 4_200 }), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ bootstrapMs: null }), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ bootstrapMs: 4_103 }), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ coldStartMs: null }), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ coldStartMs: 0 }), "coldstart-evidence-incomplete"],
    [buildColdStartMetrics({ coldStartMs: Number.NaN }), "coldstart-evidence-incomplete"],
    // A bundle/bootstrap regression delays bootstrap itself.
    [buildColdStartMetrics({ bootstrapMs: 3_000 }), "coldstart-not-first-frame-wait"],
    [buildColdStartMetrics({ bootstrapMs: 1_000.1 }), "coldstart-not-first-frame-wait"],
    [buildColdStartMetrics({ bootstrapMs: 2_200 }), "coldstart-not-first-frame-wait"],
    // A regression added to the healthy shape moves frame and ready together.
    [
      buildColdStartMetrics({
        bootstrapMs: 274.2 + healthyRegression,
        firstFrameMs: 277.3 + healthyRegression,
        coldStartMs: 1_290.1 + healthyRegression,
      }),
      "coldstart-not-first-frame-wait",
    ],
    [
      buildColdStartMetrics({
        firstFrameMs: 277.3 + healthyRegression,
        coldStartMs: 1_290.1 + healthyRegression,
      }),
      "coldstart-not-first-frame-bound",
    ],
  ];
  for (const [metrics, reason] of cases) {
    const decision = classifyTransientPerformanceRetry(
      metrics,
      buildColdStartEvaluation(),
    );
    assert.equal(decision.eligible, false, reason);
    assert.equal(decision.reason, reason, JSON.stringify(metrics));
  }
  for (const extra of [
    "projectOpenMs",
    "memory.peakBytes",
    "interactions.chroniclePan.gestureLongTaskMaxMs",
  ]) {
    const decision = classifyTransientPerformanceRetry(
      buildColdStartMetrics(),
      buildColdStartEvaluation([extra]),
    );
    assert.equal(decision.eligible, false, extra);
    assert.equal(decision.reason, "non-longtask-budget-failure", extra);
  }
});

// 2026-11-17 investigation (ci.yml, AWS-hosted runners; fusion-eval-data/
// ci-perf-2026-11-17.md): the failed attempt 1 values per job. Boot ~0.28 s,
// first frame 4.1-8.4 s, coldStart within 5 ms of the first frame, projectOpen
// within budget (except #921, see below), no GPU line near the first frame.
const OBSERVED_FIRST_FRAME_STALLS = [
  { coldStartMs: 8_366, firstFrameMs: 8_362 }, // 43871338713
  { coldStartMs: 6_270, firstFrameMs: 6_266 }, // 43874617679
  { coldStartMs: 7_026, firstFrameMs: 7_021 }, // 43898208278
  { coldStartMs: 5_247, firstFrameMs: 5_243 }, // 43615358091 (2026-11-14)
  { coldStartMs: 5_814, firstFrameMs: 5_810 }, // 43591421889 (2026-11-14)
  { coldStartMs: 6_793, firstFrameMs: 6_789 }, // 43589812705 (Azure)
  { coldStartMs: 4_107, firstFrameMs: 4_103 }, // 43551562907
];

test("an observed first-frame stall without a GPU line near the first frame is retryable (DR-PIS-9)", () => {
  for (const { coldStartMs, firstFrameMs } of OBSERVED_FIRST_FRAME_STALLS) {
    for (const offsets of [[], null, [-3_800], [-1_000.1, 500.1]]) {
      const metrics = buildColdStartMetrics({
        coldStartMs,
        firstFrameMs,
        bootstrapMs: 280,
        offsets,
      });
      const decision = classifyTransientPerformanceRetry(
        metrics,
        buildColdStartEvaluation(),
      );
      assert.equal(decision.eligible, true, JSON.stringify(metrics));
      assert.equal(decision.reason, "coldstart-first-frame-stall");
      assert.equal(decision.gpuChannelFailureCount, 0);
      assert.equal(decision.coldStartMs, coldStartMs);
      assert.equal(decision.bootstrapMs, 280);
      assert.equal(decision.firstFrameMs, firstFrameMs);
    }
  }
  const decision = classifyTransientPerformanceRetry(
    buildColdStartMetrics({
      coldStartMs: 8_366,
      firstFrameMs: 8_362,
      bootstrapMs: 280,
      offsets: [],
    }),
    buildColdStartEvaluation(),
  );
  assert.equal(
    describeRecoveredPerformanceRetry(decision),
    "Recovered after one transient performance retry: coldStart 8366ms with first frame at 8362ms and bootstrap 280ms (first-frame stall). Both attempt artifacts were retained.",
  );
  assert.equal(
    describeStartedPerformanceRetry(decision),
    "Retrying once (coldstart-first-frame-stall): first attempt coldStart 8366ms, bootstrap 280ms, first frame 8362ms (share 99.95%), 0 GPU channel failure(s) near the first frame.",
  );
});

test("a GPU line near the first frame keeps its own reason; the first attempt values are logged", () => {
  const decision = classifyTransientPerformanceRetry(
    buildColdStartMetrics(),
    buildColdStartEvaluation(),
  );
  assert.equal(decision.reason, "coldstart-gpu-channel-first-frame");
  assert.match(
    describeStartedPerformanceRetry(decision),
    /first attempt coldStart 4106\.8ms, bootstrap 280\.5ms, first frame 4102\.9ms .* 2 GPU channel failure\(s\)/u,
  );
});

test("a slow start in another segment is not retried even when the first frame dominates (DR-PIS-9)", () => {
  const cases = [
    // Slow bootstrap (bundle/bootstrap regression): the line is 1,000 ms.
    [buildColdStartMetrics({ bootstrapMs: 1_000.1, firstFrameMs: 7_000, coldStartMs: 7_004, offsets: [] }), "coldstart-not-first-frame-wait"],
    // A slow tail after the first frame (the first frame is under 90%).
    [buildColdStartMetrics({ bootstrapMs: 280, firstFrameMs: 3_000, coldStartMs: 4_500, offsets: [] }), "coldstart-not-first-frame-bound"],
    // A mild first-frame delay below the 2,000 ms wait line.
    [buildColdStartMetrics({ bootstrapMs: 900, firstFrameMs: 2_800, coldStartMs: 4_100, offsets: [] }), "coldstart-not-first-frame-wait"],
  ];
  for (const [metrics, reason] of cases) {
    const decision = classifyTransientPerformanceRetry(
      metrics,
      buildColdStartEvaluation(),
    );
    assert.equal(decision.eligible, false, reason);
    assert.equal(decision.reason, reason);
  }
  // ci.yml 43889839188 (#921): projectOpenMs failed with coldStartMs, so the
  // rest of the start was not normal.
  for (const extra of ["projectOpenMs", "frameP95Ms"]) {
    const decision = classifyTransientPerformanceRetry(
      buildColdStartMetrics({ coldStartMs: 7_167, firstFrameMs: 7_163, bootstrapMs: 280, offsets: [] }),
      buildColdStartEvaluation([extra]),
    );
    assert.equal(decision.eligible, false, extra);
    assert.equal(decision.reason, "non-longtask-budget-failure");
  }
});

test("a cold start stall retries at most once in total and judges the second sample against the same budget (DR-PIS-9)", () => {
  assert.equal(TRANSIENT_PERFORMANCE_RETRY_POLICY.maximumRetries, 1);
  assert.deepEqual(COLD_START_GPU_RETRY_POLICY, {
    minimumFirstFrameShare: 0.9,
    maximumBootstrapMs: 1_000,
    minimumBootstrapToFirstFrameMs: 2_000,
    gpuFailureWindowBeforeFirstFrameMs: 1_000,
    gpuFailureWindowAfterFirstFrameMs: 500,
  });
  assert.equal(DEFAULT_RUNTIME_BUDGETS.coldStartMs, 4_000);
  const stall = buildColdStartMetrics({
    coldStartMs: 7_026,
    firstFrameMs: 7_021,
    bootstrapMs: 280,
    offsets: [],
  });
  const attempts = [];
  const started = [];
  const result = runRuntimePerformanceWithRetry({
    outputPath: "/tmp/runtime-metrics.json",
    retryTransientOnce: true,
    executeAttempt: ({ attempt }) => {
      attempts.push(attempt);
      return coldStartFailure(stall);
    },
    copyMetrics: () => {},
    onRetry: (decision) => started.push(decision.reason),
    onRecovered: () => assert.fail("a second failure is not a recovery"),
  });
  assert.deepEqual(attempts, [1, 2]);
  assert.deepEqual(started, ["coldstart-first-frame-stall"]);
  assert.equal(result.status, 1);
  assert.equal(result.attemptCount, 2);
  assert.equal(result.recovered, false);

  // The first sample is kept next to the second, and a recovery is reported.
  const copies = [];
  const recovered = [];
  const ok = runRuntimePerformanceWithRetry({
    outputPath: "/tmp/runtime-metrics.json",
    retryTransientOnce: true,
    executeAttempt: ({ attempt }) =>
      attempt === 1 ? coldStartFailure(stall) : passingAttempt,
    copyMetrics: (from, to) => copies.push([from, to]),
    onRecovered: (decision) => recovered.push(decision.reason),
  });
  assert.equal(ok.recovered, true);
  assert.deepEqual(recovered, ["coldstart-first-frame-stall"]);
  assert.equal(copies.length, 2);
});

test("the cold start thresholds are inclusive at their edges", () => {
  const atShare = classifyTransientPerformanceRetry(
    buildColdStartMetrics({ coldStartMs: 4_100, firstFrameMs: 3_690 }),
    buildColdStartEvaluation(),
  );
  assert.equal(atShare.eligible, true, "share 0.9");
  const belowShare = classifyTransientPerformanceRetry(
    buildColdStartMetrics({ coldStartMs: 4_100, firstFrameMs: 3_689.9 }),
    buildColdStartEvaluation(),
  );
  assert.equal(belowShare.reason, "coldstart-not-first-frame-bound");
  for (const offsets of [[-1_000], [500]]) {
    assert.equal(
      classifyTransientPerformanceRetry(
        buildColdStartMetrics({ offsets }),
        buildColdStartEvaluation(),
      ).eligible,
      true,
      `offset ${offsets[0]}`,
    );
  }
  assert.equal(
    classifyTransientPerformanceRetry(
      buildColdStartMetrics({ bootstrapMs: 1_000, firstFrameMs: 3_700, coldStartMs: 4_100 }),
      buildColdStartEvaluation(),
    ).eligible,
    true,
    "bootstrap 1000 and 2700 ms to the first frame",
  );
});

test("accepted residual risk (DR-PIS-8): a main-thread stall right before the first frame that coincides with the GPU line is retried", () => {
  // The classifier cannot tell this from the GPU wait; the second sample is
  // still judged against the same 4,000 ms budget.
  const decision = classifyTransientPerformanceRetry(
    buildColdStartMetrics({ firstFrameMs: 3_800, coldStartMs: 4_100, offsets: [-30] }),
    buildColdStartEvaluation(),
  );
  assert.equal(decision.eligible, true);
});

test("an eligible cold start retries once, keeps both samples, and reports the recovery", () => {
  const attempts = [];
  const copies = [];
  const recovered = [];
  const result = runRuntimePerformanceWithRetry({
    outputPath: "/tmp/runtime-metrics.json",
    retryTransientOnce: true,
    executeAttempt: (attempt) => {
      attempts.push(attempt.attempt);
      return attempt.attempt === 1 ? coldStartFailure() : passingAttempt;
    },
    copyMetrics: (from, to) => copies.push([from, to]),
    onRecovered: (decision) => recovered.push(decision.reason),
  });
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(result.status, 0);
  assert.equal(result.recovered, true);
  assert.deepEqual(recovered, ["coldstart-gpu-channel-first-frame"]);
  assert.equal(copies.length, 2);
});

test("an eligible cold start cannot rescue a second failure and needs the explicit budget retry path", () => {
  const attempts = [];
  const result = runRuntimePerformanceWithRetry({
    outputPath: "/tmp/runtime-metrics.json",
    retryTransientOnce: true,
    executeAttempt: (attempt) => {
      attempts.push(attempt.attempt);
      return coldStartFailure();
    },
    copyMetrics: () => {},
    onRecovered: () => assert.fail("a second failure is not a recovery"),
  });
  assert.deepEqual(attempts, [1, 2]);
  assert.equal(result.status, 1);
  assert.equal(result.recovered, false);
  assert.equal(result.retryDecision.reason, "coldstart-gpu-channel-first-frame");

  for (const [retryTransientOnce, phase] of [
    [false, "budget"],
    [true, "measurement"],
  ]) {
    let calls = 0;
    const noRetry = runRuntimePerformanceWithRetry({
      outputPath: "/tmp/runtime-metrics.json",
      retryTransientOnce,
      executeAttempt: () => {
        calls += 1;
        return { ...coldStartFailure(), phase };
      },
      copyMetrics: () => assert.fail("no retry"),
      onRecovered: () => assert.fail("no retry"),
    });
    assert.equal(calls, 1, `${retryTransientOnce} ${phase}`);
    assert.equal(noRetry.attemptCount, 1);
  }
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

test("the GPU channel scanner times one signature across split, joined, and Buffer chunks", () => {
  let clock = 1_000;
  const scanner = createGpuChannelFailureScanner({ now: () => clock });
  const line = `${GPU_CHANNEL_FAILURE}\n`;
  scanner.scan("stderr", line.slice(0, 60));
  assert.deepEqual(scanner.offsetsFrom(0), [], "a partial line is not recorded yet");
  clock = 1_010;
  scanner.scan("stderr", line.slice(60) + line);
  clock = 1_020;
  scanner.scan("stdout", Buffer.from(`${GPU_CHANNEL_FAILURE}\r\n`));
  // A partial stdout line must not join a stderr chunk.
  scanner.scan("stdout", GPU_CHANNEL_FAILURE.slice(0, 40));
  scanner.scan("stderr", `${GPU_CHANNEL_FAILURE.slice(40)}\n`);
  for (const healthy of [
    "[3248:1114/033303.278940:ERROR:gpu/command_buffer/service/context_group.cc:148] ContextResult::kFatalFailure: WebGL2 blocklisted",
    "[3729:1114/041341.962393:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:395] SharedImageManager::ProduceMemory: Trying to Produce a Memory representation from a non-existent mailbox.",
    "[grimodex-electron] renderer loaded: app://bundle/index.html",
  ]) {
    scanner.scan("stderr", `${healthy}\n`);
  }
  assert.deepEqual(scanner.offsetsFrom(1_050), [-40, -40, -30]);
  assert.equal(scanner.offsetsFrom(null), null, "unknown first frame");
});

test("smoke wires the GPU channel evidence into the measured cold start read", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../electron/scripts/smoke.mjs", import.meta.url),
    "utf8",
  );
  const launch = source.slice(
    source.indexOf("async function launchApp("),
    source.indexOf("const page = await app.firstWindow(", source.indexOf("async function launchApp(")),
  );
  assert.match(launch, /const gpuChannelFailures = createGpuChannelFailureScanner\(\);/);
  assert.match(launch, /runtimeContext\.launchGpuChannelFailures = gpuChannelFailures;/);
  assert.match(launch, /gpuChannelFailures\.scan\("stdout", d\);/);
  assert.match(launch, /gpuChannelFailures\.scan\("stderr", d\);/);
  const coldStart = source.indexOf("performanceMetrics.coldStartMs = editorReadyTiming.startTime;");
  const read = source.lastIndexOf("const editorReadyHandle = await page.waitForFunction(", coldStart);
  const readBlock = source.slice(read, coldStart);
  assert.match(readBlock, /grimodex:renderer-bootstrap/);
  assert.match(readBlock, /grimodex:renderer-first-frame/);
  assert.match(readBlock, /timeOrigin: performance\.timeOrigin/);
  const evidence = source.indexOf("performanceMetrics.openEvidence = await collectRuntimeOpenEvidence(");
  for (const assignment of [
    "performanceMetrics.coldStartBootstrapMs =",
    "performanceMetrics.coldStartFirstFrameMs =",
    "performanceMetrics.coldStartGpuChannelFailureOffsetsMs =",
  ]) {
    const at = source.indexOf(assignment);
    assert.ok(at > coldStart && at < evidence, assignment);
  }
});
