// plot_threads napi 写像の roundtrip + ガード回帰テスト (Electron 移行 Phase 3
// バッチ1)。
//
// grimodex-db::plot_threads を Tauri と共用する napi 写像を、ビルド済み
// grimodex-node.node に対して end-to-end で検証する。特に link_create /
// link_update の **XPROJ ガード**（従来 Electron は FE Drizzle 分岐に落ちて
// 素通ししていた）と phase_type 検証が napi 経由でサーバサイドに効くことを
// gate する。返り値は生の SQLite 行（列名 snake_case）。
//
// 実行: pnpm napi:build 後に `pnpm --dir electron/native/grimodex-node test`
//       (= `node --test test/`)。trash-bin.test.mjs と同様、共有 Backend の
//       状態遷移に依存するため宣言順に直列実行される（順序を変えないこと）。

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

const root = mkdtempSync(join(tmpdir(), "grimodex-node-plot-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));

// plot_threads.project_id は projects(id) への FK。migrate が seed する
// default-project を主プロジェクトに使う。
const PROJECT = "default-project";

async function run(sql, params = []) {
  return JSON.parse(await backend.dbExecute(sql, params, "run"));
}
async function listThreads(projectId = PROJECT) {
  return JSON.parse(await backend.plotThreadList(projectId));
}
async function listLinks(projectId = PROJECT) {
  return JSON.parse(await backend.plotThreadListLinks(projectId));
}

test("workspace 未オープンの plotThreadList は 'No workspace is open' で reject する", async () => {
  await assert.rejects(backend.plotThreadList(PROJECT), (err) => {
    assert.match(String(err.message), /No workspace is open/);
    return true;
  });
});

test("plotThreadCreate → list → update roundtrip（生行 snake_case）", async () => {
  const opened = JSON.parse(await backend.openWorkspace(join(root, "ws")));
  assert.equal(opened.status, "ready");
  assert.equal(opened.workspace.isExisting, false);

  const created = JSON.parse(
    await backend.plotThreadCreate({
      projectId: PROJECT,
      name: "復讐の糸（日本語）",
      color: "#c33",
      description: null,
      sortOrder: "a0",
    }),
  );
  // 作成行は SELECT * の生行（列名 snake_case）— FE normalizeThread が両対応。
  assert.equal(created.project_id, PROJECT);
  assert.equal(created.name, "復讐の糸（日本語）");
  assert.equal(created.color, "#c33");
  assert.equal(created.description, null);
  assert.equal(created.sort_order, "a0");
  assert.ok(typeof created.id === "string" && created.id.length > 0);

  const threads = await listThreads();
  assert.equal(threads.length, 1);
  assert.equal(threads[0].id, created.id);

  // update: name 変更 + description は Option<Option<String>> の値セット。
  const updated = JSON.parse(
    await backend.plotThreadUpdate(created.id, {
      name: "改名した糸",
      description: "説明",
    }),
  );
  assert.equal(updated.name, "改名した糸");
  assert.equal(updated.description, "説明");

  // 空 patch は現行行をそのまま返す（updated_at も変えない契約）。
  const noop = JSON.parse(await backend.plotThreadUpdate(created.id, {}));
  assert.equal(noop.name, "改名した糸");
  assert.equal(noop.updated_at, updated.updated_at);
});

test("plotThreadLinkCreate は phase_type を検証し、正常リンクを作る", async () => {
  // 同 project にシーンを 1 つ用意する。
  await run(
    "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s1', ?, 'scene', 'S1')",
    [PROJECT],
  );
  const [thread] = await listThreads();

  // 不正 phase_type は 'invalid phase_type' で reject（サーバサイド検証）。
  await assert.rejects(
    backend.plotThreadLinkCreate({
      threadId: thread.id,
      nodeId: "s1",
      phaseType: "BOGUS",
      note: null,
      sortOrder: null,
    }),
    (err) => {
      assert.match(String(err.message), /invalid phase_type/);
      return true;
    },
  );

  const link = JSON.parse(
    await backend.plotThreadLinkCreate({
      threadId: thread.id,
      nodeId: "s1",
      phaseType: "introduce",
      note: "伏線",
      sortOrder: null,
    }),
  );
  assert.equal(link.thread_id, thread.id);
  assert.equal(link.node_id, "s1");
  assert.equal(link.phase_type, "introduce");
  assert.equal(link.note, "伏線");

  const links = await listLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0].id, link.id);
});

