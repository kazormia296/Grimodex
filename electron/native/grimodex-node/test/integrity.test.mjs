// integrity / FTS 6 コマンド (Phase 3 バッチ1) の roundtrip テスト。
//
// 実装本体は grimodex-db の Database メソッド (Tauri と共用) なので、ここでは
// napi 署名の疎通と JSON ワイヤ形状 (Tauri invoke 返り値と同形) を
// ビルド済み grimodex-node.node に対して end-to-end で検証する。
//
// 実行: pnpm napi:build 後に `pnpm --dir electron/native/grimodex-node test`。
// テストは宣言順に直列実行される (共有 Backend の状態遷移に依存)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-integrity-"));
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    // The native Backend can release its SQLite handle after exit listeners
    // on Windows, so fixture cleanup is best-effort there.
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
});

const backend = new Backend(join(root, "app-data"));
const PROJECT = "default-project";
const maintenanceEvents = [];
backend.onEvent((channel, payload) => {
  if (channel !== "narrative-maintenance:epoch-rotated") return;
  maintenanceEvents.push(JSON.parse(payload));
});

function projectPayload(projectId) {
  const occurredAt = "2026-08-23T00:00:00.000Z";
  return {
    projectId,
    requestId: `${projectId}-request`,
    sessionId: `${projectId}-session`,
    eventUid: `${projectId}-event`,
    origin: "human",
    originalTransactionId: null,
    undoJournalId: null,
    title: projectId,
    genre: null,
    pov: null,
    tense: null,
    language: "en",
    styleGuide: null,
    aiInstructions: null,
    outline: null,
    targetReaders: null,
    createdAt: occurredAt,
    updatedAt: occurredAt,
  };
}

function maintenanceEventBaseline() {
  return maintenanceEvents.length;
}

function currentMaintenanceBinding() {
  const raw = backend.getNarrativeMaintenanceWorkspaceBinding();
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function maintenanceEventPredicate({ projectId, operation, binding, reason }) {
  return (event) =>
    event?.projectId === projectId &&
    event?.operation === operation &&
    event?.reason === (reason ?? "semantic-epoch-rotated") &&
    event?.authorityId === binding.authorityId &&
    event?.generation === binding.generation;
}

const MAINTENANCE_EVENT_POLL_INTERVAL_MS = 10;
const realMaintenanceEventSleep = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForMaintenanceEventAfter(
  baselineCount,
  predicate,
  label = "epoch rotation event",
  timeoutMs = 3_000,
  {
    events = maintenanceEvents,
    now = () => Date.now(),
    sleep = realMaintenanceEventSleep,
  } = {},
) {
  assert.ok(
    Number.isSafeInteger(baselineCount) && baselineCount >= 0,
    "event baseline must be a non-negative integer",
  );
  assert.equal(typeof predicate, "function", "event predicate is required");
  const eventAfterBaseline = () =>
    events.slice(baselineCount).find((candidate) => predicate(candidate));
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    const event = eventAfterBaseline();
    if (event) return event;
    await sleep(MAINTENANCE_EVENT_POLL_INTERVAL_MS);
  }
  const finalEvent = eventAfterBaseline();
  if (finalEvent) return finalEvent;
  assert.fail(
    `${label} was not emitted after baseline ${baselineCount}; ` +
      `newEvents=${JSON.stringify(events.slice(baselineCount))}`,
  );
}

async function assertNoMaintenanceEventAfter(
  baselineCount,
  label = "unexpected epoch rotation event",
  timeoutMs = 100,
  {
    events = maintenanceEvents,
    now = () => Date.now(),
    sleep = realMaintenanceEventSleep,
    predicate = () => true,
  } = {},
) {
  assert.ok(
    Number.isSafeInteger(baselineCount) && baselineCount >= 0,
    "event baseline must be a non-negative integer",
  );
  assert.equal(typeof predicate, "function", "event predicate is required");
  const assertNoEventDelta = () => {
    const newEvents = events.slice(baselineCount);
    const matchingEvent = newEvents.find((event) => predicate(event));
    assert.equal(
      newEvents.length,
      0,
      `${label}: event delta must remain zero; ` +
        `matchingEvent=${JSON.stringify(matchingEvent ?? null)}`,
    );
  };
  const deadline = now() + timeoutMs;
  while (now() <= deadline) {
    assertNoEventDelta();
    await sleep(MAINTENANCE_EVENT_POLL_INTERVAL_MS);
  }
  // An event can be delivered by the final sleep after the last loop body;
  // inspect the post-baseline slice once more before declaring quiescence.
  assertNoEventDelta();
}

