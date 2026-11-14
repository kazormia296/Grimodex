// ai_usage・ai_audit_events の読み出しの試験（合成の sqlite。製品の DB は使わない）。
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { readAiUsageRows, readAuditPathIds } from "./ai-usage-db.mjs";

test("ai_usage の行は NULL を null で返し、audit の path_id は distinct", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "idl-usage-"));
  try {
    const db = path.join(dir, "ws", "grimodex.db");
    execFileSync("mkdir", ["-p", path.dirname(db)]);
    execFileSync("sqlite3", [
      db,
      `CREATE TABLE ai_usage (id TEXT, surface TEXT, model TEXT, tokens_in INTEGER, tokens_out INTEGER, created_at TEXT);
       INSERT INTO ai_usage VALUES ('1','codex_judgment','claude-sonnet-5-5',9000,4000,'2026-01-01T00:00:01Z');
       INSERT INTO ai_usage VALUES ('2','codex_judgment',NULL,NULL,NULL,'2026-01-01T00:00:02Z');
       INSERT INTO ai_usage VALUES ('3','codex_judgment','m',0,0,'2026-01-01T00:00:03Z');
       CREATE TABLE ai_audit_events (id INTEGER, path_id TEXT);
       INSERT INTO ai_audit_events VALUES (1,'codex_judgment');
       INSERT INTO ai_audit_events VALUES (2,'codex_judgment');`,
    ]);
    const usage = readAiUsageRows(path.dirname(db));
    assert.equal(usage.unreadable, 0);
    assert.deepEqual(usage.rows, [
      { surface: "codex_judgment", model: "claude-sonnet-5-5", tokens_in: 9000, tokens_out: 4000 },
      { surface: "codex_judgment", model: null, tokens_in: null, tokens_out: null },
      { surface: "codex_judgment", model: "m", tokens_in: 0, tokens_out: 0 },
    ]);
    assert.deepEqual(readAuditPathIds(path.dirname(db)).pathIds, ["codex_judgment"]);
    // DB が無ければ空（readable 0）。
    assert.equal(readAiUsageRows(path.join(dir, "none")).readable, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
