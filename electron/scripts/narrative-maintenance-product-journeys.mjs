import { once } from "node:events";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

import { NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG } from "./product-journey-catalog.mjs";

const execFile = promisify(execFileCallback);

/**
 * C2-5B product acceptance journeys.
 *
 * These are intentionally separate from the already-green editor/chat
 * journeys.  Every assertion below reads the live workspace through the
 * product journey harness and observes the durable Run/epoch/feed tables.  No
 * maintenance IPC is invoked from the renderer: the expected owner is the
 * main/N-API scheduler.  On the C2-5A base these journeys are expected to be
 * red because the production trigger owners and adapters are not wired yet.
 */

export const NARRATIVE_MAINTENANCE_WAIT_MS = 5_000;
export const NARRATIVE_MAINTENANCE_FAULT_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_FAULT";
export const NARRATIVE_MAINTENANCE_TRIGGER_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_TRIGGER";
export const NARRATIVE_MAINTENANCE_SETUP_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_SETUP";
export const NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN";
export const NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID";
export const NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV =
  "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_CORRELATION";
export const NARRATIVE_MAINTENANCE_OWNER_TOKEN =
  "c2-5b-product-journey-owner-v1";
export const NARRATIVE_MAINTENANCE_TRANSIENT_CODE =
  "NEX_MAINTENANCE_TRANSIENT";
export const NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE =
  "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION";
export const NARRATIVE_MAINTENANCE_INTERRUPTED_CODE =
  "NEX_MAINTENANCE_INTERRUPTED";
export const NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS = 1_250;
const RESTORE_FIXTURE_CONSUMER_KIND = "narrative-extraction-run";
const RESTORE_FIXTURE_SPEC_DIGEST = "sha256:c2-5b-restore-fixture-v1";
const RESTORE_AUTOMATIC_PHASE_RUN_KINDS = new Set([
  "backfill",
  "dependency-verify",
  "semantic-index-rebuild",
  "dependency-repair",
]);
export const NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER = "workspace-opened";
export const NARRATIVE_MAINTENANCE_FOREGROUND_SYSTEM_WORK_MARKER = Object.freeze(
  [
    "trigger",
    "canonicalWorkKey",
    "authorityId",
    "generation",
    "productJourneyBarrierId",
    "correlation",
  ],
);
export const NARRATIVE_MAINTENANCE_FAULTS = Object.freeze([
  "transient-io",
  "contract-violation",
  "process-interruption",
]);
export const NARRATIVE_MAINTENANCE_TRIGGERS = Object.freeze([
  "dependency-gap",
  "foreground-workspace-wake",
  "graphContractDigest-changed",
  "ruleRegistryDigest-changed",
  "producerGenerationSetDigest-changed",
]);
export const NARRATIVE_MAINTENANCE_SEAM_CONTRACT = Object.freeze({
  ownerTokenEnv: NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  productJourneyBarrierEnv: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
  productJourneyCorrelationEnv:
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
  foregroundMarker: Object.freeze({
    trigger: NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER,
    fields: NARRATIVE_MAINTENANCE_FOREGROUND_SYSTEM_WORK_MARKER,
  }),
  setupEnv: NARRATIVE_MAINTENANCE_SETUP_ENV,
  setupDisabledValue: "disabled",
  faultEnv: NARRATIVE_MAINTENANCE_FAULT_ENV,
  triggerEnv: NARRATIVE_MAINTENANCE_TRIGGER_ENV,
  packagedPolicy:
    "packaged launches and non-CI launches must ignore fault/trigger/setup seams; only an unpackaged CI product-journey launch with the exact owner token may consume them",
  ciEnv: "CI",
  ciValue: "true",
  jsDigestAuthority: "durable native outcome skipEvidence fields",
});
export const NARRATIVE_MAINTENANCE_JOURNEY_IDS = Object.freeze(
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
);
export const NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES = Object.freeze([
  "c2-5b-schema-backfill-verify/open",
  "c2-5b-restore-verify-rebuild-verify/restore-fixture",
  "c2-5b-restore-verify-rebuild-verify/open",
  "c2-5b-graph-digest-no-skip/baseline",
  "c2-5b-graph-digest-no-skip/changed",
  "c2-5b-rule-digest-no-skip/baseline",
  "c2-5b-rule-digest-no-skip/changed",
  "c2-5b-producer-generation-no-skip/baseline",
  "c2-5b-producer-generation-no-skip/changed",
  "c2-5b-transient-bounded-retry/open",
  "c2-5b-terminal-failure-inbox/open",
  "c2-5b-terminal-failure-inbox/reopened",
  "c2-5b-interrupted-run-recovery/interrupted",
  "c2-5b-interrupted-run-recovery/recovered",
  "c2-5b-no-automatic-repair/restore-fixture",
  "c2-5b-no-automatic-repair/open",
  "c2-5b-foreground-write-workspace-wake/settle-primary",
  "c2-5b-foreground-write-workspace-wake/authoring",
  "c2-5b-incremental-liveness/before-restart",
  "c2-5b-incremental-liveness/after-restart",
]);

const RUN_COLUMNS = `
  id,
  project_id AS projectId,
  run_kind AS runKind,
  work_key AS workKey,
  status,
  semantic_epoch_id AS semanticEpochId,
  consumer_id AS consumerId,
  created_at AS createdAt,
  started_at AS startedAt,
  completed_at AS completedAt,
  spec_json AS specJson,
  terminal_reason_code AS terminalReasonCode,
  outcome_summary_json AS outcomeSummaryJson,
  spec_digest AS specDigest,
  catalog_digest AS catalogDigest,
  registry_digest AS registryDigest,
  (SELECT COUNT(*)
     FROM narrative_extraction_attempts a
     JOIN narrative_extraction_tasks t ON t.id = a.task_id
    WHERE t.run_id = r.id) AS attemptCount,
  (SELECT COUNT(*)
     FROM narrative_extraction_tasks t
    WHERE t.run_id = r.id) AS taskCount,
  (SELECT t.status
     FROM narrative_extraction_tasks t
    WHERE t.run_id = r.id
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 1) AS taskStatus,
  (SELECT t.task_kind
     FROM narrative_extraction_tasks t
    WHERE t.run_id = r.id
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 1) AS taskKind,
  (SELECT t.attempt_count
     FROM narrative_extraction_tasks t
    WHERE t.run_id = r.id
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 1) AS taskAttemptCount,
  (SELECT t.input_json
     FROM narrative_extraction_tasks t
    WHERE t.run_id = r.id
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 1) AS taskInputJson,
  (SELECT t.created_at
     FROM narrative_extraction_tasks t
    WHERE t.run_id = r.id
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 1) AS taskCreatedAt,
  (SELECT t.started_at
     FROM narrative_extraction_tasks t
    WHERE t.run_id = r.id
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 1) AS taskStartedAt,
  (SELECT t.completed_at
     FROM narrative_extraction_tasks t
    WHERE t.run_id = r.id
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 1) AS taskCompletedAt,
  (SELECT MAX(a.attempt_number)
     FROM narrative_extraction_attempts a
     JOIN narrative_extraction_tasks t ON t.id = a.task_id
    WHERE t.run_id = r.id) AS maxAttemptNumber,
  (SELECT a.attempt_number
     FROM narrative_extraction_attempts a
     JOIN narrative_extraction_tasks t ON t.id = a.task_id
    WHERE t.run_id = r.id
    ORDER BY a.attempt_number DESC, a.started_at DESC, a.id DESC
    LIMIT 1) AS lastAttemptNumber,
  (SELECT a.started_at
     FROM narrative_extraction_attempts a
     JOIN narrative_extraction_tasks t ON t.id = a.task_id
    WHERE t.run_id = r.id
    ORDER BY a.attempt_number DESC, a.started_at DESC, a.id DESC
    LIMIT 1) AS lastAttemptStartedAt,
  (SELECT a.status
     FROM narrative_extraction_attempts a
     JOIN narrative_extraction_tasks t ON t.id = a.task_id
    WHERE t.run_id = r.id
    ORDER BY a.attempt_number DESC, a.started_at DESC, a.id DESC
    LIMIT 1) AS lastAttemptStatus,
  (SELECT a.failure_code
     FROM narrative_extraction_attempts a
     JOIN narrative_extraction_tasks t ON t.id = a.task_id
    WHERE t.run_id = r.id
    ORDER BY a.attempt_number DESC, a.started_at DESC, a.id DESC
    LIMIT 1) AS lastAttemptFailureCode,
  (SELECT a.completed_at
     FROM narrative_extraction_attempts a
     JOIN narrative_extraction_tasks t ON t.id = a.task_id
    WHERE t.run_id = r.id
    ORDER BY a.attempt_number DESC, a.started_at DESC, a.id DESC
    LIMIT 1) AS lastAttemptCompletedAt`;

export function assertForegroundLifecycle(
  run,
  expectedStatus,
  label = "foreground lifecycle",
) {
  if (!new Set(["running", "completed", "failed"]).has(expectedStatus)) {
    throw new Error(`${label} has unsupported expected lifecycle status ${expectedStatus}`);
  }
  if (Number(run?.taskCount ?? 0) !== 1 || Number(run?.attemptCount ?? 0) !== 1) {
    throw new Error(
      `${label} must own exactly one Task and Attempt: ${JSON.stringify({
        runId: run?.id,
        taskCount: run?.taskCount,
        attemptCount: run?.attemptCount,
      })}`,
    );
  }
  if (run.taskStatus !== expectedStatus || run.lastAttemptStatus !== expectedStatus) {
    throw new Error(
      `${label} lifecycle status mismatch: ${JSON.stringify({
        runId: run?.id,
        expectedStatus,
        taskStatus: run?.taskStatus,
        attemptStatus: run?.lastAttemptStatus,
      })}`,
    );
  }
  const expectedTaskKinds = {
    backfill: "maintenance-backfill",
    "dependency-verify": "maintenance-dependency-verify",
    "semantic-index-rebuild": "maintenance-semantic-index-rebuild",
  };
  const expectedTaskKind = expectedTaskKinds[run.runKind];
  if (!expectedTaskKind || run.taskKind !== expectedTaskKind) {
    throw new Error(
      `${label} Task kind mismatch: ${JSON.stringify({
        runId: run?.id,
        runKind: run?.runKind,
        expectedTaskKind,
        taskKind: run?.taskKind,
      })}`,
    );
  }
  if (Number(run.taskAttemptCount ?? 0) !== 1 || Number(run.lastAttemptNumber ?? 0) !== 1) {
    throw new Error(
      `${label} must retain exactly one Task attempt and Attempt #1: ${JSON.stringify({
        runId: run?.id,
        taskAttemptCount: run?.taskAttemptCount,
        lastAttemptNumber: run?.lastAttemptNumber,
      })}`,
    );
  }
  if (typeof run.specJson !== "string" || run.taskInputJson !== run.specJson) {
    throw new Error(
      `${label} Task input did not preserve the full Run spec: ${JSON.stringify({
        runId: run?.id,
        specJson: run?.specJson,
        taskInputJson: run?.taskInputJson,
      })}`,
    );
  }
  const runCreatedAt = parseInstant(run.createdAt, `${label} Run createdAt`);
  const runStartedAt = parseInstant(run.startedAt, `${label} Run startedAt`);
  const taskCreatedAt = parseInstant(run.taskCreatedAt, `${label} Task createdAt`);
  const taskStartedAt = parseInstant(run.taskStartedAt, `${label} Task startedAt`);
  const attemptStartedAt = parseInstant(
    run.lastAttemptStartedAt,
    `${label} Attempt startedAt`,
  );
  if (compareInstantValues(runCreatedAt, runStartedAt) > 0) {
    throw new Error(`${label} Run createdAt must not be after startedAt`);
  }
  if (compareInstantValues(runCreatedAt, taskCreatedAt) > 0) {
    throw new Error(`${label} Run createdAt must not be after Task createdAt`);
  }
  if (compareInstantValues(runStartedAt, taskCreatedAt) > 0) {
    throw new Error(`${label} Run startedAt must not be after Task createdAt`);
  }
  if (compareInstantValues(taskCreatedAt, taskStartedAt) > 0) {
    throw new Error(`${label} Task createdAt must not be after startedAt`);
  }
  if (compareInstantValues(runStartedAt, taskStartedAt) > 0) {
    throw new Error(`${label} Task startedAt must not be before Run startedAt`);
  }
  if (compareInstantValues(taskStartedAt, attemptStartedAt) !== 0) {
    throw new Error(
      `${label} taskStartedAt and lastAttemptStartedAt must share one lifecycle instant: ${JSON.stringify({
        taskStartedAt: run?.taskStartedAt,
        lastAttemptStartedAt: run?.lastAttemptStartedAt,
      })}`,
    );
  }
  if (expectedStatus === "completed" || expectedStatus === "failed") {
    if (
      !run.completedAt ||
      !run.taskCompletedAt ||
      !run.lastAttemptCompletedAt ||
      compareInstants(
        run.taskCompletedAt,
        run.completedAt,
        `${label} Task completedAt`,
        `${label} Run completedAt`,
      ) !== 0 ||
      compareInstants(
        run.lastAttemptCompletedAt,
        run.completedAt,
        `${label} Attempt completedAt`,
        `${label} Run completedAt`,
      ) !== 0
    ) {
      throw new Error(
        `${label} Run, Task, and Attempt did not share one terminal timestamp: ${JSON.stringify({
          runId: run?.id,
          runCompletedAt: run?.completedAt,
          taskCompletedAt: run?.taskCompletedAt,
          attemptCompletedAt: run?.lastAttemptCompletedAt,
        })}`,
      );
    }
    const terminalAt = parseInstant(run.completedAt, `${label} terminal completedAt`);
    for (const [field, value] of [
      ["Run.createdAt", run.createdAt],
      ["Run.startedAt", run.startedAt],
      ["Task.createdAt", run.taskCreatedAt],
      ["Task.startedAt", run.taskStartedAt],
      ["Attempt.startedAt", run.lastAttemptStartedAt],
    ]) {
      if (
        value &&
        compareInstantValues(
          terminalAt,
          parseInstant(value, `${label} ${field}`),
        ) <= 0
      ) {
        throw new Error(
          `${label} terminal completedAt must be after ${field}`,
        );
      }
    }
  } else if (run.completedAt || run.taskCompletedAt || run.lastAttemptCompletedAt) {
    throw new Error(
      `${label} running lifecycle unexpectedly has a terminal timestamp: ${JSON.stringify({
        runId: run?.id,
        runCompletedAt: run?.completedAt,
        taskCompletedAt: run?.taskCompletedAt,
        attemptCompletedAt: run?.lastAttemptCompletedAt,
      })}`,
    );
  }
}

function rowsOf(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

function sceneDocument(text) {
  return JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  });
}

async function queryRows(harness, page, sql, params = [], method = "all") {
  return rowsOf(
    await harness.invokeOk(page, "db_execute", {
      sql,
      params,
      method,
    }),
  );
}

async function projectIdFor(harness, page) {
  return harness.waitUntil(
    async () => {
      const rows = await queryRows(
        harness,
        page,
        "SELECT id FROM projects ORDER BY created_at, id LIMIT 1",
      );
      const projectId = String(rows[0]?.id ?? "");
      return projectId || null;
    },
    "C2-5B product journey project authority",
    30_000,
    250,
  );
}

