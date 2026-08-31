import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
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
  NARRATIVE_MAINTENANCE_NONCE_ENV,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
  NARRATIVE_MAINTENANCE_RETRY_OBSERVATION_MS,
  NARRATIVE_MAINTENANCE_SEAM_CONTRACT,
  NARRATIVE_MAINTENANCE_SETUP_ENV,
  NARRATIVE_FRESHNESS_DISABLE_ENV,
  NARRATIVE_MAINTENANCE_TERMINAL_CONTRACT_CODE,
  NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
  NARRATIVE_MAINTENANCE_TRIGGERS,
  assertRestoreFixtureEvidence,
  assertRestoreFixturePreGapReadiness,
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
  runRestoreVerifyRebuildVerifyScenario,
  selectChangedDigestRun,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import * as narrativeMaintenanceProductJourneys from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import {
  NARRATIVE_MAINTENANCE_ELECTRON_OWNER_GLOB,
  NARRATIVE_MAINTENANCE_ELECTRON_OWNER_PATHS,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
  PRODUCT_DOMAIN_RULES,
} from "../electron/scripts/product-journey-catalog.mjs";
import {
  expectedNarrativeMaintenanceCiReceipt,
  PRODUCT_JOURNEY_ELECTRON_PHASES,
} from "../electron/scripts/product-journey-harness.mjs";
import {
  resolveProductJourneyImpactCatalog,
  selectProductJourneys,
} from "../electron/scripts/product-journey-impact.mjs";
import { parseImpactMap, selectImpact } from "./quality/impact-map.mjs";

