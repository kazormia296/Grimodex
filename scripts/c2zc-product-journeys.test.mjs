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
  assertC2ZcMarkerExactlyOnce,
  assertC2ZcRestartInvariants,
  assertC2ZcRestoreFixtureManifest,
  assertC2ZcRestoreFixtureInput,
  assertC2ZcRestoreLifecycleOrder,
  assertC2ZcVerifyCoverage,
} from "../electron/scripts/c2zc-canonical-product-journey.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");

async function read(relativePath) {
  return readFile(path.join(repoRoot, relativePath), "utf8");
}

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
    semantic: {
      projectId: "project-e1",
      sceneId: "scene-e1",
      ownerRunId: "owner-e1",
      projectCount: 1,
      e0Count: 1,
      completedBackfillCount: 1,
      dependencyEdgeCount: 1,
      edgeStateCount: 0,
      ownerFreshnessCount: 0,
      cursorSettled: true,
      semanticIndexRows: 0,
      sceneSourceRevision: "v1@fixture",
      edgeSourceObjectIdentity: "project:scene:scene-e1",
      edgeReadSetJson: '["v1@fixture"]',
      project: {},
      projectDigest: digest,
      scene: {},
      sceneDigest: digest,
      epoch: {},
      epochDigest: digest,
      backfill: {},
      backfillDigest: digest,
      edge: {},
      edgeDigest: digest,
      feedCursor: {},
      feedCursorDigest: digest,
      derivedStateGap: {},
      semanticIndex: {},
      expectedRestoreLifecycle: {},
      contentsDigest: digest,
    },
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
