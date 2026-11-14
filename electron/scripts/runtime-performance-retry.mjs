import path from "node:path";

const RETRYABLE_GESTURE_INTERACTIONS = Object.freeze([
  "timelineDrag",
  "chroniclePan",
]);

export const TRANSIENT_PERFORMANCE_RETRY_POLICY = Object.freeze({
  maximumRetries: 1,
  minimumUnattributedRatio: 0.95,
});

/**
 * Cold start retry (2026-11-14 user decision): some GitHub-hosted runners
 * (AWS) lose the GPU process channel while the first frame is pending. The
 * renderer then waits ~2.8 s for a new channel, and the first-frame and
 * editor-ready marks land near 4.1 s instead of ~1.1 s. The 4,000 ms budget
 * is unchanged; only a cold start whose time is the first-frame wait and that
 * coincides with this exact Chromium signature may be sampled once more.
 */
export const COLD_START_GPU_RETRY_POLICY = Object.freeze({
  minimumFirstFrameShare: 0.9,
});

// One signature only. "WebGL2 blocklisted" (kFatalFailure) and SharedImageManager
// lines appear on healthy runs too and must never qualify.
const GPU_CHANNEL_FAILURE_LINE =
  /gpu\/ipc\/client\/command_buffer_proxy_impl\.cc:\d+\] ContextResult::kTransientFailure: Failed to send GpuControl\.CreateCommandBuffer\./u;
const MAX_PENDING_LINE_CHARS = 16_384;

/**
 * Count GPU channel failure lines in one Electron launch's stdout/stderr.
 * Chunks may split or join lines, so each stream keeps its partial line.
 */
export function createGpuChannelFailureScanner() {
  const pending = new Map();
  let count = 0;
  return Object.freeze({
    scan(stream, chunk) {
      const lines = `${pending.get(stream) ?? ""}${String(chunk)}`.split("\n");
      const rest = lines.pop();
      pending.set(stream, rest.slice(-MAX_PENDING_LINE_CHARS));
      for (const line of lines) {
        if (GPU_CHANNEL_FAILURE_LINE.test(line)) count += 1;
      }
    },
    get count() {
      return count;
    },
  });
}