function summarizeRuns(rows) {
  return rows.map((row) => ({
    id: row.id,
    runKind: row.runKind,
    workKey: row.workKey,
    status: row.status,
    semanticEpochId: row.semanticEpochId,
    terminalReasonCode: row.terminalReasonCode,
    attemptCount: row.attemptCount,
    maxAttemptNumber: row.maxAttemptNumber,
    lastAttemptStatus: row.lastAttemptStatus,
    lastAttemptFailureCode: row.lastAttemptFailureCode,
  }));
}

function rowsAfter(rows, baselineRows = []) {
  const baselineIds = new Set(baselineRows.map((row) => row.id));
  return rows.filter((row) => !baselineIds.has(row.id));
}

function parseOutcome(value) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function isParsedInstant(value) {
  return (
    value &&
    typeof value === "object" &&
    typeof value.epochSeconds === "bigint" &&
    typeof value.nanoseconds === "bigint"
  );
}

function compareInstantValues(left, right) {
  if (left.epochSeconds < right.epochSeconds) return -1;
  if (left.epochSeconds > right.epochSeconds) return 1;
  if (left.nanoseconds < right.nanoseconds) return -1;
  if (left.nanoseconds > right.nanoseconds) return 1;
  return 0;
}

function coerceInstant(value, label) {
  return isParsedInstant(value) ? value : parseInstant(value, label);
}

export function compareInstants(left, right, leftLabel = "left", rightLabel = "right") {
  return compareInstantValues(
    coerceInstant(left, leftLabel),
    coerceInstant(right, rightLabel),
  );
}

function wallClockInstant(milliseconds, label) {
  if (
    typeof milliseconds !== "number" ||
    !Number.isFinite(milliseconds) ||
    !Number.isInteger(milliseconds)
  ) {
    throw new Error(`${label} must be a finite integer millisecond timestamp`);
  }
  const totalNanoseconds = BigInt(milliseconds) * 1_000_000n;
  let epochSeconds = totalNanoseconds / 1_000_000_000n;
  let nanoseconds = totalNanoseconds % 1_000_000_000n;
  if (nanoseconds < 0n) {
    epochSeconds -= 1n;
    nanoseconds += 1_000_000_000n;
  }
  return { epochSeconds, nanoseconds };
}

export function assertWallClockLowerBound(
  timestamp,
  lowerBoundMilliseconds,
  label = "timestamp",
) {
  const observed = parseInstant(timestamp, `${label} timestamp`);
  const lowerBound = wallClockInstant(
    lowerBoundMilliseconds,
    `${label} lower bound`,
  );
  if (compareInstantValues(observed, lowerBound) < 0) {
    throw new Error(`${label} timestamp predates its wall-clock lower bound`);
  }
  return observed;
}

export function assertWallClockIntervalContains(
  wallClockStartMilliseconds,
  wallClockEndMilliseconds,
  intervalStart,
  intervalEnd,
  label = "wall-clock interval",
) {
  const wallClockStart = wallClockInstant(
    wallClockStartMilliseconds,
    `${label} start`,
  );
  const wallClockEnd = wallClockInstant(
    wallClockEndMilliseconds,
    `${label} end`,
  );
  const instantStart = parseInstant(intervalStart, `${label} interval start`);
  const instantEnd = parseInstant(intervalEnd, `${label} interval end`);
  if (
    compareInstantValues(wallClockStart, instantStart) < 0 ||
    compareInstantValues(wallClockEnd, instantEnd) > 0
  ) {
    throw new Error(`${label} wall-clock interval did not overlap the Run interval`);
  }
  return { start: wallClockStart, end: wallClockEnd };
}

export function parseInstant(value, label = "timestamp") {
  const text = typeof value === "string" ? value : "";
  const rfc3339 = /^(\d{4})-(\d{2})-(\d{2})([Tt ])(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|z|[+\-−]\d{2}:\d{2})$/.exec(text);
  // Chrono's `%Y` parser accepts one to four unsigned digits, or a leading
  // sign followed by one or more digits, across its signed proleptic range.
  // RFC3339 intentionally remains the stricter four-unsigned-digit grammar.
  const legacyNaive = /^([+\-]?\d+)-(\d{2})-(\d{2})( )(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(
    text,
  );
  const match = rfc3339 ?? legacyNaive;
  const isLegacyNaive = !rfc3339 && Boolean(legacyNaive);
  if (!match) {
    throw new Error(
      `${label} must be a valid Rust-compatible timestamp grammar: ${value}`,
    );
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    ,
    hourText,
    minuteText,
    secondText,
    fractionText,
    offsetText,
  ] = match;
  const year = Number(yearText);
  const yearHasSign = /^[+\-]/.test(yearText);
  const yearDigits = yearHasSign ? yearText.slice(1) : yearText;
  if (
    (isLegacyNaive && !yearHasSign && yearDigits.length > 4) ||
    !Number.isSafeInteger(year) ||
    year < -262_143 ||
    year > 262_142
  ) {
    throw new Error(
      `${label} must be a valid Rust-compatible timestamp grammar: ${value}`,
    );
  }
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const daysInMonth =
    month === 2
      ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28)
      : [4, 6, 9, 11].includes(month)
        ? 30
        : 31;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth ||
    hour > 23 ||
    minute > 59 ||
    second > 60
  ) {
    throw new Error(
      `${label} must be a valid Rust-compatible timestamp grammar: ${value}`,
    );
  }
  const fraction = fractionText ?? "";
  // Rust's durable timestamps are nanosecond values. Reject sub-nanosecond
  // text rather than silently dropping precision during lifecycle ordering.
  if (fraction.length > 9) {
    throw new Error(
      `${label} must be a valid Rust-compatible timestamp grammar: ${value}`,
    );
  }
  const nanoseconds = BigInt((fraction + "000000000").slice(0, 9));
  let offsetMinutes = 0;
  if (offsetText && !/^[Zz]$/.test(offsetText)) {
    const offsetMatch = /^[+\-−](\d{2}):(\d{2})$/.exec(offsetText);
    if (!offsetMatch) {
      throw new Error(
        `${label} must be a valid Rust-compatible timestamp grammar: ${value}`,
      );
    }
    const offsetHours = Number(offsetMatch[1]);
    const offsetMinutePart = Number(offsetMatch[2]);
    if (offsetHours > 23 || offsetMinutePart > 59) {
      throw new Error(
        `${label} must be a valid Rust-compatible timestamp grammar: ${value}`,
      );
    }
    const sign = offsetText[0] === "+" ? 1 : -1;
    offsetMinutes = sign * (offsetHours * 60 + offsetMinutePart);
  }
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second === 60 ? 59 : second, 0);
  const timestampMilliseconds = date.getTime();
  if (!Number.isFinite(timestampMilliseconds)) {
    throw new Error(
      `${label} must be a valid Rust-compatible timestamp grammar: ${value}`,
    );
  }
  // Chrono stores 23:59:60 as the preceding non-leap epoch second with a
  // nanosecond component in [1e9, 2e9). Keeping those components separate
  // makes the leap second sort after 23:59:59 and before the next minute;
  // adding one second would incorrectly collapse it onto 00:00:00.
  return {
    epochSeconds:
      BigInt(Math.trunc(timestampMilliseconds / 1_000)) -
      BigInt(offsetMinutes) * 60n,
    nanoseconds: nanoseconds + (second === 60 ? 1_000_000_000n : 0n),
  };
}

function parseRunSpec(run, label) {
  if (run?.specJson && typeof run.specJson === "object") {
    return run.specJson;
  }
  if (typeof run?.specJson !== "string") {
    throw new Error(`${label} is missing durable spec_json`);
  }
  try {
    const parsed = JSON.parse(run.specJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("spec_json is not an object");
    }
    return parsed;
  } catch (error) {
    throw new Error(`${label} has malformed durable spec_json`, {
      cause: error,
    });
  }
}

function canonicalWorkKeyForRun(run, label = "Run") {
  if (
    typeof run?.projectId !== "string" ||
    typeof run?.runKind !== "string" ||
    typeof run?.workKey !== "string" ||
    run.projectId.trim() === "" ||
    run.runKind.trim() === "" ||
    run.workKey.trim() === ""
  ) {
    throw new Error(`${label} is missing canonical work identity fields`);
  }
  const base = `narrative-maintenance:v1/${run.runKind}/${run.projectId}/${run.workKey}`;
  // The native lifecycle contract keeps the legacy Backfill WorkKey
  // epochless even though its durable Run records the current epoch. Verify
  // and Rebuild are epoch-bound identities and must retain their suffix.
  if (run.runKind === "backfill") return base;
  if (
    (run.runKind === "dependency-verify" ||
      run.runKind === "semantic-index-rebuild") &&
    (typeof run.semanticEpochId !== "string" ||
      run.semanticEpochId.trim() === "")
  ) {
    throw new Error(`${label} is missing the epoch-bound canonical work identity`);
  }
  return run.semanticEpochId ? `${base}/epoch/${run.semanticEpochId}` : base;
}

function foregroundSystemWorkMarker(run, label = "foreground Run") {
  const spec = parseRunSpec(run, label);
  const marker = spec.systemWork;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return null;
  }
  return marker;
}

export function assertForegroundRunMarker(
  run,
  { barrierId, correlation, trigger = NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER },
) {
  const marker = foregroundSystemWorkMarker(run);
  if (!marker) {
    throw new Error("foreground Run is missing the native systemWork marker");
  }
  if (marker.trigger !== trigger) {
    throw new Error(
      `foreground Run systemWork.trigger must be ${trigger}, got ${String(marker.trigger)}`,
    );
  }
  if (marker.productJourneyBarrierId !== barrierId) {
    throw new Error(
      "foreground Run systemWork.productJourneyBarrierId did not match the unique journey barrier",
    );
  }
  if (marker.correlation !== correlation) {
    throw new Error(
      "foreground Run systemWork.correlation did not match the unique journey correlation",
    );
  }
  if (
    typeof marker.authorityId !== "string" ||
    marker.authorityId.trim() === "" ||
    !Number.isSafeInteger(marker.generation) ||
    marker.generation <= 0
  ) {
    throw new Error(
      "foreground Run systemWork marker is missing immutable authority id/generation",
    );
  }
  const canonicalWorkKey = canonicalWorkKeyForRun(run);
  if (marker.canonicalWorkKey !== canonicalWorkKey) {
    throw new Error(
      `foreground Run systemWork.canonicalWorkKey did not match ${canonicalWorkKey}`,
    );
  }
  return {
    marker,
    canonicalWorkKey,
  };
}

function assertImmutableForegroundMarker(
  run,
  expected,
  originalMarker,
  label,
) {
  const { marker } = assertForegroundRunMarker(run, expected);
  for (const field of NARRATIVE_MAINTENANCE_FOREGROUND_SYSTEM_WORK_MARKER) {
    if (marker[field] !== originalMarker[field]) {
      throw new Error(
        `${label} changed immutable systemWork.${field}: ${String(
          originalMarker[field],
        )} -> ${String(marker[field])}`,
      );
    }
  }
  return marker;
}

export function foregroundMarkedRuns(
  rows,
  baselineRows,
  expected,
) {
  const fresh = rowsAfter(rows, baselineRows);
  return fresh.filter((run) => {
    const marker = foregroundSystemWorkMarker(run);
    return (
      marker?.productJourneyBarrierId === expected.barrierId ||
      marker?.correlation === expected.correlation
    );
  });
}

/**
 * A target workspace's baseline is captured before its explicit open.  A
 * marked Run already present there belongs to an old authority and must not
 * be allowed to satisfy the target-open barrier after an authority swap.
 */
export function assertForegroundTargetBaseline(
  baselineRows,
  expected,
  label = "foreground target workspace",
) {
  const oldMarked = foregroundMarkedRuns(baselineRows, [], expected);
  if (oldMarked.length > 0) {
    throw new Error(
      `${label} baseline contains an old marked authority Run: ${JSON.stringify(
        summarizeRuns(oldMarked),
      )}`,
    );
  }
  return baselineRows;
}

/**
 * Select the one immutable marker created after the target workspace open.
 * The baseline check and exact-one check stay together so a page or SQLite
 * observation cannot silently reuse an old-authority Run.
 */
export function selectForegroundTargetMarker(
  rows,
  baselineRows,
  expected,
) {
  assertForegroundTargetBaseline(baselineRows, expected);
  const candidates = foregroundMarkedRuns(rows, baselineRows, expected);
  if (candidates.length !== 1) {
    throw new Error(
      `foreground target open must leave exactly one fresh target marker: ${JSON.stringify(
        summarizeRuns(candidates),
      )}`,
    );
  }
  const [candidate] = candidates;
  assertForegroundRunMarker(candidate, expected);
  return candidate;
}

export function assertTransientAttemptEvidence(run) {
  if (run?.lastAttemptStatus !== "failed") {
    throw new Error(
      "transient retry did not retain a failed Attempt alongside the failed Run",
    );
  }
  if (run?.lastAttemptFailureCode !== NARRATIVE_MAINTENANCE_TRANSIENT_CODE) {
    throw new Error(
      "transient retry Attempt is missing the exact NEX_MAINTENANCE_TRANSIENT classification",
    );
  }
  if (
    Number(run?.taskCount ?? 0) !== 1 ||
    Number(run?.attemptCount ?? 0) !== 1 ||
    Number(run?.taskAttemptCount ?? 0) !== 1 ||
    Number(run?.lastAttemptNumber ?? 0) !== 1 ||
    Number(run?.maxAttemptNumber ?? 0) !== 1
  ) {
    throw new Error(
      "transient retry must retain exactly one Task and Attempt #1 per failed Run",
    );
  }
  return run;
}

function assertTransientCompletedEvidence(run, label) {
  const outcome = parseOutcome(run?.outcomeSummaryJson);
  if (
    !outcome ||
    outcome.maintenancePhase !== "backfill-complete" ||
    outcome.backfillAlgorithmVersion !== "3" ||
    outcome.semanticEpochId !== run?.semanticEpochId
  ) {
    throw new Error(
      `${label} completed Run is missing the canonical Backfill success outcome`,
    );
  }
  const summary = outcome.summary;
  if (
    !summary ||
    typeof summary !== "object" ||
    typeof summary.epoch_created !== "boolean" ||
    !Number.isSafeInteger(summary.contributions_created) ||
    summary.contributions_created < 0 ||
    !Number.isSafeInteger(summary.edges_created) ||
    summary.edges_created < 0 ||
    !Number.isSafeInteger(summary.applications_without_run_id) ||
    summary.applications_without_run_id < 0
  ) {
    throw new Error(
      `${label} completed Run has an invalid canonical Backfill summary`,
    );
  }
  return run;
}

