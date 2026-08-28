import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { performance } from "node:perf_hooks";

import {
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  withLaunchEnvironmentForTest,
} from "./narrative-maintenance-product-journeys.mjs";

export const C2ZC_RENDERER_MCP_DML_DENIAL_ID = "c2-zc-renderer-mcp-dml-denial";

// This lane owns a separate diagnostic namespace.  DML probes must never be
// reported as canonical cutover work: a denial probe is a boundary check, not
// an authority transition.
export const C2ZC_RENDERER_MCP_DML_DENIAL_PHASES = Object.freeze([
  "c2-zc-renderer-mcp-dml-denial/open",
  "c2-zc-renderer-mcp-dml-denial/restart",
]);
export const C2ZC_RENDERER_DML_PHASE_ALLOWLIST = Object.freeze([
  ...C2ZC_RENDERER_MCP_DML_DENIAL_PHASES,
]);

export const C2ZC_NATIVE_OWNED_TABLE_NAMES = Object.freeze([
  "narrative_semantic_epochs",
  "narrative_extraction_runs",
  "narrative_dependency_edges",
  "narrative_dependency_edge_states",
  "narrative_consumer_freshness",
  "narrative_semantic_index_metadata",
  "narrative_maintenance_finding_lifecycle",
  "narrative_maintenance_finding_observations",
  "narrative_maintenance_repair_leases",
]);

function tableContract(name, updateColumn, primaryKeyColumns) {
  const columns = Object.freeze([...primaryKeyColumns]);
  const snapshotOrderSql = columns
    .map((column) => `${quoteIdentifier(column)} ASC`)
    .join(", ");
  return Object.freeze({
    name,
    updateColumn,
    primaryKeyColumns: columns,
    snapshotOrderSql: `ORDER BY ${snapshotOrderSql}`,
  });
}

export const C2ZC_RENDERER_TABLE_CONTRACTS = Object.freeze([
  tableContract("narrative_semantic_epochs", "id", ["id"]),
  tableContract("narrative_extraction_runs", "id", ["id"]),
  tableContract("narrative_dependency_edges", "id", ["id"]),
  tableContract("narrative_dependency_edge_states", "edge_id", ["edge_id"]),
  tableContract("narrative_consumer_freshness", "project_id", [
    "project_id",
    "consumer_kind",
    "consumer_key",
  ]),
  tableContract("narrative_semantic_index_metadata", "project_id", [
    "project_id",
    "index_key",
  ]),
  tableContract("narrative_maintenance_finding_lifecycle", "id", ["id"]),
  tableContract("narrative_maintenance_finding_observations", "id", ["id"]),
  tableContract("narrative_maintenance_repair_leases", "project_id", [
    "project_id",
  ]),
]);

export const C2ZC_MCP_GENERIC_SQL_CONTRACT = Object.freeze({
  productionToolName: null,
  productionRoute: null,
  status: "not-exposed",
  canonicalRustSource: "src-tauri/crates/grimodex-db/src/execute.rs",
  canonicalRustTest:
    "c2zc_native_owned_tables_reject_all_untrusted_dml_but_allow_reads_and_trusted_writes",
  origin: "SqlOrigin::McpGeneric",
});

export const C2ZC_FRESHNESS_CURSOR_CONSUMER_ID =
  "narrative-incremental-freshness/v1";

function quoteIdentifier(identifier) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

// A renderer-visible quiescence observation must cover every persisted
// maintenance writer state, including future non-interpretation Run kinds.
// Keeping the predicate writer-oriented avoids silently missing a new
// maintenance kind while leaving ordinary interpretation Runs out of scope.
export const C2ZC_RENDERER_QUIESCENCE_QUERIES = Object.freeze({
  projects: `SELECT id
               FROM projects
              ORDER BY id`,
  feed: `SELECT project_id AS projectId,
                COALESCE(MAX(canonical_sequence), 0) AS feedHead
           FROM narrative_change_events
          GROUP BY project_id
          ORDER BY project_id`,
  freshnessCursors: `SELECT project_id AS projectId,
                            consumer_id AS consumerId,
                            acknowledged_through_sequence AS acknowledgedThrough,
                            semantic_epoch_id AS semanticEpochId,
                            active_run_id AS activeRunId,
                            reserved_through_sequence AS reservedThrough,
                            lease_owner AS leaseOwner,
                            lease_expires_at AS leaseExpiresAt,
                            last_error AS lastError
                       FROM narrative_change_cursors
                      WHERE consumer_id = '${C2ZC_FRESHNESS_CURSOR_CONSUMER_ID}'
                      ORDER BY project_id`,
  activeRuns: `SELECT id,
                      project_id AS projectId,
                      run_kind AS runKind,
                      status,
                      started_at AS startedAt
                 FROM narrative_extraction_runs
                WHERE run_kind <> 'interpretation'
                  AND status IN ('pending', 'running')
                ORDER BY project_id, created_at, id`,
  activeTasks: `SELECT t.id,
                       t.run_id AS runId,
                       r.project_id AS projectId,
                       t.task_kind AS taskKind,
                       t.status,
                       t.lease_owner AS leaseOwner,
                       t.lease_expires_at AS leaseExpiresAt
                  FROM narrative_extraction_tasks t
             LEFT JOIN narrative_extraction_runs r ON r.id = t.run_id
                 WHERE (r.id IS NULL OR r.run_kind <> 'interpretation')
                   AND t.status IN ('queued', 'running')
                 ORDER BY COALESCE(r.project_id, ''), t.created_at, t.id`,
  activeAttempts: `SELECT a.id,
                          a.task_id AS taskId,
                          t.run_id AS runId,
                          r.project_id AS projectId,
                          a.status,
                          a.started_at AS startedAt
                     FROM narrative_extraction_attempts a
                LEFT JOIN narrative_extraction_tasks t ON t.id = a.task_id
                LEFT JOIN narrative_extraction_runs r ON r.id = t.run_id
                    WHERE (r.id IS NULL OR r.run_kind <> 'interpretation')
                      AND a.status = 'running'
                    ORDER BY COALESCE(r.project_id, ''), a.started_at, a.id`,
  reservations: `SELECT project_id AS projectId,
                        consumer_id AS consumerId,
                        semantic_epoch_id AS semanticEpochId,
                        active_run_id AS activeRunId,
                        reserved_through_sequence AS reservedThrough,
                        lease_owner AS leaseOwner,
                        lease_expires_at AS leaseExpiresAt
                   FROM narrative_change_cursors
                  WHERE semantic_epoch_id IS NOT NULL
                     OR active_run_id IS NOT NULL
                     OR reserved_through_sequence IS NOT NULL
                     OR lease_owner IS NOT NULL
                     OR lease_expires_at IS NOT NULL
                  ORDER BY project_id, consumer_id`,
  repairLeases: `SELECT project_id AS projectId,
                        lease_owner AS leaseOwner,
                        verify_run_id AS verifyRunId,
                        active_run_id AS activeRunId,
                        semantic_epoch_id AS semanticEpochId,
                        claimed_at AS claimedAt,
                        expires_at AS expiresAt
                   FROM narrative_maintenance_repair_leases
                  ORDER BY project_id`,
  pendingWakeOutbox: `SELECT id,
                              project_id AS projectId,
                              operation,
                              reason,
                              created_at AS createdAt
                         FROM narrative_maintenance_wake_outbox
                        WHERE acked_at IS NULL
                        ORDER BY project_id, created_at, id`,
  epochs: `SELECT id,
                  project_id AS projectId,
                  epoch_number AS epochNumber,
                  created_at AS createdAt
             FROM narrative_semantic_epochs
            ORDER BY project_id, epoch_number, id`,
  terminalRuns: `SELECT id,
                        project_id AS projectId,
                        run_kind AS runKind,
                        consumer_id AS consumerId,
                        work_key AS workKey,
                        status,
                        semantic_epoch_id AS semanticEpochId,
                        spec_json AS specJson,
                        spec_digest AS specDigest,
                        scope_json AS scopeJson,
                        created_at AS createdAt,
                        started_at AS startedAt,
                        completed_at AS completedAt,
                        terminal_reason_code AS terminalReasonCode,
                        outcome_summary_json AS outcomeSummaryJson
                   FROM narrative_extraction_runs
                  WHERE run_kind <> 'interpretation'
                  ORDER BY project_id, created_at, id`,
  tasks: `SELECT t.id,
                 t.run_id AS runId,
                 t.task_kind AS taskKind,
                 t.status,
                 t.input_json AS inputJson,
                 t.output_json AS outputJson,
                 t.attempt_count AS attemptCount,
                 t.created_at AS createdAt,
                 t.started_at AS startedAt,
                 t.completed_at AS completedAt,
                 t.error_message AS errorMessage
            FROM narrative_extraction_tasks t
            JOIN narrative_extraction_runs r ON r.id = t.run_id
           WHERE r.run_kind <> 'interpretation'
           ORDER BY t.run_id, t.created_at, t.id`,
  attempts: `SELECT a.id,
                    a.task_id AS taskId,
                    a.attempt_number AS attemptNumber,
                    a.status,
                    a.started_at AS startedAt,
                    a.completed_at AS completedAt,
                    a.output_json AS outputJson,
                    a.error_message AS errorMessage,
                    a.failure_code AS failureCode,
                    a.retry_disposition AS retryDisposition,
                    a.policy_version AS policyVersion,
                    a.next_attempt_at AS nextAttemptAt
               FROM narrative_extraction_attempts a
               JOIN narrative_extraction_tasks t ON t.id = a.task_id
               JOIN narrative_extraction_runs r ON r.id = t.run_id
              WHERE r.run_kind <> 'interpretation'
              ORDER BY t.run_id, a.attempt_number, a.id`,
  freshnessEvidence: `SELECT project_id AS projectId,
                            consumer_kind AS consumerKind,
                            consumer_key AS consumerKey,
                            evidence_freshness AS evidenceFreshness,
                            build_action AS buildAction,
                            semantic_epoch_id AS semanticEpochId,
                            last_evaluated_run_id AS lastEvaluatedRunId,
                            dependency_set_digest AS dependencySetDigest,
                            updated_at AS updatedAt
                       FROM narrative_consumer_freshness
                      ORDER BY project_id, consumer_kind, consumer_key`,
  marker: `SELECT migration_id AS migrationId,
                  contract_version AS contractVersion,
                  applied_at AS appliedAt
            FROM schema_data_migrations
           WHERE migration_id = 'narrative-c2-canonical-freshness-v1'
            ORDER BY applied_at DESC`,
});

