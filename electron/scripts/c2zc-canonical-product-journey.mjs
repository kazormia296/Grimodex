import { randomUUID } from "node:crypto";

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

/** Validate marker, epoch, and phase Run identity across restart. */
export function assertC2ZcRestartInvariants({
  open,
  restart,
  phaseRunIds,
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
      restoreEnvironment: { setup: "disabled" },
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
        const runs = await context.runs();
        const epochs = await context.epochs();
        if (markerSnapshot.genericCount < 0 || markerSnapshot.legacyCount < 0) {
          throw new Error("C2-ZC authority counts must be non-negative");
        }
        assertC2ZcOpenPhaseTimeline({
          markerBefore: restoreSnapshot.marker,
          markerAfter: markerSnapshot.marker,
          beforeEpochs,
          afterEpochs: epochs,
          beforeRuns,
          afterRuns: runs,
          phaseRuns,
          restoreEpochId: restoreSnapshot.epochs[1].id,
        });
        openSnapshot = { marker: markerSnapshot.marker, epochs, runs, phaseRuns };
        context.record("c2-zc-canonical-authority-activated", {
          marker: markerSnapshot.marker,
          epochIds: epochs.map((epoch) => epoch.id),
          phaseRunIds: phaseRuns.map((run) => run.id),
          genericCount: markerSnapshot.genericCount,
          legacyCount: markerSnapshot.legacyCount,
          activationOwner: "electron-main:narrativeFreshness->napi",
        });
      },
      onRestart: async ({ context }) => {
        const markerSnapshot = await waitForMarker(harness, context.page, context.projectId);
        const runs = await context.runs();
        const epochs = await context.epochs();
        assertC2ZcRestartInvariants({
          open: openSnapshot,
          restart: { marker: markerSnapshot.marker, epochs, runs },
          phaseRunIds: openSnapshot.phaseRuns.map((run) => run.id),
        });
        context.record("c2-zc-canonical-authority-restarted", {
          marker: markerSnapshot.marker,
          epochIds: epochs.map((epoch) => epoch.id),
          phaseRunIds: openSnapshot.phaseRuns.map((run) => run.id),
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