function rejected(reason) {
  return Object.freeze({ eligible: false, reason });
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function classifyColdStartGpuChannelRetry(metrics, failedChecks) {
  if (!failedChecks.every((check) => check.name === "coldStartMs")) return null;
  // Measured values only (captured with coldStartMs in the same renderer
  // read); the informational open evidence never gates.
  const count = metrics.coldStartGpuChannelFailureCount;
  const coldStartMs = metrics.coldStartMs;
  const firstFrameMs = metrics.coldStartFirstFrameMs;
  if (
    !Number.isInteger(count) ||
    count < 0 ||
    !finite(coldStartMs) ||
    coldStartMs <= 0 ||
    !finite(firstFrameMs) ||
    firstFrameMs < 0 ||
    firstFrameMs > coldStartMs
  ) {
    return rejected("coldstart-evidence-incomplete");
  }
  if (count === 0) return rejected("coldstart-without-gpu-channel-failure");
  const firstFrameShare = firstFrameMs / coldStartMs;
  if (firstFrameShare < COLD_START_GPU_RETRY_POLICY.minimumFirstFrameShare) {
    return rejected("coldstart-not-first-frame-bound");
  }
  return Object.freeze({
    eligible: true,
    reason: "coldstart-gpu-channel-first-frame",
    gpuChannelFailureCount: count,
    coldStartMs,
    firstFrameMs,
    firstFrameShare,
  });
}

/** The recovery warning for a retry decision (wording per reason). */
export function describeRecoveredPerformanceRetry(decision) {
  if (decision.reason === "coldstart-gpu-channel-first-frame") {
    return (
      `Recovered after one transient performance retry: ` +
      `coldStart ${decision.coldStartMs}ms with first frame at ${decision.firstFrameMs}ms ` +
      `after ${decision.gpuChannelFailureCount} GPU channel failure(s). ` +
      `Both attempt artifacts were retained.`
    );
  }
  return (
    `Recovered after one transient performance retry: ` +
    `${decision.interaction} ${decision.durationMs}ms Long Task, ` +
    `${(decision.unattributedRatio * 100).toFixed(2)}% unattributed. ` +
    `Both attempt artifacts were retained.`
  );
}

/**
 * Allow one retry only for a single gesture Long Task whose wall time is
 * overwhelmingly outside Grimodex's instrumented work. Every functional,
 * cardinality, frame, memory, and non-gesture budget must already pass.
 */
export function classifyTransientPerformanceRetry(metrics, evaluation) {
  if (!metrics || !evaluation || !Array.isArray(evaluation.checks)) {
    return rejected("performance-evidence-missing");
  }
  if (evaluation.ok) return rejected("performance-budget-passed");

  const failedChecks = evaluation.checks.filter((check) => !check.ok);
  if (failedChecks.length === 0) {
    return rejected("performance-failure-unclassified");
  }

  const coldStart = classifyColdStartGpuChannelRetry(metrics, failedChecks);
  if (coldStart) return coldStart;

  const interaction = RETRYABLE_GESTURE_INTERACTIONS.find((candidate) => {
    const prefix = `interactions.${candidate}`;
    const allowed = new Set([
      `${prefix}.gestureLongTaskCount`,
      `${prefix}.gestureLongTaskMaxMs`,
    ]);
    return failedChecks.every((check) => allowed.has(check.name));
  });
  if (!interaction) return rejected("non-longtask-budget-failure");

  const gesture = metrics.interactions?.[interaction];
  if (gesture?.gestureLongTaskCount !== 1) {
    return rejected("longtask-count-not-single");
  }

  const entries = gesture.gestureLongTaskEntries;
  const entry =
    Array.isArray(entries) && entries.length === 1 ? entries[0] : null;
  if (
    !entry ||
    !finite(entry.duration) ||
    entry.duration <= 0 ||
    !finite(entry.unattributedMs) ||
    entry.unattributedMs < 0 ||
    entry.unattributedMs > entry.duration ||
    !Array.isArray(entry.overlappingMarks) ||
    !finite(gesture.gestureLongTaskMaxMs) ||
    Math.abs(gesture.gestureLongTaskMaxMs - entry.duration) > 0.001
  ) {
    return rejected("longtask-evidence-incomplete");
  }

  const unattributedRatio = entry.unattributedMs / entry.duration;
  if (
    unattributedRatio <
    TRANSIENT_PERFORMANCE_RETRY_POLICY.minimumUnattributedRatio
  ) {
    return rejected("longtask-attribution-too-high");
  }

  return Object.freeze({
    eligible: true,
    reason: "single-unattributed-gesture-longtask",
    interaction,
    durationMs: entry.duration,
    unattributedMs: entry.unattributedMs,
    unattributedRatio,
  });
}

export function buildRuntimePerformanceAttemptPaths(outputPath) {
  const canonical = path.resolve(outputPath);
  const parsed = path.parse(canonical);
  const evidencePath = (attempt) =>
    path.join(parsed.dir, `${parsed.name}-attempt-${attempt}${parsed.ext}`);
  return Object.freeze({
    canonical,
    firstEvidence: evidencePath(1),
    secondEvidence: evidencePath(2),
  });
}

/**
 * Run the canonical sample and, when its structured evidence qualifies,
 * exactly one fresh-process sample. The caller owns process execution and
 * file copying so this policy remains deterministic and directly testable.
 */
export function runRuntimePerformanceWithRetry({
  outputPath,
  retryTransientOnce,
  executeAttempt,
  copyMetrics,
  onRecovered,
}) {
  const paths = buildRuntimePerformanceAttemptPaths(outputPath);
  const first = executeAttempt({ attempt: 1, metricsPath: paths.canonical });
  if (first.status === 0) {
    return Object.freeze({
      status: 0,
      attemptCount: 1,
      recovered: false,
      retryDecision: null,
    });
  }

  if (
    !retryTransientOnce ||
    first.phase !== "budget" ||
    !first.metrics ||
    !first.evaluation
  ) {
    return Object.freeze({
      status: first.status,
      attemptCount: 1,
      recovered: false,
      retryDecision: null,
    });
  }

  const retryDecision = classifyTransientPerformanceRetry(
    first.metrics,
    first.evaluation,
  );
  if (!retryDecision.eligible) {
    return Object.freeze({
      status: first.status,
      attemptCount: 1,
      recovered: false,
      retryDecision,
    });
  }

  copyMetrics(paths.canonical, paths.firstEvidence);
  const second = executeAttempt({
    attempt: 2,
    metricsPath: paths.secondEvidence,
  });
  if (second.metrics) {
    copyMetrics(paths.secondEvidence, paths.canonical);
  }

  const recovered = second.status === 0;
  if (recovered) onRecovered(retryDecision);
  return Object.freeze({
    status: second.status,
    attemptCount: 2,
    recovered,
    retryDecision,
  });
}