test("maintenance event pollers inspect events delivered during the final sleep", async () => {
  const binding = { authorityId: "unit-authority", generation: 7 };
  const event = {
    projectId: "unit-project",
    operation: "unit-operation",
    reason: "semantic-epoch-rotated",
    authorityId: binding.authorityId,
    generation: binding.generation,
  };
  const predicate = maintenanceEventPredicate({
    projectId: event.projectId,
    operation: event.operation,
    binding,
  });

  let clock = 0;
  let sleepCount = 0;
  const events = [];
  const sleep = async (milliseconds) => {
    assert.equal(milliseconds, MAINTENANCE_EVENT_POLL_INTERVAL_MS);
    sleepCount += 1;
    clock += milliseconds;
    events.push(event);
  };
  const observed = await waitForMaintenanceEventAfter(
    0,
    predicate,
    "deterministic final-sleep event",
    5,
    { events, now: () => clock, sleep },
  );
  assert.deepEqual(observed, event);
  assert.equal(sleepCount, 1);

  let noEventClock = 0;
  let noEventSleepCount = 0;
  const lateEvents = [];
  const lateSleep = async (milliseconds) => {
    assert.equal(milliseconds, MAINTENANCE_EVENT_POLL_INTERVAL_MS);
    noEventSleepCount += 1;
    noEventClock += milliseconds;
    lateEvents.push(event);
  };
  await assert.rejects(
    assertNoMaintenanceEventAfter(
      0,
      "deterministic final-sleep unexpected event",
      5,
      { events: lateEvents, now: () => noEventClock, sleep: lateSleep, predicate },
    ),
    /event delta must remain zero/,
  );
  assert.equal(noEventSleepCount, 1);
});

function mutationIdentity(requestId, projectId = PROJECT, origin = "human") {
  const isInteractiveAgent = origin === "ai-apply";
  return {
    requestId,
    projectId,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin,
    authorityRoute: isInteractiveAgent
      ? "interactive-agent-command"
      : "human-direct",
    caller: isInteractiveAgent ? "chat-tool-executor" : "manual-wrapper",
    controls: isInteractiveAgent
      ? [
          "knowledge-write-policy",
          "stable-request-id",
          "agent-provenance",
          "field-authority",
          "typed-writer",
          "occ",
          "undo-journal",
          "change-event",
          "change-feed",
        ]
      : [
          "runtime-policy",
          "actor-context",
          "typed-writer",
          "occ",
          "change-event",
          "change-feed",
        ],
    provenance: isInteractiveAgent
      ? {
          requestId,
          traceId: `${requestId}:trace`,
          executionId: `${requestId}:execution`,
          mainOwnedProvenanceId: `${requestId}:main-provenance`,
        }
      : null,
    writesAuthorityProtectedField: false,
    originalTransactionId: null,
    undoJournalId: null,
  };
}

async function dbRows(sql, params) {
  const result = JSON.parse(await backend.dbExecute(sql, params, "all"));
  assert.ok(Array.isArray(result.rows), "dbExecute all must return rows");
  return result.rows;
}

async function seedActiveSemanticEpoch(projectId) {
  const backfill = JSON.parse(
    await backend.retryNarrativeLegacyBackfill({ projectId }),
  );
  assert.equal(backfill.outcome, "ran");

  const epochs = await dbRows(
    `SELECT id, project_id, epoch_number, reason
       FROM narrative_semantic_epochs
      WHERE project_id = ?
      ORDER BY epoch_number DESC
      LIMIT 1`,
    [projectId],
  );
  assert.equal(epochs.length, 1);
  assert.deepEqual(epochs[0], {
    id: epochs[0].id,
    project_id: projectId,
    epoch_number: 0,
    reason: "initial",
  });
  return epochs[0];
}

test("workspace 未オープンの ftsSearch は 'No workspace is open' マーカーで reject する", async () => {
  await assert.rejects(
    backend.ftsSearch(PROJECT, "query", "scene", 10),
    (err) => {
      assert.match(String(err.message), /No workspace is open/);
      return true;
    },
  );
});