export function assertTransientRunSequence(runs, label = "transient retry") {
  if (!Array.isArray(runs) || runs.length < 2 || runs.length > 3) {
    throw new Error(`${label} must contain at least two and at most three distinct same-work Runs`);
  }
  const first = runs[0];
  const expectedIdentity = {
    projectId: first?.projectId,
    runKind: first?.runKind,
    workKey: first?.workKey,
  };
  if (first?.status !== "failed") {
    throw new Error(`${label} must begin with a failed Run`);
  }
  const ids = new Set();
  let previousCreatedAt = null;
  let completedIndex = -1;
  for (const [index, run] of runs.entries()) {
    if (!run?.id || ids.has(run.id)) {
      throw new Error(`${label} must contain distinct same-work Run ids`);
    }
    ids.add(run.id);
    for (const [field, expected] of Object.entries(expectedIdentity)) {
      if (run?.[field] !== expected) {
        throw new Error(`${label} Run ${run?.id} changed same-work identity field ${field}`);
      }
    }
    const createdAt = parseInstant(run.createdAt, `${label} Run ${run.id} createdAt`);
    if (
      previousCreatedAt !== null &&
      compareInstantValues(createdAt, previousCreatedAt) <= 0
    ) {
      throw new Error(`${label} same-work Runs must have strictly increasing createdAt instants`);
    }
    previousCreatedAt = createdAt;
    if (!new Set(["failed", "completed"]).has(run.status)) {
      throw new Error(`${label} Run ${run.id} has unsupported terminal status ${run.status}`);
    }
    assertForegroundLifecycle(run, run.status, `${label} Run ${run.id}`);
    if (run.status === "failed") {
      if (run.terminalReasonCode !== NARRATIVE_MAINTENANCE_TRANSIENT_CODE) {
        throw new Error(`${label} failed Run ${run.id} has the wrong transient terminal evidence`);
      }
      assertTransientAttemptEvidence(run);
    } else {
      if (completedIndex >= 0) {
        throw new Error(`${label} completed Run must be final in the ordered retry sequence`);
      }
      completedIndex = index;
      assertTransientCompletedEvidence(run, `${label} Run ${run.id}`);
    }
  }
  if (completedIndex !== runs.length - 1) {
    throw new Error(`${label} completed Run must be final in the ordered retry sequence`);
  }
  return runs;
}

export function assertTerminalFailureEvidence(run) {
  if (
    run?.status !== "failed" ||
    run?.terminalReasonCode !== NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE
  ) {
    throw new Error(
      "terminal failure did not persist the exact contract reason code",
    );
  }
  if (!run.completedAt) {
    throw new Error(
      "terminal failure must persist completedAt before no-retry observation",
    );
  }
  parseInstant(run.completedAt, "terminal failed Run completedAt");
  assertForegroundLifecycle(run, "failed", "terminal failure");
  if (run.lastAttemptFailureCode !== NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE) {
    throw new Error(
      "terminal failure lastAttemptFailureCode did not persist the exact failed Attempt failure code",
    );
  }
  return run;
}

export function terminalRetryCandidates(rows, failedRun) {
  return rows.filter(
    (row) =>
      row.id !== failedRun.id &&
      row.runKind === failedRun.runKind &&
      row.workKey === failedRun.workKey,
  );
}

const DIGEST_EVIDENCE_FIELD_BY_TRIGGER = Object.freeze({
  graphContractDigest: "graphContractDigest",
  ruleRegistryDigest: "ruleRegistryDigest",
  producerGenerationSetDigest: "producerGenerationSetDigest",
});

function skipEvidenceForRun(run, label) {
  const evidence = parseOutcome(run?.outcomeSummaryJson)?.skipEvidence;
  if (!evidence || typeof evidence !== "object") {
    throw new Error(`${label}: completed Run is missing exact skipEvidence`);
  }
  for (const field of Object.values(DIGEST_EVIDENCE_FIELD_BY_TRIGGER)) {
    if (typeof evidence[field] !== "string" || evidence[field].length === 0) {
      throw new Error(
        `${label}: skipEvidence.${field} is not a durable string`,
      );
    }
  }
  return evidence;
}

function requireSequence(
  rows,
  expectedKinds,
  label,
  { requireCompleted = true } = {},
) {
  let offset = 0;
  const selected = [];
  for (const expectedKind of expectedKinds) {
    const index = rows.findIndex(
      (row, candidateIndex) =>
        candidateIndex >= offset && row.runKind === expectedKind,
    );
    if (index < 0) {
      throw new Error(
        `${label}: missing durable Run sequence ${expectedKinds.join(" -> ")}; ` +
          `observed=${JSON.stringify(summarizeRuns(rows))}`,
      );
    }
    selected.push(rows[index]);
    offset = index + 1;
  }
  for (const row of selected) {
    if (requireCompleted && row.status !== "completed") {
      throw new Error(
        `${label}: ${row.runKind} Run ${row.id} did not complete; ` +
          `observed=${JSON.stringify(summarizeRuns(rows))}`,
      );
    }
  }
  return selected;
}

/**
 * Validate the restore-triggered phase chain against the rows created after
 * the settled pre-restore snapshot.  Keeping this as a pure contract makes it
 * possible to prove that an empty backup (the old fixture) is red, while also
 * preventing a pre-restore Verify/Rebuild chain from being mistaken for the
 * post-restore chain.
 */
export function assertRestoreVerifyRebuildVerifyCausality(
  sequence,
  beforeEpochs,
  epochs,
  label = "restore/epoch sequence",
) {
  const expectedKinds = [
    "dependency-verify",
    "semantic-index-rebuild",
    "dependency-verify",
  ];
  if (!Array.isArray(sequence) || sequence.length !== expectedKinds.length) {
    throw new Error(
      `${label}: expected exactly Verify -> Rebuild -> confirmation Verify; ` +
        `observed=${JSON.stringify(summarizeRuns(sequence ?? []))}`,
    );
  }
  for (const [index, expectedKind] of expectedKinds.entries()) {
    if (sequence[index]?.runKind !== expectedKind) {
      throw new Error(
        `${label}: expected ${expectedKinds.join(" -> ")}; ` +
          `observed=${JSON.stringify(summarizeRuns(sequence))}`,
      );
    }
    if (sequence[index]?.status !== "completed") {
      throw new Error(
        `${label}: ${expectedKind} Run ${sequence[index]?.id ?? "<missing>"} did not complete`,
      );
    }
  }

  const beforeIds = new Set(
    (Array.isArray(beforeEpochs) ? beforeEpochs : []).map((epoch) => epoch.id),
  );
  const newEpochs = (Array.isArray(epochs) ? epochs : []).filter(
    (epoch) => !beforeIds.has(epoch.id),
  );
  const restoreEpochs = newEpochs.filter((epoch) => epoch.reason === "restore");
  if (restoreEpochs.length !== 1) {
    throw new Error(
      `${label}: expected exactly one new restore Epoch; ` +
        `observed=${JSON.stringify({ newEpochs, beforeEpochs, epochs })}`,
    );
  }
  const restoreEpoch = restoreEpochs[0];
  const restoreEpochCreatedAt = parseInstant(
    restoreEpoch.createdAt,
    `${label} restore Epoch createdAt`,
  );
  let previousCreatedAt = null;
  let previousCompletedAt = null;
  if (
    sequence.some(
      (run) =>
        run.semanticEpochId !== restoreEpoch.id ||
        !run.id ||
        !run.createdAt ||
        !run.completedAt,
    )
  ) {
    throw new Error(
      `${label}: every phase must be completed under the new restore Epoch; ` +
        `observed=${JSON.stringify({ sequence: summarizeRuns(sequence), restoreEpoch })}`,
    );
  }
  for (const [index, run] of sequence.entries()) {
    const createdAt = parseInstant(
      run.createdAt,
      `${label} phase ${index + 1} createdAt`,
    );
    const completedAt = parseInstant(
      run.completedAt,
      `${label} phase ${index + 1} completedAt`,
    );
    if (compareInstantValues(createdAt, completedAt) >= 0) {
      throw new Error(
        `${label}: phase ${run.id} completedAt must be after createdAt; ` +
          `observed=${JSON.stringify({ run, restoreEpoch })}`,
      );
    }
    if (compareInstantValues(createdAt, restoreEpochCreatedAt) < 0) {
      throw new Error(
        `${label}: phase ${run.id} predates the restore Epoch; ` +
          `observed=${JSON.stringify({ run, restoreEpoch })}`,
      );
    }
    if (
      previousCreatedAt &&
      compareInstantValues(createdAt, previousCreatedAt) <= 0
    ) {
      throw new Error(
        `${label}: phase creation timestamps are not strictly monotonic; ` +
        `observed=${JSON.stringify({ sequence: summarizeRuns(sequence) })}`,
      );
    }
    if (
      previousCompletedAt &&
      compareInstantValues(createdAt, previousCompletedAt) <= 0
    ) {
      throw new Error(
        `${label}: phase ${run.id} starts before the prior phase completed ` +
          `(lifecycle overlap); observed=${JSON.stringify({
            sequence: summarizeRuns(sequence),
          })}`,
      );
    }
    if (
      previousCompletedAt &&
      compareInstantValues(completedAt, previousCompletedAt) <= 0
    ) {
      throw new Error(
        `${label}: phase completion timestamps are not strictly monotonic; ` +
          `observed=${JSON.stringify({ sequence: summarizeRuns(sequence) })}`,
      );
    }
    previousCreatedAt = createdAt;
    previousCompletedAt = completedAt;
  }
  return restoreEpoch;
}

/**
 * The process-interruption seam exits immediately after the native running
 * Run ACK.  Select that durable row from the first post-exit SQLite snapshot;
 * page observation is intentionally not part of this contract because the
 * renderer may already be gone.
 */
export function selectInterruptedRunFromExitSnapshot(
  postExitRuns,
  baselineRuns = [],
) {
  const fresh = rowsAfter(postExitRuns, baselineRuns);
  const candidates = fresh.filter(
    (row) => row.runKind === "backfill" && row.status === "running",
  );
  if (candidates.length !== 1) {
    throw new Error(
      `process interruption must leave exactly one new running Backfill Run; ` +
        `observed=${JSON.stringify(summarizeRuns(fresh))}`,
    );
  }
  return candidates[0];
}

/**
 * Select the one recovery Run from a settled post-reopen ledger.  The first
 * qualifying recovery can be observed before a duplicate or a late
 * non-terminal Run is inserted, so this helper deliberately counts every
 * post-exit same-work candidate before accepting the lifecycle.
 */
export function selectInterruptedRecoveryFromStableLedger(
  stableRows,
  postExitRows = [],
  staleRun,
  label = "process interruption recovery",
) {
  const rows = Array.isArray(stableRows) ? stableRows : [];
  const stale = rows.find((row) => row.id === staleRun?.id);
  if (
    !stale ||
    stale.status !== "failed" ||
    stale.terminalReasonCode !== NARRATIVE_MAINTENANCE_INTERRUPTED_CODE ||
    !stale.completedAt
  ) {
    throw new Error(
      `${label}: stale Run did not persist the interrupted terminal lifecycle; ` +
        `observed=${JSON.stringify(summarizeRuns(rows))}`,
    );
  }
  assertForegroundLifecycle(stale, "failed", `${label} stale Run`);
  const staleCompletedAt = parseInstant(
    stale.completedAt,
    `${label} stale Run completedAt`,
  );
  const candidates = rowsAfter(rows, postExitRows).filter(
    (row) =>
      row.runKind === stale.runKind &&
      row.workKey === stale.workKey &&
      row.semanticEpochId === stale.semanticEpochId,
  );
  if (candidates.length !== 1) {
    throw new Error(
      `${label} must leave exactly one new same-work recovery Run after reopen; ` +
        `observed=${JSON.stringify(summarizeRuns(candidates))}`,
    );
  }
  const [recovery] = candidates;
  if (recovery.status !== "completed") {
    throw new Error(
      `${label} recovery Run ${recovery.id} did not complete; ` +
        `observed=${JSON.stringify(summarizeRuns(candidates))}`,
    );
  }
  if (
    compareInstantValues(
      parseInstant(recovery.createdAt, `${label} recovery Run createdAt`),
      staleCompletedAt,
    ) <= 0
  ) {
    throw new Error(
      `${label} recovery Run ${recovery.id} was created at or before the stale Run completedAt`,
    );
  }
  assertForegroundLifecycle(recovery, "completed", `${label} recovery Run`);
  return recovery;
}

/**
 * A Verify/Rebuild observation must remain free of the human-only Repair Run
 * kind across the whole settled ledger, including delayed follow-up work.
 */
export function assertNoAutomaticRepair(
  stableRows,
  label = "automatic maintenance",
) {
  const rows = Array.isArray(stableRows) ? stableRows : [];
  const repairs = rows.filter((row) => row.runKind === "dependency-repair");
  if (repairs.length > 0) {
    throw new Error(
      `${label} reached the human-only Repair Run kind: ${JSON.stringify(
        summarizeRuns(repairs),
      )}`,
    );
  }
  return stableRows;
}

/**
 * Acknowledging a reservation clears the reservation's epoch as well as its
 * Run/range columns. The completed Freshness Run carries the epoch binding;
 * a released cursor must therefore not be compared to that Run's epoch.
 */
export function isSettledFreshnessCursor(cursor) {
  return (
    cursor !== null &&
    typeof cursor === "object" &&
    cursor.activeRunId === null &&
    cursor.reservedThrough === null &&
    cursor.semanticEpochId === null &&
    cursor.lastError === null
  );
}

async function runLedger(harness, page, projectId) {
  return queryRows(
    harness,
    page,
    `SELECT ${RUN_COLUMNS}
      FROM narrative_extraction_runs r
      WHERE r.project_id = ?
      ORDER BY created_at, id`,
    [projectId],
  );
}

async function currentEpochs(harness, page, projectId) {
  return queryRows(
    harness,
    page,
    `SELECT id, epoch_number AS epochNumber, reason, created_at AS createdAt
       FROM narrative_semantic_epochs
      WHERE project_id = ?
      ORDER BY epoch_number, id`,
    [projectId],
  );
}

async function currentFeedAndCursor(harness, page, projectId) {
  const feed = await queryRows(
    harness,
    page,
    `SELECT COALESCE(MAX(canonical_sequence), 0) AS feedHead
       FROM narrative_change_events
      WHERE project_id = ?`,
    [projectId],
  );
  const cursor = await queryRows(
    harness,
    page,
    `SELECT acknowledged_through_sequence AS acknowledgedThrough,
            semantic_epoch_id AS semanticEpochId,
            active_run_id AS activeRunId,
            reserved_through_sequence AS reservedThrough,
            last_error AS lastError
       FROM narrative_change_cursors
      WHERE project_id = ?
        AND consumer_id = 'narrative-incremental-freshness/v1'`,
    [projectId],
  );
  return {
    feedHead: Number(feed[0]?.feedHead ?? 0),
    cursor: cursor[0] ?? null,
  };
}

async function waitForRunSequence(
  context,
  expectedKinds,
  label,
  timeoutMs = NARRATIVE_MAINTENANCE_WAIT_MS,
  { baselineRows = context.baselineRuns, requireCompleted = true } = {},
) {
  return waitForLedger(
    context,
    (rows) => {
      const fresh = rowsAfter(rows, baselineRows);
      try {
        return requireSequence(fresh, expectedKinds, label, {
          requireCompleted,
        });
      } catch {
        return null;
      }
    },
    `${label} durable Run sequence`,
    timeoutMs,
  );
}

async function waitForRestorePhaseRows(context, baselineRows) {
  await waitForLedger(
    context,
    (rows) => {
      const phaseRows = rowsAfter(rows, baselineRows).filter((row) =>
        RESTORE_AUTOMATIC_PHASE_RUN_KINDS.has(row.runKind),
      );
      if (
        phaseRows.length < 3 ||
        phaseRows.some((row) => row.status !== "completed")
      ) {
        return null;
      }
      return phaseRows;
    },
    "restore/epoch complete automatic phase rows",
  );

  // A three-row observation is not the settled boundary: a later confirmation
  // or repair Run can be inserted immediately after the first V -> R -> V
  // completes.  Hold the observation until the complete post-restore ledger
  // is stable, then return every fresh automatic phase row for the exact-chain
  // assertion instead of selecting a matching subsequence.
  const stableRows = await waitForStableLedger(
    context,
    baselineRows,
    "restore/epoch settled automatic phase rows",
  );
  return rowsAfter(stableRows, baselineRows).filter((row) =>
    RESTORE_AUTOMATIC_PHASE_RUN_KINDS.has(row.runKind),
  );
}

