// agent_writes napi 写像の tracked-write roundtrip (Electron 移行 Phase 3 バッチ1)。
//
// grimodex-db::agent_writes を Tauri と共用する napi 写像を、ビルド済み
// grimodex-node.node に対して end-to-end で検証する。Rust 単体テスト (21件) が
// ロジックを網羅するため、ここは **napi 境界** に集中する:
//   - payload (authorship_spans の i64 from/to_pos 含む) の from_wire deserialize。
//   - BEGIN IMMEDIATE → entity + authorship_spans + undo_journal + change_events →
//     commit_or_rollback が 1 トランザクションで閉じること (with_conn 経路)。
//   - AgentWriteResult (camelCase: entityId/version/changeEventUid/undoJournalId) の
//     serialize。
//
// 実行: pnpm napi:build 後に `pnpm --dir electron/native/grimodex-node test`。

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

const root = mkdtempSync(join(tmpdir(), "grimodex-node-agent-"));
process.on("exit", () => rmSync(root, { recursive: true, force: true }));

const backend = new Backend(join(root, "app-data"));
const PROJECT = "default-project"; // migrate seed（'character' codex_type も seed 済み）

async function rows(sql, params = []) {
  return JSON.parse(await backend.dbExecute(sql, params, "all")).rows;
}

test("workspace 未オープンの agentCodexCreate は 'No workspace is open' で reject", async () => {
  await assert.rejects(
    backend.agentCodexCreate({
      projectId: PROJECT,
      sessionId: "s1",
      typeSlug: "character",
      name: "x",
      authorshipSpans: [],
    }),
    (err) => {
      assert.match(String(err.message), /No workspace is open/);
      return true;
    },
  );
});

test("agentCodexCreate: tracked write が AgentWriteResult を返し entity+span+change_event を書く", async () => {
  await backend.openWorkspace(join(root, "ws"));

  const payload = {
    requestId: "agent-tool:codex-napi-request-1",
    entryId: "codex-napi-entity-attempt-1",
    projectId: PROJECT,
    sessionId: "sess-1",
    typeSlug: "character",
    name: "主人公",
    summary: "説明文",
    content: "{}",
    // authorship_spans の from/to_pos は i64（JSON 往復で REAL に化けないこと）。
    authorshipSpans: [{ fromPos: 0, toPos: 4, source: "ai", model: "gpt" }],
  };
  const res = JSON.parse(await backend.agentCodexCreate(payload));
  // AgentWriteResult は camelCase。
  assert.equal(typeof res.entityId, "string");
  assert.equal(res.version, 1);
  assert.equal(typeof res.changeEventUid, "string");
  assert.equal(typeof res.undoJournalId, "string");
  assert.equal(res.undoJournalId, payload.requestId);
  assert.notEqual(res.entityId, payload.requestId);

  // entity が version=1 で永続。
  const entry = await rows(
    "SELECT name, version FROM codex_entries WHERE id = ?",
    [res.entityId],
  );
  assert.equal(entry[0].name, "主人公");
  assert.equal(entry[0].version, 1);

  // authorship_span の i64 座標が保存されている。
  const spans = await rows(
    "SELECT from_pos, to_pos FROM authorship_spans WHERE codex_entry_id = ?",
    [res.entityId],
  );
  assert.equal(spans.length, 1);
  assert.equal(spans[0].from_pos, 0);
  assert.equal(spans[0].to_pos, 4);

  // 同一トランザクションで change_event + undo_journal が書かれている。
  const ce = await rows(
    "SELECT COUNT(*) AS n FROM change_events WHERE event_uid = ?",
    [res.changeEventUid],
  );
  assert.equal(ce[0].n, 1);
  const uj = await rows(
    "SELECT op_kind, entity_id FROM undo_journal WHERE id = ?",
    [res.undoJournalId],
  );
  assert.equal(uj[0].op_kind, "create");
  assert.equal(uj[0].entity_id, res.entityId);

  const retry = JSON.parse(
    await backend.agentCodexCreate({
      ...payload,
      entryId: "codex-napi-entity-attempt-2",
    }),
  );
  assert.deepEqual(
    retry,
    res,
    "same requestId returns the original result despite a fresh entity UUID",
  );
  await assert.rejects(
    backend.agentCodexCreate({ ...payload, name: "別人" }),
    /AGENT_CODEX_CREATE_IDEMPOTENCY_CONFLICT/,
  );
});