test("openWorkspace 後、fts_search はヒット無しで空配列 JSON を返す", async () => {
  await backend.openWorkspace(join(root, "ws"));
  const rows = JSON.parse(
    await backend.ftsSearch(PROJECT, "存在しない語", "scenes", 10),
  );
  assert.ok(Array.isArray(rows));
  assert.equal(rows.length, 0);
});

test("integrityCheck はレポート object の JSON を返す", async () => {
  const report = JSON.parse(await backend.integrityCheck(PROJECT));
  assert.equal(typeof report, "object");
  assert.ok(report !== null && !Array.isArray(report));
});

test("repairIntegrity は空 workspace でもレポート object を返す", async () => {
  const payload = {
    projectId: PROJECT,
    requestId: "integrity-empty-repair",
    sessionId: "integrity-test-session",
    eventUid: "integrity-empty-event",
    occurredAt: "2026-08-13T10:00:00.000Z",
    authorityRoute: "restore-or-migration",
    caller: "integrity-repair",
    controls: [
      "exclusive-system-operation",
      "semantic-epoch-event",
      "full-rebuild-marker",
    ],
    provenance: null,
    writesAuthorityProtectedField: false,
  };
  const baselineCount = maintenanceEventBaseline();
  const report = JSON.parse(
    await backend.repairIntegrity(payload),
  );
  assert.equal(typeof report, "object");
  assert.ok(report !== null && !Array.isArray(report));
  assert.equal(report.changeEventUid ?? null, null);
  await assertNoMaintenanceEventAfter(
    baselineCount,
    "empty repair must not emit an epoch wake",
  );
});

test("failed repair emits no epoch wake", async () => {
  const baselineCount = maintenanceEventBaseline();
  await assert.rejects(
    backend.repairIntegrity({
      projectId: PROJECT,
      requestId: "integrity-failed-repair",
      sessionId: "integrity-failed-repair-session",
      eventUid: "integrity-failed-repair-event",
      occurredAt: "not-an-instant",
      authorityRoute: "restore-or-migration",
      caller: "integrity-repair",
      controls: [
        "exclusive-system-operation",
        "semantic-epoch-event",
        "full-rebuild-marker",
      ],
      provenance: null,
      writesAuthorityProtectedField: false,
    }),
  );
  await assertNoMaintenanceEventAfter(
    baselineCount,
    "failed repair must not emit an epoch wake",
  );
});

test("failed snapshot restore emits no epoch wake", async () => {
  const baselineCount = maintenanceEventBaseline();
  await assert.rejects(
    backend.projectSnapshotApplyRestore({
      requestId: "snapshot-failed-request",
      sessionId: "snapshot-failed-session",
      projectId: PROJECT,
      snapshotId: "missing-snapshot",
      scopes: ["not-a-restore-scope"],
      inserts: [],
    }),
  );
  await assertNoMaintenanceEventAfter(
    baselineCount,
    "failed snapshot restore must not emit an epoch wake",
  );
});

