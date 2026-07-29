// foreshadow napi 写像の roundtrip + 境界テスト (Electron 移行 Phase 3 バッチ1)。
//
// grimodex-db::foreshadow を Tauri と共用する napi 写像を、ビルド済み
// grimodex-node.node に対して end-to-end で検証する。Rust 単体テストが直接
// 触れない **napi 境界** に集中する:
//   - i64 の JSON 往復 (save_anchors の doc_content_size ガード / setup_create_ai
//     の from/to_pos / load_anchors の座標) — normalize_integer_numbers 依存。
//   - Option<Option<T>> の null クリア (update の intent)。
//   - Option<String> 返り (resolve_orphan の reinsert new_id / None→null)。
//   - camelCase mark 出力 (load_anchors)。
//   - load_bearing のワイヤエラー文字列。
//
// 実行: pnpm napi:build 後に `pnpm --dir electron/native/grimodex-node test`。
// 宣言順に直列実行される (共有 Backend の状態に依存。順序を変えないこと)。

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

const root = mkdtempSync(join(tmpdir(), "grimodex-node-fore-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));
const PROJECT = "default-project"; // migrate seed

async function run(sql, params = []) {
  await backend.dbExecute(sql, params, "run");
}
/** WHERE で一意に絞った SELECT の 1 行（無ければ undefined）を返す。 */
async function row(sql, params = []) {
  const res = JSON.parse(await backend.dbExecute(sql, params, "all"));
  return res.rows[0];
}
async function firstForeshadow() {
  return JSON.parse(await backend.foreshadowListWithLabels(PROJECT))
    .foreshadows[0];
}

test("workspace 未オープンの foreshadowListWithLabels は 'No workspace is open' で reject", async () => {
  await assert.rejects(backend.foreshadowListWithLabels(PROJECT), (err) => {
    assert.match(String(err.message), /No workspace is open/);
    return true;
  });
});

test("foreshadowCreate は load_bearing を検証する（ワイヤエラー文字列）", async () => {
  await backend.openWorkspace(join(root, "ws"));

  await assert.rejects(
    backend.foreshadowCreate({
      projectId: PROJECT,
      title: "不正",
      intent: null,
      loadBearing: "required",
    }),
    (err) => {
      assert.match(String(err.message), /invalid load_bearing value/);
      return true;
    },
  );
});

test("foreshadowCreate → update: Option<Option> は Some(Some)=set / null・欠落=no-op（Tauri パリティ）", async () => {
  await run(
    "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order) VALUES ('foreshadow-payoff-scene', ?, 'scene', 'Payoff', '{}', 'a-foreshadow')",
    [PROJECT],
  );
  const createPayload = {
    id: "foreshadow-napi-request-1",
    projectId: PROJECT,
    title: "刹那の伏線",
    intent: "最初の意図",
    notes: "full-row note",
    payoffSceneId: "foreshadow-payoff-scene",
    payoffFromPos: 3,
    payoffToPos: 9,
    payoffConfirmed: true,
    abandoned: true,
    secret: false,
    loadBearing: "critical",
    codexLinkDirtyAt: 1784000000000,
  };
  const created = JSON.parse(await backend.foreshadowCreate(createPayload));
  assert.equal(created.title, "刹那の伏線");
  assert.equal(created.intent, "最初の意図");
  assert.equal(created.notes, "full-row note");
  assert.equal(created.payoff_scene_id, "foreshadow-payoff-scene");
  assert.equal(created.payoff_from_pos, 3);
  assert.equal(created.payoff_to_pos, 9);
  assert.equal(created.payoff_confirmed, 1);
  assert.equal(created.abandoned, 1);
  assert.equal(created.secret, 0);
  assert.equal(created.load_bearing, "critical");
  assert.equal(created.codex_link_dirty_at, 1784000000000);
  const fid = created.id;
  assert.equal(fid, createPayload.id);
  assert.deepEqual(created.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
  const replay = JSON.parse(await backend.foreshadowCreate(createPayload));
  assert.equal(replay.id, created.id);
  assert.deepEqual(replay.__idempotency, {
    replayed: true,
    entityPresent: true,
  });
  await assert.rejects(
    backend.foreshadowCreate({ ...createPayload, title: "別の伏線" }),
    /FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT/,
  );

  // Some(Some) — 値セットは効く（到達可能な唯一の書き込み経路）。
  const setted = JSON.parse(
    await backend.foreshadowUpdate(fid, { intent: "改訂した意図" }),
  );
  assert.equal(setted.intent, "改訂した意図");
  assert.equal(setted.title, "刹那の伏線", "title は不変");

  // intent: null は serde が Option<Option<T>> を外側 None に畳むため **no-op**。
  // これは Tauri のコマンド引数 deserialize と同一挙動（"clear-to-null" は wire から
  // 到達不能 = 既存パリティ。from_wire で非対称に "修正" してはならない）。
  const nulled = JSON.parse(
    await backend.foreshadowUpdate(fid, { intent: null }),
  );
  assert.equal(
    nulled.intent,
    "改訂した意図",
    "null は no-op（Tauri パリティ）",
  );

  // 空 patch は現行行をそのまま返す。
  const noop = JSON.parse(await backend.foreshadowUpdate(fid, {}));
  assert.equal(noop.id, fid);
});

test("foreshadowCreate requestId-only は同じ entity と ledger を replay する", async () => {
  const payload = {
    requestId: "foreshadow-napi-request-only",
    projectId: PROJECT,
    title: "request only",
    intent: null,
    loadBearing: null,
  };
  const created = JSON.parse(await backend.foreshadowCreate(payload));
  const replay = JSON.parse(await backend.foreshadowCreate(payload));
  assert.equal(created.id, payload.requestId);
  assert.equal(replay.id, created.id);
  assert.deepEqual(replay.__idempotency, {
    replayed: true,
    entityPresent: true,
  });
});

test("foreshadowCreate は delete 後も request tombstone を replay し deliberate restore を区別する", async () => {
  const payload = {
    id: "foreshadow-napi-entity-deleted",
    requestId: "foreshadow-napi-request-deleted",
    projectId: PROJECT,
    title: "削除後に復活しない伏線",
    intent: "SECRET_NAPI_FORESHADOW_SENTINEL",
    loadBearing: null,
  };
  await backend.foreshadowCreate(payload);
  await backend.foreshadowDelete(payload.id);

  const replay = JSON.parse(await backend.foreshadowCreate(payload));
  assert.equal(replay.id, payload.id);
  assert.deepEqual(replay.__idempotency, {
    replayed: true,
    entityPresent: false,
  });
  assert.equal(
    await row("SELECT id FROM foreshadows WHERE id = ?", [payload.id]),
    undefined,
  );

  const restored = JSON.parse(
    await backend.foreshadowCreate({
      ...payload,
      requestId: "foreshadow-napi-history-restore",
    }),
  );
  assert.equal(restored.id, payload.id);
  assert.deepEqual(restored.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
});

test("setup_create_ai → load_anchors: i64 座標が JSON 往復で保存され camelCase mark で返る", async () => {
  await run(
    "INSERT INTO tree_nodes (id, project_id, node_type, title, content, sort_order) VALUES ('sc1', ?, 'scene', 'S', '{}', 'a0')",
    [PROJECT],
  );
  const fs = await firstForeshadow();

  await backend.foreshadowSetupCreateAi({
    id: "setup-ai-1",
    foreshadowId: fs.id,
    sceneId: "sc1",
    fromPos: 10,
    toPos: 20,
    kind: "designated_existing",
    strength: null,
    aiStrength: null,
    attribution: "ai",
    aiRationale: null,
    aiReasoning: null,
    lastEvaluatedAt: 1783664540830, // Date.now() 相当（f64→i64 正規化の検証）
  });

  // DB に i64 がそのまま入っている（REAL 混入していない）。
  const r = await row(
    "SELECT from_pos, to_pos, last_evaluated_at FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(r.from_pos, 10);
  assert.equal(r.to_pos, 20);
  assert.equal(r.last_evaluated_at, 1783664540830);

  const marks = JSON.parse(await backend.foreshadowLoadAnchorsForScene("sc1"));
  const setupMark = marks.find((m) => m.markName === "foreshadowSetup");
  assert.ok(setupMark, "setup mark が返る");
  assert.equal(setupMark.from, 10);
  assert.equal(setupMark.to, 20);
  assert.equal(setupMark.attrs.setupId, "setup-ai-1");
  assert.equal(setupMark.attrs.foreshadowId, fs.id);
});

test("save_anchors_for_scene の doc_content_size i64 ガード（境界 2 / 50）", async () => {
  // 現状 sc1 には非 orphan setup が 1 件（setup-ai-1）ある。

  // docContentSize=50（本文あり）+ setups 空 → bulk-orphan スキップ。
  await backend.foreshadowSaveAnchorsForScene("sc1", [], [], 50);
  const a = await row(
    "SELECT is_orphan FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(a.is_orphan, 0, "本文ありのとき bulk-orphan しない");

  // docContentSize=2（空 doc）+ setups 空 → bulk-orphan 発火。
  await backend.foreshadowSaveAnchorsForScene("sc1", [], [], 2);
  const b = await row(
    "SELECT is_orphan FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(b.is_orphan, 1, "空 doc のとき bulk-orphan する");

  // orphan は load_anchors から除外される。
  const marks = JSON.parse(await backend.foreshadowLoadAnchorsForScene("sc1"));
  assert.equal(
    marks.filter((m) => m.markName === "foreshadowSetup").length,
    0,
    "orphan setup は mark に出ない",
  );
});

test("resolve_orphan reinsert は Option<String> の new_id を返し、delete は null", async () => {
  // setup-ai-1 は今 orphan。reinsert で新 id を採番し旧行を削除（原子的）。
  const newId = JSON.parse(
    await backend.foreshadowResolveOrphan({
      setupId: "setup-ai-1",
      action: "reinsert",
      sceneId: "sc1",
      fromPos: 3,
      toPos: 8,
    }),
  );
  assert.equal(typeof newId, "string", "reinsert は new_id 文字列を返す");
  assert.notEqual(newId, "setup-ai-1");

  // 旧行は消えている。
  const old = await row(
    "SELECT id FROM foreshadow_setups WHERE id = 'setup-ai-1'",
  );
  assert.equal(old, undefined, "旧 setup は削除済み");

  // action=delete は None → null。
  const del = JSON.parse(
    await backend.foreshadowResolveOrphan({ setupId: newId, action: "delete" }),
  );
  assert.equal(del, null, "delete は null を返す");
});

test("link_codex / list_linked_codex / unlink_codex の roundtrip", async () => {
  // type は DEFAULT 'character'（migrate トリガが default-project に seed 済み）。
  await run(
    "INSERT INTO codex_entries (id, project_id, name) VALUES ('cx1', ?, '主人公')",
    [PROJECT],
  );
  const fs = await firstForeshadow();

  await backend.foreshadowLinkCodex(fs.id, "cx1");
  let linked = JSON.parse(await backend.foreshadowListLinkedCodex(fs.id));
  assert.equal(linked.length, 1);
  assert.equal(linked[0].id, "cx1");
  assert.equal(linked[0].name, "主人公");

  await backend.foreshadowUnlinkCodex(fs.id, "cx1");
  linked = JSON.parse(await backend.foreshadowListLinkedCodex(fs.id));
  assert.deepEqual(linked, []);
});
