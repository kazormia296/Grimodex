import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  C2ZC_CANONICAL_FRESHNESS_CONTRACT,
  C2ZC_SEMANTIC_INDEX_ZERO_COUNTS,
  C2ZC_VERIFY_CHECK_NAMES,
  assertC2ZcCanonicalFreshnessEvidence,
  assertC2ZcFixtureOperationReceipt,
  assertC2ZcFindingInboxEmpty,
  assertC2ZcGenericRowsComplete,
  assertC2ZcLegacyProjectionStable,
  assertC2ZcMarkerExactlyOnce,
  assertC2ZcPostMarkerProjectSettled,
  assertC2ZcPostMarkerRestartInvariants,
  assertC2ZcCausalHoldEvidence,
  assertC2ZcSecondaryMaintenanceReadiness,
  assertC2ZcNonIdleFreshnessProducer,
  assertC2ZcTwoProjectConvergenceGate,
  assertC2ZcSemanticIndexZero,
  assertC2ZcVerifyCoverage,
  assertC2ZcOpenPhaseTimeline,
  assertC2ZcOpenTotalOrder,
  assertC2ZcPostMarkerProjectBirth,
  readC2ZcRunLedger,
  assertC2ZcRestoreBackupFixture,
  assertC2ZcRestoreStageIsolation,
  assertC2ZcRestartInvariants,
  C2ZC_PRODUCT_JOURNEY_PHASES,
  createProjectAfterCutover,
} from "../electron/scripts/c2zc-canonical-product-journey.mjs";
import {
  NARRATIVE_FRESHNESS_DISABLE_ENV,
  NARRATIVE_MAINTENANCE_FAULT_ENV,
  NARRATIVE_MAINTENANCE_FRESHNESS_HOLD_PROJECT_ENV,
  NARRATIVE_MAINTENANCE_NONCE_ENV,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN,
  NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_BARRIER_ENV,
  NARRATIVE_MAINTENANCE_PRODUCT_JOURNEY_CORRELATION_ENV,
  NARRATIVE_MAINTENANCE_SETUP_ENV,
  NARRATIVE_MAINTENANCE_TRIGGER_ENV,
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
    ["c2-zc-canonical-authority-cutover", "c2-zc-renderer-mcp-dml-denial"],
  );
  assert.deepEqual(NARRATIVE_C2ZC_PRODUCT_JOURNEY_CATALOG[0].contracts, [
    "c2-zc:canonical-authority-cutover",
    "c2-zc:post-marker-lifecycle",
  ]);
  assert.ok(
    PRODUCT_JOURNEY_CATALOG.some(
      (journey) => journey.id === "c2-zc-canonical-authority-cutover",
    ),
  );
  assert.deepEqual(
    resolveProductJourneySet("c2-zc").map((journey) => journey.id),
    ["c2-zc-canonical-authority-cutover", "c2-zc-renderer-mcp-dml-denial"],
  );
  assert.deepEqual(
    resolveProductJourneyImpactCatalog("c2-zc").map((journey) => journey.id),
    ["c2-zc-canonical-authority-cutover", "c2-zc-renderer-mcp-dml-denial"],
  );
  assert.deepEqual(
    PRODUCT_JOURNEYS.map((journey) => journey.id),
    PRODUCT_JOURNEY_CATALOG.map((journey) => journey.id),
  );
  assert.equal(NARRATIVE_C2ZC_PRODUCT_JOURNEYS.length, 2);
});

test("C2-ZC journey launch phases are registered for clean Electron diagnostics", () => {
  assert.deepEqual(
    PRODUCT_JOURNEY_ELECTRON_PHASES.filter((phase) =>
      phase.startsWith(`${C2ZC_PRODUCT_JOURNEY_PHASES[0].split("/")[0]}/`),
    ),
    C2ZC_PRODUCT_JOURNEY_PHASES,
  );
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
  assert.match(
    runner,
    /const postMarkerPhase = `\$\{C2ZC_PRODUCT_JOURNEY_ID\}\/new-project`[\s\S]*harness\.launch\(postMarkerPhase\)/,
  );
  assert.match(runner, /harness\.invokeOk\(page, "project_create"/);
  assert.match(runner, /schema_data_migrations/);
  assert.doesNotMatch(
    runner,
    /activationOwner:\s*"electron-main:narrativeFreshness->napi"/,
    "runtime journey records must not treat a hard-coded activation owner as causal evidence",
  );
  assert.match(
    runner,
    /C2ZC_CANONICAL_FRESHNESS_CONTRACT|canonical_application_freshness/,
    "the journey must record the bounded canonical Rust contract instead of an invented runtime owner",
  );
  assert.doesNotMatch(
    runner,
    /cut_over_workspace_freshness|record_c2zc_cutover_marker/,
  );
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
  assert.match(
    napi,
    /run_incremental_freshness_cycle_with_liveness_capability/,
  );
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
  const previousCi = process.env.CI;
  process.env.CI = "true";
  try {
    await launch(C2ZC_PRODUCT_JOURNEY_PHASES[0]);
    await launch(C2ZC_PRODUCT_JOURNEY_PHASES[1], {
      setup: "disabled",
      freshness: "disabled",
    });
    await launch(C2ZC_PRODUCT_JOURNEY_PHASES[2]);
    await launch(C2ZC_PRODUCT_JOURNEY_PHASES[3]);
    await launch(C2ZC_PRODUCT_JOURNEY_PHASES[4]);
    await launch(C2ZC_PRODUCT_JOURNEY_PHASES[5]);
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
        phase: C2ZC_PRODUCT_JOURNEY_PHASES[5],
        freshness: undefined,
      },
      {
        phase: "c2-5b-restore-verify-rebuild-verify/restore",
        freshness: undefined,
      },
    ]);
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
});

test("seam launch transaction fails before callback unless CI is exactly true", async () => {
  const previousCi = process.env.CI;
  const previousOwner = process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
  let callbackCalled = false;
  process.env.CI = "false";
  process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = "stale-owner";
  try {
    await assert.rejects(
      withLaunchEnvironmentForTest(
        { ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN },
        () => {
          callbackCalled = true;
        },
      ),
      /CI.*true/i,
    );
    assert.equal(callbackCalled, false);
    assert.equal(
      process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV],
      "stale-owner",
    );
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousOwner === undefined) {
      delete process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV];
    } else {
      process.env[NARRATIVE_MAINTENANCE_OWNER_TOKEN_ENV] = previousOwner;
    }
  }
});