export const C2ZC_RENDERER_DML_EVIDENCE_VERSION = 2;
export const C2ZC_RENDERER_DML_TIMELINE_EVENT =
  "c2-zc-renderer-dml-quiescence-settled";

const C2ZC_RENDERER_QUIESCENCE_WAIT_MS = 60_000;
const C2ZC_RENDERER_QUIESCENCE_INTERVAL_MS = 100;
export const C2ZC_RENDERER_QUIESCENCE_REDISCOVERY_DELAY_MS = 250;
export const C2ZC_RENDERER_QUIESCENCE_MIN_STABLE_MS = 500;
export const C2ZC_RENDERER_QUIESCENCE_MAX_SAMPLE_GAP_MS = 500;

export const C2ZC_RENDERER_MCP_DML_DENIAL_CATALOG_ENTRY = Object.freeze({
  id: C2ZC_RENDERER_MCP_DML_DENIAL_ID,
  domains: Object.freeze(["narrative-maintenance", "sqlite"]),
  interactions: Object.freeze(["narrative-maintenance->sqlite"]),
  contracts: Object.freeze([
    "c2-zc:renderer-dml-denial",
    "c2-zc:mcp-generic-rust-dml-denial",
  ]),
  capabilities: Object.freeze(["electron", "napi"]),
  description:
    "renderer db_execute zero-row DML denial across C2-ZC tables; McpGeneric remains Rust-only",
  phases: C2ZC_RENDERER_MCP_DML_DENIAL_PHASES,
  mcpGeneric: C2ZC_MCP_GENERIC_SQL_CONTRACT,
});

const RENDERER_DML_OPERATIONS = Object.freeze([
  Object.freeze({
    name: "INSERT",
    sql: (table) =>
      `INSERT INTO "${table}" SELECT * FROM "${table}" WHERE 0 = ?`,
  }),
  Object.freeze({
    name: "UPDATE",
    sql: (table, updateColumn) =>
      `UPDATE "${table}" SET "${updateColumn}" = "${updateColumn}" WHERE 0 = ?`,
  }),
  Object.freeze({
    name: "DELETE",
    sql: (table) => `DELETE FROM "${table}" WHERE 0 = ?`,
  }),
  Object.freeze({
    name: "REPLACE",
    sql: (table) =>
      `REPLACE INTO "${table}" SELECT * FROM "${table}" WHERE 0 = ?`,
  }),
]);

export const C2ZC_RENDERER_DML_OPERATIONS = RENDERER_DML_OPERATIONS;

function quoteTableName(table) {
  return quoteIdentifier(table);
}

function rowsOf(result, label) {
  if (!result || typeof result !== "object" || !Array.isArray(result.rows)) {
    throw new Error(`${label} did not return a rows[] result`);
  }
  return result.rows;
}

async function readRows(harness, page, sql, label) {
  return rowsOf(
    await harness.invokeOk(page, "db_execute", {
      sql,
      params: [],
      method: "all",
    }),
    label,
  );
}

async function snapshotTable(harness, page, table) {
  const quoted = quoteTableName(table.name);
  return readRows(
    harness,
    page,
    `SELECT * FROM ${quoted} ${table.snapshotOrderSql}`,
    `SELECT ${table.name}`,
  );
}

async function snapshotTables(harness, page) {
  const snapshot = {};
  for (const table of C2ZC_RENDERER_TABLE_CONTRACTS) {
    snapshot[table.name] = await snapshotTable(harness, page, table);
  }
  return snapshot;
}

function nullableLedgerInteger(value, label) {
  if (value === null) return null;
  if (value === undefined || value === "") {
    throw new Error(`${label} returned a missing cursor integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} returned an invalid cursor integer`);
  }
  return number;
}

function nullableLedgerIdentifier(value, label) {
  if (value === null) return null;
  if (value === undefined) {
    throw new Error(`${label} returned a missing identifier`);
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\u0000")
  ) {
    throw new Error(`${label} returned an invalid identifier`);
  }
  return value;
}

function requireWorkspaceBinding(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !==
      JSON.stringify(["authorityId", "generation"]) ||
    typeof value.authorityId !== "string" ||
    value.authorityId.trim() !== value.authorityId ||
    value.authorityId.length === 0 ||
    value.authorityId.includes("\u0000") ||
    !Number.isSafeInteger(value.generation) ||
    value.generation <= 0
  ) {
    throw new Error(
      "narrative_extraction_capture_workspace_binding returned an invalid binding",
    );
  }
  return {
    authorityId: value.authorityId,
    generation: value.generation,
  };
}

async function readWorkspaceLedger(harness, page) {
  const [projectRows, feedRows, cursorRows, epochRows, markerRows] =
    await Promise.all([
      readRows(
        harness,
        page,
        C2ZC_RENDERER_QUIESCENCE_QUERIES.projects,
        "workspace projects",
      ),
      readRows(
        harness,
        page,
        C2ZC_RENDERER_QUIESCENCE_QUERIES.feed,
        "workspace Change Feed",
      ),
      readRows(
        harness,
        page,
        C2ZC_RENDERER_QUIESCENCE_QUERIES.freshnessCursors,
        "workspace Freshness cursors",
      ),
      readRows(
        harness,
        page,
        C2ZC_RENDERER_QUIESCENCE_QUERIES.epochs,
        "workspace Semantic Epochs",
      ),
      readRows(
        harness,
        page,
        C2ZC_RENDERER_QUIESCENCE_QUERIES.marker,
        "workspace cutover marker",
      ),
    ]);

  const projects = projectRows.map((row) => row?.id);
  if (
    projects.length === 0 ||
    projects.some(
      (projectId) =>
        typeof projectId !== "string" ||
        projectId.length === 0 ||
        projectId.trim() !== projectId ||
        projectId.includes("\u0000"),
    ) ||
    new Set(projects).size !== projects.length ||
    projects.some(
      (projectId, index) => index > 0 && projectId <= projects[index - 1],
    )
  ) {
    throw new Error(
      "workspace ledger projects are not non-empty, sorted, and unique",
    );
  }

  const byProject = new Map(
    projects.map((projectId) => [
      projectId,
      {
        projectId,
        currentEpochId: null,
        feedHead: 0,
        cursor: {
          acknowledgedThrough: null,
          reservedThrough: null,
          activeRunId: null,
          semanticEpochId: null,
          lastError: null,
        },
      },
    ]),
  );
  const feedProjects = new Set();
  for (const row of feedRows) {
    const project = byProject.get(row?.projectId);
    if (!project || feedProjects.has(row.projectId)) {
      throw new Error(
        "workspace ledger has an unknown or duplicate feed project",
      );
    }
    feedProjects.add(row.projectId);
    project.feedHead = requiredNonNegativeInteger(
      row.feedHead,
      `workspace feed ${row.projectId}`,
    );
  }
  const cursorProjects = new Set();
  for (const row of cursorRows) {
    const project = byProject.get(row?.projectId);
    if (!project || row.consumerId !== C2ZC_FRESHNESS_CURSOR_CONSUMER_ID) {
      throw new Error("workspace ledger has an unknown Freshness cursor");
    }
    if (cursorProjects.has(row.projectId)) {
      throw new Error("workspace ledger has duplicate Freshness cursor");
    }
    cursorProjects.add(row.projectId);
    project.cursor = {
      acknowledgedThrough: nullableLedgerInteger(
        row.acknowledgedThrough,
        `workspace cursor ${row.projectId}`,
      ),
      reservedThrough: nullableLedgerInteger(
        row.reservedThrough,
        `workspace cursor ${row.projectId}`,
      ),
      activeRunId: nullableLedgerIdentifier(
        row.activeRunId,
        `workspace cursor ${row.projectId} activeRunId`,
      ),
      semanticEpochId: nullableLedgerIdentifier(
        row.semanticEpochId,
        `workspace cursor ${row.projectId} semanticEpochId`,
      ),
      lastError: nullableLedgerIdentifier(
        row.lastError,
        `workspace cursor ${row.projectId} lastError`,
      ),
    };
  }
  for (const row of epochRows) {
    const project = byProject.get(row?.projectId);
    if (
      !project ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      row.id.trim() !== row.id ||
      row.id.includes("\u0000")
    ) {
      throw new Error(
        "workspace ledger has an invalid or unknown Epoch project",
      );
    }
    const epochNumber = Number(row.epochNumber);
    if (!Number.isSafeInteger(epochNumber) || epochNumber <= 0) {
      throw new Error(`workspace epoch ${row.projectId} has an invalid number`);
    }
    if (
      project.currentEpochId === null ||
      epochNumber > Number(project.currentEpochNumber ?? -1) ||
      (epochNumber === Number(project.currentEpochNumber) &&
        row.id > project.currentEpochId)
    ) {
      project.currentEpochId = row.id;
      project.currentEpochNumber = epochNumber;
    }
  }
  for (const project of byProject.values()) delete project.currentEpochNumber;

  if (markerRows.length > 1) {
    throw new Error("workspace ledger has duplicate cutover markers");
  }
  const markerRow = markerRows[0] ?? null;
  const marker = markerRow
    ? {
        migrationId: markerRow.migrationId,
        contractVersion: Number(markerRow.contractVersion),
        appliedAt: markerRow.appliedAt,
      }
    : null;
  if (
    marker &&
    (marker.migrationId !== "narrative-c2-canonical-freshness-v1" ||
      marker.contractVersion !== 1 ||
      !validTimestamp(marker.appliedAt))
  ) {
    throw new Error("workspace ledger has an invalid cutover marker");
  }
  return {
    projects: [...byProject.values()],
    marker,
  };
}

export function assertQuiescenceLedgerMatches(receipt, ledger, label) {
  const state = receipt?.state;
  if (!state || !Array.isArray(state.projects)) {
    throw new Error(`${label} is missing core quiescence state.projects`);
  }
  if (canonicalJson(state.projects) !== canonicalJson(ledger.projects)) {
    throw new Error(
      `${label} state.projects does not match the live DB ledger`,
    );
  }
  if (canonicalJson(state.marker) !== canonicalJson(ledger.marker)) {
    throw new Error(`${label} marker does not match the live DB ledger`);
  }
  return receipt;
}

function requiredProjectId(row, label) {
  if (typeof row?.projectId !== "string" || row.projectId.length === 0) {
    throw new Error(`${label} returned a row without a projectId`);
  }
  return row.projectId;
}