const execFile = promisify(execFileCallback);

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
  insert("INSERT INTO narrative_extraction_tasks (id, run_id) VALUES (?, ?)", [
    "task-1",
    "run-1",
  ]);
  insert("INSERT INTO narrative_extraction_tasks (id, run_id) VALUES (?, ?)", [
    "task-2",
    "run-2",
  ]);
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
    specJson: '{"backfillAlgorithmVersion":"3"}',
    taskInputJson: '{"backfillAlgorithmVersion":"3"}',
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
      () =>
        assertForegroundLifecycle(corrupted, "completed", `corrupt ${field}`),
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
    specJson: '{"backfillAlgorithmVersion":"3"}',
    taskInputJson: '{"backfillAlgorithmVersion":"3"}',
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
    specJson: '{"backfillAlgorithmVersion":"3"}',
    taskInputJson: '{"backfillAlgorithmVersion":"3"}',
    createdAt: "2026-08-23T00:00:00.000Z",
    startedAt: "2026-08-23T00:00:00.000Z",
    taskCreatedAt: "2026-08-23T00:00:00.000Z",
    taskStartedAt: "2026-08-23T00:00:00.000Z",
    lastAttemptStartedAt: "2026-08-23T00:00:00.000Z",
  };
  assert.doesNotThrow(() =>
    assertForegroundLifecycle(
      valid,
      "running",
      "canonical timestamp lifecycle",
    ),
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
  const { assertWallClockIntervalContains, assertWallClockLowerBound } =
    narrativeMaintenanceProductJourneys;
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
    compareInstants("-0001-01-01 00:00:00", "+10000-01-01 00:00:00"),
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
    workKey: "legacy-dependency-backfill:v3",
    semanticEpochId: "epoch-1",
    taskCount: 1,
    attemptCount: 1,
    taskKind: "maintenance-backfill",
    taskAttemptCount: 1,
    lastAttemptNumber: 1,
    maxAttemptNumber: 1,
    specJson: '{"backfillAlgorithmVersion":"3"}',
    taskInputJson: '{"backfillAlgorithmVersion":"3"}',
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
      backfillAlgorithmVersion: "3",
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
    () => sequenceValidator([failed, { ...completed, taskKind: "wrong-kind" }]),
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
    () =>
      sequenceValidator([
        failed,
        completed,
        { ...completed, id: "third-completed" },
        { ...completed, id: "fourth-completed" },
      ]),
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

test("digest-change journey waits past canonical Verify runs for the changed coordinate", () => {
  const evidence = {
    graphContractDigest: "sha256:graph-current",
    ruleRegistryDigest: "sha256:rule-current",
    producerGenerationSetDigest: "sha256:producer-current",
    graphStateDigest: "sha256:state-before",
  };
  const run = (id, status, nextEvidence) => ({
    id,
    runKind: "dependency-verify",
    status,
    outcomeSummaryJson: JSON.stringify({ skipEvidence: nextEvidence }),
  });
  const baseline = run("baseline", "completed", evidence);
  const canonical = run("canonical", "completed", {
    ...evidence,
    graphStateDigest: "sha256:state-after",
  });
  const pendingChanged = run("pending-changed", "running", {
    ...evidence,
    graphContractDigest: "sha256:graph-changed",
    graphStateDigest: "sha256:state-after",
  });
  const changed = run("changed", "completed", {
    ...evidence,
    graphContractDigest: "sha256:graph-changed",
    graphStateDigest: "sha256:state-after",
  });

  assert.equal(
    selectChangedDigestRun(
      [baseline, canonical, pendingChanged],
      [baseline],
      "graphContractDigest",
      evidence,
    ),
    null,
    "an intervening canonical or incomplete Verify must not end the wait",
  );
  assert.deepEqual(
    selectChangedDigestRun(
      [baseline, canonical, pendingChanged, changed],
      [baseline],
      "graphContractDigest",
      evidence,
    ),
    {
      run: changed,
      evidence: JSON.parse(changed.outcomeSummaryJson).skipEvidence,
    },
  );
});

test("C2-5B journey seam constants keep exact durable failure contracts", () => {
  assert.equal(
    NARRATIVE_MAINTENANCE_TRANSIENT_CODE,
    "NEX_MAINTENANCE_TRANSIENT",
  );
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

test("C2-5B restore scenario phases capture an active owner receipt per launch", async () => {
  const restoreLaunchPhase =
    narrativeMaintenanceProductJourneys.launchRestoreVerifyRebuildVerifyRestorePhaseForTest;
  const launchPhase =
    narrativeMaintenanceProductJourneys.launchRestoreVerifyRebuildVerifyPhaseForTest;
  assert.equal(
    typeof restoreLaunchPhase,
    "function",
    "the production restore phase launcher must expose only a narrow test injection seam",
  );
  assert.equal(
    typeof launchPhase,
    "function",
    "the production phase launcher must expose only a narrow test injection seam",
  );

  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  const previousNonce = process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
  const previousSetup = process.env[NARRATIVE_MAINTENANCE_SETUP_ENV];
  const previousFreshness = process.env[NARRATIVE_FRESHNESS_DISABLE_ENV];
  const unrelatedEnv = "GRIMODEX_PRODUCT_JOURNEY_UNRELATED_SENTINEL";
  const previousUnrelated = process.env[unrelatedEnv];
  const inheritedOwner = "pre-existing-owner-value";
  const inheritedNonce = "00000000-0000-4000-8000-000000000001";
  const inheritedSetup = "pre-existing-setup-value";
  const inheritedFreshness = "pre-existing-freshness-value";
  process.env.CI = "true";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = inheritedOwner;
  process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = inheritedNonce;
  process.env[NARRATIVE_MAINTENANCE_SETUP_ENV] = inheritedSetup;
  process.env[NARRATIVE_FRESHNESS_DISABLE_ENV] = inheritedFreshness;
  process.env[unrelatedEnv] = "preserve-me";

  const captured = [];
  const phases = [
    {
      launcher: restoreLaunchPhase,
      name: "c2-5b-restore-verify-rebuild-verify/restore",
      environment: {},
      expectedEnvironment: {
        setup: NARRATIVE_MAINTENANCE_SEAM_CONTRACT.setupDisabledValue,
        freshness: NARRATIVE_MAINTENANCE_SEAM_CONTRACT.freshnessDisabledValue,
      },
    },
    {
      launcher: launchPhase,
      name: "c2-5b-restore-verify-rebuild-verify/open",
      environment: { trigger: "dependency-gap" },
      expectedEnvironment: { setup: undefined, freshness: undefined },
    },
    {
      launcher: launchPhase,
      name: "c2-5b-restore-verify-rebuild-verify/restart",
      environment: { trigger: "dependency-gap" },
      expectedEnvironment: { setup: undefined, freshness: undefined },
    },
  ];
  const fakeHarness = {};
  const injectedLaunch = async (phase) => {
    const childEnv = { ...process.env };
    const expectedReceipt = expectedNarrativeMaintenanceCiReceipt(childEnv);
    assert.ok(expectedReceipt, `${phase} must expect an active receipt`);
    assert.equal(expectedReceipt.active, true);
    assert.equal(
      expectedReceipt.nonce,
      childEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
    );
    assert.equal(process.env[unrelatedEnv], "preserve-me");
    captured.push({
      phase,
      ownerPresent: Object.hasOwn(
        childEnv,
        NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
      ),
      owner: childEnv[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV],
      nonce: childEnv[NARRATIVE_MAINTENANCE_NONCE_ENV],
      setup: childEnv[NARRATIVE_MAINTENANCE_SETUP_ENV],
      freshness: childEnv[NARRATIVE_FRESHNESS_DISABLE_ENV],
      receipt: {
        active: expectedReceipt.active,
        nativeAck: expectedReceipt.nativeAck,
        nonce: expectedReceipt.nonce,
        type: expectedReceipt.type,
      },
    });
    return { app: { phase }, page: { phase } };
  };

  try {
    for (const { launcher, name, environment, expectedEnvironment } of phases) {
      const originalEnvironment = { ...environment };
      await launcher(fakeHarness, name, environment, injectedLaunch);
      assert.deepEqual(
        environment,
        originalEnvironment,
        `${name} must not mutate the caller's unrelated scenario environment`,
      );
      assert.equal(
        process.env[unrelatedEnv],
        "preserve-me",
        `${name} must not leak or overwrite unrelated process environment`,
      );
      const latest = captured.at(-1);
      assert.deepEqual(
        { setup: latest.setup, freshness: latest.freshness },
        expectedEnvironment,
        `${name} must receive only its phase-specific maintenance environment`,
      );
      assert.equal(
        process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV],
        inheritedOwner,
        `${name} owner token must be restored after launch`,
      );
      assert.equal(
        process.env[NARRATIVE_MAINTENANCE_NONCE_ENV],
        inheritedNonce,
        `${name} nonce must be restored after launch`,
      );
      assert.equal(
        process.env[NARRATIVE_MAINTENANCE_SETUP_ENV],
        inheritedSetup,
        `${name} setup seam must be restored after launch`,
      );
      assert.equal(
        process.env[NARRATIVE_FRESHNESS_DISABLE_ENV],
        inheritedFreshness,
        `${name} freshness seam must be restored after launch`,
      );
    }
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    }
    if (previousNonce === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_NONCE_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_NONCE_ENV] = previousNonce;
    }
    if (previousSetup === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_SETUP_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_SETUP_ENV] = previousSetup;
    }
    if (previousFreshness === undefined) {
      delete process.env[NARRATIVE_FRESHNESS_DISABLE_ENV];
    } else {
      process.env[NARRATIVE_FRESHNESS_DISABLE_ENV] = previousFreshness;
    }
    if (previousUnrelated === undefined) delete process.env[unrelatedEnv];
    else process.env[unrelatedEnv] = previousUnrelated;
  }

  assert.deepEqual(
    captured.map(({ phase, ownerPresent, owner, nonce, setup, freshness }) => ({
      phase,
      ownerPresent,
      owner,
      nonce,
      setup,
      freshness,
    })),
    phases.map(({ name, expectedEnvironment }) => ({
      phase: name,
      ownerPresent: true,
      owner: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
      nonce: captured.find((entry) => entry.phase === name)?.nonce,
      ...expectedEnvironment,
    })),
  );
  assert.equal(new Set(captured.map(({ nonce }) => nonce)).size, phases.length);
  assert.ok(
    captured.every(({ nonce }) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        nonce,
      ),
    ),
    "every injected launch must receive a UUIDv4 nonce",
  );
  assert.deepEqual(
    captured.map(({ receipt }) => receipt),
    captured.map(({ nonce }) => ({
      active: true,
      nativeAck: true,
      nonce,
      type: "grimodex:narrative-maintenance-ci-receipt",
    })),
    "every launch must expose the active main-maintenance-receipt expectation",
  );
});