test("empty production launch transaction masks inherited seam variables and restores them", async () => {
  const seamEnvironmentNames = [
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
  const previousCi = process.env.CI;
  const previousValues = new Map(
    seamEnvironmentNames.map((name) => [name, process.env[name]]),
  );
  process.env.CI = "true";
  for (const name of seamEnvironmentNames) process.env[name] = `stale-${name}`;
  try {
    await withLaunchEnvironmentForTest({}, () => {
      for (const name of seamEnvironmentNames) {
        assert.equal(
          process.env[name],
          undefined,
          `production launch inherited ${name}`,
        );
      }
    });
    for (const name of seamEnvironmentNames) {
      assert.equal(process.env[name], `stale-${name}`);
    }
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    for (const name of seamEnvironmentNames) {
      const previous = previousValues.get(name);
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});

test("direct C2-ZC new-project launch sees restored freshness", async () => {
  const previousCi = process.env.CI;
  const previousFreshness = process.env[NARRATIVE_FRESHNESS_DISABLE_ENV];
  process.env.CI = "true";
  delete process.env[NARRATIVE_FRESHNESS_DISABLE_ENV];
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
  try {
    await withLaunchEnvironmentForTest(
      {
        setup: "disabled",
        freshness: "disabled",
        ownerToken: NARRATIVE_MAINTENANCE_OWNER_TOKEN,
      },
      () => harness.launch(C2ZC_PRODUCT_JOURNEY_PHASES[1]),
    );
    await harness.launch(C2ZC_PRODUCT_JOURNEY_PHASES[5]);
    assert.deepEqual(observed, [
      {
        phase: C2ZC_PRODUCT_JOURNEY_PHASES[1],
        freshness: "disabled",
      },
      {
        phase: C2ZC_PRODUCT_JOURNEY_PHASES[5],
        freshness: undefined,
      },
    ]);
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    if (previousFreshness === undefined) {
      delete process.env[NARRATIVE_FRESHNESS_DISABLE_ENV];
    } else {
      process.env[NARRATIVE_FRESHNESS_DISABLE_ENV] = previousFreshness;
    }
  }
});

test("C2-ZC Electron evidence is scoped and shared-Rust receipts compose separately", async () => {
  const [runner, mainSeam, nativeSeam, harness] = await Promise.all([
    read("electron/scripts/c2zc-canonical-product-journey.mjs"),
    read("electron/main/narrativeMaintenanceCiSeam.ts"),
    read("electron/native/grimodex-node/src/narrative_maintenance.rs"),
    read("electron/scripts/product-journey-harness.mjs"),
  ]);
  assert.match(runner, /electronEvidenceScope/);
  assert.match(runner, /rustReceiptComposition/);
  assert.match(runner, /composed later by the shared Rust receipt/);
  assert.doesNotMatch(runner, /rustComponentTests/);
  assert.match(runner, /readAuthoritySnapshot/);
  assert.match(runner, /assertC2ZcGenericFreshnessStorage/);
  assert.match(mainSeam, /writeNarrativeMaintenanceCiQuiescence/);
  assert.match(nativeSeam, /run_incremental_freshness_cycle/);
  assert.match(harness, /main-maintenance-receipt/);
});

test("C2-ZC journey is named in the quality impact manifest", async () => {
  const manifest = await read("evals/impact-map.yaml");
  assert.match(
    manifest,
    /C2-ZC canonical-authority candidate journey and final acceptance gates/,
  );
  assert.match(
    manifest,
    /electron\/scripts\/c2zc-canonical-product-journey\.mjs/,
  );
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
  const edge = {
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
  };
  const edgeInsert = {
    kind: "dependency-edge-insert",
    id: edge.id,
    projectId: edge.projectId,
    consumerKind: edge.consumerKind,
    consumerKey: edge.consumerKey,
    sourceObjectIdentity: edge.sourceObjectIdentity,
    readSetJson: edge.readSetJson,
    generatedByTransactionId: null,
    createdAt: edge.createdAt,
    owningRunId: edge.owningRunId,
  };
  const gapDelete = {
    kind: "dependency-derived-state-gap-delete",
    projectId: edge.projectId,
    edgeId: edge.id,
    consumerKind: edge.consumerKind,
    consumerKey: edge.consumerKey,
  };
  const operationReceipt = (operation, beforeCounts, afterCounts) => ({
    operationCount: 1,
    operationDigest: sha256Canonical([operation]),
    operations: [
      {
        operation,
        kind: operation.kind,
        operationDigest: sha256Canonical(operation),
        beforeCounts,
        afterCounts,
      },
    ],
    beforeCounts: [beforeCounts],
    afterCounts: [afterCounts],
  });
  return {
    marker: null,
    epochs: [e0],
    backfill: b0,
    edge,
    fixtureOperations: {
      edgeInsert: operationReceipt(edgeInsert, { rows: 0 }, { rows: 1 }),
      gapDelete: operationReceipt(
        gapDelete,
        { edgeStateRows: 1, freshnessRows: 1 },
        { edgeStateRows: 0, freshnessRows: 0 },
      ),
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

function c2zcIdleCheckpoint(id, epochId, createdAt, completedAt) {
  const inputPayload = {
    kind: "current-epoch-idle-checkpoint",
    version: 1,
    projectId: "project-1",
    semanticEpochId: epochId,
    fromSequenceExclusive: 1,
    throughSequenceInclusive: 1,
    feedHead: 1,
  };
  const inputDigest = sha256Canonical(inputPayload);
  const taskInput = { ...inputPayload, inputDigest };
  const outcome = {
    kind: "current-epoch-idle-checkpoint",
    version: 1,
    projectId: "project-1",
    runId: id,
    fromSequenceExclusive: 1,
    throughSequenceInclusive: 1,
    affectedEdgeCount: 0,
    affectedConsumerCount: 0,
    hasMore: false,
  };
  const outputJson = JSON.stringify(outcome);
  const spec = {
    kind: "incremental-freshness-idle-checkpoint@1",
    inputDigest,
  };
  const taskId = `${id}-task`;
  const attemptId = `${id}-attempt-1`;
  const attempt = {
    id: attemptId,
    taskId,
    attemptNumber: 1,
    status: "completed",
    startedAt: createdAt,
    completedAt,
    failureCode: null,
    retryDisposition: null,
    policyVersion: null,
    nextAttemptAt: null,
    outputJson,
  };
  return {
    id,
    projectId: "project-1",
    runKind: "freshness-evaluation",
    workKey: `incremental-freshness:${epochId}:1:1:${inputDigest.slice("sha256:".length)}`,
    semanticEpochId: epochId,
    status: "completed",
    createdAt,
    startedAt: createdAt,
    completedAt,
    consumerId: "narrative-incremental-freshness/v1",
    specJson: JSON.stringify(spec),
    specDigest: sha256Canonical(spec),
    outcomeSummaryJson: outputJson,
    taskKind: "incremental-freshness-batch",
    taskStatus: "completed",
    taskCount: 1,
    attemptCount: 1,
    taskAttemptCount: 1,
    lastAttemptStatus: "completed",
    lastAttemptNumber: 1,
    maxAttemptNumber: 1,
    taskInputJson: JSON.stringify(taskInput),
    taskCreatedAt: createdAt,
    taskStartedAt: createdAt,
    taskCompletedAt: completedAt,
    lastAttemptStartedAt: createdAt,
    lastAttemptCompletedAt: completedAt,
    tasks: [
      {
        id: taskId,
        runId: id,
        taskKind: "incremental-freshness-batch",
        status: "completed",
        attemptCount: 1,
        outputJson,
        createdAt,
        startedAt: createdAt,
        completedAt,
        attempts: [attempt],
      },
    ],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function idleRunWithAttempts(baseRun, attempts) {
  const run = clone(baseRun);
  const task = run.tasks[0];
  task.attemptCount = attempts.length;
  task.attempts = clone(attempts).map((attempt) => ({
    ...attempt,
    outputJson:
      attempt.outputJson ??
      (attempt.status === "failed" ? null : run.outcomeSummaryJson),
  }));
  run.attemptCount = attempts.length;
  run.taskAttemptCount = attempts.length;
  run.lastAttemptNumber = attempts.at(-1).attemptNumber;
  run.maxAttemptNumber = Math.max(
    ...attempts.map((attempt) => attempt.attemptNumber),
  );
  run.lastAttemptStatus = attempts.at(-1).status;
  run.lastAttemptStartedAt = attempts.at(-1).startedAt;
  run.lastAttemptCompletedAt = attempts.at(-1).completedAt;
  run.taskCompletedAt = task.completedAt;
  return run;
}

function c2zcOpenContractFixture() {
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
  const idleRun = c2zcIdleCheckpoint(
    "idle-e1",
    e1.id,
    "2026-08-28T00:00:16.100Z",
    "2026-08-28T00:00:16.200Z",
  );
  return {
    markerBefore: null,
    markerAfter: {
      migrationId: "narrative-c2-canonical-freshness-v1",
      contractVersion: 1,
      appliedAt: "2026-08-28T00:00:17.000Z",
    },
    beforeEpochs: [...fixture.epochs, e1],
    afterEpochs: [...fixture.epochs, e1],
    beforeRuns: [fixture.backfill],
    afterRuns: [fixture.backfill, ...phaseRuns, idleRun],
    phaseRuns,
    idleRun,
    restoreEpochId: e1.id,
  };
}

function c2zcVerifyOutcome() {
  const emptyCheck = () => ({
    completed: true,
    passed: true,
    issues: [],
    incomplete: [],
  });
  const semanticCheck = () => ({
    ...emptyCheck(),
    observedCounts: { ...C2ZC_SEMANTIC_INDEX_ZERO_COUNTS },
  });
  const report = {
    totalEdges: 1,
    edgeIdsWithMissingSource: [],
    duplicateEdgeKeys: [],
    edgeIdsWithCrossProjectConsumer: [],
    edgeIdsWithMalformedKeys: [],
    edgeStateIdsOutsideCurrentEpoch: [],
    edgeIdsWithoutCurrentEpochState: [],
    findingObservationIdsOutsideCurrentEpoch: [],
    consumerKeysWithoutCurrentEpochFreshness: [],
    duplicateEdgeIdsToDeactivate: [],
    edgeIdsWithUnresolvableConsumerScope: [],
    consumerKeysWithStaleDependencySetDigest: [],
    consumerKeysWithUncomputedDependencySetDigest: [],
    orphanedAttentionFindingKeys: [],
    orphanedAttentionRehomeAmbiguities: [],
    applicationRevisionArtifactReferences: emptyCheck(),
    semanticIndexDependencySetDigest: semanticCheck(),
    contributionToApplicationCommitCorrespondence: emptyCheck(),
    legacyMirrorMigrationParity: emptyCheck(),
    cursorAndFeedHeadConsistency: emptyCheck(),
    semanticIndexGenerationCorrespondence: semanticCheck(),
    rebuildRequired: false,
  };
  return {
    verifyContractVersion: "9",
    semanticEpochId: "epoch-e1",
    report,
    checkCoverage: {
      complete: true,
      required: [...C2ZC_VERIFY_CHECK_NAMES],
      covered: [...C2ZC_VERIFY_CHECK_NAMES],
      missing: [],
    },
  };
}

test("C2-ZC Verify acceptance requires the exact production 13-check coverage", () => {
  const outcome = c2zcVerifyOutcome();
  assert.doesNotThrow(() =>
    assertC2ZcVerifyCoverage({
      status: "completed",
      outcomeSummaryJson: JSON.stringify(outcome),
    }),
  );
  assert.equal(C2ZC_VERIFY_CHECK_NAMES.length, 13);
  for (const [label, mutate] of [
    ["missing check", (value) => value.checkCoverage.required.pop()],
    [
      "covered drift",
      (value) => (value.checkCoverage.covered[0] = "fixture-only"),
    ],
    [
      "missing evidence",
      (value) => value.checkCoverage.missing.push("missing"),
    ],
    [
      "incomplete typed check",
      (value) => {
        value.report.cursorAndFeedHeadConsistency.completed = false;
      },
    ],
    [
      "failed typed check",
      (value) => {
        value.report.cursorAndFeedHeadConsistency.passed = false;
      },
    ],
  ]) {
    const broken = clone(outcome);
    mutate(broken);
    assert.throws(
      () => assertC2ZcVerifyCoverage({ outcomeSummaryJson: broken }),
      /13-check|coverage|complete|passed|missing|canonical/,
      label,
    );
  }
});

test("C2-ZC Verify acceptance proves every reserved Semantic Index surface is zero", () => {
  const outcome = c2zcVerifyOutcome();
  assert.doesNotThrow(() => assertC2ZcSemanticIndexZero(outcome));
  for (const [label, mutate] of [
    [
      "metadata rows",
      (value) => {
        value.report.semanticIndexDependencySetDigest.observedCounts.metadataRows = 1;
      },
    ],
    [
      "missing surface",
      (value) => {
        delete value.report.semanticIndexGenerationCorrespondence.observedCounts
          .v1EdgeRows;
      },
    ],
    [
      "extra surface",
      (value) => {
        value.report.semanticIndexDependencySetDigest.observedCounts.extraRows = 0;
      },
    ],
    [
      "failed semantic check",
      (value) => {
        value.report.semanticIndexGenerationCorrespondence.issues.push(
          "reserved-surface-present",
        );
      },
    ],
  ]) {
    const broken = clone(outcome);
    mutate(broken);
    assert.throws(
      () => assertC2ZcSemanticIndexZero(broken),
      /Semantic Index|zero|observedCounts|surface/,
      label,
    );
  }
});

test("C2-ZC marker, findings/inbox, and Legacy projection contracts are exact", () => {
  const marker = {
    migrationId: "narrative-c2-canonical-freshness-v1",
    contractVersion: 1,
    appliedAt: "2026-08-28T00:00:17.000Z",
  };
  assert.doesNotThrow(() =>
    assertC2ZcMarkerExactlyOnce({
      marker,
      markerRows: [marker],
    }),
  );
  assert.throws(
    () => assertC2ZcMarkerExactlyOnce({ marker, markerRows: [marker, marker] }),
    /exactly one|marker/,
  );
  assert.doesNotThrow(() =>
    assertC2ZcFindingInboxEmpty({
      unresolvedFindings: [],
      inboxEntries: [
        {
          entryKind: "consumer-freshness",
          latestObservation: null,
        },
      ],
    }),
  );
  assert.throws(
    () =>
      assertC2ZcFindingInboxEmpty({
        unresolvedFindings: [{ lifecycleState: "new" }],
        inboxEntries: [],
      }),
    /Finding|inbox|unresolved/,
  );
  assert.throws(
    () =>
      assertC2ZcFindingInboxEmpty({
        epochs: [{ id: "epoch-current" }],
        findingLifecycle: [
          {
            id: "finding-1",
            findingIdentity: "finding-identity",
            lifecycleState: "new",
            semanticEpochId: "epoch-current",
            observedAt: "2026-08-28T00:00:01.000Z",
          },
        ],
        unresolvedFindings: [],
        inboxEntries: [],
      }),
    /unresolved Finding/,
  );
  assert.throws(
    () =>
      assertC2ZcFindingInboxEmpty({
        epochs: [{ id: "epoch-current" }],
        findingLifecycle: [
          {
            id: "finding-1",
            findingIdentity: "finding-identity",
            findingKey: "finding-key",
            ruleId: "rule-id",
            ruleVersion: 1,
            lifecycleState: "resolved",
            materialBasisDigest: "sha256:material",
            semanticEpochId: "epoch-current",
            observedAt: "2026-08-28T00:00:02.000Z",
          },
        ],
        findingObservations: [],
        inboxEntries: [],
      }),
    /causally anchored/,
  );
  const legacy = {
    freshness: [
      {
        applicationId: "app-1",
        status: "fresh",
        reasonJson: null,
        version: 0,
        updatedAt: "2026-08-28T00:00:01.000Z",
      },
    ],
    dependencies: [
      {
        applicationId: "app-1",
        sourceKind: "snapshot-document",
        sourceKey: "snapshot:run-1",
        observedRevisionToken: "sha256:fixture",
        propagation: "freshness-only",
      },
    ],
  };
  assert.doesNotThrow(() =>
    assertC2ZcLegacyProjectionStable(legacy, clone(legacy)),
  );
  const changed = clone(legacy);
  changed.freshness[0].status = "stale";
  assert.throws(
    () => assertC2ZcLegacyProjectionStable(legacy, changed),
    /Legacy|projection|changed|exact/,
  );
});

test("C2-ZC two-project gate keeps the marker absent until every cursor converges", () => {
  const epoch = {
    id: "epoch-e0",
    epochNumber: 0,
    reason: "initial",
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  const marker = {
    migrationId: "narrative-c2-canonical-freshness-v1",
    contractVersion: 1,
    appliedAt: "2026-08-28T00:00:17.000Z",
  };
  const settledCursor = (feedHead) => ({
    feedHead,
    cursor: {
      acknowledgedThrough: feedHead,
      activeRunId: null,
      reservedThrough: null,
      semanticEpochId: null,
      lastError: null,
    },
  });
  const primary = {
    epochs: [epoch],
    feedAndCursor: settledCursor(2),
    markerRows: [],
    marker: null,
  };
  const secondary = {
    epochs: [epoch],
    feedAndCursor: {
      feedHead: 2,
      cursor: {
        acknowledgedThrough: 1,
        activeRunId: "run-secondary",
        reservedThrough: 2,
        semanticEpochId: epoch.id,
        lastError: null,
      },
    },
    markerRows: [],
    marker: null,
  };
  assert.deepEqual(
    assertC2ZcTwoProjectConvergenceGate({
      primarySettled: primary,
      secondaryIncomplete: secondary,
      markerRowsWhileIncomplete: [],
    }),
    { primary, secondary },
  );
  assert.throws(
    () =>
      assertC2ZcTwoProjectConvergenceGate({
        primarySettled: primary,
        secondaryIncomplete: secondary,
        markerRowsWhileIncomplete: [marker],
      }),
    /marker.*incomplete/i,
  );

  const convergedPrimary = {
    ...primary,
    marker,
    markerRows: [marker],
    feedAndCursor: settledCursor(2),
  };
  const convergedSecondary = {
    ...secondary,
    marker,
    markerRows: [marker],
    feedAndCursor: settledCursor(2),
  };
  assert.deepEqual(
    assertC2ZcTwoProjectConvergenceGate({
      primarySettled: primary,
      secondaryIncomplete: secondary,
      markerRowsWhileIncomplete: [],
      convergedPrimary,
      convergedSecondary,
    }),
    { primary: convergedPrimary, secondary: convergedSecondary },
  );
  assert.throws(
    () =>
      assertC2ZcTwoProjectConvergenceGate({
        primarySettled: primary,
        secondaryIncomplete: secondary,
        markerRowsWhileIncomplete: [],
        convergedPrimary,
        convergedSecondary: {
          ...convergedSecondary,
          markerRows: [
            marker,
            { ...marker, appliedAt: "2026-08-28T00:00:18.000Z" },
          ],
        },
      }),
    /exactly one|marker/i,
  );
});

test("C2-ZC secondary project transitions from epochless create to held maintenance readiness", () => {
  const projectId = "project-secondary";
  const epoch = {
    id: "secondary-epoch-0",
    epochNumber: 0,
    reason: "initial",
    createdAt: "2026-08-28T00:00:00.000Z",
  };
  const slugs = ["character", "location", "item", "lore"];
  const projectCreateEvents = slugs.map((slug, eventOrdinal) => ({
    eventId: `secondary-event-${eventOrdinal}`,
    canonicalSequence: eventOrdinal + 1,
    eventOrdinal,
    transactionId: "secondary-project-create-transaction",
    requestId: `c2-zc-journey-project-create:${projectId}`,
    sourceDomain: "project.create",
    objectKeyJson: JSON.stringify({
      kind: "component",
      componentId: `codex-type:${projectId}-${slug}`,
    }),
    changeKind: "catalog",
    mutationKind: "create",
    applicationIdsJson: "[]",
  }));
  const emptyCursor = {
    feedHead: 4,
    cursor: {
      acknowledgedThrough: null,
      reservedThrough: null,
      activeRunId: null,
      semanticEpochId: null,
      lastError: null,
    },
    cursorPresent: false,
  };
  const postCreate = {
    projectId,
    marker: null,
    markerRows: [],
    epochs: [],
    runs: [],
    genericRows: [],
    dependencyEdges: [],
    legacyProjection: { freshness: [], dependencies: [] },
    findingLifecycle: [],
    findingObservations: [],
    inboxEntries: [],
    inboxFindings: [],
    pendingRuns: [],
    feedAndCursor: emptyCursor,
    feedEvents: projectCreateEvents,
    changeSets: [],
    projectSettled: true,
  };
  const maintenanceRun = (id, runKind, taskKind, createdAt, completedAt) => {
    const taskId = `${id}-task`;
    const attemptId = `${id}-attempt`;
    const verify = runKind === "dependency-verify";
    const outcome = verify ? c2zcVerifyOutcome() : {};
    if (verify) outcome.semanticEpochId = epoch.id;
    const outputJson = JSON.stringify(outcome);
    return {
      id,
      projectId,
      runKind,
      workKey: `${runKind}:${epoch.id}:${id}`,
      semanticEpochId: epoch.id,
      status: "completed",
      taskId,
      taskKind,
      taskStatus: "completed",
      taskCount: 1,
      attemptCount: 1,
      taskAttemptCount: 1,
      lastAttemptNumber: 1,
      maxAttemptNumber: 1,
      lastAttemptStatus: "completed",
      createdAt,
      startedAt: createdAt,
      taskCreatedAt: createdAt,
      taskStartedAt: createdAt,
      lastAttemptStartedAt: createdAt,
      completedAt,
      taskCompletedAt: completedAt,
      lastAttemptCompletedAt: completedAt,
      specJson: "{}",
      taskInputJson: "{}",
      outcomeSummaryJson: outputJson,
      tasks: [
        {
          id: taskId,
          runId: id,
          taskKind,
          status: "completed",
          attemptCount: 1,
          createdAt,
          startedAt: createdAt,
          completedAt,
          inputJson: "{}",
          outputJson,
          attempts: [
            {
              id: attemptId,
              taskId,
              attemptNumber: 1,
              status: "completed",
              startedAt: createdAt,
              completedAt,
              outputJson,
              failureCode: null,
              retryDisposition: null,
              policyVersion: null,
              nextAttemptAt: null,
            },
          ],
        },
      ],
    };
  };
  const held = {
    ...postCreate,
    epochs: [epoch],
    runs: [
      maintenanceRun(
        "secondary-backfill",
        "backfill",
        "maintenance-backfill",
        "2026-08-28T00:00:01.000Z",
        "2026-08-28T00:00:02.000Z",
      ),
      maintenanceRun(
        "secondary-verify-1",
        "dependency-verify",
        "maintenance-dependency-verify",
        "2026-08-28T00:00:03.000Z",
        "2026-08-28T00:00:04.000Z",
      ),
      maintenanceRun(
        "secondary-rebuild",
        "semantic-index-rebuild",
        "maintenance-semantic-index-rebuild",
        "2026-08-28T00:00:05.000Z",
        "2026-08-28T00:00:06.000Z",
      ),
      maintenanceRun(
        "secondary-verify-2",
        "dependency-verify",
        "maintenance-dependency-verify",
        "2026-08-28T00:00:07.000Z",
        "2026-08-28T00:00:08.000Z",
      ),
    ],
  };

  assert.throws(
    () =>
      assertC2ZcSecondaryMaintenanceReadiness({
        projectId,
        afterCreate: postCreate,
        atHold: postCreate,
        label: "C2-ZC epochless secondary RED",
      }),
    /initial epoch|Backfill|maintenance/i,
  );
  assert.doesNotThrow(() =>
    assertC2ZcSecondaryMaintenanceReadiness({
      projectId,
      afterCreate: postCreate,
      atHold: held,
      label: "C2-ZC secondary Backfill transition GREEN",
    }),
  );
  const changedFeed = structuredClone(held);
  changedFeed.feedEvents[0].canonicalSequence = 99;
  assert.throws(
    () =>
      assertC2ZcSecondaryMaintenanceReadiness({
        projectId,
        afterCreate: postCreate,
        atHold: changedFeed,
        label: "C2-ZC secondary Feed identity RED",
      }),
    /Feed identities|project_create|protected/i,
  );
});

test("C2-ZC post-marker evidence binds Generic freshness to a current producer Run and settles", () => {
  const projectId = "project-1";
  const epochId = "epoch-e1";
  const applicationId = "app-1";
  const eventIds = ["event-1"];
  const sourceObjectIdentity = "project:scene:scene-1";
  const spec = {
    projectId,
    fromSequenceExclusive: 0,
    throughSequenceInclusive: 1,
    eventIds,
    affectedObjects: [sourceObjectIdentity],
    feedPageDigest: `sha256:${"b".repeat(64)}`,
  };
  const specDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(spec), "utf8")
    .digest("hex")}`;
  const outcome = {
    projectId,
    runId: "run-freshness-1",
    fromSequenceExclusive: 0,
    throughSequenceInclusive: 1,
    affectedEdgeCount: 1,
    affectedConsumerCount: 1,
    hasMore: false,
  };
  const attempt = {
    id: "attempt-freshness-1",
    taskId: "task-freshness-1",
    attemptNumber: 1,
    status: "completed",
    startedAt: "2026-08-28T00:00:22.000Z",
    completedAt: "2026-08-28T00:00:23.000Z",
    errorMessage: null,
    outputJson: JSON.stringify(outcome),
    failureCode: null,
    retryDisposition: null,
    policyVersion: null,
    nextAttemptAt: null,
  };
  const snapshot = {
    epochs: [{ id: epochId, epochNumber: 1, reason: "restore" }],
    runs: [
      {
        id: outcome.runId,
        runKind: "freshness-evaluation",
        status: "completed",
        projectId,
        semanticEpochId: epochId,
        consumerId: "narrative-incremental-freshness/v1",
        createdAt: "2026-08-28T00:00:20.000Z",
        startedAt: "2026-08-28T00:00:21.000Z",
        completedAt: "2026-08-28T00:00:24.000Z",
        specJson: JSON.stringify(spec),
        specDigest,
        workKey: `incremental-freshness:${epochId}:0:1:${specDigest.slice("sha256:".length)}`,
        outcomeSummaryJson: JSON.stringify(outcome),
        tasks: [
          {
            id: "task-freshness-1",
            taskKind: "incremental-freshness-batch",
            status: "completed",
            attemptCount: 1,
            inputJson: JSON.stringify({
              changeSetId: "change-set-1",
              fromSequenceExclusive: 0,
              throughSequenceInclusive: 1,
            }),
            outputJson: JSON.stringify(outcome),
            createdAt: "2026-08-28T00:00:21.000Z",
            startedAt: "2026-08-28T00:00:22.000Z",
            completedAt: "2026-08-28T00:00:23.000Z",
            attempts: [attempt],
          },
        ],
      },
    ],
    genericRows: [
      {
        projectId,
        consumerKind: "application",
        consumerKey: applicationId,
        evidenceFreshness: "fresh",
        buildAction: "none",
        semanticEpochId: epochId,
        lastEvaluatedRunId: outcome.runId,
        dependencySetDigest: `sha256:${createHash("sha256")
          .update(
            `${Buffer.byteLength(sourceObjectIdentity, "utf8")}:${sourceObjectIdentity}\n`,
            "utf8",
          )
          .digest("hex")}`,
        updatedAt: "2026-08-28T00:00:21.000Z",
      },
    ],
    feedEvents: [
      {
        eventId: "event-1",
        canonicalSequence: 1,
        eventOrdinal: 0,
        objectKeyJson: JSON.stringify({ kind: "scene", sceneId: "scene-1" }),
        changeKind: "content",
        mutationKind: "update",
        applicationIdsJson: "[]",
      },
    ],
    changeSets: [
      {
        changeSetId: "change-set-1",
        projectId,
        fromSequenceExclusive: 0,
        throughSequenceInclusive: 1,
        eventIdsJson: JSON.stringify(eventIds),
        affectedObjectsJson: JSON.stringify([sourceObjectIdentity]),
        digest: specDigest,
      },
    ],
    dependencyEdges: [
      {
        projectId,
        consumerKind: "application",
        consumerKey: applicationId,
        sourceObjectIdentity,
      },
    ],
    pendingRuns: [],
    unresolvedFindings: [],
    inboxEntries: [],
  };
  assert.doesNotThrow(() =>
    assertC2ZcCanonicalFreshnessEvidence(snapshot, {
      projectId,
      applicationId,
      epochId,
    }),
  );
  assert.doesNotThrow(() => assertC2ZcPostMarkerProjectSettled(snapshot));
  const broken = clone(snapshot);
  broken.runs[0].semanticEpochId = "epoch-e0";
  assert.throws(
    () =>
      assertC2ZcCanonicalFreshnessEvidence(broken, {
        projectId: "project-1",
        applicationId: "app-1",
        epochId: "epoch-e1",
      }),
    /producer|epoch|current|Generic/,
  );
  const malformedDigest = clone(snapshot);
  malformedDigest.runs[0].specDigest = `sha256:${"c".repeat(64)}`;
  assert.throws(
    () =>
      assertC2ZcCanonicalFreshnessEvidence(malformedDigest, {
        projectId,
        applicationId,
        epochId,
      }),
    /descriptor|digest|Feed-bound/,
  );
  const missingConsumer = clone(snapshot);
  missingConsumer.runs[0].consumerId = null;
  assert.throws(
    () =>
      assertC2ZcCanonicalFreshnessEvidence(missingConsumer, {
        projectId,
        applicationId,
        epochId,
      }),
    /producer|current|Generic/,
  );
  assert.throws(
    () =>
      assertC2ZcNonIdleFreshnessProducer(
        { ...snapshot, runs: [] },
        { projectId, epochId, eventId: eventIds[0] },
        "C2-ZC missing current A Freshness",
      ),
    /no valid current-Epoch non-idle publisher|Freshness/i,
  );
  const idleOutcome = clone(snapshot);
  const idle = JSON.parse(idleOutcome.runs[0].outcomeSummaryJson);
  idle.affectedEdgeCount = 0;
  idleOutcome.runs[0].outcomeSummaryJson = JSON.stringify(idle);
  assert.throws(
    () =>
      assertC2ZcCanonicalFreshnessEvidence(idleOutcome, {
        projectId,
        applicationId,
        epochId,
      }),
    /idle|malformed|outcome/,
  );
  assert.throws(
    () =>
      assertC2ZcPostMarkerProjectSettled({
        ...snapshot,
        pendingRuns: ["run-pending"],
      }),
    /settled|pending|running/,
  );
  const rebuildSummary = {
    consumersEvaluated: 1,
    consumersSkippedUnresolvableScope: 0,
    edgesEvaluated: 1,
    edgesSkippedUnresolvableScope: 0,
  };
  const rebuildOutcome = {
    rebuildContractVersion: "1",
    semanticEpochId: epochId,
    summaryDigest: `sha256:${createHash("sha256")
      .update(JSON.stringify(rebuildSummary), "utf8")
      .digest("hex")}`,
    summary: rebuildSummary,
  };
  const rebuildRun = {
    id: "rebuild-run-1",
    projectId,
    runKind: "semantic-index-rebuild",
    workKey: "dependency-rebuild-derived",
    status: "completed",
    semanticEpochId: epochId,
    consumerId: null,
    specJson: "{}",
    specDigest: `sha256:${createHash("sha256")
      .update("{}", "utf8")
      .digest("hex")}`,
    outcomeSummaryJson: JSON.stringify(rebuildOutcome),
    createdAt: "2026-08-28T00:00:20.000Z",
    startedAt: "2026-08-28T00:00:21.000Z",
    completedAt: "2026-08-28T00:00:23.000Z",
    tasks: [
      {
        id: "rebuild-task-1",
        taskKind: "maintenance-semantic-index-rebuild",
        status: "completed",
        attemptCount: 1,
        inputJson: "{}",
        outputJson: JSON.stringify(rebuildOutcome),
        createdAt: "2026-08-28T00:00:20.000Z",
        startedAt: "2026-08-28T00:00:21.000Z",
        completedAt: "2026-08-28T00:00:23.000Z",
        attempts: [
          {
            id: "rebuild-attempt-1",
            taskId: "rebuild-task-1",
            attemptNumber: 1,
            status: "completed",
            startedAt: "2026-08-28T00:00:21.000Z",
            completedAt: "2026-08-28T00:00:23.000Z",
            outputJson: JSON.stringify(rebuildOutcome),
            failureCode: null,
            retryDisposition: null,
            policyVersion: null,
            nextAttemptAt: null,
          },
        ],
      },
    ],
  };
  const rebuildSnapshot = {
    ...snapshot,
    runs: [rebuildRun],
    genericRows: [
      {
        ...snapshot.genericRows[0],
        lastEvaluatedRunId: rebuildRun.id,
      },
    ],
    feedEvents: [],
    changeSets: [],
  };
  assert.doesNotThrow(() =>
    assertC2ZcGenericRowsComplete(rebuildSnapshot, "C2-ZC Rebuild Generic"),
  );
  const malformedRebuild = structuredClone(rebuildSnapshot);
  malformedRebuild.runs[0].consumerId = "unexpected-consumer";
  assert.throws(
    () => assertC2ZcGenericRowsComplete(malformedRebuild),
    /Rebuild publisher identity|invalid producer/,
  );
});

test("C2-ZC post-marker typed Application keeps marker, epoch, Generic, and Legacy snapshots across restart", () => {
  const marker = {
    migrationId: "narrative-c2-canonical-freshness-v1",
    contractVersion: 1,
    appliedAt: "2026-08-28T00:00:17.000Z",
  };
  const epoch = {
    id: "new-e0",
    projectId: "project-new",
    epochNumber: 0,
    reason: "initial",
    createdAt: "2026-08-28T00:00:20.000Z",
  };
  const typedRun = {
    id: "typed-run",
    runKind: null,
    status: "completed",
    tasks: [
      {
        id: "typed-task",
        status: "completed",
        attempts: [{ id: "typed-attempt", status: "completed" }],
      },
    ],
  };
  const producerRun = {
    id: "freshness-run",
    projectId: epoch.projectId,
    runKind: "freshness-evaluation",
    status: "completed",
    semanticEpochId: epoch.id,
    consumerId: "narrative-incremental-freshness/v1",
    createdAt: "2026-08-28T00:00:20.000Z",
    startedAt: "2026-08-28T00:00:21.000Z",
    completedAt: "2026-08-28T00:00:24.000Z",
    scopeJson: JSON.stringify({ projectId: epoch.projectId, scope: "full" }),
    specJson: JSON.stringify({
      projectId: epoch.projectId,
      fromSequenceExclusive: 0,
      throughSequenceInclusive: 1,
      eventIds: ["event-typed"],
      affectedObjects: ["project:scene:scene-typed"],
      feedPageDigest: `sha256:${"b".repeat(64)}`,
    }),
    specDigest: "",
    snapshotDigest: `sha256:${"c".repeat(64)}`,
    coverageJson: JSON.stringify({ complete: true, covered: ["feed"] }),
    version: 7,
    supersededByRunId: null,
    requestId: "typed-producer-request",
    idempotencyDomain: "c2-zc-product-journey",
    requestPayloadDigest: `sha256:${"e".repeat(64)}`,
    actorId: "c2-zc-product-journey",
    workKey: "",
    outcomeSummaryJson: "",
    tasks: [],
  };
  const producerSpec = JSON.parse(producerRun.specJson);
  producerRun.specDigest = `sha256:${createHash("sha256")
    .update(JSON.stringify(producerSpec), "utf8")
    .digest("hex")}`;
  producerRun.workKey = `incremental-freshness:${epoch.id}:0:1:${producerRun.specDigest.slice("sha256:".length)}`;
  const producerOutcome = {
    projectId: epoch.projectId,
    runId: producerRun.id,
    fromSequenceExclusive: 0,
    throughSequenceInclusive: 1,
    affectedEdgeCount: 1,
    affectedConsumerCount: 1,
    hasMore: false,
  };
  producerRun.outcomeSummaryJson = JSON.stringify(producerOutcome);
  producerRun.tasks = [
    {
      id: "freshness-task",
      taskKind: "incremental-freshness-batch",
      status: "completed",
      attemptCount: 1,
      inputJson: JSON.stringify({
        changeSetId: "change-set-typed",
        fromSequenceExclusive: 0,
        throughSequenceInclusive: 1,
      }),
      outputJson: JSON.stringify(producerOutcome),
      createdAt: "2026-08-28T00:00:21.000Z",
      startedAt: "2026-08-28T00:00:22.000Z",
      completedAt: "2026-08-28T00:00:23.000Z",
      attempts: [
        {
          id: "freshness-attempt",
          taskId: "freshness-task",
          attemptNumber: 1,
          status: "completed",
          startedAt: "2026-08-28T00:00:22.000Z",
          completedAt: "2026-08-28T00:00:23.000Z",
          outputJson: JSON.stringify(producerOutcome),
          failureCode: null,
          retryDisposition: null,
          policyVersion: null,
          nextAttemptAt: null,
        },
      ],
    },
  ];
  const genericRows = [
    {
      projectId: "project-new",
      consumerKind: "application",
      consumerKey: "app-typed",
      evidenceFreshness: "fresh",
      buildAction: "none",
      semanticEpochId: epoch.id,
      lastEvaluatedRunId: producerRun.id,
      dependencySetDigest: `sha256:${createHash("sha256")
        .update("25:project:scene:scene-typed\n", "utf8")
        .digest("hex")}`,
      updatedAt: "2026-08-28T00:00:21.000Z",
    },
  ];
  const typedApplication = {
    projectId: "project-new",
    runId: "typed-run",
    taskId: "typed-task",
    attemptId: "typed-attempt",
    proposalSetId: "typed-proposal-set",
    proposalId: "typed-proposal",
    revisionId: "typed-revision",
    entryId: "typed-entry",
    commitId: "typed-commit",
    applicationId: "app-typed",
  };
  const typedArtifacts = {
    proposalSets: [
      {
        proposalSetId: typedApplication.proposalSetId,
        runId: typedApplication.runId,
        projectId: typedApplication.projectId,
        setKind: "c2-zc.post-marker.review@1",
        status: "draft",
        summaryJson: JSON.stringify({
          kind: "c2-zc-post-marker-application@1",
        }),
      },
    ],
    proposals: [
      {
        proposalId: typedApplication.proposalId,
        proposalSetId: typedApplication.proposalSetId,
        kind: "codex.entry.create",
        status: "approved",
        currentRevisionId: typedApplication.revisionId,
      },
    ],
    proposalRevisions: [
      {
        revisionId: typedApplication.revisionId,
        proposalId: typedApplication.proposalId,
        revisionNumber: 1,
        originKind: "enveloped",
        createdBy: "system",
        reconciliationEnvelopeDigest: `sha256:${"1".repeat(64)}`,
      },
    ],
    proposalDecisions: [
      {
        decisionId: "typed-decision",
        proposalId: typedApplication.proposalId,
        revisionId: typedApplication.revisionId,
        decision: "approved",
        createdBy: "c2-zc-product-journey",
        actorKind: "human",
      },
    ],
    applyCommits: [
      {
        commitId: typedApplication.commitId,
        projectId: typedApplication.projectId,
        runId: typedApplication.runId,
        proposalSetId: typedApplication.proposalSetId,
        requestId: `${typedApplication.runId}-apply-request`,
        status: "applied",
        planDigest: `sha256:${"2".repeat(64)}`,
        preparedPlanJson: { operations: [] },
        preparedPolicyVersion: "v1",
        authorityDigest: `sha256:${"3".repeat(64)}`,
        sessionId: "c2-zc-canonical-authority-cutover",
      },
    ],
    applyOperations: [
      {
        operationId: "typed-operation",
        commitId: typedApplication.commitId,
        operationIndex: 0,
        operationKind: "codex.entry.create",
        resultEntityKind: "codex_entry",
        resultEntityId: typedApplication.entryId,
        status: "applied",
      },
    ],
    applications: [
      {
        applicationId: typedApplication.applicationId,
        commitId: typedApplication.commitId,
        proposalId: typedApplication.proposalId,
        revisionId: typedApplication.revisionId,
        appliedEntityKind: "codex_entry",
        appliedEntityId: typedApplication.entryId,
        applicationKind: "normal",
        compensatesApplicationId: null,
      },
    ],
    commitJournals: [
      {
        journalId: "typed-journal",
        commitId: typedApplication.commitId,
        projectId: typedApplication.projectId,
        beforeJson: null,
        afterJson: { entryId: typedApplication.entryId },
      },
    ],
    codexEntries: [
      {
        entryId: typedApplication.entryId,
        projectId: typedApplication.projectId,
        name: "Typed restart entry",
        content: "typed content",
      },
    ],
  };
  const settled = (runs, generic = genericRows) => ({
    marker,
    markerRows: [marker],
    epochs: [epoch],
    runs,
    genericRows: generic,
    dependencyEdges: [
      {
        projectId: epoch.projectId,
        consumerKind: "application",
        consumerKey: "app-typed",
        sourceObjectIdentity: "project:scene:scene-typed",
      },
    ],
    legacyProjection: {
      freshness: [
        {
          applicationId: "app-typed",
          status: "fresh",
          reasonJson: null,
          version: 0,
          updatedAt: "2026-08-28T00:00:21.000Z",
        },
      ],
      dependencies: [
        {
          applicationId: "app-typed",
          sourceKind: "snapshot-document",
          sourceKey: "snapshot:typed-run",
          observedRevisionToken: "sha256:source",
          propagation: "freshness-only",
        },
      ],
    },
    pendingRuns: [],
    unresolvedFindings: [],
    inboxEntries: [],
    inboxFindings: [],
    typedArtifacts,
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
    feedEvents: [
      {
        eventId: "event-typed",
        canonicalSequence: 1,
        eventOrdinal: 0,
        objectKeyJson: JSON.stringify({
          kind: "scene",
          sceneId: "scene-typed",
        }),
        changeKind: "content",
        mutationKind: "update",
        applicationIdsJson: JSON.stringify([typedApplication.applicationId]),
      },
    ],
    changeSets: [
      {
        changeSetId: "change-set-typed",
        projectId: epoch.projectId,
        fromSequenceExclusive: 0,
        throughSequenceInclusive: 1,
        eventIdsJson: JSON.stringify(["event-typed"]),
        affectedObjectsJson: JSON.stringify(["project:scene:scene-typed"]),
        digest: producerRun.specDigest,
      },
    ],
    projectSettled: true,
  });
  const beforeMutation = settled([], []);
  const afterMutation = settled([typedRun, producerRun]);
  const restart = settled([typedRun, producerRun]);
  assert.doesNotThrow(() =>
    assertC2ZcPostMarkerRestartInvariants({
      beforeMutation,
      afterMutation,
      restart,
      application: typedApplication,
    }),
  );
  const changedLegacy = structuredClone(restart);
  changedLegacy.legacyProjection.dependencies[0].observedRevisionToken =
    "sha256:changed";
  assert.throws(
    () =>
      assertC2ZcPostMarkerRestartInvariants({
        beforeMutation,
        afterMutation,
        restart: changedLegacy,
        application: typedApplication,
      }),
    /Legacy|changed/,
  );
  const corruptedLedger = structuredClone(restart);
  corruptedLedger.typedArtifacts.applyCommits[0].preparedPlanJson = {
    operations: [{ kind: "unexpected" }],
  };
  assert.throws(
    () =>
      assertC2ZcPostMarkerRestartInvariants({
        beforeMutation,
        afterMutation,
        restart: corruptedLedger,
        application: typedApplication,
      }),
    /normalized durable ledger|prepared\/applied Commit/,
  );
  for (const [field, value] of [
    ["scopeJson", JSON.stringify({ projectId: "changed", scope: "full" })],
    ["snapshotDigest", `sha256:${"d".repeat(64)}`],
    ["coverageJson", JSON.stringify({ complete: false, covered: [] })],
    ["version", 8],
    ["requestId", "changed-request"],
    ["idempotencyDomain", "changed-domain"],
    ["requestPayloadDigest", `sha256:${"f".repeat(64)}`],
    ["actorId", "changed-actor"],
  ]) {
    const mutatedRunLedger = structuredClone(restart);
    mutatedRunLedger.runs.find((run) => run.id === producerRun.id)[field] =
      value;
    assert.throws(
      () =>
        assertC2ZcPostMarkerRestartInvariants({
          beforeMutation,
          afterMutation,
          restart: mutatedRunLedger,
          application: typedApplication,
        }),
      /normalized durable ledger|Run contract/,
      `Run ledger mutation of ${field} must be rejected`,
    );
  }
});

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

test("C2-ZC disabled restore rejects every new Freshness Run regardless of epoch binding", () => {
  const fixture = c2zcFixture();
  const e1 = {
    id: "epoch-e1",
    epochNumber: 1,
    reason: "restore",
    createdAt: "2026-08-28T00:00:10.000Z",
  };
  for (const [label, epochId] of [
    ["E0 Freshness", "epoch-e0"],
    ["E1 Freshness", e1.id],
    ["NULL-epoch Freshness", null],
  ]) {
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
            c2zcIdleCheckpoint(
              `restore-${label}`,
              epochId,
              "2026-08-28T00:00:11.000Z",
              "2026-08-28T00:00:12.000Z",
            ),
          ],
        }),
      /must not run Freshness Runs during restore/,
      label,
    );
  }
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

test("C2-ZC open total order includes one idle E1 Freshness before the marker", () => {
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
  const idleRun = c2zcIdleCheckpoint(
    "idle-e1",
    e1.id,
    "2026-08-28T00:00:16.100Z",
    "2026-08-28T00:00:16.200Z",
  );
  const marker = {
    migrationId: "narrative-c2-canonical-freshness-v1",
    contractVersion: 1,
    appliedAt: "2026-08-28T00:00:17.000Z",
  };
  assert.doesNotThrow(() =>
    assertC2ZcOpenTotalOrder({
      markerBefore: null,
      markerAfter: marker,
      beforeEpochs: [...fixture.epochs, e1],
      afterEpochs: [...fixture.epochs, e1],
      beforeRuns: [fixture.backfill],
      afterRuns: [fixture.backfill, ...phaseRuns, idleRun],
      phaseRuns,
      idleRun,
      restoreEpochId: e1.id,
    }),
  );
  assert.throws(
    () =>
      assertC2ZcOpenTotalOrder({
        markerBefore: null,
        markerAfter: {
          ...marker,
          appliedAt: "2026-08-28T00:00:16.150Z",
        },
        beforeEpochs: [...fixture.epochs, e1],
        afterEpochs: [...fixture.epochs, e1],
        beforeRuns: [fixture.backfill],
        afterRuns: [fixture.backfill, ...phaseRuns, idleRun],
        phaseRuns,
        idleRun,
        restoreEpochId: e1.id,
      }),
    /after idle Task\/Attempt lifecycle/,
  );
  assert.throws(
    () =>
      assertC2ZcOpenTotalOrder({
        markerBefore: null,
        markerAfter: marker,
        beforeEpochs: [...fixture.epochs, e1],
        afterEpochs: [...fixture.epochs, e1],
        beforeRuns: [fixture.backfill],
        afterRuns: [
          fixture.backfill,
          ...phaseRuns,
          idleRun,
          c2zcPhase(
            "verify-after-idle",
            "dependency-verify",
            e1.id,
            "2026-08-28T00:00:16.300Z",
            "2026-08-28T00:00:16.400Z",
          ),
        ],
        phaseRuns,
        idleRun,
        restoreEpochId: e1.id,
      }),
    /exactly the three current-E1 phase Runs/,
  );
});

test("C2-ZC idle checkpoint recomputes the canonical Task input digest", () => {
  const base = c2zcOpenContractFixture();
  const taskInput = JSON.parse(base.idleRun.taskInputJson);
  const outcome = JSON.parse(base.idleRun.outcomeSummaryJson);
  const tamperedTaskInput = {
    ...taskInput,
    fromSequenceExclusive: 2,
    throughSequenceInclusive: 2,
    feedHead: 2,
  };
  const tamperedIdle = {
    ...base.idleRun,
    workKey: `incremental-freshness:${base.restoreEpochId}:2:2:${taskInput.inputDigest.slice("sha256:".length)}`,
    taskInputJson: JSON.stringify(tamperedTaskInput),
    outcomeSummaryJson: JSON.stringify({
      ...outcome,
      fromSequenceExclusive: 2,
      throughSequenceInclusive: 2,
    }),
  };
  assert.throws(
    () =>
      assertC2ZcOpenTotalOrder({
        ...base,
        afterRuns: [...base.beforeRuns, ...base.phaseRuns, tamperedIdle],
        idleRun: tamperedIdle,
      }),
    /Task input digest does not match its canonical payload/,
  );
});

test("C2-ZC idle checkpoint recomputes the canonical Run spec digest", () => {
  const base = c2zcOpenContractFixture();
  const tamperedIdle = {
    ...base.idleRun,
    specDigest: sha256Canonical({
      kind: "incremental-freshness-idle-checkpoint@1",
      inputDigest: "sha256:" + "c".repeat(64),
    }),
  };
  assert.throws(
    () =>
      assertC2ZcOpenTotalOrder({
        ...base,
        afterRuns: [...base.beforeRuns, ...base.phaseRuns, tamperedIdle],
        idleRun: tamperedIdle,
      }),
    /specDigest does not match its canonical spec/,
  );
});

test("C2-ZC idle checkpoint requires the exact incremental freshness consumer", () => {
  const base = c2zcOpenContractFixture();
  const tamperedIdle = { ...base.idleRun, consumerId: "other-consumer/v1" };
  assert.throws(
    () =>
      assertC2ZcOpenTotalOrder({
        ...base,
        afterRuns: [...base.beforeRuns, ...base.phaseRuns, tamperedIdle],
        idleRun: tamperedIdle,
      }),
    /consumerId must be narrative-incremental-freshness\/v1/,
  );
});

test("C2-ZC idle Task and final Attempt output must match the Run outcome", () => {
  const base = c2zcOpenContractFixture();
  const outcome = JSON.parse(base.idleRun.outcomeSummaryJson);
  for (const [label, mutate] of [
    [
      "Task output",
      (run) => {
        const tampered = { ...outcome, affectedEdgeCount: 1 };
        run.tasks[0].outputJson = JSON.stringify(tampered);
      },
    ],
    [
      "Attempt output",
      (run) => {
        const tampered = { ...outcome, hasMore: true };
        run.tasks[0].attempts[0].outputJson = JSON.stringify(tampered);
      },
    ],
  ]) {
    const idleRun = clone(base.idleRun);
    mutate(idleRun);
    assert.throws(
      () =>
        assertC2ZcOpenTotalOrder({
          ...base,
          afterRuns: [...base.beforeRuns, ...base.phaseRuns, idleRun],
          idleRun,
        }),
      /output JSON does not match Run outcome/,
      label,
    );
  }

  const failedRetry = idleRunWithAttempts(base.idleRun, [
    {
      id: "idle-e1-attempt-1",
      taskId: base.idleRun.tasks[0].id,
      attemptNumber: 1,
      status: "failed",
      startedAt: "2026-08-28T00:00:16.100Z",
      completedAt: "2026-08-28T00:00:16.120Z",
      failureCode: "NEX_TEST_RETRY",
      retryDisposition: "retryable",
      policyVersion: "v1",
      nextAttemptAt: "2026-08-28T00:00:16.130Z",
    },
    {
      id: "idle-e1-attempt-2",
      taskId: base.idleRun.tasks[0].id,
      attemptNumber: 2,
      status: "completed",
      startedAt: "2026-08-28T00:00:16.140Z",
      completedAt: "2026-08-28T00:00:16.200Z",
      failureCode: null,
      retryDisposition: null,
      policyVersion: null,
      nextAttemptAt: null,
    },
  ]);
  failedRetry.tasks[0].attempts[0].outputJson = JSON.stringify(outcome);
  assert.throws(
    () =>
      assertC2ZcOpenTotalOrder({
        ...base,
        afterRuns: [...base.beforeRuns, ...base.phaseRuns, failedRetry],
        idleRun: failedRetry,
      }),
    /output JSON does not match Run outcome|failed Attempt outputJson must be NULL/,
    "failed Attempt output must be NULL",
  );

  const finalMismatch = idleRunWithAttempts(base.idleRun, [
    {
      id: "idle-e1-attempt-1",
      taskId: base.idleRun.tasks[0].id,
      attemptNumber: 1,
      status: "completed",
      startedAt: "2026-08-28T00:00:16.100Z",
      completedAt: "2026-08-28T00:00:16.200Z",
      failureCode: null,
      retryDisposition: null,
      policyVersion: null,
      nextAttemptAt: null,
    },
  ]);
  finalMismatch.tasks[0].attempts[0].outputJson = JSON.stringify({
    ...outcome,
    affectedConsumerCount: 1,
  });
  assert.throws(
    () =>
      assertC2ZcOpenTotalOrder({
        ...base,
        afterRuns: [...base.beforeRuns, ...base.phaseRuns, finalMismatch],
        idleRun: finalMismatch,
      }),
    /output JSON does not match Run outcome/,
    "final completed Attempt output must match the Run outcome",
  );

  const reordered = clone(base.idleRun);
  const reorderedOutcome = Object.fromEntries(
    Object.entries(outcome).reverse(),
  );
  reordered.tasks[0].outputJson = JSON.stringify(reorderedOutcome);
  reordered.tasks[0].attempts[0].outputJson = JSON.stringify(reorderedOutcome);
  assert.doesNotThrow(() =>
    assertC2ZcOpenTotalOrder({
      ...base,
      afterRuns: [...base.beforeRuns, ...base.phaseRuns, reordered],
      idleRun: reordered,
    }),
  );
});

test("C2-ZC open rejects every extra post-baseline Freshness Run", () => {
  const base = c2zcOpenContractFixture();
  for (const [label, extra] of [
    [
      "E0",
      c2zcIdleCheckpoint(
        "idle-e0",
        "epoch-e0",
        "2026-08-28T00:00:16.300Z",
        "2026-08-28T00:00:16.400Z",
      ),
    ],
    [
      "NULL epoch",
      c2zcIdleCheckpoint(
        "idle-null",
        null,
        "2026-08-28T00:00:16.300Z",
        "2026-08-28T00:00:16.400Z",
      ),
    ],
  ]) {
    assert.throws(
      () =>
        assertC2ZcOpenTotalOrder({
          ...base,
          afterRuns: [...base.afterRuns, extra],
        }),
      /exactly one post-baseline Freshness Run/,
      label,
    );
  }
});

test("C2-ZC restart rejects an extra E0 or NULL-epoch Freshness Run", () => {
  const base = c2zcOpenContractFixture();
  const open = {
    marker: base.markerAfter,
    epochs: base.afterEpochs,
    runs: base.afterRuns,
  };
  for (const [label, extra] of [
    [
      "E0",
      c2zcIdleCheckpoint(
        "restart-idle-e0",
        "epoch-e0",
        "2026-08-28T00:00:18.000Z",
        "2026-08-28T00:00:18.100Z",
      ),
    ],
    [
      "NULL epoch",
      c2zcIdleCheckpoint(
        "restart-idle-null",
        null,
        "2026-08-28T00:00:18.000Z",
        "2026-08-28T00:00:18.100Z",
      ),
    ],
  ]) {
    assert.throws(
      () =>
        assertC2ZcRestartInvariants({
          open,
          restart: {
            marker: { ...base.markerAfter },
            epochs: base.afterEpochs,
            runs: [...base.afterRuns, extra],
          },
          phaseRunIds: base.phaseRuns.map((run) => run.id),
          idleRunId: base.idleRun.id,
          baselineRuns: base.beforeRuns,
        }),
      /Freshness Run identities changed across restart/,
      label,
    );
  }
});

test("C2-ZC idle checkpoint requires a complete Task and Attempt temporal envelope", () => {
  const base = c2zcOpenContractFixture();
  for (const [label, changes] of [
    ["missing task completion", { taskCompletedAt: null }],
    [
      "attempt starts before task",
      { lastAttemptStartedAt: "2026-08-28T00:00:16.050Z" },
    ],
    [
      "task completes after Run",
      { taskCompletedAt: "2026-08-28T00:00:16.300Z" },
    ],
  ]) {
    const tamperedIdle = { ...base.idleRun, ...changes };
    assert.throws(
      () =>
        assertC2ZcOpenTotalOrder({
          ...base,
          afterRuns: [...base.beforeRuns, ...base.phaseRuns, tamperedIdle],
          idleRun: tamperedIdle,
        }),
      /Task\/Attempt lifecycle temporal envelope is invalid/,
      label,
    );
  }
});

test("C2-ZC idle checkpoint accepts a zero-duration completed Attempt", () => {
  const base = c2zcOpenContractFixture();
  const idleRun = clone(base.idleRun);
  idleRun.lastAttemptCompletedAt = idleRun.lastAttemptStartedAt;
  idleRun.tasks[0].attempts[0].completedAt = idleRun.lastAttemptStartedAt;
  assert.doesNotThrow(() =>
    assertC2ZcOpenTotalOrder({
      ...base,
      afterRuns: [...base.beforeRuns, ...base.phaseRuns, idleRun],
      idleRun,
    }),
  );
});

test("C2-ZC idle checkpoint accepts bounded failed-retry history before final completion", () => {
  const base = c2zcOpenContractFixture();
  const idleRun = idleRunWithAttempts(base.idleRun, [
    {
      id: "idle-e1-attempt-1",
      taskId: base.idleRun.tasks[0].id,
      attemptNumber: 1,
      status: "failed",
      startedAt: "2026-08-28T00:00:16.100Z",
      completedAt: "2026-08-28T00:00:16.120Z",
      failureCode: "NEX_TEST_RETRY",
      retryDisposition: "retryable",
      policyVersion: "v1",
      nextAttemptAt: "2026-08-28T00:00:16.130Z",
    },
    {
      id: "idle-e1-attempt-2",
      taskId: base.idleRun.tasks[0].id,
      attemptNumber: 2,
      status: "completed",
      startedAt: "2026-08-28T00:00:16.140Z",
      completedAt: "2026-08-28T00:00:16.200Z",
      failureCode: null,
      retryDisposition: null,
      policyVersion: null,
      nextAttemptAt: null,
    },
  ]);
  assert.doesNotThrow(() =>
    assertC2ZcOpenTotalOrder({
      ...base,
      afterRuns: [...base.beforeRuns, ...base.phaseRuns, idleRun],
      idleRun,
    }),
  );
});

test("C2-ZC idle checkpoint rejects malformed retry topology and metadata", () => {
  const base = c2zcOpenContractFixture();
  const validAttempts = [
    {
      id: "idle-e1-attempt-1",
      taskId: base.idleRun.tasks[0].id,
      attemptNumber: 1,
      status: "failed",
      startedAt: "2026-08-28T00:00:16.100Z",
      completedAt: "2026-08-28T00:00:16.120Z",
      failureCode: "NEX_TEST_RETRY",
      retryDisposition: "retryable",
      policyVersion: "v1",
      nextAttemptAt: "2026-08-28T00:00:16.130Z",
    },
    {
      id: "idle-e1-attempt-2",
      taskId: base.idleRun.tasks[0].id,
      attemptNumber: 2,
      status: "completed",
      startedAt: "2026-08-28T00:00:16.140Z",
      completedAt: "2026-08-28T00:00:16.200Z",
      failureCode: null,
      retryDisposition: null,
      policyVersion: null,
      nextAttemptAt: null,
    },
  ];
  const cases = [
    [
      "attempt count mismatch",
      (run) => {
        run.tasks[0].attemptCount = 1;
        run.attemptCount = 1;
        run.taskAttemptCount = 1;
      },
    ],
    [
      "attempt numbering gap",
      (run) => {
        run.tasks[0].attempts[1].attemptNumber = 3;
      },
    ],
    [
      "completed attempt before failed retry",
      (run) => {
        run.tasks[0].attempts[0].status = "completed";
        run.tasks[0].attempts[0].failureCode = null;
        run.tasks[0].attempts[0].retryDisposition = null;
        run.tasks[0].attempts[0].policyVersion = null;
        run.tasks[0].attempts[0].nextAttemptAt = null;
        run.tasks[0].attempts[1].status = "failed";
        run.tasks[0].attempts[1].failureCode = "NEX_LATE_RETRY";
        run.tasks[0].attempts[1].retryDisposition = "retryable";
        run.tasks[0].attempts[1].policyVersion = "v1";
        run.tasks[0].attempts[1].nextAttemptAt = "2026-08-28T00:00:16.210Z";
      },
    ],
    [
      "running attempt",
      (run) => {
        run.tasks[0].attempts[1].status = "running";
      },
    ],
    [
      "retry cap",
      (run) => {
        run.tasks[0].attempts.push(
          {
            ...run.tasks[0].attempts[1],
            id: "idle-e1-attempt-3",
            attemptNumber: 3,
            startedAt: "2026-08-28T00:00:16.210Z",
            completedAt: "2026-08-28T00:00:16.220Z",
          },
          {
            ...run.tasks[0].attempts[1],
            id: "idle-e1-attempt-4",
            attemptNumber: 4,
            startedAt: "2026-08-28T00:00:16.230Z",
            completedAt: "2026-08-28T00:00:16.240Z",
          },
        );
        run.tasks[0].attempts[2].status = "failed";
        run.tasks[0].attempts[2].failureCode = "NEX_RETRY_3";
        run.tasks[0].attempts[2].retryDisposition = "retryable";
        run.tasks[0].attempts[2].policyVersion = "v1";
        run.tasks[0].attempts[2].nextAttemptAt = "2026-08-28T00:00:16.225Z";
        run.tasks[0].attempts[3].status = "completed";
        run.tasks[0].attempts[3].failureCode = null;
        run.tasks[0].attempts[3].retryDisposition = null;
        run.tasks[0].attempts[3].policyVersion = null;
        run.tasks[0].attempts[3].nextAttemptAt = null;
        run.tasks[0].attemptCount = 4;
        run.attemptCount = 4;
        run.taskAttemptCount = 4;
        run.lastAttemptNumber = 4;
        run.maxAttemptNumber = 4;
        run.lastAttemptStatus = "completed";
        run.lastAttemptStartedAt = "2026-08-28T00:00:16.230Z";
        run.lastAttemptCompletedAt = "2026-08-28T00:00:16.240Z";
        run.taskCompletedAt = "2026-08-28T00:00:16.240Z";
        run.completedAt = "2026-08-28T00:00:16.240Z";
      },
    ],
    [
      "failed retry metadata",
      (run) => {
        run.tasks[0].attempts[0].retryDisposition = "terminal";
      },
    ],
    [
      "completed attempt metadata",
      (run) => {
        run.tasks[0].attempts[1].failureCode = "NEX_FORGED";
      },
    ],
    [
      "attempt temporal inversion",
      (run) => {
        run.tasks[0].attempts[1].startedAt = "2026-08-28T00:00:16.110Z";
      },
    ],
  ];
  for (const [label, mutate] of cases) {
    const idleRun = idleRunWithAttempts(base.idleRun, validAttempts);
    mutate(idleRun);
    assert.throws(
      () =>
        assertC2ZcOpenTotalOrder({
          ...base,
          afterRuns: [...base.beforeRuns, ...base.phaseRuns, idleRun],
          idleRun,
        }),
      /Task\/Attempt retry topology is invalid/,
      label,
    );
  }
});

test("C2-ZC permits marker appliedAt equal to idle completion at millisecond precision", () => {
  const base = c2zcOpenContractFixture();
  assert.doesNotThrow(() =>
    assertC2ZcOpenTotalOrder({
      ...base,
      markerAfter: { ...base.markerAfter, appliedAt: base.idleRun.completedAt },
    }),
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
  const idleRun = c2zcIdleCheckpoint(
    "idle-e1",
    e1.id,
    "2026-08-28T00:00:16.100Z",
    "2026-08-28T00:00:16.200Z",
  );
  assert.doesNotThrow(() =>
    assertC2ZcRestartInvariants({
      open: {
        marker,
        epochs: [...fixture.epochs, e1],
        runs: [fixture.backfill, ...phaseRuns, idleRun],
      },
      restart: {
        marker: { ...marker },
        epochs: [...fixture.epochs, e1],
        runs: [fixture.backfill, ...phaseRuns, idleRun],
      },
      phaseRunIds: phaseRuns.map((run) => run.id),
      idleRunId: idleRun.id,
      baselineRuns: [fixture.backfill],
    }),
  );
  assert.throws(
    () =>
      assertC2ZcRestartInvariants({
        open: {
          marker,
          epochs: [...fixture.epochs, e1],
          runs: [fixture.backfill, ...phaseRuns, idleRun],
        },
        restart: {
          marker: { ...marker, appliedAt: "2026-08-28T00:00:18.000Z" },
          epochs: [...fixture.epochs, e1],
          runs: [fixture.backfill, ...phaseRuns, idleRun],
        },
        phaseRunIds: phaseRuns.map((run) => run.id),
        idleRunId: idleRun.id,
        baselineRuns: [fixture.backfill],
      }),
    /changed marker appliedAt/,
  );
});

test("C2-ZC restart rejects mutations to phase and idle Run contract fields", () => {
  const base = c2zcOpenContractFixture();
  const open = {
    marker: base.markerAfter,
    epochs: base.afterEpochs,
    runs: base.afterRuns,
  };
  for (const [label, mutate] of [
    [
      "phase status",
      (runs) => {
        runs.find((run) => run.id === base.phaseRuns[0].id).status = "failed";
      },
    ],
    [
      "phase work key",
      (runs) => {
        runs.find((run) => run.id === base.phaseRuns[1].id).workKey =
          "forged-work-key";
      },
    ],
    [
      "idle spec",
      (runs) => {
        const idle = runs.find((run) => run.id === base.idleRun.id);
        idle.specJson = JSON.stringify({
          kind: "incremental-freshness-idle-checkpoint@1",
          inputDigest: "sha256:" + "d".repeat(64),
        });
      },
    ],
    [
      "idle outcome",
      (runs) => {
        const idle = runs.find((run) => run.id === base.idleRun.id);
        const outcome = JSON.parse(idle.outcomeSummaryJson);
        outcome.affectedEdgeCount = 1;
        idle.outcomeSummaryJson = JSON.stringify(outcome);
      },
    ],
    [
      "idle task input",
      (runs) => {
        const idle = runs.find((run) => run.id === base.idleRun.id);
        const input = JSON.parse(idle.taskInputJson);
        input.feedHead = 2;
        idle.taskInputJson = JSON.stringify(input);
      },
    ],
    [
      "idle attempt",
      (runs) => {
        const idle = runs.find((run) => run.id === base.idleRun.id);
        idle.tasks[0].attempts[0].status = "running";
      },
    ],
    [
      "idle task output",
      (runs) => {
        const idle = runs.find((run) => run.id === base.idleRun.id);
        const outcome = JSON.parse(idle.outcomeSummaryJson);
        outcome.affectedEdgeCount = 1;
        idle.tasks[0].outputJson = JSON.stringify(outcome);
      },
    ],
    [
      "idle attempt output",
      (runs) => {
        const idle = runs.find((run) => run.id === base.idleRun.id);
        const outcome = JSON.parse(idle.outcomeSummaryJson);
        outcome.hasMore = true;
        idle.tasks[0].attempts[0].outputJson = JSON.stringify(outcome);
      },
    ],
  ]) {
    const restartRuns = clone(base.afterRuns);
    mutate(restartRuns);
    assert.throws(
      () =>
        assertC2ZcRestartInvariants({
          open,
          restart: {
            marker: { ...base.markerAfter },
            epochs: base.afterEpochs,
            runs: restartRuns,
          },
          phaseRunIds: base.phaseRuns.map((run) => run.id),
          idleRunId: base.idleRun.id,
          baselineRuns: base.beforeRuns,
        }),
      /persisted|Run spec|Task input|specDigest|outcome|retry topology/,
      label,
    );
  }
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
  assert.match(
    runner,
    /dependency-verify[\s\S]*semantic-index-rebuild[\s\S]*dependency-verify/,
  );
  assert.match(runner, /assertC2ZcOpenTotalOrder/);
  assert.match(runner, /idleRunId/);
  assert.match(runner, /appliedAt[\s\S]*completedAt/);
  assert.match(runner, /createProjectAfterCutover/);
  assert.match(maintenance, /runRestoreVerifyRebuildVerifyScenario/);
  assert.match(maintenance, /runRestoreVerifyRebuildVerifyScenario\([\s\S]*id/);
  assert.deepEqual(C2ZC_PRODUCT_JOURNEY_PHASES, [
    "c2-zc-canonical-authority-cutover/restore-fixture",
    "c2-zc-canonical-authority-cutover/restore",
    "c2-zc-canonical-authority-cutover/open",
    "c2-zc-canonical-authority-cutover/restart",
    "c2-zc-canonical-authority-cutover/restart-persistence",
    "c2-zc-canonical-authority-cutover/new-project",
  ]);
  for (const phase of C2ZC_PRODUCT_JOURNEY_PHASES) {
    assert.ok(PRODUCT_JOURNEY_ELECTRON_PHASES.includes(phase), phase);
  }
  assert.match(harness, /PRODUCT_JOURNEY_ELECTRON_PHASES/);
});

test("C2-ZC ledger enrichment preserves the supplied Run rows", async () => {
  const runs = [{ id: "run-1", runKind: "freshness-evaluation" }];
  const harness = {
    async invokeOk(_page, _command, { sql }) {
      if (sql.includes("narrative_extraction_attempts a")) {
        return {
          rows: [
            {
              id: "attempt-1",
              taskId: "task-1",
              attemptNumber: 1,
              status: "completed",
            },
          ],
        };
      }
      return {
        rows: [
          {
            id: "task-1",
            runId: "run-1",
            taskKind: "incremental-freshness-batch",
            status: "completed",
            attemptCount: 1,
            outputJson: '{"kind":"fixture-output"}',
          },
        ],
      };
    },
  };
  const enriched = await readC2ZcRunLedger(harness, {}, "project-1", runs);
  assert.equal(enriched.length, 1);
  assert.equal(enriched[0].id, "run-1");
  assert.equal(enriched[0].tasks.length, 1);
  assert.equal(enriched[0].tasks[0].outputJson, '{"kind":"fixture-output"}');
  assert.equal(enriched[0].tasks[0].attempts[0].id, "attempt-1");
});

test("C2-ZC restart wiring carries the open pre-run baseline into its invariant check", async () => {
  const runner = await read(
    "electron/scripts/c2zc-canonical-product-journey.mjs",
  );
  const openSnapshot = runner.match(/openSnapshot = \{[\s\S]*?\n\s*\};/)?.[0];
  assert.match(
    openSnapshot ?? "",
    /beforeRuns,/,
    "onOpen must persist its pre-open Run baseline for the restart phase",
  );
  const restartCallback = runner.match(
    /onRestart: async \(\{ context \}\) => \{[\s\S]*?baselineRuns: openSnapshot\.beforeRuns,/,
  )?.[0];
  assert.match(
    restartCallback ?? "",
    /baselineRuns: openSnapshot\.beforeRuns,/,
    "onRestart must use the persisted open baseline",
  );
  assert.doesNotMatch(restartCallback ?? "", /openResult\.beforeRuns/);
});

test("C2-ZC post-marker project creation waits for startup workspace authority", async () => {
  const runner = await read(
    "electron/scripts/c2zc-canonical-product-journey.mjs",
  );
  const createProjectFunction = runner.match(
    /export async function createProjectAfterCutover[\s\S]*?\n}\n\nasync function readAuthoritySnapshot/,
  )?.[0];
  const postMarkerCall = runner.match(
    /const newProjectId = await createProjectAfterCutover\([\s\S]*?\n\s*\);/,
  )?.[0];
  assert.match(
    postMarkerCall ?? "",
    /scenario\.workspace/,
    "new-project must settle the workspace used by the completed scenario",
  );
  assert.match(
    createProjectFunction ?? "",
    /waitForC2ZcWorkspaceAuthority\(harness, page, workspace\)/,
    "new-project must await the startup workspace authority transition",
  );
  assert.doesNotMatch(
    createProjectFunction ?? "",
    /invokeOk\(page, "open_workspace"/,
    "new-project must not race startup auto-open with a second raw open_workspace",
  );

  const workspace = "/tmp/c2-zc-post-marker-workspace";
  const lifecyclePhases = [
    "switch-requested",
    "quiescence-started",
    "authority-commit",
    "new-scope-hydrated",
  ];
  const makeLifecycleTrace = (
    targetWorkspace = workspace,
    targetRevision = 1,
    targetProjectId = "default-project",
    phases = lifecyclePhases,
  ) =>
    phases.map((phase, sequence) => ({
      schemaVersion: 1,
      transitionId: "workspace:c2-zc-post-marker",
      sequence,
      timestampMs: 1_000 + sequence,
      kind: "workspace",
      phase,
      from: {
        workspacePath: null,
        workspaceOpenRevision: 0,
        projectId: "default-project",
      },
      to: {
        workspacePath: targetWorkspace,
        workspaceOpenRevision: sequence < 2 ? null : targetRevision,
        projectId: sequence < 2 ? null : targetProjectId,
      },
    }));
  const foreignMidTransition = makeLifecycleTrace();
  foreignMidTransition[2] = {
    ...foreignMidTransition[2],
    to: {
      ...foreignMidTransition[2].to,
      workspacePath: "/tmp/foreign-mid-transition-workspace",
    },
  };
  const priorWorkspaceFromTransition = makeLifecycleTrace();
  priorWorkspaceFromTransition[1] = {
    ...priorWorkspaceFromTransition[1],
    from: {
      ...priorWorkspaceFromTransition[1].from,
      workspacePath: "/tmp/prior-workspace",
      workspaceOpenRevision: 7,
    },
  };
  for (const [label, lifecycleTrace] of [
    ["partial transition", makeLifecycleTrace().slice(0, 2)],
    ["foreign workspace", makeLifecycleTrace("/tmp/foreign-workspace")],
    ["foreign mid-transition workspace", foreignMidTransition],
    ["prior workspace in from", priorWorkspaceFromTransition],
    [
      "wrong order",
      makeLifecycleTrace(workspace, 1, "default-project", [
        "switch-requested",
        "quiescence-started",
        "new-scope-hydrated",
        "authority-commit",
      ]),
    ],
    ["invalid revision", makeLifecycleTrace(workspace, "1")],
    ["invalid project", makeLifecycleTrace(workspace, 1, null)],
  ]) {
    const calls = [];
    const harness = {
      async invokeOk(_page, command, payload) {
        calls.push({ command, payload });
        if (command === "open_workspace") {
          throw new Error("raw open_workspace is forbidden in this phase");
        }
        return { projectId: payload.payload.projectId };
      },
      async readLifecycleTrace() {
        return lifecycleTrace;
      },
      async waitUntil(fn) {
        return fn();
      },
    };
    await assert.rejects(
      () => createProjectAfterCutover(harness, {}, workspace),
      /workspace authority transition is not settled|raw open_workspace is forbidden/,
      label,
    );
    assert.deepEqual(
      calls.map(({ command }) => command),
      [],
      `${label} must not call project_create`,
    );
  }

  const calls = [];
  const harness = {
    async invokeOk(_page, command, payload) {
      calls.push({ command, payload });
      if (command === "open_workspace") {
        throw new Error("raw open_workspace is forbidden in this phase");
      }
      return { projectId: payload.payload.projectId };
    },
    async readLifecycleTrace() {
      return makeLifecycleTrace();
    },
    async waitUntil(fn) {
      return fn();
    },
  };
  const projectId = await createProjectAfterCutover(harness, {}, workspace);
  assert.equal(typeof projectId, "string");
  assert.deepEqual(
    calls.map(({ command }) => command),
    ["project_create"],
    "a settled target transition permits exactly one project_create",
  );
});

test("C2-ZC project_create errors propagate without retry after settlement", async () => {
  const calls = [];
  const workspace = "/tmp/c2-zc-post-marker-error-workspace";
  const lifecyclePhases = [
    "switch-requested",
    "quiescence-started",
    "authority-commit",
    "new-scope-hydrated",
  ];
  const lifecycleTrace = lifecyclePhases.map((phase, sequence) => ({
    schemaVersion: 1,
    transitionId: "workspace:c2-zc-post-marker",
    sequence,
    timestampMs: 1_000 + sequence,
    kind: "workspace",
    phase,
    from: {
      workspacePath: null,
      workspaceOpenRevision: 0,
      projectId: "default-project",
    },
    to: {
      workspacePath: workspace,
      workspaceOpenRevision: sequence < 2 ? null : 1,
      projectId: sequence < 2 ? null : "default-project",
    },
  }));
  const harness = {
    async invokeOk(_page, command, payload) {
      calls.push({ command, payload });
      if (command === "project_create") {
        throw new Error(
          "WORKSPACE_SWITCHING: workspace is switching; DB access is temporarily rejected",
        );
      }
      throw new Error("raw open_workspace is forbidden in this phase");
    },
    async readLifecycleTrace() {
      return lifecycleTrace;
    },
    async waitUntil(fn) {
      return fn();
    },
  };

  await assert.rejects(
    () => createProjectAfterCutover(harness, {}, workspace),
    /WORKSPACE_SWITCHING: workspace is switching/,
  );
  assert.deepEqual(
    calls.map(({ command }) => command),
    ["project_create"],
  );
});
