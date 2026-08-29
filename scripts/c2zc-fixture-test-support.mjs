import { createHash } from "node:crypto";

export function stableFixtureJson(value) {
  if (Array.isArray(value))
    return `[${value.map(stableFixtureJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableFixtureJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function fixtureDigest(value) {
  return `sha256:${createHash("sha256")
    .update(stableFixtureJson(value), "utf8")
    .digest("hex")}`;
}

export function createC2ZcFixtureSemantic({
  projectId = "project-e1",
  sceneId = "scene-e1",
  applicationId = "application-e1",
  applyRunId = "owner-e1",
  backfillRunId = "backfill-e1",
  sceneSourceRevision = "v1@fixture",
} = {}) {
  const edgeSourceObjectIdentity = `project:scene:${sceneId}`;
  const edgeReadSetJson = JSON.stringify([sceneSourceRevision]);
  const eventId = `${applyRunId}-event`;
  const createdAt = "2026-08-29T00:00:01.000Z";
  const completedAt = "2026-08-29T00:00:02.000Z";
  const semantic = {
    projectId,
    sceneId,
    applicationId,
    applyRunId,
    backfillRunId,
    projectCount: 1,
    sceneCount: 1,
    e0Count: 1,
    completedBackfillCount: 1,
    dependencyEdgeCount: 2,
    applicationCount: 1,
    legacyProjectionFreshnessCount: 1,
    legacyProjectionDependencyCount: 1,
    applicationEdgeCount: 1,
    applicationEdgeStateCount: 0,
    applicationFreshnessCount: 0,
    cursorSettled: true,
    semanticIndexRows: 0,
    sceneSourceRevision,
    edgeSourceObjectIdentity,
    edgeReadSetJson,
    project: { id: projectId, title: "Fixture project" },
    scene: { id: sceneId, projectId },
    epoch: {
      rows: [
        {
          id: "e0",
          projectId,
          epochNumber: 0,
          reason: "initial",
          triggeredByChangeEventUid: null,
          createdAt,
        },
      ],
    },
    backfill: { rows: [{ id: backfillRunId, projectId, status: "completed" }] },
    application: {
      id: applicationId,
      commitId: `${applyRunId}-commit`,
      projectId,
      runId: applyRunId,
      runStatus: "completed",
      proposalSetId: `${applyRunId}-proposal-set`,
      requestId: `${applyRunId}-prepare`,
      planDigest: "c2zc-restore-fixture-plan",
      commitStatus: "applied",
      sessionId: `${applyRunId}-session`,
      commitCreatedAt: createdAt,
      completedAt,
      commitVersion: 1,
      proposalId: `${applyRunId}-proposal`,
      revisionId: `${applyRunId}-revision`,
      appliedEntityKind: "event",
      appliedEntityId: eventId,
      eventId,
      createdAt,
      applicationKind: "normal",
      compensatesApplicationId: null,
    },
    legacyProjection: {
      freshness: {
        applicationId,
        status: "fresh",
        reasonJson: null,
        version: 0,
        updatedAt: "2026-08-29T00:00:01.000Z",
      },
      dependencies: [
        {
          sourceKind: "scene-body",
          sourceKey: edgeSourceObjectIdentity,
          observedRevisionToken: sceneSourceRevision,
          propagation: "freshness-only",
        },
      ],
    },
    edge: {
      id: "edge-e1",
      projectId,
      consumerKind: "application",
      consumerKey: applicationId,
      sourceObjectIdentity: edgeSourceObjectIdentity,
      readSetJson: edgeReadSetJson,
      generatedByTransactionId: null,
      createdAt,
      owningRunId: backfillRunId,
    },
    feedCursor: {
      feedHead: 1,
      cursor: {
        projectId,
        consumerId: "narrative-incremental-freshness/v1",
        acknowledgedThroughSequence: 1,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastError: null,
        updatedAt: completedAt,
      },
    },
    derivedStateGap: {
      applicationEdgeStateRows: 0,
      applicationFreshnessRows: 0,
      genericApplicationRows: 0,
      rebuildScope:
        "narrative_dependency_edge_states+narrative_consumer_freshness",
    },
    semanticIndex: {
      metadataRows: 0,
      activeD1HeadRows: 0,
      v1EdgeRows: 0,
      consumerFreshnessRows: 0,
      totalRows: 0,
    },
    expectedRestoreLifecycle: {
      firstVerify: "rebuild-required",
      conditionalRebuild: "required",
      confirmationVerify: "clean",
      marker: "after-confirmation-verify",
    },
  };
  return refreshC2ZcFixtureSemanticDigests(semantic);
}

function semanticContentsPayload(semantic) {
  return {
    projectId: semantic.projectId,
    sceneId: semantic.sceneId,
    applicationId: semantic.applicationId,
    applyRunId: semantic.applyRunId,
    backfillRunId: semantic.backfillRunId,
    projectCount: semantic.projectCount,
    sceneCount: semantic.sceneCount,
    e0Count: semantic.e0Count,
    completedBackfillCount: semantic.completedBackfillCount,
    dependencyEdgeCount: semantic.dependencyEdgeCount,
    applicationCount: semantic.applicationCount,
    legacyProjectionFreshnessCount: semantic.legacyProjectionFreshnessCount,
    legacyProjectionDependencyCount: semantic.legacyProjectionDependencyCount,
    applicationEdgeCount: semantic.applicationEdgeCount,
    applicationEdgeStateCount: semantic.applicationEdgeStateCount,
    applicationFreshnessCount: semantic.applicationFreshnessCount,
    cursorSettled: semantic.cursorSettled,
    semanticIndexRows: semantic.semanticIndexRows,
    sceneSourceRevision: semantic.sceneSourceRevision,
    edgeSourceObjectIdentity: semantic.edgeSourceObjectIdentity,
    edgeReadSetJson: semantic.edgeReadSetJson,
    project: semantic.project,
    scene: semantic.scene,
    epoch: semantic.epoch,
    backfill: semantic.backfill,
    application: semantic.application,
    legacyProjection: semantic.legacyProjection,
    edge: semantic.edge,
    feedCursor: semantic.feedCursor,
    derivedStateGap: semantic.derivedStateGap,
    semanticIndex: semantic.semanticIndex,
    expectedRestoreLifecycle: semantic.expectedRestoreLifecycle,
  };
}

export function refreshC2ZcFixtureSemanticDigests(semantic) {
  for (const field of [
    "project",
    "scene",
    "epoch",
    "backfill",
    "application",
    "legacyProjection",
    "edge",
    "feedCursor",
    "derivedStateGap",
    "semanticIndex",
    "expectedRestoreLifecycle",
  ]) {
    semantic[`${field}Digest`] = fixtureDigest(semantic[field]);
  }
  semantic.contentsDigest = fixtureDigest(semanticContentsPayload(semantic));
  return semantic;
}

export function createC2ZcFixtureManifest({
  candidate = {
    requested: "HEAD",
    resolvedHeadSha: "b".repeat(40),
    resolvedTreeSha: "c".repeat(40),
    headSha: "b".repeat(40),
    treeSha: "c".repeat(40),
    clean: true,
    statusSha256: `sha256:${"a".repeat(64)}`,
  },
  semantic,
  fixtureSha256 = `sha256:${"a".repeat(64)}`,
  fixtureSizeBytes = 10,
  schemaVersion = 1,
  fixturePath = "c2-zc-fixture.backup.db",
  databasePath = "c2-zc-fixture.db",
  builderCommand = ["c2zc-restore-fixture", "build"],
} = {}) {
  return {
    manifestVersion: 1,
    contractVersion: 1,
    schemaVersion,
    databaseSchemaVersion: schemaVersion,
    c2zcMarkerPresent: false,
    candidate,
    builderVersion: "c2zc-restore-fixture-builder/v1",
    builderCommand,
    exactBuilderCommand: [...builderCommand],
    artifacts: {
      fixture: {
        path: fixturePath,
        sha256: fixtureSha256,
        sizeBytes: fixtureSizeBytes,
      },
      database: {
        path: databasePath,
        sha256: fixtureSha256,
        sizeBytes: fixtureSizeBytes,
      },
    },
    fixtureSha256,
    fixtureSizeBytes,
    semantic: semantic ?? createC2ZcFixtureSemantic(),
  };
}