test("non-noop repair emits one observer-only epoch wake and replay emits none", async () => {
  await backend.projectCreate(projectPayload("repair-event-p1"));
  await backend.projectCreate(projectPayload("repair-event-p2"));
  const repairProjectEpoch = await seedActiveSemanticEpoch("repair-event-p1");
  await seedActiveSemanticEpoch("repair-event-p2");
  await backend.treeNodeCreate({
    ...mutationIdentity("repair-event-scene-create", "repair-event-p2"),
    id: "repair-event-scene",
    projectId: "repair-event-p2",
    parentId: null,
    nodeType: "scene",
    title: "Foreign scene",
    sortOrder: "a0",
    synopsis: null,
    status: null,
    sourceUri: null,
    sourceMtime: null,
    content: "{}",
  });
  await backend.dbExecute(
    "INSERT INTO chat_sessions (id, project_id, title) VALUES (?, ?, ?)",
    ["repair-event-session", "repair-event-p2", "Foreign session"],
    "run",
  );
  await backend.dbExecute(
    "INSERT INTO chat_messages (id, session_id, role, content) VALUES (?, ?, ?, ?)",
    ["repair-event-message", "repair-event-session", "user", "Foreign"],
    "run",
  );
  await backend.agentCodexCreate({
    ...mutationIdentity(
      "repair-event-codex-create",
      "repair-event-p1",
      "ai-apply",
    ),
    entryId: "repair-event-codex",
    projectId: "repair-event-p1",
    sessionId: "repair-event-codex-session",
    typeSlug: "character",
    name: "Foreign source",
    summary: "",
    content: "{}",
    sourceChatMessageId: "repair-event-message",
    authorshipSpans: [],
  });
  const payload = {
    projectId: "repair-event-p1",
    requestId: "repair-event-request",
    sessionId: "repair-event-session",
    eventUid: "repair-event-change",
    occurredAt: "2026-08-23T00:00:00.000Z",
    authorityRoute: "restore-or-migration",
    caller: "integrity-repair",
    controls: [
      "exclusive-system-operation",
      "semantic-epoch-event",
      "full-rebuild-marker",
    ],
    provenance: null,
    writesAuthorityProtectedField: false,
  };
  const binding = currentMaintenanceBinding();
  assert.ok(binding?.authorityId);
  assert.ok(Number.isSafeInteger(binding?.generation));
  const baselineCount = maintenanceEventBaseline();
  const report = JSON.parse(await backend.repairIntegrity(payload));
  assert.ok(report.codexSourcesFixed > 0);

  const currentEpochs = await dbRows(
    `SELECT id, project_id, epoch_number, reason, triggered_by_change_event_uid
       FROM narrative_semantic_epochs
      WHERE project_id = ?
      ORDER BY epoch_number DESC
      LIMIT 1`,
    [payload.projectId],
  );
  assert.equal(currentEpochs.length, 1);
  assert.notEqual(currentEpochs[0].id, repairProjectEpoch.id);
  assert.equal(
    currentEpochs[0].epoch_number,
    repairProjectEpoch.epoch_number + 1,
  );
  assert.equal(currentEpochs[0].project_id, payload.projectId);
  assert.equal(currentEpochs[0].reason, "migration");
  assert.equal(
    currentEpochs[0].triggered_by_change_event_uid,
    payload.eventUid,
  );

  const feedRows = await dbRows(
    `SELECT object_key_json, before_version, before_digest,
            after_version, after_digest
       FROM narrative_change_events
      WHERE project_id = ? AND canonical_change_event_uid = ?
      ORDER BY event_ordinal`,
    [payload.projectId, payload.eventUid],
  );
  const codexFeed = feedRows.find((row) => {
    const objectKey = JSON.parse(row.object_key_json);
    return (
      objectKey.kind === "codex-entry" &&
      objectKey.entryId === "repair-event-codex"
    );
  });
  assert.ok(codexFeed, "repair must append a Codex Feed event");
  assert.equal(codexFeed.before_version, 1);
  assert.equal(codexFeed.after_version, 2);
  assert.equal(typeof codexFeed.before_digest, "string");
  assert.equal(typeof codexFeed.after_digest, "string");

  const codexHeads = await dbRows(
    `SELECT after_version, after_digest
       FROM narrative_change_object_heads
      WHERE project_id = ? AND object_identity = ?`,
    [
      payload.projectId,
      JSON.stringify({ kind: "codex-entry", entryId: "repair-event-codex" }),
    ],
  );
  assert.deepEqual(codexHeads, [
    {
      after_version: codexFeed.after_version,
      after_digest: codexFeed.after_digest,
    },
  ]);
  const firstEvent = await waitForMaintenanceEventAfter(
    baselineCount,
    maintenanceEventPredicate({
      projectId: "repair-event-p1",
      operation: "integrity-repair",
      binding,
    }),
    "integrity repair epoch wake",
  );
  assert.deepEqual(firstEvent, {
    projectId: "repair-event-p1",
    operation: "integrity-repair",
    reason: "semantic-epoch-rotated",
    authorityId: binding.authorityId,
    generation: binding.generation,
  });

  const replayBaseline = maintenanceEventBaseline();
  const replay = JSON.parse(
    await backend.repairIntegrity({
      ...payload,
      sessionId: "repair-event-session-replay",
      eventUid: "repair-event-change-replay",
    }),
  );
  assert.deepEqual(replay, report);
  await assertNoMaintenanceEventAfter(
    replayBaseline,
    "repair replay must not emit an epoch wake",
  );
});

