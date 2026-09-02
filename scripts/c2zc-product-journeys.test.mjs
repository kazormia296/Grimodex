import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { resolveProductJourneyImpactCatalog } from "../electron/scripts/product-journey-impact.mjs";
import {
  NARRATIVE_C2ZC_PRODUCT_JOURNEYS,
  assertProductJourneySelectionBinding,
  resolveProductJourneySet,
  PRODUCT_JOURNEYS,
} from "../electron/scripts/product-journeys.mjs";
import {
  C2ZC_AUTHORITY_APPLICATION_ROWS_QUERY,
  C2ZC_AUTHORITY_SNAPSHOT_QUERIES,
  C2ZC_CANONICAL_PRODUCT_JOURNEY_PHASES,
  C2ZC_PRODUCT_JOURNEY_ID,
  C2ZC_RESTORE_FIXTURE_BACKUP_NAME,
  C2ZC_RESTORE_FIXTURE_ENV,
  C2ZC_VERIFY_COVERAGE_COUNT,
  assertC2ZcFixtureCandidateBinding,
  assertC2ZcFixtureApplicationParity,
  assertC2ZcFindingRowsResolved,
  assertC2ZcMarkerExactlyOnce,
  assertC2ZcPostMarkerApplicationPersistence,
  assertC2ZcProjectInventory,
  assertC2ZcRestorePreCutoverState,
  assertC2ZcRestorePostSettingsState,
  assertC2ZcRestoreCanonicalBaseline,
  assertC2ZcRuntimeBackupName,
  assertC2ZcRestartInvariants,
  assertC2ZcRestoreFixtureManifest,
  assertC2ZcRestoreFixtureInput,
  assertC2ZcRestoreLifecycleOrder,
  assertC2ZcFeedCursorSettled,
  assertC2ZcVerifyCoverage,
  countC2ZcSqlPlaceholders,
  readC2ZcAuthoritySnapshot,
  resolveC2ZcRestoreCanonicalLifecycleBaseline,
  resolveC2ZcRuntimeBackupName,
  resolveC2ZcAuthorityQuery,
  stageC2ZcRestoreFixture,
} from "../electron/scripts/c2zc-canonical-product-journey.mjs";
import {
  configureJourneyWorkspaceForProductJourney,
  launchRestoreVerifyRebuildVerifyRestorePhaseForProductJourney,
  NARRATIVE_FRESHNESS_DISABLE_ENV,
  NARRATIVE_MAINTENANCE_FAULT_ENV,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
  NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV,
  NARRATIVE_MAINTENANCE_NONCE_ENV,
  NARRATIVE_MAINTENANCE_SETUP_ENV,
  NARRATIVE_MAINTENANCE_TRIGGER_ENV,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import {
  createC2ZcFixtureManifest,
  createC2ZcFixtureSemantic,
  refreshC2ZcFixtureSemanticDigests,
} from "./c2zc-fixture-test-support.mjs";
import {
  C2ZC_RUST_VERIFY_CONTRACT_VERSION,
  C2ZC_RUST_VERIFY_COVERAGE,
} from "./c2zc-verify-contract.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

const fixtureSemantic = () => createC2ZcFixtureSemantic();
const fixtureManifest = () => createC2ZcFixtureManifest();

test("C2-ZC has one required canonical lane followed by one required auxiliary DML lane", () => {
  assert.deepEqual(
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map(({ id }) => id),
    [C2ZC_PRODUCT_JOURNEY_ID, "c2-zc-renderer-mcp-dml-denial"],
  );
  assert.deepEqual(
    resolveProductJourneySet("c2-zc").map(({ id }) => id),
    [C2ZC_PRODUCT_JOURNEY_ID, "c2-zc-renderer-mcp-dml-denial"],
  );
  assert.deepEqual(
    resolveProductJourneyImpactCatalog("c2-zc").map(({ id }) => id),
    [C2ZC_PRODUCT_JOURNEY_ID, "c2-zc-renderer-mcp-dml-denial"],
  );
  assert.deepEqual(
    NARRATIVE_C2ZC_PRODUCT_JOURNEYS.map(({ id }) => id),
    [C2ZC_PRODUCT_JOURNEY_ID, "c2-zc-renderer-mcp-dml-denial"],
  );
  assert.equal(NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG[0].required, true);
  assert.equal(
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG[0].acceptanceRole,
    "required",
  );
  assert.equal(NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG[1].required, true);
  assert.equal(
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG[1].acceptanceRole,
    "auxiliary",
  );
  assert.deepEqual(
    PRODUCT_JOURNEYS.map(({ id }) => id),
    PRODUCT_JOURNEY_CATALOG.map(({ id }) => id),
  );
});

test("canonical lifecycle has the single ordered phase contract", () => {
  assert.deepEqual(C2ZC_CANONICAL_PRODUCT_JOURNEY_PHASES, [
    `${C2ZC_PRODUCT_JOURNEY_ID}/restore-fixture`,
    `${C2ZC_PRODUCT_JOURNEY_ID}/restore`,
    `${C2ZC_PRODUCT_JOURNEY_ID}/open`,
    `${C2ZC_PRODUCT_JOURNEY_ID}/restart`,
    `${C2ZC_PRODUCT_JOURNEY_ID}/typed-write`,
    `${C2ZC_PRODUCT_JOURNEY_ID}/restart-persistence`,
  ]);
  assert.equal(C2ZC_VERIFY_COVERAGE_COUNT, 13);
  assert.equal(
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG[0].phases.length,
    C2ZC_CANONICAL_PRODUCT_JOURNEY_PHASES.length,
  );
  assert.equal(NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG[1].phases.length, 1);
});

test("live authority snapshots preserve every cursor reservation and run field", async () => {
  const row = {
    feedHead: 4,
    cursorProjectId: "project-e1",
    consumerId: "narrative-incremental-freshness/v1",
    acknowledgedThrough: 4,
    reservedThrough: 4,
    activeRunId: "freshness-run-active",
    semanticEpochId: "e1",
    lastError: null,
    leaseOwner: "worker-1",
    leaseExpiresAt: "2026-08-29T00:01:00.000Z",
    updatedAt: "2026-08-29T00:00:30.000Z",
  };
  const harness = {
    invokeOk: async (_page, command, request) => {
      if (command === "narrative_maintenance_inbox_list") return [];
      if (request.sql.includes("FROM narrative_change_events")) {
        const placeholderCount = countC2ZcSqlPlaceholders(request.sql);
        assert.equal(placeholderCount, 21);
        assert.equal(request.params.length, placeholderCount);
        return { rows: [row] };
      }
      return { rows: [] };
    },
  };
  const snapshot = await readC2ZcAuthoritySnapshot(
    harness,
    { id: "page" },
    "project-e1",
  );
  assert.equal(snapshot.feedCursor.cursor.reservedThrough, row.reservedThrough);
  assert.equal(snapshot.feedCursor.cursor.activeRunId, row.activeRunId);
  assert.equal(snapshot.feedCursor.cursor.semanticEpochId, row.semanticEpochId);
  assert.throws(
    () =>
      assertC2ZcFeedCursorSettled(snapshot, {
        epochId: "e1",
        projectId: row.cursorProjectId,
        consumerId: row.consumerId,
      }),
    /cursor|acknowledged|active|epoch/i,
  );
});

test("SQLite placeholder scanner ignores quoted literals and comments", () => {
  const cases = [
    ["SELECT ?", 1],
    ["SELECT 'it''s ?' AS text, ?", 1],
    ['SELECT "quoted ""?"" identifier", ?', 1],
    ["SELECT `?``name`, ?", 1],
    ["SELECT [?] AS value, ?", 1],
    [String.raw`SELECT 'a\\' AS text, ?`, 1],
    ["SELECT ':é @é $é ?' AS text, ? /* :é @é $é ? */ -- :é @é $é ?\n", 1],
    ["-- ?\nSELECT ? /* block ? */", 1],
    ["SELECT '?' /* ? */ -- ?\n", 0],
  ];
  for (const [sql, expected] of cases) {
    assert.equal(countC2ZcSqlPlaceholders(sql), expected, sql);
  }
  assert.throws(
    () =>
      resolveC2ZcAuthorityQuery({
        sql: "SELECT '?' /* ? */",
        params: () => ["unexpected"],
      }),
    /expected 0, got 1/,
  );
  assert.throws(
    () =>
      resolveC2ZcAuthorityQuery({
        sql: "SELECT ? -- ?\n",
        params: () => [],
      }),
    /expected 1, got 0/,
  );
  for (const [sql, message] of [
    ["SELECT ?1", /unsupported numbered SQLite placeholder/],
    ["SELECT :name", /unsupported named SQLite placeholder/],
    ["SELECT @name", /unsupported named SQLite placeholder/],
    ["SELECT $name", /unsupported named SQLite placeholder/],
    ["SELECT :é", /unsupported named SQLite placeholder/],
    ["SELECT @é", /unsupported named SQLite placeholder/],
    ["SELECT $é", /unsupported named SQLite placeholder/],
    ["SELECT $::foo", /unsupported named SQLite placeholder/],
  ]) {
    assert.throws(() => countC2ZcSqlPlaceholders(sql), message, sql);
    assert.throws(
      () => resolveC2ZcAuthorityQuery({ sql, params: () => [] }),
      message,
      sql,
    );
  }
});

test("authority query descriptors preserve order, aliases, and bind arity", () => {
  const expectedDescriptorKeys = [
    "marker",
    "epochs",
    "runs",
    "genericFreshness",
    "legacyFreshness",
    "legacyDependencies",
    "dependencyEdges",
    "feedCursor",
    "applications",
    "codexEntries",
    "projectInventory",
    "findingLifecycle",
  ];
  assert.deepEqual(
    Object.keys(C2ZC_AUTHORITY_SNAPSHOT_QUERIES),
    expectedDescriptorKeys,
  );
  assert.equal(expectedDescriptorKeys.length, 12);
  assert.match(
    C2ZC_AUTHORITY_SNAPSHOT_QUERIES.codexEntries.sql,
    /type AS typeSlug/,
  );
  assert.equal(
    countC2ZcSqlPlaceholders(C2ZC_AUTHORITY_SNAPSHOT_QUERIES.feedCursor.sql),
    21,
  );

  const projectId = "project-contract";
  const descriptors = [
    ...Object.entries(C2ZC_AUTHORITY_SNAPSHOT_QUERIES).map(
      ([label, definition]) => [label, definition, { projectId }],
    ),
    [
      "applicationRows",
      C2ZC_AUTHORITY_APPLICATION_ROWS_QUERY,
      { commitId: "commit-contract" },
    ],
  ];
  assert.equal(descriptors.length, 13);
  for (const [label, definition, context] of descriptors) {
    const request = resolveC2ZcAuthorityQuery(definition, context);
    assert.equal(
      request.params.length,
      countC2ZcSqlPlaceholders(request.sql),
      label + " descriptor arity",
    );
  }
});
test("settled feed cursor rejects wrong project and consumer identities", () => {
  const snapshot = {
    feedCursor: {
      feedHead: 2,
      cursor: {
        projectId: "project-e1",
        consumerId: "narrative-incremental-freshness/v1",
        acknowledgedThroughSequence: 2,
        reservedThrough: null,
        activeRunId: null,
        semanticEpochId: null,
        lastError: null,
      },
    },
  };
  assert.doesNotThrow(() =>
    assertC2ZcFeedCursorSettled(snapshot, {
      projectId: "project-e1",
      consumerId: "narrative-incremental-freshness/v1",
    }),
  );
  assert.throws(
    () =>
      assertC2ZcFeedCursorSettled(snapshot, {
        projectId: "wrong-project",
        consumerId: "narrative-incremental-freshness/v1",
      }),
    /unexpected project/i,
  );
  assert.throws(
    () =>
      assertC2ZcFeedCursorSettled(snapshot, {
        projectId: "project-e1",
        consumerId: "wrong-consumer",
      }),
    /unexpected consumer/i,
  );
});

test("selection binding requires the canonical lane and preserves catalog order", () => {
  const complete = assertProductJourneySelectionBinding({
    catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
    journeys: NARRATIVE_C2ZC_PRODUCT_JOURNEYS,
    selectionName: "c2-zc",
  });
  assert.equal(complete.complete, true);
  assert.throws(
    () =>
      assertProductJourneySelectionBinding({
        catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
        journeys: [NARRATIVE_C2ZC_PRODUCT_JOURNEYS[1]],
        selectionName: "c2-zc",
      }),
    /canonical|required|order/i,
  );
  assert.throws(
    () =>
      assertProductJourneySelectionBinding({
        catalog: NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
        journeys: [...NARRATIVE_C2ZC_PRODUCT_JOURNEYS].reverse(),
        selectionName: "c2-zc",
      }),
    /order|catalog/i,
  );
});

test("canonical source has no independent post-marker lane or old hold seams", async () => {
  const source = await read(
    "electron/scripts/c2zc-canonical-product-journey.mjs",
  );
  for (const symbol of [
    "runC2ZcPostMarkerLifecycleJourney",
    "runC2ZcPostMarkerAuthorityLane",
    "C2ZC_POST_MARKER_PRODUCT_JOURNEY_ID",
    "C2ZC_POST_MARKER_PRODUCT_JOURNEY_PHASES",
    "freshnessHoldProjectId",
    "heldFreshness",
    "incomplete-cursor",
    "runRestoreVerifyRebuildVerifyScenario",
    "withLaunchEnvironmentForTest",
    "createPrimaryTypedFeedMutation",
  ]) {
    assert.doesNotMatch(source, new RegExp(symbol), symbol);
  }
  assert.match(source, /C2ZC_RESTORE_FIXTURE_ENV/);
  assert.match(source, /configureJourneyWorkspaceForProductJourney/);
  assert.match(
    source,
    /launchRestoreVerifyRebuildVerifyRestorePhaseForProductJourney/,
  );
  assert.match(source, /restoreBackupThroughSettingsUi/);
  assert.match(source, /assertC2ZcVerifyCoverage/);
  assert.doesNotMatch(
    source,
    /readC2ZcRestoreCanonicalLifecycleBaseline|sqlite3/,
  );
  const journeyBody = source.slice(
    source.indexOf("export async function runC2ZcCanonicalAuthorityJourney"),
  );
  assert.match(journeyBody, /assertC2ZcProjectInventory/);
  assert.match(journeyBody, /assertC2ZcRestorePreCutoverState/);
  assert.match(journeyBody, /assertC2ZcRestorePostSettingsState/);
  assert.match(journeyBody, /resolveC2ZcRestoreCanonicalLifecycleBaseline/);
  assert.match(journeyBody, /assertC2ZcRuntimeBackupName/);
  assert.match(journeyBody, /assertC2ZcFixtureApplicationParity/);
  assert.match(journeyBody, /assertC2ZcFindingRowsResolved/);
  assert.match(journeyBody, /assertC2ZcPostMarkerApplicationPersistence/);
  const openCheckpoint = journeyBody.slice(
    journeyBody.indexOf("openLaunch ="),
    journeyBody.indexOf("let restartLaunch"),
  );
  assert.match(openCheckpoint, /waitForLifecycle/);
  assert.match(openCheckpoint, /assertC2ZcFindingRowsResolved/);
  assert.match(openCheckpoint, /assertC2ZcFixtureApplicationParity/);
  const restartCheckpoint = journeyBody.slice(
    journeyBody.indexOf("restartLaunch ="),
    journeyBody.indexOf("let finalLaunch"),
  );
  assert.match(restartCheckpoint, /assertC2ZcRestartInvariants/);
  assert.match(restartCheckpoint, /assertC2ZcProjectInventory/);
  assert.match(restartCheckpoint, /assertC2ZcFixtureApplicationParity/);
  const finalCheckpoint = journeyBody.slice(
    journeyBody.indexOf("finalLaunch ="),
  );
  assert.match(finalCheckpoint, /assertC2ZcPostMarkerApplicationPersistence/);
  const restoreCallOffset = journeyBody.indexOf(
    "await restoreBackupThroughSettingsUi(",
  );
  const restoredAssignmentOffset = journeyBody.indexOf(
    "restoredSnapshot = await harness.waitUntil(",
  );
  const baselineReadOffset = journeyBody.indexOf(
    "resolveC2ZcRestoreCanonicalLifecycleBaseline(",
  );
  const restoredReadOffset = journeyBody.indexOf(
    "const snapshot = await readC2ZcAuthoritySnapshot(",
    restoredAssignmentOffset,
  );
  const restoredAssertionOffset = journeyBody.indexOf(
    "assertC2ZcRestorePostSettingsState(\n      restoredSnapshot,",
    restoredAssignmentOffset,
  );
  const restoreCloseOffset = journeyBody.indexOf(
    "  } finally {\n    await closeLaunch(\n      harness,\n      restoreLaunch,\n      `${C2ZC_PRODUCT_JOURNEY_ID}/restore`,\n    );",
    restoredAssertionOffset,
  );
  const normalOpenOffset = journeyBody.indexOf(
    "openLaunch = await harness.launch(`${C2ZC_PRODUCT_JOURNEY_ID}/open`);",
    restoreCloseOffset,
  );
  assert.ok(
    restoreCallOffset >= 0 &&
      restoredAssignmentOffset > restoreCallOffset &&
      baselineReadOffset >= 0 &&
      baselineReadOffset < restoreCallOffset &&
      restoredReadOffset > restoredAssignmentOffset &&
      restoredAssertionOffset > restoredReadOffset &&
      restoreCloseOffset > restoredAssertionOffset &&
      normalOpenOffset > restoreCloseOffset,
    "restore contamination assertion must guard the restored snapshot before close and normal open",
  );
  assert.doesNotMatch(source, /manifest\.(verifyOutcome|rustOutcome)/);
});

test("C2-ZC restore setup keeps automatic cutover disabled until normal open", async () => {
  const previousCi = process.env.CI;
  const seamEnvs = [
    NARRATIVE_MAINTENANCE_FAULT_ENV,
    NARRATIVE_MAINTENANCE_TRIGGER_ENV,
    NARRATIVE_MAINTENANCE_SETUP_ENV,
    NARRATIVE_FRESHNESS_DISABLE_ENV,
    NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV,
    NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
    NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
    NARRATIVE_MAINTENANCE_NONCE_ENV,
  ];
  const previousSeamValues = new Map(
    seamEnvs.map((name) => [name, process.env[name]]),
  );
  const observed = [];
  const snapshotEnvironment = () =>
    Object.fromEntries(seamEnvs.map((name) => [name, process.env[name]]));
  const expectedEnvironment = (overrides = {}) => ({
    ...Object.fromEntries(seamEnvs.map((name) => [name, undefined])),
    ...overrides,
  });
  const assertObservedEnvironment = (phase, expected) => {
    const observation = observed.find((entry) => entry.phase === phase);
    assert.ok(observation, `missing environment observation for ${phase}`);
    for (const name of seamEnvs) {
      if (expected[name] === "<uuid>") {
        assert.match(
          observation.env[name] ?? "",
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
          `${phase} must carry a generated UUIDv4 nonce`,
        );
      } else {
        assert.equal(
          observation.env[name],
          expected[name],
          `${phase} must restore/mask ${name}`,
        );
      }
    }
  };
  const harness = {
    launch: async (phase) => {
      observed.push({ phase, env: snapshotEnvironment() });
      if (phase.endsWith("/throw")) {
        throw new Error(`${phase} launch failed`);
      }
      return { phase };
    },
  };
  process.env.CI = "true";
  for (const name of seamEnvs) delete process.env[name];
  const activeConfigureEnvironment = expectedEnvironment({
    [NARRATIVE_MAINTENANCE_SETUP_ENV]: "disabled",
    [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    [NARRATIVE_MAINTENANCE_NONCE_ENV]: "<uuid>",
  });
  const activeRestoreEnvironment = expectedEnvironment({
    [NARRATIVE_MAINTENANCE_SETUP_ENV]: "disabled",
    [NARRATIVE_FRESHNESS_DISABLE_ENV]: "disabled",
    [NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV]: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
    [NARRATIVE_MAINTENANCE_NONCE_ENV]: "<uuid>",
  });
  const absentEnvironment = expectedEnvironment();
  const originalEnvironment = Object.fromEntries(
    seamEnvs.map((name, index) => [name, `original-${index}`]),
  );
  try {
    await configureJourneyWorkspaceForProductJourney(
      {},
      async () => {
        observed.push({ phase: "configure", env: snapshotEnvironment() });
      },
      "/tmp/c2-zc-restore-workspace",
    );
    await launchRestoreVerifyRebuildVerifyRestorePhaseForProductJourney(
      harness,
      "c2-zc-canonical-authority-cutover/restore",
      {},
    );
    await harness.launch("c2-zc-canonical-authority-cutover/normal-open");
    for (const [name, value] of Object.entries(originalEnvironment)) {
      process.env[name] = value;
    }
    await assert.rejects(
      configureJourneyWorkspaceForProductJourney(
        harness,
        async () => {
          observed.push({
            phase: "configure/throw",
            env: snapshotEnvironment(),
          });
          throw new Error("configure failed");
        },
        "/tmp/c2-zc-restore-workspace-throw",
      ),
      /configure failed/,
    );
    await harness.launch(
      "c2-zc-canonical-authority-cutover/normal-open-after-configure-throw",
    );
    await assert.rejects(
      launchRestoreVerifyRebuildVerifyRestorePhaseForProductJourney(
        harness,
        "c2-zc-canonical-authority-cutover/throw",
        {},
      ),
      /launch failed/,
    );
    await harness.launch(
      "c2-zc-canonical-authority-cutover/normal-open-after-restore-throw",
    );
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    for (const [name, value] of previousSeamValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
  assert.equal(observed.length, 7);
  assertObservedEnvironment("configure", activeConfigureEnvironment);
  assertObservedEnvironment(
    "c2-zc-canonical-authority-cutover/restore",
    activeRestoreEnvironment,
  );
  assertObservedEnvironment(
    "c2-zc-canonical-authority-cutover/normal-open",
    absentEnvironment,
  );
  assertObservedEnvironment("configure/throw", activeConfigureEnvironment);
  assertObservedEnvironment(
    "c2-zc-canonical-authority-cutover/normal-open-after-configure-throw",
    originalEnvironment,
  );
  assertObservedEnvironment(
    "c2-zc-canonical-authority-cutover/throw",
    activeRestoreEnvironment,
  );
  assertObservedEnvironment(
    "c2-zc-canonical-authority-cutover/normal-open-after-restore-throw",
    originalEnvironment,
  );

  assert.doesNotThrow(() =>
    assertC2ZcRestorePreCutoverState({
      markerRows: [],
      runs: [
        { runKind: "legacy-import", status: "completed" },
        { runKind: "unrelated-maintenance", status: "completed" },
      ],
      genericRows: [],
    }),
  );
  assert.throws(
    () =>
      assertC2ZcRestorePreCutoverState({
        markerRows: [
          {
            migrationId: "narrative-c2-canonical-freshness-v1",
            contractVersion: 1,
            appliedAt: "2026-08-30T00:00:00.000Z",
          },
        ],
        runs: [],
        genericRows: [],
      }),
    /marker/i,
  );
  for (const runKind of [
    "dependency-verify",
    "semantic-index-rebuild",
    "freshness-evaluation",
    "incremental-freshness",
  ]) {
    assert.throws(
      () =>
        assertC2ZcRestorePreCutoverState({
          markerRows: [],
          runs: [{ runKind, status: "completed" }],
          genericRows: [],
        }),
      /lifecycle|Run/i,
      `must reject ${runKind} before restore`,
    );
  }
  assert.throws(
    () =>
      assertC2ZcRestorePreCutoverState({
        markerRows: [],
        runs: [],
        genericRows: [{ consumerKind: "application" }],
      }),
    /Generic authority/i,
  );
});

function restoreBaselineRuns() {
  return [
    {
      id: "fixture-freshness-1",
      projectId: "project-e1",
      runKind: "freshness-evaluation",
      workKey: "incremental-freshness:fixture:0:2",
      status: "completed",
      semanticEpochId: "e0",
      outcomeSummaryJson: '{"throughSequenceInclusive":2}',
      createdAt: "2026-08-29T00:00:01.000Z",
      startedAt: "2026-08-29T00:00:01.000Z",
      completedAt: "2026-08-29T00:00:02.000Z",
      version: 1,
    },
    {
      id: "fixture-freshness-2",
      projectId: "project-e1",
      runKind: "freshness-evaluation",
      workKey: "incremental-freshness:fixture:2:3",
      status: "completed",
      semanticEpochId: "e0",
      outcomeSummaryJson: '{"throughSequenceInclusive":3}',
      createdAt: "2026-08-29T00:00:03.000Z",
      startedAt: "2026-08-29T00:00:03.000Z",
      completedAt: "2026-08-29T00:00:04.000Z",
      version: 1,
    },
  ];
}

function validRestoreDeltaRuns() {
  const coverage = structuredClone(C2ZC_RUST_VERIFY_COVERAGE);
  const times = [
    "2026-08-29T00:00:10.000Z",
    "2026-08-29T00:00:11.000Z",
    "2026-08-29T00:00:12.000Z",
    "2026-08-29T00:00:13.000Z",
    "2026-08-29T00:00:14.000Z",
    "2026-08-29T00:00:15.000Z",
    "2026-08-29T00:00:16.000Z",
    "2026-08-29T00:00:17.000Z",
    "2026-08-29T00:00:18.000Z",
    "2026-08-29T00:00:19.000Z",
    "2026-08-29T00:00:20.000Z",
    "2026-08-29T00:00:21.000Z",
    "2026-08-29T00:00:22.000Z",
    "2026-08-29T00:00:23.000Z",
  ];
  const run = (id, runKind, createdAt, outcomeSummaryJson = undefined) => ({
    id,
    projectId: "project-e1",
    runKind,
    status: "completed",
    semanticEpochId: "e1",
    createdAt,
    startedAt: times[times.indexOf(createdAt) + 1] ?? createdAt,
    completedAt: times[times.indexOf(createdAt) + 2] ?? createdAt,
    ...(outcomeSummaryJson ? { outcomeSummaryJson } : {}),
  });
  return [
    run("verify-1", "dependency-verify", times[0], {
      report: productionVerifyReport({ first: true }),
      verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
      checkCoverage: coverage,
    }),
    run("rebuild-1", "semantic-index-rebuild", times[3]),
    run("verify-2", "dependency-verify", times[6], {
      report: productionVerifyReport(),
      verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
      checkCoverage: coverage,
    }),
    run("fresh-1", "freshness-evaluation", times[9]),
  ];
}

test("C2-ZC restore baseline preserves fixture lifecycle rows exactly", () => {
  const semantic = fixtureSemantic();
  const baseline = resolveC2ZcRestoreCanonicalLifecycleBaseline(semantic);
  assert.deepEqual(
    assertC2ZcRestoreCanonicalBaseline(
      { runs: structuredClone(baseline) },
      baseline,
    ),
    baseline,
  );
  assert.doesNotThrow(() =>
    assertC2ZcRestorePostSettingsState(
      {
        markerRows: [],
        genericRows: [],
        runs: structuredClone(baseline),
      },
      baseline,
    ),
  );
  assert.throws(
    () =>
      assertC2ZcRestorePostSettingsState(
        {
          markerRows: [{ migrationId: "narrative-c2-canonical-freshness-v1" }],
          genericRows: [],
          runs: structuredClone(baseline),
        },
        baseline,
      ),
    /marker/i,
  );
  assert.throws(
    () =>
      assertC2ZcRestorePostSettingsState(
        {
          markerRows: [],
          genericRows: [{ consumerKind: "application" }],
          runs: structuredClone(baseline),
        },
        baseline,
      ),
    /Generic authority/i,
  );

  for (const [label, mutate] of [
    ["extra", (runs) => runs.push({ ...runs[0], id: "extra" })],
    ["missing", (runs) => runs.splice(1, 1)],
    ["mutated", (runs) => (runs[0].outcomeSummaryJson = '{"changed":true}')],
    ["duplicate", (runs) => runs.splice(1, 0, structuredClone(runs[0]))],
    ["reordered", (runs) => runs.reverse()],
  ]) {
    const observed = structuredClone(baseline);
    mutate(observed);
    assert.throws(
      () =>
        assertC2ZcRestoreCanonicalBaseline(
          { runs: observed },
          baseline,
          `C2-ZC restore baseline ${label}`,
        ),
      /baseline|canonical|lifecycle|changed|duplicate|order/i,
      label,
    );
  }
});

test("C2-ZC lifecycle verifier isolates an exact four-run delta after baseline", () => {
  const baseline = restoreBaselineRuns();
  const delta = validRestoreDeltaRuns();
  const fixture = strictLifecycleRuns();
  const allRuns = [...baseline, ...delta];
  assert.doesNotThrow(() =>
    assertC2ZcRestoreLifecycleOrder(allRuns, {
      currentEpochId: "e1",
      restoreEpochId: "e1",
      expectedRestoreLifecycle: fixture.expectedRestoreLifecycle,
      marker: fixture.marker,
      rustOutcome: fixture.rustOutcome,
      fixtureSemantic: fixtureSemantic(),
      baselineRuns: baseline,
    }),
  );
  for (const [label, mutate] of [
    [
      "baseline-mutated",
      (runs) => (runs[0].outcomeSummaryJson = '{"changed":true}'),
    ],
    ["baseline-missing", (runs) => runs.splice(1, 1)],
    [
      "baseline-extra",
      (runs) => runs.splice(1, 0, { ...runs[0], id: "extra" }),
    ],
    ["delta-missing", (runs) => runs.splice(-1, 1)],
    ["delta-extra", (runs) => runs.push({ ...runs.at(-1), id: "extra-delta" })],
    [
      "delta-order",
      (runs) => {
        const last = runs.pop();
        runs.splice(baseline.length, 0, last);
      },
    ],
  ]) {
    const mutated = structuredClone(allRuns);
    mutate(mutated);
    assert.throws(
      () =>
        assertC2ZcRestoreLifecycleOrder(mutated, {
          currentEpochId: "e1",
          restoreEpochId: "e1",
          expectedRestoreLifecycle: fixture.expectedRestoreLifecycle,
          marker: fixture.marker,
          rustOutcome: fixture.rustOutcome,
          fixtureSemantic: fixtureSemantic(),
          baselineRuns: baseline,
        }),
      /baseline|canonical|lifecycle|changed|delta|order|four|4|Verify|Freshness/i,
      label,
    );
  }
});

test("C2-ZC manifest baseline is immutable and exact", () => {
  const semantic = fixtureSemantic();
  const baseline = resolveC2ZcRestoreCanonicalLifecycleBaseline(semantic);
  assert.deepEqual(baseline, semantic.restoreCanonicalLifecycleBaseline.rows);
  for (const mutate of [
    (value) => value.restoreCanonicalLifecycleBaseline.rows.pop(),
    (value) => {
      value.restoreCanonicalLifecycleBaseline.rows[0].id = "mutated";
    },
    (value) => {
      value.restoreCanonicalLifecycleBaseline.rows.reverse();
    },
    (value) => {
      value.restoreCanonicalLifecycleBaseline.rows.push(
        structuredClone(value.restoreCanonicalLifecycleBaseline.rows.at(-1)),
      );
    },
  ]) {
    const mutated = structuredClone(semantic);
    mutate(mutated);
    assert.throws(
      () => resolveC2ZcRestoreCanonicalLifecycleBaseline(mutated),
      /baseline|canonical|digest|order|duplicate|non-empty/i,
    );
  }
});

test("C2-ZC staged restore backup name is bound to the manifest fixture digest", () => {
  const digest = `sha256:${"a".repeat(64)}`;
  assert.equal(
    resolveC2ZcRuntimeBackupName(C2ZC_RESTORE_FIXTURE_BACKUP_NAME, digest),
    `grimodex-c2zc-restore-fixture--sha256-${"a".repeat(64)}.backup.db`,
  );
  for (const invalid of [
    undefined,
    "",
    "sha256:ABC" + "a".repeat(61),
    `sha256:${"a".repeat(63)}G`,
    `sha256:${"a".repeat(65)}`,
    "sha256:" + "a".repeat(64) + ".db",
  ]) {
    assert.throws(
      () =>
        resolveC2ZcRuntimeBackupName(C2ZC_RESTORE_FIXTURE_BACKUP_NAME, invalid),
      /digest|sha256|lowerhex/i,
      String(invalid),
    );
  }
});

test("offline restore fixture interface is narrow and fail-closed", () => {
  assert.equal(C2ZC_RESTORE_FIXTURE_ENV, "GRIMODEX_C2ZC_RESTORE_FIXTURE");
  const digest = `sha256:${"a".repeat(64)}`;
  const fixtureManifest = {
    manifestVersion: 1,
    contractVersion: 1,
    schemaVersion: 1,
    databaseSchemaVersion: 1,
    c2zcMarkerPresent: false,
    candidate: {
      requested: "HEAD",
      resolvedHeadSha: "b".repeat(40),
      resolvedTreeSha: "c".repeat(40),
      headSha: "b".repeat(40),
      treeSha: "c".repeat(40),
      clean: true,
      statusSha256: digest,
    },
    builderVersion: "c2zc-restore-fixture-builder/v1",
    builderCommand: ["c2zc-restore-fixture", "build"],
    exactBuilderCommand: ["c2zc-restore-fixture", "build"],
    artifacts: {
      fixture: {
        path: "c2-zc-fixture.backup.db",
        sha256: digest,
        sizeBytes: 10,
      },
      database: {
        path: "c2-zc-fixture.db",
        sha256: digest,
        sizeBytes: 10,
      },
    },
    fixtureSha256: digest,
    fixtureSizeBytes: 10,
    semantic: fixtureSemantic(),
  };
  const valid = {
    path: "/tmp/c2-zc-fixture.backup.db",
    manifest: fixtureManifest,
  };
  assert.deepEqual(assertC2ZcRestoreFixtureInput(valid), valid);
  assert.doesNotThrow(() => assertC2ZcRestoreFixtureManifest(fixtureManifest));
  assert.doesNotThrow(() =>
    assertC2ZcFixtureCandidateBinding(fixtureManifest.candidate, {
      requestedHead: "HEAD",
      resolvedHeadSha: fixtureManifest.candidate.resolvedHeadSha,
      resolvedHeadTreeSha: fixtureManifest.candidate.resolvedTreeSha,
      currentHeadSha: fixtureManifest.candidate.headSha,
      worktreeClean: true,
    }),
  );
  for (const invalid of [
    null,
    {},
    { path: "relative.sqlite", manifest: valid.manifest },
    {
      path: valid.path,
      manifest: { ...valid.manifest, manifestVersion: 2 },
    },
    {
      path: valid.path,
      manifest: {
        ...valid.manifest,
        artifacts: {
          ...valid.manifest.artifacts,
          fixture: {
            ...valid.manifest.artifacts.fixture,
            path: "../escape",
          },
        },
      },
    },
  ]) {
    assert.throws(
      () => assertC2ZcRestoreFixtureInput(invalid),
      /fixture|path|manifest|version/i,
    );
  }
});

test("C2-ZC staging publishes the offline fixture through an owned private temp", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "grimodex-c2zc-stage-"));
  const fixtureBytes = Buffer.from("fixture-db");
  const fixtureSha256 = `sha256:${createHash("sha256")
    .update(fixtureBytes)
    .digest("hex")}`;
  const fixtureFor = async (sourceName = C2ZC_RESTORE_FIXTURE_BACKUP_NAME) => {
    const sourcePath = path.join(root, sourceName);
    await writeFile(sourcePath, fixtureBytes);
    return {
      path: sourcePath,
      manifest: createC2ZcFixtureManifest({
        fixturePath: C2ZC_RESTORE_FIXTURE_BACKUP_NAME,
        databasePath: "c2zc-restore-fixture.db",
        fixtureSha256,
        fixtureSizeBytes: fixtureBytes.length,
      }),
    };
  };
  const backupEntries = async (workspace) =>
    readdir(path.join(workspace, "backups"));
  const assertStagingResidue = async (workspace, targetPresent) => {
    const entries = await backupEntries(workspace);
    const hidden = entries.filter((entry) => entry.startsWith("."));
    assert.equal(hidden.length, 1);
    assert.ok(!hidden[0].startsWith("grimodex-"));
    assert.equal(
      entries.filter((entry) => entry.startsWith("grimodex-")).length,
      targetPresent ? 1 : 0,
    );
    return hidden[0];
  };
  const workspaceFor = (name) => path.join(root, `${name}-workspace`);
  const targetFor = (workspace, fixture) =>
    path.join(
      workspace,
      "backups",
      resolveC2ZcRuntimeBackupName(
        fixture.manifest.artifacts.fixture.path,
        fixture.manifest.artifacts.fixture.sha256,
      ),
    );
  const assertStageFailure = async (
    name,
    fixture,
    options,
    expected,
    targetPresent = false,
  ) => {
    const workspace = workspaceFor(name);
    const target = targetFor(workspace, fixture);
    await assert.rejects(
      stageC2ZcRestoreFixture(workspace, fixture, options),
      expected,
    );
    if (!targetPresent) await assert.rejects(lstat(target), { code: "ENOENT" });
    await assertStagingResidue(workspace, targetPresent);
    return { target, workspace };
  };
  try {
    const stagingSource = await read(
      "electron/scripts/c2zc-canonical-product-journey.mjs",
    );
    assert.doesNotMatch(stagingSource, /\bunlink\b/);

    const fixture = await fixtureFor();
    const staged = await stageC2ZcRestoreFixture(
      path.join(root, "workspace"),
      fixture,
    );
    const expectedBackupName = resolveC2ZcRuntimeBackupName(
      fixture.manifest.artifacts.fixture.path,
      fixture.manifest.artifacts.fixture.sha256,
    );
    assert.equal(staged.backupName, expectedBackupName);
    assertC2ZcRuntimeBackupName(
      staged.backupName,
      fixture.manifest.fixtureSha256,
    );
    assert.equal(
      staged.targetPath,
      path.join(root, "workspace", "backups", expectedBackupName),
    );
    assert.deepEqual(await readFile(staged.targetPath), fixtureBytes);
    assert.equal(staged.sourceBackupName, C2ZC_RESTORE_FIXTURE_BACKUP_NAME);
    assert.ok(path.basename(staged.stagingTempPath).startsWith("."));
    assert.ok(!path.basename(staged.stagingTempPath).startsWith("grimodex-"));
    const targetMetadata = await lstat(staged.targetPath);
    const tempMetadata = await lstat(staged.stagingTempPath);
    assert.equal(targetMetadata.dev, tempMetadata.dev);
    assert.equal(targetMetadata.ino, tempMetadata.ino);
    assert.equal(staged.stagingTempDevice, tempMetadata.dev);
    assert.equal(staged.stagingTempInode, tempMetadata.ino);
    await assertStagingResidue(path.join(root, "workspace"), true);

    for (const invalid of [
      "",
      ".db",
      ".db.gz",
      "c2zc-restore-fixture.db",
      "c2zc-restore-fixture.db.gz",
      "c2zc-restore-fixture.foo..bar.db",
      "c2zc-restore-fixture\\backup.db",
      "C:\\tmp\\c2zc-restore-fixture.backup.db",
      "../c2zc-restore-fixture.backup.db",
      "c2zc-../fixture.db",
    ]) {
      assert.throws(
        () => resolveC2ZcRuntimeBackupName(invalid),
        /relative file name|must be a non-empty string|must be c2zc-restore-fixture/i,
        invalid,
      );
    }

    const existingFixture = await fixtureFor();
    const existingWorkspace = workspaceFor("existing-file");
    const existingPath = targetFor(existingWorkspace, existingFixture);
    await mkdir(path.dirname(existingPath), { recursive: true });
    await writeFile(existingPath, "keep-existing");
    await assert.rejects(
      stageC2ZcRestoreFixture(existingWorkspace, existingFixture),
      /already exists/,
    );
    assert.deepEqual(
      await readFile(existingPath),
      Buffer.from("keep-existing"),
    );
    assert.deepEqual(await backupEntries(existingWorkspace), [
      path.basename(existingPath),
    ]);

    const sentinelPath = path.join(root, "external-sentinel.txt");
    await writeFile(sentinelPath, "keep-sentinel");
    const symlinkWorkspace = workspaceFor("symlink");
    const symlinkPath = targetFor(symlinkWorkspace, existingFixture);
    await mkdir(path.dirname(symlinkPath), { recursive: true });
    await symlink(sentinelPath, symlinkPath);
    await assert.rejects(
      stageC2ZcRestoreFixture(symlinkWorkspace, existingFixture),
      /already exists/,
    );
    assert.deepEqual(
      await readFile(sentinelPath),
      Buffer.from("keep-sentinel"),
    );
    assert.equal((await lstat(symlinkPath)).isSymbolicLink(), true);
    assert.deepEqual(await backupEntries(symlinkWorkspace), [
      path.basename(symlinkPath),
    ]);

    const externalBackups = path.join(root, "external-backups");
    const backupDirectorySymlinkWorkspace = path.join(
      root,
      "backup-directory-symlink-workspace",
    );
    await mkdir(externalBackups, { recursive: true });
    await mkdir(backupDirectorySymlinkWorkspace, { recursive: true });
    await symlink(
      externalBackups,
      path.join(backupDirectorySymlinkWorkspace, "backups"),
      "dir",
    );
    await assert.rejects(
      stageC2ZcRestoreFixture(backupDirectorySymlinkWorkspace, existingFixture),
      /backup directory must be a real directory/,
    );
    assert.equal((await lstat(externalBackups)).isDirectory(), true);

    await assertStageFailure(
      "partial",
      existingFixture,
      {
        writeFileFn: async (fileHandle, bytes) => {
          const result = await fileHandle.write(bytes, 0, 2, null);
          assert.equal(result.bytesWritten, 2);
          throw new Error("injected partial temp write");
        },
      },
      /partial temp write/,
    );
    await assertStageFailure(
      "corrupt",
      existingFixture,
      {
        writeFileFn: async (fileHandle, bytes, tempPath) => {
          await fileHandle.write(bytes, 0, bytes.length, null);
          await writeFile(tempPath, "corrupt-file");
        },
      },
      /bytes do not match/,
    );

    const beforeLink = await assertStageFailure(
      "before-link",
      existingFixture,
      {
        linkFn: async (tempPath, targetPath) => {
          await writeFile(targetPath, "replacement-before-link");
          return link(tempPath, targetPath);
        },
      },
      /EEXIST|already exists|file exists/i,
      true,
    );
    assert.deepEqual(
      await readFile(beforeLink.target),
      Buffer.from("replacement-before-link"),
    );

    const afterLink = await assertStageFailure(
      "after-link",
      existingFixture,
      {
        linkFn: async (tempPath, targetPath) => {
          await link(tempPath, targetPath);
          await rm(targetPath);
          await writeFile(targetPath, "replacement-after-link");
        },
      },
      /published restore fixture identity changed/,
      true,
    );
    assert.deepEqual(
      await readFile(afterLink.target),
      Buffer.from("replacement-after-link"),
    );

    let replacedTempPath = null;
    await assertStageFailure(
      "residue",
      existingFixture,
      {
        linkFn: async (tempPath) => {
          replacedTempPath = tempPath;
          await rm(tempPath);
          await writeFile(tempPath, "replacement-private-temp");
          throw new Error("injected private temp replacement");
        },
      },
      /injected private temp replacement/,
    );
    assert.ok(replacedTempPath);
    assert.deepEqual(
      await readFile(replacedTempPath),
      Buffer.from("replacement-private-temp"),
    );

    await assertStageFailure(
      "unsupported",
      existingFixture,
      {
        linkFn: async () => {
          const error = new Error("link unsupported");
          error.code = "EOPNOTSUPP";
          throw error;
        },
      },
      /link unsupported/,
    );

    const sourceSymlinkDirectory = path.join(root, "source-link");
    const sourceSymlink = path.join(
      sourceSymlinkDirectory,
      C2ZC_RESTORE_FIXTURE_BACKUP_NAME,
    );
    await mkdir(sourceSymlinkDirectory, { recursive: true });
    await symlink(existingFixture.path, sourceSymlink);
    await assert.rejects(
      stageC2ZcRestoreFixture(path.join(root, "source-symlink-workspace"), {
        ...existingFixture,
        path: sourceSymlink,
      }),
      /regular file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restore fixture accepts the canonical initial scene version boundary", () => {
  const semantic = createC2ZcFixtureSemantic({
    sceneSourceRevision: "v0@2026-08-29T00:00:01.000Z",
  });
  semantic.scene.version = 0;
  refreshC2ZcFixtureSemanticDigests(semantic);
  assert.doesNotThrow(() =>
    assertC2ZcRestoreFixtureManifest(createC2ZcFixtureManifest({ semantic })),
  );

  for (const version of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const invalidSemantic = structuredClone(semantic);
    invalidSemantic.scene.version = version;
    refreshC2ZcFixtureSemanticDigests(invalidSemantic);
    assert.throws(
      () =>
        assertC2ZcRestoreFixtureManifest(
          createC2ZcFixtureManifest({ semantic: invalidSemantic }),
        ),
      /scene\.version|integer/,
      `scene.version=${String(version)} must be rejected`,
    );
  }
});

test("restore fixture accepts the real Rust typed tree-node producer timestamp shape", async () => {
  const rustFixtureSource = await read(
    "src-tauri/crates/grimodex-db/src/narrative_extraction/c2zc_restore_fixture.rs",
  );
  const rustWriterSource = await read(
    "src-tauri/crates/grimodex-db/src/domain_writes.rs",
  );
  const treeNodeCreateSource = rustWriterSource.slice(
    rustWriterSource.indexOf("pub fn tree_node_create_with_authority("),
    rustWriterSource.indexOf("pub fn tree_node_delete("),
  );
  assert.match(
    rustFixtureSource,
    /"updatedAt": row\.get::<_, String>\(8\)\?/,
    "Rust fixture serialization must retain tree_nodes.updated_at verbatim",
  );
  assert.match(
    rustFixtureSource,
    /let scene_source_revision = format!\("v\{scene_version\}@\{scene_updated_at\}"\);/,
    "Rust fixture serialization must compose the source token from the raw timestamp",
  );
  assert.match(
    treeNodeCreateSource,
    /let now = chrono::Utc::now\(\)\.to_rfc3339\(\);/,
    "the typed tree-node producer must remain the source of scene.updatedAt",
  );
  const sceneUpdatedAt = "2026-08-29T20:37:21.914339624+00:00";
  const sceneSourceRevision = `v0@${sceneUpdatedAt}`;
  const semantic = createC2ZcFixtureSemantic({ sceneSourceRevision });
  semantic.scene.version = 0;
  refreshC2ZcFixtureSemanticDigests(semantic);
  const manifest = createC2ZcFixtureManifest({ semantic });

  assert.doesNotThrow(() => assertC2ZcRestoreFixtureManifest(manifest));
  assert.equal(manifest.semantic.scene.updatedAt, sceneUpdatedAt);
  assert.equal(manifest.semantic.sceneSourceRevision, sceneSourceRevision);
  assert.equal(
    manifest.semantic.edgeReadSetJson,
    JSON.stringify([sceneSourceRevision]),
  );
  assert.equal(
    manifest.semantic.legacyProjection.dependencies[0].observedRevisionToken,
    sceneSourceRevision,
  );
});

test("typed tree-node producer timestamps use the source profile without weakening authority timestamps", () => {
  for (const sceneUpdatedAt of [
    "2026-08-29T20:37:21Z",
    "2026-08-29T20:37:21.1Z",
    "2026-08-29T20:37:21.914339624+00:00",
    "2024-02-29T20:37:21.123456789Z",
    "0000-02-29T20:37:21Z",
  ]) {
    const semantic = createC2ZcFixtureSemantic({
      sceneSourceRevision: `v1@${sceneUpdatedAt}`,
    });
    assert.doesNotThrow(
      () =>
        assertC2ZcRestoreFixtureManifest(
          createC2ZcFixtureManifest({ semantic }),
        ),
      `valid source timestamp must be accepted: ${sceneUpdatedAt}`,
    );
  }

  for (const sceneUpdatedAt of [
    "2026-02-29T20:37:21Z",
    "2026-04-31T20:37:21Z",
    "2026-08-29T24:37:21Z",
    "2026-08-29T20:60:21Z",
    // Generic RFC3339 permits leap-second syntax; tree_node_create's Utc::now
    // producer output profile is explicitly non-leap-second.
    "2026-08-29T20:37:60Z",
    "2026-08-29T20:37:61Z",
    "2026-08-29T20:37:21+01:00",
    "2026-08-29T20:37:21-00:00",
    "2026-08-29T20:37:21z",
    "2026-08-29T20:37:21.1234567890Z",
    " 2026-08-29T20:37:21Z",
    "2026-08-29T20:37:21Z ",
    "2026-08-29T20:37:21Ztrailing",
  ]) {
    const semantic = createC2ZcFixtureSemantic({
      sceneSourceRevision: `v1@${sceneUpdatedAt}`,
    });
    assert.throws(
      () =>
        assertC2ZcRestoreFixtureManifest(
          createC2ZcFixtureManifest({ semantic }),
        ),
      /scene(?:\.updatedAt|SourceRevision).*?(?:timestamp|RFC3339|non-empty)/i,
      `invalid source timestamp must be rejected: ${sceneUpdatedAt}`,
    );
  }

  const authorityTimestamp = "2026-08-29T20:37:21.914339624+00:00";
  const authoritySemantic = createC2ZcFixtureSemantic();
  authoritySemantic.epoch.rows[0].createdAt = authorityTimestamp;
  refreshC2ZcFixtureSemanticDigests(authoritySemantic);
  assert.throws(
    () =>
      assertC2ZcRestoreFixtureManifest(
        createC2ZcFixtureManifest({ semantic: authoritySemantic }),
      ),
    /epoch\.rows\[0\]\.createdAt.*canonical UTC millisecond timestamp/i,
    "authority timestamps must retain the canonical millisecond contract",
  );
});

test("Verify coverage binds both outcomes to the Rust and policy contract", () => {
  const rustOutcome = {
    verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
    checkCoverage: C2ZC_RUST_VERIFY_COVERAGE,
    report: { rebuildRequired: false },
  };
  const run = { status: "completed", outcomeSummaryJson: rustOutcome };
  assert.deepEqual(
    assertC2ZcVerifyCoverage(run, rustOutcome).checkCoverage,
    rustOutcome.checkCoverage,
  );
  assert.throws(
    () =>
      assertC2ZcVerifyCoverage(run, {
        ...rustOutcome,
        checkCoverage: {
          ...rustOutcome.checkCoverage,
          covered: [],
        },
      }),
    /coverage|13|Rust/i,
  );
  assert.throws(
    () =>
      assertC2ZcVerifyCoverage(run, {
        ...rustOutcome,
        verifyContractVersion: "bogus",
      }),
    /version|Rust/i,
  );
  assert.throws(
    () =>
      assertC2ZcVerifyCoverage(run, {
        ...rustOutcome,
        checkCoverage: {
          ...rustOutcome.checkCoverage,
          required: Array.from({ length: 13 }, (_, index) => `fake-${index}`),
          covered: Array.from({ length: 13 }, (_, index) => `fake-${index}`),
        },
      }),
    /coverage|policy|Rust/i,
  );
  assert.throws(
    () =>
      assertC2ZcVerifyCoverage(
        {
          ...run,
          outcomeSummaryJson: {
            ...rustOutcome,
            verifyContractVersion: "bogus",
          },
        },
        rustOutcome,
      ),
    /version|Rust/i,
  );
  assert.throws(
    () =>
      assertC2ZcVerifyCoverage(
        {
          ...run,
          outcomeSummaryJson: {
            ...rustOutcome,
            checkCoverage: {
              ...rustOutcome.checkCoverage,
              required: [
                "fake-check",
                ...rustOutcome.checkCoverage.required.slice(1),
              ],
              covered: [
                "fake-check",
                ...rustOutcome.checkCoverage.covered.slice(1),
              ],
            },
          },
        },
        rustOutcome,
      ),
    /coverage|policy|Rust/i,
  );
});

test("marker and restart contracts retain authority, Legacy, and Epoch values", () => {
  const marker = {
    migrationId: "narrative-c2-canonical-freshness-v1",
    contractVersion: 1,
    appliedAt: "2026-08-29T00:00:00.000Z",
  };
  const before = {
    markerRows: [marker],
    epochs: [
      { id: "e0", epochNumber: 0, reason: "initial" },
      { id: "e1", epochNumber: 1, reason: "restore" },
    ],
    currentEpochId: "e1",
    legacyProjection: [{ applicationId: "a1", status: "fresh" }],
    runs: [{ id: "verify-1", runKind: "dependency-verify" }],
  };
  const after = structuredClone(before);
  assertC2ZcMarkerExactlyOnce(after);
  assert.doesNotThrow(() =>
    assertC2ZcRestartInvariants({ before, restart: after }),
  );
  assert.throws(
    () =>
      assertC2ZcRestartInvariants({
        before,
        restart: {
          ...after,
          epochs: [...after.epochs, { id: "e2" }],
        },
      }),
    /Epoch|authority|restart/i,
  );
});

test("restore lifecycle accepts Verify -> conditional Rebuild -> confirmation Verify -> Freshness", () => {
  const checkCoverage = structuredClone(C2ZC_RUST_VERIFY_COVERAGE);
  const runs = [
    {
      id: "verify-1",
      runKind: "dependency-verify",
      status: "completed",
      semanticEpochId: "e1",
      outcomeSummaryJson: {
        report: { rebuildRequired: true },
        verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
        checkCoverage,
      },
    },
    {
      id: "rebuild-1",
      runKind: "semantic-index-rebuild",
      status: "completed",
      semanticEpochId: "e1",
    },
    {
      id: "verify-2",
      runKind: "dependency-verify",
      status: "completed",
      semanticEpochId: "e1",
      outcomeSummaryJson: {
        report: { rebuildRequired: false },
        verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
        checkCoverage,
      },
    },
    {
      id: "fresh-1",
      runKind: "freshness-evaluation",
      status: "completed",
      semanticEpochId: "e1",
    },
  ];
  assert.doesNotThrow(() =>
    assertC2ZcRestoreLifecycleOrder(runs, { currentEpochId: "e1" }),
  );
  assert.doesNotThrow(() =>
    assertC2ZcRestoreLifecycleOrder(runs, {
      currentEpochId: "e1",
      restoreEpochId: "e1",
    }),
  );
  assert.throws(
    () =>
      assertC2ZcRestoreLifecycleOrder(runs, {
        currentEpochId: "e1",
        restoreEpochId: "wrong-e1",
      }),
    /restored E1|Semantic Epoch/i,
  );
  assert.throws(
    () =>
      assertC2ZcRestoreLifecycleOrder([runs[0], runs[2], runs[3]], {
        currentEpochId: "e1",
      }),
    /Rebuild|order|confirmation/i,
  );
});

function completeSemanticIndexChecks() {
  const zero = {
    metadataRows: 0,
    activeD1HeadRows: 0,
    v1EdgeRows: 0,
    consumerFreshnessRows: 0,
  };
  return {
    semanticIndexDependencySetDigest: {
      observedCounts: zero,
      completed: true,
      passed: true,
      issues: [],
      incomplete: [],
    },
    semanticIndexGenerationCorrespondence: {
      observedCounts: zero,
      completed: true,
      passed: true,
      issues: [],
      incomplete: [],
    },
  };
}

function productionVerifyReport({ first = false } = {}) {
  const complete = {
    completed: true,
    passed: true,
    issues: [],
    incomplete: [],
  };
  const semantic = {
    ...complete,
    observedCounts: {
      metadataRows: 0,
      activeD1HeadRows: 0,
      v1EdgeRows: 0,
      consumerFreshnessRows: 0,
    },
  };
  return {
    totalEdges: 1,
    edgeIdsWithMissingSource: [],
    duplicateEdgeKeys: [],
    edgeIdsWithCrossProjectConsumer: [],
    edgeIdsWithMalformedKeys: [],
    edgeStateIdsOutsideCurrentEpoch: [],
    edgeIdsWithoutCurrentEpochState: first
      ? ["edge-e1", "proposal-edge-e1"]
      : [],
    findingObservationIdsOutsideCurrentEpoch: [],
    consumerKeysWithoutCurrentEpochFreshness: first
      ? [
          ["application", "application-e1"],
          ["proposal-revision", "owner-e1-revision"],
        ]
      : [],
    duplicateEdgeIdsToDeactivate: [],
    edgeIdsWithUnresolvableConsumerScope: [],
    consumerKeysWithStaleDependencySetDigest: [],
    consumerKeysWithUncomputedDependencySetDigest: [],
    orphanedAttentionFindingKeys: [],
    orphanedAttentionRehomeAmbiguities: [],
    applicationRevisionArtifactReferences: complete,
    semanticIndexDependencySetDigest: semantic,
    contributionToApplicationCommitCorrespondence: complete,
    legacyMirrorMigrationParity: first
      ? {
          completed: false,
          passed: false,
          issues: [],
          incomplete: [
            "application:application-e1:generic-freshness-missing",
            "application:unrelated-application:generic-freshness-missing",
          ],
        }
      : complete,
    cursorAndFeedHeadConsistency: complete,
    semanticIndexGenerationCorrespondence: semantic,
    rebuildRequired: first,
  };
}

function strictLifecycleRuns() {
  const coverage = structuredClone(C2ZC_RUST_VERIFY_COVERAGE);
  const times = [
    "2026-08-29T00:00:10.000Z",
    "2026-08-29T00:00:11.000Z",
    "2026-08-29T00:00:12.000Z",
    "2026-08-29T00:00:13.000Z",
    "2026-08-29T00:00:14.000Z",
    "2026-08-29T00:00:15.000Z",
    "2026-08-29T00:00:16.000Z",
    "2026-08-29T00:00:17.000Z",
    "2026-08-29T00:00:18.000Z",
    "2026-08-29T00:00:19.000Z",
    "2026-08-29T00:00:20.000Z",
    "2026-08-29T00:00:21.000Z",
    "2026-08-29T00:00:22.000Z",
    "2026-08-29T00:00:23.000Z",
  ];
  const run = (id, runKind, createdAt, outcomeSummaryJson = undefined) => ({
    id,
    projectId: "project-e1",
    runKind,
    status: "completed",
    semanticEpochId: "e1",
    createdAt,
    startedAt: times[times.indexOf(createdAt) + 1] ?? createdAt,
    completedAt: times[times.indexOf(createdAt) + 2] ?? createdAt,
    ...(outcomeSummaryJson ? { outcomeSummaryJson } : {}),
  });
  return {
    coverage,
    times,
    runs: [
      run("verify-1", "dependency-verify", times[0], {
        report: productionVerifyReport({ first: true }),
        verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
        checkCoverage: coverage,
      }),
      run("rebuild-1", "semantic-index-rebuild", times[3]),
      run("verify-2", "dependency-verify", times[6], {
        report: productionVerifyReport(),
        verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
        checkCoverage: coverage,
      }),
      run("fresh-1", "freshness-evaluation", times[9]),
    ],
    expectedRestoreLifecycle: {
      firstVerify: "rebuild-required",
      conditionalRebuild: "required",
      confirmationVerify: "clean",
      marker: "after-confirmation-verify",
    },
    marker: {
      migrationId: "narrative-c2-canonical-freshness-v1",
      contractVersion: 1,
      appliedAt: times[12],
    },
    rustOutcome: {
      verifyContractVersion: C2ZC_RUST_VERIFY_CONTRACT_VERSION,
      report: productionVerifyReport(),
      checkCoverage: structuredClone(coverage),
    },
  };
}

test("restore lifecycle is fixture-bound, exact, timestamped, and marker-last", () => {
  const fixture = strictLifecycleRuns();
  assert.doesNotThrow(() =>
    assertC2ZcRestoreLifecycleOrder(fixture.runs, {
      currentEpochId: "e1",
      restoreEpochId: "e1",
      expectedRestoreLifecycle: fixture.expectedRestoreLifecycle,
      marker: fixture.marker,
      rustOutcome: fixture.rustOutcome,
      fixtureSemantic: fixtureSemantic(),
    }),
  );
  const firstVerifyFalse = structuredClone(fixture.runs);
  firstVerifyFalse[0].outcomeSummaryJson.report.rebuildRequired = false;
  assert.throws(
    () =>
      assertC2ZcRestoreLifecycleOrder(firstVerifyFalse, {
        currentEpochId: "e1",
        restoreEpochId: "e1",
        expectedRestoreLifecycle: fixture.expectedRestoreLifecycle,
        marker: fixture.marker,
        rustOutcome: fixture.rustOutcome,
        fixtureSemantic: fixtureSemantic(),
      }),
    /rebuild|required|first Verify/i,
  );
  const dependencyRepair = structuredClone(fixture.runs);
  dependencyRepair.splice(1, 0, {
    ...dependencyRepair[1],
    id: "repair-1",
    runKind: "dependency-repair",
  });
  assert.throws(
    () =>
      assertC2ZcRestoreLifecycleOrder(dependencyRepair, {
        currentEpochId: "e1",
        restoreEpochId: "e1",
        expectedRestoreLifecycle: fixture.expectedRestoreLifecycle,
        marker: fixture.marker,
        rustOutcome: fixture.rustOutcome,
        fixtureSemantic: fixtureSemantic(),
      }),
    /dependency-repair|repair/i,
  );
  const nonCanonicalTimestamp = structuredClone(fixture.runs);
  nonCanonicalTimestamp[0].createdAt = "2026-08-29T00:00:10Z";
  assert.throws(
    () =>
      assertC2ZcRestoreLifecycleOrder(nonCanonicalTimestamp, {
        currentEpochId: "e1",
        restoreEpochId: "e1",
        expectedRestoreLifecycle: fixture.expectedRestoreLifecycle,
        marker: fixture.marker,
        rustOutcome: fixture.rustOutcome,
        fixtureSemantic: fixtureSemantic(),
      }),
    /timestamp|canonical|createdAt/i,
  );
  assert.throws(
    () =>
      assertC2ZcRestoreLifecycleOrder(fixture.runs, {
        currentEpochId: "e1",
        restoreEpochId: "e1",
        expectedRestoreLifecycle: fixture.expectedRestoreLifecycle,
        marker: {
          ...fixture.marker,
          appliedAt: fixture.runs[3].completedAt,
        },
        rustOutcome: fixture.rustOutcome,
        fixtureSemantic: fixtureSemantic(),
      }),
    /marker|after|Freshness/i,
  );
  for (const mutate of [
    (value) => {
      value.runs[0].outcomeSummaryJson.report.edgeIdsWithMissingSource = [
        "edge-e1",
      ];
    },
    (value) => {
      value.runs[2].outcomeSummaryJson.report.legacyMirrorMigrationParity = {
        completed: false,
        passed: false,
        issues: ["not-clean"],
        incomplete: [],
      };
    },
    (value) => {
      value.runs[2].outcomeSummaryJson.checkCoverage.covered[0] =
        "different-check";
    },
    (value) => {
      value.runs[0].outcomeSummaryJson.report.semanticIndexDependencySetDigest.observedCounts.metadataRows = 1;
    },
    (value) => {
      value.runs[0].outcomeSummaryJson.report.semanticIndexGenerationCorrespondence.observedCounts.v1EdgeRows = 1;
    },
    (value) => {
      value.runs[0].outcomeSummaryJson.report.consumerKeysWithoutCurrentEpochFreshness =
        [["application", "other-application"]];
    },
    (value) => {
      value.runs[0].outcomeSummaryJson.report.legacyMirrorMigrationParity.completed = true;
      value.runs[0].outcomeSummaryJson.report.legacyMirrorMigrationParity.passed = true;
    },
  ]) {
    const mutated = structuredClone(fixture);
    mutate(mutated);
    assert.throws(
      () =>
        assertC2ZcRestoreLifecycleOrder(mutated.runs, {
          currentEpochId: "e1",
          restoreEpochId: "e1",
          expectedRestoreLifecycle: mutated.expectedRestoreLifecycle,
          marker: mutated.marker,
          rustOutcome: mutated.rustOutcome,
          fixtureSemantic: fixtureSemantic(),
        }),
      /coverage|check|issue|consistent|semantic|zero|13|application|incomplete|policy/i,
    );
  }
});

test("fixture manifest is a non-vacuous Application/Legacy image with exact digests", () => {
  const manifest = fixtureManifest();
  assert.doesNotThrow(() => assertC2ZcRestoreFixtureManifest(manifest));
  for (const mutate of [
    (value) => {
      value.semantic.applicationId = "other-application";
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.edge.consumerKind = "narrative-extraction-run";
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.legacyProjection = {
        freshness: value.semantic.legacyProjection.freshness,
        dependencies: [],
      };
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.application.applicationId = "other-application";
      refreshC2ZcFixtureSemanticDigests(value.semantic);
      value.semantic.applicationDigest = `sha256:${"0".repeat(64)}`;
    },
    (value) => {
      value.semantic.derivedStateGap.legacyProjectionPresent = false;
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.project = {};
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.scene = {};
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.epoch = {};
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.backfill = {};
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.expectedRestoreGap.edgeIdsWithoutCurrentEpochState[1].id =
        value.semantic.edge.id;
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.expectedRestoreGap.edgeIdsWithoutCurrentEpochState.push({
        id: "extra-edge",
        consumerKind: "application",
        consumerKey: value.semantic.applicationId,
      });
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.expectedRestoreGap.edgeIdsWithoutCurrentEpochState.pop();
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.expectedRestoreGap.edgeIdsWithoutCurrentEpochState.reverse();
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.expectedRestoreGap.consumerKeysWithoutCurrentEpochFreshness.push(
        { consumerKind: "application", consumerKey: "extra-application" },
      );
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.expectedRestoreGap.consumerKeysWithoutCurrentEpochFreshness.pop();
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      value.semantic.expectedRestoreGap.consumerKeysWithoutCurrentEpochFreshness.reverse();
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
    (value) => {
      const backfill = value.semantic.backfill.rows[0];
      backfill.startedAt = backfill.completedAt;
      refreshC2ZcFixtureSemanticDigests(value.semantic);
    },
  ]) {
    const mutated = structuredClone(manifest);
    mutate(mutated);
    assert.throws(
      () => assertC2ZcRestoreFixtureManifest(mutated),
      /Application|Legacy|project|scene|epoch|backfill|edge|digest|derived|consumer/i,
    );
  }
});

test("project inventory is exactly one restored fixture project", () => {
  const valid = { projectInventory: [{ projectId: "project-e1" }] };
  assert.doesNotThrow(() => assertC2ZcProjectInventory(valid, "project-e1"));
  assert.throws(
    () =>
      assertC2ZcProjectInventory(
        {
          projectInventory: [...valid.projectInventory, { projectId: "other" }],
        },
        "project-e1",
      ),
    /project|inventory|exactly one/i,
  );
  assert.throws(
    () => assertC2ZcProjectInventory({ projectInventory: [] }, "project-e1"),
    /project|inventory/i,
  );
});

test("initial Verify accepts unrelated vectors but still requires the fixture targets", () => {
  const fixture = strictLifecycleRuns();
  assert.doesNotThrow(() =>
    assertC2ZcRestoreLifecycleOrder(fixture.runs, {
      currentEpochId: "e1",
      restoreEpochId: "e1",
      expectedRestoreLifecycle: fixture.expectedRestoreLifecycle,
      marker: fixture.marker,
      rustOutcome: fixture.rustOutcome,
      fixtureSemantic: fixtureSemantic(),
    }),
  );

  const wrongEdge = structuredClone(fixture);
  wrongEdge.runs[0].outcomeSummaryJson.report.edgeIdsWithoutCurrentEpochState =
    ["unrelated-edge"];
  assert.throws(
    () =>
      assertC2ZcRestoreLifecycleOrder(wrongEdge.runs, {
        currentEpochId: "e1",
        restoreEpochId: "e1",
        expectedRestoreLifecycle: wrongEdge.expectedRestoreLifecycle,
        marker: wrongEdge.marker,
        rustOutcome: wrongEdge.rustOutcome,
        fixtureSemantic: fixtureSemantic(),
      }),
    /edge|fixture|target/i,
  );

  const missingRustOutcome = structuredClone(fixture);
  assert.throws(
    () =>
      assertC2ZcRestoreLifecycleOrder(missingRustOutcome.runs, {
        currentEpochId: "e1",
        restoreEpochId: "e1",
        expectedRestoreLifecycle: missingRustOutcome.expectedRestoreLifecycle,
        marker: missingRustOutcome.marker,
        fixtureSemantic: fixtureSemantic(),
      }),
    /Rust|outcome|13/i,
  );

  const expectedEdgeIds =
    fixtureSemantic().expectedRestoreGap.edgeIdsWithoutCurrentEpochState.map(
      (edge) => edge.id,
    );
  const expectedConsumerPairs =
    fixtureSemantic().expectedRestoreGap.consumerKeysWithoutCurrentEpochFreshness.map(
      (consumer) => [consumer.consumerKind, consumer.consumerKey],
    );
  for (const [label, mutate] of [
    [
      "duplicate edge",
      (report) => {
        report.edgeIdsWithoutCurrentEpochState = [
          expectedEdgeIds[0],
          expectedEdgeIds[0],
        ];
      },
    ],
    [
      "extra edge",
      (report) => {
        report.edgeIdsWithoutCurrentEpochState = [
          ...expectedEdgeIds,
          "extra-edge",
        ];
      },
    ],
    [
      "missing edge",
      (report) => {
        report.edgeIdsWithoutCurrentEpochState = expectedEdgeIds.slice(0, 1);
      },
    ],
    [
      "reordered edge",
      (report) => {
        report.edgeIdsWithoutCurrentEpochState = [...expectedEdgeIds].reverse();
      },
    ],
    [
      "duplicate consumer",
      (report) => {
        report.consumerKeysWithoutCurrentEpochFreshness = [
          expectedConsumerPairs[0],
          expectedConsumerPairs[0],
        ];
      },
    ],
    [
      "extra consumer",
      (report) => {
        report.consumerKeysWithoutCurrentEpochFreshness = [
          ...expectedConsumerPairs,
          ["application", "extra-application"],
        ];
      },
    ],
    [
      "missing consumer",
      (report) => {
        report.consumerKeysWithoutCurrentEpochFreshness =
          expectedConsumerPairs.slice(0, 1);
      },
    ],
    [
      "reordered consumer",
      (report) => {
        report.consumerKeysWithoutCurrentEpochFreshness = [
          ...expectedConsumerPairs,
        ].reverse();
      },
    ],
  ]) {
    const mutated = structuredClone(fixture);
    mutate(mutated.runs[0].outcomeSummaryJson.report);
    assert.throws(
      () =>
        assertC2ZcRestoreLifecycleOrder(mutated.runs, {
          currentEpochId: "e1",
          restoreEpochId: "e1",
          expectedRestoreLifecycle: mutated.expectedRestoreLifecycle,
          marker: mutated.marker,
          rustOutcome: mutated.rustOutcome,
          fixtureSemantic: fixtureSemantic(),
        }),
      /edge|consumer|gap|fixture|order|vector/i,
      label,
    );
  }
});

function settledApplicationSnapshot(
  legacyProjection = fixtureSemantic().legacyProjection,
) {
  const semantic = fixtureSemantic();
  const marker = {
    migrationId: "narrative-c2-canonical-freshness-v1",
    contractVersion: 1,
    appliedAt: "2026-08-29T00:01:00.000Z",
  };
  const genericRow = {
    projectId: semantic.projectId,
    consumerKind: "application",
    consumerKey: semantic.applicationId,
    applicationId: semantic.applicationId,
    evidenceFreshness: "fresh",
    buildAction: "none",
    semanticEpochId: "e1",
    lastEvaluatedRunId: "fresh-1",
    dependencySetDigest: `sha256:${"b".repeat(64)}`,
    updatedAt: "2026-08-29T00:00:30.000Z",
  };
  return {
    projectId: semantic.projectId,
    projectInventory: [{ projectId: semantic.projectId }],
    marker,
    markerRows: [marker],
    epochs: [
      { id: "e0", epochNumber: 0, reason: "initial" },
      { id: "e1", epochNumber: 1, reason: "restore" },
    ],
    currentEpochId: "e1",
    runs: [
      {
        id: "verify-2",
        projectId: semantic.projectId,
        runKind: "dependency-verify",
        status: "completed",
        semanticEpochId: "e1",
      },
      {
        id: "fresh-1",
        projectId: semantic.projectId,
        runKind: "freshness-evaluation",
        status: "completed",
        semanticEpochId: "e1",
      },
    ],
    genericRows: [genericRow],
    dependencyEdges: [semantic.edge],
    applications: [structuredClone(semantic.application)],
    legacyProjection,
    findingRows: [{ id: "finding-1", lifecycleState: "resolved" }],
    inboxEntries: [],
    feedCursor: {
      feedHead: 1,
      projectId: semantic.projectId,
      consumerId: "narrative-incremental-freshness/v1",
      acknowledgedThrough: 1,
      reservedThrough: null,
      activeRunId: null,
      semanticEpochId: null,
      lastError: null,
    },
    projectSettled: true,
  };
}

test("pre-marker Application evidence rejects zero Generic rows and mismatched parity", () => {
  const semantic = fixtureSemantic();
  const valid = settledApplicationSnapshot();
  assert.doesNotThrow(() =>
    assertC2ZcFixtureApplicationParity(valid, semantic, "fixture Application"),
  );
  const noGeneric = structuredClone(valid);
  noGeneric.genericRows = [];
  assert.throws(
    () => assertC2ZcFixtureApplicationParity(noGeneric, semantic),
    /Generic|consumer|Application/i,
  );
  const wrongConsumer = structuredClone(valid);
  wrongConsumer.genericRows[0].consumerKey = "wrong-application";
  assert.throws(
    () => assertC2ZcFixtureApplicationParity(wrongConsumer, semantic),
    /consumer|Application|edge/i,
  );
  const wrongLegacy = structuredClone(valid);
  wrongLegacy.legacyProjection.freshness.status = "stale";
  assert.throws(
    () => assertC2ZcFixtureApplicationParity(wrongLegacy, semantic),
    /Legacy|parity|projection/i,
  );
  const wrongEdgeOwner = structuredClone(valid);
  wrongEdgeOwner.dependencyEdges[0].owningRunId = "fresh-1";
  assert.throws(
    () => assertC2ZcFixtureApplicationParity(wrongEdgeOwner, semantic),
    /owner|Application|Edge/i,
  );
  const applicationEdgeOwner = structuredClone(valid);
  applicationEdgeOwner.dependencyEdges[0].owningRunId = semantic.applyRunId;
  assert.throws(
    () => assertC2ZcFixtureApplicationParity(applicationEdgeOwner, semantic),
    /owner|Backfill|Edge/i,
  );
  const applicationProducer = structuredClone(valid);
  applicationProducer.genericRows[0].lastEvaluatedRunId = semantic.applyRunId;
  assert.throws(
    () => assertC2ZcFixtureApplicationParity(applicationProducer, semantic),
    /producer|Freshness|Generic/i,
  );
});

test("finding acceptance ignores resolved history but rejects unresolved lifecycle rows", () => {
  const valid = {
    findingRows: [{ id: "finding-1", lifecycleState: "resolved" }],
    inboxEntries: [],
  };
  assert.doesNotThrow(() => assertC2ZcFindingRowsResolved(valid));
  assert.throws(
    () =>
      assertC2ZcFindingRowsResolved({
        ...valid,
        findingRows: [
          ...valid.findingRows,
          { id: "finding-3", lifecycleState: "open" },
        ],
      }),
    /unresolved|Finding/i,
  );
  assert.throws(
    () =>
      assertC2ZcFindingRowsResolved({
        ...valid,
        findingRows: [
          ...valid.findingRows,
          { id: "finding-closed", lifecycleState: "closed" },
        ],
      }),
    /unresolved|Finding/i,
  );
  assert.throws(
    () =>
      assertC2ZcFindingRowsResolved({
        ...valid,
        inboxEntries: [{ id: "inbox-1" }],
      }),
    /Inbox|inbox/i,
  );
});

test("post-marker typed Application requires exact producer provenance and stable authority", () => {
  const semantic = fixtureSemantic();
  const application = {
    applicationId: "typed-application",
    projectId: semantic.projectId,
    runId: "typed-run",
    entryId: "typed-entry",
  };
  const make = () => {
    const snapshot = settledApplicationSnapshot();
    snapshot.genericRows = [
      {
        ...snapshot.genericRows[0],
        consumerKey: application.applicationId,
        lastEvaluatedRunId: "typed-freshness",
      },
    ];
    snapshot.dependencyEdges = [
      {
        ...semantic.edge,
        consumerKey: application.applicationId,
        owningRunId: application.runId,
      },
    ];
    snapshot.applications = [
      {
        applicationId: application.applicationId,
        projectId: application.projectId,
      },
    ];
    snapshot.codexEntries = [
      { entryId: application.entryId, projectId: application.projectId },
    ];
    snapshot.runs.push({
      id: application.runId,
      projectId: application.projectId,
      runKind: "application",
      status: "completed",
      semanticEpochId: "e1",
    });
    snapshot.runs.push({
      id: "typed-freshness",
      projectId: application.projectId,
      runKind: "freshness-evaluation",
      status: "completed",
      semanticEpochId: "e1",
    });
    return snapshot;
  };
  const beforeMutation = make();
  const afterMutation = structuredClone(beforeMutation);
  const restart = structuredClone(afterMutation);
  assert.doesNotThrow(() =>
    assertC2ZcPostMarkerApplicationPersistence({
      beforeMutation,
      afterMutation,
      restart,
      application,
    }),
  );
  for (const mutate of [
    (value) => {
      value.afterMutation.genericRows[0].lastEvaluatedRunId = "wrong-run";
    },
    (value) => {
      value.afterMutation.legacyProjection.freshness.status = "stale";
    },
    (value) => {
      value.afterMutation.dependencyEdges[0].owningRunId = "wrong-run";
    },
    (value) => {
      value.afterMutation.genericRows[0].lastEvaluatedRunId = "typed-run";
    },
    (value) => {
      value.restart.runs.push({
        id: "repair-1",
        runKind: "dependency-repair",
        status: "completed",
        semanticEpochId: "e1",
      });
    },
    (value) => {
      value.restart.markerRows = [];
    },
  ]) {
    const mutated = {
      beforeMutation: structuredClone(beforeMutation),
      afterMutation: structuredClone(afterMutation),
      restart: structuredClone(restart),
      application,
    };
    mutate(mutated);
    assert.throws(
      () => assertC2ZcPostMarkerApplicationPersistence(mutated),
      /producer|Legacy|repair|marker|authority|Generic/i,
    );
  }
});
