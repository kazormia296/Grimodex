import { createHash, randomUUID } from "node:crypto";

import {
  assertRestoreFixtureEvidence,
  compareInstants,
  parseInstant,
  restoreBackupThroughSettingsUi,
  runRestoreVerifyRebuildVerifyScenario,
} from "./narrative-maintenance-product-journeys.mjs";

const C2ZC_CUTOVER_MIGRATION_ID = "narrative-c2-canonical-freshness-v1";
const C2ZC_CUTOVER_CONTRACT_VERSION = 1;
const C2ZC_FRESHNESS_CONSUMER_KIND = "application";
const C2ZC_WAIT_MS = 60_000;
const C2ZC_PHASE_RUN_KINDS = Object.freeze([
  "dependency-verify",
  "semantic-index-rebuild",
  "dependency-verify",
]);
const C2ZC_IDLE_RUN_KIND = "freshness-evaluation";
const C2ZC_IDLE_TASK_KIND = "incremental-freshness-batch";
const C2ZC_IDLE_TASK_INPUT_KIND = "current-epoch-idle-checkpoint";
const C2ZC_IDLE_SPEC_KIND = "incremental-freshness-idle-checkpoint@1";
const C2ZC_IDLE_HEX_DIGEST = /^sha256:[0-9a-f]{64}$/;
const C2ZC_MAX_IDLE_ATTEMPTS = 3;
const C2ZC_AUTOMATIC_RUN_KINDS = new Set([
  "backfill",
  "dependency-verify",
  "semantic-index-rebuild",
  "dependency-repair",
]);

