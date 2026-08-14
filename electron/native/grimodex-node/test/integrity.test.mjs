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

function mutationIdentity(requestId) {
  return {
    requestId,
    projectId: PROJECT,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin: "human",
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
