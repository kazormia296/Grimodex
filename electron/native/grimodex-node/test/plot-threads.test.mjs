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
  assert.equal(opened.isExisting, false);

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

test("plotThreadLinkDelete / plotThreadDelete は対象を消す", async () => {
  const [link] = await listLinks();
  await backend.plotThreadLinkDelete(link.id);
  assert.deepEqual(await listLinks(), []);

  const [thread] = await listThreads();
  await backend.plotThreadDelete(thread.id);
  assert.deepEqual(await listThreads(), []);
});