async function waitForLedger(
  context,
  predicate,
  label,
  timeoutMs = NARRATIVE_MAINTENANCE_WAIT_MS,
) {
  return context.harness.waitUntil(
    async () => {
      const rows = await runLedger(
        context.harness,
        context.page,
        context.projectId,
      );
      const value = await predicate(rows);
      if (value) return value;
      throw new Error(
        `${label}: durable observations are not ready; ` +
          `observed=${JSON.stringify(summarizeRuns(rows))}`,
      );
    },
    label,
    timeoutMs,
    100,
  );
}

async function waitForReadiness(
  context,
  label,
  {
    baselineRuns = null,
    minimumFeedHead = 0,
    requireFreshRun = false,
    requireMaintenanceSettled = false,
  } = {},
) {
  const baselineIds = new Set(
    (baselineRuns ?? []).map((run) => String(run.id)),
  );
  return context.harness.waitUntil(
    async () => {
      const rows = await runLedger(
        context.harness,
        context.page,
        context.projectId,
      );
      const epochs = await currentEpochs(
        context.harness,
        context.page,
        context.projectId,
      );
      const feedAndCursor = await currentFeedAndCursor(
        context.harness,
        context.page,
        context.projectId,
      );
      const latestEpoch = epochs.at(-1);
      const latestFreshness = [...rows]
        .reverse()
        .find((row) => row.runKind === "freshness-evaluation");
      const maintenanceKinds = new Set([
        "backfill",
        "dependency-verify",
        "semantic-index-rebuild",
        "freshness-evaluation",
      ]);
      const maintenanceSettled =
        rows.some(
          (row) => row.runKind === "backfill" && row.status === "completed",
        ) &&
        !rows.some(
          (row) =>
            maintenanceKinds.has(row.runKind) &&
            (row.status === "pending" || row.status === "running"),
        );
      const ready =
        latestEpoch &&
        latestFreshness?.status === "completed" &&
        (!requireFreshRun || !baselineIds.has(String(latestFreshness.id))) &&
        latestFreshness.semanticEpochId === latestEpoch.id &&
        latestFreshness.completedAt &&
        feedAndCursor.cursor &&
        feedAndCursor.feedHead >= minimumFeedHead &&
        Number(feedAndCursor.cursor.acknowledgedThrough) ===
          feedAndCursor.feedHead &&
        isSettledFreshnessCursor(feedAndCursor.cursor) &&
        (!requireMaintenanceSettled || maintenanceSettled);
      return ready
        ? {
            epoch: latestEpoch,
            freshness: latestFreshness,
            feedAndCursor,
          }
        : null;
    },
    `${label} current-epoch liveness`,
    NARRATIVE_MAINTENANCE_WAIT_MS,
    100,
  );
}

async function withLaunchEnvironment(
  {
    fault = null,
    trigger = null,
    setup = null,
    ownerToken = null,
    barrierId = null,
    correlation = null,
  } = {},
  callback,
) {
  if (
    !fault &&
    !trigger &&
    !setup &&
    !ownerToken &&
    !barrierId &&
    !correlation
  ) {
    return callback();
  }
  const previousFault = process.env[NARRATIVE_MAINTENANCE_FAULT_ENV];
  const previousTrigger = process.env[NARRATIVE_MAINTENANCE_TRIGGER_ENV];
  const previousSetup = process.env[NARRATIVE_MAINTENANCE_SETUP_ENV];
  const previousOwnerToken = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousBarrierId =
    process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV];
  const previousCorrelation =
    process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV];
  if (fault) process.env[NARRATIVE_MAINTENANCE_FAULT_ENV] = fault;
  else delete process.env[NARRATIVE_MAINTENANCE_FAULT_ENV];
  if (trigger) process.env[NARRATIVE_MAINTENANCE_TRIGGER_ENV] = trigger;
  else delete process.env[NARRATIVE_MAINTENANCE_TRIGGER_ENV];
  if (setup) process.env[NARRATIVE_MAINTENANCE_SETUP_ENV] = setup;
  else delete process.env[NARRATIVE_MAINTENANCE_SETUP_ENV];
  if (ownerToken) {
    process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = ownerToken;
  } else {
    delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  }
  if (barrierId) {
    process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV] = barrierId;
  } else {
    delete process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV];
  }
  if (correlation) {
    process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV] =
      correlation;
  } else {
    delete process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV];
  }
  try {
    return await callback();
  } finally {
    if (previousFault === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_FAULT_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_FAULT_ENV] = previousFault;
    }
    if (previousTrigger === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_TRIGGER_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_TRIGGER_ENV] = previousTrigger;
    }
    if (previousSetup === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_SETUP_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_SETUP_ENV] = previousSetup;
    }
    if (previousOwnerToken === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwnerToken;
    }
    if (previousBarrierId === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV] =
        previousBarrierId;
    }
    if (previousCorrelation === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV] =
        previousCorrelation;
    }
  }
}

async function configureJourneyWorkspace(
  harness,
  configureWorkspace,
  workspace,
  options = {},
) {
  return withLaunchEnvironment(
    {
      setup: "disabled",
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    },
    () => configureWorkspace(harness, workspace, options),
  );
}

function workspaceContext(
  harness,
  launched,
  workspace,
  id,
  projectId,
  baselineRuns,
  setupMetadata = null,
) {
  return {
    harness,
    page: launched.page,
    app: launched.app,
    workspace,
    projectId,
    baselineRuns,
    setupMetadata,
    query: (sql, params = [], method = "all") =>
      queryRows(harness, launched.page, sql, params, method),
    runs: () => runLedger(harness, launched.page, projectId),
    epochs: () => currentEpochs(harness, launched.page, projectId),
    feedAndCursor: () =>
      currentFeedAndCursor(harness, launched.page, projectId),
    record: (event, details = {}) =>
      harness.recordTimeline(event, { projectId, ...details }),
  };
}

async function contextForLaunch(
  harness,
  launched,
  workspace,
  id,
  baselineRuns,
  setupMetadata = null,
) {
  const projectId = await projectIdFor(harness, launched.page);
  const currentRuns =
    baselineRuns ?? (await runLedger(harness, launched.page, projectId));
  return workspaceContext(
    harness,
    launched,
    workspace,
    id,
    projectId,
    currentRuns,
    setupMetadata,
  );
}

async function withWorkspace(
  harness,
  configureWorkspace,
  id,
  callback,
  {
    fault = null,
    trigger = null,
    additionalWorkspaces = [],
    prepareWorkspace = null,
    readRunSnapshotFn = readRunSnapshot,
  } = {},
) {
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace, {
    additionalWorkspaces,
  });
  const setupMetadata = prepareWorkspace
    ? await prepareWorkspace(workspace)
    : null;
  const preLaunchRuns = await readRunSnapshotFn(workspace);
  const launched = await withLaunchEnvironment(
    {
      fault,
      trigger,
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    },
    () => harness.launch(`${id}/open`),
  );
  try {
    const context = await contextForLaunch(
      harness,
      launched,
      workspace,
      id,
      preLaunchRuns,
      setupMetadata,
    );
    return await callback(context);
  } finally {
    await harness.close(launched.app, launched.page, `${id}/open`);
  }
}

async function createSceneIfNeeded(context, marker) {
  const existing = await context.query(
    `SELECT id, project_id AS projectId, version, updated_at AS updatedAt, content
       FROM tree_nodes
      WHERE project_id = ? AND node_type = 'scene'
      ORDER BY created_at, id
      LIMIT 1`,
    [context.projectId],
  );
  if (existing[0]) return existing[0];
  const sceneId = `c2-5b-journey-scene-${randomUUID()}`;
  const eventUid = `c2-5b-journey-scene-create-${randomUUID()}`;
  await context.harness.invokeOk(context.page, "tree_node_create", {
    payload: {
      requestId: eventUid,
      eventUid,
      origin: "human",
      authorityRoute: "human-direct",
      caller: "c2-5b-product-journey",
      controls: [
        "runtime-policy",
        "actor-context",
        "typed-writer",
        "occ",
        "change-event",
        "change-feed",
      ],
      provenance: null,
      writesAuthorityProtectedField: false,
      originalTransactionId: null,
      undoJournalId: null,
      id: sceneId,
      projectId: context.projectId,
      sessionId: "c2-5b-product-journey",
      nodeType: "scene",
      title: marker,
      sortOrder: "c2-5b",
      parentId: null,
      synopsis: null,
      status: null,
      sourceUri: null,
      sourceMtime: null,
      content: sceneDocument(marker),
    },
  });
  return context.harness.waitUntil(
    async () => {
      const rows = await context.query(
        "SELECT id, project_id AS projectId, version, updated_at AS updatedAt, content FROM tree_nodes WHERE id = ?",
        [sceneId],
      );
      return rows[0] ?? null;
    },
    `${marker} scene persistence`,
    30_000,
    100,
  );
}

