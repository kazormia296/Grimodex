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
  assertProductJourneySelectionBinding,
  resolveProductJourneySet,
  PRODUCT_JOURNEYS,
} from "../electron/scripts/product-journeys.mjs";
import {
  C2ZC_CANONICAL_PRODUCT_JOURNEY_PHASES,
  C2ZC_PRODUCT_JOURNEY_ID,
  C2ZC_RESTORE_FIXTURE_ENV,
  C2ZC_VERIFY_COVERAGE_COUNT,
  assertC2ZcFixtureCandidateBinding,
  assertC2ZcFixtureApplicationParity,
  assertC2ZcFindingRowsResolved,
  assertC2ZcMarkerExactlyOnce,
  assertC2ZcPostMarkerApplicationPersistence,
  assertC2ZcProjectInventory,
  assertC2ZcRestartInvariants,
  assertC2ZcRestoreFixtureManifest,
  assertC2ZcRestoreFixtureInput,
  assertC2ZcRestoreLifecycleOrder,
  assertC2ZcFeedCursorSettled,
  assertC2ZcVerifyCoverage,
  readC2ZcAuthoritySnapshot,
} from "../electron/scripts/c2zc-canonical-product-journey.mjs";
import {
  createC2ZcFixtureManifest,
  createC2ZcFixtureSemantic,
  refreshC2ZcFixtureSemanticDigests,
} from "./c2zc-fixture-test-support.mjs";

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
    () => assertC2ZcFeedCursorSettled(snapshot, { epochId: "e1" }),
    /cursor|acknowledged|active|epoch/i,
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
  assert.match(source, /restoreBackupThroughSettingsUi/);
  assert.match(source, /assertC2ZcVerifyCoverage/);
  const journeyBody = source.slice(
    source.indexOf("export async function runC2ZcCanonicalAuthorityJourney"),
  );
  assert.match(journeyBody, /assertC2ZcProjectInventory/);
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
  assert.doesNotMatch(source, /manifest\.(verifyOutcome|rustOutcome)/);
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

test("Verify coverage compares values from the Rust outcome without a JS check catalogue", () => {
  const rustOutcome = {
    checkCoverage: {
      complete: true,
      required: Array.from({ length: 13 }, (_, index) => `rust-${index}`),
      covered: Array.from({ length: 13 }, (_, index) => `rust-${index}`),
      missing: [],
    },
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
        checkCoverage: { ...rustOutcome.checkCoverage, covered: [] },
      }),
    /coverage|13|Rust/i,
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
  const checkCoverage = {
    complete: true,
    required: Array.from({ length: 13 }, (_, index) => `rust-${index}`),
    covered: Array.from({ length: 13 }, (_, index) => `rust-${index}`),
    missing: [],
  };
  const runs = [
    {
      id: "verify-1",
      runKind: "dependency-verify",
      status: "completed",
      semanticEpochId: "e1",
      outcomeSummaryJson: { report: { rebuildRequired: true }, checkCoverage },
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
      outcomeSummaryJson: { report: { rebuildRequired: false }, checkCoverage },
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
  const coverage = {
    complete: true,
    required: Array.from({ length: 13 }, (_, index) => `rust-check-${index}`),
    covered: Array.from({ length: 13 }, (_, index) => `rust-check-${index}`),
    missing: [],
  };
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
        checkCoverage: coverage,
      }),
      run("rebuild-1", "semantic-index-rebuild", times[3]),
      run("verify-2", "dependency-verify", times[6], {
        report: productionVerifyReport(),
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
      /coverage|check|issue|consistent|semantic|zero|13|application|incomplete/i,
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
