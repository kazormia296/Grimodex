// DR-CP4-TR-9: 開始時の B の封印を、製品と別の read-only の接続（WAL の読み手）で
// 読む。製品の書込みを妨げないこと（読みは製品の書込みの transaction を待たず、
// 書込みも読みの後にすぐ commit できる）、busy のときは待たずに失敗して
// `unknown` になることを一時の SQLite で確かめる。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { START_SEAL_BUSY_TIMEOUT_MS, readStartSeal } from "./trace-seal.mjs";
import { startSealOf } from "./trace-record.mjs";
import { INDEX_KEYS, readIndexMetadata } from "./workspace-db.mjs";

function workspace({ wal = true } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "cp4-tr-seal-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "grimodex.db");
  const db = new DatabaseSync(file);
  if (wal) db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE narrative_semantic_index_metadata (
    project_id TEXT, index_key TEXT, generation INTEGER, dirty_cache_flag INTEGER,
    source_digest TEXT, dependency_set_digest TEXT, producer_id TEXT, producer_version TEXT)`);
  const insert = db.prepare(
    "INSERT INTO narrative_semantic_index_metadata VALUES (?, ?, ?, ?, 'd', 'e', 'p', '1')",
  );
  insert.run("p1", INDEX_KEYS.b, 4, 0);
  insert.run("p1", INDEX_KEYS.chronicle, 9, 0);
  return { file, writer: db };
}

test("TR-9: 封印の読取は B の generation と dirty を返し、読取の接続は busy の待ちを持たない", () => {
  assert.equal(START_SEAL_BUSY_TIMEOUT_MS, 0);
  const { file, writer } = workspace();
  const current = readStartSeal(file, "p1");
  assert.equal(current.read, "ok");
  assert.deepEqual(current.b, { generation: 4, dirty: false });
  assert.deepEqual(current.chronicle, { generation: 9, dirty: false });
  writer.exec(
    `UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1 WHERE index_key = '${INDEX_KEYS.b}'`,
  );
  assert.equal(readStartSeal(file, "p1").b.dirty, true);
  assert.equal(readStartSeal(file, "other").b, null);
  writer.close();
});

test("TR-9: WAL の読み手は製品の書込みの transaction を待たず（commit 済みの状態を読む）、書込みは読取の後にすぐ commit できる", () => {
  const { file, writer } = workspace();
  writer.exec("BEGIN IMMEDIATE");
  writer.exec(
    `UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1 WHERE index_key = '${INDEX_KEYS.b}'`,
  );
  const started = performance.now();
  const seal = readStartSeal(file, "p1");
  assert.ok(performance.now() - started < 1_000);
  assert.equal(seal.read, "ok");
  // Not the writer's uncommitted change.
  assert.equal(seal.b.dirty, false);
  // The reader closed its connection: the writer commits at once.
  writer.exec("COMMIT");
  assert.equal(readStartSeal(file, "p1").b.dirty, true);
  writer.close();
});

test("TR-9: busy（rollback journal で書込みが排他の lock を持つ）や読めない DB は待たずに失敗し、開始時の封印は unknown になる", () => {
  const { file, writer } = workspace({ wal: false });
  writer.exec("BEGIN EXCLUSIVE");
  writer.exec(
    `UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1 WHERE index_key = '${INDEX_KEYS.b}'`,
  );
  const started = performance.now();
  const busy = readStartSeal(file, "p1");
  assert.ok(performance.now() - started < 1_000, "the read did not wait");
  assert.equal(busy.read, "failed");
  assert.match(busy.error, /locked|busy/iu);
  writer.exec("COMMIT");
  writer.close();
  const missing = readStartSeal(path.join(path.dirname(file), "none.db"), "p1");
  assert.equal(missing.read, "failed");
  assert.equal(
    startSealOf({ ...busy, startedAt: 1, finishedAt: 2 }, 10).state,
    "unknown",
  );
});

test("TR-9: 読取は busy の timeout 0 を接続に渡し、readIndexMetadata はその option を read-only の接続に渡す", () => {
  const seen = [];
  readStartSeal("/x.db", "p1", {
    read: (file, projectId, options) => {
      seen.push(options);
      return { b: null, chronicle: null };
    },
  });
  assert.deepEqual(seen, [{ timeout: 0 }]);
  // The option reaches the connection: with a busy timeout the same busy
  // read waits, without it it does not.
  const { file, writer } = workspace({ wal: false });
  writer.exec("BEGIN EXCLUSIVE");
  writer.exec(
    `UPDATE narrative_semantic_index_metadata SET dirty_cache_flag = 1 WHERE index_key = '${INDEX_KEYS.b}'`,
  );
  const started = performance.now();
  assert.throws(() => readIndexMetadata(file, "p1", { timeout: 300 }));
  assert.ok(performance.now() - started >= 250, "the timeout was applied");
  writer.exec("COMMIT");
  writer.close();
});
