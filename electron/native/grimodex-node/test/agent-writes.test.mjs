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
process.on("exit", () => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    // The native Backend can release its SQLite handle after exit listeners
    // on Windows, so fixture cleanup is best-effort there.
    if (process.platform !== "win32" || error?.code !== "EPERM") throw error;
  }
});

const backend = new Backend(join(root, "app-data"));
const PROJECT = "default-project"; // migrate seed（'character' codex_type も seed 済み）

function canonical(requestId, origin = "human") {
  const isInteractiveAgent = origin === "ai-apply";
  return {
    requestId,
    projectId: PROJECT,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin,
    authorityRoute: isInteractiveAgent
      ? "interactive-agent-command"
      : "human-direct",
    caller: isInteractiveAgent ? "chat-tool-executor" : "manual-wrapper",
    controls: isInteractiveAgent
      ? [
          "knowledge-write-policy",
          "stable-request-id",
          "agent-provenance",
          "typed-writer",
          "occ",
          "undo-journal",
          "change-event",
          "change-feed",
        ]
      : [
          "runtime-policy",
          "actor-context",
          "typed-writer",
          "occ",
          "change-event",
          "change-feed",
        ],
    provenance: isInteractiveAgent
      ? { requestId, traceId: `${requestId}:trace` }
      : null,
    writesAuthorityProtectedField: false,
    originalTransactionId: null,
    undoJournalId: null,
  };
}

async function rows(sql, params = []) {
  return JSON.parse(await backend.dbExecute(sql, params, "all")).rows;
}

async function writeCounts() {
  const result = await rows(`
    SELECT
      (SELECT COUNT(*) FROM codex_entries) AS codex_entries,
      (SELECT COUNT(*) FROM undo_journal) AS undo_journal,
      (SELECT COUNT(*) FROM change_events) AS change_events,
      (SELECT COUNT(*) FROM narrative_change_transactions) AS feed_transactions
  `);
  return result[0];
}

test("workspace 未オープンの agentCodexCreate は 'No workspace is open' で reject", async () => {
  await assert.rejects(
    backend.agentCodexCreate({
      ...canonical("unopened-codex-create", "ai-apply"),
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
    ...canonical("agent-tool:codex-napi-request-1", "ai-apply"),
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
      sessionId: "sess-1-after-restart",
      eventUid: "agent-tool:codex-napi-retry-event",
    }),
  );
  assert.deepEqual(
    retry,
    res,
    "same requestId returns the original result despite fresh transport identity",
  );
  await assert.rejects(
    backend.agentCodexCreate({ ...payload, name: "別人" }),
    /AGENT_CODEX_CREATE_IDEMPOTENCY_CONFLICT/,
  );
});

test("agentCodexCreate: N-API authority rejection leaves write tables unchanged", async () => {
  const invalidCaller = {
    ...canonical("napi-invalid-authority-caller", "human"),
    caller: "background-maintenance-v2",
    entryId: "napi-invalid-authority-caller-entry",
    typeSlug: "character",
    name: "invalid caller",
    content: "{}",
    authorshipSpans: [],
  };
  const beforeInvalidCaller = await writeCounts();
  await assert.rejects(
    backend.agentCodexCreate(invalidCaller),
    /Forbidden caller/,
  );
  assert.deepEqual(await writeCounts(), beforeInvalidCaller);

  const missingControl = {
    ...canonical("napi-missing-authority-control", "human"),
    controls: [],
    entryId: "napi-missing-authority-control-entry",
    typeSlug: "character",
    name: "missing control",
    content: "{}",
    authorshipSpans: [],
  };
  const beforeMissingControl = await writeCounts();
  await assert.rejects(
    backend.agentCodexCreate(missingControl),
    /Missing required control/,
  );
  assert.deepEqual(await writeCounts(), beforeMissingControl);
});

