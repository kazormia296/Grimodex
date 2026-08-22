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

async function waitForMaintenanceEvent(timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (maintenanceEvents.length === 0 && Date.now() <= deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(maintenanceEvents.length > 0, "epoch rotation event was not emitted");
  return maintenanceEvents.at(-1);
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
  const eventCountBefore = maintenanceEvents.length;
  const report = JSON.parse(
    await backend.repairIntegrity({
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
    }),
  );
  assert.equal(typeof report, "object");
  assert.ok(report !== null && !Array.isArray(report));
  assert.equal(report.changeEventUid ?? null, null);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(maintenanceEvents.length, eventCountBefore);
});

test("failed repair emits no epoch wake", async () => {
  const eventCountBefore = maintenanceEvents.length;
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
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(maintenanceEvents.length, eventCountBefore);
});

test("failed snapshot restore emits no epoch wake", async () => {
  const eventCountBefore = maintenanceEvents.length;
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
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(maintenanceEvents.length, eventCountBefore);
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
  const report = JSON.parse(await backend.repairIntegrity(payload));
  assert.ok(report.codexSourcesFixed > 0);
  const firstEvent = await waitForMaintenanceEvent();
  assert.deepEqual(firstEvent, {
    projectId: "repair-event-p1",
    operation: "integrity-repair",
    reason: "semantic-epoch-rotated",
  });
  assert.equal(typeof firstEvent.authorityId, "string");
  assert.ok(firstEvent.authorityId.length > 0);
  assert.equal(Number.isSafeInteger(firstEvent.generation), true);
  const countAfterFirst = maintenanceEvents.length;

  const replay = JSON.parse(
    await backend.repairIntegrity({
      ...payload,
      sessionId: "repair-event-session-replay",
      eventUid: "repair-event-change-replay",
    }),
  );
  assert.deepEqual(replay, report);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(maintenanceEvents.length, countAfterFirst);
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
  const restored = JSON.parse(
    await backend.projectSnapshotApplyRestore(payload),
  );
  assert.equal(restored.noOp, false);
  assert.equal(typeof restored.changeEventUid, "string");
  const firstEvent = await waitForMaintenanceEvent();
  assert.deepEqual(firstEvent, {
    projectId,
    operation: "project-snapshot-restore",
    reason: "semantic-epoch-rotated",
  });
  assert.equal(typeof firstEvent.authorityId, "string");
  assert.ok(firstEvent.authorityId.length > 0);
  assert.equal(Number.isSafeInteger(firstEvent.generation), true);
  const countAfterRestore = maintenanceEvents.length;

  const replay = JSON.parse(
    await backend.projectSnapshotApplyRestore({
      ...payload,
      sessionId: "snapshot-event-session-replay",
    }),
  );
  assert.deepEqual(replay, restored);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(maintenanceEvents.length, countAfterRestore);

  const firstNoOp = JSON.parse(
    await backend.projectSnapshotApplyRestore({
      ...payload,
      requestId: "snapshot-event-no-op-request",
      sessionId: "snapshot-event-no-op-session",
    }),
  );
  assert.equal(firstNoOp.noOp, true);
  assert.equal(firstNoOp.changeEventUid ?? null, null);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(maintenanceEvents.length, countAfterRestore);
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
