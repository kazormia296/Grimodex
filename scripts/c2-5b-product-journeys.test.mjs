import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import initSqlJs from "sql.js/dist/sql-asm.js";
import yaml from "js-yaml";

import {
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS,
  resolveProductJourneySet,
  resolveSelectedProductJourneys,
} from "../electron/scripts/product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_FAULTS,
  NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES,
  NARRATIVE_MAINTENANCE_FOREGROUND_SYSTEM_WORK_MARKER,
  NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER,
  NARRATIVE_MAINTENANCE_INTERRUPTED_CODE,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
  NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS,
  NARRATIVE_MAINTENANCE_SEAM_CONTRACT,
  NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
  NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
  NARRATIVE_MAINTENANCE_TRIGGERS,
  assertRestoreFixtureEvidence,
  assertRestoreVerifyRebuildVerifyCausality,
  assertForegroundLifecycle,
  assertForegroundTargetBaseline,
  assertForegroundRunMarker,
  assertTerminalFailureEvidence,
  assertTransientAttemptEvidence,
  foregroundMarkedRuns,
  isSettledFreshnessCursor,
  assertNoAutomaticRepair,
  selectForegroundTargetMarker,
  selectInterruptedRunFromExitSnapshot,
  selectInterruptedRecoveryFromStableLedger,
  terminalRetryCandidates,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import * as narrativeMaintenanceProductJourneys from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_ELECTRON_OWNER_GLOB,
  NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_DOMAIN_RULES,
} from "../electron/scripts/product-journey-catalog.mjs";
import { PRODUCT_JOURNEY_ELECTRON_PHASES } from "../electron/scripts/product-journey-harness.mjs";
import {
  resolveProductJourneyImpactCatalog,
  selectProductJourneys,
} from "../electron/scripts/product-journey-impact.mjs";
import {
  parseImpactMap,
  selectImpact,
} from "./quality/impact-map.mjs";

test("Run ledger scopes attempt evidence through task and Run ownership", async () => {
  const source = await readFile(
    new URL(
      "../electron/scripts/narrative-maintenance-product-journeys.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const runColumns = source.match(/const RUN_COLUMNS = `([\s\S]*?)`;/)?.[1];
  assert.ok(runColumns, "RUN_COLUMNS must remain a SQL projection contract");
  const directSnapshotReader = source.match(
    /async function readRunLedgerSnapshot\([\s\S]*?\n}\n/,
  )?.[0];
  assert.match(
    directSnapshotReader ?? "",
    /SELECT \$\{RUN_COLUMNS\}/,
    "direct post-exit snapshots must reuse the complete Run ledger projection",
  );
  assert.match(
    directSnapshotReader ?? "",
    /FROM narrative_extraction_runs r/,
    "direct post-exit snapshots must preserve the Run alias used by RUN_COLUMNS",
  );

  const SQL = await initSqlJs();
  const database = new SQL.Database();
  database.run(`
    CREATE TABLE narrative_extraction_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      run_kind TEXT,
      work_key TEXT,
      status TEXT,
      semantic_epoch_id TEXT,
      consumer_id TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      spec_json TEXT,
      terminal_reason_code TEXT,
      outcome_summary_json TEXT,
      spec_digest TEXT,
      catalog_digest TEXT,
      registry_digest TEXT
    );
    CREATE TABLE narrative_extraction_tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL,
      task_kind TEXT,
      status TEXT,
      input_json TEXT,
      attempt_count INTEGER,
      created_at TEXT,
      started_at TEXT,
      completed_at TEXT
    );
    CREATE TABLE narrative_extraction_attempts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      attempt_number INTEGER NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      completed_at TEXT,
      failure_code TEXT
    );
  `);

  const attemptsColumns = database.exec(
    "PRAGMA table_info(narrative_extraction_attempts)",
  )[0].values;
  assert.equal(
    attemptsColumns.some((column) => column[1] === "run_id"),
    false,
    "attempts must remain owned by task_id, not gain a run_id column",
  );

  const insert = (sql, params) => database.run(sql, params);
  insert(
    "INSERT INTO narrative_extraction_runs (id, project_id, created_at) VALUES (?, ?, ?)",
    ["run-1", "project-1", "2026-08-23T00:00:00.000Z"],
  );
  insert(
    "INSERT INTO narrative_extraction_runs (id, project_id, created_at) VALUES (?, ?, ?)",
    ["run-2", "project-1", "2026-08-23T00:00:01.000Z"],
  );
  insert(
    "INSERT INTO narrative_extraction_tasks (id, run_id) VALUES (?, ?)",
    ["task-1", "run-1"],
  );
  insert(
    "INSERT INTO narrative_extraction_tasks (id, run_id) VALUES (?, ?)",
    ["task-2", "run-2"],
  );
  insert(
    "INSERT INTO narrative_extraction_attempts (id, task_id, attempt_number, status, started_at, failure_code) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "attempt-1",
      "task-1",
      1,
      "failed",
      "2026-08-23T00:00:02.000Z",
      "older-code",
    ],
  );
  insert(
    "INSERT INTO narrative_extraction_attempts (id, task_id, attempt_number, status, started_at, failure_code) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "attempt-2a",
      "task-1",
      2,
      "failed",
      "2026-08-23T00:00:03.000Z",
      "not-the-latest-code",
    ],
  );
  insert(
    "INSERT INTO narrative_extraction_attempts (id, task_id, attempt_number, status, started_at, failure_code) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "attempt-2b",
      "task-1",
      2,
      "failed",
      "2026-08-23T00:00:03.000Z",
      NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
    ],
  );
  insert(
    "INSERT INTO narrative_extraction_attempts (id, task_id, attempt_number, status, started_at, failure_code) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "attempt-foreign",
      "task-2",
      9,
      "failed",
      "2026-08-23T00:00:04.000Z",
      "foreign-run-code",
    ],
  );

  const result = database.exec(`
    SELECT ${runColumns}
      FROM narrative_extraction_runs r
     WHERE r.project_id = 'project-1'
     ORDER BY created_at
  `);
  const [ledger] = result;
  assert.ok(ledger, "the Run ledger query must return rows");
  const rows = ledger.values.map((values) =>
    Object.fromEntries(
      ledger.columns.map((column, index) => [column, values[index]]),
    ),
  );
  assert.deepEqual(
    rows.map((row) => ({
      id: row.id,
      attemptCount: row.attemptCount,
      maxAttemptNumber: row.maxAttemptNumber,
      lastAttemptStatus: row.lastAttemptStatus,
      lastAttemptFailureCode: row.lastAttemptFailureCode,
    })),
    [
      {
        id: "run-1",
        attemptCount: 3,
        maxAttemptNumber: 2,
        lastAttemptStatus: "failed",
        lastAttemptFailureCode: NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
      },
      {
        id: "run-2",
        attemptCount: 1,
        maxAttemptNumber: 9,
        lastAttemptStatus: "failed",
        lastAttemptFailureCode: "foreign-run-code",
      },
    ],
    "attempts from another task/Run must not contaminate any Run evidence",
  );
  database.close();
});