test("XPROJ ガード: 別 project のシーンへのリンクは reject する（Electron でも効く）", async () => {
  // 別 project p2 とそのシーン s2 を用意。
  await run("INSERT INTO projects (id) VALUES ('p2')");
  await run(
    "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s2', 'p2', 'scene', 'S2')",
  );
  const [thread] = await listThreads(); // default-project のスレッド

  await assert.rejects(
    backend.plotThreadLinkCreate({
      threadId: thread.id,
      nodeId: "s2",
      phaseType: "introduce",
      note: null,
      sortOrder: null,
    }),
    (err) => {
      assert.match(String(err.message), /same project/);
      return true;
    },
  );
});

test("XPROJ ガード: link_update の別 project スレッドへの移動も reject する", async () => {
  // p2 にスレッドを作り、default-project の既存リンクをそこへ移そうとする。
  const p2thread = JSON.parse(
    await backend.plotThreadCreate({
      projectId: "p2",
      name: "p2 のスレッド",
      color: null,
      description: null,
      sortOrder: "a0",
    }),
  );
  const [link] = await listLinks();

  await assert.rejects(
    backend.plotThreadLinkUpdate(link.id, { threadId: p2thread.id }),
    (err) => {
      assert.match(String(err.message), /same project/);
      return true;
    },
  );
});