export const C2ZC_PRODUCT_JOURNEY_ID = "c2-zc-canonical-authority-cutover";
export const C2ZC_PRODUCT_JOURNEY_PHASES = Object.freeze([
  `${C2ZC_PRODUCT_JOURNEY_ID}/restore-fixture`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restore`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/open`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/restart`,
  `${C2ZC_PRODUCT_JOURNEY_ID}/new-project`,
]);

function rowsOf(result) {
  return Array.isArray(result?.rows) ? result.rows : [];
}

async function queryRows(harness, page, sql, params = []) {
  return rowsOf(
    await harness.invokeOk(page, "db_execute", {
      sql,
      params,
      method: "all",
    }),
  );
}

export async function readC2ZcRunLedger(harness, page, projectId, runs) {
  const [taskRows, attemptRows] = await Promise.all([
    queryRows(
      harness,
      page,
      `SELECT t.id,
              t.run_id AS runId,
              t.task_kind AS taskKind,
              t.status,
              t.attempt_count AS attemptCount,
              t.priority,
              t.lease_owner AS leaseOwner,
              t.lease_expires_at AS leaseExpiresAt,
              t.heartbeat_at AS heartbeatAt,
              t.error_message AS errorMessage,
              t.input_json AS inputJson,
              t.output_json AS outputJson,
              t.created_at AS createdAt,
              t.started_at AS startedAt,
              t.completed_at AS completedAt,
              t.version
         FROM narrative_extraction_tasks t
         JOIN narrative_extraction_runs r ON r.id = t.run_id
        WHERE r.project_id = ?
        ORDER BY t.run_id, t.created_at, t.id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT a.id,
              a.task_id AS taskId,
              a.attempt_number AS attemptNumber,
              a.status,
              a.started_at AS startedAt,
              a.completed_at AS completedAt,
              a.error_message AS errorMessage,
              a.output_json AS outputJson,
              a.failure_code AS failureCode,
              a.retry_disposition AS retryDisposition,
              a.policy_version AS policyVersion,
              a.next_attempt_at AS nextAttemptAt
         FROM narrative_extraction_attempts a
         JOIN narrative_extraction_tasks t ON t.id = a.task_id
         JOIN narrative_extraction_runs r ON r.id = t.run_id
        WHERE r.project_id = ?
        ORDER BY t.run_id, a.attempt_number, a.id`,
      [projectId],
    ),
  ]);
  const attemptsByTaskId = new Map();
  for (const attempt of attemptRows) {
    const taskAttempts = attemptsByTaskId.get(attempt.taskId) ?? [];
    taskAttempts.push(attempt);
    attemptsByTaskId.set(attempt.taskId, taskAttempts);
  }
  const tasksByRunId = new Map();
  for (const task of taskRows) {
    const runTasks = tasksByRunId.get(task.runId) ?? [];
    runTasks.push({
      ...task,
      attempts: attemptsByTaskId.get(task.id) ?? [],
    });
    tasksByRunId.set(task.runId, runTasks);
  }
  return rows(runs, "C2-ZC Run ledger").map((run) => ({
    ...run,
    tasks: tasksByRunId.get(run.id) ?? [],
  }));
}

async function createProjectAfterCutover(harness, page) {
  const projectId = `c2-zc-journey-project-${randomUUID()}`;
  const now = new Date().toISOString();
  await harness.invokeOk(page, "project_create", {
    payload: {
      requestId: `c2-zc-journey-project-create:${projectId}`,
      projectId,
      sessionId: C2ZC_PRODUCT_JOURNEY_ID,
      eventUid: `c2-zc-journey-project-create-event:${projectId}`,
      origin: "human",
      originalTransactionId: null,
      undoJournalId: null,
      title: "C2-ZC post-marker project",
      genre: null,
      pov: null,
      tense: null,
      language: "ja",
      styleGuide: null,
      aiInstructions: null,
      outline: null,
      targetReaders: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return projectId;
}

async function readAuthoritySnapshot(harness, page, projectId) {
  const [marker, epochs, runs, generic, legacy] = await Promise.all([
    queryRows(
      harness,
      page,
      `SELECT migration_id AS migrationId,
              contract_version AS contractVersion,
              applied_at AS appliedAt
         FROM schema_data_migrations
        WHERE migration_id = ?`,
      [C2ZC_CUTOVER_MIGRATION_ID],
    ),
    queryRows(
      harness,
      page,
      `SELECT id, project_id AS projectId,
              epoch_number AS epochNumber, reason,
              created_at AS createdAt
         FROM narrative_semantic_epochs
        WHERE project_id = ?
        ORDER BY epoch_number, id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT id, project_id AS projectId,
              run_kind AS runKind, work_key AS workKey, status,
              semantic_epoch_id AS semanticEpochId,
              created_at AS createdAt, started_at AS startedAt,
              completed_at AS completedAt
         FROM narrative_extraction_runs
        WHERE project_id = ?
        ORDER BY created_at, id`,
      [projectId],
    ),
    queryRows(
      harness,
      page,
      `SELECT COUNT(*) AS count
         FROM narrative_consumer_freshness
        WHERE project_id = ? AND consumer_kind = ?`,
      [projectId, C2ZC_FRESHNESS_CONSUMER_KIND],
    ),
    queryRows(
      harness,
      page,
      `SELECT COUNT(*) AS count
         FROM narrative_projection_freshness f
         JOIN narrative_proposal_applications a ON a.id = f.application_id
         JOIN narrative_apply_commits c ON c.id = a.commit_id
        WHERE c.project_id = ?`,
      [projectId],
    ),
  ]);
  return {
    marker: marker[0] ?? null,
    epochs,
    runs,
    genericCount: Number(generic[0]?.count ?? 0),
    legacyCount: Number(legacy[0]?.count ?? 0),
  };
}

async function waitForMarker(harness, page, projectId) {
  return harness.waitUntil(
    async () => {
      const snapshot = await readAuthoritySnapshot(harness, page, projectId);
      return snapshot.marker?.migrationId === C2ZC_CUTOVER_MIGRATION_ID &&
        Number(snapshot.marker.contractVersion) === C2ZC_CUTOVER_CONTRACT_VERSION &&
        snapshot.epochs.length > 0
        ? snapshot
        : null;
    },
    "C2-ZC canonical marker after main scheduler wake",
    C2ZC_WAIT_MS,
    250,
  );
}

function rows(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function initialEpoch(epochs, label) {
  const value = rows(epochs, `${label} Epochs`);
  if (
    value.length !== 1 ||
    value[0]?.epochNumber !== 0 ||
    value[0]?.reason !== "initial" ||
    typeof value[0]?.id !== "string" ||
    value[0].id.trim() === ""
  ) {
    throw new Error(`${label} must contain exactly one initial epoch E0`);
  }
  parseInstant(value[0].createdAt, `${label} E0 createdAt`);
  return value[0];
}

function sameEpochLineage(before, after, label) {
  const left = rows(before, `${label} before Epochs`);
  const right = rows(after, `${label} after Epochs`);
  if (
    left.length !== right.length ||
    right.some(
      (epoch, index) =>
        epoch?.id !== left[index]?.id ||
        Number(epoch?.epochNumber) !== Number(left[index]?.epochNumber) ||
        epoch?.reason !== left[index]?.reason,
    )
  ) {
    throw new Error(`${label} changed the existing Semantic Epoch lineage`);
  }
  return right;
}

/** Validate the pre-cutover WAL-safe E0/B0 image and its real derived gap. */
export function assertC2ZcRestoreBackupFixture(
  snapshot,
  label = "C2-ZC pre-cutover backup",
) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error(`${label} is not an object`);
  }
  if (snapshot.marker !== null) {
    throw new Error(`${label} pre-cutover backup must not contain the C2-ZC marker`);
  }
  const e0 = initialEpoch(snapshot.epochs, label);
  const backfills = rows(
    snapshot.backfillRuns ?? (snapshot.backfill ? [snapshot.backfill] : []),
    `${label} Backfill Runs`,
  );
  const backfill = snapshot.backfill ?? (backfills.length === 1 ? backfills[0] : null);
  if (backfills.length !== 1 || !backfill) {
    throw new Error(`${label} must contain exactly one closed Task and Attempt`);
  }
  if (
    backfill.runKind !== "backfill" ||
    backfill.workKey !== "legacy-dependency-backfill:v3" ||
    backfill.semanticEpochId !== e0.id ||
    backfill.status !== "completed" ||
    backfill.taskKind !== "maintenance-backfill" ||
    backfill.taskStatus !== "completed" ||
    backfill.lastAttemptStatus !== "completed" ||
    Number(backfill.taskCount) !== 1 ||
    Number(backfill.attemptCount) !== 1 ||
    Number(backfill.taskAttemptCount) !== 1 ||
    Number(backfill.lastAttemptNumber) !== 1 ||
    Number(backfill.maxAttemptNumber) !== 1 ||
    typeof backfill.id !== "string" ||
    backfill.id.trim() === "" ||
    (backfill.taskId !== undefined && !backfill.taskId) ||
    (backfill.attemptId !== undefined && !backfill.attemptId)
  ) {
    throw new Error(`${label} must contain exactly one closed Task and Attempt`);
  }
  const expectedProjectId = snapshot.projectId ?? backfill.projectId ?? snapshot.edge?.projectId;
  if (
    typeof expectedProjectId !== "string" ||
    expectedProjectId.trim() === "" ||
    backfill.projectId !== expectedProjectId ||
    snapshot.edge?.projectId !== expectedProjectId
  ) {
    throw new Error(`${label} B0 and canonical Edge must belong to the same project`);
  }
  const lifecycleFields = [
    "createdAt",
    "startedAt",
    "taskCreatedAt",
    "taskStartedAt",
    "lastAttemptStartedAt",
    "lastAttemptCompletedAt",
    "taskCompletedAt",
    "completedAt",
  ];
  for (const field of lifecycleFields) {
    parseInstant(backfill[field], `${label} B0 ${field}`);
  }
  for (let index = 1; index < lifecycleFields.length; index += 1) {
    if (
      compareInstants(
        backfill[lifecycleFields[index - 1]],
        backfill[lifecycleFields[index]],
      ) > 0
    ) {
      throw new Error(`${label} B0 lifecycle timestamps are not monotonic`);
    }
  }
  const edge = snapshot.edge;
  if (!edge || Number(snapshot.derivedState?.edgeCount) !== 1) {
    throw new Error(`${label} derived-state gap requires one canonical Edge`);
  }
  let readSetToken = snapshot.readSetToken;
  if (!readSetToken) {
    try {
      const readSet = JSON.parse(edge.readSetJson);
      readSetToken = Array.isArray(readSet) ? readSet[0] : null;
    } catch {
      readSetToken = null;
    }
  }
  assertRestoreFixtureEvidence([edge], {
    projectId: edge.projectId,
    edgeId: edge.id,
    consumerKey: edge.consumerKey,
    sourceObjectIdentity: edge.sourceObjectIdentity,
    owningRunId: edge.owningRunId,
    readSetToken,
  });
  if (
    Number(snapshot.derivedState?.edgeStateCount) !== 0 ||
    Number(snapshot.derivedState?.freshnessCount) !== 0
  ) {
    throw new Error(`${label} must preserve the canonical Edge while containing a derived-state gap`);
  }
  return { e0, backfill, edge };
}

/** Validate disabled Settings restore: E0/B0 remain and only E1 is minted. */
export function assertC2ZcRestoreStageIsolation({
  setup,
  marker,
  beforeEpochs,
  afterEpochs,
  beforeRuns,
  afterRuns,
  label = "C2-ZC restore stage",
}) {
  if (setup !== "disabled") {
    throw new Error(`${label} must launch with maintenance setup disabled`);
  }
  if (marker !== null) {
    throw new Error(`${label} must not apply the C2-ZC marker during restore`);
  }
  const e0 = initialEpoch(beforeEpochs, `${label} before`);
  const after = rows(afterEpochs, `${label} after Epochs`);
  if (
    after.length !== 2 ||
    after[0]?.id !== e0.id ||
    Number(after[0]?.epochNumber) !== 0 ||
    after[1]?.reason !== "restore" ||
    Number(after[1]?.epochNumber) !== 1 ||
    typeof after[1]?.id !== "string" ||
    after[1].id === e0.id
  ) {
    throw new Error(`${label} must mint exactly E1(reason=restore) while retaining E0`);
  }
  parseInstant(after[1].createdAt, `${label} E1 createdAt`);
  const priorRuns = rows(beforeRuns, `${label} before Runs`);
  const currentRuns = rows(afterRuns, `${label} after Runs`);
  const priorIds = new Set(priorRuns.map((run) => run.id));
  const freshFreshness = currentRuns.filter(
    (run) => !priorIds.has(run.id) && run.runKind === C2ZC_IDLE_RUN_KIND,
  );
  if (freshFreshness.length > 0) {
    throw new Error(`${label} must not run Freshness Runs during restore`);
  }
  const fresh = currentRuns.filter(
    (run) => !priorIds.has(run.id) && C2ZC_AUTOMATIC_RUN_KINDS.has(run.runKind),
  );
  if (fresh.length > 0) {
    throw new Error(`${label} must not run maintenance phases during restore`);
  }
  const b0 = priorRuns.find(
    (run) => run.runKind === "backfill" && run.workKey === "legacy-dependency-backfill:v3",
  );
  const retainedB0 = currentRuns.find((run) => run.id === b0?.id);
  if (!b0 || !retainedB0 || b0.semanticEpochId !== e0.id || retainedB0.semanticEpochId !== e0.id) {
    throw new Error(`${label} must retain the canonical B0 under E0`);
  }
  return after[1];
}

function parseObject(value, label) {
  let parsed = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${label} is not canonical JSON`, { cause: error });
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed;
}

