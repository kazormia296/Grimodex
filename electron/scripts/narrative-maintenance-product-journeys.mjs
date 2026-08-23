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
  "c2-5b-no-automatic-repair/open",
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
  (SELECT t.input_json
     FROM narrative_extraction_tasks t
    WHERE t.run_id = r.id
    ORDER BY t.created_at ASC, t.id ASC
    LIMIT 1) AS taskInputJson,
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

function assertForegroundLifecycle(run, expectedStatus, label) {
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
  if (typeof run.specJson !== "string" || run.taskInputJson !== run.specJson) {
    throw new Error(
      `${label} Task input did not preserve the full Run spec: ${JSON.stringify({
        runId: run?.id,
        specJson: run?.specJson,
        taskInputJson: run?.taskInputJson,
      })}`,
    );
  }
  if (expectedStatus === "completed") {
    if (
      !run.completedAt ||
      run.taskCompletedAt !== run.completedAt ||
      run.lastAttemptCompletedAt !== run.completedAt
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

function parseInstant(value, label) {
  const timestamp = Date.parse(String(value ?? ""));
  if (!Number.isFinite(timestamp)) {
    throw new Error(`${label} must be a valid RFC3339 timestamp: ${value}`);
  }
  return timestamp;
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
  return run.semanticEpochId
    ? `${base}/epoch/${run.semanticEpochId}`
    : base;
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
    marker.generation < 0
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
    Number(run?.maxAttemptNumber ?? 0) < 2 ||
    Number(run?.attemptCount ?? 0) < 2
  ) {
    throw new Error(
      "transient retry did not record attempt >= 2 on the failed Run",
    );
  }
  return run;
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

async function runLedger(harness, page, projectId) {
  return queryRows(
    harness,
    page,
    `SELECT ${RUN_COLUMNS}
       FROM narrative_extraction_runs r
      WHERE r.project_id = ?
      ORDER BY created_at`,
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
  { baselineRuns = null, minimumFeedHead = 0, requireFreshRun = false } = {},
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
      const ready =
        latestEpoch &&
        latestFreshness?.status === "completed" &&
        (!requireFreshRun || !baselineIds.has(String(latestFreshness.id))) &&
        latestFreshness.semanticEpochId === latestEpoch.id &&
        latestFreshness.completedAt &&
        feedAndCursor.cursor &&
        feedAndCursor.cursor.semanticEpochId === latestEpoch.id &&
        feedAndCursor.feedHead >= minimumFeedHead &&
        Number(feedAndCursor.cursor.acknowledgedThrough) ===
          feedAndCursor.feedHead &&
        feedAndCursor.cursor.activeRunId == null &&
        feedAndCursor.cursor.lastError == null;
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
    `SELECT id, version, content
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
        "SELECT id, version, content FROM tree_nodes WHERE id = ?",
        [sceneId],
      );
      return rows[0] ?? null;
    },
    `${marker} scene persistence`,
    30_000,
    100,
  );
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
    `SELECT id,
            project_id AS projectId,
            run_kind AS runKind,
            work_key AS workKey,
            semantic_epoch_id AS semanticEpochId,
            status,
            created_at AS createdAt,
            completed_at AS completedAt
       FROM narrative_extraction_runs
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

async function runRestoreVerifyRebuildVerify(harness, configureWorkspace) {
  const id = "c2-5b-restore-verify-rebuild-verify";
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace);
  const backupName = await createRestoreBackupFixture(workspace);
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
    const baselineRuns = context.baselineRuns;
    const beforeEpochs = await context.epochs();
    await context.harness.invokeOk(context.page, "restore_backup", {
      fileName: backupName,
    });
    context.record("restore-epoch-trigger-observed", { backupName });
    const sequence = await waitForRunSequence(
      { ...context, baselineRuns },
      ["dependency-verify", "semantic-index-rebuild", "dependency-verify"],
      "restore/epoch verify-first rebuild confirmation",
    );
    const epochs = await context.epochs();
    const newEpochs = epochs.filter(
      (epoch) => !beforeEpochs.some((before) => before.id === epoch.id),
    );
    if (!newEpochs.some((epoch) => epoch.reason === "restore")) {
      throw new Error(
        `restore/epoch journey did not observe a durable restore epoch: ${JSON.stringify(
          {
            beforeEpochs,
            epochs,
          },
        )}`,
      );
    }
    const restoreEpoch = newEpochs.find((epoch) => epoch.reason === "restore");
    if (
      sequence[0]?.semanticEpochId !== restoreEpoch?.id ||
      sequence[1]?.semanticEpochId !== restoreEpoch?.id ||
      sequence[2]?.semanticEpochId !== restoreEpoch?.id
    ) {
      throw new Error(
        `restore/epoch sequence crossed semantic epochs: ${JSON.stringify({
          sequence: summarizeRuns(sequence),
          restoreEpoch,
        })}`,
      );
    }
    context.record("restore-epoch-verify-rebuild-verify-complete", {
      epochs: newEpochs.map((epoch) => epoch.id),
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
              parseInstant(row.createdAt, "transient completed Run createdAt") >
                failedCreatedAt,
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
                parseInstant(
                  row.createdAt,
                  "transient completed Run createdAt",
                ) > failedCreatedAt,
            );
          })()
        : null;
      if (!failed || !completed) {
        throw new Error(
          `transient retry did not produce a failed Run followed by a distinct completed same-work Run: ${JSON.stringify(summarizeRuns(freshAttempts))}`,
        );
      }
      assertTransientAttemptEvidence(failed);
      const maxAttempt = Math.max(
        0,
        ...freshAttempts.map((row) => Number(row.maxAttemptNumber ?? 0)),
      );
      if (
        freshAttempts.length > 3 ||
        maxAttempt > 3 ||
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
        maxAttempt,
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
  let interruptedContext;
  let interruptedRun;
  let postExitRuns;
  try {
    interruptedContext = await contextForLaunch(
      harness,
      interruptedLaunch,
      workspace,
      id,
      baselineRuns,
    );
    interruptedContext.record("interruption-fault-requested", {
      fault: "process-interruption",
    });
    interruptedRun = await waitForLedger(
      interruptedContext,
      (rows) => {
        const fresh = rowsAfter(rows, baselineRuns);
        return (
          fresh.find(
            (row) => row.runKind === "backfill" && row.status === "running",
          ) ?? null
        );
      },
      "process interruption running Run",
    );
    const exit = await waitForProcessExit(
      interruptedLaunch.app,
      "process interruption recovery",
    );
    postExitRuns = await readRunLedgerSnapshot(workspace);
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
    interruptedContext.record("process-interrupted", {
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
        const postExitIds = new Set(postExitRuns.map((row) => row.id));
        const recovery = rows.find(
          (row) =>
            !postExitIds.has(row.id) &&
            row.id !== interruptedRun.id &&
            row.runKind === stale.runKind &&
            row.workKey === stale.workKey &&
            row.semanticEpochId === stale.semanticEpochId &&
            row.status === "completed" &&
            parseInstant(row.createdAt, "interruption recovery Run createdAt") >
              staleCompletedAt,
        );
        return recovery ? { rows, stale, recovery } : null;
      },
      "process interruption durable recovery",
    );
    const { rows: recoveredRows, recovery: recoveryRun } = recoveryEvidence;
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
      const rows = await waitForRunSequence(
        context,
        ["dependency-verify", "semantic-index-rebuild"],
        "automatic Verify/Rebuild without Repair",
      );
      const allRows = await context.runs();
      if (allRows.some((row) => row.runKind === "dependency-repair")) {
        throw new Error(
          "automatic maintenance reached the human-only Repair Run kind",
        );
      }
      context.record("automatic-repair-absent", {
        runKinds: allRows.map((row) => row.runKind),
      });
    },
    { trigger: "dependency-gap" },
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
  await configureJourneyWorkspace(harness, configureWorkspace, workspaceA, {
    additionalWorkspaces: [workspaceB],
  });
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
    const context = await contextForLaunch(harness, first, workspaceA, id);
    const scene = await createSceneIfNeeded(context, "foreground-authoring");
    const body = `C2-5B-FOREGROUND-${Date.now()}`;
    const wakeBaseline = await context.runs();
    await harness.invokeOk(first.page, "open_workspace", {
      path: workspaceB,
    });
    context.record("workspace-switched-to-secondary", {
      workspace: workspaceB,
    });
    const openRequestLowerBound = Date.now();
    await harness.invokeOk(first.page, "open_workspace", {
      path: workspaceA,
    });
    const workspaceOpenedAt = Date.now();
    context.record("workspace-opened-primary", {
      workspace: workspaceA,
      workspaceOpenedAt,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    context.record("workspace-opened-scheduler-grace-elapsed", {
      delayMs: 250,
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
        if (parseInstant(candidate.createdAt, "workspace wake marked Run createdAt") < openRequestLowerBound) {
          throw new Error(
            "foreground barrier marker predates the workspace-open request lower bound",
          );
        }
        return candidate.status === "running" ? candidate : null;
      },
      "foreground workspace wake scheduler running barrier",
    );
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
    const schedulerStartedAt = parseInstant(
      completedSchedulerRun.startedAt,
      "foreground scheduler startedAt",
    );
    const schedulerCompletedAt = parseInstant(
      completedSchedulerRun.completedAt,
      "foreground scheduler completedAt",
    );
    if (
      foregroundPatchStartedAt < schedulerStartedAt ||
      foregroundPatchCompletedAt > schedulerCompletedAt
    ) {
      throw new Error(
        `foreground writer did not overlap the exact wake Run interval: ${JSON.stringify({
          schedulerRunId: schedulerRun.id,
          schedulerStartedAt,
          foregroundPatchStartedAt,
          foregroundPatchCompletedAt,
          schedulerCompletedAt,
        })}`,
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
    const cleanFeed = await context.feedAndCursor();
    if (
      cleanFeed.cursor?.activeRunId != null ||
      cleanFeed.cursor?.lastError != null
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
      schedulerCompletedAt,
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