test("plotThreadBranchCreate は native transaction で XPROJ と durable replay を守る", async () => {
  const from = JSON.parse(
    await backend.plotThreadCreate({
      id: "branch-from-thread",
      projectId: PROJECT,
      name: "分岐元",
      color: null,
      description: null,
      sortOrder: "b0",
    }),
  );
  const to = JSON.parse(
    await backend.plotThreadCreate({
      id: "branch-to-thread",
      projectId: PROJECT,
      name: "分岐先",
      color: null,
      description: null,
      sortOrder: "b1",
    }),
  );
  const payload = {
    id: "branch-napi-request-1",
    projectId: PROJECT,
    fromThreadId: from.id,
    toThreadId: to.id,
    atNodeId: "s1",
    kind: "branch",
  };
  const created = JSON.parse(await backend.plotThreadBranchCreate(payload));
  assert.equal(created.id, payload.id);
  assert.deepEqual(created.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
  const exactReplay = JSON.parse(await backend.plotThreadBranchCreate(payload));
  assert.deepEqual(exactReplay.__idempotency, {
    replayed: true,
    entityPresent: true,
  });

  await assert.rejects(
    backend.plotThreadBranchCreate({ ...payload, kind: "merge" }),
    /PLOT_THREAD_BRANCH_IDEMPOTENCY_CONFLICT/,
  );
  await assert.rejects(
    backend.plotThreadBranchCreate({
      ...payload,
      id: "branch-napi-xproj",
      toThreadId: "p2-thread-missing",
    }),
    /same project/,
  );

  await run("DELETE FROM plot_thread_branches WHERE id = ?", [payload.id]);
  const deletedReplay = JSON.parse(
    await backend.plotThreadBranchCreate(payload),
  );
  assert.deepEqual(deletedReplay.__idempotency, {
    replayed: true,
    entityPresent: false,
  });
  const rows = JSON.parse(
    await backend.dbExecute(
      "SELECT id FROM plot_thread_branches WHERE id = ?",
      [payload.id],
      "all",
    ),
  ).rows;
  assert.deepEqual(rows, []);
  await backend.plotThreadDelete(from.id);
  await backend.plotThreadDelete(to.id);
});

test("plotThreadMoveMarkerBundle は N-API 越しに marker + branch を1回で確定・再送する", async () => {
  await run(
    "INSERT INTO tree_nodes (id, project_id, node_type, title) VALUES ('s-move', ?, 'scene', 'Move')",
    [PROJECT],
  );
  const from = JSON.parse(
    await backend.plotThreadCreate({
      id: "move-from-thread",
      projectId: PROJECT,
      name: "移動元",
      color: null,
      description: null,
      sortOrder: "m0",
    }),
  );
  const to = JSON.parse(
    await backend.plotThreadCreate({
      id: "move-to-thread",
      projectId: PROJECT,
      name: "移動先",
      color: null,
      description: null,
      sortOrder: "m1",
    }),
  );
  const rawLink = JSON.parse(
    await backend.plotThreadLinkCreate({
      id: "move-marker-link",
      threadId: from.id,
      nodeId: "s1",
      phaseType: "turn",
      note: "atomic marker",
      sortOrder: null,
    }),
  );
  const markerBefore = {
    id: rawLink.id,
    threadId: rawLink.thread_id,
    nodeId: rawLink.node_id,
    phaseType: rawLink.phase_type,
    note: rawLink.note,
    sortOrder: rawLink.sort_order,
    createdAt: rawLink.created_at,
    updatedAt: rawLink.updated_at,
  };
  const markerAfter = {
    ...markerBefore,
    threadId: to.id,
    nodeId: "s-move",
    updatedAt: "2026-07-29T04:00:00.000Z",
  };
  const branchAfter = {
    id: "move-marker-branch",
    projectId: PROJECT,
    fromThreadId: from.id,
    toThreadId: to.id,
    atNodeId: "s-move",
    kind: "branch",
    createdAt: "2026-07-29T04:00:00.000Z",
    updatedAt: "2026-07-29T04:00:00.000Z",
  };
  const payload = {
    requestId: "move-marker-request",
    projectId: PROJECT,
    markerBefore,
    markerAfter,
    branchTransitions: [{ before: null, after: branchAfter }],
  };

  const moved = JSON.parse(
    await backend.plotThreadMoveMarkerBundle(payload),
  );
  assert.deepEqual(moved.marker, markerAfter);
  assert.deepEqual(moved.branches, [branchAfter]);
  assert.deepEqual(moved.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
  const replay = JSON.parse(
    await backend.plotThreadMoveMarkerBundle(payload),
  );
  assert.deepEqual(replay.__idempotency, {
    replayed: true,
    entityPresent: true,
  });
  const persisted = JSON.parse(
    await backend.dbExecute(
      `SELECT
         (SELECT thread_id FROM plot_thread_scene_links WHERE id = ?) AS marker_thread,
         (SELECT node_id FROM plot_thread_scene_links WHERE id = ?) AS marker_node,
         (SELECT COUNT(*) FROM plot_thread_branches WHERE id = ?) AS branches`,
      [rawLink.id, rawLink.id, branchAfter.id],
      "get",
    ),
  ).rows[0];
  assert.deepEqual(persisted, {
    marker_thread: to.id,
    marker_node: "s-move",
    branches: 1,
  });

  await backend.plotThreadDelete(from.id);
  await backend.plotThreadDelete(to.id);
});

test("plotThreadRestoreSnapshot / DeleteSnapshot は N-API 経由でも atomic replay を守る", async () => {
  const [sourceThread] = await listThreads();
  const thread = {
    id: "snapshot-napi-thread",
    projectId: PROJECT,
    name: "N-API snapshot",
    color: "#334455",
    description: "restored atomically",
    sortOrder: "c0",
    startNodeId: "s1",
    endNodeId: "s1",
    createdAt: "2026-07-28T03:00:00.000Z",
    updatedAt: "2026-07-28T03:01:00.000Z",
  };
  const link = {
    id: "snapshot-napi-link",
    threadId: thread.id,
    nodeId: "s1",
    phaseType: "turn",
    note: "N-API marker",
    sortOrder: "a0",
    createdAt: "2026-07-28T03:02:00.000Z",
    updatedAt: "2026-07-28T03:03:00.000Z",
  };
  const branch = {
    id: "snapshot-napi-branch",
    projectId: PROJECT,
    fromThreadId: sourceThread.id,
    toThreadId: thread.id,
    atNodeId: "s1",
    kind: "branch",
    createdAt: "2026-07-28T03:04:00.000Z",
    updatedAt: "2026-07-28T03:05:00.000Z",
  };
  const restorePayload = {
    requestId: "snapshot-napi-restore",
    projectId: PROJECT,
    thread,
    links: [link],
    branches: [branch],
  };

  const restored = JSON.parse(
    await backend.plotThreadRestoreSnapshot(restorePayload),
  );
  assert.deepEqual(restored.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
  assert.deepEqual(restored.thread, thread);
  assert.deepEqual(restored.links, [link]);
  assert.deepEqual(restored.branches, [branch]);
  const exactRestore = JSON.parse(
    await backend.plotThreadRestoreSnapshot(restorePayload),
  );
  assert.deepEqual(exactRestore.__idempotency, {
    replayed: true,
    entityPresent: true,
  });

  await run(
    "UPDATE plot_thread_scene_links SET note = 'changed', updated_at = 'changed-at' WHERE id = ?",
    [link.id],
  );
  await assert.rejects(
    backend.plotThreadDeleteSnapshot({
      requestId: "snapshot-napi-delete-stale",
      projectId: PROJECT,
      link,
      branches: [branch],
    }),
    /PLOT_THREAD_DELETE_PRECONDITION_FAILED/,
  );
  const staleLedger = JSON.parse(
    await backend.dbExecute(
      `SELECT request_id FROM idempotency_requests
        WHERE domain = 'plot_thread_delete_snapshot' AND request_id = ?`,
      ["snapshot-napi-delete-stale"],
      "all",
    ),
  ).rows;
  assert.deepEqual(staleLedger, []);
  await run(
    "UPDATE plot_thread_scene_links SET note = ?, updated_at = ? WHERE id = ?",
    [link.note, link.updatedAt, link.id],
  );

  const deletePayload = {
    requestId: "snapshot-napi-delete",
    projectId: PROJECT,
    link,
    branches: [branch],
  };
  const deleted = JSON.parse(
    await backend.plotThreadDeleteSnapshot(deletePayload),
  );
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
  const exactDelete = JSON.parse(
    await backend.plotThreadDeleteSnapshot(deletePayload),
  );
  assert.deepEqual(exactDelete.__idempotency, {
    replayed: true,
    entityPresent: true,
  });

  await backend.plotThreadRestoreSnapshot({
    ...restorePayload,
    requestId: "snapshot-napi-recreate",
    thread: null,
  });
  const staleDelete = JSON.parse(
    await backend.plotThreadDeleteSnapshot(deletePayload),
  );
  assert.deepEqual(staleDelete.__idempotency, {
    replayed: true,
    entityPresent: false,
  });
  const recreatedRows = JSON.parse(
    await backend.dbExecute(
      `SELECT id FROM plot_thread_scene_links WHERE id = ?
       UNION ALL SELECT id FROM plot_thread_branches WHERE id = ?`,
      [link.id, branch.id],
      "all",
    ),
  ).rows;
  assert.deepEqual(recreatedRows, [{ id: link.id }, { id: branch.id }]);

  await backend.plotThreadDelete(thread.id);
});

test("plotThreadLinkDelete / plotThreadDelete は対象を消す", async () => {
  const [link] = await listLinks();
  await backend.plotThreadLinkDelete(link.id);
  assert.deepEqual(await listLinks(), []);

  const [thread] = await listThreads();
  await backend.plotThreadDelete(thread.id);
  assert.deepEqual(await listThreads(), []);
});