function requiredNonNegativeInteger(value, label) {
  if (value === null || value === undefined || value === "") {
    throw new Error(`${label} returned a missing integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error(`${label} returned an invalid integer: ${String(value)}`);
  }
  return number;
}

function readFeedAndCursorState(feedRows, cursorRows) {
  const feedByProject = new Map();
  for (const row of feedRows) {
    const projectId = requiredProjectId(row, "narrative_change_events");
    if (feedByProject.has(projectId)) {
      throw new Error(`duplicate Change Feed project row: ${projectId}`);
    }
    feedByProject.set(projectId, {
      projectId,
      feedHead: requiredNonNegativeInteger(
        row.feedHead,
        `Change Feed ${projectId}`,
      ),
    });
  }

  const cursorByProject = new Map();
  for (const row of cursorRows) {
    const projectId = requiredProjectId(row, "narrative_change_cursors");
    if (row.consumerId !== C2ZC_FRESHNESS_CURSOR_CONSUMER_ID) {
      throw new Error(
        `unexpected Freshness cursor consumer: ${String(row.consumerId)}`,
      );
    }
    if (cursorByProject.has(projectId)) {
      throw new Error(`duplicate Freshness cursor row: ${projectId}`);
    }
    cursorByProject.set(projectId, {
      ...row,
      projectId,
      acknowledgedThrough: requiredNonNegativeInteger(
        row.acknowledgedThrough,
        `Freshness cursor ${projectId}`,
      ),
    });
  }

  const projectIds = new Set([
    ...feedByProject.keys(),
    ...cursorByProject.keys(),
  ]);
  const mismatches = [];
  for (const projectId of [...projectIds].sort()) {
    const feedHead = feedByProject.get(projectId)?.feedHead ?? 0;
    const cursor = cursorByProject.get(projectId);
    if (!cursor) {
      if (feedHead !== 0) {
        mismatches.push({
          projectId,
          reason: "freshness-cursor-missing",
          feedHead,
        });
      }
      continue;
    }
    if (cursor.acknowledgedThrough !== feedHead) {
      mismatches.push({
        projectId,
        reason: "feed-head-not-acknowledged",
        feedHead,
        acknowledgedThrough: cursor.acknowledgedThrough,
      });
    }
    if (
      cursor.semanticEpochId !== null ||
      cursor.activeRunId !== null ||
      cursor.reservedThrough !== null ||
      cursor.leaseOwner !== null ||
      cursor.leaseExpiresAt !== null ||
      cursor.lastError !== null
    ) {
      mismatches.push({
        projectId,
        reason: "freshness-cursor-not-released",
      });
    }
  }

  return {
    feed: [...feedByProject.values()],
    cursors: [...cursorByProject.values()],
    mismatches,
    consistent: mismatches.length === 0,
  };
}

function activeRepairLeases(rows, observedAt) {
  const observedTime = Date.parse(observedAt);
  return rows.filter((row) => {
    if (row.expiresAt === null || row.expiresAt === undefined) return true;
    const expiresAt = Date.parse(String(row.expiresAt));
    return (
      !Number.isFinite(observedTime) ||
      !Number.isFinite(expiresAt) ||
      expiresAt > observedTime
    );
  });
}

function compareLedgerInstants(left, right) {
  const leftTime = Date.parse(String(left ?? ""));
  const rightTime = Date.parse(String(right ?? ""));
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime)) {
    return leftTime - rightTime;
  }
  return String(left ?? "").localeCompare(String(right ?? ""));
}

function completedRun(run) {
  return (
    run?.status === "completed" &&
    typeof run.id === "string" &&
    Number.isFinite(Date.parse(String(run.completedAt ?? "")))
  );
}

function sameSemanticEpoch(left, right) {
  return (
    typeof left === "string" &&
    left.length > 0 &&
    typeof right === "string" &&
    right.length > 0 &&
    left === right
  );
}

function parseObjectJson(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256Json(value) {
  return `sha256:${createHash("sha256")
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function canonicalRunWorkKey(run) {
  if (
    typeof run?.projectId !== "string" ||
    typeof run?.runKind !== "string" ||
    typeof run?.workKey !== "string"
  ) {
    return null;
  }
  const base = `narrative-maintenance:v1/${run.runKind}/${run.projectId}/${run.workKey}`;
  if (run.runKind === "backfill") return base;
  if (
    (run.runKind === "dependency-verify" ||
      run.runKind === "semantic-index-rebuild") &&
    typeof run.semanticEpochId !== "string"
  ) {
    return null;
  }
  return run.semanticEpochId ? `${base}/epoch/${run.semanticEpochId}` : base;
}

function canonicalRunBaseSpec(runKind) {
  switch (runKind) {
    case "backfill":
      return { backfillAlgorithmVersion: "3" };
    case "dependency-verify":
      return { verifyContractVersion: "1" };
    case "semantic-index-rebuild":
      return {};
    default:
      return null;
  }
}

function validSystemWorkMarker(run) {
  const spec = parseObjectJson(run?.specJson);
  const marker = spec?.systemWork;
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return false;
  }
  if (
    marker.trigger !== "workspace-opened" ||
    typeof marker.authorityId !== "string" ||
    marker.authorityId.trim() === "" ||
    !Number.isSafeInteger(marker.generation) ||
    marker.generation <= 0 ||
    typeof marker.productJourneyBarrierId !== "string" ||
    marker.productJourneyBarrierId.trim() === "" ||
    typeof marker.correlation !== "string" ||
    marker.correlation.trim() === ""
  ) {
    return false;
  }
  return marker.canonicalWorkKey === canonicalRunWorkKey(run);
}

function validCanonicalRunSpec(run) {
  const base = canonicalRunBaseSpec(run?.runKind);
  if (!base) return false;
  const parsed = parseObjectJson(run.specJson);
  if (!parsed || !validSystemWorkMarker(run)) return false;
  const { systemWork: _systemWork, ...specWithoutMarker } = parsed;
  if (canonicalJson(specWithoutMarker) !== canonicalJson(base)) return false;
  return run.specDigest === sha256Json(base);
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function timestampAtOrAfter(left, right) {
  return (
    validTimestamp(left) &&
    validTimestamp(right) &&
    Date.parse(left) >= Date.parse(right)
  );
}

function timestampStrictlyAfter(left, right) {
  return (
    validTimestamp(left) &&
    validTimestamp(right) &&
    Date.parse(left) > Date.parse(right)
  );
}

function validRunTaskAttemptLifecycle(
  run,
  tasks = [],
  attempts = [],
  {
    requireInputMatch = true,
    expectedTaskKind = null,
    coordinates = null,
    requireOutputMatch = false,
  } = {},
) {
  const matchingTasks = tasks.filter((task) => task?.runId === run?.id);
  if (matchingTasks.length !== 1) return false;
  const task = matchingTasks[0];
  const lifecycleTaskKind =
    expectedTaskKind ??
    {
      backfill: "maintenance-backfill",
      "dependency-verify": "maintenance-dependency-verify",
      "semantic-index-rebuild": "maintenance-semantic-index-rebuild",
      "freshness-evaluation": "incremental-freshness-batch",
    }[run.runKind];
  if (
    task.taskKind !== lifecycleTaskKind ||
    task.status !== "completed" ||
    (requireInputMatch && task.inputJson !== run.specJson)
  ) {
    return false;
  }
  if (!requireInputMatch) {
    const taskInput = parseObjectJson(task.inputJson);
    if (!taskInput) return false;
    if (
      requireOutputMatch &&
      (Object.keys(taskInput).sort().join(",") !==
        ["changeSetId", "fromSequenceExclusive", "throughSequenceInclusive"]
          .sort()
          .join(",") ||
        typeof taskInput.changeSetId !== "string" ||
        taskInput.changeSetId.trim() === "")
    ) {
      return false;
    }
    const from = taskInput.from ?? taskInput.fromSequenceExclusive;
    const through = taskInput.through ?? taskInput.throughSequenceInclusive;
    if (
      coordinates &&
      (Number(from) !== Number(coordinates.from) ||
        Number(through) !== Number(coordinates.through))
    ) {
      return false;
    }
  }
  const outcome = requireOutputMatch
    ? parseObjectJson(run.outcomeSummaryJson)
    : null;
  if (requireOutputMatch && !outcome) return false;
  const matchingAttempts = attempts
    .filter((attempt) => attempt?.taskId === task.id)
    .toSorted(
      (left, right) => Number(left.attemptNumber) - Number(right.attemptNumber),
    );
  const attemptCount = Number(task.attemptCount);
  if (
    !Number.isSafeInteger(attemptCount) ||
    attemptCount < 1 ||
    attemptCount > 3 ||
    matchingAttempts.length !== attemptCount
  ) {
    return false;
  }
  for (const [index, attempt] of matchingAttempts.entries()) {
    if (Number(attempt.attemptNumber) !== index + 1) return false;
    if (
      !validTimestamp(attempt.startedAt) ||
      !validTimestamp(attempt.completedAt)
    ) {
      return false;
    }
    if (!timestampAtOrAfter(attempt.completedAt, attempt.startedAt))
      return false;
    if (index > 0) {
      const previousAttempt = matchingAttempts[index - 1];
      if (!timestampAtOrAfter(attempt.startedAt, previousAttempt.completedAt)) {
        return false;
      }
      if (
        previousAttempt.nextAttemptAt !== null &&
        previousAttempt.nextAttemptAt !== undefined &&
        !timestampAtOrAfter(attempt.startedAt, previousAttempt.nextAttemptAt)
      ) {
        return false;
      }
    }
    if (index < matchingAttempts.length - 1 && attempt.status !== "failed") {
      return false;
    }
    if (
      index === matchingAttempts.length - 1 &&
      attempt.status !== "completed"
    ) {
      return false;
    }
    if (attempt.status === "failed") {
      if (
        typeof attempt.failureCode !== "string" ||
        !attempt.failureCode.startsWith("NEX_") ||
        attempt.retryDisposition !== "retryable" ||
        attempt.policyVersion !== "v1" ||
        !validTimestamp(attempt.nextAttemptAt) ||
        !timestampAtOrAfter(attempt.nextAttemptAt, attempt.completedAt) ||
        (requireOutputMatch && attempt.outputJson !== null)
      ) {
        return false;
      }
    } else if (
      attempt.failureCode !== null &&
      attempt.failureCode !== undefined
    ) {
      return false;
    } else if (
      attempt.retryDisposition !== null &&
      attempt.retryDisposition !== undefined
    ) {
      return false;
    } else if (
      attempt.policyVersion !== null &&
      attempt.policyVersion !== undefined
    ) {
      return false;
    } else if (
      attempt.nextAttemptAt !== null &&
      attempt.nextAttemptAt !== undefined
    ) {
      return false;
    } else if (
      attempt.errorMessage !== null &&
      attempt.errorMessage !== undefined
    ) {
      return false;
    }
  }
  if (requireOutputMatch) {
    if (
      canonicalJson(parseObjectJson(task.outputJson)) !== canonicalJson(outcome)
    ) {
      return false;
    }
    const finalAttempt = matchingAttempts.at(-1);
    if (
      canonicalJson(parseObjectJson(finalAttempt.outputJson)) !==
      canonicalJson(outcome)
    ) {
      return false;
    }
  }
  const firstAttempt = matchingAttempts[0];
  const finalAttempt = matchingAttempts.at(-1);
  return (
    validTimestamp(run.createdAt) &&
    validTimestamp(run.startedAt) &&
    validTimestamp(run.completedAt) &&
    validTimestamp(task.createdAt) &&
    validTimestamp(task.startedAt) &&
    validTimestamp(task.completedAt) &&
    timestampAtOrAfter(run.startedAt, run.createdAt) &&
    timestampAtOrAfter(task.createdAt, run.createdAt) &&
    timestampAtOrAfter(task.startedAt, task.createdAt) &&
    timestampAtOrAfter(task.completedAt, task.startedAt) &&
    timestampAtOrAfter(task.startedAt, run.startedAt) &&
    timestampAtOrAfter(firstAttempt.startedAt, task.startedAt) &&
    timestampAtOrAfter(finalAttempt.completedAt, firstAttempt.startedAt) &&
    timestampAtOrAfter(task.completedAt, finalAttempt.completedAt) &&
    timestampAtOrAfter(run.completedAt, task.completedAt)
  );
}

/**
 * Validate the ordered durable boundary, rather than inferring it from
 * terminal completion order.  A run that overlaps its predecessor can have
 * a later completed_at while still observing an earlier, non-authoritative
 * state.  Every mandatory edge therefore needs a strict canonical timestamp
 * boundary: predecessor.completedAt < successor.startedAt.
 */
export function validateMandatoryLifecycleSequence(orderedRuns) {
  const expectedKinds = [
    "backfill",
    "dependency-verify",
    "semantic-index-rebuild",
    "dependency-verify",
  ];
  if (
    !Array.isArray(orderedRuns) ||
    orderedRuns.length !== expectedKinds.length
  ) {
    return {
      valid: false,
      reason: "mandatory-lifecycle-sequence-shape-invalid",
    };
  }
  for (const [index, run] of orderedRuns.entries()) {
    if (
      !run ||
      run.runKind !== expectedKinds[index] ||
      !validTimestamp(run.startedAt) ||
      !validTimestamp(run.completedAt) ||
      Date.parse(run.completedAt) < Date.parse(run.startedAt)
    ) {
      return {
        valid: false,
        reason: `mandatory-lifecycle-run-${index}-timestamp-invalid`,
      };
    }
    if (
      index > 0 &&
      Date.parse(orderedRuns[index - 1].completedAt) >=
        Date.parse(run.startedAt)
    ) {
      return {
        valid: false,
        reason: `mandatory-lifecycle-boundary-${index - 1}-${index}-overlap`,
      };
    }
  }
  return { valid: true };
}

function expectedRunWorkKey(kind, epochId) {
  switch (kind) {
    case "backfill":
      return "legacy-dependency-backfill:v3";
    case "dependency-verify":
      return `dependency-verify:${epochId}`;
    case "semantic-index-rebuild":
      return "dependency-rebuild-derived";
    default:
      return null;
  }
}

function mandatoryRunObligation({
  kind,
  projectId,
  epochId,
  run,
  tasks,
  attempts,
  workspace,
  afterRunId = null,
  beforeRunId = null,
}) {
  const expectedWorkKey = expectedRunWorkKey(kind, epochId);
  const marker = parseObjectJson(run?.specJson)?.systemWork ?? null;
  const base = {
    kind,
    runId: run?.id ?? null,
    projectId,
    workspace: workspace ?? null,
    semanticEpochId: epochId ?? null,
    workKey: expectedWorkKey,
    systemWork: marker,
    status: "missing",
    ...(afterRunId ? { afterRunId } : {}),
    ...(beforeRunId ? { beforeRunId } : {}),
  };
  if (!run) return base;
  const valid =
    completedRun(run) &&
    run.projectId === projectId &&
    (workspace === null ||
      run.workspace === undefined ||
      run.workspace === workspace) &&
    run.semanticEpochId === epochId &&
    run.workKey === expectedWorkKey &&
    validCanonicalRunSpec(run) &&
    validRunTaskAttemptLifecycle(run, tasks, attempts);
  return {
    ...base,
    status: valid ? "completed" : "invalid",
    completedAt: run.completedAt ?? null,
    terminalReasonCode: run.terminalReasonCode ?? null,
    ...(valid ? {} : { reason: "run-contract-invalid" }),
  };
}

/**
 * Generic Consumer Freshness is a publisher receipt, not a scheduler
 * heartbeat.  The zero-width idle checkpoint is intentionally rejected here;
 * it may prove scheduler liveness only.  A Rebuild run can be used as a
 * canonical publisher only when its lifecycle has already been validated by
 * the caller.
 */
export function validateGenericFreshnessPublisherProvenance(input) {
  const run = input?.runKind ? input : input?.run;
  const rebuildRun = input?.rebuildRun;
  const expectedProjectId = input?.projectId;
  const expectedEpochId = input?.epochId ?? input?.semanticEpochId;
  const lifecycleProvided =
    Object.prototype.hasOwnProperty.call(input ?? {}, "tasks") ||
    Object.prototype.hasOwnProperty.call(input ?? {}, "attempts");
  const tasks = Array.isArray(input?.tasks) ? input.tasks : [];
  const attempts = Array.isArray(input?.attempts) ? input.attempts : [];
  if (!run || run.status === "failed" || run.status === "cancelled") {
    return {
      valid: false,
      reason: "publisher-run-missing-or-terminal-failure",
    };
  }
  if (
    (expectedProjectId !== undefined && run.projectId !== expectedProjectId) ||
    (expectedEpochId !== undefined && run.semanticEpochId !== expectedEpochId)
  ) {
    return { valid: false, reason: "publisher-scope-binding-invalid" };
  }
  if (run.runKind === "semantic-index-rebuild") {
    const valid =
      run.workKey === "dependency-rebuild-derived" &&
      completedRun(run) &&
      typeof expectedProjectId === "string" &&
      run.projectId === expectedProjectId &&
      typeof expectedEpochId === "string" &&
      run.semanticEpochId === expectedEpochId &&
      validCanonicalRunSpec(run) &&
      (rebuildRun === undefined || rebuildRun?.id === run.id) &&
      lifecycleProvided &&
      validRunTaskAttemptLifecycle(run, tasks, attempts);
    return {
      valid,
      reason: valid ? undefined : "rebuild-publisher-lifecycle-invalid",
      publisherRun: valid ? run : undefined,
    };
  }
  if (
    run.runKind !== "freshness-evaluation" ||
    !completedRun(run) ||
    run.consumerId !== C2ZC_FRESHNESS_CURSOR_CONSUMER_ID
  ) {
    return { valid: false, reason: "publisher-run-kind-invalid" };
  }
  const spec = parseObjectJson(run.specJson);
  const outcome = parseObjectJson(run.outcomeSummaryJson);
  if (
    !spec ||
    !outcome ||
    spec.idleCheckpoint ||
    outcome.idleCheckpoint ||
    typeof run.specDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(run.specDigest)
  ) {
    return { valid: false, reason: "idle-checkpoint-is-scheduler-only" };
  }
  const expectedSpecKeys = [
    "affectedObjects",
    "eventIds",
    "feedPageDigest",
    "fromSequenceExclusive",
    "projectId",
    "throughSequenceInclusive",
  ];
  if (
    Object.keys(spec).sort().join(",") !== expectedSpecKeys.join(",") ||
    spec.projectId !== expectedProjectId ||
    !Number.isSafeInteger(Number(spec.fromSequenceExclusive)) ||
    !Number.isSafeInteger(Number(spec.throughSequenceInclusive)) ||
    Number(spec.fromSequenceExclusive) >=
      Number(spec.throughSequenceInclusive) ||
    !Array.isArray(spec.eventIds) ||
    !spec.eventIds.every(
      (eventId) => typeof eventId === "string" && eventId.trim() !== "",
    ) ||
    !Array.isArray(spec.affectedObjects) ||
    typeof spec.feedPageDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/.test(spec.feedPageDigest) ||
    run.specDigest !== sha256Json(spec)
  ) {
    return { valid: false, reason: "feed-publisher-spec-invalid" };
  }
  const workKey = String(run.workKey ?? "");
  const workKeyMatch = workKey.match(
    /^incremental-freshness:([^:]+):(\d+):(\d+):([0-9a-f]{64})$/,
  );
  const matchesFeedWorkKey = Boolean(workKeyMatch);
  const [, workKeyEpoch, workKeyFrom, workKeyThrough] = workKeyMatch ?? [];
  const fromSequence = outcome?.from ?? outcome?.fromSequenceExclusive;
  const throughSequence = outcome?.through ?? outcome?.throughSequenceInclusive;
  const coordinatesMatch =
    matchesFeedWorkKey &&
    run.semanticEpochId === workKeyEpoch &&
    Number(fromSequence) === Number(workKeyFrom) &&
    Number(throughSequence) === Number(workKeyThrough);
  const nonZeroRange =
    Number.isSafeInteger(Number(fromSequence)) &&
    Number.isSafeInteger(Number(throughSequence)) &&
    Number(fromSequence) < Number(throughSequence);
  const specCoordinatesMatch =
    ["from", "fromSequenceExclusive"].every(
      (key) =>
        spec[key] === undefined || Number(spec[key]) === Number(fromSequence),
    ) &&
    ["through", "throughSequenceInclusive"].every(
      (key) =>
        spec[key] === undefined ||
        Number(spec[key]) === Number(throughSequence),
    );
  if (
    !matchesFeedWorkKey ||
    !coordinatesMatch ||
    !specCoordinatesMatch ||
    workKeyMatch[4] !== run.specDigest.slice("sha256:".length) ||
    !nonZeroRange ||
    outcome.projectId !== expectedProjectId ||
    outcome.runId !== run.id ||
    Number(outcome.fromSequenceExclusive ?? outcome.from) !==
      Number(fromSequence) ||
    Number(outcome.throughSequenceInclusive ?? outcome.through) !==
      Number(throughSequence) ||
    !Number.isSafeInteger(Number(outcome.affectedEdgeCount)) ||
    Number(outcome.affectedEdgeCount) < 0 ||
    !Number.isSafeInteger(Number(outcome.affectedConsumerCount)) ||
    Number(outcome.affectedConsumerCount) < 0 ||
    outcome?.hasMore !== false ||
    (lifecycleProvided &&
      !validRunTaskAttemptLifecycle(run, tasks, attempts, {
        requireInputMatch: false,
        expectedTaskKind: "incremental-freshness-batch",
        coordinates: { from: fromSequence, through: throughSequence },
        requireOutputMatch: true,
      })) ||
    !lifecycleProvided
  ) {
    return { valid: false, reason: "feed-publisher-contract-invalid" };
  }
  return { valid: true, publisherRun: run };
}

/**
 * Validate the complete Generic Freshness surface for one current project
 * and Epoch.  The SQL snapshot contains every consumer row, so selecting the
 * first row would allow a valid publisher to hide a duplicate, reserved
 * Semantic Index row, or a row whose publisher has the wrong consumerId.
 */
export function validateGenericFreshnessRows(
  rows,
  { projectId, epochId, runs = [], tasks = [], attempts = [] } = {},
) {
  if (typeof projectId !== "string" || typeof epochId !== "string") {
    return { valid: false, reason: "generic-freshness-scope-invalid" };
  }
  if (!Array.isArray(rows)) {
    return { valid: false, reason: "generic-freshness-rows-invalid" };
  }
  const projectRows = rows.filter((row) => row?.projectId === projectId);
  if (projectRows.length === 0) {
    return { valid: false, reason: "generic-freshness-row-missing" };
  }
  const targetRows = projectRows;
  const seenKeys = new Set();
  const publisherRuns = [];
  for (const row of targetRows) {
    if (
      row.semanticEpochId !== epochId ||
      typeof row.consumerKind !== "string" ||
      row.consumerKind.trim() === "" ||
      row.consumerKind === "semantic-index" ||
      typeof row.consumerKey !== "string" ||
      row.consumerKey.trim() === "" ||
      row.evidenceFreshness !== "fresh" ||
      row.buildAction !== "none"
    ) {
      return { valid: false, reason: "generic-freshness-row-contract-invalid" };
    }
    const key = `${row.consumerKind}\u0000${row.consumerKey}`;
    if (seenKeys.has(key)) {
      return { valid: false, reason: "generic-freshness-duplicate-row" };
    }
    seenKeys.add(key);
    const publisherRun = runs.find((run) => run?.id === row.lastEvaluatedRunId);
    const provenance = validateGenericFreshnessPublisherProvenance({
      run: publisherRun,
      projectId,
      epochId,
      tasks,
      attempts,
    });
    if (!provenance.valid) {
      return {
        valid: false,
        reason: provenance.reason ?? "generic-freshness-publisher-invalid",
      };
    }
    publisherRuns.push(provenance.publisherRun ?? publisherRun);
  }
  return { valid: true, rows: targetRows, publisherRuns };
}

/**
 * Build the terminal obligations which make a renderer read a safe boundary.
 * A clean cursor alone is insufficient: a delayed scheduler writer could
 * still publish after a probe.  The ledger is therefore part of the
 * fingerprint and every applicable terminal phase must be completed.
 */
export function inspectDurableTerminalLedger({
  projects,
  runs = [],
  epochs = [],
  tasks = [],
  attempts = [],
  freshnessEvidence = [],
  feedAndCursor,
  workspace = null,
}) {
  const authorityMode = Array.isArray(projects);
  const authorityProjectValues = authorityMode
    ? projects.map((project) => project?.id ?? project?.projectId)
    : [];
  const authorityProjectIds = new Set(authorityProjectValues);
  const authorityMalformed =
    authorityMode &&
    authorityProjectValues.some(
      (projectId) => typeof projectId !== "string" || projectId.trim() === "",
    );
  const authorityDuplicate =
    authorityMode && authorityProjectIds.size !== authorityProjectValues.length;
  const projectIds = authorityMode
    ? new Set(
        projects
          .map((project) => project?.id ?? project?.projectId)
          .filter((projectId) => typeof projectId === "string" && projectId),
      )
    : new Set([
        ...runs.map((run) => run?.projectId),
        ...epochs.map((epoch) => epoch?.projectId),
        ...freshnessEvidence.map((row) => row?.projectId),
        ...(feedAndCursor?.feed ?? []).map((row) => row?.projectId),
        ...(feedAndCursor?.cursors ?? []).map((row) => row?.projectId),
      ]);
  projectIds.delete(undefined);
  projectIds.delete(null);

  const obligations = [];
  const completed = [];
  if (authorityMode && projectIds.size === 0) {
    obligations.push({
      kind: "project-authority",
      runId: null,
      projectId: null,
      workspace,
      status: "missing",
      reason: "project-authority-empty",
    });
  }
  if (authorityMalformed || authorityDuplicate) {
    obligations.push({
      kind: "project-authority",
      runId: null,
      projectId: null,
      workspace,
      status: "missing",
      reason: authorityMalformed
        ? "project-authority-invalid"
        : "project-authority-duplicate",
    });
  }
  for (const projectId of [...projectIds].sort()) {
    const projectRuns = runs
      .filter((run) => run?.projectId === projectId)
      .toSorted((left, right) => {
        const instant = compareLedgerInstants(
          left.completedAt,
          right.completedAt,
        );
        return instant || String(left.id).localeCompare(String(right.id));
      });

    if (authorityMode) {
      const currentEpoch = epochs
        .filter((epoch) => epoch?.projectId === projectId)
        .toSorted((left, right) => {
          const numberDelta =
            Number(left.epochNumber) - Number(right.epochNumber);
          return numberDelta || String(left.id).localeCompare(String(right.id));
        })
        .at(-1);
      const validCurrentEpoch =
        currentEpoch &&
        typeof currentEpoch.id === "string" &&
        currentEpoch.id.trim() !== "" &&
        Number.isSafeInteger(Number(currentEpoch.epochNumber)) &&
        Number(currentEpoch.epochNumber) > 0 &&
        validTimestamp(currentEpoch.createdAt);
      const currentEpochObligation = {
        kind: "current-epoch",
        runId: null,
        projectId,
        workspace,
        semanticEpochId: validCurrentEpoch ? currentEpoch.id : null,
        status: validCurrentEpoch ? "completed" : "missing",
        ...(validCurrentEpoch
          ? {}
          : {
              reason: currentEpoch
                ? "current-epoch-invalid"
                : "current-epoch-missing",
            }),
      };
      obligations.push(currentEpochObligation);
      if (currentEpochObligation.status === "completed") {
        completed.push(currentEpochObligation);
      }
      if (!validCurrentEpoch) {
        for (const kind of [
          "backfill",
          "dependency-verify",
          "semantic-index-rebuild",
          "confirmation-verify",
          "freshness-evaluation",
        ]) {
          obligations.push({
            kind,
            runId: null,
            projectId,
            workspace,
            semanticEpochId: null,
            workKey: expectedRunWorkKey(
              kind === "confirmation-verify" ? "dependency-verify" : kind,
              null,
            ),
            systemWork: true,
            status: "missing",
            reason: "current-epoch-missing",
          });
        }
        continue;
      }

      const epochId = currentEpoch.id;
      const backfill = projectRuns.find(
        (run) =>
          run.runKind === "backfill" &&
          run.semanticEpochId === epochId &&
          run.workKey === expectedRunWorkKey("backfill", epochId),
      );
      const backfillObligation = mandatoryRunObligation({
        kind: "backfill",
        projectId,
        epochId,
        run: backfill,
        tasks,
        attempts,
        workspace,
      });
      obligations.push(backfillObligation);
      if (backfillObligation.status === "completed") {
        completed.push(backfillObligation);
      }

      const verifies = projectRuns
        .filter(
          (run) =>
            run.runKind === "dependency-verify" &&
            run.semanticEpochId === epochId &&
            run.workKey === expectedRunWorkKey("dependency-verify", epochId),
        )
        .toSorted((left, right) =>
          compareLedgerInstants(left.completedAt, right.completedAt),
        );
      const firstVerify = verifies.find(
        (run) =>
          backfill &&
          completedRun(run) &&
          timestampStrictlyAfter(run.completedAt, backfill.completedAt) &&
          timestampStrictlyAfter(run.startedAt, backfill.completedAt),
      );
      const verifyObligation = mandatoryRunObligation({
        kind: "dependency-verify",
        projectId,
        epochId,
        run: firstVerify,
        tasks,
        attempts,
        workspace,
        ...(backfill ? { afterRunId: backfill.id } : {}),
      });
      obligations.push(verifyObligation);
      if (verifyObligation.status === "completed")
        completed.push(verifyObligation);

      const rebuild = projectRuns.find(
        (run) =>
          run.runKind === "semantic-index-rebuild" &&
          run.semanticEpochId === epochId &&
          run.workKey ===
            expectedRunWorkKey("semantic-index-rebuild", epochId) &&
          completedRun(run) &&
          firstVerify &&
          timestampStrictlyAfter(run.completedAt, firstVerify.completedAt) &&
          timestampStrictlyAfter(run.startedAt, firstVerify.completedAt),
      );
      const rebuildObligation = mandatoryRunObligation({
        kind: "semantic-index-rebuild",
        projectId,
        epochId,
        run: rebuild,
        tasks,
        attempts,
        workspace,
        ...(firstVerify ? { beforeRunId: rebuild?.id ?? null } : {}),
      });
      obligations.push(rebuildObligation);
      if (rebuildObligation.status === "completed")
        completed.push(rebuildObligation);

      const confirmationVerify = verifies.find(
        (run) =>
          firstVerify &&
          rebuild &&
          completedRun(run) &&
          run.id !== firstVerify?.id &&
          timestampStrictlyAfter(run.completedAt, rebuild.completedAt) &&
          timestampStrictlyAfter(run.startedAt, rebuild.completedAt),
      );
      const mandatorySequence = validateMandatoryLifecycleSequence([
        backfill,
        firstVerify,
        rebuild,
        confirmationVerify,
      ]);
      if (!mandatorySequence.valid) {
        for (const obligation of [verifyObligation, rebuildObligation]) {
          if (obligation.status === "completed") {
            obligation.status = "invalid";
            obligation.reason = mandatorySequence.reason;
          }
        }
      }
      const confirmationObligation = mandatoryRunObligation({
        kind: "dependency-verify",
        projectId,
        epochId,
        run: confirmationVerify,
        tasks,
        attempts,
        workspace,
        ...(rebuild ? { afterRunId: rebuild.id } : {}),
      });
      confirmationObligation.kind = "confirmation-verify";
      if (
        !mandatorySequence.valid &&
        confirmationObligation.status === "completed"
      ) {
        confirmationObligation.status = "invalid";
        confirmationObligation.reason = mandatorySequence.reason;
      }
      obligations.push(confirmationObligation);
      if (confirmationObligation.status === "completed") {
        completed.push(confirmationObligation);
      }

      const genericFreshness = validateGenericFreshnessRows(freshnessEvidence, {
        projectId,
        epochId,
        runs: projectRuns,
        tasks,
        attempts,
      });
      const freshnessEvidenceRows = genericFreshness.rows ?? [];
      const freshnessEvidenceRow = freshnessEvidenceRows[0] ?? null;
      const publisherRuns = genericFreshness.publisherRuns ?? [];
      const freshnessOrderValid =
        genericFreshness.valid &&
        publisherRuns.length > 0 &&
        publisherRuns.every(
          (publisherRun) =>
            publisherRun?.runKind === "semantic-index-rebuild" ||
            (confirmationVerify &&
              timestampStrictlyAfter(
                publisherRun?.completedAt,
                confirmationVerify.completedAt,
              )),
        );
      const publisherRun = publisherRuns[0] ?? null;
      const freshnessObligation = {
        kind: "freshness-evaluation",
        runId: publisherRun?.id ?? null,
        projectId,
        workspace,
        semanticEpochId: epochId,
        status:
          genericFreshness.valid && freshnessOrderValid
            ? "completed"
            : "missing",
        ...(genericFreshness.valid && freshnessOrderValid
          ? {
              evidence: {
                consumerKind: freshnessEvidenceRow.consumerKind,
                consumerKey: freshnessEvidenceRow.consumerKey,
                evidenceFreshness: freshnessEvidenceRow.evidenceFreshness,
                buildAction: freshnessEvidenceRow.buildAction,
                lastEvaluatedRunId: freshnessEvidenceRow.lastEvaluatedRunId,
                dependencySetDigest:
                  freshnessEvidenceRow.dependencySetDigest ?? null,
                updatedAt: freshnessEvidenceRow.updatedAt ?? null,
              },
            }
          : {
              reason:
                genericFreshness.reason ??
                (freshnessEvidenceRow
                  ? "generic-publisher-invalid"
                  : "current-epoch-freshness-evidence-missing"),
            }),
      };
      obligations.push(freshnessObligation);
      if (freshnessObligation.status === "completed") {
        completed.push(freshnessObligation);
      }
      continue;
    }

    for (const run of projectRuns) {
      const obligation = {
        kind: run.runKind,
        runId: run.id,
        projectId,
        semanticEpochId: run.semanticEpochId ?? null,
        createdAt: run.createdAt ?? null,
        startedAt: run.startedAt ?? null,
        completedAt: run.completedAt ?? null,
        status: completedRun(run)
          ? "completed"
          : run.status === "completed"
            ? "invalid"
            : (run.status ?? "missing"),
        terminalReasonCode: run.terminalReasonCode ?? null,
      };
      obligations.push(obligation);
      if (obligation.status === "completed") completed.push(obligation);
    }

    const completedRebuilds = projectRuns.filter(
      (run) => run.runKind === "semantic-index-rebuild" && completedRun(run),
    );
    const completedBackfills = projectRuns.filter(
      (run) => run.runKind === "backfill" && completedRun(run),
    );
    for (const backfill of completedBackfills) {
      const verification = projectRuns.find(
        (run) =>
          run.runKind === "dependency-verify" &&
          completedRun(run) &&
          timestampStrictlyAfter(run.completedAt, backfill.completedAt) &&
          timestampStrictlyAfter(run.startedAt, backfill.completedAt) &&
          sameSemanticEpoch(run.semanticEpochId, backfill.semanticEpochId),
      );
      const obligation = verification
        ? {
            kind: "dependency-verify",
            runId: verification.id,
            projectId,
            semanticEpochId: verification.semanticEpochId ?? null,
            completedAt: verification.completedAt ?? null,
            status: "completed",
            terminalReasonCode: verification.terminalReasonCode ?? null,
            afterRunId: backfill.id,
          }
        : {
            kind: "dependency-verify",
            runId: null,
            projectId,
            semanticEpochId: backfill.semanticEpochId ?? null,
            status: "missing",
            afterRunId: backfill.id,
          };
      obligations.push(obligation);
      if (obligation.status === "completed") completed.push(obligation);
    }
    for (const rebuild of completedRebuilds) {
      const precedingVerify = projectRuns.find(
        (run) =>
          run.runKind === "dependency-verify" &&
          completedRun(run) &&
          timestampStrictlyAfter(rebuild.startedAt, run.completedAt) &&
          sameSemanticEpoch(run.semanticEpochId, rebuild.semanticEpochId),
      );
      const precondition = precedingVerify
        ? {
            kind: "dependency-verify",
            runId: precedingVerify.id,
            projectId,
            semanticEpochId: precedingVerify.semanticEpochId ?? null,
            completedAt: precedingVerify.completedAt ?? null,
            status: "completed",
            terminalReasonCode: precedingVerify.terminalReasonCode ?? null,
            beforeRunId: rebuild.id,
          }
        : {
            kind: "dependency-verify",
            runId: null,
            projectId,
            semanticEpochId: rebuild.semanticEpochId ?? null,
            status: "missing",
            beforeRunId: rebuild.id,
          };
      obligations.push(precondition);
      if (precondition.status === "completed") completed.push(precondition);
      const confirmation = projectRuns.find(
        (run) =>
          run.runKind === "dependency-verify" &&
          completedRun(run) &&
          timestampStrictlyAfter(run.completedAt, rebuild.completedAt) &&
          timestampStrictlyAfter(run.startedAt, rebuild.completedAt) &&
          sameSemanticEpoch(run.semanticEpochId, rebuild.semanticEpochId),
      );
      const obligation = confirmation
        ? {
            kind: "confirmation-verify",
            runId: confirmation.id,
            projectId,
            semanticEpochId: confirmation.semanticEpochId ?? null,
            completedAt: confirmation.completedAt ?? null,
            status: "completed",
            terminalReasonCode: confirmation.terminalReasonCode ?? null,
            afterRunId: rebuild.id,
          }
        : {
            kind: "confirmation-verify",
            runId: null,
            projectId,
            semanticEpochId: rebuild.semanticEpochId ?? null,
            status: "missing",
            afterRunId: rebuild.id,
          };
      obligations.push(obligation);
      if (obligation.status === "completed") completed.push(obligation);
    }

    const currentEpoch = epochs
      .filter((epoch) => epoch?.projectId === projectId)
      .toSorted((left, right) => {
        const numberDelta =
          Number(left.epochNumber) - Number(right.epochNumber);
        return numberDelta || String(left.id).localeCompare(String(right.id));
      })
      .at(-1);
    const freshnessRuns = projectRuns.filter(
      (run) => run.runKind === "freshness-evaluation",
    );
    if (currentEpoch) {
      const genericFreshness = validateGenericFreshnessRows(freshnessEvidence, {
        projectId,
        epochId: currentEpoch.id,
        runs: freshnessRuns,
        tasks,
        attempts,
      });
      const evidence = genericFreshness.rows?.[0] ?? null;
      const currentCompletedFreshnessRun =
        genericFreshness.publisherRuns?.[0] ?? null;
      const obligation = evidence
        ? {
            kind: "freshness-evaluation",
            runId: currentCompletedFreshnessRun.id,
            projectId,
            semanticEpochId: currentEpoch.id,
            status: genericFreshness.valid ? "completed" : "missing",
            evidence: {
              consumerKind: evidence.consumerKind,
              consumerKey: evidence.consumerKey,
              evidenceFreshness: evidence.evidenceFreshness,
              buildAction: evidence.buildAction,
              lastEvaluatedRunId: evidence.lastEvaluatedRunId,
              dependencySetDigest: evidence.dependencySetDigest ?? null,
              updatedAt: evidence.updatedAt ?? null,
            },
          }
        : {
            kind: "freshness-evaluation",
            runId: currentCompletedFreshnessRun?.id ?? null,
            projectId,
            semanticEpochId: currentEpoch.id,
            status: "missing",
            reason:
              genericFreshness.reason ??
              "current-epoch-freshness-evidence-missing",
          };
      obligations.push(obligation);
      if (obligation.status === "completed") completed.push(obligation);
    }
  }

  return {
    ready:
      obligations.length > 0 &&
      obligations.every((obligation) => obligation.status === "completed"),
    obligations,
    completed,
  };
}

export function validateDurableQuiescenceObservation(
  observation,
  label = "durable quiescence",
) {
  if (!observation || observation.settled !== true) {
    throw new Error(`${label} is not settled`);
  }
  if (observation.feedAndCursor?.consistent !== true) {
    throw new Error(
      `${label} feed/cursor state is not released at the feed head`,
    );
  }
  const active = observation.active;
  const activeEntries = [
    "runs",
    "tasks",
    "attempts",
    "reservations",
    "repairLeases",
    "pendingWakeOutbox",
  ].flatMap((name) => {
    const entries = active?.[name];
    return Array.isArray(entries) ? entries : [{ name }];
  });
  if (activeEntries.length > 0) {
    throw new Error(`${label} has active maintenance state`);
  }
  const ledger = observation.terminalLedger;
  if (!ledger || ledger.ready !== true || !Array.isArray(ledger.obligations)) {
    throw new Error(
      `${label} terminal ledger obligation is missing or incomplete`,
    );
  }
  const incomplete = ledger.obligations.filter(
    (obligation) => obligation?.status !== "completed",
  );
  if (incomplete.length > 0) {
    throw new Error(
      `${label} terminal ledger obligation is missing or incomplete: ${JSON.stringify(
        incomplete,
      )}`,
    );
  }
  return observation;
}

async function readRendererQuiescenceObservation(harness, page, workspace) {
  const rows = {};
  for (const [name, sql] of Object.entries(C2ZC_RENDERER_QUIESCENCE_QUERIES)) {
    rows[name] = await readRows(
      harness,
      page,
      sql,
      `C2-ZC renderer quiescence ${name}`,
    );
  }

  const observedAt = new Date(
    typeof harness.now === "function" ? harness.now() : Date.now(),
  ).toISOString();
  const monotonicMs =
    typeof harness.monotonicNow === "function"
      ? Number(harness.monotonicNow())
      : performance.now();
  if (!Number.isFinite(monotonicMs)) {
    throw new Error("C2-ZC renderer quiescence clock is not monotonic");
  }
  const feedAndCursor = readFeedAndCursorState(
    rows.feed,
    rows.freshnessCursors,
  );
  const active = {
    runs: rows.activeRuns,
    tasks: rows.activeTasks,
    attempts: rows.activeAttempts,
    reservations: rows.reservations,
    repairLeases: activeRepairLeases(rows.repairLeases, observedAt),
    pendingWakeOutbox: rows.pendingWakeOutbox,
  };
  const terminalLedger = inspectDurableTerminalLedger({
    projects: rows.projects,
    runs: rows.terminalRuns,
    epochs: rows.epochs,
    tasks: rows.tasks,
    attempts: rows.attempts,
    freshnessEvidence: rows.freshnessEvidence,
    feedAndCursor,
    workspace,
  });
  const observation = {
    observedAt,
    monotonicMs,
    feedAndCursor,
    active,
    terminalLedger,
    settled:
      feedAndCursor.consistent &&
      Object.values(active).every((entries) => entries.length === 0) &&
      terminalLedger.ready,
  };
  return observation;
}

function quiescenceDiagnostic(observation) {
  return {
    settled: observation.settled,
    feedCursorMismatches: observation.feedAndCursor.mismatches,
    terminalLedger: observation.terminalLedger,
    activeCounts: Object.fromEntries(
      Object.entries(observation.active).map(([name, entries]) => [
        name,
        entries.length,
      ]),
    ),
  };
}

function quiescenceEvidence(observation) {
  return {
    observedAt: observation.observedAt,
    monotonicMs: observation.monotonicMs,
    settled: observation.settled,
    startAt: observation.startAt,
    endAt: observation.endAt,
    durationMs: observation.durationMs,
    stableSampleCount: observation.stableSampleCount,
    fingerprint: observation.fingerprint,
    feedAndCursor: observation.feedAndCursor,
    active: observation.active,
    terminalLedger: observation.terminalLedger,
  };
}

function observationFingerprint(observation) {
  return JSON.stringify({
    feedAndCursor: observation.feedAndCursor,
    active: observation.active,
    terminalLedger: observation.terminalLedger,
  });
}

/**
 * Purely evaluate a sequence of read observations. Keeping this separate from
 * the polling transport makes the delayed-writer and unstable-fingerprint
 * contracts testable without launching Electron.
 */
export function assessDurableQuiescenceSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) return null;
  let segment = [];
  let fingerprint = null;
  let previousObservedMs = null;
  for (const sample of samples) {
    if (
      !sample ||
      sample.settled !== true ||
      sample.terminalLedger?.ready !== true
    ) {
      segment = [];
      fingerprint = null;
      previousObservedMs = null;
      continue;
    }
    const observedMs = Number(sample.monotonicMs);
    if (!Number.isFinite(observedMs)) {
      segment = [];
      fingerprint = null;
      previousObservedMs = null;
      continue;
    }
    if (previousObservedMs !== null && observedMs < previousObservedMs) {
      segment = [];
      fingerprint = null;
    }
    if (
      previousObservedMs !== null &&
      observedMs - previousObservedMs >
        C2ZC_RENDERER_QUIESCENCE_MAX_SAMPLE_GAP_MS
    ) {
      segment = [];
      fingerprint = null;
    }
    previousObservedMs = observedMs;
    const currentFingerprint =
      typeof sample.fingerprint === "string"
        ? sample.fingerprint
        : observationFingerprint(sample);
    if (fingerprint !== currentFingerprint) {
      fingerprint = currentFingerprint;
      segment = [];
    }
    segment.push(sample);
    const start = segment[0];
    const end = segment.at(-1);
    const startMs = Number(start.monotonicMs);
    const endMs = Number(end.monotonicMs);
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs < startMs ||
      endMs - startMs < C2ZC_RENDERER_QUIESCENCE_MIN_STABLE_MS
    ) {
      continue;
    }
    return {
      startAt: start.observedAt,
      endAt: end.observedAt,
      durationMs: endMs - startMs,
      stableSampleCount: segment.length,
      fingerprint: currentFingerprint,
      monotonicStartMs: startMs,
      monotonicEndMs: endMs,
      monotonicDurationMs: endMs - startMs,
      observation: end,
    };
  }
  return null;
}

/**
 * Attribute a paired table change at the denial boundary.  A protected
 * snapshot that changes between the immediate before and after reads is
 * always a failed probe: a later ledger transition cannot retroactively prove
 * that the denied call was harmless.  A legitimate scheduler writer may only
 * explain an after->settledAfter transition, and that is recorded separately.
 */
export function classifyDmlSnapshotTransition({
  before,
  after,
  settledAfter,
  beforeFingerprint,
  afterFingerprint,
}) {
  const beforeJson = JSON.stringify(before);
  const afterJson = JSON.stringify(after);
  const settledAfterJson = JSON.stringify(settledAfter);
  const snapshotChangedDuringProbe = beforeJson !== afterJson;
  const snapshotChangedAfterProbe = afterJson !== settledAfterJson;
  const snapshotChangedFromBefore = beforeJson !== settledAfterJson;
  const quiescenceFingerprintChanged = beforeFingerprint !== afterFingerprint;
  const unaccountedPostProbeChange =
    !snapshotChangedDuringProbe &&
    snapshotChangedAfterProbe &&
    !quiescenceFingerprintChanged;
  return {
    ok: !snapshotChangedDuringProbe && !unaccountedPostProbeChange,
    snapshotUnchanged: !snapshotChangedDuringProbe,
    backgroundWriterDetected:
      !snapshotChangedDuringProbe &&
      snapshotChangedAfterProbe &&
      quiescenceFingerprintChanged,
    snapshotChangedDuringProbe,
    snapshotChangedAfterProbe,
    snapshotChangedFromBefore,
    quiescenceFingerprintChanged,
    unaccountedPostProbeChange,
  };
}

async function waitForRendererQuiescence(harness, page, workspace, label) {
  const samples = [];
  return harness.waitUntil(
    async () => {
      const observation = await readRendererQuiescenceObservation(
        harness,
        page,
        workspace,
      );
      samples.push({
        ...observation,
        fingerprint: observationFingerprint(observation),
      });
      const evidence = assessDurableQuiescenceSamples(samples);
      if (!evidence) {
        throw new Error(
          `${label} is not settled: ${JSON.stringify(
            quiescenceDiagnostic(observation),
          )}`,
        );
      }
      validateDurableQuiescenceObservation(
        observation,
        `${label} terminal readiness`,
      );
      return {
        ...observation,
        workspace,
        evidenceVersion: C2ZC_RENDERER_DML_EVIDENCE_VERSION,
        ...evidence,
      };
    },
    label,
    C2ZC_RENDERER_QUIESCENCE_WAIT_MS,
    C2ZC_RENDERER_QUIESCENCE_INTERVAL_MS,
  );
}

function requireCoreQuiescenceEvidence(artifact, label) {
  const receipt = artifact?.receipt;
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) {
    throw new Error(`${label} did not return the core quiescence artifact`);
  }
  const state = receipt.state;
  if (
    receipt.freshness?.heldProjectId !== null ||
    receipt.freshness?.cutoverNotReady !== false ||
    state?.freshnessHoldProjectId !== null ||
    state?.heldProjectId !== null
  ) {
    throw new Error(
      `${label} must prove no freshness hold and no cutover-not-ready state`,
    );
  }
  const discovery = receipt.discovery;
  if (
    discovery?.timerScheduled !== false ||
    discovery?.pendingRetry !== false ||
    discovery?.pendingEvent !== false ||
    discovery?.wakeAckPending !== false ||
    discovery?.wakeOutboxDrainInFlight !== false ||
    discovery?.wakeOutboxDrainSucceeded !== true ||
    discovery?.wakeOutboxDrainFailed !== false ||
    discovery?.wakeOutboxPendingRows !== false
  ) {
    throw new Error(`${label} must prove the wake outbox is drained`);
  }
  if (
    receipt.freshness?.inFlight !== false ||
    receipt.freshness?.hasMore !== false ||
    receipt.freshness?.noWrite !== true ||
    receipt.freshness?.wakePending !== false ||
    discovery?.inFlight !== false ||
    discovery?.empty !== true ||
    discovery?.queueIdle !== true
  ) {
    throw new Error(`${label} must prove all core schedulers are idle`);
  }
  return artifact;
}