test("C2-5B restore reopens the normal scheduler in a fresh Electron process", async () => {
  const restorePhase = "c2-5b-restore-verify-rebuild-verify/restore";
  const source = await readFile(
    new URL(
      "../electron/scripts/narrative-maintenance-product-journeys.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const journeyBody = source.match(
    /async function runRestoreVerifyRebuildVerify\([\s\S]*?\n}\n\nasync function runDigestChangeJourney/,
  )?.[0];
  assert.ok(
    journeyBody,
    "C2-5B restore journey caller must remain inspectable",
  );
  assert.ok(
    NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES.includes(restorePhase),
    "C2-5B restore phase must be registered for diagnostics",
  );
  assert.ok(
    PRODUCT_JOURNEY_ELECTRON_PHASES.includes(restorePhase),
    "C2-5B restore phase must be registered in the harness phase allowlist",
  );
  assert.match(
    journeyBody,
    /restorePhase:\s*"restore",\s*openPhase:\s*"open",/s,
    "C2-5B must close the disabled restore process before opening a normal scheduler process",
  );
  assert.match(
    journeyBody,
    /onRestore:\s*\(/,
    "C2-5B must retain the post-restore observation before the fresh open",
  );
  assert.match(
    journeyBody,
    /onOpen:\s*\(/,
    "C2-5B must retain the normal Verify/Rebuild/Verify observation",
  );
});

test("C2-5B restore scenario runs restore then close then normal open dynamically", async () => {
  const id = "c2-5b-restore-verify-rebuild-verify";
  const restorePhase = id + "/restore";
  const openPhase = id + "/open";
  const beforeEpochs = [
    { id: "epoch-initial", epochNumber: 0, reason: "initial" },
  ];
  const restoreEpoch = {
    id: "epoch-restore",
    epochNumber: 1,
    reason: "restore",
    createdAt: "2026-08-23T00:00:00.000Z",
  };
  const phaseRuns = [
    {
      id: "verify-1",
      runKind: "dependency-verify",
      semanticEpochId: restoreEpoch.id,
      status: "completed",
      createdAt: "2026-08-23T00:00:01.000Z",
      completedAt: "2026-08-23T00:00:01.500Z",
    },
    {
      id: "rebuild-1",
      runKind: "semantic-index-rebuild",
      semanticEpochId: restoreEpoch.id,
      status: "completed",
      createdAt: "2026-08-23T00:00:02.000Z",
      completedAt: "2026-08-23T00:00:02.500Z",
    },
    {
      id: "verify-2",
      runKind: "dependency-verify",
      semanticEpochId: restoreEpoch.id,
      status: "completed",
      createdAt: "2026-08-23T00:00:03.000Z",
      completedAt: "2026-08-23T00:00:03.500Z",
    },
  ];
  const createContext = (phase, runs, epochs) => ({
    projectId: "project-1",
    phase,
    runs: async () => runs,
    epochs: async () => epochs,
  });
  const contexts = [
    createContext(restorePhase, [], beforeEpochs),
    createContext(restorePhase, [], [...beforeEpochs, restoreEpoch]),
    createContext(openPhase, phaseRuns, [...beforeEpochs, restoreEpoch]),
  ];
  const events = [];
  const launches = [];
  let contextIndex = 0;
  const unrelatedEnv = "GRIMODEX_PRODUCT_JOURNEY_UNRELATED_SENTINEL";
  const environmentNames = [
    "CI",
    NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
    NARRATIVE_MAINTENANCE_NONCE_ENV,
    NARRATIVE_MAINTENANCE_SETUP_ENV,
    NARRATIVE_FRESHNESS_DISABLE_ENV,
    unrelatedEnv,
  ];
  const previousEnvironment = new Map(
    environmentNames.map((name) => [name, process.env[name]]),
  );
  const inheritedEnvironment = {
    CI: "true",
    [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: "inherited-owner",
    [NARRATIVE_MAINTENANCE_NONCE_ENV]: "00000000-0000-4000-8000-000000000001",
    [NARRATIVE_MAINTENANCE_SETUP_ENV]: "inherited-setup",
    [NARRATIVE_FRESHNESS_DISABLE_ENV]: "inherited-freshness",
    [unrelatedEnv]: "preserve-me",
  };
  for (const [name, value] of Object.entries(inheritedEnvironment)) {
    process.env[name] = value;
  }

  let observedEnvironment;
  let scenarioResult;
  try {
    scenarioResult = await runRestoreVerifyRebuildVerifyScenario(
      {
        workspacePath: (requestedId) => {
          assert.equal(requestedId, id);
          return "/tmp/c2-5b-restore-phase-sequence-test";
        },
        launch: async (phase) => {
          const childEnvironment = { ...process.env };
          const receipt =
            expectedNarrativeMaintenanceCiReceipt(childEnvironment);
          assert.ok(receipt, phase + " must publish an active receipt");
          launches.push({
            phase,
            owner: childEnvironment[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV],
            nonce: childEnvironment[NARRATIVE_MAINTENANCE_NONCE_ENV],
            setup: childEnvironment[NARRATIVE_MAINTENANCE_SETUP_ENV],
            freshness: childEnvironment[NARRATIVE_FRESHNESS_DISABLE_ENV],
            receipt: {
              type: receipt.type,
              active: receipt.active,
              nativeAck: receipt.nativeAck,
              nonce: receipt.nonce,
              setup: receipt.setup,
              freshness: receipt.freshness,
            },
          });
          events.push({ type: "launch", phase });
          return {
            app: { phase },
            page: { phase },
          };
        },
        close: async (app, page, phase) => {
          assert.equal(app.phase, phase);
          assert.equal(page.phase, phase);
          events.push({ type: "close", phase });
        },
        waitUntil: async (predicate, label) => {
          const result = await predicate();
          assert.ok(result, label + " must settle in the injected harness");
          return result;
        },
      },
      async (_harness, workspace) => {
        assert.equal(workspace, "/tmp/c2-5b-restore-phase-sequence-test");
        events.push({ type: "configure" });
      },
      {
        id,
        restorePhase: "restore",
        openPhase: "open",
        restoreThroughSettingsUi: async (_context, backupName) => {
          assert.equal(backupName, "restore-fixture.db");
          events.push({ type: "restore-click" });
        },
        testHooks: {
          fixtureEvidence: { backupName: "restore-fixture.db" },
          readRunSnapshot: async () => [],
          contextForLaunch: async (_harness, launch) => {
            const context = contexts[contextIndex++];
            assert.ok(
              context,
              "unexpected contextForLaunch call for " + launch.app.phase,
            );
            assert.equal(launch.app.phase, context.phase);
            return context;
          },
          waitForReadiness: async () => {},
          waitForRestorePhaseRows: async () => phaseRuns,
        },
        onRestore: async ({ context, fixtureEvidence }) => {
          assert.equal(context.phase, restorePhase);
          assert.equal(fixtureEvidence.backupName, "restore-fixture.db");
          events.push({ type: "restore-observed" });
        },
        onOpen: async ({
          openLaunch,
          phaseRuns: observedPhaseRuns,
          beforeEpochs: observedBeforeEpochs,
          epochs,
        }) => {
          assert.equal(openLaunch.app.phase, openPhase);
          assert.deepEqual(observedPhaseRuns, phaseRuns);
          assert.deepEqual(
            observedBeforeEpochs,
            beforeEpochs,
            "open callback must receive the pre-restore Epoch baseline",
          );
          const observedRestoreEpoch =
            assertRestoreVerifyRebuildVerifyCausality(
              observedPhaseRuns,
              observedBeforeEpochs,
              epochs,
            );
          assert.equal(observedRestoreEpoch.id, restoreEpoch.id);
          events.push({ type: "open-observed" });
        },
      },
    );
    observedEnvironment = Object.fromEntries(
      environmentNames.map((name) => [name, process.env[name]]),
    );
  } finally {
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }

  assert.equal(contextIndex, contexts.length);
  assert.deepEqual(
    events.filter(({ type }) => type !== "configure"),
    [
      { type: "launch", phase: restorePhase },
      { type: "restore-click" },
      { type: "restore-observed" },
      { type: "close", phase: restorePhase },
      { type: "launch", phase: openPhase },
      { type: "open-observed" },
      { type: "close", phase: openPhase },
    ],
    "the scenario must close restore before launching the normal open process",
  );
  assert.deepEqual(
    launches.map(({ phase, setup, freshness }) => ({
      phase,
      setup,
      freshness,
    })),
    [
      { phase: restorePhase, setup: "disabled", freshness: "disabled" },
      { phase: openPhase, setup: undefined, freshness: undefined },
    ],
  );
  assert.deepEqual(
    launches.map(({ owner, receipt: { active, nativeAck, nonce, type } }) => ({
      owner,
      active,
      nativeAck,
      nonce,
      type,
    })),
    launches.map(({ nonce }) => ({
      owner: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
      active: true,
      nativeAck: true,
      nonce,
      type: "grimodex:narrative-maintenance-ci-receipt",
    })),
  );
  assert.equal(
    new Set(launches.map(({ nonce }) => nonce)).size,
    launches.length,
    "restore and open launches must have distinct nonces",
  );
  assert.ok(
    launches.every(({ nonce }) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
        nonce,
      ),
    ),
    "restore and open launch nonces must be UUIDv4",
  );
  assert.notEqual(
    scenarioResult.restore.context,
    scenarioResult.open.context,
    "normal open must bind a fresh process context after restore closes",
  );
  assert.equal(scenarioResult.restore.context.phase, restorePhase);
  assert.equal(scenarioResult.open.context.phase, openPhase);
  assert.equal(
    observedEnvironment.CI,
    inheritedEnvironment.CI,
    "scenario must restore CI after all phase launches",
  );
  assert.equal(
    observedEnvironment[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV],
    inheritedEnvironment[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV],
    "scenario must restore inherited owner environment",
  );
  assert.equal(
    observedEnvironment[NARRATIVE_MAINTENANCE_NONCE_ENV],
    inheritedEnvironment[NARRATIVE_MAINTENANCE_NONCE_ENV],
    "scenario must restore inherited nonce environment",
  );
  assert.equal(
    observedEnvironment[NARRATIVE_MAINTENANCE_SETUP_ENV],
    inheritedEnvironment[NARRATIVE_MAINTENANCE_SETUP_ENV],
    "scenario must restore inherited setup environment",
  );
  assert.equal(
    observedEnvironment[NARRATIVE_FRESHNESS_DISABLE_ENV],
    inheritedEnvironment[NARRATIVE_FRESHNESS_DISABLE_ENV],
    "scenario must restore inherited freshness environment",
  );
  assert.equal(observedEnvironment[unrelatedEnv], "preserve-me");
  assert.deepEqual(
    Object.fromEntries(
      environmentNames.map((name) => [name, process.env[name]]),
    ),
    Object.fromEntries(previousEnvironment),
    "scenario cleanup must restore the process environment after assertions",
  );
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
    /createRestoreFixtureDerivedStateGap\(\s*context/.test(seedBody),
    "restore fixture must create a real derived-state gap before backup",
  );
  assert.ok(
    seedBody.search(/createRestoreFixtureDerivedStateGap\(\s*context/) <
      seedBody.indexOf("createRestoreBackupFixture(workspace)"),
    "the gap must be captured in the WAL-safe backup",
  );
  const gapAt = seedBody.search(
    /createRestoreFixtureDerivedStateGap\(\s*context/,
  );
  const readinessMatch = seedBody.match(
    /waitForReadiness\(\s*context,\s*"restore fixture pre-gap freshness settled",[\s\S]*?\n\s*\);/,
  );
  const readinessAt = readinessMatch?.index ?? -1;
  assert.ok(
    readinessAt >= 0 && readinessAt < gapAt,
    "restore fixture must settle production Freshness/cursor before deleting derived state",
  );
  const readinessBlock = seedBody.slice(readinessAt, gapAt);
  assert.match(
    readinessBlock,
    /requireMaintenanceSettled:\s*true/,
    "pre-gap readiness must exclude active maintenance Runs",
  );
  assert.match(
    readinessBlock,
    /minimumFeedHead:/,
    "pre-gap readiness must wait for the observed Change Feed head",
  );
  assert.match(
    readinessBlock,
    /baselineRuns:\s*preSceneRuns/,
    "pre-gap readiness must compare against the pre-scene Run baseline",
  );
  assert.match(
    readinessBlock,
    /minimumFeedHead:\s*postSceneFeedAndCursor\.feedHead/,
    "pre-gap readiness must wait for the post-scene Change Feed head",
  );
  assert.match(
    readinessBlock,
    /requireFreshRun:\s*true/,
    "pre-gap readiness must require Freshness after source seeding",
  );
  const preSceneRunsAt = seedBody.indexOf("const preSceneRuns");
  const sceneCreationAt = seedBody.indexOf(
    'createSceneIfNeeded(context, "restore-fixture-source")',
  );
  assert.ok(
    preSceneRunsAt >= 0 && preSceneRunsAt < sceneCreationAt,
    "the Freshness Run baseline must be captured before scene creation",
  );
  const postSceneFeedAndCursorAt = seedBody.indexOf(
    "const postSceneFeedAndCursor",
  );
  assert.ok(
    postSceneFeedAndCursorAt >= 0 && postSceneFeedAndCursorAt < readinessAt,
    "the observed post-scene feed head must be captured before readiness polling",
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

test("restore fixture readiness requires a current completed Freshness and released cursor", () => {
  const makeReadiness = () => ({
    epoch: { id: "epoch-1" },
    freshness: { status: "completed", semanticEpochId: "epoch-1" },
    feedAndCursor: {
      feedHead: 3,
      cursor: {
        acknowledgedThrough: 3,
        reservedThrough: null,
        activeRunId: null,
        semanticEpochId: null,
        lastError: null,
      },
    },
  });
  const mutate = (change) => {
    const readiness = makeReadiness();
    change(readiness);
    return readiness;
  };

  assert.doesNotThrow(() =>
    assertRestoreFixturePreGapReadiness(makeReadiness()),
  );
  assert.doesNotThrow(() => {
    const zeroHead = makeReadiness();
    zeroHead.feedAndCursor.feedHead = 0;
    zeroHead.feedAndCursor.cursor.acknowledgedThrough = 0;
    assertRestoreFixturePreGapReadiness(zeroHead);
  }, "zero is a valid settled Change Feed head");

  const invalidCases = [
    ["missing readiness", null],
    ["missing epoch", mutate((readiness) => (readiness.epoch = undefined))],
    ["empty epoch id", mutate((readiness) => (readiness.epoch.id = ""))],
    [
      "whitespace epoch id",
      mutate((readiness) => (readiness.epoch.id = "   ")),
    ],
    [
      "missing Freshness",
      mutate((readiness) => (readiness.freshness = undefined)),
    ],
    [
      "pending Freshness",
      mutate((readiness) => (readiness.freshness.status = "pending")),
    ],
    [
      "running Freshness",
      mutate((readiness) => (readiness.freshness.status = "running")),
    ],
    [
      "failed Freshness",
      mutate((readiness) => (readiness.freshness.status = "failed")),
    ],
    [
      "stale Freshness epoch",
      mutate(
        (readiness) => (readiness.freshness.semanticEpochId = "epoch-old"),
      ),
    ],
    [
      "missing feed head",
      mutate((readiness) => (readiness.feedAndCursor.feedHead = undefined)),
    ],
    [
      "fractional feed head",
      mutate((readiness) => (readiness.feedAndCursor.feedHead = 3.5)),
    ],
    [
      "fractional feed and acknowledged head",
      mutate((readiness) => {
        readiness.feedAndCursor.feedHead = 3.5;
        readiness.feedAndCursor.cursor.acknowledgedThrough = 3.5;
      }),
    ],
    [
      "unsafe feed head",
      mutate(
        (readiness) =>
          (readiness.feedAndCursor.feedHead = Number.MAX_SAFE_INTEGER + 1),
      ),
    ],
    [
      "unsafe feed and acknowledged head",
      mutate((readiness) => {
        readiness.feedAndCursor.feedHead = Number.MAX_SAFE_INTEGER + 1;
        readiness.feedAndCursor.cursor.acknowledgedThrough =
          Number.MAX_SAFE_INTEGER + 1;
      }),
    ],
    [
      "fractional acknowledged head",
      mutate(
        (readiness) =>
          (readiness.feedAndCursor.cursor.acknowledgedThrough = 2.5),
      ),
    ],
    [
      "unequal acknowledged head",
      mutate(
        (readiness) => (readiness.feedAndCursor.cursor.acknowledgedThrough = 2),
      ),
    ],
    [
      "missing cursor",
      mutate((readiness) => (readiness.feedAndCursor.cursor = undefined)),
    ],
    [
      "reserved cursor",
      mutate(
        (readiness) => (readiness.feedAndCursor.cursor.reservedThrough = 4),
      ),
    ],
    [
      "active cursor Run",
      mutate(
        (readiness) => (readiness.feedAndCursor.cursor.activeRunId = "run-1"),
      ),
    ],
    [
      "cursor epoch",
      mutate(
        (readiness) =>
          (readiness.feedAndCursor.cursor.semanticEpochId = "epoch-1"),
      ),
    ],
    [
      "cursor error",
      mutate(
        (readiness) =>
          (readiness.feedAndCursor.cursor.lastError = "NEX_TEST_FAILURE"),
      ),
    ],
    [
      "null cursor",
      mutate((readiness) => (readiness.feedAndCursor.cursor = null)),
    ],
  ];

  for (const [label, readiness] of invalidCases) {
    assert.throws(
      () => assertRestoreFixturePreGapReadiness(readiness, label),
      new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      `invalid restore readiness must be rejected: ${label}`,
    );
  }
});

test("restore fixture backup readiness reads the online backup snapshot, not the live DB", async () => {
  await execFile("sqlite3", ["--version"]);
  const root = await mkdtemp(path.join(tmpdir(), "c2-5b-backup-reader-"));
  const workspace = path.join(root, "workspace");
  const databasePath = path.join(workspace, "grimodex.db");
  const backupName = "restore-fixture.db";
  const backupPath = path.join(workspace, "backups", backupName);
  const projectId = "project-backup-reader";
  try {
    await mkdir(path.dirname(backupPath), { recursive: true });
    await execFile("sqlite3", [
      databasePath,
      `
        PRAGMA journal_mode=WAL;
        CREATE TABLE narrative_semantic_epochs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          epoch_number INTEGER NOT NULL,
          reason TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE narrative_extraction_runs (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL,
          run_kind TEXT NOT NULL,
          status TEXT NOT NULL,
          semantic_epoch_id TEXT,
          created_at TEXT NOT NULL
        );
        CREATE TABLE narrative_change_events (
          canonical_sequence INTEGER NOT NULL,
          project_id TEXT NOT NULL
        );
        CREATE TABLE narrative_change_cursors (
          project_id TEXT NOT NULL,
          consumer_id TEXT NOT NULL,
          acknowledged_through_sequence INTEGER,
          reserved_through_sequence INTEGER,
          active_run_id TEXT,
          semantic_epoch_id TEXT,
          last_error TEXT
        );
        INSERT INTO narrative_semantic_epochs
          (id, project_id, epoch_number, reason, created_at)
        VALUES
          ('epoch-1', '${projectId}', 0, 'initial', '2026-08-28T16:05:00.000Z');
        INSERT INTO narrative_extraction_runs
          (id, project_id, run_kind, status, semantic_epoch_id, created_at)
        VALUES
          ('freshness-1', '${projectId}', 'freshness-evaluation', 'completed',
           'epoch-1', '2026-08-28T16:05:01.000Z');
        INSERT INTO narrative_change_events (canonical_sequence, project_id)
        VALUES (1, '${projectId}');
        INSERT INTO narrative_change_cursors
          (project_id, consumer_id, acknowledged_through_sequence,
           reserved_through_sequence, active_run_id, semantic_epoch_id, last_error)
        VALUES
          ('${projectId}', 'narrative-incremental-freshness/v1', 1, NULL, NULL, NULL, NULL);
      `,
    ]);
    await execFile("sqlite3", [
      databasePath,
      `.backup '${backupPath.replaceAll("'", "''")}'`,
    ]);
    await execFile("sqlite3", [
      databasePath,
      `
        INSERT INTO narrative_semantic_epochs
          (id, project_id, epoch_number, reason, created_at)
        VALUES
          ('epoch-2', '${projectId}', 1, 'live-only-change', '2026-08-28T16:05:02.000Z');
        INSERT INTO narrative_extraction_runs
          (id, project_id, run_kind, status, semantic_epoch_id, created_at)
        VALUES
          ('freshness-2', '${projectId}', 'freshness-evaluation', 'completed',
           'epoch-2', '2026-08-28T16:05:03.000Z');
        INSERT INTO narrative_change_events (canonical_sequence, project_id)
        VALUES (2, '${projectId}');
        UPDATE narrative_change_cursors
           SET acknowledged_through_sequence = 2
         WHERE project_id = '${projectId}'
           AND consumer_id = 'narrative-incremental-freshness/v1';
      `,
    ]);
    const { stdout: liveStdout } = await execFile("sqlite3", [
      "-json",
      databasePath,
      `
        SELECT
          (SELECT id FROM narrative_semantic_epochs
            WHERE project_id = '${projectId}'
            ORDER BY epoch_number DESC LIMIT 1) AS epochId,
          (SELECT id FROM narrative_extraction_runs
            WHERE project_id = '${projectId}'
              AND run_kind = 'freshness-evaluation'
            ORDER BY created_at DESC LIMIT 1) AS freshnessRunId,
          (SELECT MAX(canonical_sequence) FROM narrative_change_events
            WHERE project_id = '${projectId}') AS feedHead,
          (SELECT acknowledged_through_sequence FROM narrative_change_cursors
            WHERE project_id = '${projectId}') AS acknowledgedThrough;
      `,
    ]);
    const liveRow = JSON.parse(liveStdout.trim())[0];
    assert.deepEqual(liveRow, {
      epochId: "epoch-2",
      freshnessRunId: "freshness-2",
      feedHead: 2,
      acknowledgedThrough: 2,
    });

    const readBackupReadiness =
      narrativeMaintenanceProductJourneys.readRestoreFixtureBackupReadiness;
    assert.equal(typeof readBackupReadiness, "function");
    const backupReadiness = await readBackupReadiness(
      workspace,
      backupName,
      projectId,
    );
    assert.deepEqual(backupReadiness, {
      epoch: { id: "epoch-1" },
      freshness: {
        status: "completed",
        semanticEpochId: "epoch-1",
      },
      feedAndCursor: {
        feedHead: 1,
        cursor: {
          acknowledgedThrough: 1,
          reservedThrough: null,
          activeRunId: null,
          semanticEpochId: null,
          lastError: null,
        },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore fixture requires a typed completed legacy Backfill boundary", async () => {
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
  const backfillRouteAt = seedBody.indexOf('"retry_narrative_legacy_backfill"');
  const ownerRunAt = seedBody.indexOf('"narrative_extraction_create_run"');
  const gapAt = seedBody.search(
    /createRestoreFixtureDerivedStateGap\(\s*context/,
  );
  const backupAt = seedBody.indexOf("createRestoreBackupFixture(workspace)");
  assert.ok(
    backfillRouteAt >= 0,
    "restore fixture must seed legacy Backfill through the typed production route",
  );
  assert.ok(
    backfillRouteAt < ownerRunAt && backfillRouteAt < gapAt,
    "the canonical Backfill boundary must precede fixture-only ownership and the derived-state gap",
  );
  assert.ok(
    gapAt < backupAt,
    "the gap must be captured only after the completed Backfill boundary",
  );
  assert.match(
    seedBody,
    /!\["ran",\s*"alreadyRun"\]\.includes\(backfillOutcome\.outcome\)/,
    "the fixture must accept only a typed run or a startup-created alreadyRun outcome",
  );
  assert.match(
    seedBody,
    /runKind\s*!==\s*"backfill"[\s\S]*status\s*!==\s*"completed"/,
    "the fixture must validate the durable completed Backfill Run lifecycle",
  );
  assert.match(
    seedBody,
    /(?:Number\()?initialEpoch\.epochNumber\)?\s*!==\s*0[\s\S]*initialEpoch\.reason\s*!==\s*"initial"/,
    "the fixture must validate the initial Semantic Epoch created by Backfill",
  );
});

test("restore fixture binds owner Run mutations to the exact active workspace", async () => {
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
  const bindingCaptureAt = seedBody.indexOf(
    '"narrative_extraction_capture_workspace_binding"',
  );
  const ownerRunAt = seedBody.indexOf('"narrative_extraction_create_run"');
  const cancelRunAt = seedBody.indexOf('"narrative_extraction_cancel_run"');
  assert.ok(
    bindingCaptureAt >= 0 &&
      bindingCaptureAt < ownerRunAt &&
      ownerRunAt < cancelRunAt,
    "the exact workspace binding must be captured before owner Run mutations",
  );
  const createRunBody = seedBody.slice(ownerRunAt, cancelRunAt);
  const cancelRunBody = seedBody.slice(
    cancelRunAt,
    seedBody.indexOf("const edgeId", cancelRunAt),
  );
  assert.match(
    seedBody,
    /"narrative_extraction_capture_workspace_binding",\s*\{\s*expectedWorkspacePath:\s*workspace\s*}/,
    "the fixture must bind mutations to its exact workspace path",
  );
  assert.match(
    createRunBody,
    /"narrative_extraction_create_run",[\s\S]*?payload:\s*\{[\s\S]*?tasks:\s*\[\],[\s\S]*?},\s*workspaceBinding,\s*}/,
    "the owner Run must be created with the captured binding",
  );
  assert.match(
    cancelRunBody,
    /"narrative_extraction_cancel_run",\s*\{\s*payload:\s*\{\s*runId,\s*projectId:\s*context\.projectId\s*},\s*workspaceBinding,\s*}/,
    "the owner Run must be cancelled with the same captured binding",
  );
});

test("restore journey must exercise the Settings backup UI and rebind after reload", async () => {
  const source = await readFile(
    new URL(
      "../electron/scripts/narrative-maintenance-product-journeys.mjs",
      import.meta.url,
    ),
    "utf8",
  );
  const helperBody = source.match(
    /async function restoreBackupThroughSettingsUi\([\s\S]*?\n}\n\nasync function runRestoreVerifyRebuildVerify/,
  )?.[0];
  const journeyBody = source.match(
    /async function runRestoreVerifyRebuildVerify\([\s\S]*?\n}\n\nasync function runDigestChangeJourney/,
  )?.[0];
  const scenarioBody = source.match(
    /export async function runRestoreVerifyRebuildVerifyScenario\([\s\S]*?\n}\n\nasync function runRestoreVerifyRebuildVerify/,
  )?.[0];
  assert.ok(helperBody, "restore UI helper must remain inspectable");
  assert.ok(journeyBody, "restore journey helper must remain inspectable");
  assert.ok(
    scenarioBody,
    "shared restore scenario helper must remain inspectable",
  );
  assert.match(
    scenarioBody,
    /restoreThroughSettingsUi\(context, fixtureEvidence\.backupName\)/,
    "restore must call the production Settings UI helper",
  );
  assert.doesNotMatch(
    scenarioBody,
    /invokeOk\(context\.page,\s*"restore_backup"/,
    "restore journey must not bypass the production UI with raw restore_backup IPC",
  );
  assert.match(
    helperBody,
    /getByTestId\("settings-dialog"\)/,
    "restore helper must open the real Settings dialog",
  );
  assert.match(
    helperBody,
    /getByRole\("button", \{ name: "Data", exact: true \}\)/,
    "restore helper must select the Data category",
  );
  assert.match(
    helperBody,
    /name: \/\^\(\?:Restore\|復元\)\$\//,
    "restore helper must perform the first restore click",
  );
  assert.match(
    helperBody,
    /getByTestId\(\s*`backup-restore-\$\{encodeURIComponent\(backupName\)\}`\s*,?\s*\)/,
    "restore helper must select the backup by stable identity, not row order",
  );
  assert.doesNotMatch(
    helperBody,
    /\.nth\(/,
    "restore helper must not select a backup by an unstable list index",
  );
  assert.match(
    helperBody,
    /name: \/\^\(\?:Replace & restore\|全体を置換して復元\)\$\//,
    "restore helper must perform the explicit destructive confirmation",
  );
  assert.match(
    helperBody,
    /framenavigated[\s\S]*frame === page\.mainFrame\(\)/,
    "restore helper must observe the main-frame reload",
  );
  assert.match(
    scenarioBody,
    /contextForLaunch(?:ForScenario)?\([\s\S]*beforeRestoreRuns[\s\S]*restore\/reload project hydration/,
    "restore journey must rebind context and wait for post-reload hydration",
  );
  assert.match(
    scenarioBody,
    /candidate\.projectId !== context\.projectId/,
    "restore journey must prove project authority is unchanged after reload",
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
            ...phase("rebuild-1", "semantic-index-rebuild", restoreEpoch.id, 2),
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
    workKey: "legacy-dependency-backfill:v3",
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
    specJson: '{"backfillAlgorithmVersion":"3"}',
    taskInputJson: '{"backfillAlgorithmVersion":"3"}',
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
        [...baseline, { ...interrupted, id: "old-running" }],
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
    workKey: "legacy-dependency-backfill:v3",
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
    specJson: '{"backfillAlgorithmVersion":"3"}',
    taskInputJson: '{"backfillAlgorithmVersion":"3"}',
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
  assert.doesNotThrow(() => assertNoAutomaticRepair(stableRows.slice(0, 2)));
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
    workKey: "legacy-dependency-backfill:v3",
    semanticEpochId: "epoch-a",
    status: "running",
    specJson: JSON.stringify({
      systemWork: {
        trigger: expected.trigger,
        canonicalWorkKey:
          "narrative-maintenance:v1/backfill/project-a/legacy-dependency-backfill:v3",
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
  for (const field of [
    "reservedThrough",
    "activeRunId",
    "semanticEpochId",
    "lastError",
  ]) {
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
    workKey: "legacy-dependency-backfill:v3",
    semanticEpochId: "epoch-1",
    status: "running",
    specJson: JSON.stringify({
      systemWork: {
        trigger: "workspace-opened",
        canonicalWorkKey:
          "narrative-maintenance:v1/backfill/project-1/legacy-dependency-backfill:v3",
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
  assert.deepEqual(
    selected.map((run) => run.id),
    ["marked-run"],
  );
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

test("foreground marker canonical keys follow native Backfill and epoch-bound phase contracts", () => {
  const expected = {
    barrierId: "canonical-key-barrier",
    correlation: "canonical-key-correlation",
    trigger: "workspace-opened",
  };
  const makeRun = (runKind, workKey, canonicalWorkKey) => ({
    id: `${runKind}-marker`,
    projectId: "project-1",
    runKind,
    workKey,
    semanticEpochId: "epoch-1",
    status: "running",
    specJson: JSON.stringify({
      systemWork: {
        trigger: expected.trigger,
        canonicalWorkKey,
        authorityId: "authority-1",
        generation: 1,
        productJourneyBarrierId: expected.barrierId,
        correlation: expected.correlation,
      },
    }),
  });
  const backfillKey =
    "narrative-maintenance:v1/backfill/project-1/legacy-dependency-backfill:v3";
  const backfill = makeRun(
    "backfill",
    "legacy-dependency-backfill:v3",
    backfillKey,
  );
  assert.equal(
    assertForegroundRunMarker(backfill, expected).canonicalWorkKey,
    backfillKey,
  );
  assert.throws(
    () =>
      assertForegroundRunMarker(
        makeRun(
          "backfill",
          "legacy-dependency-backfill:v3",
          `${backfillKey}/epoch/epoch-1`,
        ),
        expected,
      ),
    /canonicalWorkKey/,
    "Backfill must remain epochless even when the durable Run has an epoch",
  );

  const verifyKey =
    "narrative-maintenance:v1/dependency-verify/project-1/dependency-verify:epoch-1/epoch/epoch-1";
  assert.equal(
    assertForegroundRunMarker(
      makeRun("dependency-verify", "dependency-verify:epoch-1", verifyKey),
      expected,
    ).canonicalWorkKey,
    verifyKey,
  );
  const rebuildKey =
    "narrative-maintenance:v1/semantic-index-rebuild/project-1/dependency-rebuild-derived/epoch/epoch-1";
  assert.equal(
    assertForegroundRunMarker(
      makeRun(
        "semantic-index-rebuild",
        "dependency-rebuild-derived",
        rebuildKey,
      ),
      expected,
    ).canonicalWorkKey,
    rebuildKey,
  );
  assert.throws(
    () =>
      assertForegroundRunMarker(
        makeRun(
          "dependency-verify",
          "dependency-verify:epoch-1",
          "narrative-maintenance:v1/dependency-verify/project-1/dependency-verify:epoch-1",
        ),
        expected,
      ),
    /canonicalWorkKey/,
    "Verify must retain its epoch-bound canonical identity",
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
  assert.doesNotThrow(() =>
    assertTransientAttemptEvidence(oneAttemptTransient),
  );
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
    workKey: "legacy-dependency-backfill:v3",
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
  const journeyId = "c2-5b-restore-verify-rebuild-verify";
  const expectedPhase = `${journeyId}/restore-fixture`;
  const launches = [];
  const harness = {
    async launch(phase) {
      launches.push(phase);
      return { app: {}, page: {}, phase };
    },
  };
  const previousCi = process.env.CI;
  process.env.CI = "true";
  let launched;
  try {
    launched =
      await narrativeMaintenanceProductJourneys.launchRestoreFixtureForJourney(
        harness,
        journeyId,
      );
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
  assert.deepEqual(
    launches,
    [expectedPhase],
    "the delegated launcher must retain the C2-5B restore-fixture suffix",
  );
  assert.equal(launched.phase, expectedPhase);
  assert.ok(
    NARRATIVE_MAINTENANCE_ELECTRON_LAUNCH_PHASES.includes(expectedPhase),
    "the emitted phase must remain in the diagnostics registry",
  );

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
    /export async function runRestoreVerifyRebuildVerifyScenario\([\s\S]*?\n}\n\nasync function runRestoreVerifyRebuildVerify/,
  )?.[0];
  const fixtureHelperBody = source.match(
    /async function seedRestoreFixtureEvidence\([\s\S]*?\n}\n\n\/\*\*/,
  )?.[0];
  assert.ok(
    fixtureHelperBody,
    "restore fixture helper must remain inspectable",
  );
  assert.match(
    fixtureHelperBody,
    /\{\s*fixturePhase = "restore-fixture"\s*\}\s*=\s*\{\}/s,
    "restore fixture helper must retain the exact C2-5B restore-fixture default",
  );
  assert.match(
    fixtureHelperBody,
    /launchRestoreFixtureForJourney\(\s*harness,\s*id,\s*\{\s*fixturePhase,\s*\}\s*\)/s,
    "restore fixture helper must delegate phase construction to the shared launcher",
  );
  assert.ok(
    restoreJourneyBody,
    "restore journey caller must remain inspectable",
  );
  assert.match(
    restoreJourneyBody,
    /id = "c2-5b-restore-verify-rebuild-verify",/,
    "restore journey must bind its fixture to its own journey id",
  );
  assert.match(
    restoreJourneyBody,
    /seedRestoreFixtureEvidence\(\s*harness,\s*workspace,\s*id,\s*\{\s*fixturePhase\s*,?\s*\}\s*,?\s*\)/,
    "restore journey must seed its own restore-fixture caller",
  );
  assert.match(
    restoreJourneyBody,
    /restorePhase = "open"/,
    "shared restore journey must retain the C2-5B open default",
  );
  assert.match(
    restoreJourneyBody,
    /harness\.launch\(`\$\{id\}\/\$\{restorePhase\}`\)/,
    "shared restore journey must launch its configured restore phase",
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
  assert.match(
    foregroundJourneyBody,
    /getByTestId\("workspace-menu-trigger"\)/,
    "foreground workspace-wake must switch A through the canonical WorkspaceMenu",
  );
  assert.match(
    foregroundJourneyBody,
    /data-workspace-open-revision.*previousRevision|previousRevision.*data-workspace-open-revision/s,
    "foreground workspace-wake must prove the renderer workspace revision advanced",
  );
  const foregroundAuthoringBody = foregroundJourneyBody.match(
    /const context = await contextForLaunch\([\s\S]*?workspaceA,[\s\S]*?const body = `C2-5B-FOREGROUND-/,
  )?.[0];
  assert.ok(
    foregroundAuthoringBody,
    "foreground workspace-wake A authoring path must remain inspectable",
  );
  assert.match(
    foregroundAuthoringBody,
    /createForegroundSceneThroughUi\(\s*context,\s*"foreground-authoring",?\s*\)/s,
    "foreground workspace-wake must create its A scene through the renderer UI",
  );
  assert.doesNotMatch(
    foregroundAuthoringBody,
    /createSceneIfNeeded|tree_node_create/,
    "foreground workspace-wake must not fall back to raw scene creation",
  );
  assert.doesNotMatch(
    foregroundJourneyBody,
    /harness\.invokeOk\(first\.page,\s*"open_workspace"/,
    "foreground workspace-wake must not mutate native authority behind the renderer store",
  );
  const foregroundSceneHelperBody = source.match(
    /async function createForegroundSceneThroughUi\([\s\S]*?\n}\n\nasync function patchScene/,
  )?.[0];
  assert.ok(
    foregroundSceneHelperBody,
    "foreground UI scene helper must remain inspectable",
  );
  assert.match(
    foregroundSceneHelperBody,
    /data-panel-header.*シーン/s,
    "foreground UI scene helper must target the Scenes panel header",
  );
  assert.match(
    foregroundSceneHelperBody,
    /button\[title="新規作成"\]/,
    "foreground UI scene helper must use the canonical create button",
  );
  assert.match(
    foregroundSceneHelperBody,
    /getByRole\("menuitem",\s*\{ name: "New scene", exact: true \}\)/,
    "foreground UI scene helper must select the canonical New scene menu item",
  );
  assert.match(
    foregroundSceneHelperBody,
    /SELECT id, project_id AS projectId[\s\S]*WHERE project_id = \? AND node_type = 'scene'/,
    "foreground UI scene helper must identify the new scene in project scope",
  );
  assert.match(
    foregroundSceneHelperBody,
    /created\.projectId.*context\.projectId/s,
    "foreground UI scene helper must assert exact project authority",
  );
  assert.match(
    foregroundSceneHelperBody,
    /data-editor-loaded-document-id=/,
    "foreground UI scene helper must wait for the selected editor document",
  );
  assert.doesNotMatch(
    foregroundSceneHelperBody,
    /tree_node_create|harness\.invokeOk\([^)]*tree_node_create/s,
    "foreground UI scene helper must not contain a raw tree_node_create fallback",
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
  const expectedIds = [
    ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
    ...NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  ].map((journey) => journey.id);
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
  const expectedIds = [
    ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
    ...NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  ].map((journey) => journey.id);
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
  const expectedProductJourneyIds = [
    ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
    ...NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  ].map((journey) => journey.id);
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
    await readFile(
      new URL("../evals/impact-map.yaml", import.meta.url),
      "utf8",
    ),
  );
  const changedPath =
    "electron/main/narrativeMaintenance.futureRegression.test.ts";
  const expectedIds = [
    ...NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CATALOG,
    ...NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  ].map((journey) => journey.id);
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
  assert.ok(qualitySelection.suiteIds.includes("narrative-semantic-contract"));
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
