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

function mutationIdentity(requestId, projectId = PROJECT, origin = "human") {
  const isRestore = origin === "restore" || origin === "migration";
  return {
    requestId,
    projectId,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin,
    authorityRoute: isRestore ? "restore-or-migration" : "human-direct",
    caller: isRestore ? "restore-controller" : "manual-wrapper",
    controls: isRestore
      ? [
          "exclusive-system-operation",
          "semantic-epoch-event",
          "full-rebuild-marker",
        ]
      : [
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

async function listThreads(projectId = PROJECT) {
  return JSON.parse(await backend.plotThreadList(projectId));
}
async function listLinks(projectId = PROJECT) {
  return JSON.parse(await backend.plotThreadListLinks(projectId));
}

async function createProject(projectId) {
  const occurredAt = "2026-08-13T00:00:00.000Z";
  return JSON.parse(
    await backend.projectCreate({
      requestId: `plot-project-create:${projectId}`,
      projectId,
      sessionId: "plot-thread-napi-test",
      eventUid: `plot-project-create-event:${projectId}`,
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
      title: projectId,
      genre: null,
      pov: null,
      tense: null,
      language: "ja",
      styleGuide: null,
      aiInstructions: null,
      outline: null,
      targetReaders: null,
      createdAt: occurredAt,
      updatedAt: occurredAt,
    }),
  );
}

async function createScene(id, projectId = PROJECT) {
  const requestId = `plot-scene-create:${projectId}:${id}`;
  return JSON.parse(
    await backend.treeNodeCreate({
      ...mutationIdentity(requestId, projectId),
      undoJournalId: null,
      id,
      projectId,
      parentId: null,
      nodeType: "scene",
      title: id,
      sortOrder: `test-${id}`,
      synopsis: null,
      status: null,
      sourceUri: null,
      sourceMtime: null,
      content: "{}",
    }),
  );
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
      ...mutationIdentity("plot-thread-create-roundtrip"),
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
      ...mutationIdentity("plot-thread-update-name"),
      name: "改名した糸",
      description: "説明",
      baseVersion: created.version,
    }),
  );
  assert.equal(updated.name, "改名した糸");
  assert.equal(updated.description, "説明");

  // Explicit JSON null must remain distinct from an omitted PATCH field.
  const cleared = JSON.parse(
    await backend.plotThreadUpdate(created.id, {
      ...mutationIdentity("plot-thread-update-clear"),
      color: null,
      description: null,
      baseVersion: updated.version,
    }),
  );
  assert.equal(cleared.color, null);
  assert.equal(cleared.description, null);
  assert.equal(cleared.version, updated.version + 1);

  // 空 patch は現行行をそのまま返す（updated_at も変えない契約）。
  const noop = JSON.parse(
    await backend.plotThreadUpdate(created.id, {
      ...mutationIdentity("plot-thread-update-noop"),
      baseVersion: cleared.version,
    }),
  );
  assert.equal(noop.name, "改名した糸");
  assert.equal(noop.color, null);
  assert.equal(noop.description, null);
  assert.equal(noop.version, cleared.version);
  assert.equal(noop.updated_at, cleared.updated_at);
});

test("plotThreadLinkCreate は phase_type を検証し、正常リンクを作る", async () => {
  // 同 project にシーンを 1 つ用意する。
  await createScene("s1");
  const [thread] = await listThreads();

  // 不正 phase_type は 'invalid phase_type' で reject（サーバサイド検証）。
  await assert.rejects(
    backend.plotThreadLinkCreate({
      ...mutationIdentity("plot-marker-create-invalid-phase"),
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
      ...mutationIdentity("plot-marker-create-roundtrip"),
      threadId: thread.id,
      nodeId: "s1",
      phaseType: "introduce",
      note: "伏線",
      sortOrder: "marker-a0",
    }),
  );
  assert.equal(link.thread_id, thread.id);
  assert.equal(link.node_id, "s1");
  assert.equal(link.phase_type, "introduce");
  assert.equal(link.note, "伏線");
  assert.equal(link.sort_order, "marker-a0");

  const cleared = JSON.parse(
    await backend.plotThreadLinkUpdate(link.id, {
      ...mutationIdentity("plot-marker-update-clear"),
      note: null,
      sortOrder: null,
      baseVersion: link.version,
    }),
  );
  assert.equal(cleared.note, null);
  assert.equal(cleared.sort_order, null);
  assert.equal(cleared.version, link.version + 1);

  const links = await listLinks();
  assert.equal(links.length, 1);
  assert.equal(links[0].id, cleared.id);
});

