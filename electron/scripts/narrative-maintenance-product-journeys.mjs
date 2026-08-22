import { once } from "node:events";
import { execFile as execFileCallback } from "node:child_process";
import { copyFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";

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
export const NARRATIVE_MAINTENANCE_OWNER_TOKEN =
  "c2-5b-product-journey-owner-v1";
export const NARRATIVE_MAINTENANCE_JOURNEY_IDS = Object.freeze([
  "c2-5b-schema-backfill-verify",
  "c2-5b-restore-verify-rebuild-verify",
  "c2-5b-graph-digest-no-skip",
  "c2-5b-rule-digest-no-skip",
  "c2-5b-producer-generation-no-skip",
  "c2-5b-transient-bounded-retry",
  "c2-5b-terminal-failure-inbox",
  "c2-5b-interrupted-run-recovery",
  "c2-5b-no-automatic-repair",
  "c2-5b-foreground-write-workspace-wake",
  "c2-5b-incremental-liveness",
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
  terminal_reason_code AS terminalReasonCode,
  outcome_summary_json AS outcomeSummaryJson,
  spec_digest AS specDigest,
  catalog_digest AS catalogDigest,
  registry_digest AS registryDigest,
  (SELECT COUNT(*)
     FROM narrative_extraction_attempts a
    WHERE a.run_id = r.id) AS attemptCount,
  (SELECT MAX(a.attempt_number)
     FROM narrative_extraction_attempts a
    WHERE a.run_id = r.id) AS maxAttemptNumber`;

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
  return harness.waitUntil(async () => {
    const rows = await queryRows(
      harness,
      page,
      "SELECT id FROM projects ORDER BY created_at, id LIMIT 1",
    );
    const projectId = String(rows[0]?.id ?? "");
    return projectId || null;
  }, "C2-5B product journey project authority", 30_000, 250);
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
      throw new Error(`${label}: skipEvidence.${field} is not a durable string`);
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

async function waitForReadiness(context, label) {
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
        latestFreshness.semanticEpochId === latestEpoch.id &&
        latestFreshness.completedAt &&
        feedAndCursor.cursor &&
        feedAndCursor.cursor.semanticEpochId === latestEpoch.id &&
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
  { fault = null, trigger = null, setup = null, ownerToken = null } = {},
  callback,
) {
  if (!fault && !trigger && !setup && !ownerToken) return callback();
  const previousFault = process.env[NARRATIVE_MAINTENANCE_FAULT_ENV];
  const previousTrigger = process.env[NARRATIVE_MAINTENANCE_TRIGGER_ENV];
  const previousSetup = process.env[NARRATIVE_MAINTENANCE_SETUP_ENV];
  const previousOwnerToken =
    process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
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
  const currentRuns = baselineRuns ?? (await runLedger(harness, launched.page, projectId));
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
  } = {},
) {
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace, {
    additionalWorkspaces,
  });
  const setupMetadata = prepareWorkspace
    ? await prepareWorkspace(workspace)
    : null;
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
      undefined,
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
  await mkdir(backupDirectory, { recursive: true });
  await copyFile(
    path.join(workspace, "grimodex.db"),
    path.join(backupDirectory, backupName),
  );
  return backupName;
}

async function prepareLegacySchemaMarker(workspace) {
  const databasePath = path.join(workspace, "grimodex.db");
  try {
    await execFile("sqlite3", [databasePath, "PRAGMA user_version = 30;"]);
    const { stdout } = await execFile("sqlite3", [
      databasePath,
      "PRAGMA user_version;",
    ]);
    const marker = Number(String(stdout).trim());
    if (marker !== 30) {
      throw new Error(`legacy schema fixture marker was not written: ${marker}`);
    }
    return marker;
  } catch (error) {
    throw new Error(
      `schema marker fixture requires the sqlite3 test dependency: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
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

async function waitForStableLedger(context, baselineRows, label) {
  let previous = null;
  let stableSamples = 0;
  return context.harness.waitUntil(
    async () => {
      const rows = await context.runs();
      const fresh = rowsAfter(rows, baselineRows);
      const signature = JSON.stringify(fresh.map((row) => row.id));
      if (signature === previous) stableSamples += 1;
      else stableSamples = 0;
      previous = signature;
      if (stableSamples >= 3) return rows;
      throw new Error(
        `${label}: ledger is still changing; ` +
          `observed=${JSON.stringify(summarizeRuns(rows))}`,
      );
    },
    label,
    2_000,
    100,
  );
}

async function waitForProcessExit(app, label, timeoutMs = 5_000) {
  const child = app?.process?.();
  if (!child) throw new Error(`${label}: Electron child process is unavailable`);
  if (child.exitCode !== null || child.signalCode !== null) {
    return { exitCode: child.exitCode, signalCode: child.signalCode };
  }
  const exit = once(child, "exit").then(([exitCode, signalCode]) => ({
    exitCode,
    signalCode,
  }));
  const timeout = new Promise((_, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label}: test-only process interruption seam was not exercised`)),
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
      context.record("schema-marker-observed", {
        sourceSchemaVersion,
        schemaVersion: Number(marker[0].user_version),
      });
      await waitForRunSequence(
        context,
        ["backfill", "dependency-verify"],
      "schema-marker/open",
      );
      context.record("schema-marker-backfill-verify-complete");
    },
    { prepareWorkspace: prepareSchemaMarker },
  );
}

async function runRestoreVerifyRebuildVerify(harness, configureWorkspace) {
  const id = "c2-5b-restore-verify-rebuild-verify";
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace);
  const backupName = await createRestoreBackupFixture(workspace);
  const launched = await harness.launch(`${id}/open`);
  try {
    const context = await contextForLaunch(harness, launched, workspace, id);
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
        `restore/epoch journey did not observe a durable restore epoch: ${JSON.stringify({
          beforeEpochs,
          epochs,
        })}`,
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
            row.runKind === "dependency-verify" &&
            row.status === "completed",
        )
          ? rows
          : null,
      `${coordinate} baseline Verify`,
    );
    baselineContext.baselineRuns = baselineRows;
  } finally {
    await harness.close(baselineLaunch.app, baselineLaunch.page, `${id}/baseline`);
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
    if (!changedField || beforeEvidence[changedField] === afterEvidence[changedField]) {
      throw new Error(
        `${coordinate} changed journey did not change exact skipEvidence.${changedField}: ${JSON.stringify({
          before: beforeEvidence,
          after: afterEvidence,
        })}`,
      );
    }
    for (const field of Object.values(DIGEST_EVIDENCE_FIELD_BY_TRIGGER)) {
      if (
        field !== changedField &&
        beforeEvidence[field] !== afterEvidence[field]
      ) {
        throw new Error(
          `${coordinate} changed journey changed an unrelated exact skipEvidence field ${field}: ${JSON.stringify({
            before: beforeEvidence[field],
            after: afterEvidence[field],
          })}`,
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
          return fresh.some(
            (row) => row.runKind === "backfill" && row.status === "completed",
          )
            ? allRows
            : null;
        },
        "transient bounded retry",
      );
      const freshAttempts = rowsAfter(rows, context.baselineRuns).filter(
        (row) => row.runKind === "backfill",
      );
      const maxAttempt = Math.max(
        0,
        ...freshAttempts.map((row) => Number(row.maxAttemptNumber ?? 0)),
      );
      if (
        freshAttempts.length > 3 ||
        maxAttempt > 3 ||
        freshAttempts.at(-1)?.status !== "completed"
      ) {
        throw new Error(
          `transient retry exceeded bounded policy: ${JSON.stringify(summarizeRuns(freshAttempts))}`,
        );
      }
      const inboxCount = await countInboxObservations(context);
      if (inboxCount !== 0) {
        throw new Error("transient retry incorrectly projected a durable Inbox Finding");
      }
      context.record("transient-retry-succeeded", {
        runIds: freshAttempts.map((run) => run.id),
        maxAttempt,
      });
    },
    { fault: "transient-io" },
  );
}

async function runTerminalFailureInbox(harness, configureWorkspace) {
  return withWorkspace(
    harness,
    configureWorkspace,
    "c2-5b-terminal-failure-inbox",
    async (context) => {
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
              String(row.terminalReasonCode ?? "").length > 0,
          )
            ? allRows
            : null;
        },
        "terminal contract failure",
      );
      const fresh = rowsAfter(rows, context.baselineRuns);
      const failed = fresh.find(
        (row) =>
          row.runKind === "backfill" &&
          row.status === "failed" &&
          String(row.terminalReasonCode ?? "").length > 0,
      );
      if (!failed?.terminalReasonCode) {
        throw new Error(
          `terminal failure did not persist an immutable reason code: ${JSON.stringify(summarizeRuns(fresh))}`,
        );
      }
      if (!String(failed.terminalReasonCode).startsWith("NEX_")) {
        throw new Error(
          `terminal failure used a non-contract reason code: ${failed.terminalReasonCode}`,
        );
      }
      const inbox = await context.query(
        `SELECT finding_identity AS findingIdentity, run_id AS runId
           FROM narrative_maintenance_finding_observations
          WHERE project_id = ?
          ORDER BY observed_at, id`,
        [context.projectId],
      );
      if (!inbox.some((row) => row.runId === failed.id)) {
        throw new Error(
          `terminal failure did not project durable Inbox evidence: ${JSON.stringify(inbox)}`,
        );
      }
      const settledRows = await waitForStableLedger(
        context,
        context.baselineRuns,
        "terminal failure retry boundary",
      );
      const laterBackfills = rowsAfter(settledRows, context.baselineRuns).filter(
        (row) =>
          row.runKind === "backfill" &&
          row.createdAt > failed.createdAt &&
          row.id !== failed.id,
      );
      if (laterBackfills.length > 0) {
        throw new Error(
          `terminal contract failure was automatically retried: ${JSON.stringify(summarizeRuns(laterBackfills))}`,
        );
      }
      context.record("terminal-failure-inbox-projected", {
        runId: failed.id,
        terminalReasonCode: failed.terminalReasonCode,
      });
    },
    { fault: "contract-violation" },
  );
}

async function runInterruptedRecovery(harness, configureWorkspace) {
  const id = "c2-5b-interrupted-run-recovery";
  const workspace = harness.workspacePath(id);
  await configureJourneyWorkspace(harness, configureWorkspace, workspace);
  const baselineRuns = [];

  const interruptedLaunch = await withLaunchEnvironment(
    {
      fault: "process-interruption",
      ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    },
    () => harness.launch(`${id}/interrupted`),
  );
  let interruptedContext;
  let interruptedRun;
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
    interruptedContext.record("process-interrupted", {
      runId: interruptedRun.id,
      ...exit,
    });
  } finally {
    await harness.close(
      interruptedLaunch.app,
      interruptedLaunch.page,
      `${id}/interrupted`,
    ).catch(() => undefined);
  }

  const recoveredLaunch = await harness.launch(`${id}/recovered`);
  try {
    const recoveredContext = await contextForLaunch(
      harness,
      recoveredLaunch,
      workspace,
      id,
      baselineRuns,
    );
    const recoveredRows = await waitForLedger(
      recoveredContext,
      (rows) => {
        const fresh = rowsAfter(rows, baselineRuns);
        const stale = fresh.find((row) => row.id === interruptedRun.id);
        const followup = fresh.find(
          (row) =>
            row.id !== interruptedRun.id &&
            ["backfill", "dependency-verify"].includes(row.runKind) &&
            row.status === "completed",
        );
        return stale && stale.status !== "running" && followup ? rows : null;
      },
      "process interruption durable recovery",
    );
    const stale = recoveredRows.find((row) => row.id === interruptedRun.id);
    if (stale?.status === "failed" && !String(stale.terminalReasonCode).includes("INTERRUPT")) {
      throw new Error(
        `interrupted Run was closed without an interruption reason: ${JSON.stringify(stale)}`,
      );
    }
    const fresh = rowsAfter(recoveredRows, baselineRuns);
    recoveredContext.record("interrupted-run-recovered", {
      interruptedRunId: interruptedRun.id,
      recoveredRunIds: fresh.map((run) => run.id),
    });
  } finally {
    await harness.close(recoveredLaunch.app, recoveredLaunch.page, `${id}/recovered`);
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
        throw new Error("automatic maintenance reached the human-only Repair Run kind");
      }
      context.record("automatic-repair-absent", {
        runKinds: allRows.map((row) => row.runKind),
      });
    },
    { trigger: "dependency-gap" },
  );
}

async function runForegroundWriteWorkspaceWake(harness, configureWorkspace) {
  const workspaceA = harness.workspacePath("c2-5b-foreground-write-workspace-a");
  const workspaceB = harness.workspacePath("c2-5b-foreground-write-workspace-b");
  await configureJourneyWorkspace(harness, configureWorkspace, workspaceA, {
    additionalWorkspaces: [workspaceB],
  });
  const first = await harness.launch("c2-5b-foreground-write-workspace-wake/authoring");
  const second = await harness.launch("c2-5b-foreground-write-workspace-wake/wake");
  try {
    const context = await contextForLaunch(harness, first, workspaceA, "wake");
    const scene = await createSceneIfNeeded(context, "foreground-authoring");
    const body = `C2-5B-FOREGROUND-${Date.now()}`;
    const writer = patchScene(context, scene, body);
    const wake = (async () => {
      await harness.invokeOk(second.page, "open_workspace", {
        path: workspaceB,
      });
      await harness.invokeOk(second.page, "open_workspace", {
        path: workspaceA,
      });
    })();
    await Promise.all([writer, wake]);
    const persisted = await harness.waitUntil(async () => {
      const rows = await queryRows(
        harness,
        first.page,
        "SELECT content FROM tree_nodes WHERE id = ? AND project_id = ?",
        [scene.id, context.projectId],
      );
      return String(rows[0]?.content ?? "").includes(body) ? rows[0] : null;
    }, "foreground authoring body after workspace wake", 30_000, 100);
    const runs = await runLedger(harness, first.page, context.projectId);
    const wakeRuns = await runLedger(harness, second.page, context.projectId);
    if (
      [...runs, ...wakeRuns].some((row) =>
        String(row.outcomeSummaryJson).includes("BUSY_SNAPSHOT"),
      )
    ) {
      throw new Error("workspace wake surfaced SQLITE_BUSY_SNAPSHOT in durable Run evidence");
    }
    const persistedOnWake = await harness.waitUntil(async () => {
      const rows = await queryRows(
        harness,
        second.page,
        "SELECT content FROM tree_nodes WHERE id = ? AND project_id = ?",
        [scene.id, context.projectId],
      );
      return String(rows[0]?.content ?? "").includes(body) ? rows[0] : null;
    }, "workspace wake observes foreground body", 30_000, 100);
    context.record("foreground-write-workspace-wake-complete", {
      persisted: Boolean(persisted && persistedOnWake),
      runCount: new Set([...runs, ...wakeRuns].map((row) => row.id)).size,
    });
  } finally {
    await harness.close(
      second.app,
      second.page,
      "c2-5b-foreground-write-workspace-wake/wake",
    );
    await harness.close(
      first.app,
      first.page,
      "c2-5b-foreground-write-workspace-wake/authoring",
    );
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
    const scene = await createSceneIfNeeded(beforeContext, "incremental-liveness");
    await patchScene(beforeContext, scene, `C2-5B-LIVENESS-${Date.now()}`);
    beforeReadiness = await waitForReadiness(beforeContext, "incremental runtime");
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
    const afterReadiness = await waitForReadiness(
      afterContext,
      "incremental runtime after restart",
    );
    if (afterReadiness.epoch.id !== beforeReadiness.epoch.id) {
      throw new Error(
        `incremental restart changed the durable current epoch unexpectedly: ${beforeReadiness.epoch.id} -> ${afterReadiness.epoch.id}`,
      );
    }
    if (afterReadiness.feedAndCursor.feedHead <= 0) {
      throw new Error("incremental restart did not retain a durable change-feed head");
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
    const persistedRun = beforeRuns.find(
      (run) => run.id === afterReadiness.freshness.id,
    );
    if (!persistedRun) {
      throw new Error(
        `incremental restart freshness Run ${afterReadiness.freshness.id} was not durable before restart`,
      );
    }
    afterContext.record("incremental-liveness-proven", {
      epochId: afterReadiness.epoch.id,
      freshnessRunId: afterReadiness.freshness.id,
      feedHead: afterReadiness.feedAndCursor.feedHead,
    });
  } finally {
    await harness.close(restarted.app, restarted.page, `${id}/after-restart`);
  }
}

export function createNarrativeMaintenanceProductJourneys({
  configureWorkspace,
  prepareSchemaMarker = prepareLegacySchemaMarker,
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