test("foreground lifecycle proof rejects wrong child identity and non-monotonic timestamps", () => {
  const valid = {
    id: "foreground-run",
    runKind: "backfill",
    taskCount: 1,
    attemptCount: 1,
    taskKind: "maintenance-backfill",
    taskAttemptCount: 1,
    lastAttemptNumber: 1,
    maxAttemptNumber: 1,
    taskStatus: "completed",
    lastAttemptStatus: "completed",
    specJson: "{\"backfillAlgorithmVersion\":\"2\"}",
    taskInputJson: "{\"backfillAlgorithmVersion\":\"2\"}",
    createdAt: "2026-08-23T00:00:00.000Z",
    startedAt: "2026-08-23T00:00:00.000Z",
    taskCreatedAt: "2026-08-23T00:00:00.000Z",
    taskStartedAt: "2026-08-23T00:00:00.000Z",
    lastAttemptStartedAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T00:00:01.000Z",
    taskCompletedAt: "2026-08-23T00:00:01.000Z",
    lastAttemptCompletedAt: "2026-08-23T00:00:01.000Z",
  };
  assert.doesNotThrow(() =>
    assertForegroundLifecycle(valid, "completed", "valid foreground lifecycle"),
  );
  for (const [field, value] of [
    ["taskKind", "wrong-kind"],
    ["lastAttemptNumber", 2],
    ["taskCount", 2],
    ["taskStartedAt", "2099-01-01T00:00:00.000Z"],
    ["taskCreatedAt", "2025-01-01T00:00:00.000Z"],
    ["startedAt", "2026-08-23T00:00:02.000Z"],
  ]) {
    const corrupted = { ...valid, [field]: value };
    assert.throws(
      () => assertForegroundLifecycle(corrupted, "completed", `corrupt ${field}`),
      new RegExp(field),
    );
  }
});

test("terminal fault evidence requires the exact failed Run, Task, and Attempt triplet", () => {
  const valid = {
    id: "terminal-run",
    runKind: "backfill",
    status: "failed",
    taskCount: 1,
    attemptCount: 1,
    taskKind: "maintenance-backfill",
    taskAttemptCount: 1,
    lastAttemptNumber: 1,
    maxAttemptNumber: 1,
    taskStatus: "failed",
    lastAttemptStatus: "failed",
    lastAttemptFailureCode: NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
    terminalReasonCode: NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
    specJson: '{"backfillAlgorithmVersion":"2"}',
    taskInputJson: '{"backfillAlgorithmVersion":"2"}',
    createdAt: "2026-08-23T00:00:00.000000001Z",
    startedAt: "2026-08-23T00:00:00.000000002Z",
    taskCreatedAt: "2026-08-23T00:00:00.000000002Z",
    taskStartedAt: "2026-08-23T00:00:00.000000003Z",
    lastAttemptStartedAt: "2026-08-23T00:00:00.000000003Z",
    completedAt: "2026-08-23T00:00:00.000000004Z",
    taskCompletedAt: "2026-08-23T00:00:00.000000004Z",
    lastAttemptCompletedAt: "2026-08-23T00:00:00.000000004Z",
  };
  assert.doesNotThrow(() => assertTerminalFailureEvidence(valid));
  for (const [field, value] of [
    ["taskCount", 2],
    ["attemptCount", 2],
    ["taskKind", "wrong-kind"],
    ["taskAttemptCount", 2],
    ["lastAttemptNumber", 2],
    ["lastAttemptFailureCode", "wrong-code"],
    ["taskCompletedAt", "2026-08-23T00:00:00.000000005Z"],
  ]) {
    assert.throws(
      () => assertTerminalFailureEvidence({ ...valid, [field]: value }),
      new RegExp(field),
      `terminal evidence must reject corrupted ${field}`,
    );
  }
});

test("foreground lifecycle timestamps use the Rust-compatible grammar", () => {
  const valid = {
    id: "timestamp-run",
    runKind: "backfill",
    taskCount: 1,
    attemptCount: 1,
    taskKind: "maintenance-backfill",
    taskAttemptCount: 1,
    lastAttemptNumber: 1,
    taskStatus: "running",
    lastAttemptStatus: "running",
    specJson: "{\"backfillAlgorithmVersion\":\"2\"}",
    taskInputJson: "{\"backfillAlgorithmVersion\":\"2\"}",
    createdAt: "2026-08-23T00:00:00.000Z",
    startedAt: "2026-08-23T00:00:00.000Z",
    taskCreatedAt: "2026-08-23T00:00:00.000Z",
    taskStartedAt: "2026-08-23T00:00:00.000Z",
    lastAttemptStartedAt: "2026-08-23T00:00:00.000Z",
  };
  assert.doesNotThrow(() =>
    assertForegroundLifecycle(valid, "running", "canonical timestamp lifecycle"),
  );
  assert.doesNotThrow(() =>
    assertForegroundLifecycle(
      {
        ...valid,
        createdAt: "2026-08-23 00:00:00.000",
        startedAt: "2026-08-23 00:00:00.000",
        taskCreatedAt: "2026-08-23 00:00:00.000",
        taskStartedAt: "2026-08-23 00:00:00.000",
        lastAttemptStartedAt: "2026-08-23 00:00:00.000",
      },
      "running",
      "legacy naive timestamp lifecycle",
    ),
  );
  assert.doesNotThrow(() =>
    assertForegroundLifecycle(
      {
        ...valid,
        taskStatus: "completed",
        lastAttemptStatus: "completed",
        createdAt: "2026-08-23T09:00:00.000000001+09:00",
        startedAt: "2026-08-23T00:00:00.000000002Z",
        taskCreatedAt: "2026-08-23T00:00:00.000000003Z",
        taskStartedAt: "2026-08-23T00:00:00.000000004Z",
        lastAttemptStartedAt: "2026-08-23T00:00:00.000000004Z",
        completedAt: "2026-08-23T00:00:00.000000005Z",
        taskCompletedAt: "2026-08-23T00:00:00.000000005Z",
        lastAttemptCompletedAt: "2026-08-23T00:00:00.000000005Z",
      },
      "completed",
      "sub-millisecond timestamp lifecycle",
    ),
  );
  for (const timestamp of [
    "2026-08-23T00:00:00+0900",
    "2026-08-23T00:00:00.000Z ",
    "2026-02-30T00:00:00.000Z",
    "2026-08-23T00:00:00",
    "2026-08-23T00:00:00.1234567890Z",
  ]) {
    assert.throws(
      () =>
        assertForegroundLifecycle(
          {
            ...valid,
            createdAt: timestamp,
            startedAt: timestamp,
            taskCreatedAt: timestamp,
            taskStartedAt: timestamp,
            lastAttemptStartedAt: timestamp,
          },
          "running",
          `malformed timestamp ${timestamp}`,
        ),
      /timestamp/,
    );
  }
});