test("XPROJ ガード: 別 project のシーンへのリンクは reject する（Electron でも効く）", async () => {
  // 別 project p2 とそのシーン s2 を用意。
  await createProject("p2");
  await createScene("s2", "p2");
  const [thread] = await listThreads(); // default-project のスレッド

  await assert.rejects(
    backend.plotThreadLinkCreate({
      ...mutationIdentity("plot-marker-create-xproj"),
      threadId: thread.id,
      nodeId: "s2",
      phaseType: "introduce",
      note: null,
      sortOrder: null,
    }),
    (err) => {
      assert.match(String(err.message), /snapshot project/);
      return true;
    },
  );
});

test("XPROJ ガード: link_update の別 project スレッドへの移動も reject する", async () => {
  // p2 にスレッドを作り、default-project の既存リンクをそこへ移そうとする。
  const p2thread = JSON.parse(
    await backend.plotThreadCreate({
      ...mutationIdentity("plot-thread-create-p2", "p2"),
      name: "p2 のスレッド",
      color: null,
      description: null,
      sortOrder: "a0",
    }),
  );
  const [link] = await listLinks();

  await assert.rejects(
    backend.plotThreadLinkUpdate(link.id, {
      ...mutationIdentity("plot-marker-update-xproj"),
      threadId: p2thread.id,
      baseVersion: link.version,
    }),
    (err) => {
      assert.match(String(err.message), /same project/);
      return true;
    },
  );
});

test("plotThreadBranchCreate は native transaction で XPROJ と durable replay を守る", async () => {
  const from = JSON.parse(
    await backend.plotThreadCreate({
      ...mutationIdentity("plot-thread-create-branch-from"),
      id: "branch-from-thread",
      name: "分岐元",
      color: null,
      description: null,
      sortOrder: "b0",
    }),
  );
  const to = JSON.parse(
    await backend.plotThreadCreate({
      ...mutationIdentity("plot-thread-create-branch-to"),
      id: "branch-to-thread",
      name: "分岐先",
      color: null,
      description: null,
      sortOrder: "b1",
    }),
  );
  const payload = {
    ...mutationIdentity("branch-napi-request-1"),
    id: "branch-napi-request-1",
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
      ...mutationIdentity("branch-napi-xproj"),
      id: "branch-napi-xproj",
      toThreadId: "p2-thread-missing",
    }),
    /same project/,
  );

  await backend.plotThreadBranchDelete({
    ...mutationIdentity("branch-napi-delete"),
    id: payload.id,
    baseVersion: created.version,
  });
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
  await backend.plotThreadDelete({
    ...mutationIdentity("plot-thread-delete-branch-from"),
    id: from.id,
    baseVersion: from.version,
  });
  await backend.plotThreadDelete({
    ...mutationIdentity("plot-thread-delete-branch-to"),
    id: to.id,
    baseVersion: to.version,
  });
});