// This is the JS counterpart of the shared Rust digest_plan seam: object keys
// are sorted recursively, arrays retain their order, and the UTF-8 JSON bytes
// are hashed with SHA-256. The idle descriptor contains only JSON-safe integer,
// boolean, and string values, so JSON.stringify has the same number spelling as
// serde_json for this contract.
function canonicalJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Canonical(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex")}`;
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new Error(`${label} has unexpected keys`);
  }
}

function assertOutputMatchesRunOutcome(outputJson, outcome, label) {
  let output;
  try {
    output = parseObject(outputJson, `${label} outputJson`);
  } catch (error) {
    throw new Error(`${label} output JSON does not match Run outcome`, {
      cause: error,
    });
  }
  if (canonicalJson(output) !== canonicalJson(outcome)) {
    throw new Error(`${label} output JSON does not match Run outcome`);
  }
}

function parseCanonicalLifecycleInstant(value, label) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
  ) {
    throw new Error(`${label} must be canonical RFC3339 milliseconds`);
  }
  return parseInstant(value, label);
}

function assertC2ZcIdleCheckpointRun(run, restoreEpochId, label) {
  if (
    run?.runKind !== C2ZC_IDLE_RUN_KIND ||
    run.status !== "completed" ||
    run.semanticEpochId !== restoreEpochId ||
    typeof run.id !== "string" ||
    run.id.trim() === ""
  ) {
    throw new Error(`${label} must be a completed current-E1 Freshness Run`);
  }
  if (run.projectId !== undefined && typeof run.projectId !== "string") {
    throw new Error(`${label} project binding is invalid`);
  }
  if (run.consumerId !== "narrative-incremental-freshness/v1") {
    throw new Error(`${label} consumerId must be narrative-incremental-freshness/v1`);
  }

  const taskRows = Array.isArray(run.tasks) ? run.tasks : [];
  const task = taskRows[0];
  const attempts = Array.isArray(task?.attempts) ? task.attempts : [];
  const taskAttemptCount = Number(task?.attemptCount);
  if (
    taskRows.length !== 1 ||
    !task ||
    typeof task.id !== "string" ||
    task.id.trim() === "" ||
    (task.runId !== undefined && task.runId !== run.id) ||
    task.taskKind !== C2ZC_IDLE_TASK_KIND ||
    task.status !== "completed" ||
    run.taskKind !== task.taskKind ||
    run.taskStatus !== task.status ||
    Number(run.taskCount) !== taskRows.length ||
    Number(run.attemptCount) !== attempts.length ||
    Number(run.taskAttemptCount) !== taskAttemptCount ||
    !Number.isInteger(taskAttemptCount) ||
    taskAttemptCount < 1 ||
    taskAttemptCount > C2ZC_MAX_IDLE_ATTEMPTS ||
    taskAttemptCount !== attempts.length
  ) {
    throw new Error(`${label} Task/Attempt retry topology is invalid`);
  }
  if (task.inputJson !== undefined && task.inputJson !== run.taskInputJson) {
    throw new Error(`${label} Task/Attempt retry topology is invalid`);
  }

  const taskInput = parseObject(run.taskInputJson, `${label} Task input`);
  assertExactKeys(taskInput, [
    "kind",
    "version",
    "projectId",
    "semanticEpochId",
    "fromSequenceExclusive",
    "throughSequenceInclusive",
    "feedHead",
    "inputDigest",
  ], `${label} Task input`);
  if (
    taskInput.kind !== C2ZC_IDLE_TASK_INPUT_KIND ||
    taskInput.version !== 1 ||
    taskInput.semanticEpochId !== restoreEpochId ||
    (run.projectId !== undefined && taskInput.projectId !== run.projectId) ||
    !Number.isSafeInteger(taskInput.feedHead) ||
    taskInput.feedHead < 0 ||
    taskInput.fromSequenceExclusive !== taskInput.feedHead ||
    taskInput.throughSequenceInclusive !== taskInput.feedHead ||
    !C2ZC_IDLE_HEX_DIGEST.test(taskInput.inputDigest)
  ) {
    throw new Error(`${label} Task input is not a tagged zero-width current-E1 checkpoint`);
  }
  const taskInputPayload = { ...taskInput };
  delete taskInputPayload.inputDigest;
  if (sha256Canonical(taskInputPayload) !== taskInput.inputDigest) {
    throw new Error(`${label} Task input digest does not match its canonical payload`);
  }

  const spec = parseObject(run.specJson, `${label} Run spec`);
  assertExactKeys(spec, ["kind", "inputDigest"], `${label} Run spec`);
  if (spec.kind !== C2ZC_IDLE_SPEC_KIND || spec.inputDigest !== taskInput.inputDigest) {
    throw new Error(`${label} Run spec is not bound to the idle Task input`);
  }
  if (!C2ZC_IDLE_HEX_DIGEST.test(run.specDigest ?? "")) {
    throw new Error(`${label} Run specDigest is not a canonical sha256 digest`);
  }
  if (sha256Canonical(spec) !== run.specDigest) {
    throw new Error(`${label} specDigest does not match its canonical spec`);
  }
  const expectedWorkKey =
    `incremental-freshness:${restoreEpochId}:${taskInput.fromSequenceExclusive}:` +
    `${taskInput.throughSequenceInclusive}:${taskInput.inputDigest.slice("sha256:".length)}`;
  if (run.workKey !== expectedWorkKey) {
    throw new Error(`${label} work_key is not bound to the idle Task input`);
  }

  const outcome = parseObject(run.outcomeSummaryJson, `${label} Run outcome`);
  assertExactKeys(outcome, [
    "kind",
    "version",
    "projectId",
    "runId",
    "fromSequenceExclusive",
    "throughSequenceInclusive",
    "affectedEdgeCount",
    "affectedConsumerCount",
    "hasMore",
  ], `${label} Run outcome`);
  if (
    outcome.kind !== C2ZC_IDLE_TASK_INPUT_KIND ||
    outcome.version !== 1 ||
    outcome.projectId !== taskInput.projectId ||
    outcome.runId !== run.id ||
    outcome.fromSequenceExclusive !== taskInput.fromSequenceExclusive ||
    outcome.throughSequenceInclusive !== taskInput.throughSequenceInclusive ||
    outcome.affectedEdgeCount !== 0 ||
    outcome.affectedConsumerCount !== 0 ||
    outcome.hasMore !== false
  ) {
    throw new Error(`${label} outcome is not a zero-width idle checkpoint`);
  }
  assertOutputMatchesRunOutcome(task.outputJson, outcome, `${label} Task`);

  let lifecycle;
  try {
    lifecycle = {
      runCreatedAt: parseCanonicalLifecycleInstant(run.createdAt, `${label} Run.createdAt`),
      runStartedAt: parseCanonicalLifecycleInstant(run.startedAt, `${label} Run.startedAt`),
      taskCreatedAt: parseCanonicalLifecycleInstant(run.taskCreatedAt, `${label} Task.createdAt`),
      taskStartedAt: parseCanonicalLifecycleInstant(run.taskStartedAt, `${label} Task.startedAt`),
      attemptStartedAt: parseCanonicalLifecycleInstant(
        run.lastAttemptStartedAt,
        `${label} Attempt.startedAt`,
      ),
      attemptCompletedAt: parseCanonicalLifecycleInstant(
        run.lastAttemptCompletedAt,
        `${label} Attempt.completedAt`,
      ),
      taskCompletedAt: parseCanonicalLifecycleInstant(
        run.taskCompletedAt,
        `${label} Task.completedAt`,
      ),
      runCompletedAt: parseCanonicalLifecycleInstant(run.completedAt, `${label} Run.completedAt`),
      taskDetailCreatedAt: parseCanonicalLifecycleInstant(
        task.createdAt,
        `${label} Task.createdAt detail`,
      ),
      taskDetailStartedAt: parseCanonicalLifecycleInstant(
        task.startedAt,
        `${label} Task.startedAt detail`,
      ),
      taskDetailCompletedAt: parseCanonicalLifecycleInstant(
        task.completedAt,
        `${label} Task.completedAt detail`,
      ),
    };
  } catch (error) {
    throw new Error(`${label} Task/Attempt lifecycle temporal envelope is invalid`, {
      cause: error,
    });
  }
  if (
    compareInstants(lifecycle.taskCreatedAt, lifecycle.taskDetailCreatedAt) !== 0 ||
    compareInstants(lifecycle.taskStartedAt, lifecycle.taskDetailStartedAt) !== 0 ||
    compareInstants(lifecycle.taskCompletedAt, lifecycle.taskDetailCompletedAt) !== 0
  ) {
    throw new Error(`${label} Task/Attempt lifecycle temporal envelope is invalid`);
  }
  const orderedLifecycle = [
    ["Run.createdAt", lifecycle.runCreatedAt],
    ["Run.startedAt", lifecycle.runStartedAt],
    ["Task.createdAt", lifecycle.taskCreatedAt],
    ["Task.startedAt", lifecycle.taskStartedAt],
    ["Attempt.startedAt", lifecycle.attemptStartedAt],
    ["Attempt.completedAt", lifecycle.attemptCompletedAt],
    ["Task.completedAt", lifecycle.taskCompletedAt],
    ["Run.completedAt", lifecycle.runCompletedAt],
  ];
  for (let index = 1; index < orderedLifecycle.length; index += 1) {
    if (compareInstants(orderedLifecycle[index - 1][1], orderedLifecycle[index][1]) > 0) {
      throw new Error(`${label} Task/Attempt lifecycle temporal envelope is invalid`);
    }
  }

  const attemptIds = new Set();
  let previousStartedAt = lifecycle.taskStartedAt;
  let previousCompletedAt = null;
  let completedAttemptIndex = -1;
  for (const [index, attempt] of attempts.entries()) {
    if (
      typeof attempt?.id !== "string" ||
      attempt.id.trim() === "" ||
      attemptIds.has(attempt.id) ||
      (attempt.taskId !== undefined && attempt.taskId !== task.id) ||
      Number(attempt.attemptNumber) !== index + 1 ||
      !["failed", "completed"].includes(attempt.status)
    ) {
      throw new Error(`${label} Task/Attempt retry topology is invalid`);
    }
    attemptIds.add(attempt.id);
    let startedAt;
    let completedAt;
    try {
      startedAt = parseCanonicalLifecycleInstant(
        attempt.startedAt,
        `${label} Attempt ${index + 1}.startedAt`,
      );
      completedAt = parseCanonicalLifecycleInstant(
        attempt.completedAt,
        `${label} Attempt ${index + 1}.completedAt`,
      );
    } catch (error) {
      throw new Error(`${label} Task/Attempt lifecycle temporal envelope is invalid`, {
        cause: error,
      });
    }
    if (
      compareInstants(startedAt, previousStartedAt) < 0 ||
      (previousCompletedAt && compareInstants(startedAt, previousCompletedAt) < 0) ||
      compareInstants(completedAt, startedAt) < 0
    ) {
      throw new Error(`${label} Task/Attempt retry topology is invalid`);
    }
    if (attempt.status === "failed") {
      if (attempt.outputJson !== null) {
        throw new Error(
          `${label} Task/Attempt retry topology is invalid: failed Attempt outputJson must be NULL`,
        );
      }
      let nextAttemptAt;
      try {
        nextAttemptAt = parseCanonicalLifecycleInstant(
          attempt.nextAttemptAt,
          `${label} Attempt ${index + 1}.nextAttemptAt`,
        );
      } catch (error) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`, {
          cause: error,
        });
      }
      if (
        typeof attempt.failureCode !== "string" ||
        !attempt.failureCode.startsWith("NEX_") ||
        attempt.retryDisposition !== "retryable" ||
        attempt.policyVersion !== "v1" ||
        compareInstants(nextAttemptAt, completedAt) < 0
      ) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`);
      }
      if (completedAttemptIndex >= 0) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`);
      }
    } else {
      if (
        attempt.failureCode != null ||
        attempt.retryDisposition != null ||
        attempt.policyVersion != null ||
        attempt.nextAttemptAt != null
      ) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`);
      }
      if (completedAttemptIndex >= 0) {
        throw new Error(`${label} Task/Attempt retry topology is invalid`);
      }
      completedAttemptIndex = index;
    }
    previousStartedAt = startedAt;
    previousCompletedAt = completedAt;
  }
  if (
    completedAttemptIndex !== attempts.length - 1 ||
    compareInstants(lifecycle.taskCompletedAt, previousCompletedAt) < 0
  ) {
    throw new Error(`${label} Task/Attempt retry topology is invalid`);
  }
  const finalAttempt = attempts.at(-1);
  assertOutputMatchesRunOutcome(
    finalAttempt.outputJson,
    outcome,
    `${label} final Attempt`,
  );
  if (
    Number(run.lastAttemptNumber) !== finalAttempt.attemptNumber ||
    Number(run.maxAttemptNumber) !== finalAttempt.attemptNumber ||
    run.lastAttemptStatus !== finalAttempt.status ||
    compareInstants(run.lastAttemptStartedAt, finalAttempt.startedAt) !== 0 ||
    compareInstants(run.lastAttemptCompletedAt, finalAttempt.completedAt) !== 0
  ) {
    throw new Error(`${label} Task/Attempt retry topology is invalid`);
  }
  return run;
}