test("wall-clock bounds and overlap use the exact instant representation", () => {
  const {
    assertWallClockIntervalContains,
    assertWallClockLowerBound,
  } = narrativeMaintenanceProductJourneys;
  assert.equal(typeof assertWallClockLowerBound, "function");
  assert.equal(typeof assertWallClockIntervalContains, "function");

  const openLowerBound = Date.parse("2026-08-23T00:00:00.001Z");
  assert.doesNotThrow(() =>
    assertWallClockLowerBound(
      "2026-08-23T00:00:00.001000000Z",
      openLowerBound,
      "current workspace wake Run",
    ),
  );
  assert.throws(
    () =>
      assertWallClockLowerBound(
        "2026-08-23T00:00:00.000999999Z",
        openLowerBound,
        "old workspace wake Run",
      ),
    /predates/,
  );

  const schedulerStartedAt = "2026-08-23T00:00:00.001000000Z";
  const schedulerCompletedAt = "2026-08-23T00:00:00.003000000Z";
  assert.doesNotThrow(() =>
    assertWallClockIntervalContains(
      Date.parse("2026-08-23T00:00:00.001500Z"),
      Date.parse("2026-08-23T00:00:00.002500Z"),
      schedulerStartedAt,
      schedulerCompletedAt,
      "current foreground write",
    ),
  );
  assert.throws(
    () =>
      assertWallClockIntervalContains(
        Date.parse("2026-08-23T00:00:00.000500Z"),
        Date.parse("2026-08-23T00:00:00.002500Z"),
        schedulerStartedAt,
        schedulerCompletedAt,
        "old foreground write",
      ),
    /overlap/,
  );
});

test("instant comparison preserves Chrono leap-second ordering and precision", () => {
  const { compareInstants } = narrativeMaintenanceProductJourneys;
  assert.equal(typeof compareInstants, "function");
  assert.equal(
    compareInstants(
      "2026-08-23T23:59:59.999999999Z",
      "2026-08-23T23:59:60.000000000Z",
    ),
    -1,
  );
  assert.equal(
    compareInstants(
      "2026-08-23T23:59:60.999999999Z",
      "2026-08-24T00:00:00.000000000Z",
    ),
    -1,
  );
  assert.equal(
    compareInstants(
      "2026-08-24T00:00:00.000000000Z",
      "2026-08-24T00:00:01.000000000Z",
    ),
    -1,
  );
  assert.equal(
    compareInstants(
      "2026-08-23T09:00:00.000000001+09:00",
      "2026-08-23T00:00:00.000000001Z",
    ),
    0,
  );
  assert.equal(
    compareInstants(
      "2026-08-23 00:00:00.000000001",
      "2026-08-23T00:00:00.000000001Z",
    ),
    0,
  );
  assert.equal(
    compareInstants(
      "2026-08-23T00:00:00.000000001Z",
      "2026-08-23T00:00:00.000000000Z",
    ),
    1,
  );
  assert.throws(
    () =>
      compareInstants(
        "2026-08-23T00:00:00.1234567890Z",
        "2026-08-23T00:00:00.123456789Z",
      ),
    /timestamp/,
  );
});

test("legacy naive timestamps preserve Chrono signed proleptic years", () => {
  const { compareInstants, parseInstant } = narrativeMaintenanceProductJourneys;
  assert.equal(typeof parseInstant, "function");
  assert.doesNotThrow(() => parseInstant("-0001-01-01 00:00:00"));
  assert.doesNotThrow(() => parseInstant("+10000-01-01 00:00:00"));
  assert.equal(
    compareInstants(
      "-0001-01-01 00:00:00",
      "+10000-01-01 00:00:00",
    ),
    -1,
  );
  assert.doesNotThrow(() => parseInstant("-262143-01-01 00:00:00"));
  assert.doesNotThrow(() => parseInstant("+262142-12-31 23:59:59"));

  for (const timestamp of [
    "-262144-01-01 00:00:00",
    "+262143-12-31 23:59:59",
    "-262145-01-01 00:00:00",
    "+262144-01-01 00:00:00",
    "262144-01-01 00:00:00",
    "+-10000-01-01 00:00:00",
    "-+0001-01-01 00:00:00",
    "+-01-01 00:00:00",
    "-0001/01/01 00:00:00",
  ]) {
    assert.throws(
      () => parseInstant(timestamp),
      /timestamp/,
      `malformed or out-of-range legacy year must fail: ${timestamp}`,
    );
  }
  assert.throws(
    () => parseInstant("+10000T00:00:00Z"),
    /timestamp/,
    "RFC3339 must retain its four unsigned year digits",
  );
});

test("transient retry validates every distinct same-work lifecycle in order", () => {
  const sequenceValidator =
    narrativeMaintenanceProductJourneys.assertTransientRunSequence;
  assert.equal(
    typeof sequenceValidator,
    "function",
    "the product journey must expose the exact transient sequence validator",
  );
  const base = {
    projectId: "project-1",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    semanticEpochId: "epoch-1",
    taskCount: 1,
    attemptCount: 1,
    taskKind: "maintenance-backfill",
    taskAttemptCount: 1,
    lastAttemptNumber: 1,
    maxAttemptNumber: 1,
    specJson: '{"backfillAlgorithmVersion":"2"}',
    taskInputJson: '{"backfillAlgorithmVersion":"2"}',
    startedAt: "2026-08-23T00:00:00.000000001Z",
    taskCreatedAt: "2026-08-23T00:00:00.000000002Z",
    taskStartedAt: "2026-08-23T00:00:00.000000003Z",
    lastAttemptStartedAt: "2026-08-23T00:00:00.000000003Z",
  };
  const failed = {
    ...base,
    id: "failed-run",
    status: "failed",
    terminalReasonCode: NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
    taskStatus: "failed",
    lastAttemptStatus: "failed",
    lastAttemptFailureCode: NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
    createdAt: "2026-08-23T00:00:00.000000001Z",
    completedAt: "2026-08-23T00:00:00.000000004Z",
    taskCompletedAt: "2026-08-23T00:00:00.000000004Z",
    lastAttemptCompletedAt: "2026-08-23T00:00:00.000000004Z",
  };
  const completed = {
    ...base,
    id: "completed-run",
    status: "completed",
    taskStatus: "completed",
    lastAttemptStatus: "completed",
    createdAt: "2026-08-23T00:00:01.000000001Z",
    startedAt: "2026-08-23T00:00:01.000000001Z",
    taskCreatedAt: "2026-08-23T00:00:01.000000002Z",
    taskStartedAt: "2026-08-23T00:00:01.000000003Z",
    lastAttemptStartedAt: "2026-08-23T00:00:01.000000003Z",
    completedAt: "2026-08-23T00:00:01.000000004Z",
    taskCompletedAt: "2026-08-23T00:00:01.000000004Z",
    lastAttemptCompletedAt: "2026-08-23T00:00:01.000000004Z",
    outcomeSummaryJson: JSON.stringify({
      maintenancePhase: "backfill-complete",
      backfillAlgorithmVersion: "2",
      semanticEpochId: "epoch-1",
      summary: {
        epoch_created: false,
        contributions_created: 0,
        edges_created: 0,
        applications_without_run_id: 0,
      },
    }),
  };
  assert.doesNotThrow(() => sequenceValidator([failed, completed]));
  assert.throws(
    () =>
      sequenceValidator([
        failed,
        { ...completed, taskKind: "wrong-kind" },
      ]),
    /Task kind/,
  );
  assert.throws(
    () =>
      sequenceValidator([
        failed,
        completed,
        {
          ...failed,
          id: "third-run",
          lastAttemptNumber: 2,
          createdAt: "2026-08-23T00:00:02.000000001Z",
        },
      ]),
    /Attempt #1/,
  );
  assert.throws(
    () =>
      sequenceValidator([
        {
          ...failed,
          createdAt: completed.createdAt,
          startedAt: completed.startedAt,
          taskCreatedAt: completed.taskCreatedAt,
          taskStartedAt: completed.taskStartedAt,
          lastAttemptStartedAt: completed.lastAttemptStartedAt,
          completedAt: completed.completedAt,
          taskCompletedAt: completed.taskCompletedAt,
          lastAttemptCompletedAt: completed.lastAttemptCompletedAt,
        },
        completed,
      ]),
    /strictly increasing/,
  );
  assert.throws(
    () => sequenceValidator([failed, completed, { ...completed, id: "third-completed" }, { ...completed, id: "fourth-completed" }]),
    /at most three/,
  );
  assert.throws(
    () =>
      sequenceValidator([
        failed,
        completed,
        {
          ...failed,
          id: "third-failed",
          createdAt: "2026-08-23T00:00:02.000000001Z",
          startedAt: "2026-08-23T00:00:02.000000001Z",
          taskCreatedAt: "2026-08-23T00:00:02.000000002Z",
          taskStartedAt: "2026-08-23T00:00:02.000000003Z",
          lastAttemptStartedAt: "2026-08-23T00:00:02.000000003Z",
          completedAt: "2026-08-23T00:00:02.000000004Z",
          taskCompletedAt: "2026-08-23T00:00:02.000000004Z",
          lastAttemptCompletedAt: "2026-08-23T00:00:02.000000004Z",
        },
      ]),
    /completed Run must be final/,
  );
});