test("agentCodexMutate creates a Detail Definition and semantic binding atomically", async () => {
  const created = JSON.parse(
    await backend.agentCodexMutate({
      ...canonical("preset-semantic-create", "human"),
      operation: "detail.definition.create",
      projectId: PROJECT,
      sessionId: "preset-semantic-session",
      surface: "manual",
      definitionId: "definition-semantic-napi",
      typeSlug: "character",
      name: "Role",
      fieldType: "dropdown",
      sortOrder: 1,
      includeInContext: 1,
      semanticBinding: {
        id: "binding-semantic-napi",
        facetKey: "role.current",
        projectionKind: "enum",
        temporalPolicy: "base-and-phase",
        source: "preset",
        confirmed: false,
      },
    }),
  );
  assert.equal(created.entityId, "definition-semantic-napi");
  assert.equal(created.version, 0);

  const binding = await rows(
    `SELECT project_id, definition_id, facet_key, projection_kind,
            temporal_policy, source, confirmed, version
       FROM codex_detail_semantic_bindings WHERE id = ?`,
    ["binding-semantic-napi"],
  );
  assert.deepEqual(binding, [
    {
      project_id: PROJECT,
      definition_id: "definition-semantic-napi",
      facet_key: "role.current",
      projection_kind: "enum",
      temporal_policy: "base-and-phase",
      source: "preset",
      confirmed: 0,
      version: 0,
    },
  ]);

  await assert.rejects(
    backend.agentCodexMutate({
      ...canonical("preset-semantic-conflict", "human"),
      operation: "detail.definition.create",
      projectId: PROJECT,
      sessionId: "preset-semantic-session",
      surface: "manual",
      definitionId: "definition-semantic-rolled-back-napi",
      typeSlug: "character",
      name: "Duplicate semantic binding id",
      fieldType: "text",
      sortOrder: 2,
      includeInContext: 1,
      semanticBinding: {
        id: "binding-semantic-napi",
        facetKey: "goal.active",
        projectionKind: "summary-text",
        temporalPolicy: "phase-on-durable-change",
        source: "preset",
        confirmed: false,
      },
    }),
  );
  assert.deepEqual(
    await rows("SELECT id FROM codex_detail_definitions WHERE id = ?", [
      "definition-semantic-rolled-back-napi",
    ]),
    [],
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
  await assert.rejects(
    backend.agentEventCreate({
      projectId: PROJECT,
      sessionId: "sess-missing-event-request",
      title: "missing request",
    }),
    /requestId|request_id/,
  );
  await assert.rejects(
    backend.agentSceneEventLink({
      projectId: PROJECT,
      sessionId: "sess-missing-scene-link-request",
      sceneId: "scene-missing",
      eventId: "event-missing",
    }),
    /requestId|request_id/,
  );
  await assert.rejects(
    backend.agentEventRelationAdd({
      projectId: PROJECT,
      sessionId: "sess-missing-relation-request",
      causeEventId: "event-a",
      effectEventId: "event-b",
    }),
    /requestId|request_id/,
  );
});

test("manual Snippet CRUD crosses napi through one canonical transaction per write", async () => {
  const identity = (requestId) => canonical(requestId, "human");
  const createPayload = {
    ...identity("manual-snippet-create-napi"),
    snippetId: "manual-snippet-napi",
    title: "Manual",
    content: "{}",
    tagsCache: null,
    contentSource: "human",
    sceneId: null,
    sourceChatMessageId: null,
    canonicalPayload: { title: "Manual", sceneId: null },
  };
  const created = JSON.parse(await backend.snippetCreate(createPayload));
  assert.deepEqual(
    JSON.parse(
      await backend.snippetCreate({
        ...createPayload,
        sessionId: "manual-snippet-create-retry-session",
        eventUid: "manual-snippet-create-retry-event",
      }),
    ),
    created,
  );
  assert.equal(created.entityId, createPayload.snippetId);
  assert.equal(created.version, 1);

  const updated = JSON.parse(
    await backend.snippetUpdate({
      ...identity("manual-snippet-update-napi"),
      snippetId: createPayload.snippetId,
      baseVersion: created.version,
      title: "Updated",
      canonicalPayload: { fields: ["title"] },
    }),
  );
  assert.equal(updated.version, 2);

  const deleted = JSON.parse(
    await backend.snippetDelete({
      ...identity("manual-snippet-delete-napi"),
      snippetId: createPayload.snippetId,
      baseVersion: updated.version,
      canonicalPayload: { title: "Updated" },
    }),
  );
  assert.equal(deleted.version, 2);
  assert.deepEqual(
    await rows(
      `SELECT
         (SELECT COUNT(*) FROM snippets WHERE id = ?) AS domain_count,
         (SELECT COUNT(*) FROM undo_journal
           WHERE id IN (?, ?, ?)) AS journal_count,
         (SELECT COUNT(*) FROM narrative_change_transactions
           WHERE request_id IN (?, ?, ?)) AS feed_count`,
      [
        createPayload.snippetId,
        createPayload.requestId,
        "manual-snippet-update-napi",
        "manual-snippet-delete-napi",
        createPayload.requestId,
        "manual-snippet-update-napi",
        "manual-snippet-delete-napi",
      ],
    ),
    [{ domain_count: 0, journal_count: 3, feed_count: 3 }],
  );
});

test("agentEventCreate/Update: Chronicle minute境界と同一端点をN-API越しに保持する", async () => {
  const created = JSON.parse(
    await backend.agentEventCreate({
      requestId: "agent-tool:event-napi-chronicle-boundaries-1",
      projectId: PROJECT,
      sessionId: "sess-chronicle-boundaries",
      title: "境界日時",
      startTime: 10,
      startMinute: 0,
      startGranularity: "time",
      endTime: 10,
      endMinute: 1439,
      endGranularity: "time",
    }),
  );
  assert.equal(created.version, 1);

  const boundaryRow = await rows(
    `SELECT start_time, start_minute, end_time, end_minute
       FROM events WHERE id = ?`,
    [created.entityId],
  );
  assert.deepEqual(boundaryRow[0], {
    start_time: 10,
    start_minute: 0,
    end_time: 10,
    end_minute: 1439,
  });

  const updated = JSON.parse(
    await backend.agentEventUpdate({
      requestId: "agent-tool:event-napi-chronicle-update-1",
      projectId: PROJECT,
      sessionId: "sess-chronicle-boundaries",
      eventId: created.entityId,
      baseVersion: created.version,
      endTime: 10,
      endMinute: 0,
      endGranularity: "time",
    }),
  );
  assert.equal(updated.version, 2);

  const equalEndpoints = await rows(
    `SELECT start_time, start_minute, end_time, end_minute
       FROM events WHERE id = ?`,
    [created.entityId],
  );
  assert.deepEqual(equalEndpoints[0], {
    start_time: 10,
    start_minute: 0,
    end_time: 10,
    end_minute: 0,
  });
});

test("agentCodexUpdate: 存在しない entry は reject し、副作用を残さない（ROLLBACK）", async () => {
  const before = await rows("SELECT COUNT(*) AS n FROM change_events");
  await assert.rejects(
    backend.agentCodexUpdate({
      ...canonical("missing-codex-update", "ai-apply"),
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

test("agentChronicleBulkMutate: mixed selection は1 journalで原子的に往復する", async () => {
  const eventId = "chronicle-bulk-napi-event-1";
  const datedEventId = "chronicle-bulk-napi-event-2";
  const sceneId = "chronicle-bulk-napi-scene-1";
  const datedSceneId = "chronicle-bulk-napi-scene-2";
  await backend.agentEventCreate({
    requestId: `fixture:${eventId}`,
    eventId,
    projectId: PROJECT,
    sessionId: "sess-bulk-fixture",
    surface: "manual",
    title: "Bulk event",
    ordinal: "z-bulk",
    startTime: 42,
    startMinute: 90,
    startGranularity: "time",
    endGranularity: "none",
    precision: "exact",
    kind: "generic",
  });
  await backend.agentEventCreate({
    requestId: `fixture:${datedEventId}`,
    eventId: datedEventId,
    projectId: PROJECT,
    sessionId: "sess-bulk-fixture",
    surface: "manual",
    title: "Dated bulk event",
    ordinal: "z-bulk-2",
    startTime: 142,
    startGranularity: "day",
    endGranularity: "none",
    precision: "exact",
    kind: "generic",
  });

  const scene = JSON.parse(
    await backend.treeNodeCreate({
      ...canonical(`tree-create:${sceneId}`, "human"),
      id: sceneId,
      projectId: PROJECT,
      parentId: null,
      nodeType: "scene",
      title: "Bulk scene",
      sortOrder: "z-bulk",
      content: "{}",
    }),
  );
  const sceneTemporal = JSON.parse(
    await backend.temporalScenePatch({
      ...canonical(`temporal-patch:${sceneId}`, "human"),
      projectId: PROJECT,
      targetId: sceneId,
      baseVersion: scene.version,
      startTime: 84,
      startGranularity: "day",
      endGranularity: "none",
      precision: "exact",
    }),
  );
  const sceneUpdatedAt = sceneTemporal.updatedAt;

  const datedScene = JSON.parse(
    await backend.treeNodeCreate({
      ...canonical(`tree-create:${datedSceneId}`, "human"),
      id: datedSceneId,
      projectId: PROJECT,
      parentId: null,
      nodeType: "scene",
      title: "Dated bulk scene",
      sortOrder: "z-bulk-2",
      content: "{}",
    }),
  );
  const datedSceneTemporal = JSON.parse(
    await backend.temporalScenePatch({
      ...canonical(`temporal-patch:${datedSceneId}`, "human"),
      projectId: PROJECT,
      targetId: datedSceneId,
      baseVersion: datedScene.version,
      startTime: 184,
      startGranularity: "day",
      endGranularity: "none",
      precision: "exact",
    }),
  );
  const datedSceneUpdatedAt = datedSceneTemporal.updatedAt;

  const result = JSON.parse(
    await backend.agentChronicleBulkMutate({
      requestId: "chronicle-bulk-napi-forward-1",
      projectId: PROJECT,
      sessionId: "sess-bulk",
      surface: "manual",
      operations: [
        { kind: "eventDelete", eventId, baseVersion: 1 },
        { kind: "sceneClearDate", sceneId, baseUpdatedAt: sceneUpdatedAt },
        {
          kind: "eventSetDate",
          eventId: datedEventId,
          baseVersion: 1,
          startTime: 143,
          startMinute: 120,
          startGranularity: "time",
          endTime: 144,
          endMinute: null,
          endGranularity: "day",
        },
        {
          kind: "sceneSetDate",
          sceneId: datedSceneId,
          baseUpdatedAt: datedSceneUpdatedAt,
          startTime: 185,
          startMinute: null,
          startGranularity: "day",
          endTime: 185,
          endMinute: 720,
          endGranularity: "time",
        },
      ],
    }),
  );
  assert.equal(result.eventResults[0].eventId, eventId);
  assert.equal(result.eventResults[0].version, null);
  assert.equal(result.sceneResults[0].sceneId, sceneId);
  assert.deepEqual(result.eventResults[1], {
    kind: "eventSetDate",
    eventId: datedEventId,
    version: 2,
  });
  assert.equal(result.sceneResults[1].sceneId, datedSceneId);

  const eventAfter = await rows(
    "SELECT COUNT(*) AS n FROM events WHERE id = ?",
    [eventId],
  );
  const sceneAfter = await rows(
    "SELECT chronicle_start_time, chronicle_start_granularity FROM tree_nodes WHERE id = ?",
    [sceneId],
  );
  const datedEventAfter = await rows(
    `SELECT start_time, start_minute, start_granularity,
            end_time, end_minute, end_granularity, version
       FROM events WHERE id = ?`,
    [datedEventId],
  );
  const datedSceneAfter = await rows(
    `SELECT chronicle_start_time, chronicle_start_minute,
            chronicle_start_granularity, chronicle_end_time,
            chronicle_end_minute, chronicle_end_granularity
       FROM tree_nodes WHERE id = ?`,
    [datedSceneId],
  );
  const journal = await rows(
    "SELECT entity_kind, op_kind FROM undo_journal WHERE id = ?",
    [result.undoJournalId],
  );
  const changeEvent = await rows(
    "SELECT op_type FROM change_events WHERE event_uid = ?",
    [result.changeEventUid],
  );
  assert.equal(eventAfter[0].n, 0);
  assert.equal(sceneAfter[0].chronicle_start_time, null);
  assert.equal(sceneAfter[0].chronicle_start_granularity, "none");
  assert.deepEqual(datedEventAfter[0], {
    start_time: 143,
    start_minute: 120,
    start_granularity: "time",
    end_time: 144,
    end_minute: null,
    end_granularity: "day",
    version: 2,
  });
  assert.deepEqual(datedSceneAfter[0], {
    chronicle_start_time: 185,
    chronicle_start_minute: null,
    chronicle_start_granularity: "day",
    chronicle_end_time: 185,
    chronicle_end_minute: 720,
    chronicle_end_granularity: "time",
  });
  assert.deepEqual(journal[0], {
    entity_kind: "chronicle_bulk",
    op_kind: "update",
  });
  assert.equal(changeEvent[0].op_type, "chronicle.bulk");

  await backend.agentApplyUndoJournal({
    requestId: "chronicle-bulk-napi-undo-1",
    projectId: PROJECT,
    sessionId: "sess-bulk",
    journalId: result.undoJournalId,
    direction: "undo",
  });
  const eventUndo = await rows("SELECT version FROM events WHERE id = ?", [
    eventId,
  ]);
  const sceneUndo = await rows(
    "SELECT chronicle_start_time, chronicle_start_granularity FROM tree_nodes WHERE id = ?",
    [sceneId],
  );
  const datedEventUndo = await rows(
    `SELECT start_time, start_minute, start_granularity,
            end_time, end_minute, end_granularity, version
       FROM events WHERE id = ?`,
    [datedEventId],
  );
  const datedSceneUndo = await rows(
    `SELECT chronicle_start_time, chronicle_start_minute,
            chronicle_start_granularity, chronicle_end_time,
            chronicle_end_minute, chronicle_end_granularity
       FROM tree_nodes WHERE id = ?`,
    [datedSceneId],
  );
  assert.equal(eventUndo[0].version, 2);
  assert.equal(sceneUndo[0].chronicle_start_time, 84);
  assert.equal(sceneUndo[0].chronicle_start_granularity, "day");
  assert.deepEqual(datedEventUndo[0], {
    start_time: 142,
    start_minute: null,
    start_granularity: "day",
    end_time: null,
    end_minute: null,
    end_granularity: "none",
    version: 3,
  });
  assert.deepEqual(datedSceneUndo[0], {
    chronicle_start_time: 184,
    chronicle_start_minute: null,
    chronicle_start_granularity: "day",
    chronicle_end_time: null,
    chronicle_end_minute: null,
    chronicle_end_granularity: "none",
  });
});