test("plotThreadMoveMarkerBundle は N-API 越しに marker + branch を1回で確定・再送する", async () => {
  await createScene("s-move");
  const from = JSON.parse(
    await backend.plotThreadCreate({
      ...mutationIdentity("plot-thread-create-move-from"),
      id: "move-from-thread",
      name: "移動元",
      color: null,
      description: null,
      sortOrder: "m0",
    }),
  );
  const to = JSON.parse(
    await backend.plotThreadCreate({
      ...mutationIdentity("plot-thread-create-move-to"),
      id: "move-to-thread",
      name: "移動先",
      color: null,
      description: null,
      sortOrder: "m1",
    }),
  );
  const rawLink = JSON.parse(
    await backend.plotThreadLinkCreate({
      ...mutationIdentity("plot-marker-create-move"),
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
    semanticKey: rawLink.semantic_key,
    version: rawLink.version,
    createdAt: rawLink.created_at,
    updatedAt: rawLink.updated_at,
  };
  const markerAfter = {
    ...markerBefore,
    threadId: to.id,
    nodeId: "s-move",
    semanticKey: `${to.id}|s-move|turn`,
    version: markerBefore.version + 1,
    updatedAt: "2026-07-29T04:00:00.000Z",
  };
  const branchAfter = {
    id: "move-marker-branch",
    projectId: PROJECT,
    fromThreadId: from.id,
    toThreadId: to.id,
    atNodeId: "s-move",
    kind: "branch",
    semanticKey: `${from.id}|${to.id}|s-move|branch`,
    version: 0,
    createdAt: "2026-07-29T04:00:00.000Z",
    updatedAt: "2026-07-29T04:00:00.000Z",
  };
  const payload = {
    ...mutationIdentity("move-marker-request"),
    markerBefore,
    markerAfter,
    branchTransitions: [{ before: null, after: branchAfter }],
  };

  const moved = JSON.parse(await backend.plotThreadMoveMarkerBundle(payload));
  assert.deepEqual(moved.marker, markerAfter);
  assert.deepEqual(moved.branches, [branchAfter]);
  assert.deepEqual(moved.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
  const replay = JSON.parse(await backend.plotThreadMoveMarkerBundle(payload));
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

  await backend.plotThreadDelete({
    ...mutationIdentity("plot-thread-delete-move-from"),
    id: from.id,
    baseVersion: from.version,
  });
  await backend.plotThreadDelete({
    ...mutationIdentity("plot-thread-delete-move-to"),
    id: to.id,
    baseVersion: to.version,
  });
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
    version: 0,
  };
  const link = {
    id: "snapshot-napi-link",
    threadId: thread.id,
    nodeId: "s1",
    phaseType: "turn",
    note: "N-API marker",
    sortOrder: "a0",
    semanticKey: `${thread.id}|s1|turn`,
    version: 0,
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
    semanticKey: `${sourceThread.id}|${thread.id}|s1|branch`,
    version: 0,
    createdAt: "2026-07-28T03:04:00.000Z",
    updatedAt: "2026-07-28T03:05:00.000Z",
  };
  const restorePayload = {
    ...mutationIdentity("snapshot-napi-restore", PROJECT, "restore"),
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
  const restoredThread = { ...thread, version: thread.version + 1 };
  const restoredLink = { ...link, version: link.version + 1 };
  const restoredBranch = { ...branch, version: branch.version + 1 };
  assert.deepEqual(restored.thread, restoredThread);
  assert.deepEqual(restored.links, [restoredLink]);
  assert.deepEqual(restored.branches, [restoredBranch]);
  const exactRestore = JSON.parse(
    await backend.plotThreadRestoreSnapshot(restorePayload),
  );
  assert.deepEqual(exactRestore.__idempotency, {
    replayed: true,
    entityPresent: true,
  });

  const changedLinkRow = JSON.parse(
    await backend.plotThreadLinkUpdate(restoredLink.id, {
      ...mutationIdentity("snapshot-napi-link-update"),
      note: "changed",
      baseVersion: restoredLink.version,
    }),
  );
  const changedLink = {
    id: changedLinkRow.id,
    threadId: changedLinkRow.thread_id,
    nodeId: changedLinkRow.node_id,
    phaseType: changedLinkRow.phase_type,
    note: changedLinkRow.note,
    sortOrder: changedLinkRow.sort_order,
    semanticKey: changedLinkRow.semantic_key,
    version: changedLinkRow.version,
    createdAt: changedLinkRow.created_at,
    updatedAt: changedLinkRow.updated_at,
  };
  await assert.rejects(
    backend.plotThreadDeleteSnapshot({
      ...mutationIdentity("snapshot-napi-delete-stale"),
      link: restoredLink,
      branches: [restoredBranch],
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
  const deletePayload = {
    ...mutationIdentity("snapshot-napi-delete"),
    link: changedLink,
    branches: [restoredBranch],
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
    ...mutationIdentity("snapshot-napi-recreate", PROJECT, "restore"),
    thread: null,
    links: [changedLink],
    branches: [restoredBranch],
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
      [changedLink.id, restoredBranch.id],
      "all",
    ),
  ).rows;
  assert.deepEqual(recreatedRows, [
    { id: changedLink.id },
    { id: restoredBranch.id },
  ]);

  await backend.plotThreadDelete({
    ...mutationIdentity("snapshot-napi-thread-delete"),
    id: restoredThread.id,
    baseVersion: restoredThread.version,
  });
});

test("plotThreadLinkDelete / plotThreadDelete は対象を消す", async () => {
  const [link] = await listLinks();
  await backend.plotThreadLinkDelete({
    ...mutationIdentity("plot-marker-delete-final"),
    id: link.id,
    baseVersion: link.version,
  });
  assert.deepEqual(await listLinks(), []);

  const [thread] = await listThreads();
  await backend.plotThreadDelete({
    ...mutationIdentity("plot-thread-delete-final"),
    id: thread.id,
    baseVersion: thread.version,
  });
  assert.deepEqual(await listThreads(), []);
});