test("snippet / agent foreshadow / event request IDs are idempotent through napi", async () => {
  const snippet = {
    requestId: "agent-tool:snippet-napi-request-1",
    snippetId: "snippet-napi-entity-attempt-1",
    projectId: PROJECT,
    sessionId: "sess-1",
    title: "抜粋",
    content: "{}",
    authorshipSpans: [],
  };
  const snippetFirst = JSON.parse(await backend.agentSnippetCreate(snippet));
  assert.equal(snippetFirst.undoJournalId, snippet.requestId);
  assert.notEqual(snippetFirst.entityId, snippet.requestId);
  assert.deepEqual(
    JSON.parse(
      await backend.agentSnippetCreate({
        ...snippet,
        snippetId: "snippet-napi-entity-attempt-2",
      }),
    ),
    snippetFirst,
  );
  await assert.rejects(
    backend.agentSnippetCreate({ ...snippet, title: "別の抜粋" }),
    /AGENT_SNIPPET_CREATE_IDEMPOTENCY_CONFLICT/,
  );

  const foreshadow = {
    requestId: "agent-tool:foreshadow-napi-request-1",
    foreshadowId: "foreshadow-napi-entity-attempt-1",
    projectId: PROJECT,
    sessionId: "sess-1",
    title: "刻印",
    intent: null,
    notes: null,
    loadBearing: "critical",
    secret: true,
  };
  const foreshadowFirst = JSON.parse(
    await backend.agentForeshadowCreate(foreshadow),
  );
  assert.equal(foreshadowFirst.undoJournalId, foreshadow.requestId);
  assert.notEqual(foreshadowFirst.entityId, foreshadow.requestId);
  assert.deepEqual(
    JSON.parse(
      await backend.agentForeshadowCreate({
        ...foreshadow,
        foreshadowId: "foreshadow-napi-entity-attempt-2",
      }),
    ),
    foreshadowFirst,
  );
  await assert.rejects(
    backend.agentForeshadowCreate({ ...foreshadow, title: "別の刻印" }),
    /AGENT_FORESHADOW_CREATE_IDEMPOTENCY_CONFLICT/,
  );

  const event = {
    requestId: "agent-tool:event-napi-request-1",
    eventId: "event-napi-entity-attempt-1",
    projectId: PROJECT,
    sessionId: "sess-1",
    title: "到着",
  };
  const eventFirst = JSON.parse(await backend.agentEventCreate(event));
  assert.equal(eventFirst.undoJournalId, event.requestId);
  assert.notEqual(eventFirst.entityId, event.requestId);
  assert.deepEqual(
    JSON.parse(
      await backend.agentEventCreate({
        ...event,
        eventId: "event-napi-entity-attempt-2",
      }),
    ),
    eventFirst,
  );
  await assert.rejects(
    backend.agentEventCreate({ ...event, title: "出発" }),
    /AGENT_EVENT_CREATE_IDEMPOTENCY_CONFLICT/,
  );
});

test("agentCodexUpdate: 存在しない entry は reject し、副作用を残さない（ROLLBACK）", async () => {
  const before = await rows("SELECT COUNT(*) AS n FROM change_events");
  await assert.rejects(
    backend.agentCodexUpdate({
      projectId: PROJECT,
      sessionId: "sess-1",
      entryId: "does-not-exist",
      baseVersion: 1,
      name: "改名",
      authorshipSpans: null,
    }),
  );
  const after = await rows("SELECT COUNT(*) AS n FROM change_events");
  assert.equal(after[0].n, before[0].n, "失敗時に change_events を書かない");
});