async function requireCoreQuiescence(
  harness,
  app,
  phase,
  { previousSequence, binding },
) {
  if (
    typeof harness?.awaitQuiescence !== "function" ||
    typeof harness?.readQuiescence !== "function"
  ) {
    throw new Error(
      "C2-ZC DML denial requires the core awaitQuiescence/readQuiescence API",
    );
  }
  const checkedBinding = requireWorkspaceBinding(binding);
  if (!Number.isSafeInteger(previousSequence) || previousSequence < 0) {
    throw new Error(
      "C2-ZC DML denial requires a non-negative previous sequence",
    );
  }
  const requestNonce = randomUUID();
  const awaited = requireCoreQuiescenceEvidence(
    await harness.awaitQuiescence(app, phase, {
      previousSequence,
      requestNonce,
      authorityId: checkedBinding.authorityId,
      generation: checkedBinding.generation,
    }),
    `${phase} awaitQuiescence`,
  );
  const awaitedReceipt = awaited.receipt;
  const reread = requireCoreQuiescenceEvidence(
    await harness.readQuiescence(app, phase, {
      previousSequence: awaitedReceipt.sequence - 1,
      requestNonce: awaitedReceipt.requestNonce,
      authorityId: checkedBinding.authorityId,
      generation: checkedBinding.generation,
    }),
    `${phase} readQuiescence`,
  );
  if (
    reread.receipt.sequence !== awaitedReceipt.sequence ||
    reread.receipt.requestNonce !== requestNonce ||
    reread.receipt.phase !== phase ||
    reread.receipt.stateDigest !== awaitedReceipt.stateDigest ||
    reread.sha256 !== awaited.sha256
  ) {
    throw new Error(`${phase} core quiescence changed between await and read`);
  }
  return reread;
}