/** Validate the exact V/R/V -> one current-E1 idle Freshness -> marker order. */
export function assertC2ZcOpenTotalOrder({
  markerBefore,
  markerAfter,
  beforeEpochs,
  afterEpochs,
  beforeRuns,
  afterRuns,
  phaseRuns,
  idleRun,
  restoreEpochId,
  label = "C2-ZC normal open",
}) {
  const phases = assertC2ZcOpenPhaseTimeline({
    markerBefore,
    markerAfter,
    beforeEpochs,
    afterEpochs,
    beforeRuns,
    afterRuns,
    phaseRuns,
    restoreEpochId,
    label,
  });
  const priorIds = new Set(rows(beforeRuns, `${label} before Runs`).map((run) => run.id));
  const current = rows(afterRuns, `${label} after Runs`).filter(
    (run) => !priorIds.has(run.id),
  );
  const freshnessRuns = current.filter(
    (run) => run.runKind === C2ZC_IDLE_RUN_KIND,
  );
  if (freshnessRuns.length !== 1) {
    throw new Error(`${label} must contain exactly one post-baseline Freshness Run`);
  }
  const observedIdle = freshnessRuns[0];
  if (observedIdle.semanticEpochId !== restoreEpochId) {
    throw new Error(`${label} sole post-baseline Freshness Run must be bound to current E1`);
  }
  if (idleRun && observedIdle.id !== idleRun.id) {
    throw new Error(`${label} idle Freshness identity does not match the observed Run`);
  }
  const validatedIdle = assertC2ZcIdleCheckpointRun(observedIdle, restoreEpochId, `${label} idle Freshness`);
  if (phases.length !== C2ZC_PHASE_RUN_KINDS.length) {
    throw new Error(`${label} maintenance phase rows must remain exactly Verify -> Rebuild -> Verify`);
  }
  if (compareInstants(phases[2].completedAt, validatedIdle.createdAt) >= 0) {
    throw new Error(`${label} idle Freshness must start after confirmation Verify completedAt`);
  }
  const markerAppliedAt = parseInstant(markerAfter.appliedAt, `${label} marker appliedAt`);
  const idleLifecycleFields = [
    "createdAt",
    "startedAt",
    "taskCreatedAt",
    "taskStartedAt",
    "lastAttemptStartedAt",
    "lastAttemptCompletedAt",
    "taskCompletedAt",
    "completedAt",
  ];
  for (const field of idleLifecycleFields) {
    if (
      compareInstants(
        markerAppliedAt,
        parseInstant(validatedIdle[field], `${label} idle Freshness ${field}`),
      ) < 0
    ) {
      throw new Error(`${label} marker must be after idle Task/Attempt lifecycle`);
    }
  }
  if (compareInstants(markerAppliedAt, validatedIdle.completedAt) < 0) {
    throw new Error(`${label} marker must be applied after idle Freshness completedAt`);
  }
  return { phaseRuns: phases, idleRun: validatedIdle };
}