test("c2-5b runner set is explicit and preserves stable order", () => {
  const selected = resolveProductJourneySet("c2-5b");
  assert.deepEqual(
    selected.map((journey) => journey.id),
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS.map((journey) => journey.id),
  );
  assert.equal(selected.length, 11);
});

test("C2-5B fault and trigger seams are closed enums", () => {
  assert.deepEqual(NARRATIVE_MAINTENANCE_FAULTS, [
    "transient-io",
    "contract-violation",
    "process-interruption",
  ]);
  assert.deepEqual(NARRATIVE_MAINTENANCE_TRIGGERS, [
    "dependency-gap",
    "foreground-workspace-wake",
    "graphContractDigest-changed",
    "ruleRegistryDigest-changed",
    "producerGenerationSetDigest-changed",
  ]);
});

test("C2-5B journey seam constants keep exact durable failure contracts", () => {
  assert.equal(NARRATIVE_MAINTENANCE_TRANSIENT_CODE, "NEX_MAINTENANCE_TRANSIENT");
  assert.equal(
    NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
    "NEX_DEPENDENCY_BACKFILL_CONTRACT_VIOLATION",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_INTERRUPTED_CODE,
    "NEX_MAINTENANCE_INTERRUPTED",
  );
  assert.equal(NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS, 1_250);
  assert.equal(
    NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
    "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_OWNER_TOKEN",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    "c2-5b-product-journey-owner-v1",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
    "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_BARRIER_ID",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
    "GRIMODEX_PRODUCT_JOURNEY_MAINTENANCE_CORRELATION",
  );
  assert.equal(
    NARRATIVE_MAINTENANCE_SEAM_CONTRACT.jsDigestAuthority,
    "durable native outcome skipEvidence fields",
  );
  assert.equal(NARRATIVE_MAINTENANCE_FOREGROUND_TRIGGER, "workspace-opened");
  assert.deepEqual(NARRATIVE_MAINTENANCE_FOREGROUND_SYSTEM_WORK_MARKER, [
    "trigger",
    "canonicalWorkKey",
    "authorityId",
    "generation",
    "productJourneyBarrierId",
    "correlation",
  ]);
});

test("restore fixture evidence is canonical and an empty fixture stays red", () => {
  const expected = {
    projectId: "project-1",
    edgeId: "restore-edge",
    consumerKey: "restore-owner-run",
    sourceObjectIdentity: "project:scene:restore-scene",
    owningRunId: "restore-owner-run",
    readSetToken: "v1@2026-08-23T00:00:00.000Z",
  };
  const edge = {
    ...expected,
    id: expected.edgeId,
    consumerKind: "narrative-extraction-run",
    readSetJson: JSON.stringify([expected.readSetToken]),
    generatedByTransactionId: null,
    owningRunId: expected.owningRunId,
    createdAt: "2026-08-23T00:00:00.000Z",
  };
  assert.doesNotThrow(() => assertRestoreFixtureEvidence([edge], expected));
  assert.throws(
    () => assertRestoreFixtureEvidence([], expected),
    /exactly one canonical dependency Edge/,
    "the old empty setup-disabled backup must not be accepted as restore evidence",
  );
  assert.throws(
    () =>
      assertRestoreFixtureEvidence(
        [{ ...edge, readSetJson: JSON.stringify([]) }],
        expected,
      ),
    /one-token shape/,
  );
  assert.throws(
    () =>
      assertRestoreFixtureEvidence(
        [{ ...edge, sourceObjectIdentity: "project:scene:other" }],
        expected,
      ),
    /not canonical/,
  );
});