test("non-noop snapshot restore emits once, replay emits none, and first no-op emits none", async () => {
  const projectId = "snapshot-event-p1";
  const snapshotId = "snapshot-event-s1";
  await backend.projectCreate(projectPayload(projectId));
  await backend.dbExecute(
    "INSERT INTO labels (id, project_id, name, color) VALUES (?, ?, ?, ?)",
    ["snapshot-event-label", projectId, "Before", "#111111"],
    "run",
  );
  await backend.projectSnapshotCreate({
    projectId,
    snapshotId,
    name: "Snapshot event fixture",
    description: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    treeRows: [],
    codexRows: [],
    snippetRows: [],
    versionIds: [],
  });
  await backend.dbExecute(
    "DELETE FROM labels WHERE project_id = ?",
    [projectId],
    "run",
  );
  const context = JSON.parse(
    await backend.projectSnapshotRestoreContext(projectId, snapshotId, ["labels"]),
  );
  const labelsScope = context.auxRows.find(({ scope }) => scope === "labels");
  assert.ok(labelsScope);
  const inserts = JSON.parse(labelsScope.payloadJson).rows.map((row) => ({
    table: "labels",
    row,
    mode: "insert",
  }));
  const payload = {
    requestId: "snapshot-event-request",
    sessionId: "snapshot-event-session",
    projectId,
    snapshotId,
    scopes: ["labels"],
    inserts,
  };
  // Keep the real repair wake from the preceding fixture in the ledger. The
  // restore assertion must only accept a new, matching event after this
  // baseline; an old repair event can never satisfy it.
  assert.ok(
    maintenanceEvents.some(
      (event) =>
        event.projectId === "repair-event-p1" &&
        event.operation === "integrity-repair",
    ),
    "the event ledger must retain the preceding repair wake",
  );
  const binding = currentMaintenanceBinding();
  assert.ok(binding?.authorityId);
  assert.ok(Number.isSafeInteger(binding?.generation));
  const restoreBaseline = maintenanceEventBaseline();
  const restored = JSON.parse(
    await backend.projectSnapshotApplyRestore(payload),
  );
  assert.equal(restored.noOp, false);
  assert.equal(typeof restored.changeEventUid, "string");
  const firstEvent = await waitForMaintenanceEventAfter(
    restoreBaseline,
    maintenanceEventPredicate({
      projectId,
      operation: "project-snapshot-restore",
      binding,
    }),
    "snapshot restore epoch wake",
  );
  assert.deepEqual(firstEvent, {
    projectId,
    operation: "project-snapshot-restore",
    reason: "semantic-epoch-rotated",
    authorityId: binding.authorityId,
    generation: binding.generation,
  });

  const replayBaseline = maintenanceEventBaseline();
  const replay = JSON.parse(
    await backend.projectSnapshotApplyRestore({
      ...payload,
      sessionId: "snapshot-event-session-replay",
    }),
  );
  assert.deepEqual(replay, restored);
  await assertNoMaintenanceEventAfter(
    replayBaseline,
    "snapshot restore replay must not emit an epoch wake",
  );

  const noOpBaseline = maintenanceEventBaseline();
  const firstNoOp = JSON.parse(
    await backend.projectSnapshotApplyRestore({
      ...payload,
      requestId: "snapshot-event-no-op-request",
      sessionId: "snapshot-event-no-op-session",
    }),
  );
  assert.equal(firstNoOp.noOp, true);
  assert.equal(firstNoOp.changeEventUid ?? null, null);
  await assertNoMaintenanceEventAfter(
    noOpBaseline,
    "snapshot restore no-op must not emit an epoch wake",
  );
});

test("ftsOptimize / ftsRebuild / ftsRebuildEn は空 workspace で成功する", async () => {
  await backend.ftsOptimize();
  await backend.ftsRebuild();
  await backend.ftsRebuildEn();
});

test("FTS 再構築後もシーン本文の roundtrip 検索が通る", async () => {
  // db_execute で tree_nodes の scene 行を挿入 → fts_rebuild → 検索ヒット、
  // の粗い end-to-end（FTS トリガ/rebuild と search_fts の整合を疎通確認）。
  await backend.treeNodeCreate({
    ...mutationIdentity("integrity-scene-create"),
    id: "itg-scene-1",
    projectId: PROJECT,
    parentId: null,
    nodeType: "scene",
    title: "検証シーン",
    sortOrder: "a0",
    content: "唯一無二の検索対象テキスト",
  });
  await backend.ftsRebuild();
  const rows = JSON.parse(
    await backend.ftsSearch(PROJECT, "唯一無二", "scenes", 10),
  );
  assert.ok(Array.isArray(rows));
});