async function createForegroundSceneThroughUi(context, marker) {
  const header = context.page.locator(
    `[data-panel-header]:has(span[role="heading"]:text-is("シーン"))`,
  );
  await header.waitFor({ state: "visible", timeout: 60_000 });
  const before = await context.query(
    "SELECT id FROM tree_nodes WHERE project_id = ? AND node_type = 'scene'",
    [context.projectId],
  );
  const existingSceneIds = new Set(
    before.map((row) => String(row.id)),
  );
  await header.locator('button[title="新規作成"]').click();
  await context.page
    .getByRole("menuitem", { name: "New scene", exact: true })
    .click();

  const renameInput = context.page.locator(
    '[data-droptarget-id="scenes-panel"] input:focus',
  );
  if (
    await renameInput
      .waitFor({ state: "visible", timeout: 1_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await context.page.keyboard.press("Enter");
  }

  const created = await context.harness.waitUntil(async () => {
    const rows = await context.query(
      `SELECT id, project_id AS projectId, version,
              updated_at AS updatedAt, content, title
         FROM tree_nodes
        WHERE project_id = ? AND node_type = 'scene'
        ORDER BY created_at DESC, id DESC`,
      [context.projectId],
    );
    return (
      rows.find((row) => !existingSceneIds.has(String(row.id))) ?? null
    );
  }, `${marker} UI scene persistence`, 30_000, 100);

  if (String(created.projectId) !== String(context.projectId)) {
    throw new Error(
      `foreground UI scene crossed project authority: ${JSON.stringify({
        sceneProjectId: created.projectId,
        contextProjectId: context.projectId,
      })}`,
    );
  }
  if (
    created.title !== "シーン 1" &&
    !/^シーン \d+$/.test(String(created.title))
  ) {
    throw new Error(`unexpected foreground UI scene title: ${String(created.title)}`);
  }

  const editorSurface = context.page
    .locator(
      `[data-editor-loaded-document-id="${created.id}"][data-editor-document-loading="false"]:visible`,
    )
    .last();
  await editorSurface.waitFor({ state: "visible", timeout: 30_000 });
  await editorSurface
    .locator('.ProseMirror[contenteditable="true"]')
    .first()
    .waitFor({ state: "visible", timeout: 30_000 });
  return created;
}

async function patchScene(context, scene, text) {
  const eventUid = `c2-5b-journey-scene-patch-${randomUUID()}`;
  await context.harness.invokeOk(context.page, "tree_node_patch", {
    payload: {
      projectId: context.projectId,
      requestId: eventUid,
      sessionId: "c2-5b-product-journey",
      eventUid,
      origin: "human",
      originalTransactionId: null,
      undoJournalId: null,
      nodeId: scene.id,
      updatedAt: new Date().toISOString(),
      patch: {
        content: sceneDocument(text),
        charCount: text.length,
      },
      bumpVersion: true,
      baseVersion: Number(scene.version),
      changeEvent: {
        eventUid,
        sessionId: "c2-5b-product-journey",
        timestamp: Date.now(),
      },
    },
  });
}

async function createRestoreBackupFixture(workspace) {
  const backupName = "grimodex-c2-5b-restore-seed.db";
  const backupDirectory = path.join(workspace, "backups");
  const destination = path.join(backupDirectory, backupName);
  await mkdir(backupDirectory, { recursive: true });
  const escapedDestination = destination.replaceAll("'", "''");
  try {
    // SQLite's online backup API includes committed WAL frames; copying only
    // grimodex.db would create a stale restore fixture when a WAL is present.
    await execFile("sqlite3", [
      path.join(workspace, "grimodex.db"),
      `.backup '${escapedDestination}'`,
    ]);
  } catch (error) {
    throw new Error(
      `WAL-safe restore fixture requires sqlite3 online backup support: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  return backupName;
}

/**
 * Validate the one durable Graph Edge used by the restore and dependency-gap
 * journeys.  This deliberately checks the complete persisted shape instead
 * of accepting a convenient marker row: Verify must discover a real Edge
 * whose current-epoch derived state is absent/stale, and Rebuild must be able
 * to evaluate its canonical scene Source.
 */
export function assertRestoreFixtureEvidence(
  rows,
  {
    projectId,
    edgeId,
    consumerKey,
    sourceObjectIdentity,
    owningRunId,
    readSetToken,
  },
) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(
      `restore fixture must contain exactly one canonical dependency Edge; observed=${JSON.stringify(rows)}`,
    );
  }
  const [edge] = rows;
  if (
    edge.id !== edgeId ||
    edge.projectId !== projectId ||
    edge.consumerKind !== RESTORE_FIXTURE_CONSUMER_KIND ||
    edge.consumerKey !== consumerKey ||
    edge.sourceObjectIdentity !== sourceObjectIdentity ||
    edge.generatedByTransactionId !== null ||
    edge.owningRunId !== owningRunId
  ) {
    throw new Error(
      `restore fixture dependency Edge is not canonical: ${JSON.stringify({
        expected: {
          id: edgeId,
          projectId,
          consumerKind: RESTORE_FIXTURE_CONSUMER_KIND,
          consumerKey,
          sourceObjectIdentity,
          generatedByTransactionId: null,
          owningRunId,
        },
        actual: edge,
      })}`,
    );
  }
  parseInstant(edge.createdAt, "restore fixture dependency Edge createdAt");
  if (
    typeof readSetToken !== "string" ||
    !/^v[0-9]+@.+$/.test(readSetToken)
  ) {
    throw new Error(
      `restore fixture read_set token is not a canonical scene revision token: ${JSON.stringify(readSetToken)}`,
    );
  }
  let readSet;
  try {
    readSet = JSON.parse(edge.readSetJson);
  } catch (error) {
    throw new Error(
      `restore fixture dependency Edge read_set_json is not valid JSON: ${String(error)}`,
      { cause: error },
    );
  }
  if (
    !Array.isArray(readSet) ||
    readSet.length !== 1 ||
    readSet[0] !== readSetToken
  ) {
    throw new Error(
      `restore fixture dependency Edge read_set_json is not the canonical one-token shape: ${JSON.stringify(readSet)}`,
    );
  }
  return edge;
}

/**
 * Seed a real scene Source and a fully shaped Dependency Edge through the
 * product's typed APIs before the scheduler launch.  Only the final Edge
 * declaration uses db_execute because no renderer-facing Edge writer exists;
 * its owner Run and every persisted field are validated immediately.
 */
async function seedRestoreFixtureEvidence(harness, workspace, id) {
  const fixtureLaunch = await withLaunchEnvironment(
    {
      setup: "disabled",
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    },
    () => harness.launch(`${id}/restore-fixture`),
  );
  try {
    const context = await contextForLaunch(
      harness,
      fixtureLaunch,
      workspace,
      id,
      null,
    );
    const scene = await createSceneIfNeeded(context, "restore-fixture-source");
    const readSetToken = `v${scene.version}@${scene.updatedAt}`;
    if (!/^v[0-9]+@.+$/.test(readSetToken)) {
      throw new Error(
        `restore fixture scene did not expose a canonical revision token: ${JSON.stringify({
          sceneId: scene.id,
          version: scene.version,
          updatedAt: scene.updatedAt,
        })}`,
      );
    }
    // Establish the same durable legacy boundary that a real workspace has
    // before restore.  Calling the typed production route is important here:
    // an empty/epochless fixture makes the first post-restore open dispatch a
    // Backfill, so the journey can no longer prove the required Verify ->
    // Rebuild -> confirmation Verify chain.  The fixture deliberately rejects
    // a reused/no-op response and validates the persisted Run/Epoch pair.
    const backfillOutcome = await context.harness.invokeOk(
      context.page,
      "retry_narrative_legacy_backfill",
      { payload: { projectId: context.projectId } },
    );
    if (
      !backfillOutcome ||
      backfillOutcome.outcome !== "ran" ||
      typeof backfillOutcome.runId !== "string" ||
      backfillOutcome.runId.trim() === ""
    ) {
      throw new Error(
        `restore fixture requires a fresh typed legacy Backfill outcome: ${JSON.stringify(backfillOutcome)}`,
      );
    }
    const backfillRuns = await context.query(
      `SELECT id,
              project_id AS projectId,
              run_kind AS runKind,
              work_key AS workKey,
              status,
              semantic_epoch_id AS semanticEpochId,
              created_at AS createdAt,
              started_at AS startedAt,
              completed_at AS completedAt
         FROM narrative_extraction_runs
        WHERE project_id = ? AND id = ?`,
      [context.projectId, backfillOutcome.runId],
    );
    const initialEpochs = await context.query(
      `SELECT id,
              project_id AS projectId,
              epoch_number AS epochNumber,
              reason,
              created_at AS createdAt
         FROM narrative_semantic_epochs
        WHERE project_id = ?
        ORDER BY epoch_number DESC, id DESC
        LIMIT 1`,
      [context.projectId],
    );
    const backfillRun = backfillRuns[0];
    const initialEpoch = initialEpochs[0];
    if (
      backfillRuns.length !== 1 ||
      !backfillRun ||
      backfillRun.id !== backfillOutcome.runId ||
      backfillRun.projectId !== context.projectId ||
      backfillRun.runKind !== "backfill" ||
      backfillRun.workKey !== "legacy-dependency-backfill:v3" ||
      backfillRun.status !== "completed" ||
      typeof backfillRun.semanticEpochId !== "string" ||
      backfillRun.semanticEpochId.trim() === "" ||
      initialEpochs.length !== 1 ||
      !initialEpoch ||
      initialEpoch.projectId !== context.projectId ||
      Number(initialEpoch.epochNumber) !== 0 ||
      initialEpoch.reason !== "initial" ||
      backfillRun.semanticEpochId !== initialEpoch.id
    ) {
      throw new Error(
        `restore fixture legacy Backfill boundary is not canonical: ${JSON.stringify({
          outcome: backfillOutcome,
          backfillRun,
          initialEpoch,
        })}`,
      );
    }
    for (const [field, value] of [
      ["createdAt", backfillRun.createdAt],
      ["startedAt", backfillRun.startedAt],
      ["completedAt", backfillRun.completedAt],
      ["epoch.createdAt", initialEpoch.createdAt],
    ]) {
      parseInstant(value, `restore fixture Backfill ${field}`);
    }
    if (
      compareInstants(backfillRun.createdAt, backfillRun.startedAt) > 0 ||
      compareInstants(backfillRun.startedAt, backfillRun.completedAt) >= 0
    ) {
      throw new Error(
        `restore fixture Backfill lifecycle timestamps are not terminal and monotonic: ${JSON.stringify(backfillRun)}`,
      );
    }
    context.record("restore-fixture-backfill-boundary-seeded", {
      runId: backfillRun.id,
      semanticEpochId: backfillRun.semanticEpochId,
      epochNumber: Number(initialEpoch.epochNumber),
      reason: initialEpoch.reason,
    });
    const runId = `c2-5b-restore-fixture-run-${randomUUID()}`;
    const createdRun = await context.harness.invokeOk(
      context.page,
      "narrative_extraction_create_run",
      {
        payload: {
          runId,
          projectId: context.projectId,
          surfacePathId: "c2-5b-restore-fixture",
          scopeJson: {},
          specJson: { fixture: "restore-verify-rebuild-verify" },
          specDigest: RESTORE_FIXTURE_SPEC_DIGEST,
          tasks: [],
        },
      },
    );
    if (createdRun?.runId !== runId || createdRun?.status !== "pending") {
      throw new Error(
        `restore fixture owner Run was not created through the canonical API: ${JSON.stringify(createdRun)}`,
      );
    }
    await context.harness.invokeOk(
      context.page,
      "narrative_extraction_cancel_run",
      { payload: { runId, projectId: context.projectId } },
    );
    const edgeId = `c2-5b-restore-fixture-edge-${randomUUID()}`;
    const consumerKey = runId;
    const sourceObjectIdentity = `project:scene:${scene.id}`;
    await context.harness.invokeOk(context.page, "db_execute", {
      sql: `INSERT INTO narrative_dependency_edges
              (id, project_id, consumer_kind, consumer_key,
               source_object_identity, read_set_json,
               generated_by_transaction_id, created_at, owning_run_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        edgeId,
        context.projectId,
        RESTORE_FIXTURE_CONSUMER_KIND,
        consumerKey,
        sourceObjectIdentity,
        JSON.stringify([readSetToken]),
        null,
        new Date().toISOString(),
        runId,
      ],
      method: "run",
    });
    const edgeRows = await context.query(
      `SELECT id,
              project_id AS projectId,
              consumer_kind AS consumerKind,
              consumer_key AS consumerKey,
              source_object_identity AS sourceObjectIdentity,
              read_set_json AS readSetJson,
              generated_by_transaction_id AS generatedByTransactionId,
              created_at AS createdAt,
              owning_run_id AS owningRunId
         FROM narrative_dependency_edges
        WHERE project_id = ? AND id = ?`,
      [context.projectId, edgeId],
    );
    const ownerRows = await context.query(
      `SELECT id,
              project_id AS projectId,
              surface_path_id AS surfacePathId,
              scope_json AS scopeJson,
              spec_json AS specJson,
              spec_digest AS specDigest,
              status,
              created_at AS createdAt,
              (SELECT COUNT(*)
                 FROM narrative_extraction_tasks t
                WHERE t.run_id = narrative_extraction_runs.id) AS taskCount
         FROM narrative_extraction_runs
        WHERE id = ?`,
      [runId],
    );
    let ownerScope;
    let ownerSpec;
    try {
      ownerScope = JSON.parse(ownerRows[0]?.scopeJson ?? "");
      ownerSpec = JSON.parse(ownerRows[0]?.specJson ?? "");
    } catch (error) {
      throw new Error(
        `restore fixture owner Run JSON fields are not canonical: ${JSON.stringify(ownerRows)}`,
        { cause: error },
      );
    }
    if (
      ownerRows.length !== 1 ||
      ownerRows[0].id !== runId ||
      ownerRows[0].projectId !== context.projectId ||
      ownerRows[0].surfacePathId !== "c2-5b-restore-fixture" ||
      JSON.stringify(ownerScope) !== "{}" ||
      JSON.stringify(ownerSpec) !==
        JSON.stringify({ fixture: "restore-verify-rebuild-verify" }) ||
      ownerRows[0].specDigest !== RESTORE_FIXTURE_SPEC_DIGEST ||
      Number(ownerRows[0].taskCount) !== 0 ||
      ownerRows[0].status !== "cancelled"
    ) {
      throw new Error(
        `restore fixture owner Run is not a durable same-project cancelled Run: ${JSON.stringify(ownerRows)}`,
      );
    }
    parseInstant(ownerRows[0].createdAt, "restore fixture owner Run createdAt");
    const edge = assertRestoreFixtureEvidence(edgeRows, {
      projectId: context.projectId,
      edgeId,
      consumerKey,
      sourceObjectIdentity,
      owningRunId: runId,
      readSetToken,
    });
    context.record("restore-fixture-evidence-seeded", {
      edgeId: edge.id,
      consumerKind: edge.consumerKind,
      consumerKey: edge.consumerKey,
      sourceObjectIdentity: edge.sourceObjectIdentity,
      owningRunId: edge.owningRunId,
    });
    // The restore image must preserve the canonical Edge while its derived
    // state is genuinely absent.  Capture that WAL-safe image before any
    // ordinary launch can settle the live workspace, so the later restore
    // necessarily replays Verify -> Rebuild -> confirmation Verify.
    await createRestoreFixtureDerivedStateGap(context, {
      edgeId,
      consumerKey,
    });
    const backupName = await createRestoreBackupFixture(workspace);
    return {
      edgeId,
      consumerKey,
      sourceObjectIdentity,
      owningRunId: runId,
      readSetToken,
      sceneId: scene.id,
      backupName,
    };
  } finally {
    await harness.close(
      fixtureLaunch.app,
      fixtureLaunch.page,
      `${id}/restore-fixture`,
    );
  }
}

/**
 * Turn the seeded fixture workspace into a restore image with a real derived
 * state gap.  The canonical Edge and Source remain in the image while the
 * Edge/Freshness projections are removed so the restored Epoch's first Verify
 * must request Rebuild.  The owner is a fixture-only Consumer, therefore
 * these deletes cannot affect another journey's graph.
 */
async function createRestoreFixtureDerivedStateGap(context, evidence) {
  await context.harness.invokeOk(context.page, "db_execute", {
    sql: `DELETE FROM narrative_dependency_edge_states
           WHERE project_id = ? AND edge_id = ?`,
    params: [context.projectId, evidence.edgeId],
    method: "run",
  });
  await context.harness.invokeOk(context.page, "db_execute", {
    sql: `DELETE FROM narrative_consumer_freshness
           WHERE project_id = ?
             AND consumer_kind = ?
             AND consumer_key = ?`,
    params: [
      context.projectId,
      RESTORE_FIXTURE_CONSUMER_KIND,
      evidence.consumerKey,
    ],
    method: "run",
  });
  const remaining = await context.query(
    `SELECT
       (SELECT COUNT(*)
          FROM narrative_dependency_edge_states
         WHERE project_id = ? AND edge_id = ?) AS edgeStateCount,
       (SELECT COUNT(*)
          FROM narrative_consumer_freshness
         WHERE project_id = ?
           AND consumer_kind = ?
           AND consumer_key = ?) AS freshnessCount`,
    [
      context.projectId,
      evidence.edgeId,
      context.projectId,
      RESTORE_FIXTURE_CONSUMER_KIND,
      evidence.consumerKey,
    ],
  );
  if (
    Number(remaining[0]?.edgeStateCount ?? -1) !== 0 ||
    Number(remaining[0]?.freshnessCount ?? -1) !== 0
  ) {
    throw new Error(
      `restore fixture derived-state gap was not fully created: ${JSON.stringify(remaining)}`,
    );
  }
  context.record("restore-fixture-derived-state-gap-created", {
    edgeId: evidence.edgeId,
    consumerKey: evidence.consumerKey,
  });
}

async function prepareLegacySchemaMarker(workspace) {
  const databasePath = path.join(workspace, "grimodex.db");
  try {
    await execFile("sqlite3", [databasePath, "PRAGMA user_version = 30;"]);
    await execFile("sqlite3", [
      databasePath,
      "DELETE FROM schema_data_migrations WHERE migration_id = 'narrative-c2-finding-identity-v31';",
    ]);
    const { stdout } = await execFile("sqlite3", [
      databasePath,
      "PRAGMA user_version;",
    ]);
    const marker = Number(String(stdout).trim());
    if (marker !== 30) {
      throw new Error(
        `legacy schema fixture marker was not written: ${marker}`,
      );
    }
    return marker;
  } catch (error) {
    throw new Error(
      `schema marker fixture requires the sqlite3 test dependency: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readRunSnapshotQuery(workspace, query) {
  const databasePath = path.join(workspace, "grimodex.db");
  try {
    const { stdout } = await execFile("sqlite3", [
      "-json",
      databasePath,
      query,
    ]);
    const rows = JSON.parse(String(stdout).trim() || "[]");
    if (!Array.isArray(rows)) {
      throw new Error("sqlite3 returned a non-array snapshot");
    }
    return rows;
  } catch (error) {
    throw new Error(
      `durable Run snapshot requires the sqlite3 test dependency: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function readRunSnapshot(workspace) {
  return readRunSnapshotQuery(
    workspace,
    "SELECT id FROM narrative_extraction_runs ORDER BY created_at, id;",
  );
}

async function readRunLedgerSnapshot(workspace) {
  return readRunSnapshotQuery(
    workspace,
    `SELECT ${RUN_COLUMNS}
       FROM narrative_extraction_runs r
      ORDER BY created_at, id;`,
  );
}

async function countInboxObservations(context) {
  const rows = await context.query(
    `SELECT COUNT(*) AS count
       FROM narrative_maintenance_finding_observations
      WHERE project_id = ?`,
    [context.projectId],
  );
  return Number(rows[0]?.count ?? 0);
}

async function listMaintenanceInbox(context, page = context.page) {
  const value = await context.harness.invokeOk(
    page,
    "narrative_maintenance_inbox_list",
    { payload: { projectId: context.projectId } },
  );
  const entries = Array.isArray(value)
    ? value
    : Array.isArray(value?.entries)
      ? value.entries
      : null;
  if (!entries) {
    throw new Error(
      `narrative_maintenance_inbox_list returned a non-list value: ${JSON.stringify(value)}`,
    );
  }
  return entries;
}

function terminalInboxEntryForRun(entries, failedRun) {
  const expectedConsumerKey = `${failedRun.runKind}:${failedRun.workKey}`;
  return entries.find((entry) => {
    const observation = entry.latest_observation ?? entry.latestObservation;
    const runId = observation?.run_id ?? observation?.runId;
    const findingIdentity =
      observation?.finding_identity ?? observation?.findingIdentity;
    const failureCode = observation?.failure_code ?? observation?.failureCode;
    const consumerKind = entry.consumer_kind ?? entry.consumerKind;
    const consumerKey = entry.consumer_key ?? entry.consumerKey;
    return (
      entry.entry_kind === "terminal-failure" &&
      consumerKind === "narrative-maintenance-failure" &&
      consumerKey === expectedConsumerKey &&
      runId === failedRun.id &&
      findingIdentity &&
      typeof findingIdentity === "string" &&
      findingIdentity.trim() !== "" &&
      failureCode === failedRun.terminalReasonCode
    );
  });
}

async function waitForStableLedger(
  context,
  baselineRows,
  label,
  {
    minimumObservationMs = NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS,
    timeoutMs = minimumObservationMs + 2_000,
  } = {},
) {
  const observationStartedAt = Date.now();
  let previous = null;
  let stableSamples = 0;
  return context.harness.waitUntil(
    async () => {
      const rows = await context.runs();
      const fresh = rowsAfter(rows, baselineRows);
      const signature = JSON.stringify(
        fresh.map((row) => ({
          id: row.id,
          status: row.status,
          terminalReasonCode: row.terminalReasonCode,
          completedAt: row.completedAt,
        })),
      );
      if (signature === previous) stableSamples += 1;
      else stableSamples = 0;
      previous = signature;
      if (
        stableSamples >= 3 &&
        Date.now() - observationStartedAt >= minimumObservationMs
      ) {
        return rows;
      }
      throw new Error(
        `${label}: ledger is still changing; ` +
          `observed=${JSON.stringify(summarizeRuns(rows))}`,
      );
    },
    label,
    timeoutMs,
    100,
  );
}

async function waitForProcessExit(app, label, timeoutMs = 5_000) {
  const child = app?.process?.();
  if (!child)
    throw new Error(`${label}: Electron child process is unavailable`);
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signalCode: child.signalCode };
  }
  const exit = once(child, "exit").then(([exitCode, signalCode]) => ({
    exitCode,
    signalCode,
  }));
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `${label}: test-only process interruption seam was not exercised`,
          ),
        ),
      timeoutMs,
    );
    exit.finally(() => clearTimeout(timer)).catch(() => undefined);
  });
  return Promise.race([exit, timeout]);
}