test("restore fixture captures the derived-state gap before the normal launch settles it", async () => {
  const source = await readFile(
    new URL(
      "../electron/scripts/narrative-maintenance-product-journeys.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const seedBody = source.match(
    /async function seedRestoreFixtureEvidence\([\s\S]*?\n}\n\n\/\*\*/,
  )?.[0];
  assert.ok(seedBody, "restore fixture seeding helper must remain inspectable");
  assert.ok(
    seedBody.indexOf("createRestoreFixtureDerivedStateGap(context") >= 0,
    "restore fixture must create a real derived-state gap before backup",
  );
  assert.ok(
    seedBody.indexOf("createRestoreFixtureDerivedStateGap(context") <
      seedBody.indexOf("createRestoreBackupFixture(workspace)"),
    "the gap must be captured in the WAL-safe backup",
  );
  const journeyBody = source.match(
    /async function runRestoreVerifyRebuildVerify\([\s\S]*?\n}\n\nasync function runDigestChangeJourney/,
  )?.[0];
  assert.ok(journeyBody, "restore journey helper must remain inspectable");
  assert.equal(
    journeyBody.includes("createRestoreFixtureDerivedStateGap(context"),
    false,
    "normal launch must restore the pre-settled gap image, not create a post-settle clean backup",
  );
});

test("restore sequence binds Verify/Rebuild/confirmation to the new restore Epoch", () => {
  const beforeEpochs = [
    { id: "epoch-initial", epochNumber: 0, reason: "initial" },
  ];
  const restoreEpoch = {
    id: "epoch-restore",
    epochNumber: 1,
    reason: "restore",
    createdAt: "2026-08-23T00:00:00.000Z",
  };
  const instantAtSecond = (second) => {
    const milliseconds = Math.round(second * 1_000);
    const wholeSeconds = Math.floor(milliseconds / 1_000);
    const millisecondPart = milliseconds % 1_000;
    return `2026-08-23T00:00:${String(wholeSeconds).padStart(
      2,
      "0",
    )}.${String(millisecondPart).padStart(3, "0")}Z`;
  };
  const phase = (
    id,
    runKind,
    semanticEpochId = restoreEpoch.id,
    createdSecond = 1,
    completedSecond = createdSecond + 0.5,
  ) => ({
    id,
    runKind,
    semanticEpochId,
    status: "completed",
    createdAt: instantAtSecond(createdSecond),
    completedAt: instantAtSecond(completedSecond),
  });
  assert.doesNotThrow(() =>
    assertRestoreVerifyRebuildVerifyCausality(
      [
        phase("verify-1", "dependency-verify", restoreEpoch.id, 1),
        phase("rebuild-1", "semantic-index-rebuild", restoreEpoch.id, 2),
        phase("verify-2", "dependency-verify", restoreEpoch.id, 3),
      ],
      beforeEpochs,
      [...beforeEpochs, restoreEpoch],
    ),
  );
  assert.throws(
    () =>
      assertRestoreVerifyRebuildVerifyCausality(
        [phase("verify-only", "dependency-verify", restoreEpoch.id, 1)],
        beforeEpochs,
        [...beforeEpochs, restoreEpoch],
      ),
    /exactly Verify -> Rebuild -> confirmation Verify/,
    "the old fixture's Verify-only restore must fail red",
  );
  assert.throws(
    () =>
      assertRestoreVerifyRebuildVerifyCausality(
        [
          phase("verify-old", "dependency-verify", "epoch-initial", 1),
          phase("rebuild-new", "semantic-index-rebuild", restoreEpoch.id, 2),
          phase("verify-new", "dependency-verify", restoreEpoch.id, 3),
        ],
        beforeEpochs,
        [...beforeEpochs, restoreEpoch],
      ),
    /new restore Epoch/,
    "a pre-restore phase must not satisfy post-restore causality",
  );
  assert.throws(
    () =>
      assertRestoreVerifyRebuildVerifyCausality(
        [
          phase("verify-1", "dependency-verify", restoreEpoch.id, 1),
          {
            ...phase(
              "rebuild-1",
              "semantic-index-rebuild",
              restoreEpoch.id,
              2,
            ),
            createdAt: "2026-08-23T00:00:00.500Z",
          },
          phase("verify-2", "dependency-verify", restoreEpoch.id, 3),
        ],
        beforeEpochs,
        [...beforeEpochs, restoreEpoch],
      ),
    /not strictly monotonic|predates/,
    "a sequence with out-of-order durable creation timestamps must stay red",
  );
  assert.throws(
    () =>
      assertRestoreVerifyRebuildVerifyCausality(
        [
          phase("verify-1", "dependency-verify", restoreEpoch.id, 1),
          {
            ...phase(
              "rebuild-overlap",
              "semantic-index-rebuild",
              restoreEpoch.id,
              2,
            ),
            createdAt: "2026-08-23T00:00:01.400Z",
          },
          phase("verify-2", "dependency-verify", restoreEpoch.id, 3),
        ],
        beforeEpochs,
        [...beforeEpochs, restoreEpoch],
      ),
    /lifecycle overlap|prior phase completed/,
    "a phase created before the prior phase completed must stay red",
  );
  assert.throws(
    () =>
      assertRestoreVerifyRebuildVerifyCausality(
        [
          phase("verify-1", "dependency-verify", restoreEpoch.id, 1),
          phase(
            "rebuild-equal-completed",
            "semantic-index-rebuild",
            restoreEpoch.id,
            1.5,
          ),
          phase("verify-2", "dependency-verify", restoreEpoch.id, 3),
        ],
        beforeEpochs,
        [...beforeEpochs, restoreEpoch],
      ),
    /lifecycle overlap|prior phase completed/,
    "a phase created exactly when the prior phase completed must stay red",
  );
  assert.throws(
    () =>
      assertRestoreVerifyRebuildVerifyCausality(
        [
          phase("verify-1", "dependency-verify", restoreEpoch.id, 1),
          phase("rebuild-equal", "semantic-index-rebuild", restoreEpoch.id, 1),
          phase("verify-2", "dependency-verify", restoreEpoch.id, 3),
        ],
        beforeEpochs,
        [...beforeEpochs, restoreEpoch],
      ),
    /not strictly monotonic/,
    "equal lifecycle timestamps must not masquerade as Verify/Rebuild causality",
  );
  assert.throws(
    () =>
      assertRestoreVerifyRebuildVerifyCausality(
        [
          phase("verify-1", "dependency-verify", restoreEpoch.id, 1),
          phase("rebuild-1", "semantic-index-rebuild", restoreEpoch.id, 2),
          phase("verify-2", "dependency-verify", restoreEpoch.id, 3),
          phase("verify-extra", "dependency-verify", restoreEpoch.id, 4),
        ],
        beforeEpochs,
        [...beforeEpochs, restoreEpoch],
      ),
    /exactly Verify -> Rebuild -> confirmation Verify/,
    "an extra post-restore phase must not be hidden by subsequence selection",
  );
});

test("interrupted snapshot selection is page-independent and rejects a pre-existing running Run", () => {
  const baseline = [
    {
      id: "before",
      runKind: "backfill",
      status: "running",
    },
  ];
  const interrupted = {
    id: "interrupted",
    projectId: "project-1",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    semanticEpochId: "epoch-1",
    status: "running",
    taskCount: 1,
    attemptCount: 1,
    taskKind: "maintenance-backfill",
    taskAttemptCount: 1,
    lastAttemptNumber: 1,
    maxAttemptNumber: 1,
    taskStatus: "running",
    lastAttemptStatus: "running",
    specJson: '{"backfillAlgorithmVersion":"2"}',
    taskInputJson: '{"backfillAlgorithmVersion":"2"}',
    createdAt: "2026-08-23T00:00:00.000Z",
    startedAt: "2026-08-23T00:00:00.000Z",
    taskCreatedAt: "2026-08-23T00:00:00.000Z",
    taskStartedAt: "2026-08-23T00:00:00.000Z",
    lastAttemptStartedAt: "2026-08-23T00:00:00.000Z",
  };
  const selected = selectInterruptedRunFromExitSnapshot(
    [...baseline, interrupted],
    baseline,
  );
  assert.equal(selected.id, "interrupted");
  assert.doesNotThrow(() =>
    assertForegroundLifecycle(
      selected,
      "running",
      "complete direct post-exit Run/Task/Attempt snapshot",
    ),
  );
  assert.throws(
    () =>
      selectInterruptedRunFromExitSnapshot(
        [
          ...baseline,
          { ...interrupted, id: "old-running" },
        ],
        [],
      ),
    /exactly one new running Backfill Run/,
  );
});

test("settled interruption recovery rejects duplicate, non-terminal, and stale recovery Runs", () => {
  const makeRun = ({
    id,
    status,
    createdAt,
    completedAt = null,
    terminalReasonCode = null,
  }) => ({
    id,
    projectId: "project-1",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    semanticEpochId: "epoch-1",
    status,
    terminalReasonCode,
    taskCount: 1,
    attemptCount: 1,
    taskKind: "maintenance-backfill",
    taskAttemptCount: 1,
    lastAttemptNumber: 1,
    maxAttemptNumber: 1,
    taskStatus: status,
    lastAttemptStatus: status,
    specJson: '{"backfillAlgorithmVersion":"2"}',
    taskInputJson: '{"backfillAlgorithmVersion":"2"}',
    createdAt,
    startedAt: createdAt,
    taskCreatedAt: createdAt,
    taskStartedAt: createdAt,
    lastAttemptStartedAt: createdAt,
    completedAt,
    taskCompletedAt: completedAt,
    lastAttemptCompletedAt: completedAt,
    lastAttemptFailureCode:
      status === "failed" ? NARRATIVE_MAINTENANCE_INTERRUPTED_CODE : null,
  });
  const stale = makeRun({
    id: "stale-interrupted",
    status: "failed",
    terminalReasonCode: NARRATIVE_MAINTENANCE_INTERRUPTED_CODE,
    createdAt: "2026-08-23T00:00:00.000Z",
    completedAt: "2026-08-23T00:00:02.000Z",
  });
  const postExit = [{ id: "interrupted-running" }, stale];
  const recovery = makeRun({
    id: "recovery",
    status: "completed",
    createdAt: "2026-08-23T00:00:03.000Z",
    completedAt: "2026-08-23T00:00:04.000Z",
  });

  assert.equal(
    selectInterruptedRecoveryFromStableLedger(
      [...postExit, recovery],
      postExit,
      stale,
    ).id,
    "recovery",
  );
  assert.throws(
    () =>
      selectInterruptedRecoveryFromStableLedger(
        [...postExit, recovery, { ...recovery, id: "duplicate-recovery" }],
        postExit,
        stale,
      ),
    /exactly one new same-work recovery Run/,
    "a delayed duplicate recovery must not be hidden by first-match selection",
  );
  assert.throws(
    () =>
      selectInterruptedRecoveryFromStableLedger(
        [
          ...postExit,
          makeRun({
            id: "running-recovery",
            status: "running",
            createdAt: "2026-08-23T00:00:03.000Z",
          }),
        ],
        postExit,
        stale,
      ),
    /did not complete/,
    "a same-work recovery that is still running must remain red",
  );
  assert.throws(
    () =>
      selectInterruptedRecoveryFromStableLedger(
        [
          ...postExit,
          makeRun({
            id: "before-stale-completion",
            status: "completed",
            createdAt: "2026-08-23T00:00:01.000Z",
            completedAt: "2026-08-23T00:00:01.500Z",
          }),
        ],
        postExit,
        stale,
      ),
    /at or before the stale Run completedAt/,
    "a recovery created before stale completion must remain red",
  );
});

test("stable no-automatic-repair assertion rejects a delayed Repair Run", () => {
  const stableRows = [
    { id: "verify", runKind: "dependency-verify", status: "completed" },
    {
      id: "rebuild",
      runKind: "semantic-index-rebuild",
      status: "completed",
    },
    { id: "delayed-repair", runKind: "dependency-repair", status: "completed" },
  ];
  assert.throws(
    () => assertNoAutomaticRepair(stableRows),
    /human-only Repair Run kind/,
    "a Repair Run arriving after Verify/Rebuild must fail the settled ledger assertion",
  );
  assert.doesNotThrow(() =>
    assertNoAutomaticRepair(stableRows.slice(0, 2)),
  );
});

test("foreground target setup rejects an old marked authority and requires one fresh target marker", () => {
  const expected = {
    barrierId: "target-barrier",
    correlation: "target-correlation",
    trigger: "workspace-opened",
  };
  const marked = {
    id: "old-authority-run",
    projectId: "project-a",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    semanticEpochId: "epoch-a",
    status: "running",
    specJson: JSON.stringify({
      systemWork: {
        trigger: expected.trigger,
        canonicalWorkKey:
          "narrative-maintenance:v1/backfill/project-a/legacy-dependency-backfill:v2/epoch/epoch-a",
        authorityId: "authority-old",
        generation: 1,
        productJourneyBarrierId: expected.barrierId,
        correlation: expected.correlation,
      },
    }),
  };
  const targetMarked = {
    ...marked,
    id: "target-authority-run",
    specJson: JSON.stringify({
      systemWork: {
        ...JSON.parse(marked.specJson).systemWork,
        authorityId: "authority-target",
        generation: 2,
      },
    }),
  };
  assert.throws(
    () => assertForegroundTargetBaseline([marked], expected, "target A"),
    /old marked authority/,
    "an initial marked Run from the old authority cannot be the target A pre-open baseline",
  );
  assert.doesNotThrow(() =>
    assertForegroundTargetBaseline([], expected, "target A"),
  );
  assert.equal(
    selectForegroundTargetMarker([targetMarked], [], expected).id,
    "target-authority-run",
  );
  assert.throws(
    () =>
      selectForegroundTargetMarker(
        [targetMarked, { ...targetMarked, id: "duplicate-target-run" }],
        [],
        expected,
      ),
    /exactly one fresh target marker/,
    "one target open must not accept duplicate marked Runs",
  );
});

test("settled freshness cursor requires the canonical released reservation shape", () => {
  assert.equal(
    isSettledFreshnessCursor({
      acknowledgedThrough: 2,
      reservedThrough: null,
      activeRunId: null,
      semanticEpochId: null,
      lastError: null,
    }),
    true,
  );
  for (const field of ["reservedThrough", "activeRunId", "semanticEpochId", "lastError"]) {
    assert.equal(
      isSettledFreshnessCursor({
        acknowledgedThrough: 2,
        reservedThrough: null,
        activeRunId: null,
        semanticEpochId: null,
        lastError: null,
        [field]: field === "lastError" ? "stale" : "epoch-1",
      }),
      false,
      `${field} must remain released/null for readiness`,
    );
  }
});

test("foreground marker selects one native Run by immutable barrier, not row order", () => {
  const expected = {
    barrierId: "barrier-unique",
    correlation: "correlation-unique",
    trigger: "workspace-opened",
  };
  const unrelatedFreshness = {
    id: "freshness-unrelated",
    projectId: "project-1",
    runKind: "freshness-evaluation",
    workKey: "incremental-freshness",
    semanticEpochId: "epoch-1",
    status: "running",
    specJson: JSON.stringify({ domain: "freshness" }),
  };
  const markedRun = {
    id: "marked-run",
    projectId: "project-1",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
    semanticEpochId: "epoch-1",
    status: "running",
    specJson: JSON.stringify({
      systemWork: {
        trigger: "workspace-opened",
        canonicalWorkKey:
          "narrative-maintenance:v1/backfill/project-1/legacy-dependency-backfill:v2/epoch/epoch-1",
        authorityId: "authority-1",
        generation: 7,
        productJourneyBarrierId: expected.barrierId,
        correlation: expected.correlation,
      },
    }),
  };
  const selected = foregroundMarkedRuns(
    [unrelatedFreshness, markedRun],
    [],
    expected,
  );
  assert.deepEqual(selected.map((run) => run.id), ["marked-run"]);
  assert.equal(
    assertForegroundRunMarker(markedRun, expected).marker.authorityId,
    "authority-1",
  );
  assert.throws(
    () =>
      assertForegroundRunMarker(
        {
          ...markedRun,
          specJson: JSON.stringify({
            systemWork: {
              ...JSON.parse(markedRun.specJson).systemWork,
              productJourneyBarrierId: "wrong-barrier",
            },
          }),
        },
        expected,
      ),
    /productJourneyBarrierId/,
  );
  assert.throws(
    () =>
      assertForegroundRunMarker(
        {
          ...markedRun,
          specJson: JSON.stringify({
            systemWork: {
              ...JSON.parse(markedRun.specJson).systemWork,
              generation: 0,
            },
          }),
        },
        expected,
      ),
    /generation/,
  );
});

test("transient and terminal validators reject fallback and same-millisecond false greens", () => {
  assert.throws(
    () =>
      assertTransientAttemptEvidence({
        terminalReasonCode: NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
        lastAttemptStatus: "failed",
        lastAttemptFailureCode: null,
        attemptCount: 2,
        maxAttemptNumber: 2,
      }),
    /exact NEX_MAINTENANCE_TRANSIENT/,
  );
  const oneAttemptTransient = {
    status: "failed",
    taskCount: 1,
    attemptCount: 1,
    taskAttemptCount: 1,
    lastAttemptNumber: 1,
    maxAttemptNumber: 1,
    lastAttemptStatus: "failed",
    lastAttemptFailureCode: NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
  };
  assert.doesNotThrow(() => assertTransientAttemptEvidence(oneAttemptTransient));
  assert.throws(
    () =>
      assertTransientAttemptEvidence({
        ...oneAttemptTransient,
        attemptCount: 2,
      }),
    /exactly one Task and Attempt/,
  );
  assert.throws(
    () =>
      assertTransientAttemptEvidence({
        ...oneAttemptTransient,
        maxAttemptNumber: 2,
      }),
    /Attempt #1/,
  );
  assert.throws(
    () =>
      assertTerminalFailureEvidence({
        status: "failed",
        terminalReasonCode: NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
        completedAt: null,
      }),
    /completedAt/,
  );
  const failed = {
    id: "failed-run",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v2",
  };
  assert.deepEqual(
    terminalRetryCandidates(
      [
        failed,
        { ...failed, id: "same-ms-retry" },
        {
          ...failed,
          id: "other-work",
          workKey: "different-work",
        },
      ],
      failed,
    ).map((run) => run.id),
    ["same-ms-retry"],
  );
});

test("every actual C2-5B Electron launch phase is registered for diagnostics", async () => {
  assert.equal(
    new Set(NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES).size,
    NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES.length,
    "C2-5B launch phases must be unique",
  );
  for (const phase of NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES) {
    assert.ok(PRODUCT_JOURNEY_ELECTRON_PHASES.includes(phase), phase);
  }
  const registeredC2Phases = PRODUCT_JOURNEY_ELECTRON_PHASES.filter((phase) =>
    phase.startsWith("c2-5b-"),
  );
  assert.deepEqual(
    registeredC2Phases,
    NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES,
    "C2-5B launch phase registry must stay in parity with the runner",
  );
  const source = await readFile(
    new URL(
      "../electron/scripts/narrative-maintenance-product-journeys.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const restoreJourneyBody = source.match(
    /async function runRestoreVerifyRebuildVerify\([\s\S]*?\n}\n\nasync function runDigestChangeJourney/,
  )?.[0];
  assert.ok(restoreJourneyBody, "restore journey caller must remain inspectable");
  assert.match(
    restoreJourneyBody,
    /const id = "c2-5b-restore-verify-rebuild-verify";/,
    "restore journey must bind its fixture to its own journey id",
  );
  assert.match(
    restoreJourneyBody,
    /seedRestoreFixtureEvidence\(\s*harness,\s*workspace,\s*id,\s*\)/,
    "restore journey must seed its own restore-fixture caller",
  );
  assert.match(
    restoreJourneyBody,
    /harness\.launch\(`\$\{id\}\/open`\)/,
    "restore journey must launch its own open phase after fixture setup",
  );

  const noRepairJourneyBody = source.match(
    /async function runNoAutomaticRepair\([\s\S]*?\n}\n\nasync function runForegroundWriteWorkspaceWake/,
  )?.[0];
  assert.ok(
    noRepairJourneyBody,
    "no-automatic-repair journey caller must remain inspectable",
  );
  assert.match(
    noRepairJourneyBody,
    /seedRestoreFixtureEvidence\(\s*harness,\s*preparedWorkspace,\s*"c2-5b-no-automatic-repair"\s*,\s*\)/,
    "no-automatic-repair must bind fixture setup to its own journey id",
  );
  const foregroundJourneyBody = source.match(
    /async function runForegroundWriteWorkspaceWake\([\s\S]*?\n}\n\nasync function runIncrementalLiveness/,
  )?.[0];
  assert.ok(
    foregroundJourneyBody,
    "foreground workspace-wake journey caller must remain inspectable",
  );
  assert.match(
    foregroundJourneyBody,
    /harness\.launch\(`\$\{id\}\/settle-primary`\)/,
    "foreground workspace-wake must retain its settle-primary launch phase",
  );
});

test("c2-5b runner IDs are wired to the central catalog and impact selector", () => {
  assert.deepEqual(
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEYS.map((journey) => journey.id),
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  const selection = selectProductJourneys({
    catalog: NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: [
      "electron/scripts/narrative-maintenance-product-journeys.mjs",
    ],
    mode: "all",
  });
  assert.deepEqual(
    selection.journeyIds,
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.equal(selection.allSelected, true);
});

test("maintenance source changes select the executable C2-5B journey subset", () => {
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  for (const changedPath of [
    "src-tauri/crates/grimodex-db/src/narrative_extraction/legacy_backfill.rs",
    "electron/native/grimodex-node/src/lib.rs",
    "electron/main/narrativeFreshness.ts",
    "policies/narrative/narrative-run-kind-policy.json",
  ]) {
    const selection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
      mode: "affected",
    });
    assert.deepEqual(
      expectedIds.filter((id) => selection.journeyIds.includes(id)),
      expectedIds,
      changedPath,
    );
  }
});

test("C2-5B runtime/semantic impact is direct for every launch owner path", async () => {
  const [impactSource, qualityManifest] = await Promise.all([
    readFile(new URL("../evals/impact-map.yaml", import.meta.url), "utf8"),
    readFile(
      new URL("../evals/quality-manifest.yaml", import.meta.url),
      "utf8",
    ),
  ]);
  const impactMap = parseImpactMap(impactSource);
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  const ownerPaths = [
    ...NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS,
    "src-tauri/crates/grimodex-db/src/migrate.rs",
    "src-tauri/crates/grimodex-core/src/workspace_schema.rs",
    "src-tauri/crates/grimodex-db/src/backup_restore.rs",
  ];
  for (const changedPath of ownerPaths) {
    assert.ok(
      qualityManifest.includes(`- ${changedPath}`),
      `${changedPath} must remain traceable in the quality manifest`,
    );
    const productSelection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
      mode: "affected",
    });
    assert.deepEqual(productSelection.journeyIds, expectedIds, changedPath);
    assert.equal(productSelection.fallback, false, changedPath);
    assert.equal(productSelection.allSelected, false, changedPath);
    assert.ok(
      productSelection.matchedRuleIds.includes(
        "narrative-maintenance-product-journeys",
      ),
      changedPath,
    );

    const qualitySelection = selectImpact(impactMap, [changedPath]);
    assert.equal(qualitySelection.fallback, false, changedPath);
    assert.ok(
      qualitySelection.matchedRuleIds.includes("narrative-runtime-authority"),
      changedPath,
    );
    assert.ok(
      qualitySelection.matchedRuleIds.includes("narrative-semantic-contract"),
      changedPath,
    );
    assert.ok(
      qualitySelection.suiteIds.includes("narrative-runtime"),
      changedPath,
    );
    assert.ok(
      qualitySelection.suiteIds.includes("narrative-semantic-contract"),
      changedPath,
    );
  }
});

