import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG,
  PRODUCT_JOURNEY_CATALOG,
} from "../electron/scripts/product-journey-catalog.mjs";
import { resolveProductJourneyImpactCatalog } from "../electron/scripts/product-journey-impact.mjs";
import {
  NARRATIVE_C2ZC_PRODUCT_JOURNEYS,
  resolveProductJourneySet,
  PRODUCT_JOURNEYS,
} from "../electron/scripts/product-journeys.mjs";
import {
  assertC2ZcOpenPhaseTimeline,
  assertC2ZcPostMarkerProjectBirth,
  assertC2ZcRestoreBackupFixture,
  assertC2ZcRestoreStageIsolation,
  assertC2ZcRestartInvariants,
  C2ZC_PRODUCT_JOURNEY_PHASES,
} from "../electron/scripts/c2zc-canonical-product-journey.mjs";
import {
  NARRATIVE_FRESHNESS_DISABLE_ENV,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  withLaunchEnvironmentForTest,
} from "../electron/scripts/narrative-maintenance-product-journeys.mjs";
import { PRODUCT_JOURNEY_ELECTRON_PHASES } from "../electron/scripts/product-journey-harness.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

test("C2-ZC is registered as a distinct product journey and contract boundary", () => {
  assert.deepEqual(
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
    ["c2-zc-canonical-authority-cutover"],
  );
  assert.deepEqual(
    NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG[0].contracts,
    ["c2-zc:canonical-authority-cutover", "c2-zc:post-marker-lifecycle"],
  );
  assert.ok(
    PRODUCT_JOURNEY_CATALOG.some(
      (journey) => journey.id === "c2-zc-canonical-authority-cutover",
    ),
  );
  assert.deepEqual(
    resolveProductJourneySet("c2-zc").map((journey) => journey.id),
    ["c2-zc-canonical-authority-cutover"],
  );
  assert.deepEqual(
    resolveProductJourneyImpactCatalog("c2-zc").map((journey) => journey.id),
    ["c2-zc-canonical-authority-cutover"],
  );
  assert.deepEqual(
    PRODUCT_JOURNEYS.map((journey) => journey.id),
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.equal(NARRATIVE_C2ZC_PRODUCT_JOURNEYS.length, 1);
});

test("C2-ZC journey launch phases are registered for clean Electron diagnostics", () => {
  for (const phase of C2ZC_PRODUCT_JOURNEY_PHASES) {
    assert.ok(PRODUCT_JOURNEY_ELECTRON_PHASES.includes(phase), phase);
  }
});

test("C2-ZC runner reaches the marker only through main scheduler and N-API", async () => {
  const [runner, main, napi, harness] = await Promise.all([
    read("electron/scripts/c2zc-canonical-product-journey.mjs"),
    read("electron/main/index.ts"),
    read("electron/native/grimodex-node/src/lib.rs"),
    read("electron/scripts/product-journey-harness.mjs"),
  ]);

  assert.match(runner, /runRestoreVerifyRebuildVerifyScenario/);
  assert.match(runner, /restoreBackupThroughSettingsUi/);
  assert.match(runner, /setup:\s*"disabled"/);
  assert.match(
    runner,
    /freshness:\s*"disabled"/,
    "the restore launch must disable only the freshness scheduler before a pre-cutover restore",
  );
  assert.match(
    runner,
    /onRestore:[\s\S]*readAuthoritySnapshot\([\s\S]*marker: observed\.marker/,
    "restore isolation must inspect the persisted marker rather than hard-code null",
  );
  assert.match(runner, /harness\.launch\(`\$\{C2ZC_PRODUCT_JOURNEY_ID\}\/new-project`\)/);
  assert.match(runner, /harness\.invokeOk\(page, "project_create"/);
  assert.match(runner, /schema_data_migrations/);
  assert.match(runner, /activationOwner: "electron-main:narrativeFreshness->napi"/);
  assert.doesNotMatch(runner, /cut_over_workspace_freshness|record_c2zc_cutover_marker/);
  assert.doesNotMatch(
    runner,
    /(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+schema_data_migrations/i,
    "C2-ZC runner must not write the marker SQL directly",
  );
  assert.match(main, /createNarrativeFreshnessScheduler\(backend,\s*\{/);
  assert.match(main, /shouldDisableNarrativeFreshnessForLaunch/);
  assert.match(main, /onCutoverNotReady/);
  assert.match(main, /requestBeforeCutoverPreparation/);
  assert.match(main, /narrativeFreshness\.start\(\)/);
  assert.match(napi, /run_incremental_freshness_cycle_with_liveness_capability/);
  assert.match(napi, /record_live_scheduler_heartbeat/);
  assert.match(napi, /cut_over_workspace_freshness/);
  assert.match(napi, /NEX_C2ZC_CUTOVER_NOT_READY:/);
  assert.match(harness, /ELECTRON_DISABLE_SANDBOX/);
  assert.match(harness, /\["--no-sandbox", mainCjs\]/);
});

test("launch-time freshness disable is isolated to C2-ZC restore", async () => {
  const [runner, maintenance] = await Promise.all([
    read("electron/scripts/c2zc-canonical-product-journey.mjs"),
    read("electron/scripts/narrative-maintenance-product-journeys.mjs"),
  ]);
  const restoreEnvironment = runner.match(
    /restoreEnvironment:\s*\{[\s\S]*?\n\s*\},/,
  )?.[0];
  assert.match(
    restoreEnvironment ?? "",
    /setup:\s*"disabled"[\s\S]*freshness:\s*"disabled"/,
    "C2-ZC restore must disable freshness for its pre-cutover launch",
  );
  assert.equal(
    runner.match(/freshness:\s*"disabled"/g)?.length,
    1,
    "C2-ZC must not opt other launch phases into the freshness disable seam",
  );
  const newProjectLaunch = runner.match(
    /const launched = await harness\.launch\([\s\S]*?\n\s*try \{/,
  )?.[0];
  assert.doesNotMatch(newProjectLaunch ?? "", /freshness/);

  const c2FiveBRestore = maintenance.match(
    /async function runRestoreVerifyRebuildVerify\([\s\S]*?\n}\n\nasync function runDigestChangeJourney/,
  )?.[0];
  assert.ok(c2FiveBRestore, "C2-5B restore caller must remain inspectable");
  assert.doesNotMatch(
    c2FiveBRestore,
    /restoreEnvironment|freshness/,
    "default C2-5B restore must retain the scheduler default",
  );

  const observed = [];
  const harness = {
    async launch(phase) {
      observed.push({
        phase,
        freshness: process.env[NARRATIVE_FRESHNESS_DISABLE_ENV],
      });
      return { phase };
    },
  };
  const launch = async (phase, options = {}) =>
    withLaunchEnvironmentForTest(
      { ...options, ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
      () => harness.launch(phase),
    );

  await launch(C2ZC_PRODUCT_JOURNEY_PHASES[0]);
  await launch(C2ZC_PRODUCT_JOURNEY_PHASES[1], {
    setup: "disabled",
    freshness: "disabled",
  });
  await launch(C2ZC_PRODUCT_JOURNEY_PHASES[2]);
  await launch(C2ZC_PRODUCT_JOURNEY_PHASES[3]);
  await launch(C2ZC_PRODUCT_JOURNEY_PHASES[4]);
  await launch("c2-5b-restore-verify-rebuild-verify/restore");

  assert.deepEqual(observed, [
    {
      phase: C2ZC_PRODUCT_JOURNEY_PHASES[0],
      freshness: undefined,
    },
    {
      phase: C2ZC_PRODUCT_JOURNEY_PHASES[1],
      freshness: "disabled",
    },
    {
      phase: C2ZC_PRODUCT_JOURNEY_PHASES[2],
      freshness: undefined,
    },
    {
      phase: C2ZC_PRODUCT_JOURNEY_PHASES[3],
      freshness: undefined,
    },
    {
      phase: C2ZC_PRODUCT_JOURNEY_PHASES[4],
      freshness: undefined,
    },
    {
      phase: "c2-5b-restore-verify-rebuild-verify/restore",
      freshness: undefined,
    },
  ]);
});

test("C2-ZC evidence packet maps failure, swap/stale, restore/import, and birth tests", async () => {
  const [cutover, liveness, importCommit, backupRestore, domainWrites] =
    await Promise.all([
      read("src-tauri/crates/grimodex-db/tests/narrative_c2zc_canonical_cutover.rs"),
      read("src-tauri/crates/grimodex-db/tests/narrative_c2zc_liveness_binding.rs"),
      read("src-tauri/crates/grimodex-db/tests/import_session_commit.rs"),
      read("src-tauri/crates/grimodex-db/src/backup_restore.rs"),
      read("src-tauri/crates/grimodex-db/src/domain_writes.rs"),
    ]);

  for (const testName of [
    "cutover_refuses_incomplete_workspace_before_any_authority_marker",
    "cutover_rejects_evaluated_freshness_without_a_publisher_run",
    "canonical_read_rejects_non_incremental_or_stale_evaluation_run_reference",
    "canonical_read_has_no_legacy_fallback_after_generic_cutover",
  ]) {
    assert.match(cutover, new RegExp(`fn ${testName}`), testName);
  }
  for (const testName of [
    "completed_cycle_capability_cannot_cross_database_authority",
    "completed_cycle_capability_expires_before_a_late_heartbeat",
    "authority_generation_replacement_rejects_the_previous_receipt",
  ]) {
    assert.match(liveness, new RegExp(`fn ${testName}`), testName);
  }
  assert.match(importCommit, /post_marker_import_binds_one_initial_epoch/);
  assert.match(backupRestore, /ensure_restore_c2zc_authority_not_downgraded/);
  assert.match(domainWrites, /project_create_mints_one_event_bound_initial_epoch_after_c2zc_marker/);
});

test("C2-ZC journey is named in the quality impact manifest", async () => {
  const manifest = await read("evals/impact-map.yaml");
  assert.match(
    manifest,
    /C2-ZC canonical-authority candidate journey and final acceptance gates/,
  );
  assert.match(manifest, /electron\/scripts\/c2zc-canonical-product-journey\.mjs/);
  assert.match(manifest, /scripts\/c2zc-product-journeys\.test\.mjs/);
});

function c2zcFixture() {
  const e0 = {
    id: "epoch-e0",
    epochNumber: 0,
    reason: "initial",
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  const b0 = {
    id: "run-b0",
    projectId: "project-1",
    runKind: "backfill",
    workKey: "legacy-dependency-backfill:v3",
    semanticEpochId: e0.id,
    status: "completed",
    taskId: "task-b0",
    taskKind: "maintenance-backfill",
    taskStatus: "completed",
    taskCount: 1,
    attemptCount: 1,
    taskAttemptCount: 1,
    attemptId: "attempt-b0",
    attemptNumber: 1,
    lastAttemptNumber: 1,
    maxAttemptNumber: 1,
    lastAttemptStatus: "completed",
    createdAt: "2026-08-28T00:00:01.000Z",
    startedAt: "2026-08-28T00:00:01.100Z",
    taskCreatedAt: "2026-08-28T00:00:01.100Z",
    taskStartedAt: "2026-08-28T00:00:01.200Z",
    lastAttemptStartedAt: "2026-08-28T00:00:01.200Z",
    completedAt: "2026-08-28T00:00:02.000Z",
    taskCompletedAt: "2026-08-28T00:00:02.000Z",
    lastAttemptCompletedAt: "2026-08-28T00:00:02.000Z",
  };
  return {
    marker: null,
    epochs: [e0],
    backfill: b0,
    edge: {
      id: "edge-b0",
      projectId: "project-1",
      consumerKind: "narrative-extraction-run",
      consumerKey: b0.id,
      sourceObjectIdentity: "project:scene:scene-b0",
      readSetJson: JSON.stringify(["v1@2026-08-28T00:00:00.000Z"]),
      generatedByTransactionId: null,
      createdAt: "2026-08-28T00:00:00.500Z",
      owningRunId: b0.id,
      readSetToken: "v1@2026-08-28T00:00:00.000Z",
    },
    derivedState: {
      edgeCount: 1,
      edgeStateCount: 0,
      freshnessCount: 0,
    },
    setup: "disabled",
  };
}

function c2zcPhase(id, runKind, epochId, createdAt, completedAt) {
  return {
    id,
    projectId: "project-1",
    runKind,
    workKey: `${runKind}:${epochId}`,
    semanticEpochId: epochId,
    status: "completed",
    createdAt,
    completedAt,
  };
}

test("C2-ZC backup fixture contract proves pre-cutover E0/B0 and a derived gap", () => {
  const fixture = c2zcFixture();
  assert.doesNotThrow(() => assertC2ZcRestoreBackupFixture(fixture));
  assert.throws(
    () =>
      assertC2ZcRestoreBackupFixture({
        ...fixture,
        marker: {
          migrationId: "narrative-c2-canonical-freshness-v1",
          contractVersion: 1,
          appliedAt: "2026-08-28T00:00:03.000Z",
        },
      }),
    /pre-cutover backup must not contain the C2-ZC marker/,
  );
  assert.throws(
    () =>
      assertC2ZcRestoreBackupFixture({
        ...fixture,
        backfill: { ...fixture.backfill, taskCount: 2 },
      }),
    /exactly one closed Task and Attempt/,
  );
  assert.throws(
    () =>
      assertC2ZcRestoreBackupFixture({
        ...fixture,
        derivedState: { ...fixture.derivedState, edgeStateCount: 1 },
      }),
    /derived-state gap/,
  );
});

test("C2-ZC restore stage is isolated from maintenance and mints exactly E1", () => {
  const fixture = c2zcFixture();
  const e1 = {
    id: "epoch-e1",
    epochNumber: 1,
    reason: "restore",
    createdAt: "2026-08-28T00:00:10.000Z",
  };
  assert.doesNotThrow(() =>
    assertC2ZcRestoreStageIsolation({
      setup: "disabled",
      marker: null,
      beforeEpochs: fixture.epochs,
      afterEpochs: [...fixture.epochs, e1],
      beforeRuns: [fixture.backfill],
      afterRuns: [fixture.backfill],
    }),
  );
  assert.throws(
    () =>
      assertC2ZcRestoreStageIsolation({
        setup: "disabled",
        marker: {
          migrationId: "narrative-c2-canonical-freshness-v1",
          contractVersion: 1,
          appliedAt: "2026-08-28T00:00:09.000Z",
        },
        beforeEpochs: fixture.epochs,
        afterEpochs: [...fixture.epochs, e1],
        beforeRuns: [fixture.backfill],
        afterRuns: [fixture.backfill],
      }),
    /must not apply the C2-ZC marker/,
  );
  assert.throws(
    () =>
      assertC2ZcRestoreStageIsolation({
        setup: "disabled",
        marker: null,
        beforeEpochs: fixture.epochs,
        afterEpochs: [...fixture.epochs, e1],
        beforeRuns: [fixture.backfill],
        afterRuns: [
          fixture.backfill,
          c2zcPhase(
            "verify-before-open",
            "dependency-verify",
            e1.id,
            "2026-08-28T00:00:11.000Z",
            "2026-08-28T00:00:12.000Z",
          ),
        ],
      }),
    /must not run maintenance phases/,
  );
});

test("C2-ZC open proves exact E1 Verify/Rebuild/confirmation and late marker", () => {
  const fixture = c2zcFixture();
  const e1 = {
    id: "epoch-e1",
    epochNumber: 1,
    reason: "restore",
    createdAt: "2026-08-28T00:00:10.000Z",
  };
  const phaseRuns = [
    c2zcPhase(
      "verify-e1",
      "dependency-verify",
      e1.id,
      "2026-08-28T00:00:11.000Z",
      "2026-08-28T00:00:12.000Z",
    ),
    c2zcPhase(
      "rebuild-e1",
      "semantic-index-rebuild",
      e1.id,
      "2026-08-28T00:00:13.000Z",
      "2026-08-28T00:00:14.000Z",
    ),
    c2zcPhase(
      "confirm-e1",
      "dependency-verify",
      e1.id,
      "2026-08-28T00:00:15.000Z",
      "2026-08-28T00:00:16.000Z",
    ),
  ];
  const marker = {
    migrationId: "narrative-c2-canonical-freshness-v1",
    contractVersion: 1,
    appliedAt: "2026-08-28T00:00:17.000Z",
  };
  assert.doesNotThrow(() =>
    assertC2ZcOpenPhaseTimeline({
      markerBefore: null,
      markerAfter: marker,
      beforeEpochs: [...fixture.epochs, e1],
      afterEpochs: [...fixture.epochs, e1],
      beforeRuns: [fixture.backfill],
      afterRuns: [fixture.backfill, ...phaseRuns],
      phaseRuns,
      restoreEpochId: e1.id,
    }),
  );
  assert.throws(
    () =>
      assertC2ZcOpenPhaseTimeline({
        markerBefore: null,
        markerAfter: { ...marker, appliedAt: phaseRuns[2].completedAt },
        beforeEpochs: [...fixture.epochs, e1],
        afterEpochs: [...fixture.epochs, e1],
        beforeRuns: [fixture.backfill],
        afterRuns: [fixture.backfill, ...phaseRuns],
        phaseRuns,
        restoreEpochId: e1.id,
      }),
    /after confirmation Verify completedAt/,
  );
  assert.throws(
    () =>
      assertC2ZcOpenPhaseTimeline({
        markerBefore: null,
        markerAfter: marker,
        beforeEpochs: [...fixture.epochs, e1],
        afterEpochs: [...fixture.epochs, e1],
        beforeRuns: [fixture.backfill],
        afterRuns: [
          fixture.backfill,
          ...phaseRuns,
          { ...fixture.backfill, id: "backfill-e1", semanticEpochId: e1.id },
        ],
        phaseRuns,
        restoreEpochId: e1.id,
      }),
    /must not mint an E1 Backfill/,
  );
});

test("C2-ZC restart preserves marker, E0/E1, and phase Run identity", () => {
  const fixture = c2zcFixture();
  const e1 = {
    id: "epoch-e1",
    epochNumber: 1,
    reason: "restore",
    createdAt: "2026-08-28T00:00:10.000Z",
  };
  const marker = {
    migrationId: "narrative-c2-canonical-freshness-v1",
    contractVersion: 1,
    appliedAt: "2026-08-28T00:00:17.000Z",
  };
  const phaseRuns = [
    c2zcPhase("verify-e1", "dependency-verify", e1.id, "2026-08-28T00:00:11.000Z", "2026-08-28T00:00:12.000Z"),
    c2zcPhase("rebuild-e1", "semantic-index-rebuild", e1.id, "2026-08-28T00:00:13.000Z", "2026-08-28T00:00:14.000Z"),
    c2zcPhase("confirm-e1", "dependency-verify", e1.id, "2026-08-28T00:00:15.000Z", "2026-08-28T00:00:16.000Z"),
  ];
  assert.doesNotThrow(() =>
    assertC2ZcRestartInvariants({
      open: {
        marker,
        epochs: [...fixture.epochs, e1],
        runs: [fixture.backfill, ...phaseRuns],
      },
      restart: {
        marker: { ...marker },
        epochs: [...fixture.epochs, e1],
        runs: [fixture.backfill, ...phaseRuns],
      },
      phaseRunIds: phaseRuns.map((run) => run.id),
    }),
  );
  assert.throws(
    () =>
      assertC2ZcRestartInvariants({
        open: {
          marker,
          epochs: [...fixture.epochs, e1],
          runs: [fixture.backfill, ...phaseRuns],
        },
        restart: {
          marker: { ...marker, appliedAt: "2026-08-28T00:00:18.000Z" },
          epochs: [...fixture.epochs, e1],
          runs: [fixture.backfill, ...phaseRuns],
        },
        phaseRunIds: phaseRuns.map((run) => run.id),
      }),
    /changed marker appliedAt/,
  );
});

test("C2-ZC post-marker project birth is exactly one initial epoch", () => {
  assert.doesNotThrow(() =>
    assertC2ZcPostMarkerProjectBirth({
      marker: {
        migrationId: "narrative-c2-canonical-freshness-v1",
        contractVersion: 1,
        appliedAt: "2026-08-28T00:00:17.000Z",
      },
      epochs: [
        {
          id: "new-e0",
          epochNumber: 0,
          reason: "initial",
          createdAt: "2026-08-28T00:00:20.000Z",
        },
      ],
    }),
  );
  assert.throws(
    () =>
      assertC2ZcPostMarkerProjectBirth({
        marker: null,
        epochs: [
          { id: "new-e0", epochNumber: 0, reason: "initial" },
          { id: "new-e1", epochNumber: 1, reason: "restore" },
        ],
      }),
    /exactly one initial epoch/,
  );
});

test("C2-ZC runner uses the shared restore scenario and explicit phase separation", async () => {
  const [runner, maintenance, harness] = await Promise.all([
    read("electron/scripts/c2zc-canonical-product-journey.mjs"),
    read("electron/scripts/narrative-maintenance-product-journeys.mjs"),
    read("electron/scripts/product-journey-harness.mjs"),
  ]);
  assert.match(runner, /runRestoreVerifyRebuildVerifyScenario/);
  assert.match(runner, /restoreBackupThroughSettingsUi/);
  assert.match(runner, /setup:\s*"disabled"/);
  assert.match(runner, /dependency-verify[\s\S]*semantic-index-rebuild[\s\S]*dependency-verify/);
  assert.match(runner, /appliedAt[\s\S]*completedAt/);
  assert.match(runner, /createProjectAfterCutover/);
  assert.match(maintenance, /runRestoreVerifyRebuildVerifyScenario/);
  assert.match(maintenance, /runRestoreVerifyRebuildVerifyScenario\([\s\S]*id/);
  assert.deepEqual(
    C2ZC_PRODUCT_JOURNEY_PHASES,
    [
      "c2-zc-canonical-authority-cutover/restore-fixture",
      "c2-zc-canonical-authority-cutover/restore",
      "c2-zc-canonical-authority-cutover/open",
      "c2-zc-canonical-authority-cutover/restart",
      "c2-zc-canonical-authority-cutover/new-project",
    ],
  );
  for (const phase of C2ZC_PRODUCT_JOURNEY_PHASES) {
    assert.ok(PRODUCT_JOURNEY_ELECTRON_PHASES.includes(phase), phase);
  }
  assert.match(harness, /PRODUCT_JOURNEY_ELECTRON_PHASES/);
});
