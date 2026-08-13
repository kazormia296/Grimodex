// S2 スモークテスト (Electron 移行 Phase 2 設計書 §8 S2)。
//
// openWorkspace → migrate 確認 → dbExecute roundtrip → dbExecuteBatch の
// トランザクション性 → エラーマーカー透過 → onEvent 受信 (登録前バッファの
// flush 含む) を、ビルド済み grimodex-node.node に対して end-to-end で検証する。
//
// 実行: pnpm build (grimodex-node.node 生成) 後に `pnpm test`
//       (= `node --test test/`)。
// 追加: 環境変数 GRIMODEX_TAURI_WS_FIXTURE に「Tauri 側 (grimodex-db を
//       src-tauri workspace の cargo でビルドしたバイナリ) で作成済みの
//       workspace ディレクトリ」を渡すと、A3 (Tauri ↔ Electron 相互運用) の
//       前倒し確認テストも走る。
//
// 注意: このファイルは vitest の対象外 (vitest include は src/**/*.test.{ts,tsx})。
// テストは宣言順に直列実行される (共有 Backend の状態遷移に依存するため順序を
// 変えないこと)。

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

const root = mkdtempSync(join(tmpdir(), "grimodex-node-smoke-"));
const appDataDir = join(root, "app-data");
const wsDir = join(root, "ws");
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const events = [];
const backend = new Backend(appDataDir);
// onEvent 登録は new の後 = backend:ready は登録前 emit。EventQueue の
// バッファ + flush が効いていることをテスト 2 で検証する。
backend.onEvent((channel, payload) => events.push({ channel, payload }));