test("current C2-5B scheduler owner tests route directly to product and quality gates", async () => {
  const [entries, impactSource, qualityManifestSource] = await Promise.all([
    readdir(new URL("../electron/main/", import.meta.url), {
      withFileTypes: true,
    }),
    readFile(new URL("../evals/impact-map.yaml", import.meta.url), "utf8"),
    readFile(
      new URL("../evals/quality-manifest.yaml", import.meta.url),
      "utf8",
    ),
  ]);
  const currentOwnerTests = [
    ...entries
      .filter(
        (entry) =>
          entry.isFile() &&
          entry.name.startsWith("narrativeMaintenance") &&
          entry.name.endsWith(".test.ts"),
      )
      .map((entry) => `electron/main/${entry.name}`),
    "electron/main/foregroundBarrierRelease.test.ts",
  ].sort();
  const qualityManifest = yaml.load(qualityManifestSource);
  const requirements = new Map(
    qualityManifest.requirements.map((requirement) => [
      requirement.id,
      requirement,
    ]),
  );
  const impactMap = parseImpactMap(impactSource);
  const expectedProductJourneyIds =
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
      (journey) => journey.id,
    );
  const expectedQualityRuleIds = [
    "narrative-runtime-authority",
    "narrative-semantic-contract",
  ];
  const expectedQualitySuiteIds = [
    "narrative-runtime",
    "narrative-semantic-contract",
  ];

  assert.ok(currentOwnerTests.length > 0);
  for (const changedPath of currentOwnerTests) {
    assert.ok(
      NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS.includes(changedPath),
      `${changedPath} must be an explicit C2-5B owner path`,
    );
    for (const requirementId of [
      "GDX-POLICY-001",
      "GDX-NARR-SEMANTIC-CONTRACT-001",
    ]) {
      assert.ok(
        requirements.get(requirementId)?.implementedBy.includes(changedPath),
        `${changedPath} must be traceable in ${requirementId}.implementedBy`,
      );
    }

    const productSelection = selectProductJourneys({
      catalog: PRODUCT_JOURNEY_CATALOG,
      domainRules: PRODUCT_DOMAIN_RULES,
      changedPaths: [changedPath],
      mode: "affected",
    });
    assert.deepEqual(productSelection.journeyIds, expectedProductJourneyIds);
    assert.equal(productSelection.fallback, false, changedPath);
    assert.equal(productSelection.allSelected, false, changedPath);
    assert.ok(
      productSelection.matchedRuleIds.includes(
        "narrative-maintenance-product-journeys",
      ),
      changedPath,
    );

    const qualitySelection = selectImpact(impactMap, [changedPath]);
    assert.equal(qualitySelection.fallback, false, changedPath);
    assert.deepEqual(qualitySelection.unmatchedPaths, [], changedPath);
    for (const ruleId of expectedQualityRuleIds) {
      assert.ok(qualitySelection.matchedRuleIds.includes(ruleId), changedPath);
    }
    for (const suiteId of expectedQualitySuiteIds) {
      assert.ok(qualitySelection.suiteIds.includes(suiteId), changedPath);
    }
  }
});

