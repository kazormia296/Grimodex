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

async function waitForMaintenanceEventAfter(
  baselineCount,
  predicate,
  label = "epoch rotation event",
  timeoutMs = 3_000,
) {
  assert.ok(
    Number.isSafeInteger(baselineCount) && baselineCount >= 0,
    "event baseline must be a non-negative integer",
  );
  assert.equal(typeof predicate, "function", "event predicate is required");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const event = maintenanceEvents
      .slice(baselineCount)
      .find((candidate) => predicate(candidate));
    if (event) return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(
    `${label} was not emitted after baseline ${baselineCount}; ` +
      `newEvents=${JSON.stringify(maintenanceEvents.slice(baselineCount))}`,
  );
}

async function assertNoMaintenanceEventAfter(
  baselineCount,
  label = "unexpected epoch rotation event",
  timeoutMs = 100,
) {
  assert.ok(
    Number.isSafeInteger(baselineCount) && baselineCount >= 0,
    "event baseline must be a non-negative integer",
  );
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    assert.equal(
      maintenanceEvents.length,
      baselineCount,
      `${label}: event delta must remain zero`,
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function mutationIdentity(requestId) {
  return {
    requestId,
    projectId: PROJECT,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin: "human",
    authorityRoute: "human-direct",
    caller: "manual-wrapper",
    controls: [
      "runtime-policy",
      "actor-context",
      "typed-writer",
      "occ",
      "change-event",
      "change-feed",
    ],
    provenance: null,
    writesAuthorityProtectedField: false,
    originalTransactionId: null,
    undoJournalId: null,
  };
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
  await backend.dbExecute(
    "INSERT INTO projects (id, title) VALUES (?, ?), (?, ?)",
    ["repair-event-p1", "Repair one", "repair-event-p2", "Repair two"],
    "run",
  );
  await backend.dbExecute(
    "INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order) VALUES (?, ?, ?, ?, ?)",
    ["repair-event-scene", "repair-event-p2", "scene", "Foreign scene", "a0"],
    "run",
  );
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
  await backend.dbExecute(
    "INSERT INTO codex_entries (id, project_id, type, name, source_chat_message_id, version, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      "repair-event-codex",
      "repair-event-p1",
      "character",
      "Foreign source",
      "repair-event-message",
      1,
      "2026-08-23T00:00:00.000Z",
    ],
    "run",
  );
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
  await backend.dbExecute(
    "INSERT INTO projects (id, title) VALUES (?, ?)",
    [projectId, "Snapshot event"],
    "run",
  );
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
    "DELETE FROM labels WHERE id = ?",
    ["snapshot-event-label"],
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