async function runSchemaBackfillVerify(
  harness,
  configureWorkspace,
  prepareSchemaMarker = prepareLegacySchemaMarker,
  readRunSnapshotFn = readRunSnapshot,
) {
  const id = "c2-5b-schema-backfill-verify";
  return withWorkspace(
    harness,
    configureWorkspace,
    id,
    async (context) => {
      const sourceSchemaVersion = Number(context.setupMetadata ?? 0);
      const marker = await context.query("PRAGMA user_version");
      if (Number(marker[0]?.user_version) <= sourceSchemaVersion) {
        throw new Error(
          `schema marker/open did not migrate the fixture: source=${sourceSchemaVersion}, current=${marker[0]?.user_version}`,
        );
      }
      if (!Number.isSafeInteger(Number(marker[0]?.user_version))) {
        throw new Error("schema marker was not observed through the live DB");
      }
      const migratedMarker = await context.query(
        "SELECT migration_id FROM schema_data_migrations WHERE migration_id = ?",
        ["narrative-c2-finding-identity-v31"],
      );
      if (
        migratedMarker[0]?.migration_id !== "narrative-c2-finding-identity-v31"
      ) {
        throw new Error(
          "schema marker/open did not leave the durable v31 migration marker",
        );
      }
      context.record("schema-marker-observed", {
        sourceSchemaVersion,
        schemaVersion: Number(marker[0].user_version),
        migrationId: migratedMarker[0].migration_id,
      });
      await waitForRunSequence(
        context,
        ["backfill", "dependency-verify"],
        "schema-marker/open",
      );
      context.record("schema-marker-backfill-verify-complete");
    },
    {
      prepareWorkspace: prepareSchemaMarker,
      readRunSnapshotFn,
    },
  );
}

async function restoreBackupThroughSettingsUi(context, backupName) {
  const { page, harness } = context;
  const backups = await harness.invokeOk(page, "list_backups");
  const matchingBackups = Array.isArray(backups)
    ? backups.filter((backup) => backup?.fileName === backupName)
    : [];
  if (matchingBackups.length !== 1) {
    throw new Error(
      `restore UI requires exactly one fixture backup ${backupName}: ${JSON.stringify(backups)}`,
    );
  }

  const settingsButton = page
    .getByRole("button", {
      name: /^(?:Settings|設定)(?: \(update available\)|（更新があります）)?$/,
    })
    .first();
  await settingsButton.click();
  const settingsDialog = page.getByTestId("settings-dialog");
  await settingsDialog.waitFor({ state: "visible" });
  await settingsDialog
    .getByRole("button", { name: "Data", exact: true })
    .click();

  // The component consumes the same Rust list_backups ordering. Re-read it
  // after Data mounted and pin the exact sequence before selecting a row;
  // filenames are intentionally not rendered by the settings UI.
  const uiBackups = await harness.invokeOk(page, "list_backups");
  if (
    !Array.isArray(uiBackups) ||
    uiBackups.length !== backups.length ||
    uiBackups.some(
      (backup, index) => backup?.fileName !== backups[index]?.fileName,
    )
  ) {
    throw new Error(
      `restore UI backup ordering changed while mounting Data: ${JSON.stringify({
        before: backups,
        after: uiBackups,
      })}`,
    );
  }
  const backupIndex = uiBackups.findIndex(
    (backup) => backup?.fileName === backupName,
  );
  if (backupIndex < 0) {
    throw new Error(`restore UI fixture backup disappeared: ${backupName}`);
  }

  const restoreButtons = settingsDialog.getByRole("button", {
    name: /^(?:Restore|復元)$/,
  });
  await restoreButtons.nth(backupIndex).waitFor({ state: "visible" });
  await restoreButtons.nth(backupIndex).click();
  const confirmButton = settingsDialog.getByRole("button", {
    name: /^(?:Replace & restore|全体を置換して復元)$/,
  });
  await confirmButton.waitFor({ state: "visible" });

  // BackupRestoreSection owns the destructive lifecycle: flush pending saves,
  // invoke restore_backup, then reload the renderer. Observe the main-frame
  // navigation and the new document timing rather than bypassing production
  // with a raw restore_backup IPC call.
  const previousTimeOrigin = await page.evaluate(() => performance.timeOrigin);
  const mainFrameReload = page.waitForEvent("framenavigated", {
    predicate: (frame) => frame === page.mainFrame(),
    timeout: 60_000,
  });
  const reload = page.waitForFunction(
    (origin) => performance.timeOrigin !== origin,
    previousTimeOrigin,
    { timeout: 60_000 },
  );
  await confirmButton.click();
  await Promise.all([mainFrameReload, reload]);
  await page.waitForFunction(
    () => globalThis.grimodex?.shell === "electron",
    undefined,
    { timeout: 60_000 },
  );

  // The new document may expose the preload bridge before bootstrap has
  // reopened the workspace. Wait for hydrated workspace chrome; the caller
  // then rebuilds DB context closures against this reloaded page.
  await page
    .getByTestId("workspace-menu-trigger")
    .waitFor({ state: "visible", timeout: 60_000 });
  return { backupIndex };
}

async function runRestoreVerifyRebuildVerify(harness, configureWorkspace) {
  const id = "c2-5b-restore-verify-rebuild-verify";
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace);
  const fixtureEvidence = await seedRestoreFixtureEvidence(
    harness,
    workspace,
    id,
  );
  const preLaunchRuns = await readRunSnapshot(workspace);
  const launched = await withLaunchEnvironment(
    { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
    () => harness.launch(`${id}/open`),
  );
  try {
    const context = await contextForLaunch(
      harness,
      launched,
      workspace,
      id,
      preLaunchRuns,
    );
    // The first real launch starts the Project background Timelapse and the
    // maintenance scheduler concurrently.  Restore must not detach the live
    // DB while either still owns a scoped mutation; wait on their durable
    // completion/cursor contract instead of sleeping for an arbitrary delay.
    await waitForReadiness(context, "restore/pre-restore settled", {
      requireMaintenanceSettled: true,
    });
    const beforeRestoreRuns = await context.runs();
    const beforeEpochs = await context.epochs();
    await restoreBackupThroughSettingsUi(context, fixtureEvidence.backupName);
    let restoredContext;
    let authorityMismatch;
    await harness.waitUntil(
      async () => {
        try {
          const candidate = await contextForLaunch(
            harness,
            launched,
            workspace,
            id,
            beforeRestoreRuns,
          );
          if (candidate.projectId !== context.projectId) {
            authorityMismatch = new Error(
              `restore reload changed project authority: ${context.projectId} -> ${candidate.projectId}`,
            );
            return true;
          }
          restoredContext = candidate;
          return true;
        } catch {
          return false;
        }
      },
      "restore/reload project hydration",
      60_000,
      100,
    );
    if (authorityMismatch) throw authorityMismatch;
    if (!restoredContext) {
      throw new Error("restore reload did not rebind a hydrated project context");
    }
    // The restored fixture intentionally has no post-restore Freshness Run:
    // the automatic restore chain is Verify -> Rebuild -> Verify.  The
    // Settings UI helper and contextForLaunch above already prove renderer /
    // workspace hydration; waitForRestorePhaseRows below is the durable
    // settled boundary for this restored database.
    context.record("restore-epoch-trigger-observed", {
      backupName: fixtureEvidence.backupName,
    });
    const sequence = await waitForRestorePhaseRows(
      restoredContext,
      beforeRestoreRuns,
    );
    const epochs = await restoredContext.epochs();
    const restoreEpoch = assertRestoreVerifyRebuildVerifyCausality(
      sequence,
      beforeEpochs,
      epochs,
    );
    context.record("restore-epoch-verify-rebuild-verify-complete", {
      epochs: [restoreEpoch.id],
      runIds: sequence.map((run) => run.id),
    });
  } finally {
    await harness.close(launched.app, launched.page, `${id}/open`);
  }
}

async function runDigestChangeJourney(
  harness,
  configureWorkspace,
  id,
  coordinate,
) {
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace);
  const baselineLaunch = await withLaunchEnvironment(
    { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
    () => harness.launch(`${id}/baseline`),
  );
  let baselineContext;
  try {
    baselineContext = await contextForLaunch(
      harness,
      baselineLaunch,
      workspace,
      id,
    );
    const baselineRows = await waitForLedger(
      baselineContext,
      (rows) =>
        rows.some(
          (row) =>
            row.runKind === "dependency-verify" && row.status === "completed",
        )
          ? rows
          : null,
      `${coordinate} baseline Verify`,
    );
    baselineContext.baselineRuns = baselineRows;
  } finally {
    await harness.close(
      baselineLaunch.app,
      baselineLaunch.page,
      `${id}/baseline`,
    );
  }

  const changedLaunch = await withLaunchEnvironment(
    {
      trigger: `${coordinate}-changed`,
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    },
    () => harness.launch(`${id}/changed`),
  );
  try {
    const context = await contextForLaunch(
      harness,
      changedLaunch,
      workspace,
      id,
      baselineContext.baselineRuns,
    );
    const rows = await waitForRunSequence(
      context,
      ["dependency-verify"],
      `${coordinate} changed/no-skip`,
    );
    const latest = rows.at(-1);
    if (baselineContext.baselineRuns.some((run) => run.id === latest?.id)) {
      throw new Error(
        `${coordinate} changed journey reused a baseline Run instead of recording a new Run`,
      );
    }
    const previousVerify = [...baselineContext.baselineRuns]
      .reverse()
      .find(
        (run) =>
          run.runKind === "dependency-verify" && run.status === "completed",
      );
    const beforeEvidence = skipEvidenceForRun(
      previousVerify,
      `${coordinate} baseline`,
    );
    const afterEvidence = skipEvidenceForRun(latest, `${coordinate} changed`);
    const changedField = DIGEST_EVIDENCE_FIELD_BY_TRIGGER[coordinate];
    if (
      !changedField ||
      beforeEvidence[changedField] === afterEvidence[changedField]
    ) {
      throw new Error(
        `${coordinate} changed journey did not change exact skipEvidence.${changedField}: ${JSON.stringify(
          {
            before: beforeEvidence,
            after: afterEvidence,
          },
        )}`,
      );
    }
    for (const field of Object.values(DIGEST_EVIDENCE_FIELD_BY_TRIGGER)) {
      if (
        field !== changedField &&
        beforeEvidence[field] !== afterEvidence[field]
      ) {
        throw new Error(
          `${coordinate} changed journey changed an unrelated exact skipEvidence field ${field}: ${JSON.stringify(
            {
              before: beforeEvidence[field],
              after: afterEvidence[field],
            },
          )}`,
        );
      }
    }
    context.record("maintenance-coordinate-changed", {
      coordinate,
      priorRunIds: baselineContext.baselineRuns.map((run) => run.id),
      runId: latest.id,
      beforeEvidence,
      afterEvidence,
    });
  } finally {
    await harness.close(changedLaunch.app, changedLaunch.page, `${id}/changed`);
  }
}

async function runTransientRetry(harness, configureWorkspace) {
  return withWorkspace(
    harness,
    configureWorkspace,
    "c2-5b-transient-bounded-retry",
    async (context) => {
      context.record("transient-fault-requested", {
        fault: "transient-io",
      });
      const rows = await waitForLedger(
        context,
        (allRows) => {
          const fresh = rowsAfter(allRows, context.baselineRuns);
          const failedIndex = fresh.findIndex(
            (row) =>
              row.runKind === "backfill" &&
              row.status === "failed" &&
              row.terminalReasonCode === NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
          );
          if (failedIndex < 0) return null;
          const failed = fresh[failedIndex];
          const failedCreatedAt = parseInstant(
            failed.createdAt,
            "transient failed Run createdAt",
          );
          const completed = fresh.find(
            (row) =>
              row.id !== failed.id &&
              row.runKind === failed.runKind &&
              row.workKey === failed.workKey &&
              row.status === "completed" &&
              compareInstantValues(
                parseInstant(row.createdAt, "transient completed Run createdAt"),
                failedCreatedAt,
              ) > 0,
          );
          return completed ? allRows : null;
        },
        "transient bounded retry",
      );
      const freshAttempts = rowsAfter(rows, context.baselineRuns).filter(
        (row) => row.runKind === "backfill",
      );
      const failedIndex = freshAttempts.findIndex(
        (row) =>
          row.status === "failed" &&
          row.terminalReasonCode === NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
      );
      const failed = failedIndex >= 0 ? freshAttempts[failedIndex] : null;
      const completed = failed
        ? (() => {
            const failedCreatedAt = parseInstant(
              failed.createdAt,
              "transient failed Run createdAt",
            );
            return freshAttempts.find(
              (row) =>
                row.id !== failed.id &&
                row.runKind === failed.runKind &&
                row.workKey === failed.workKey &&
                row.status === "completed" &&
                compareInstantValues(
                  parseInstant(
                    row.createdAt,
                    "transient completed Run createdAt",
                  ),
                  failedCreatedAt,
                ) > 0,
            );
          })()
        : null;
      if (!failed || !completed) {
        throw new Error(
          `transient retry did not produce a failed Run followed by a distinct completed same-work Run: ${JSON.stringify(summarizeRuns(freshAttempts))}`,
        );
      }
      assertTransientAttemptEvidence(failed);
      const sameWorkRuns = freshAttempts.filter(
        (row) =>
          row.runKind === failed.runKind && row.workKey === failed.workKey,
      );
      assertTransientRunSequence(sameWorkRuns);
      const sameWorkRunIds = new Set(sameWorkRuns.map((row) => row.id));
      const sameWorkCreatedAt = sameWorkRuns.map((row) =>
        parseInstant(row.createdAt, "transient same-work Run createdAt"),
      );
      const sameWorkRunsAreOrdered = sameWorkCreatedAt.every(
        (createdAt, index) =>
          index === 0 ||
          compareInstantValues(createdAt, sameWorkCreatedAt[index - 1]) > 0,
      );
      const distinctSameWorkRunCount = sameWorkRunIds.size;
      if (
        sameWorkRunIds.size !== sameWorkRuns.length ||
        sameWorkRuns[0]?.id !== failed.id ||
        !sameWorkRunsAreOrdered ||
        completed.status !== "completed"
      ) {
        throw new Error(
          `transient retry exceeded bounded policy: ${JSON.stringify(summarizeRuns(freshAttempts))}`,
        );
      }
      const inboxCount = await countInboxObservations(context);
      if (inboxCount !== 0) {
        throw new Error(
          "transient retry incorrectly projected a durable Inbox Finding",
        );
      }
      context.record("transient-retry-succeeded", {
        runIds: freshAttempts.map((run) => run.id),
        failedRunId: failed.id,
        completedRunId: completed.id,
        distinctSameWorkRunCount,
      });
    },
    { fault: "transient-io" },
  );
}

