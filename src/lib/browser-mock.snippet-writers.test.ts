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

function identity(requestId: string) {
  return {
    requestId,
    sessionId: `${requestId}:session`,
    eventUid: `${requestId}:event`,
    origin: "human",
    originalTransactionId: null,
    undoJournalId: null,
    projectId: "snippet-project",
  };
}

describe("BrowserMock canonical Snippet writers", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({
      onDatabaseDirty,
      allowProtectedWriterTestFixtures: true,
    });
    await run(
      mock,
      `INSERT INTO projects (id, title) VALUES
        ('snippet-project', 'Snippet'), ('snippet-foreign', 'Foreign')`,
    );
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order, version)
       VALUES
        ('snippet-scene', 'snippet-project', 'scene', 'Scene', 'a0', 0),
        ('snippet-foreign-scene', 'snippet-foreign', 'scene', 'Foreign', 'a0', 0)`,
    );
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("atomically tracks create/update/delete and returns exact retry receipts", async () => {
    const createPayload = {
      ...identity("snippet-create"),
      snippetId: "snippet-one",
      title: "Before",
      content: '{"type":"doc","content":[]}',
      tagsCache: null,
      contentSource: "human",
      sceneId: "snippet-scene",
      sourceChatMessageId: null,
      canonicalPayload: { action: "create" },
    };
    const created = await mock.invoke<Record<string, unknown>>(
      "snippet_create",
      {
        payload: createPayload,
      },
    );
    const createRetry = await mock.invoke<Record<string, unknown>>(
      "snippet_create",
      {
        payload: {
          ...createPayload,
          sessionId: "snippet-create:retry",
          eventUid: "snippet-create:retry-event",
        },
      },
    );
    expect(createRetry).toEqual(created);
    expect(created).toMatchObject({
      entityId: "snippet-one",
      version: 1,
      changeEventUid: "snippet-create:event",
      undoJournalId: "snippet-create",
      maintenanceTransactionId: expect.any(String),
    });
    await expect(
      mock.invoke("snippet_create", {
        payload: { ...createPayload, title: "Conflict" },
      }),
    ).rejects.toThrow("SNIPPET_CREATE_IDEMPOTENCY_CONFLICT");

    const updatePayload = {
      ...identity("snippet-update"),
      snippetId: "snippet-one",
      baseVersion: 1,
      title: "After",
      content: '{"type":"doc","content":[{"type":"paragraph"}]}',
      sceneId: "",
      canonicalPayload: { action: "update" },
    };
    const updated = await mock.invoke<Record<string, unknown>>(
      "snippet_update",
      {
        payload: updatePayload,
      },
    );
    const updateRetry = await mock.invoke<Record<string, unknown>>(
      "snippet_update",
      {
        payload: {
          ...updatePayload,
          sessionId: "snippet-update:retry",
          eventUid: "snippet-update:retry-event",
        },
      },
    );
    expect(updateRetry).toEqual(updated);
    expect(updated).toMatchObject({ entityId: "snippet-one", version: 2 });

    const deleted = await mock.invoke<Record<string, unknown>>(
      "snippet_delete",
      {
        payload: {
          ...identity("snippet-delete"),
          snippetId: "snippet-one",
          baseVersion: 2,
          canonicalPayload: { action: "delete" },
        },
      },
    );
    expect(deleted).toMatchObject({ entityId: "snippet-one", version: 2 });
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM snippets WHERE id = 'snippet-one') AS domain_count,
           (SELECT COUNT(*) FROM undo_journal
             WHERE id IN ('snippet-create', 'snippet-update', 'snippet-delete')) AS journal_count,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id IN ('snippet-create', 'snippet-update', 'snippet-delete')) AS feed_count,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id IN ('snippet-create', 'snippet-update', 'snippet-delete')) AS receipt_count`,
      ),
    ).toEqual([
      { domain_count: 0, journal_count: 3, feed_count: 3, receipt_count: 3 },
    ]);
  });

  it("fails closed on foreign references and rolls domain, journal, canonical, Feed, and receipt back", async () => {
    await expect(
      mock.invoke("snippet_create", {
        payload: {
          ...identity("snippet-foreign-scene-create"),
          snippetId: "snippet-foreign-reference",
          title: "Foreign",
          content: "{}",
          sceneId: "snippet-foreign-scene",
        },
      }),
    ).rejects.toThrow("not in project");
    await run(
      mock,
      `CREATE TRIGGER reject_snippet_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN SELECT RAISE(ABORT, 'forced Snippet Feed failure'); END`,
    );
    await expect(
      mock.invoke("snippet_create", {
        payload: {
          ...identity("snippet-feed-rollback"),
          snippetId: "snippet-rollback",
          title: "Rollback",
          content: "{}",
          sceneId: "snippet-scene",
        },
      }),
    ).rejects.toThrow("forced Snippet Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM snippets WHERE id = 'snippet-rollback') AS domain_count,
           (SELECT COUNT(*) FROM undo_journal WHERE id = 'snippet-feed-rollback') AS journal_count,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'snippet-feed-rollback:event') AS canonical_count,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'snippet-feed-rollback') AS feed_count,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'snippet_create'
               AND request_id = 'snippet-feed-rollback') AS receipt_count`,
      ),
    ).toEqual([
      {
        domain_count: 0,
        journal_count: 0,
        canonical_count: 0,
        feed_count: 0,
        receipt_count: 0,
      },
    ]);
  });

  it("replays Snippet journals with monotonic versions and explicit Undo/Redo lineage", async () => {
    const created = await mock.invoke<Record<string, unknown>>(
      "snippet_create",
      {
        payload: {
          ...identity("snippet-history-create"),
          snippetId: "snippet-history",
          title: "History",
          content: "{}",
          sceneId: null,
        },
      },
    );
    const undo = await mock.invoke<Record<string, unknown>>(
      "agent_apply_undo_journal",
      {
        payload: {
          requestId: "snippet-history-undo",
          projectId: "snippet-project",
          sessionId: "snippet-history-session",
          journalId: created.undoJournalId,
          direction: "undo",
        },
      },
    );
    const redo = await mock.invoke<Record<string, unknown>>(
      "agent_apply_undo_journal",
      {
        payload: {
          requestId: "snippet-history-redo",
          projectId: "snippet-project",
          sessionId: "snippet-history-session",
          journalId: created.undoJournalId,
          direction: "redo",
        },
      },
    );
    expect(undo).toMatchObject({
      ok: true,
      maintenanceTransactionId: expect.any(String),
      undoJournalId: "snippet-history-create",
    });
    expect(redo).toMatchObject({
      ok: true,
      maintenanceTransactionId: expect.any(String),
      undoJournalId: "snippet-history-create",
    });
    expect(
      await rows(
        mock,
        `SELECT snippet.version,
                (SELECT result_version FROM undo_journal
                  WHERE id = 'snippet-history-create') AS journal_version,
                undo_tx.origin AS undo_origin,
                redo_tx.origin AS redo_origin,
                undo_tx.original_transaction_id AS undo_root,
                redo_tx.original_transaction_id AS redo_root
           FROM snippets snippet
           JOIN narrative_change_transactions forward_tx
             ON forward_tx.request_id = 'snippet-history-create'
           JOIN narrative_change_transactions undo_tx
             ON undo_tx.request_id = 'snippet-history-undo'
           JOIN narrative_change_transactions redo_tx
             ON redo_tx.request_id = 'snippet-history-redo'
          WHERE snippet.id = 'snippet-history'`,
      ),
    ).toEqual([
      {
        version: 2,
        journal_version: 2,
        undo_origin: "undo",
        redo_origin: "redo",
        undo_root: created.maintenanceTransactionId,
        redo_root: created.maintenanceTransactionId,
      },
    ]);
  });

  it("rolls a Snippet Undo replay back when its Feed append fails", async () => {
    const created = await mock.invoke<Record<string, unknown>>(
      "snippet_create",
      {
        payload: {
          ...identity("snippet-undo-rollback-create"),
          snippetId: "snippet-undo-rollback",
          title: "Keep me",
          content: "{}",
          sceneId: null,
        },
      },
    );
    await run(
      mock,
      `CREATE TRIGGER reject_snippet_undo_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN SELECT RAISE(ABORT, 'forced Snippet Undo Feed failure'); END`,
    );
    await expect(
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId: "snippet-undo-rollback",
          projectId: "snippet-project",
          sessionId: "snippet-undo-rollback-session",
          journalId: created.undoJournalId,
          direction: "undo",
        },
      }),
    ).rejects.toThrow("forced Snippet Undo Feed failure");
    expect(
      await rows(
        mock,
        `SELECT snippet.version,
                (SELECT COUNT(*) FROM change_events
                  WHERE event_uid != 'snippet-undo-rollback-create:event'
                    AND domain = 'snippet') AS replay_canonical_count,
                (SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE request_id = 'snippet-undo-rollback') AS replay_feed_count,
                (SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = 'agent_apply_undo_journal'
                    AND request_id = 'snippet-undo-rollback') AS receipt_count
           FROM snippets snippet WHERE snippet.id = 'snippet-undo-rollback'`,
      ),
    ).toEqual([
      {
        version: 1,
        replay_canonical_count: 0,
        replay_feed_count: 0,
        receipt_count: 0,
      },
    ]);
  });

  it("replays Snippet update and delete journals without reusing old OCC tokens", async () => {
    await mock.invoke("snippet_create", {
      payload: {
        ...identity("snippet-update-history-create"),
        snippetId: "snippet-update-history",
        title: "Before",
        content: "{}",
      },
    });
    const updated = await mock.invoke<Record<string, unknown>>(
      "snippet_update",
      {
        payload: {
          ...identity("snippet-update-history"),
          snippetId: "snippet-update-history",
          baseVersion: 1,
          title: "After",
        },
      },
    );
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "snippet-update-history-undo",
        projectId: "snippet-project",
        sessionId: "snippet-update-history-session",
        journalId: updated.undoJournalId,
        direction: "undo",
      },
    });
    expect(
      await rows(
        mock,
        "SELECT title, version FROM snippets WHERE id = 'snippet-update-history'",
      ),
    ).toEqual([{ title: "Before", version: 3 }]);
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "snippet-update-history-redo",
        projectId: "snippet-project",
        sessionId: "snippet-update-history-session",
        journalId: updated.undoJournalId,
        direction: "redo",
      },
    });
    expect(
      await rows(
        mock,
        "SELECT title, version FROM snippets WHERE id = 'snippet-update-history'",
      ),
    ).toEqual([{ title: "After", version: 4 }]);

    await mock.invoke("snippet_create", {
      payload: {
        ...identity("snippet-delete-history-create"),
        snippetId: "snippet-delete-history",
        title: "Delete",
        content: "{}",
      },
    });
    const deleted = await mock.invoke<Record<string, unknown>>(
      "snippet_delete",
      {
        payload: {
          ...identity("snippet-delete-history"),
          snippetId: "snippet-delete-history",
          baseVersion: 1,
        },
      },
    );
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "snippet-delete-history-undo",
        projectId: "snippet-project",
        sessionId: "snippet-delete-history-session",
        journalId: deleted.undoJournalId,
        direction: "undo",
      },
    });
    expect(
      await rows(
        mock,
        "SELECT title, version FROM snippets WHERE id = 'snippet-delete-history'",
      ),
    ).toEqual([{ title: "Delete", version: 2 }]);
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "snippet-delete-history-redo",
        projectId: "snippet-project",
        sessionId: "snippet-delete-history-session",
        journalId: deleted.undoJournalId,
        direction: "redo",
      },
    });
    expect(
      await rows(
        mock,
        "SELECT id FROM snippets WHERE id = 'snippet-delete-history'",
      ),
    ).toEqual([]);
  });
});
