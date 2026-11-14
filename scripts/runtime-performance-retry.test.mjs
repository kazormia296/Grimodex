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

test("cold starts without time-bound GPU evidence, with a slow bootstrap, or mixed failures are not retryable", () => {
  const healthyRegression = 2_900; // a regression added to the healthy shape
  const cases = [
    [buildColdStartMetrics({ offsets: [] }), "coldstart-without-gpu-channel-failure"],
    // The same line also appears harmlessly right after launch.
    [buildColdStartMetrics({ offsets: [-3_800] }), "coldstart-gpu-channel-failure-not-near-first-frame"],
    [buildColdStartMetrics({ offsets: [-1_000.1, 500.1] }), "coldstart-gpu-channel-failure-not-near-first-frame"],
    [buildColdStartMetrics({ offsets: null }), "coldstart-evidence-incomplete"],
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
