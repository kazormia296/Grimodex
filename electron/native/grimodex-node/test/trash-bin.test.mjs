// trash_bin 垂直スライスの roundtrip テスト (Electron 移行 Phase 2 追補)。
//
// workspace 読み込み時に必ず呼ばれる trash_bin_list が IPC_UNIMPLEMENTED で
// reject して起動のたびにゴミ箱エラートーストが出た件の回帰 gate。
// create → list で戻る → delete → clear_all → prune (期日切れ + 件数超過) を、
// ビルド済み grimodex-node.node に対して end-to-end で検証する
// (日本語 preview_text の roundtrip 含む)。
//
// 実行: pnpm napi:build 後に `pnpm --dir electron/native/grimodex-node test`
//       (= `node --test test/`)。smoke.test.mjs とはプロセス・一時ディレクトリ
//       とも独立。テストは宣言順に直列実行される (共有 Backend の状態遷移に
//       依存するため順序を変えないこと)。

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

const root = mkdtempSync(join(tmpdir(), "grimodex-node-trash-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));

// trash_items.project_id は projects(id) への FK (foreign_keys=ON) なので
// migrate が seed する default-project を使う。
const PROJECT = "default-project";

/** FE (src/features/trash-bin/api.ts) が送る camelCase payload と同形。 */
function makePayload(previewText, deletedAt, overrides = {}) {
  return {
    projectId: PROJECT,
    kind: "text-fragment",
    subKind: "text-fragment",
    originSceneId: null,
    originCodexId: null,
    previewText,
    previewMeta: null,
    payload: JSON.stringify({ text: previewText, spans: [] }),
    charCount: [...previewText].length,
    isInteresting: false,
    deletedAt,
    ...overrides,
  };
}

async function listRows(limit) {
  return JSON.parse(await backend.trashBinList(PROJECT, limit));
}

test("workspace 未オープンの trashBinList は 'No workspace is open' マーカーで reject する", async () => {
  // §5.2 エラー文字列契約: 起動時 loadItems の失敗判定が Tauri と同形で読める。
  await assert.rejects(backend.trashBinList(PROJECT), (err) => {
    assert.match(String(err.message), /No workspace is open/);
    return true;
  });
});

test("trashBinCreate → trashBinList roundtrip (日本語 preview_text)", async () => {
  const opened = JSON.parse(await backend.openWorkspace(join(root, "ws")));
  assert.equal(opened.status, "ready");
  assert.equal(opened.workspace.isExisting, false);

  const createPayload = makePayload(
    "消した文字屑（日本語・絵文字🗑）",
    "2026-07-10T00:00:00.000Z",
    { id: "trash-napi-request-1" },
  );
  const created = JSON.parse(await backend.trashBinCreate(createPayload));
  // 作成行は SELECT * の生行 (列名 snake_case) — FE normalizeTrashItem が両対応。
  assert.equal(created.preview_text, "消した文字屑（日本語・絵文字🗑）");
  assert.equal(created.project_id, PROJECT);
  assert.equal(created.is_interesting, 0);
  assert.equal(created.id, createPayload.id);
  assert.deepEqual(created.__idempotency, {
    replayed: false,
    entityPresent: true,
  });
  const replay = JSON.parse(await backend.trashBinCreate(createPayload));
  assert.equal(replay.id, created.id);
  assert.deepEqual(replay.__idempotency, {
    replayed: true,
    entityPresent: true,
  });
  await assert.rejects(
    backend.trashBinCreate({ ...createPayload, previewText: "別の屑" }),
    /TRASH_BIN_CREATE_IDEMPOTENCY_CONFLICT/,
  );

  const rows = await listRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, created.id);
  assert.equal(rows[0].preview_text, "消した文字屑（日本語・絵文字🗑）");
});

test("trashBinList は limit を尊重し deleted_at 降順で返す", async () => {
  await backend.trashBinCreate(
    makePayload("より新しい屑", "2026-07-10T12:00:00.000Z"),
  );
  const all = await listRows();
  assert.equal(all.length, 2);

  const limited = await listRows(1);
  assert.equal(limited.length, 1);
  assert.equal(limited[0].preview_text, "より新しい屑");
});

test("trashBinDelete は 1 件だけ消す", async () => {
  const [newest, oldest] = await listRows();
  await backend.trashBinDelete(newest.id);
  const rows = await listRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, oldest.id);
});

test("trashBinClearAll で project の屑が全て消える", async () => {
  const durablePayload = makePayload("SECRET_NAPI_TRASH_SENTINEL", undefined, {
    id: "trash-napi-cleared-request",
  });
  await backend.trashBinCreate(durablePayload);
  await backend.trashBinClearAll(PROJECT);
  assert.deepEqual(await listRows(), []);

  const replay = JSON.parse(await backend.trashBinCreate(durablePayload));
  assert.equal(replay.id, durablePayload.id);
  assert.deepEqual(replay.__idempotency, {
    replayed: true,
    entityPresent: false,
  });
  assert.deepEqual(await listRows(), []);
});

test("trashBinPrune は期日切れ + 件数超過を刈り取り残件数を返す", async () => {
  const nowMs = Date.now();
  const daysAgo = (days) =>
    new Date(nowMs - days * 24 * 60 * 60 * 1_000).toISOString();
  // 期日切れ 1 件 (retention 60 日を大きく超える古さ) + 新しい 3 件
  await backend.trashBinCreate(makePayload("期日切れ", daysAgo(365)));
  await backend.trashBinCreate(makePayload("i1", daysAgo(3)));
  await backend.trashBinCreate(makePayload("i2", daysAgo(2)));
  await backend.trashBinCreate(makePayload("i3", daysAgo(1)));

  // retention で 1 件消え、max_count=2 で古い方からさらに 1 件消える。
  const remaining = JSON.parse(await backend.trashBinPrune(PROJECT, 60, 2));
  assert.equal(remaining, 2);
  const rows = await listRows();
  assert.deepEqual(
    rows.map((r) => r.preview_text),
    ["i3", "i2"],
    "新しい 2 件だけが残る",
  );
});