/** Validate exact current-E1 Verify -> Rebuild -> confirmation Verify. */
export function assertC2ZcOpenPhaseTimeline({
  markerBefore,
  markerAfter,
  beforeEpochs,
  afterEpochs,
  beforeRuns,
  afterRuns,
  phaseRuns,
  restoreEpochId,
  label = "C2-ZC normal open",
}) {
  if (markerBefore !== null) {
    throw new Error(`${label} must begin before the C2-ZC marker is applied`);
  }
  if (
    markerAfter?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
    Number(markerAfter?.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION
  ) {
    throw new Error(`${label} did not observe the v1 C2-ZC marker`);
  }
  const markerAppliedAt = parseInstant(markerAfter.appliedAt, `${label} marker appliedAt`);
  const before = rows(beforeEpochs, `${label} before Epochs`);
  const after = rows(afterEpochs, `${label} after Epochs`);
  if (before.length !== 2 || after.length !== 2) {
    throw new Error(`${label} must retain exactly E0 and E1`);
  }
  sameEpochLineage(before, after, label);
  if (!after.find((epoch) => epoch.id === restoreEpochId && epoch.reason === "restore")) {
    throw new Error(`${label} is not bound to the current restore E1`);
  }
  const restoreEpoch = after.find((epoch) => epoch.id === restoreEpochId);
  const restoreCreatedAt = parseInstant(restoreEpoch.createdAt, `${label} E1 createdAt`);
  const phases = rows(phaseRuns, `${label} phase Runs`);
  if (phases.length !== C2ZC_PHASE_RUN_KINDS.length) {
    throw new Error(`${label} must contain exactly current-E1 Verify/Rebuild/Verify`);
  }
  const ids = new Set();
  let previousCreatedAt = null;
  let previousCompletedAt = null;
  for (const [index, run] of phases.entries()) {
    if (run.runKind !== C2ZC_PHASE_RUN_KINDS[index]) {
      throw new Error(`${label} phase order must be Verify -> Rebuild -> confirmation Verify`);
    }
    if (
      typeof run.id !== "string" ||
      run.id.trim() === "" ||
      ids.has(run.id) ||
      run.status !== "completed" ||
      run.semanticEpochId !== restoreEpochId
    ) {
      throw new Error(`${label} phase Runs must be unique, completed, and bound to E1`);
    }
    ids.add(run.id);
    const createdAt = parseInstant(run.createdAt, `${label} phase ${index + 1} createdAt`);
    const completedAt = parseInstant(run.completedAt, `${label} phase ${index + 1} completedAt`);
    if (compareInstants(createdAt, completedAt) >= 0 || compareInstants(createdAt, restoreCreatedAt) < 0) {
      throw new Error(`${label} phase timestamps are invalid for E1`);
    }
    if (
      previousCreatedAt &&
      (compareInstants(createdAt, previousCreatedAt) <= 0 ||
        compareInstants(createdAt, previousCompletedAt) <= 0 ||
        compareInstants(completedAt, previousCompletedAt) <= 0)
    ) {
      throw new Error(`${label} phase timestamps must be strict and non-overlapping`);
    }
    previousCreatedAt = createdAt;
    previousCompletedAt = completedAt;
  }
  const priorIds = new Set(rows(beforeRuns, `${label} before Runs`).map((run) => run.id));
  const current = rows(afterRuns, `${label} after Runs`);
  if (current.some((run) => run.runKind === "backfill" && run.semanticEpochId === restoreEpochId)) {
    throw new Error(`${label} must not mint an E1 Backfill`);
  }
  const fresh = current.filter(
    (run) => !priorIds.has(run.id) && C2ZC_AUTOMATIC_RUN_KINDS.has(run.runKind),
  );
  if (fresh.length !== phases.length || fresh.some((run) => !ids.has(run.id))) {
    throw new Error(`${label} must add exactly the three current-E1 phase Runs`);
  }
  if (
    compareInstants(
      markerAppliedAt,
      phases[2].completedAt,
      `${label} marker appliedAt`,
      `${label} confirmation Verify completedAt`,
    ) <= 0
  ) {
    throw new Error(`${label} marker must be applied after confirmation Verify completedAt`);
  }
  return phases;
}

function assertC2ZcRestartPhaseRows(phaseRuns, restoreEpoch, label) {
  const phases = rows(phaseRuns, `${label} phase Runs`);
  if (phases.length !== C2ZC_PHASE_RUN_KINDS.length) {
    throw new Error(`${label} must preserve exactly Verify -> Rebuild -> Verify`);
  }
  const epochCreatedAt = parseInstant(restoreEpoch.createdAt, `${label} E1 createdAt`);
  const ids = new Set();
  let previousCreatedAt = null;
  let previousCompletedAt = null;
  for (const [index, run] of phases.entries()) {
    if (
      run.runKind !== C2ZC_PHASE_RUN_KINDS[index] ||
      typeof run.id !== "string" ||
      run.id.trim() === "" ||
      ids.has(run.id) ||
      run.status !== "completed" ||
      run.semanticEpochId !== restoreEpoch.id ||
      typeof run.workKey !== "string" ||
      run.workKey.trim() === ""
    ) {
      throw new Error(`${label} persisted phase Run contract is invalid`);
    }
    ids.add(run.id);
    const createdAt = parseInstant(run.createdAt, `${label} phase ${index + 1} createdAt`);
    const completedAt = parseInstant(run.completedAt, `${label} phase ${index + 1} completedAt`);
    if (
      compareInstants(createdAt, epochCreatedAt) < 0 ||
      compareInstants(createdAt, completedAt) >= 0 ||
      (previousCreatedAt &&
        (compareInstants(createdAt, previousCreatedAt) <= 0 ||
          compareInstants(createdAt, previousCompletedAt) <= 0 ||
          compareInstants(completedAt, previousCompletedAt) <= 0))
    ) {
      throw new Error(`${label} persisted phase Run timestamps are invalid`);
    }
    previousCreatedAt = createdAt;
    previousCompletedAt = completedAt;
  }
  return phases;
}

function normalizeC2ZcRunContract(run) {
  const fields = [
    "runKind",
    "projectId",
    "workKey",
    "status",
    "semanticEpochId",
    "consumerId",
    "createdAt",
    "startedAt",
    "completedAt",
    "specJson",
    "specDigest",
    "outcomeSummaryJson",
    "terminalReasonCode",
    "catalogDigest",
    "registryDigest",
    "taskKind",
    "taskStatus",
    "taskCount",
    "attemptCount",
    "taskAttemptCount",
    "lastAttemptStatus",
    "lastAttemptNumber",
    "maxAttemptNumber",
    "taskInputJson",
    "taskCreatedAt",
    "taskStartedAt",
    "taskCompletedAt",
    "lastAttemptStartedAt",
    "lastAttemptCompletedAt",
  ];
  const normalized = Object.fromEntries(
    fields.map((field) => [field, run?.[field] ?? null]),
  );
  normalized.tasks = Array.isArray(run?.tasks)
    ? run.tasks.map((task) => ({
        id: task?.id ?? null,
        runId: task?.runId ?? null,
        taskKind: task?.taskKind ?? null,
        status: task?.status ?? null,
        attemptCount: task?.attemptCount ?? null,
        priority: task?.priority ?? null,
        leaseOwner: task?.leaseOwner ?? null,
        leaseExpiresAt: task?.leaseExpiresAt ?? null,
        heartbeatAt: task?.heartbeatAt ?? null,
        errorMessage: task?.errorMessage ?? null,
        inputJson: task?.inputJson ?? null,
        outputJson: task?.outputJson ?? null,
        createdAt: task?.createdAt ?? null,
        startedAt: task?.startedAt ?? null,
        completedAt: task?.completedAt ?? null,
        version: task?.version ?? null,
        attempts: Array.isArray(task?.attempts)
          ? task.attempts.map((attempt) => ({
              id: attempt?.id ?? null,
              taskId: attempt?.taskId ?? null,
              attemptNumber: attempt?.attemptNumber ?? null,
              status: attempt?.status ?? null,
              startedAt: attempt?.startedAt ?? null,
              completedAt: attempt?.completedAt ?? null,
              errorMessage: attempt?.errorMessage ?? null,
              outputJson: attempt?.outputJson ?? null,
              failureCode: attempt?.failureCode ?? null,
              retryDisposition: attempt?.retryDisposition ?? null,
              policyVersion: attempt?.policyVersion ?? null,
              nextAttemptAt: attempt?.nextAttemptAt ?? null,
            }))
          : null,
      }))
    : null;
  return normalized;
}

/** Validate marker, epoch, and phase Run identity across restart. */
export function assertC2ZcRestartInvariants({
  open,
  restart,
  phaseRunIds,
  idleRunId,
  baselineRuns = [],
  label = "C2-ZC restart",
}) {
  const left = open?.marker;
  const right = restart?.marker;
  if (
    left?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
    Number(left?.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION ||
    right?.migrationId !== left.migrationId ||
    Number(right?.contractVersion) !== Number(left.contractVersion) ||
    right?.appliedAt !== left.appliedAt
  ) {
    throw new Error(`${label} changed marker appliedAt/version across restart`);
  }
  parseInstant(left.appliedAt, `${label} marker appliedAt`);
  const openEpochs = rows(open?.epochs, `${label} open Epochs`);
  const restartEpochs = rows(restart?.epochs, `${label} restart Epochs`);
  if (openEpochs.length !== 2 || restartEpochs.length !== 2) {
    throw new Error(`${label} must preserve E0 and E1 without minting a new epoch`);
  }
  sameEpochLineage(openEpochs, restartEpochs, label);
  const ids = rows(phaseRunIds, `${label} phase Run IDs`);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} phase Run IDs must be unique`);
  const openRuns = rows(open?.runs, `${label} open Runs`);
  const restartRuns = rows(restart?.runs, `${label} restart Runs`);
  const openIds = new Set(
    openRuns
      .filter((run) => C2ZC_AUTOMATIC_RUN_KINDS.has(run.runKind))
      .map((run) => run.id),
  );
  const restartIds = new Set(
    restartRuns
      .filter((run) => C2ZC_AUTOMATIC_RUN_KINDS.has(run.runKind))
      .map((run) => run.id),
  );
  if (
    openIds.size !== restartIds.size ||
    [...openIds].some((id) => !restartIds.has(id)) ||
    ids.some((id) => !openIds.has(id) || !restartIds.has(id))
  ) {
    throw new Error(`${label} did not preserve phase Run IDs without rerunning them`);
  }
  const baselineIds = new Set(rows(baselineRuns, `${label} baseline Runs`).map((run) => run.id));
  const openFreshnessIds = new Set(
    openRuns
      .filter(
        (run) =>
          run.runKind === C2ZC_IDLE_RUN_KIND && !baselineIds.has(run.id),
      )
      .map((run) => run.id),
  );
  const restartFreshnessIds = new Set(
    restartRuns
      .filter(
        (run) =>
          run.runKind === C2ZC_IDLE_RUN_KIND && !baselineIds.has(run.id),
      )
      .map((run) => run.id),
  );
  if (
    openFreshnessIds.size !== 1 ||
    restartFreshnessIds.size !== 1 ||
    [...openFreshnessIds].some((id) => !restartFreshnessIds.has(id))
  ) {
    throw new Error(`${label} post-baseline Freshness Run identities changed across restart`);
  }
  if (typeof idleRunId !== "string" || idleRunId.trim() === "") {
    throw new Error(`${label} requires the current-E1 idle Freshness Run ID`);
  }
  const openIdle = openRuns.filter((run) => run.id === idleRunId);
  const restartIdle = restartRuns.filter((run) => run.id === idleRunId);
  if (
    openIdle.length !== 1 ||
    restartIdle.length !== 1 ||
    openIdle[0]?.runKind !== C2ZC_IDLE_RUN_KIND ||
    restartIdle[0]?.runKind !== C2ZC_IDLE_RUN_KIND ||
    openIdle[0]?.semanticEpochId !== restartEpochs[1]?.id ||
    restartIdle[0]?.semanticEpochId !== restartEpochs[1]?.id
  ) {
    throw new Error(`${label} did not preserve the current-E1 idle Freshness Run ID`);
  }
  const openIdleIds = new Set(
    openRuns
      .filter(
        (run) =>
          run.runKind === C2ZC_IDLE_RUN_KIND &&
          run.semanticEpochId === restartEpochs[1]?.id,
      )
      .map((run) => run.id),
  );
  const restartIdleIds = new Set(
    restartRuns
      .filter(
        (run) =>
          run.runKind === C2ZC_IDLE_RUN_KIND &&
          run.semanticEpochId === restartEpochs[1]?.id,
      )
      .map((run) => run.id),
  );
  if (
    openIdleIds.size !== 1 ||
    restartIdleIds.size !== 1 ||
    [...openIdleIds].some((id) => !restartIdleIds.has(id))
  ) {
    throw new Error(`${label} reran or minted a second current-E1 idle Freshness Run`);
  }
  const restartPhaseRuns = ids.map((id) => restartRuns.find((run) => run.id === id));
  assertC2ZcRestartPhaseRows(
    restartPhaseRuns,
    restartEpochs[1],
    `${label} restart`,
  );
  const restartIdleRun = restartIdle[0];
  assertC2ZcIdleCheckpointRun(
    restartIdleRun,
    restartEpochs[1].id,
    `${label} restart idle Freshness`,
  );
  for (const id of [...ids, idleRunId]) {
    const openRun = openRuns.find((run) => run.id === id);
    const restartRun = restartRuns.find((run) => run.id === id);
    if (
      !openRun ||
      !restartRun ||
      canonicalJson(normalizeC2ZcRunContract(openRun)) !==
        canonicalJson(normalizeC2ZcRunContract(restartRun))
    ) {
      throw new Error(`${label} persisted Run contract changed across restart for ${id}`);
    }
  }
  if (restartRuns.some((run) => run.runKind === "backfill" && run.semanticEpochId === restartEpochs[1].id)) {
    throw new Error(`${label} minted an E1 Backfill during restart`);
  }
  return restart;
}

/** Validate direct post-marker project_create birth. */
export function assertC2ZcPostMarkerProjectBirth({
  marker,
  epochs,
  label = "C2-ZC post-marker project",
}) {
  if (
    marker?.migrationId !== C2ZC_CUTOVER_MIGRATION_ID ||
    Number(marker?.contractVersion) !== C2ZC_CUTOVER_CONTRACT_VERSION
  ) {
    throw new Error(`${label} requires the applied v1 C2-ZC marker and exactly one initial epoch`);
  }
  parseInstant(marker.appliedAt, `${label} marker appliedAt`);
  return initialEpoch(epochs, label);
}

/**
 * Exercise the production Settings restore, normal scheduler open, restart,
 * and direct post-marker project_create. No cutover IPC or marker write is
 * available to this runner; those remain main/N-API production ownership.
 */
export async function runC2ZcCanonicalAuthorityJourney(
  harness,
  configureWorkspace,
) {
  let restoreSnapshot = null;
  let openSnapshot = null;
  let projectId = null;
  const scenario = await runRestoreVerifyRebuildVerifyScenario(
    harness,
    configureWorkspace,
    {
      id: C2ZC_PRODUCT_JOURNEY_ID,
      restorePhase: "restore",
      openPhase: "open",
      restartPhase: "restart",
      restoreEnvironment: {
        setup: "disabled",
        freshness: "disabled",
      },
      restoreThroughSettingsUi: restoreBackupThroughSettingsUi,
      onFixture: ({ fixtureEvidence }) => {
        assertC2ZcRestoreBackupFixture(fixtureEvidence.backupContract);
        harness.recordTimeline("c2-zc-pre-cutover-backup-ready", {
          projectId: fixtureEvidence.backupContract.projectId,
          epochIds: fixtureEvidence.backupContract.epochs.map((epoch) => epoch.id),
          backfillRunId: fixtureEvidence.backupContract.backfill?.id,
          edgeId: fixtureEvidence.backupContract.edge?.id,
          derivedState: fixtureEvidence.backupContract.derivedState,
        });
      },
      onRestore: async ({ context, setup, beforeRuns, beforeEpochs }) => {
        const observed = await readAuthoritySnapshot(
          harness,
          context.page,
          context.projectId,
        );
        const e1 = assertC2ZcRestoreStageIsolation({
          setup,
          marker: observed.marker,
          beforeEpochs,
          afterEpochs: observed.epochs,
          beforeRuns,
          afterRuns: observed.runs,
        });
        projectId = context.projectId;
        restoreSnapshot = {
          marker: observed.marker,
          epochs: observed.epochs,
          runs: observed.runs,
        };
        context.record("c2-zc-restore-stage-isolated", {
          setup,
          epochIds: observed.epochs.map((epoch) => epoch.id),
          restoreEpochId: e1.id,
          marker: observed.marker,
          runIds: observed.runs.map((run) => run.id),
        });
      },
      onOpen: async ({ context, beforeRuns, beforeEpochs, phaseRuns }) => {
        const markerSnapshot = await waitForMarker(harness, context.page, context.projectId);
        const runs = await readC2ZcRunLedger(
          harness,
          context.page,
          context.projectId,
          await context.runs(),
        );
        const epochs = await context.epochs();
        if (markerSnapshot.genericCount < 0 || markerSnapshot.legacyCount < 0) {
          throw new Error("C2-ZC authority counts must be non-negative");
        }
        const totalOrder = assertC2ZcOpenTotalOrder({
          markerBefore: restoreSnapshot.marker,
          markerAfter: markerSnapshot.marker,
          beforeEpochs,
          afterEpochs: epochs,
          beforeRuns,
          afterRuns: runs,
          phaseRuns,
          restoreEpochId: restoreSnapshot.epochs[1].id,
        });
        openSnapshot = {
          marker: markerSnapshot.marker,
          epochs,
          runs,
          beforeRuns,
          phaseRuns: totalOrder.phaseRuns,
          idleRun: totalOrder.idleRun,
        };
        context.record("c2-zc-canonical-authority-activated", {
          marker: markerSnapshot.marker,
          epochIds: epochs.map((epoch) => epoch.id),
          phaseRunIds: totalOrder.phaseRuns.map((run) => run.id),
          idleRunId: totalOrder.idleRun.id,
          genericCount: markerSnapshot.genericCount,
          legacyCount: markerSnapshot.legacyCount,
          activationOwner: "electron-main:narrativeFreshness->napi",
        });
      },
      onRestart: async ({ context }) => {
        const markerSnapshot = await waitForMarker(harness, context.page, context.projectId);
        const runs = await readC2ZcRunLedger(
          harness,
          context.page,
          context.projectId,
          await context.runs(),
        );
        const epochs = await context.epochs();
        assertC2ZcRestartInvariants({
          open: openSnapshot,
          restart: { marker: markerSnapshot.marker, epochs, runs },
          phaseRunIds: openSnapshot.phaseRuns.map((run) => run.id),
          idleRunId: openSnapshot.idleRun.id,
          baselineRuns: openSnapshot.beforeRuns,
        });
        context.record("c2-zc-canonical-authority-restarted", {
          marker: markerSnapshot.marker,
          epochIds: epochs.map((epoch) => epoch.id),
          phaseRunIds: openSnapshot.phaseRuns.map((run) => run.id),
          idleRunId: openSnapshot.idleRun.id,
        });
      },
    },
  );
  if (!projectId || !restoreSnapshot || !openSnapshot || !scenario.restart) {
    throw new Error("C2-ZC shared restore scenario did not complete all authority phases");
  }

  const launched = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/new-project`);
  try {
    const newProjectId = await createProjectAfterCutover(harness, launched.page);
    const snapshot = await harness.waitUntil(
      async () => {
        const value = await readAuthoritySnapshot(harness, launched.page, newProjectId);
        return value.epochs.length === 1 ? value : null;
      },
      "C2-ZC post-marker project initial epoch",
      C2ZC_WAIT_MS,
      250,
    );
    const epoch = assertC2ZcPostMarkerProjectBirth(snapshot);
    harness.recordTimeline("c2-zc-post-marker-project-created", {
      projectId: newProjectId,
      epochId: epoch.id,
      epochCount: snapshot.epochs.length,
    });
  } finally {
    await harness.close(launched.app, launched.page, `${C2ZC_PRODUCT_JOURNEY_ID}/new-project`);
  }
}
