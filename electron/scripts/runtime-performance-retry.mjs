import path from "node:path";

const RETRYABLE_GESTURE_INTERACTIONS = Object.freeze([
  "timelineDrag",
  "chroniclePan",
]);

export const TRANSIENT_PERFORMANCE_RETRY_POLICY = Object.freeze({
  maximumRetries: 1,
  minimumUnattributedRatio: 0.95,
});

function rejected(reason) {
  return Object.freeze({ eligible: false, reason });
}

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
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
