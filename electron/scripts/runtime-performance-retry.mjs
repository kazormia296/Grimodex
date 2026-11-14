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
 * Cold start retry (DR-PIS-8, 2026-11-14 user decision; supersedes DR-PIS-5).
 * Some GitHub-hosted runners (AWS) lose the GPU process channel while the
 * first frame is pending: bootstrap stays at ~0.28 s, but the first frame and
 * editor-ready wait ~2.8 s more (frame ~4.1 s / ready ~4.1 s instead of
 * ~0.28 s / ~1.29 s). The 4,000 ms budget is unchanged. A cold start may be
 * sampled once more only when all of these hold (measured values captured
 * with coldStartMs; the informational open evidence never gates):
 * - coldStartMs is the only failed check;
 * - bootstrap is normal and the time is the wait between bootstrap and the
 *   first frame (excludes bundle/bootstrap regressions);
 * - the first frame is most of the cold start;
 * - this exact Chromium GPU channel failure was received near the first frame
 *   (the same line can appear harmlessly right after launch).
 * A regression that only sometimes crosses the budget can still pass on the
 * second sample (DR-PIS-5 (4)); that residual risk is accepted in DR-PIS-8.
 */
export const COLD_START_GPU_RETRY_POLICY = Object.freeze({
  minimumFirstFrameShare: 0.9,
  maximumBootstrapMs: 1_000,
  minimumBootstrapToFirstFrameMs: 2_000,
  // GPU failure line receipt relative to the first frame (wall clock).
  gpuFailureWindowBeforeFirstFrameMs: 1_000,
  gpuFailureWindowAfterFirstFrameMs: 500,
});

// One signature only. "WebGL2 blocklisted" (kFatalFailure) and SharedImageManager
// lines appear on healthy runs too and must never qualify.
const GPU_CHANNEL_FAILURE_LINE =
  /gpu\/ipc\/client\/command_buffer_proxy_impl\.cc:\d+\] ContextResult::kTransientFailure: Failed to send GpuControl\.CreateCommandBuffer\./u;
const MAX_PENDING_LINE_CHARS = 16_384;
const MAX_RECORDED_FAILURES = 64;

/**
 * Record when GPU channel failure lines arrive in one Electron launch's
 * stdout/stderr (wall clock, ms). Chunks may split or join lines, so each
 * stream keeps its own partial line.
 */
export function createGpuChannelFailureScanner({ now = () => Date.now() } = {}) {
  const pending = new Map();
  const receivedAt = [];
  return Object.freeze({
    scan(stream, chunk) {
      const lines = `${pending.get(stream) ?? ""}${String(chunk)}`.split("\n");
      const rest = lines.pop();
      pending.set(stream, rest.slice(-MAX_PENDING_LINE_CHARS));
      for (const line of lines) {
        if (
          GPU_CHANNEL_FAILURE_LINE.test(line) &&
          receivedAt.length < MAX_RECORDED_FAILURES
        ) {
          receivedAt.push(now());
        }
      }
    },
    /** Receipt times relative to `firstFrameWallMs` (null when unknown). */
    offsetsFrom(firstFrameWallMs) {
      if (!finite(firstFrameWallMs)) return null;
      return receivedAt.map((at) => at - firstFrameWallMs);
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
  const policy = COLD_START_GPU_RETRY_POLICY;
  const coldStartMs = metrics.coldStartMs;
  const bootstrapMs = metrics.coldStartBootstrapMs;
  const firstFrameMs = metrics.coldStartFirstFrameMs;
  const offsets = metrics.coldStartGpuChannelFailureOffsetsMs;
  if (
    !finite(coldStartMs) ||
    coldStartMs <= 0 ||
    !finite(bootstrapMs) ||
    bootstrapMs < 0 ||
    !finite(firstFrameMs) ||
    firstFrameMs < bootstrapMs ||
    firstFrameMs > coldStartMs ||
    !Array.isArray(offsets) ||
    !offsets.every(finite)
  ) {
    return rejected("coldstart-evidence-incomplete");
  }
  if (
    bootstrapMs > policy.maximumBootstrapMs ||
    firstFrameMs - bootstrapMs < policy.minimumBootstrapToFirstFrameMs
  ) {
    return rejected("coldstart-not-first-frame-wait");
  }
  const firstFrameShare = firstFrameMs / coldStartMs;
  if (firstFrameShare < policy.minimumFirstFrameShare) {
    return rejected("coldstart-not-first-frame-bound");
  }
  const nearFirstFrame = offsets.filter(
    (offset) =>
      offset >= -policy.gpuFailureWindowBeforeFirstFrameMs &&
      offset <= policy.gpuFailureWindowAfterFirstFrameMs,
  );
  if (nearFirstFrame.length === 0) {
    return rejected(
      offsets.length === 0
        ? "coldstart-without-gpu-channel-failure"
        : "coldstart-gpu-channel-failure-not-near-first-frame",
    );
  }
  return Object.freeze({
    eligible: true,
    reason: "coldstart-gpu-channel-first-frame",
    gpuChannelFailureCount: nearFirstFrame.length,
    coldStartMs,
    bootstrapMs,
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
 * Allow one retry only for (a) a single gesture Long Task whose wall time is
 * overwhelmingly outside Grimodex's instrumented work, with every functional,
 * cardinality, frame, memory, and non-gesture budget already passing, or
 * (b) a cold start delayed by a GPU channel failure before the first frame
 * (DR-PIS-8, see COLD_START_GPU_RETRY_POLICY).
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