function serializeCoreQuiescenceArtifact(artifact, label) {
  const checked = requireCoreQuiescenceEvidence(artifact, label);
  if (
    typeof checked.path !== "string" ||
    typeof checked.realPath !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(checked.sha256 ?? "") ||
    !Number.isSafeInteger(checked.byteLength) ||
    checked.byteLength <= 0
  ) {
    throw new Error(`${label} is missing its immutable artifact identity`);
  }
  return {
    receipt: checked.receipt,
    path: checked.path,
    realPath: checked.realPath,
    sha256: checked.sha256,
    byteLength: checked.byteLength,
  };
}

async function expectProtectedWriterDenial(
  harness,
  page,
  { table, operation, sql },
) {
  try {
    await harness.invokeOk(page, "db_execute", {
      sql,
      params: [1],
      method: "run",
    });
  } catch (error) {
    const message = String(error?.message ?? error);
    if (
      !message.includes(
        "PROTECTED_WRITER_SQL: denied mutation of protected narrative table",
      )
    ) {
      throw new Error(
        `${operation} ${table} returned an unstable denial: ${message}`,
        { cause: error },
      );
    }
    return;
  }
  throw new Error(
    `${operation} ${table} unexpectedly succeeded through renderer`,
  );
}

async function runRendererDmlProbe(
  harness,
  page,
  workspace,
  table,
  operation,
  index,
) {
  const beforeQuiescence = await waitForRendererQuiescence(
    harness,
    page,
    workspace,
    `C2-ZC renderer DML probe ${index} before ${operation.name} ${table.name}`,
  );
  const before = await snapshotTables(harness, page);
  await expectProtectedWriterDenial(harness, page, {
    table: table.name,
    operation: operation.name,
    sql: operation.sql(table.name, table.updateColumn),
  });
  const after = await snapshotTables(harness, page);
  const afterQuiescence = await waitForRendererQuiescence(
    harness,
    page,
    workspace,
    `C2-ZC renderer DML probe ${index} after ${operation.name} ${table.name}`,
  );
  const settledAfter = await snapshotTables(harness, page);
  const transition = classifyDmlSnapshotTransition({
    before,
    after,
    settledAfter,
    beforeFingerprint: beforeQuiescence.fingerprint,
    afterFingerprint: afterQuiescence.fingerprint,
  });
  if (!transition.ok) {
    throw new Error(
      `${operation.name} ${table.name} changed immediately after denial; protected snapshot drift is not attributable to a later writer`,
    );
  }
  return {
    index,
    table: table.name,
    operation: operation.name,
    denial:
      "PROTECTED_WRITER_SQL: denied mutation of protected narrative table",
    unchanged: !transition.snapshotChangedFromBefore,
    ...transition,
    beforeSnapshot: before,
    afterSnapshot: after,
    settledAfterSnapshot: settledAfter,
    beforeQuiescence: quiescenceEvidence(beforeQuiescence),
    afterQuiescence: quiescenceEvidence(afterQuiescence),
  };
}