async function runTerminalFailureInbox(harness, configureWorkspace) {
  const id = "c2-5b-terminal-failure-inbox";
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace);
  const baselineRuns = await readRunSnapshot(workspace);
  const launched = await withLaunchEnvironment(
    {
      fault: "contract-violation",
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    },
    () => harness.launch(`${id}/open`),
  );
  let failed;
  let originalFindingIdentity;
  try {
    const context = await contextForLaunch(
      harness,
      launched,
      workspace,
      id,
      baselineRuns,
    );
    context.record("terminal-fault-requested", {
      fault: "contract-violation",
    });
    const rows = await waitForLedger(
      context,
      (allRows) => {
        const fresh = rowsAfter(allRows, context.baselineRuns);
        return fresh.find(
          (row) =>
            row.runKind === "backfill" &&
            row.status === "failed" &&
            row.terminalReasonCode ===
              NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE &&
            row.completedAt,
        )
          ? allRows
          : null;
      },
      "terminal contract failure",
    );
    const fresh = rowsAfter(rows, context.baselineRuns);
    failed = fresh.find(
      (row) =>
        row.runKind === "backfill" &&
        row.status === "failed" &&
        row.terminalReasonCode ===
          NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
    );
    assertForegroundLifecycle(failed, "failed", "terminal failed Run");
    assertTerminalFailureEvidence(failed);
    const settledRows = await waitForStableLedger(
      context,
      context.baselineRuns,
      "terminal failure retry boundary",
    );
    const settledFresh = rowsAfter(settledRows, context.baselineRuns);
    if (!settledFresh.some((row) => row.id === failed.id)) {
      throw new Error(
        `terminal failure disappeared from the durable ledger: ${failed.id}`,
      );
    }
    const laterBackfills = terminalRetryCandidates(settledFresh, failed);
    if (laterBackfills.length > 0) {
      throw new Error(
        `terminal contract failure was automatically retried: ${JSON.stringify(summarizeRuns(laterBackfills))}`,
      );
    }
    const inbox = await listMaintenanceInbox(context);
    const inboxEntry = terminalInboxEntryForRun(inbox, failed);
    if (!inboxEntry) {
      throw new Error(
        `terminal failure did not project a matching production Inbox entry: ${JSON.stringify(inbox)}`,
      );
    }
    const repeatedInboxEntry = terminalInboxEntryForRun(
      await listMaintenanceInbox(context),
      failed,
    );
    const firstObservation =
      inboxEntry.latest_observation ?? inboxEntry.latestObservation;
    const repeatedObservation =
      repeatedInboxEntry?.latest_observation ??
      repeatedInboxEntry?.latestObservation;
    const firstIdentity =
      firstObservation?.finding_identity ?? firstObservation?.findingIdentity;
    originalFindingIdentity = firstIdentity;
    if (!originalFindingIdentity || originalFindingIdentity.trim() === "") {
      throw new Error(
        "terminal production Inbox returned an empty original findingIdentity",
      );
    }
    const repeatedIdentity =
      repeatedObservation?.finding_identity ??
      repeatedObservation?.findingIdentity;
    if (!repeatedInboxEntry || firstIdentity !== repeatedIdentity) {
      throw new Error(
        `terminal production Inbox identity was not stable across reads: ${JSON.stringify({
          firstIdentity,
          repeatedIdentity,
        })}`,
      );
    }
    context.record("terminal-failure-inbox-projected", {
      runId: failed.id,
      workKey: failed.workKey,
      terminalReasonCode: failed.terminalReasonCode,
      findingIdentity: firstIdentity,
    });
  } finally {
    await harness.close(launched.app, launched.page, `${id}/open`);
  }

  const reopened = await withLaunchEnvironment(
    { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
    () => harness.launch(`${id}/reopened`),
  );
  try {
    const context = await contextForLaunch(
      harness,
      reopened,
      workspace,
      id,
      baselineRuns,
    );
    const reopenedEntry = await context.harness.waitUntil(
      async () =>
        terminalInboxEntryForRun(
          await listMaintenanceInbox(context, reopened.page),
          failed,
        ) ?? null,
      "terminal production Inbox after reopen",
      NARRATIVE_MAINTENANCE_WAIT_MS,
      100,
    );
    const observation =
      reopenedEntry.latest_observation ?? reopenedEntry.latestObservation;
    const findingIdentity =
      observation?.finding_identity ?? observation?.findingIdentity;
    const reopenedRunId =
      observation?.run_id ?? observation?.runId ?? null;
    const reopenedFailureCode =
      observation?.failure_code ?? observation?.failureCode ?? null;
    const reopenedConsumerKey =
      reopenedEntry.consumer_key ?? reopenedEntry.consumerKey ?? null;
    if (
      !findingIdentity ||
      findingIdentity.trim() === "" ||
      findingIdentity !== originalFindingIdentity ||
      reopenedRunId !== failed.id ||
      reopenedFailureCode !== failed.terminalReasonCode ||
      reopenedConsumerKey !== `${failed.runKind}:${failed.workKey}`
    ) {
      throw new Error(
        `terminal production Inbox changed durable identity after reopen: ${JSON.stringify({
          expected: {
            runId: failed.id,
            consumerKey: `${failed.runKind}:${failed.workKey}`,
            failureCode: failed.terminalReasonCode,
            findingIdentity: originalFindingIdentity,
          },
          actual: {
            reopenedRunId,
            reopenedConsumerKey,
            reopenedFailureCode,
            findingIdentity,
          },
        })}`,
      );
    }
    context.record("terminal-failure-inbox-persisted-after-reopen", {
      runId: failed.id,
      workKey: failed.workKey,
      terminalReasonCode: failed.terminalReasonCode,
      findingIdentity,
    });
  } finally {
    await harness.close(reopened.app, reopened.page, `${id}/reopened`);
  }
}

async function runInterruptedRecovery(harness, configureWorkspace) {
  const id = "c2-5b-interrupted-run-recovery";
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace);
  const baselineRuns = await readRunSnapshot(workspace);

  const interruptedLaunch = await withLaunchEnvironment(
    {
      fault: "process-interruption",
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    },
    () => harness.launch(`${id}/interrupted`),
  );
  let interruptedRun;
  let postExitRuns;
  try {
    // The native interruption seam exits immediately after it durably ACKs
    // the running Run.  Arm and await process exit before touching the page;
    // page-based polling can otherwise race Target closed and hide the real
    // lifecycle failure in teardown.
    const exit = await waitForProcessExit(
      interruptedLaunch.app,
      "process interruption recovery",
    );
    postExitRuns = await readRunLedgerSnapshot(workspace);
    interruptedRun = selectInterruptedRunFromExitSnapshot(
      postExitRuns,
      baselineRuns,
    );
    assertForegroundLifecycle(
      interruptedRun,
      "running",
      "process interruption running Run",
    );
    const staleAtExit = postExitRuns.find(
      (row) => row.id === interruptedRun.id,
    );
    if (!staleAtExit) {
      throw new Error(
        `process interruption lost the running Run before reopen snapshot: ${interruptedRun.id}`,
      );
    }
    const recoveryAtExit = postExitRuns.filter(
      (row) =>
        row.id !== interruptedRun.id &&
        row.runKind === interruptedRun.runKind &&
        row.workKey === interruptedRun.workKey &&
        row.semanticEpochId === interruptedRun.semanticEpochId,
    );
    if (recoveryAtExit.length > 0) {
      throw new Error(
        `process interruption already had a recovery Run before reopen: ${JSON.stringify(
          summarizeRuns(recoveryAtExit),
        )}`,
      );
    }
    harness.recordTimeline("process-interrupted", {
      projectId: interruptedRun.projectId,
      runId: interruptedRun.id,
      postExitRunIds: postExitRuns.map((row) => row.id),
      ...exit,
    });
  } finally {
    await harness
      .close(interruptedLaunch.app, interruptedLaunch.page, `${id}/interrupted`)
      .catch(() => undefined);
  }

  const recoveredLaunch = await withLaunchEnvironment(
    { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
    () => harness.launch(`${id}/recovered`),
  );
  try {
    const recoveredContext = await contextForLaunch(
      harness,
      recoveredLaunch,
      workspace,
      id,
      postExitRuns,
    );
    const recoveryEvidence = await waitForLedger(
      recoveredContext,
      (rows) => {
        const stale = rows.find((row) => row.id === interruptedRun.id);
        if (
          !stale ||
          stale.status !== "failed" ||
          stale.terminalReasonCode !== NARRATIVE_MAINTENANCE_INTERRUPTED_CODE ||
          !stale.completedAt
        ) {
          return null;
        }
        const staleCompletedAt = parseInstant(
          stale.completedAt,
          "interrupted stale Run completedAt",
        );
        const hasRecovery = rowsAfter(rows, postExitRuns).some(
          (row) =>
            row.runKind === stale.runKind &&
            row.workKey === stale.workKey &&
            row.semanticEpochId === stale.semanticEpochId &&
            row.status === "completed" &&
            compareInstantValues(
              parseInstant(row.createdAt, "interruption recovery Run createdAt"),
              staleCompletedAt,
            ) > 0,
        );
        return hasRecovery ? { rows, stale } : null;
      },
      "process interruption durable recovery",
    );
    const stableRows = await waitForStableLedger(
      recoveredContext,
      postExitRuns,
      "process interruption durable recovery settled",
    );
    const {
      stale: staleRun,
    } = recoveryEvidence;
    const recoveryRun = selectInterruptedRecoveryFromStableLedger(
      stableRows,
      postExitRuns,
      staleRun,
    );
    const recoveredRows = stableRows;
    recoveredContext.record("interrupted-run-recovered", {
      interruptedRunId: interruptedRun.id,
      recoveredRunId: recoveryRun.id,
      recoveredRunIds: recoveredRows.map((run) => run.id),
      recoveryEpochId: recoveryRun.semanticEpochId,
    });
  } finally {
    await harness.close(
      recoveredLaunch.app,
      recoveredLaunch.page,
      `${id}/recovered`,
    );
  }
}

async function runNoAutomaticRepair(harness, configureWorkspace) {
  return withWorkspace(
    harness,
    configureWorkspace,
    "c2-5b-no-automatic-repair",
    async (context) => {
      await waitForRunSequence(
        context,
        ["dependency-verify", "semantic-index-rebuild"],
        "automatic Verify/Rebuild without Repair",
      );
      const stableRows = await waitForStableLedger(
        context,
        context.baselineRuns,
        "automatic Verify/Rebuild without Repair settled",
      );
      assertNoAutomaticRepair(stableRows);
      context.record("automatic-repair-absent", {
        runKinds: stableRows.map((row) => row.runKind),
      });
    },
    {
      trigger: "dependency-gap",
      prepareWorkspace: (preparedWorkspace) =>
        seedRestoreFixtureEvidence(
          harness,
          preparedWorkspace,
          "c2-5b-no-automatic-repair",
        ),
    },
  );
}

