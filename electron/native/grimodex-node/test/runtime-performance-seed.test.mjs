import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_PERFORMANCE_FIXTURE,
  buildRuntimePerformanceFixtureForReview,
  buildRuntimeFixtureActualCardinalityQuery,
  buildRuntimeFixtureSeedPayload,
  parseRuntimeFixtureActualCardinality,
} from "../../../scripts/runtime-performance-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));
const root = mkdtempSync(join(tmpdir(), "grimodex-runtime-seed-"));
const backend = new Backend(join(root, "app-data"));
const ownerTokenEnvironment = "GRIMODEX_RUNTIME_PERFORMANCE_OWNER_TOKEN";
const originalOwnerToken = process.env[ownerTokenEnvironment];

process.on("exit", () => {
  if (originalOwnerToken === undefined) {
    delete process.env[ownerTokenEnvironment];
  } else {
    process.env[ownerTokenEnvironment] = originalOwnerToken;
  }
  rmSync(root, { recursive: true, force: true });
});

test("runtimePerformanceSeed is owner-gated, atomic, and side-effect-free", async () => {
  await backend.openWorkspace(join(root, "workspace"));
  const payload = buildRuntimeFixtureSeedPayload();

  delete process.env[ownerTokenEnvironment];
  await assert.rejects(
    backend.runtimePerformanceSeed("owner-token", payload),
    /fixture seed is disabled/,
  );
  process.env[ownerTokenEnvironment] = "owner-token";
  await assert.rejects(
    backend.runtimePerformanceSeed("x".repeat(201), payload),
    /owner token is too long/,
  );
  await assert.rejects(
    backend.runtimePerformanceSeed("wrong-token", payload),
    /owner token mismatch/,
  );

  const result = JSON.parse(
    await backend.runtimePerformanceSeed("owner-token", payload),
  );
  const expectedRows =
    payload.treeNodes.length +
    2 +
    payload.mapNodePositions.length +
    payload.mapEdges.length +
    payload.plotThreads.length +
    payload.plotThreadSceneLinks.length +
    payload.events.length +
    payload.eventRelations.length +
    Number(payload.chatSession !== null) +
    payload.chatMessages.length;
  assert.deepEqual(result, {
    fixtureId: RUNTIME_PERFORMANCE_FIXTURE.id,
    insertedRowCount: expectedRows,
    dbTransactionCount: 1,
    historySideEffectCount: 0,
  });

  const query = buildRuntimeFixtureActualCardinalityQuery();
  const cardinalityRows = JSON.parse(
    await backend.dbExecute(query.sql, query.params, query.method),
  ).rows;
  assert.deepEqual(parseRuntimeFixtureActualCardinality(cardinalityRows), {
    textChars: RUNTIME_PERFORMANCE_FIXTURE.seededTextChars,
    beatCount: RUNTIME_PERFORMANCE_FIXTURE.seededBeatCount,
    treeNodeCount:
      RUNTIME_PERFORMANCE_FIXTURE.collectionSceneCount +
      RUNTIME_PERFORMANCE_FIXTURE.autosaveExtraSceneCount +
      2,
    sceneCount:
      RUNTIME_PERFORMANCE_FIXTURE.collectionSceneCount +
      RUNTIME_PERFORMANCE_FIXTURE.autosaveExtraSceneCount +
      1,
    threadCount: RUNTIME_PERFORMANCE_FIXTURE.timelineThreadCount,
    markerLinkCount: RUNTIME_PERFORMANCE_FIXTURE.timelineMarkerLinkCount,
    eventCount: RUNTIME_PERFORMANCE_FIXTURE.chronicleEventCount,
    mapNodeCount: RUNTIME_PERFORMANCE_FIXTURE.mapNodeCount,
    mapEdgeCount: RUNTIME_PERFORMANCE_FIXTURE.mapEdgeCount,
    chatSessionCount: 0,
    chatMessageCount: 0,
  });

  const historyBefore = JSON.parse(
    await backend.dbExecute(
      `SELECT
        (SELECT COUNT(*) FROM change_events) AS changes,
        (SELECT COUNT(*) FROM undo_journal) AS journals,
        (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
      [],
      "get",
    ),
  ).rows;
  assert.deepEqual(historyBefore, [{ changes: 0, journals: 0, receipts: 0 }]);

  await assert.rejects(
    backend.runtimePerformanceSeed("owner-token", payload),
    /UNIQUE constraint failed/,
  );
  const historyAfter = JSON.parse(
    await backend.dbExecute(
      `SELECT
        (SELECT COUNT(*) FROM change_events) AS changes,
        (SELECT COUNT(*) FROM undo_journal) AS journals,
        (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
      [],
      "get",
    ),
  ).rows;
  assert.deepEqual(historyAfter, historyBefore);

  await backend.openWorkspace(join(root, "timeline-workspace"));
  const timelinePayload = buildRuntimeFixtureSeedPayload(
    buildRuntimePerformanceFixtureForReview(
      "timeline-1k-scenes-100-threads-5k-markers-links",
    ),
  );
  const timelineResult = JSON.parse(
    await backend.runtimePerformanceSeed("owner-token", timelinePayload),
  );
  assert.equal(timelineResult.historySideEffectCount, 0);
  const timelineRows = JSON.parse(
    await backend.dbExecute(
      `SELECT COUNT(*) AS links,
              COUNT(DISTINCT semantic_key) AS distinctKeys,
              SUM(version) AS versionSum
         FROM plot_thread_scene_links`,
      [],
      "get",
    ),
  ).rows;
  assert.deepEqual(timelineRows, [
    { links: 5_000, distinctKeys: 5_000, versionSum: 0 },
  ]);
});