/**
 * Real Electron acceptance for the renderer SQL boundary. The MCP generic
 * surface is deliberately absent from the standalone server; its equivalent
 * untrusted origin is covered by the canonical shared-Rust regression named
 * in C2ZC_MCP_GENERIC_SQL_CONTRACT.
 */
export async function runC2ZcRendererMcpDmlDenialJourney(harness) {
  if (
    !harness ||
    typeof harness.workspacePath !== "function" ||
    typeof harness.launch !== "function" ||
    typeof harness.close !== "function" ||
    typeof harness.invokeOk !== "function" ||
    typeof harness.waitUntil !== "function" ||
    typeof harness.recordTimeline !== "function" ||
    typeof harness.awaitQuiescence !== "function" ||
    typeof harness.readQuiescence !== "function"
  ) {
    throw new TypeError(
      "C2-ZC DML denial journey requires waitUntil, recordTimeline, and " +
        "the core awaitQuiescence/readQuiescence API",
    );
  }

  const workspace = harness.workspacePath(C2ZC_RENDERER_MCP_DML_DENIAL_ID);
  await mkdir(workspace, { recursive: true });

  let launched = null;
  try {
    const launchWithOwner = (phase) =>
      withLaunchEnvironmentForTest(
        { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
        () => harness.launch(phase),
      );
    launched = await launchWithOwner(C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[0]);
    await harness.invokeOk(launched.page, "open_workspace", {
      path: workspace,
    });
    await harness.close(
      launched.app,
      launched.page,
      C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[0],
    );
    launched = null;

    launched = await launchWithOwner(C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[1]);
    await harness.invokeOk(launched.page, "open_workspace", {
      path: workspace,
    });

    const binding = requireWorkspaceBinding(
      await harness.invokeOk(
        launched.page,
        "narrative_extraction_capture_workspace_binding",
        { expectedWorkspacePath: workspace },
      ),
    );
    const coreBefore = await requireCoreQuiescence(
      harness,
      launched.app,
      C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[1],
      { previousSequence: 0, binding },
    );
    const openingLedger = await readWorkspaceLedger(harness, launched.page);
    assertQuiescenceLedgerMatches(
      coreBefore.receipt,
      openingLedger,
      "C2-ZC DML opening core quiescence",
    );

    // The scheduler remains production-enabled. This renderer-only read
    // barrier absorbs the ordinary open-time maintenance/freshness work
    // before any denial probe is paired with a table snapshot.
    const openingQuiescence = await waitForRendererQuiescence(
      harness,
      launched.page,
      workspace,
      "C2-ZC renderer DML opening quiescence",
    );
    const denialCount = { renderer: 0 };
    const probeEvidence = [];
    let probeIndex = 0;
    for (const table of C2ZC_RENDERER_TABLE_CONTRACTS) {
      for (const operation of RENDERER_DML_OPERATIONS) {
        probeIndex += 1;
        probeEvidence.push(
          await runRendererDmlProbe(
            harness,
            launched.page,
            workspace,
            table,
            operation,
            probeIndex,
          ),
        );
        denialCount.renderer += 1;
      }
    }

    // The final evidence is deliberately captured only after another
    // renderer-visible quiescence check; it is not compared to the opening
    // snapshot because legitimate writers may have completed between probes.
    const finalQuiescence = await waitForRendererQuiescence(
      harness,
      launched.page,
      workspace,
      "C2-ZC renderer DML final quiescence",
    );
    const finalSnapshot = await snapshotTables(harness, launched.page);
    const coreAfter = await requireCoreQuiescence(
      harness,
      launched.app,
      C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[1],
      { previousSequence: coreBefore.receipt.sequence, binding },
    );
    const finalLedger = await readWorkspaceLedger(harness, launched.page);
    assertQuiescenceLedgerMatches(
      coreAfter.receipt,
      finalLedger,
      "C2-ZC DML final core quiescence",
    );
    const quiescenceArtifacts = {
      before: serializeCoreQuiescenceArtifact(
        coreBefore,
        "C2-ZC DML opening core quiescence",
      ),
      after: serializeCoreQuiescenceArtifact(
        coreAfter,
        "C2-ZC DML final core quiescence",
      ),
    };
    // The core receipt is emitted by the main/N-API connection while the
    // ledger is read through the renderer's typed db_execute connection.
    // Keep this cross-connection comparison in the persisted result so a
    // matching sidecar cannot be mistaken for renderer-local state alone.
    const secondaryConnectionProof = {
      workspace,
      binding,
      opening: openingLedger,
      final: finalLedger,
      openingStateDigest: coreBefore.receipt.stateDigest,
      finalStateDigest: coreAfter.receipt.stateDigest,
    };
    const settledEvidence = {
      evidenceVersion: C2ZC_RENDERER_DML_EVIDENCE_VERSION,
      kind: C2ZC_RENDERER_DML_TIMELINE_EVENT,
      workspace,
      settled: true,
      startAt: finalQuiescence.startAt,
      endAt: finalQuiescence.endAt,
      durationMs: finalQuiescence.durationMs,
      stableSampleCount: finalQuiescence.stableSampleCount,
      fingerprint: finalQuiescence.fingerprint,
      monotonicStartMs: finalQuiescence.monotonicStartMs,
      monotonicEndMs: finalQuiescence.monotonicEndMs,
      monotonicDurationMs: finalQuiescence.monotonicDurationMs,
      terminalLedger: finalQuiescence.terminalLedger,
      openingLedger,
      finalLedger,
      secondaryConnectionProof,
      quiescenceArtifacts,
      openingQuiescence: quiescenceEvidence(openingQuiescence),
      probeCount: probeEvidence.length,
      probes: probeEvidence,
      finalQuiescence: quiescenceEvidence(finalQuiescence),
      finalSnapshot,
    };
    harness.recordTimeline(C2ZC_RENDERER_DML_TIMELINE_EVENT, {
      evidence: settledEvidence,
    });

    await harness.close(
      launched.app,
      launched.page,
      C2ZC_RENDERER_MCP_DML_DENIAL_PHASES[1],
    );
    launched = null;

    return {
      id: C2ZC_RENDERER_MCP_DML_DENIAL_ID,
      workspace,
      rendererDenials: denialCount.renderer,
      protectedTableCount: C2ZC_RENDERER_TABLE_CONTRACTS.length,
      settledEvidence,
      quiescenceArtifacts,
      secondaryConnectionProof,
      mcpGeneric: C2ZC_MCP_GENERIC_SQL_CONTRACT,
    };
  } finally {
    if (launched) {
      await harness.close(
        launched.app,
        launched.page,
        `${C2ZC_RENDERER_MCP_DML_DENIAL_ID}/cleanup`,
      );
    }
  }
}
export const C2ZC_RENDERER_MCP_DML_DENIAL_JOURNEY = Object.freeze({
  id: C2ZC_RENDERER_MCP_DML_DENIAL_ID,
  run: runC2ZcRendererMcpDmlDenialJourney,
});