test("future narrativeMaintenance files route directly without safe-all fallback", async () => {
  const impactMap = parseImpactMap(
    await readFile(new URL("../evals/impact-map.yaml", import.meta.url), "utf8"),
  );
  const changedPath =
    "electron/main/narrativeMaintenance.futureRegression.test.ts";
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  const productSelection = selectProductJourneys({
    catalog: PRODUCT_JOURNEY_CATALOG,
    domainRules: PRODUCT_DOMAIN_RULES,
    changedPaths: [changedPath],
    mode: "affected",
  });
  assert.deepEqual(productSelection.journeyIds, expectedIds);
  assert.equal(productSelection.fallback, false);
  assert.equal(productSelection.allSelected, false);
  assert.ok(
    productSelection.matchedRuleIds.includes(
      "narrative-maintenance-product-journeys",
    ),
  );
  const qualitySelection = selectImpact(impactMap, [changedPath]);
  assert.equal(qualitySelection.fallback, false);
  assert.ok(
    qualitySelection.matchedRuleIds.includes("narrative-runtime-authority"),
  );
  assert.ok(
    qualitySelection.matchedRuleIds.includes("narrative-semantic-contract"),
  );
  assert.ok(qualitySelection.suiteIds.includes("narrative-runtime"));
  assert.ok(
    qualitySelection.suiteIds.includes("narrative-semantic-contract"),
  );
  assert.ok(
    PRODUCT_DOMAIN_RULES.find(
      (rule) => rule.id === "narrative-maintenance-product-journeys",
    )?.paths.includes(NARRATIVE_MAINTENANCE_ELECTRON_OWNER_GLOB),
  );
});

