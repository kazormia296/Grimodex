// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

async function run(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await mock.invoke("db_execute", { sql, params, method: "run" });
}

async function rows(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql, params, method: "all" },
  );
  return result.rows;
}

function payload(requestId = "browser-integrity-repair") {
  return {
    projectId: "browser-repair-p1",
    requestId,
    sessionId: "browser-repair-session",
    eventUid: requestId,
    occurredAt: "2026-08-13T10:00:00.000Z",
    authorityRoute: "restore-or-migration",
    caller: "integrity-repair",
    controls: [
      "exclusive-system-operation",
      "semantic-epoch-event",
      "full-rebuild-marker",
    ],
    provenance: null,
    writesAuthorityProtectedField: false,
  };
}

describe("Browser Mock integrity repair canonical writer", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({
      onDatabaseDirty,
      allowProtectedWriterTestFixtures: true,
    });
    await run(mock, "PRAGMA foreign_keys = OFF");
    await run(
      mock,
      "INSERT INTO projects (id, title) VALUES ('browser-repair-p1', 'One'), ('browser-repair-p2', 'Two')",
    );
    await run(
      mock,
      `INSERT INTO tree_nodes (id, project_id, node_type, title, sort_order)
       VALUES ('browser-cross-scene', 'browser-repair-p2', 'scene', 'Foreign scene', 'a0')`,
    );
    await run(
      mock,
      `INSERT INTO chat_sessions (id, project_id, title)
       VALUES ('browser-cross-session', 'browser-repair-p2', 'Foreign session')`,
    );
    await run(
      mock,
      `INSERT INTO chat_messages (id, session_id, role, content)
       VALUES ('browser-cross-message', 'browser-cross-session', 'user', 'Foreign')`,
    );
    await run(
      mock,
      `INSERT INTO codex_entries
         (id, project_id, type, name, source_chat_message_id, version)
       VALUES
         ('browser-codex-b', 'browser-repair-p1', 'character', 'B', 'browser-cross-message', 4),
         ('browser-codex-a', 'browser-repair-p1', 'character', 'A', 'missing-a', 2),
         ('browser-codex-other', 'browser-repair-p2', 'character', 'Other', 'missing-other', 8)`,
    );
    await run(
      mock,
      `INSERT INTO snippets
         (id, project_id, title, source_chat_message_id, scene_id, version)
       VALUES
         ('browser-snippet-b', 'browser-repair-p1', 'B', 'browser-cross-message', 'browser-cross-scene', 7),
         ('browser-snippet-a', 'browser-repair-p1', 'A', 'missing-a', NULL, 3),
         ('browser-snippet-other', 'browser-repair-p2', 'Other', 'missing-other', 'missing-scene-other', 9)`,
    );
    await run(mock, "PRAGMA foreign_keys = ON");
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("repairs only one project in deterministic Feed order and replays one logical request", async () => {
    await expect(
      mock.invoke("integrity_check", { projectId: "browser-repair-p1" }),
    ).resolves.toEqual({
      orphanedCodexSources: 2,
      orphanedSnippetSources: 2,
      orphanedSnippetScenes: 1,
    });

    const first = await mock.invoke<Record<string, unknown>>(
      "repair_integrity",
      { payload: payload() },
    );
    const retry = await mock.invoke<Record<string, unknown>>(
      "repair_integrity",
      {
        payload: {
          ...payload(),
          sessionId: "browser-repair-session-after-restart",
          eventUid: "browser-repair-event-after-restart",
        },
      },
    );
    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      codexSourcesFixed: 2,
      snippetSourcesFixed: 2,
      snippetScenesFixed: 1,
      changeEventUid: "browser-integrity-repair",
    });
    await expect(
      mock.invoke("repair_integrity", {
        payload: {
          ...payload(),
          occurredAt: "2026-08-13T10:00:01.000Z",
        },
      }),
    ).rejects.toThrow("REPAIR_INTEGRITY_IDEMPOTENCY_CONFLICT");

    expect(
      await rows(
        mock,
        `SELECT event.object_key_json AS objectKey,
                event.changed_paths_json AS changedPaths
           FROM narrative_change_events event
           JOIN narrative_change_transactions transaction_row
             ON transaction_row.id = event.transaction_id
          WHERE transaction_row.request_id = ?
          ORDER BY event.event_ordinal`,
        [payload().requestId],
      ),
    ).toEqual([
      {
        objectKey: '{"entryId":"browser-codex-a","kind":"codex-entry"}',
        changedPaths: '["/sourceChatMessageId"]',
      },
      {
        objectKey: '{"entryId":"browser-codex-b","kind":"codex-entry"}',
        changedPaths: '["/sourceChatMessageId"]',
      },
      {
        objectKey:
          '{"componentId":"snippet:browser-snippet-a","kind":"component"}',
        changedPaths: '["/sourceChatMessageId"]',
      },
      {
        objectKey:
          '{"componentId":"snippet:browser-snippet-b","kind":"component"}',
        changedPaths: '["/sceneId","/sourceChatMessageId"]',
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM chat_messages message
             JOIN chat_sessions session ON session.id = message.session_id
            WHERE message.id = 'browser-cross-message'
              AND session.project_id = 'browser-repair-p2') AS foreignMessage,
           (SELECT COUNT(*) FROM tree_nodes
             WHERE id = 'browser-cross-scene'
               AND project_id = 'browser-repair-p2') AS foreignScene`,
      ),
    ).toEqual([{ foreignMessage: 1, foreignScene: 1 }]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM change_events WHERE event_uid = ?) AS canonicalEvents,
           (SELECT COUNT(*) FROM narrative_change_transactions WHERE request_id = ?) AS feedTransactions,
           (SELECT COUNT(*) FROM idempotency_requests WHERE domain = 'repair_integrity' AND request_id = ?) AS receipts`,
        [payload().eventUid, payload().requestId, payload().requestId],
      ),
    ).toEqual([{ canonicalEvents: 1, feedTransactions: 1, receipts: 1 }]);
    expect(
      await rows(
        mock,
        `SELECT entry.source_chat_message_id AS codexSource,
                snippet.source_chat_message_id AS snippetSource,
                snippet.scene_id AS snippetScene,
                entry.version AS codexVersion,
                snippet.version AS snippetVersion
           FROM codex_entries entry
           JOIN snippets snippet ON snippet.project_id = entry.project_id
          WHERE entry.id = 'browser-codex-other'
            AND snippet.id = 'browser-snippet-other'`,
      ),
    ).toEqual([
      {
        codexSource: "missing-other",
        snippetSource: "missing-other",
        snippetScene: "missing-scene-other",
        codexVersion: 8,
        snippetVersion: 9,
      },
    ]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });

  it("rolls domain, canonical event, Feed, and retry receipt back on Feed failure", async () => {
    await run(
      mock,
      `CREATE TRIGGER reject_integrity_repair_feed
       BEFORE INSERT ON narrative_change_transactions
       BEGIN SELECT RAISE(ABORT, 'forced browser integrity Feed failure'); END`,
    );

    await expect(
      mock.invoke("repair_integrity", {
        payload: payload("browser-integrity-rollback"),
      }),
    ).rejects.toThrow("forced browser integrity Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT source_chat_message_id FROM codex_entries WHERE id = 'browser-codex-a') AS codexSource,
           (SELECT version FROM codex_entries WHERE id = 'browser-codex-a') AS codexVersion,
           (SELECT COUNT(*) FROM change_events WHERE event_uid = 'browser-integrity-rollback') AS canonicalEvents,
           (SELECT COUNT(*) FROM narrative_change_transactions WHERE request_id = 'browser-integrity-rollback') AS feedTransactions,
           (SELECT COUNT(*) FROM idempotency_requests WHERE domain = 'repair_integrity' AND request_id = 'browser-integrity-rollback') AS receipts`,
      ),
    ).toEqual([
      {
        codexSource: "missing-a",
        codexVersion: 2,
        canonicalEvents: 0,
        feedTransactions: 0,
        receipts: 0,
      },
    ]);
  });

  it("records a retry-safe no-op without inventing a canonical narrative event", async () => {
    await mock.invoke("repair_integrity", { payload: payload("clean-first") });
    const noOpPayload = payload("clean-no-op");
    const first = await mock.invoke("repair_integrity", {
      payload: noOpPayload,
    });
    const replay = await mock.invoke("repair_integrity", {
      payload: {
        ...noOpPayload,
        sessionId: "clean-no-op-session-after-restart",
        eventUid: "clean-no-op-event-after-restart",
      },
    });
    expect(replay).toEqual(first);
    expect(first).toEqual({
      codexSourcesFixed: 0,
      snippetSourcesFixed: 0,
      snippetScenesFixed: 0,
    });
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM change_events WHERE event_uid = 'clean-no-op') AS canonicalEvents,
           (SELECT COUNT(*) FROM narrative_change_transactions WHERE request_id = 'clean-no-op') AS feedTransactions,
           (SELECT COUNT(*) FROM idempotency_requests WHERE domain = 'repair_integrity' AND request_id = 'clean-no-op') AS receipts`,
      ),
    ).toEqual([{ canonicalEvents: 0, feedTransactions: 0, receipts: 1 }]);
  });
});