async function runForegroundWriteWorkspaceWake(harness, configureWorkspace) {
  const id = "c2-5b-foreground-write-workspace-wake";
  const workspaceA = harness.workspacePath(
    "c2-5b-foreground-write-workspace-a",
  );
  const workspaceB = harness.workspacePath(
    "c2-5b-foreground-write-workspace-b",
  );
  const barrierId = `c2-5b-product-journey-barrier-${randomUUID()}`;
  const correlation = `c2-5b-product-journey-correlation-${randomUUID()}`;
  const markerExpectation = {
    barrierId,
    correlation,
    trigger: NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER,
  };
  // Make B the last-active authority. Its ordinary owner-token launch is
  // settled before the foreground seam starts, so startup cannot consume the
  // marked Run intended for the later explicit A open.
  await configureJourneyWorkspace(harness, configureWorkspace, workspaceB, {
    additionalWorkspaces: [workspaceA],
  });

  const settledPrimary = await withLaunchEnvironment(
    { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
    () => harness.launch(`${id}/settle-primary`),
  );
  try {
    const settledContext = await contextForLaunch(
      harness,
      settledPrimary,
      workspaceB,
      id,
    );
    // An empty setup-disabled workspace has no Freshness Run to satisfy the
    // readiness contract. Seed the ordinary B authoring Source before the
    // barrier; this launch is outside the foreground marker seam.
    await createSceneIfNeeded(settledContext, "foreground-primary-settled");
    await waitForReadiness(settledContext, "foreground primary settled", {
      requireMaintenanceSettled: true,
    });
    settledContext.record("foreground-primary-settled", {
      workspace: workspaceB,
    });
  } finally {
    await harness.close(
      settledPrimary.app,
      settledPrimary.page,
      `${id}/settle-primary`,
    );
  }

  // Capture A before its explicit open. A marked row here belongs to an old
  // authority and must fail the fixture rather than satisfy the target gate.
  const targetBaseline = await readRunLedgerSnapshot(workspaceA);
  assertForegroundTargetBaseline(
    targetBaseline,
    markerExpectation,
    "foreground target A",
  );
  const primaryBaseline = await readRunLedgerSnapshot(workspaceB);

  const first = await withLaunchEnvironment(
    {
      trigger: "foreground-workspace-wake",
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
      barrierId,
      correlation,
    },
    () => harness.launch(`${id}/authoring`),
  );
  try {
    const primaryContext = await contextForLaunch(
      harness,
      first,
      workspaceB,
      id,
      primaryBaseline,
    );
    const primaryRows = await primaryContext.runs();
    const primaryMarked = foregroundMarkedRuns(
      primaryRows,
      primaryBaseline,
      markerExpectation,
    );
    if (primaryMarked.length !== 0) {
      throw new Error(
        `foreground startup on settled B consumed the target marker: ${JSON.stringify(
          summarizeRuns(primaryMarked),
        )}`,
      );
    }
    primaryContext.record("foreground-primary-opened-without-marker", {
      workspace: workspaceB,
      baselineRunCount: primaryBaseline.length,
    });

    // Switch through the renderer's canonical WorkspaceMenu/store route. A
    // low-level bridge invoke would change the native authority without
    // publishing the renderer scope, leaving EditorPane's old B load alive
    // while the quiescence lease rejects its sidecar reads.
    const openRequestLowerBound = Date.now();
    const previousRevision = Number(
      await first.page
        .getByTestId("workspace-menu-trigger")
        .getAttribute("data-workspace-open-revision"),
    );
    if (!Number.isSafeInteger(previousRevision)) {
      throw new Error(
        `invalid foreground workspace revision: ${String(previousRevision)}`,
      );
    }
    await first.page.getByTestId("workspace-menu-trigger").click();
    await first.page
      .getByTestId("workspace-menu-dropdown")
      .getByRole("button", { name: path.basename(workspaceA), exact: true })
      .click();
    const workspaceOpenedAt = await harness.waitUntil(
      async () => {
        const triggerText = await first.page
          .getByTestId("workspace-menu-trigger")
          .textContent();
        const revision = Number(
          await first.page
            .getByTestId("workspace-menu-trigger")
            .getAttribute("data-workspace-open-revision"),
        );
        return String(triggerText ?? "").includes(path.basename(workspaceA)) &&
          Number.isSafeInteger(revision) &&
          revision > previousRevision
          ? Date.now()
          : null;
      },
      "foreground target A UI authority",
      30_000,
      100,
    );
    const context = await contextForLaunch(
      harness,
      first,
      workspaceA,
      id,
      targetBaseline,
    );
    const scene = await createForegroundSceneThroughUi(
      context,
      "foreground-authoring",
    );
    const body = `C2-5B-FOREGROUND-${Date.now()}`;
    const wakeBaseline = targetBaseline;
    context.record("workspace-opened-target", {
      workspace: workspaceA,
      workspaceOpenedAt,
      openRequestLowerBound,
      targetBaselineRunCount: targetBaseline.length,
    });
    const schedulerRun = await waitForLedger(
      context,
      (rows) => {
        const marked = foregroundMarkedRuns(
          rows,
          wakeBaseline,
          markerExpectation,
        );
        if (marked.length > 1) {
          throw new Error(
            `foreground wake emitted multiple Runs for one immutable barrier marker: ${JSON.stringify(
              summarizeRuns(marked),
            )}`,
          );
        }
        const candidate = marked[0];
        if (!candidate) return null;
        assertForegroundRunMarker(candidate, markerExpectation);
        if (
          !["backfill", "dependency-verify", "freshness-evaluation"].includes(
            candidate.runKind,
          )
        ) {
          throw new Error(
            `foreground barrier marker was attached to an unexpected Run kind: ${candidate.runKind}`,
          );
        }
        assertWallClockLowerBound(
          candidate.createdAt,
          openRequestLowerBound,
          "foreground barrier marker",
        );
        return candidate.status === "running" ? candidate : null;
      },
      "foreground workspace wake scheduler running barrier",
    );
    const selectedTargetRun = selectForegroundTargetMarker(
      await context.runs(),
      wakeBaseline,
      markerExpectation,
    );
    if (selectedTargetRun.id !== schedulerRun.id) {
      throw new Error(
        `foreground target marker selection changed Run identity: ${JSON.stringify({
          selectedTargetRun: selectedTargetRun.id,
          schedulerRun: schedulerRun.id,
        })}`,
      );
    }
    const originalMarker = assertForegroundRunMarker(
      schedulerRun,
      markerExpectation,
    ).marker;
    const runningBarrier = await waitForLedger(
      context,
      (rows) => {
        const exact = rows.find((row) => row.id === schedulerRun.id);
        if (!exact || exact.status !== "running") return null;
        assertImmutableForegroundMarker(
          exact,
          markerExpectation,
          originalMarker,
          "foreground running Run",
        );
        return exact;
      },
      "foreground workspace wake exact running barrier",
    );
    assertForegroundLifecycle(
      runningBarrier,
      "running",
      "foreground running lifecycle",
    );
    const foregroundWriteStartedAt = Date.now();
    context.record("foreground-write-started-while-scheduler-running", {
      schedulerRunId: runningBarrier.id,
      schedulerRunStatus: runningBarrier.status,
      schedulerRunCreatedAt: runningBarrier.createdAt,
      workspaceOpenedAt,
      openRequestLowerBound,
      foregroundWriteStartedAt,
      barrierId,
      correlation,
    });
    const foregroundPatchStartedAt = Date.now();
    await patchScene(context, scene, body);
    const foregroundPatchCompletedAt = Date.now();
    const runAtPatchCompletion = (await context.runs()).find(
      (row) => row.id === schedulerRun.id,
    );
    if (!runAtPatchCompletion || runAtPatchCompletion.status !== "running") {
      throw new Error(
        `foreground tree_node_patch did not complete while the exact native barrier Run was held: ${JSON.stringify(
          runAtPatchCompletion,
        )}`,
      );
    }
    assertForegroundLifecycle(
      runAtPatchCompletion,
      "running",
      "foreground lifecycle at tree_node_patch completion",
    );
    assertImmutableForegroundMarker(
      runAtPatchCompletion,
      markerExpectation,
      originalMarker,
      "foreground Run at tree_node_patch completion",
    );
    const completedSchedulerRun = await waitForLedger(
      context,
      (rows) => {
        const exact = rows.find((row) => row.id === schedulerRun.id);
        if (!exact || exact.status !== "completed") return null;
        assertImmutableForegroundMarker(
          exact,
          markerExpectation,
          originalMarker,
          "foreground completed Run",
        );
        return exact;
      },
      "foreground workspace wake exact Run completion",
    );
    assertForegroundLifecycle(
      completedSchedulerRun,
      "completed",
      "foreground completed lifecycle",
    );
    try {
      assertWallClockIntervalContains(
        foregroundPatchStartedAt,
        foregroundPatchCompletedAt,
        completedSchedulerRun.startedAt,
        completedSchedulerRun.completedAt,
        "foreground writer",
      );
    } catch (error) {
      throw new Error(
        `foreground writer did not overlap the exact wake Run interval: ${JSON.stringify({
          schedulerRunId: schedulerRun.id,
          schedulerStartedAt: completedSchedulerRun.startedAt,
          foregroundPatchStartedAt,
          foregroundPatchCompletedAt,
          schedulerCompletedAt: completedSchedulerRun.completedAt,
        })}`,
        { cause: error },
      );
    }
    const freshAfterWake = rowsAfter(await context.runs(), wakeBaseline);
    const exactMarkedAfterCompletion = foregroundMarkedRuns(
      freshAfterWake,
      [],
      markerExpectation,
    );
    if (
      exactMarkedAfterCompletion.length !== 1 ||
      exactMarkedAfterCompletion[0]?.id !== schedulerRun.id
    ) {
      throw new Error(
        `foreground wake marker was not unique and immutable after completion: ${JSON.stringify(
          summarizeRuns(exactMarkedAfterCompletion),
        )}`,
      );
    }
    const unrelatedFreshnessRuns = freshAfterWake.filter(
      (row) =>
        row.runKind === "freshness-evaluation" && row.id !== schedulerRun.id,
    );
    if (
      unrelatedFreshnessRuns.some((row) => {
        const marker = foregroundSystemWorkMarker(row);
        return (
          marker?.productJourneyBarrierId === barrierId ||
          marker?.correlation === correlation
        );
      })
    ) {
      throw new Error(
        "foreground wake barrier correlation was reused by an unrelated freshness Run",
      );
    }
    const schedulerOutcomeText = String(
      completedSchedulerRun.outcomeSummaryJson ?? "",
    );
    if (
      completedSchedulerRun.terminalReasonCode ||
      /BUSY_SNAPSHOT|SQLITE_BUSY|error/i.test(schedulerOutcomeText)
    ) {
      throw new Error(
        `workspace wake scheduler Run carried a busy/error outcome: ${JSON.stringify(
          completedSchedulerRun,
        )}`,
      );
    }
    const persisted = await harness.waitUntil(
      async () => {
        const rows = await queryRows(
          harness,
          first.page,
          "SELECT content FROM tree_nodes WHERE id = ? AND project_id = ?",
          [scene.id, context.projectId],
        );
        return String(rows[0]?.content ?? "").includes(body) ? rows[0] : null;
      },
      "foreground authoring body after workspace wake",
      30_000,
      100,
    );
    const cleanFeed = await harness.waitUntil(
      async () => {
        const feedAndCursor = await context.feedAndCursor();
        return feedAndCursor.feedHead ===
          Number(feedAndCursor.cursor?.acknowledgedThrough ?? -1) &&
          isSettledFreshnessCursor(feedAndCursor.cursor)
          ? feedAndCursor
          : null;
      },
      "foreground wake clean cursor",
      NARRATIVE_MAINTENANCE_WAIT_MS,
      100,
    );
    if (
      cleanFeed.feedHead !==
        Number(cleanFeed.cursor?.acknowledgedThrough ?? -1) ||
      !isSettledFreshnessCursor(cleanFeed.cursor)
    ) {
      throw new Error(
        `foreground wake did not release to a clean cursor state: ${JSON.stringify(cleanFeed)}`,
      );
    }
    const runs = await runLedger(harness, first.page, context.projectId);
    context.record("foreground-write-workspace-wake-complete", {
      persisted: Boolean(persisted),
      schedulerRunId: schedulerRun.id,
      barrierId,
      correlation,
      foregroundPatchCompletedAt,
      schedulerCompletedAt: completedSchedulerRun.completedAt,
      runCount: runs.length,
    });
  } finally {
    await harness.close(first.app, first.page, `${id}/authoring`);
  }
}

async function runIncrementalLiveness(harness, configureWorkspace) {
  const id = "c2-5b-incremental-liveness";
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace);
  const first = await withLaunchEnvironment(
    { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
    () => harness.launch(`${id}/before-restart`),
  );
  let beforeContext;
  let beforeReadiness;
  let beforeRuns;
  try {
    beforeContext = await contextForLaunch(harness, first, workspace, id);
    const scene = await createSceneIfNeeded(
      beforeContext,
      "incremental-liveness",
    );
    await patchScene(beforeContext, scene, `C2-5B-LIVENESS-${Date.now()}`);
    beforeReadiness = await waitForReadiness(
      beforeContext,
      "incremental runtime",
    );
    beforeRuns = await beforeContext.runs();
  } finally {
    await harness.close(first.app, first.page, `${id}/before-restart`);
  }

  const restarted = await withLaunchEnvironment(
    { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
    () => harness.launch(`${id}/after-restart`),
  );
  try {
    const afterContext = await contextForLaunch(
      harness,
      restarted,
      workspace,
      id,
      beforeRuns,
    );
    const restartBaselineFeed = await afterContext.feedAndCursor();
    const restartScene = await createSceneIfNeeded(
      afterContext,
      "incremental-liveness-restart",
    );
    const restartBody = `C2-5B-LIVENESS-RESTART-${Date.now()}`;
    await patchScene(afterContext, restartScene, restartBody);
    const afterReadiness = await waitForReadiness(
      afterContext,
      "incremental runtime after restart",
      {
        baselineRuns: beforeRuns,
        minimumFeedHead: restartBaselineFeed.feedHead + 1,
        requireFreshRun: true,
      },
    );
    if (afterReadiness.epoch.id !== beforeReadiness.epoch.id) {
      throw new Error(
        `incremental restart changed the durable current epoch unexpectedly: ${beforeReadiness.epoch.id} -> ${afterReadiness.epoch.id}`,
      );
    }
    if (
      afterReadiness.feedAndCursor.feedHead <=
      restartBaselineFeed.feedHead
    ) {
      throw new Error(
        `incremental restart mutation did not append a new durable change-feed head: ${JSON.stringify({
          before: restartBaselineFeed.feedHead,
          after: afterReadiness.feedAndCursor.feedHead,
        })}`,
      );
    }
    if (
      Number(afterReadiness.feedAndCursor.cursor.acknowledgedThrough) !==
      afterReadiness.feedAndCursor.feedHead
    ) {
      throw new Error(
        `incremental restart cursor is not at feed head: ${JSON.stringify(afterReadiness.feedAndCursor)}`,
      );
    }
    const outcome = parseOutcome(afterReadiness.freshness.outcomeSummaryJson);
    if (!outcome || !afterReadiness.freshness.completedAt) {
      throw new Error(
        `incremental restart lost completed freshness outcome evidence: ${JSON.stringify(afterReadiness.freshness)}`,
      );
    }
    const afterRuns = await afterContext.runs();
    const newFreshnessRun = afterRuns.find(
      (run) => run.id === afterReadiness.freshness.id,
    );
    if (
      !newFreshnessRun ||
      beforeRuns.some((run) => run.id === newFreshnessRun.id)
    ) {
      throw new Error(
        `incremental restart did not persist a new freshness Run after the new mutation: ${JSON.stringify(
          summarizeRuns(afterRuns),
        )}`,
      );
    }
    const restartSceneRows = await afterContext.query(
      "SELECT content FROM tree_nodes WHERE id = ? AND project_id = ?",
      [restartScene.id, afterContext.projectId],
    );
    if (!String(restartSceneRows[0]?.content ?? "").includes(restartBody)) {
      throw new Error(
        "incremental restart mutation body was not durable after the restarted launch",
      );
    }
    if (afterReadiness.feedAndCursor.cursor.lastError != null) {
      throw new Error(
        `incremental restart cursor retained an error after the new mutation: ${JSON.stringify(afterReadiness.feedAndCursor)}`,
      );
    }
    afterContext.record("incremental-liveness-proven", {
      epochId: afterReadiness.epoch.id,
      freshnessRunId: afterReadiness.freshness.id,
      feedHead: afterReadiness.feedAndCursor.feedHead,
      previousFeedHead: restartBaselineFeed.feedHead,
      newMutationBody: restartBody,
      newRunId: newFreshnessRun.id,
    });
  } finally {
    await harness.close(restarted.app, restarted.page, `${id}/after-restart`);
  }
}

export function createNarrativeMaintenanceProductJourneys({
  configureWorkspace,
  prepareSchemaMarker = prepareLegacySchemaMarker,
  readRunSnapshotFn = readRunSnapshot,
}) {
  if (typeof configureWorkspace !== "function") {
    throw new Error("C2-5B product journeys require configureWorkspace");
  }
  return [
    {
      id: "c2-5b-schema-backfill-verify",
      run: (harness) =>
        runSchemaBackfillVerify(
          harness,
          configureWorkspace,
          prepareSchemaMarker,
          readRunSnapshotFn,
        ),
    },
    {
      id: "c2-5b-restore-verify-rebuild-verify",
      run: (harness) =>
        runRestoreVerifyRebuildVerify(harness, configureWorkspace),
    },
    {
      id: "c2-5b-graph-digest-no-skip",
      run: (harness) =>
        runDigestChangeJourney(
          harness,
          configureWorkspace,
          "c2-5b-graph-digest-no-skip",
          "graphContractDigest",
        ),
    },
    {
      id: "c2-5b-rule-digest-no-skip",
      run: (harness) =>
        runDigestChangeJourney(
          harness,
          configureWorkspace,
          "c2-5b-rule-digest-no-skip",
          "ruleRegistryDigest",
        ),
    },
    {
      id: "c2-5b-producer-generation-no-skip",
      run: (harness) =>
        runDigestChangeJourney(
          harness,
          configureWorkspace,
          "c2-5b-producer-generation-no-skip",
          "producerGenerationSetDigest",
        ),
    },
    {
      id: "c2-5b-transient-bounded-retry",
      run: (harness) => runTransientRetry(harness, configureWorkspace),
    },
    {
      id: "c2-5b-terminal-failure-inbox",
      run: (harness) => runTerminalFailureInbox(harness, configureWorkspace),
    },
    {
      id: "c2-5b-interrupted-run-recovery",
      run: (harness) => runInterruptedRecovery(harness, configureWorkspace),
    },
    {
      id: "c2-5b-no-automatic-repair",
      run: (harness) => runNoAutomaticRepair(harness, configureWorkspace),
    },
    {
      id: "c2-5b-foreground-write-workspace-wake",
      run: (harness) =>
        runForegroundWriteWorkspaceWake(harness, configureWorkspace),
    },
    {
      id: "c2-5b-incremental-liveness",
      run: (harness) => runIncrementalLiveness(harness, configureWorkspace),
    },
  ];
}
