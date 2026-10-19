// NIR-1 DA-1 ST3 (K3/2 "表の台帳" と own-data-read): Native の policy 版 2 と、
// Main が付ける own-data-read の分類（読取専用の確認）を、実 Native の
// Backend.dbExecute / dbExecuteBatch で固定する。
//
// 読取の開放（read-open の表と列を restricted の汎用 SQL で読めること）は
// `PROFILE_EGRESS_READ_OPEN_ENABLED`（grimodex-db）が false の間は閉じたまま
// なので、ここでは「閉じたままの状態で成り立つこと」だけを断言する。開放後の
// 期待値は OPEN_EXPECTATIONS に pending として並べ、開放 commit が true に
// 切り替える（開いているときの挙動は grimodex-db の cargo test が
// `with_read_open(true)` で固定している）。
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { Backend } = require(join(here, "..", "grimodex-node.node"));

// 開放 commit（DR-DA1-35）でこの値と grimodex-db の PROFILE_EGRESS_READ_OPEN_ENABLED
// を同時に true にした。
const READ_OPEN = true;

const DENIED = /D2A_EGRESS_DENIED/;
const NOT_READ_ONLY = /D2A_EGRESS_DENIED.*own-data-read statement is not read-only/;

async function restrictedRig(label) {
  const root = mkdtempSync(join(tmpdir(), `grimodex-own-data-${label}-`));
  const backend = new Backend(join(root, "app-data"));
  await backend.initializeProfileEgress();
  const status = JSON.parse(await backend.activateProfileEgress());
  const workspace = join(root, "workspace");
  await backend.openWorkspace(workspace);
  const identity = {
    profileId: status.profileId,
    callerId: "main-caller",
    callerEpoch: status.callerEpoch,
    senderId: 42,
    workspaceId: workspace,
    sessionId: "main-session",
  };
  await backend.registerProfileEgressCaller(JSON.stringify(identity));
  return {
    root,
    backend,
    status,
    wire: JSON.stringify(identity),
    async close() {
      const wire = await backend.shutdownWorkspaceLifecycle();
      assert.equal(JSON.parse(wire).status, "closed");
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const run = (rig, sql, params = [], method = "all", own) =>
  own === undefined
    ? rig.backend.dbExecute(sql, params, method, rig.wire)
    : rig.backend.dbExecute(sql, params, method, rig.wire, own);

test("the startup status publishes policy version 2 as closed / read-open / read-open columns", async () => {
  const rig = await restrictedRig("policy");
  try {
    const policy = rig.status.sqlPolicy;
    assert.deepEqual(Object.keys(policy).sort(), [
      "closedTables",
      "readOpenColumns",
      "readOpenTables",
      "version",
    ]);
    assert.equal(policy.version, 2);
    assert.equal(policy.closedTables.length, 26);
    assert.equal(policy.readOpenTables.length, 58);
    assert.deepEqual(policy.readOpenColumns, [
      { table: "change_events", column: "payload" },
      { table: "state_snapshots", column: "payload" },
    ]);
    const closed = new Set(policy.closedTables);
    assert.ok(policy.readOpenTables.every((table) => !closed.has(table)));
    for (const table of [
      "narrative_proposals",
      "nir1_generation_attempts",
      "idempotency_requests",
      "messages",
    ]) {
      assert.ok(closed.has(table), table);
    }
    for (const table of ["chat_messages", "chat_sessions", "foreshadows"]) {
      assert.ok(policy.readOpenTables.includes(table), table);
    }
  } finally {
    await rig.close();
  }
});

test("closed tables and DML on the ledger are rejected whatever the classification", async () => {
  const rig = await restrictedRig("closed");
  try {
    for (const own of [undefined, false, true]) {
      for (const sql of [
        "SELECT * FROM narrative_proposals",
        "SELECT * FROM nir1_generation_attempts",
        "SELECT * FROM idempotency_requests",
        "DELETE FROM chat_sessions",
        "INSERT INTO chat_sessions(id,project_id) VALUES ('x','y')",
        "UPDATE chat_sessions SET project_id = 'z'",
        "UPDATE chat_messages SET is_starred = 1",
        "DELETE FROM change_events",
        "INSERT INTO app_settings(key,value) VALUES ('k','v') RETURNING value",
      ]) {
        await assert.rejects(
          run(rig, sql, [], "run", own),
          DENIED,
          `${sql} (own-data-read=${own})`,
        );
      }
    }
    // DML on the ledger is rejected by the DML arm, not by luck of a read.
    await assert.rejects(
      run(rig, "DELETE FROM chat_sessions", [], "run", true),
      /protected DML target chat_sessions/,
    );
    await assert.rejects(
      run(rig, "UPDATE chat_messages SET is_starred = 1", [], "run", true),
      /protected DML target chat_messages/,
    );
  } finally {
    await rig.close();
  }
});

test("every closed table rejects generic SQL reads and DML in Native, whatever Main sent (Negative (19))", async () => {
  const rig = await restrictedRig("closed-all");
  try {
    for (const table of rig.status.sqlPolicy.closedTables) {
      // `messages` is closed defensively but the migrations do not create it.
      const missing = table === "messages" ? /no such table/ : undefined;
      for (const own of [undefined, true]) {
        await assert.rejects(
          run(rig, `SELECT * FROM "${table}" LIMIT 1`, [], "all", own),
          missing ?? DENIED,
          table,
        );
        await assert.rejects(
          run(rig, `DELETE FROM "${table}" WHERE 0`, [], "run", own),
          missing ?? DENIED,
          table,
        );
      }
    }
  } finally {
    await rig.close();
  }
});

test("a statement Main classified own-data-read must be read-only", async () => {
  const rig = await restrictedRig("readonly");
  try {
    const leak =
      "WITH s AS (SELECT 1 AS n) INSERT INTO app_settings(key,value) SELECT 'own-data-leak', n FROM s";
    const present = async () =>
      JSON.parse(
        await run(
          rig,
          "SELECT key FROM app_settings WHERE key = 'own-data-leak'",
        ),
      ).rows.length;

    // classified: the write never runs
    await assert.rejects(run(rig, leak, [], "run", true), NOT_READ_ONLY);
    for (const sql of [
      "INSERT INTO app_settings(key,value) VALUES ('own-data-leak','v')",
      "UPDATE app_settings SET value = 'v'",
      "DELETE FROM app_settings",
      "REPLACE INTO app_settings(key,value) VALUES ('own-data-leak','v')",
    ]) {
      await assert.rejects(run(rig, sql, [], "run", true), NOT_READ_ONLY, sql);
    }
    assert.equal(await present(), 0);

    // classified read: passes, and reports no mutation
    const read = JSON.parse(
      await run(rig, "SELECT 1 AS one FROM app_settings LIMIT 1", [], "all", true),
    );
    assert.deepEqual(read.rows, []);
    assert.notEqual(read.__grimodexDbResultKind, "committed-mutation");

    // unclassified (no flag, or false): the check is not applied, exactly as
    // before — this is the documented comma-join limitation, not a hole the
    // flag is meant to close.
    await run(rig, leak, [], "run", false);
    assert.equal(await present(), 1);
    await run(rig, "DELETE FROM app_settings WHERE key = 'own-data-leak'");
    await run(rig, leak);
    assert.equal(await present(), 1);
  } finally {
    await rig.close();
  }
});

test("the classification is per statement in a batch and must match its length", async () => {
  const rig = await restrictedRig("batch");
  try {
    const write = (key) => ({
      sql: "INSERT INTO app_settings(key,value) VALUES (?, 'v')",
      params: [key],
      method: "run",
    });
    const read = { sql: "SELECT 1 AS one", params: [], method: "all" };
    const count = async (prefix) =>
      JSON.parse(
        await run(
          rig,
          `SELECT key FROM app_settings WHERE key LIKE '${prefix}%'`,
        ),
      ).rows.length;

    // a classified read next to an unclassified write
    await rig.backend.dbExecuteBatch(
      [write("own-batch-ok"), read],
      rig.wire,
      [false, true],
    );
    assert.equal(await count("own-batch-ok"), 1);

    // a classified write rolls the whole batch back
    await assert.rejects(
      rig.backend.dbExecuteBatch(
        [write("own-batch-rolled"), write("own-batch-rolled-2")],
        rig.wire,
        [false, true],
      ),
      NOT_READ_ONLY,
    );
    assert.equal(await count("own-batch-rolled"), 0);

    // a length mismatch is rejected before anything runs
    await assert.rejects(
      rig.backend.dbExecuteBatch([write("own-batch-mismatch"), read], rig.wire, [
        true,
      ]),
      DENIED,
    );
    assert.equal(await count("own-batch-mismatch"), 0);

    // no classification at all behaves as before
    await rig.backend.dbExecuteBatch([write("own-batch-plain")], rig.wire);
    assert.equal(await count("own-batch-plain"), 1);
  } finally {
    await rig.close();
  }
});

test("read-open tables follow the opening switch; closed tables never open", async () => {
  const rig = await restrictedRig("switch");
  try {
    for (const sql of [
      "SELECT * FROM chat_sessions",
      "SELECT content FROM chat_messages",
      "SELECT * FROM foreshadows",
      "SELECT payload FROM change_events",
    ]) {
      if (READ_OPEN) {
        await run(rig, sql, [], "all", true);
      } else {
        await assert.rejects(run(rig, sql, [], "all", true), DENIED, sql);
      }
    }
    await assert.rejects(
      run(rig, "SELECT * FROM narrative_proposals", [], "all", true),
      DENIED,
    );
    // columns of change_events other than payload are readable either way
    await run(rig, "SELECT domain, sequence FROM change_events");
  } finally {
    await rig.close();
  }
});