async function waitForEvent(channel, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const hit = events.find((e) => e.channel === channel);
    if (hit) return hit;
    if (Date.now() > deadline) {
      throw new Error(`event not received within ${timeoutMs}ms: ${channel}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** dbExecute の JSON 文字列返り値を rows 配列に剥がすヘルパ。 */
async function exec(sql, params = [], method = "all") {
  return JSON.parse(await backend.dbExecute(sql, params, method)).rows;
}

test("workspace 未オープンの dbExecute は 'No workspace is open' マーカーで reject する", async () => {
  // §5.2 エラー文字列契約: napi reason = AppError の Display がそのまま
  // JS Error.message に載る (FE は部分一致判定)。WORKSPACE_SWITCHING 側の
  // 同一写像は Rust 単体 (convert.rs) で gate 済み。
  await assert.rejects(
    backend.dbExecute("SELECT 1 AS one", [], "get"),
    (err) => {
      assert.match(String(err.message), /No workspace is open/);
      return true;
    },
  );
});

test("onEvent が登録前 emit の backend:ready を受信する (バッファ flush)", async () => {
  const ready = await waitForEvent("backend:ready");
  const payload = JSON.parse(ready.payload);
  assert.ok(
    Number.isInteger(payload.schemaVersion) && payload.schemaVersion >= 1,
    `schemaVersion が正の整数で載ること: ${ready.payload}`,
  );
});

test("openWorkspace が新規 workspace を scaffold + migrate し workspace:opened を emit する", async () => {
  const result = JSON.parse(await backend.openWorkspace(wsDir));
  assert.equal(result.status, "ready");
  assert.equal(result.workspace.isExisting, false);
  assert.equal(result.workspace.name, basename(wsDir));
  assert.match(result.workspace.workspaceId, /^[0-9a-f-]{36}$/);

  // migrate 済み: user_version が backend:ready の schemaVersion
  // (= grimodex_core::SCHEMA_VERSION) と一致する。
  const ready = JSON.parse(
    events.find((e) => e.channel === "backend:ready").payload,
  );
  const [{ user_version }] = await exec("PRAGMA user_version", [], "get");
  assert.equal(user_version, ready.schemaVersion);

  // migrate 済みスキーマ: default project が seed されている
  // (migrate.rs の INSERT OR IGNORE 'default-project')。
  const rows = await exec("SELECT id FROM projects", [], "all");
  assert.deepEqual(
    rows.map((r) => r.id),
    ["default-project"],
  );

  // §7.1 TSFn 実証チャネルその 2: openWorkspace 完了で workspace:opened。
  const opened = await waitForEvent("workspace:opened");
  assert.equal(JSON.parse(opened.payload).path, wsDir);

  // validateWorkspacePath: grimodex.db が生えたので true / 未作成 dir は false。
  assert.equal(backend.validateWorkspacePath(wsDir), true);
  assert.equal(backend.validateWorkspacePath(join(root, "no-such-ws")), false);
});

test("projectCreate + dbExecute SELECT roundtrip (パラメータ変換 + null + 日本語)", async () => {
  const createdAt = "2026-08-13T00:00:00.000Z";
  const created = JSON.parse(
    await backend.projectCreate({
      requestId: "smoke-project-create-p1",
      projectId: "p1",
      sessionId: "smoke-session",
      eventUid: "smoke-project-create-event-p1",
      origin: "human",
      originalTransactionId: null,
      undoJournalId: null,
      title: "スモーク作品",
      genre: null,
      pov: null,
      tense: null,
      language: "ja",
      styleGuide: null,
      aiInstructions: null,
      outline: null,
      targetReaders: null,
      createdAt,
      updatedAt: createdAt,
    }),
  );
  assert.equal(created.__writeReceipt.undoJournalId, null);
  assert.equal(
    typeof created.__writeReceipt.maintenanceTransactionId,
    "string",
  );
  const rows = await exec(
    "SELECT id, title, genre FROM projects WHERE id = ?",
    ["p1"],
    "all",
  );
  assert.deepEqual(rows, [{ id: "p1", title: "スモーク作品", genre: null }]);
});

test("dbExecuteBatch は途中失敗で全文 rollback する (トランザクション性)", async () => {
  await backend.dbExecuteBatch([
    {
      sql: "INSERT INTO app_settings (key, value) VALUES (?, ?)",
      params: ["smoke-tx-1", "1"],
      method: "run",
    },
  ]);
  const [{ n: before }] = await exec(
    "SELECT count(*) AS n FROM app_settings WHERE key LIKE 'smoke-tx-%'",
    [],
    "get",
  );
  assert.equal(before, 1);

  // 3 文目が失敗 → 先行 2 文の INSERT も残らないこと (BEGIN IMMEDIATE +
  // 全 ROLLBACK)。エラーメッセージには失敗原因が透過する。
  await assert.rejects(
    backend.dbExecuteBatch([
      {
        sql: "INSERT INTO app_settings (key, value) VALUES (?, ?)",
        params: ["smoke-tx-2", "2"],
        method: "run",
      },
      {
        sql: "INSERT INTO app_settings (key, value) VALUES (?, ?)",
        params: ["smoke-tx-3", "3"],
        method: "run",
      },
      {
        sql: "INSERT INTO no_such_table (v) VALUES (1)",
        params: [],
        method: "run",
      },
    ]),
    (err) => {
      assert.match(String(err.message), /no_such_table/);
      return true;
    },
  );
  const [{ n: after }] = await exec(
    "SELECT count(*) AS n FROM app_settings WHERE key LIKE 'smoke-tx-%'",
    [],
    "get",
  );
  assert.equal(after, 1, "途中失敗 batch は全文 rollback される");
});

test("renderer SQL policy は外部DB・VACUUM INTO・schema操作を明示拒否する", async () => {
  const attachPath = join(root, "renderer-attach.db");
  const vacuumPath = join(root, "renderer-vacuum.db");

  await assert.rejects(
    backend.dbExecute("ATTACH DATABASE ?1 AS audit", [attachPath], "run"),
    /RENDERER_SQL_SECURITY: denied ATTACH or VACUUM/,
  );
  assert.equal(existsSync(attachPath), false);

  await assert.rejects(
    backend.dbExecute("VACUUM INTO ?1", [vacuumPath], "run"),
    /RENDERER_SQL_SECURITY: denied ATTACH or VACUUM/,
  );
  assert.equal(existsSync(vacuumPath), false);

  await assert.rejects(
    backend.dbExecute(
      "CREATE TABLE renderer_schema_escape (v TEXT)",
      [],
      "run",
    ),
    /RENDERER_SQL_SECURITY: denied schema operation/,
  );
});

test("dbExecuteBatch の security rejection は先行書き込みも rollback する", async () => {
  const attachPath = join(root, "renderer-batch-attach.db");
  await assert.rejects(
    backend.dbExecuteBatch([
      {
        sql: "INSERT INTO app_settings (key, value) VALUES (?, ?)",
        params: ["renderer-security-batch", "must-roll-back"],
        method: "run",
      },
      {
        sql: "ATTACH DATABASE ?1 AS audit",
        params: [attachPath],
        method: "run",
      },
    ]),
    /RENDERER_SQL_SECURITY: denied ATTACH or VACUUM/,
  );
  const [{ n }] = await exec(
    "SELECT count(*) AS n FROM app_settings WHERE key = ?",
    ["renderer-security-batch"],
    "get",
  );
  assert.equal(n, 0);
  assert.equal(existsSync(attachPath), false);
});

test("vacuumDatabase は path 引数なしで通常の workspace DB を compact する", async () => {
  await backend.vacuumDatabase();
  const [{ title }] = await exec(
    "SELECT title FROM projects WHERE id = ?",
    ["p1"],
    "get",
  );
  assert.equal(title, "スモーク作品");
});

test("timelapseAppendBatch が監査チェーンへ append し冪等再送をスキップする", async () => {
  const makeEvent = (uid) => ({
    eventUid: uid,
    sceneId: null,
    domain: "prose",
    opType: "insert",
    entityType: null,
    entityId: null,
    payload: "{}",
    timestamp: Date.now(),
  });
  const first = JSON.parse(
    await backend.timelapseAppendBatch("p1", "session-1", [
      makeEvent("uid-1"),
      makeEvent("uid-2"),
    ]),
  );
  assert.equal(first.insertedCount, 2);
  assert.equal(first.tailSequence, 3);
  assert.match(first.tailHash, /^[0-9a-f]{64}$/);

  // 冪等再送 (コミット済み batch の再送) は 1 行も増えない。
  const resend = JSON.parse(
    await backend.timelapseAppendBatch("p1", "session-1", [makeEvent("uid-1")]),
  );
  assert.equal(resend.insertedCount, 0);
  assert.equal(resend.tailSequence, 3);
});

test("getGlobalSettings / saveGlobalSettings の roundtrip と recent-workspaces 反映", async () => {
  const settings = JSON.parse(await backend.getGlobalSettings());
  // openWorkspace が recent-workspaces を更新している (open_workspace_sync の
  // gs_path 着弾確認 — Tauri と同一経路)。
  assert.equal(settings.recentWorkspaces.length, 1);
  assert.equal(settings.recentWorkspaces[0].path, wsDir);
  assert.equal(settings.lastActiveWorkspace, wsDir);
  assert.equal(typeof settings.theme, "string");

  settings.theme = "dark";
  settings.uiScale = 125;
  await backend.saveGlobalSettings(settings);
  const loaded = JSON.parse(await backend.getGlobalSettings());
  assert.equal(loaded.theme, "dark");
  assert.equal(loaded.uiScale, 125);
  assert.equal(loaded.lastActiveWorkspace, wsDir, "他フィールドは維持される");
});

test("再オープンで isExisting=true になり書き込み内容が永続している (A2 の核)", async () => {
  const reopened = JSON.parse(await backend.openWorkspace(wsDir));
  assert.equal(reopened.status, "ready");
  assert.equal(reopened.workspace.isExisting, true);
  const workspaceMeta = JSON.parse(
    readFileSync(join(wsDir, ".grimodex", "workspace.json"), "utf8"),
  );
  assert.equal(reopened.workspace.workspaceId, workspaceMeta.id);
  const [{ title }] = await exec(
    "SELECT title FROM projects WHERE id = ?",
    ["p1"],
    "get",
  );
  assert.equal(title, "スモーク作品");
});

test(
  "Tauri 側 cargo ビルドで作った既存 workspace を openWorkspace で開ける (A3 前倒し)",
  {
    skip:
      !process.env.GRIMODEX_TAURI_WS_FIXTURE &&
      "GRIMODEX_TAURI_WS_FIXTURE 未設定",
  },
  async () => {
    const fixture = process.env.GRIMODEX_TAURI_WS_FIXTURE;
    assert.equal(backend.validateWorkspacePath(fixture), true);
    const result = JSON.parse(await backend.openWorkspace(fixture));
    assert.equal(result.status, "ready");
    assert.equal(
      result.workspace.isExisting,
      true,
      "既存 workspace として認識される",
    );

    // 同一スキーマ・同一 migrate 経路: user_version が一致し、Tauri 側で
    // 書いた行が読める。
    const ready = JSON.parse(
      events.find((e) => e.channel === "backend:ready").payload,
    );
    const [{ user_version }] = await exec("PRAGMA user_version", [], "get");
    assert.equal(user_version, ready.schemaVersion);
    const rows = await exec("SELECT id, title FROM projects", [], "all");
    assert.ok(rows.length >= 1, "Tauri 側で seed した project 行が読める");
  },
);