test("current narrativeMaintenance inventory remains explicit in the quality manifest", async () => {
  const [entries, qualityManifest] = await Promise.all([
    readdir(new URL("../electron/main/", import.meta.url), {
      withFileTypes: true,
    }),
    readFile(
      new URL("../evals/quality-manifest.yaml", import.meta.url),
      "utf8",
    ),
  ]);
  const currentInventory = entries
    .filter(
      (entry) =>
        entry.isFile() &&
        entry.name.startsWith("narrativeMaintenance") &&
        entry.name.endsWith(".ts"),
    )
    .map((entry) => `electron/main/${entry.name}`)
    .sort();
  assert.ok(currentInventory.length > 0);
  for (const path of currentInventory) {
    assert.ok(
      NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS.includes(path),
      `${path} must be represented by the explicit maintenance owner inventory`,
    );
    assert.ok(
      qualityManifest.includes(`- ${path}`),
      `${path} must remain an explicit quality-manifest implementation path`,
    );
  }
});

test("central impact catalog emits C2-5B IDs that the Electron runner can execute", () => {
  const reportCatalog = resolveProductJourneyImpactCatalog("c2-5b");
  const expectedIds = NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG.map(
    (journey) => journey.id,
  );
  assert.deepEqual(
    reportCatalog.map((journey) => journey.id),
    expectedIds,
  );
});

test("c2-5b selector executes only explicitly selected durable journeys", () => {
  const set = resolveProductJourneySet("c2-5b");
  const selected = resolveSelectedProductJourneys(
    set,
    JSON.stringify([
      "c2-5b-terminal-failure-inbox",
      "c2-5b-incremental-liveness",
    ]),
  );
  assert.deepEqual(
    selected.map((journey) => journey.id),
    ["c2-5b-terminal-failure-inbox", "c2-5b-incremental-liveness"],
  );
});
