// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  browserNarrativeStateDigest,
  createBrowserMock,
  type PersistentBrowserMock,
} from "./browser-mock";
import { withCanonicalWriterTestContext } from "./browser-mock.canonical-test-context";

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

async function createEntry(
  mock: PersistentBrowserMock,
  entryId: string,
  name = "Original",
): Promise<{
  entityId: string;
  version: number;
  changeEventUid: string;
  undoJournalId: string;
}> {
  return mock.invoke("agent_codex_create", {
    payload: {
      projectId: "default-project",
      sessionId: "codex-occ-session",
      surface: "in-app-agent",
      entryId,
      typeSlug: "character",
      name,
      summary: "Before summary",
      content: "{}",
    },
  });
}

async function replay(
  mock: PersistentBrowserMock,
  journalId: string,
  direction: "undo" | "redo",
  requestId: string,
): Promise<void> {
  await mock.invoke("agent_apply_undo_journal", {
    payload: {
      requestId,
      projectId: "default-project",
      sessionId: "codex-occ-session",
      journalId,
      direction,
    },
  });
}

async function authorshipRows(
  mock: PersistentBrowserMock,
  entryId: string,
): Promise<Record<string, unknown>[]> {
  return rows(
    mock,
    `SELECT codex_entry_id, from_pos, to_pos, source, model, chat_msg_id, trace_id
       FROM authorship_spans
      WHERE codex_entry_id = ?
      ORDER BY from_pos, to_pos, source, coalesce(model, ''),
               coalesce(chat_msg_id, ''), coalesce(trace_id, '')`,
    [entryId],
  );
}

describe("browser mock Agent Codex entry OCC and journal replay", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = withCanonicalWriterTestContext(
      await createBrowserMock({
        onDatabaseDirty,
        allowProtectedWriterTestFixtures: true,
      }),
    );
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("rejects stale update/delete without mutating the row or appending history", async () => {
    const created = await createEntry(mock, "codex-stale");
    const updated = await mock.invoke<{
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_codex_update", {
      payload: {
        projectId: "default-project",
        sessionId: "codex-occ-session",
        surface: "in-app-agent",
        entryId: "codex-stale",
        baseVersion: created.version,
        name: "Winner",
        content: "{}",
        model: "winner-model",
        authorshipSpans: [{ fromPos: 1, toPos: 2, source: "ai" }],
        authorshipSpanLanes: ["content"],
      },
    });
    expect(updated.version).toBe(2);
    const beforeConflict = await rows(
      mock,
      `SELECT
         (SELECT COUNT(*) FROM change_events
           WHERE entity_type = 'codex_entry' AND entity_id = 'codex-stale') AS events,
         (SELECT COUNT(*) FROM undo_journal
           WHERE entity_kind = 'codex_entry' AND entity_id = 'codex-stale') AS journals`,
    );
    const dirtyBeforeConflict = onDatabaseDirty.mock.calls.length;

    await expect(
      mock.invoke("agent_codex_update", {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-stale",
          baseVersion: 1,
          name: "Stale loser",
          content: '{"stale":true}',
          authorshipSpans: [{ fromPos: 8, toPos: 9, source: "unknown" }],
          authorshipSpanLanes: ["content"],
        },
      }),
    ).rejects.toThrow(/version conflict/i);
    await expect(
      mock.invoke("agent_codex_delete", {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-stale",
          baseVersion: 1,
        },
      }),
    ).rejects.toThrow(/version conflict/i);

    expect(
      await rows(
        mock,
        "SELECT name, version FROM codex_entries WHERE id = 'codex-stale'",
      ),
    ).toEqual([{ name: "Winner", version: 2 }]);
    expect(await authorshipRows(mock, "codex-stale")).toEqual([
      {
        codex_entry_id: "codex-stale",
        from_pos: 1,
        to_pos: 2,
        source: "ai",
        model: "__lane_content__",
        chat_msg_id: null,
        trace_id: null,
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM change_events
             WHERE entity_type = 'codex_entry' AND entity_id = 'codex-stale') AS events,
           (SELECT COUNT(*) FROM undo_journal
             WHERE entity_kind = 'codex_entry' AND entity_id = 'codex-stale') AS journals`,
      ),
    ).toEqual(beforeConflict);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBeforeConflict);

    expect(
      await rows(
        mock,
        `SELECT journal.id, journal.change_event_uid
           FROM undo_journal journal
           JOIN change_events event
             ON event.event_uid = journal.change_event_uid
          WHERE journal.id IN (?, ?)
          ORDER BY journal.id`,
        [created.undoJournalId, updated.undoJournalId],
      ),
    ).toHaveLength(2);
    const updateJournal = (
      await rows(
        mock,
        "SELECT before_json, after_json FROM undo_journal WHERE id = ?",
        [updated.undoJournalId],
      )
    )[0];
    expect(JSON.parse(String(updateJournal.before_json))).toMatchObject({
      id: "codex-stale",
      name: "Original",
      version: 1,
    });
    expect(JSON.parse(String(updateJournal.after_json))).toMatchObject({
      id: "codex-stale",
      name: "Winner",
      version: 2,
    });
  });

  it("enforces project ownership for entry rows and parent references", async () => {
    await mock.invoke("db_execute_batch", {
      statements: [
        {
          sql: "INSERT INTO projects (id, title) VALUES ('other-project', 'Other')",
          params: [],
          method: "run",
        },
      ],
    });
    await createEntry(mock, "owned-entry");
    await mock.invoke("agent_codex_create", {
      payload: {
        projectId: "other-project",
        sessionId: "codex-occ-session",
        entryId: "other-parent",
        typeSlug: "character",
        name: "Other parent",
      },
    });
    const historyBefore = await rows(
      mock,
      `SELECT
         (SELECT COUNT(*) FROM change_events) AS events,
         (SELECT COUNT(*) FROM undo_journal) AS journals`,
    );
    const dirtyBefore = onDatabaseDirty.mock.calls.length;

    await expect(
      mock.invoke("agent_codex_create", {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "cross-project-child",
          typeSlug: "character",
          name: "Invalid child",
          parentId: "other-parent",
        },
      }),
    ).rejects.toThrow(/parent.*not in project/i);
    await expect(
      mock.invoke("agent_codex_update", {
        payload: {
          projectId: "other-project",
          sessionId: "codex-occ-session",
          entryId: "owned-entry",
          baseVersion: 1,
          name: "Cross-project update",
        },
      }),
    ).rejects.toThrow(/not in project/i);
    await expect(
      mock.invoke("agent_codex_delete", {
        payload: {
          projectId: "other-project",
          sessionId: "codex-occ-session",
          entryId: "owned-entry",
          baseVersion: 1,
        },
      }),
    ).rejects.toThrow(/not in project/i);

    expect(
      await rows(
        mock,
        "SELECT name, version FROM codex_entries WHERE id = 'owned-entry'",
      ),
    ).toEqual([{ name: "Original", version: 1 }]);
    expect(
      await rows(
        mock,
        "SELECT id FROM codex_entries WHERE id = 'cross-project-child'",
      ),
    ).toEqual([]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM change_events) AS events,
           (SELECT COUNT(*) FROM undo_journal) AS journals`,
      ),
    ).toEqual(historyBefore);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBefore);
  });

  it("returns the original create result for an exact request retry without new side effects", async () => {
    const requestId = "codex-create-idempotent";
    const firstPayload = {
      requestId,
      projectId: "default-project",
      sessionId: "codex-create-first-session",
      surface: null,
      typeSlug: "character",
      name: "Idempotent character",
      summary: null,
      content: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "text",
            text: "AI prose",
            marks: [
              {
                type: "authorship",
                attrs: { source: "ai", timestamp: "first-attempt" },
              },
            ],
          },
        ],
      }),
      aliases: null,
      excludedAliases: null,
      readings: null,
      tagsCache: null,
      parentId: null,
      contextMode: "always",
      icon: "star",
      childrenBudget: "standard",
      notes: "private",
      sourceChatMessageId: null,
      model: "fallback-model",
      chatMessageId: "chat-message",
      traceId: "trace-id",
      authorshipSpans: [
        { fromPos: 8, toPos: 12, source: "ai" },
        { fromPos: 1, toPos: 4, source: "human", model: "human-model" },
      ],
    };
    const first = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_codex_create", { payload: firstPayload });
    const countsAfterFirst = await rows(
      mock,
      `SELECT
         (SELECT COUNT(*) FROM codex_entries) AS entries,
         (SELECT COUNT(*) FROM authorship_spans) AS spans,
         (SELECT COUNT(*) FROM change_events) AS events,
         (SELECT COUNT(*) FROM undo_journal) AS journals,
         (SELECT COUNT(*) FROM idempotency_requests
           WHERE domain = 'agent_codex_create') AS receipts`,
    );
    const dirtyAfterFirst = onDatabaseDirty.mock.calls.length;

    const retry = await mock.invoke<typeof first>("agent_codex_create", {
      payload: {
        ...firstPayload,
        entryId: "ignored-retry-entry-id",
        sessionId: "codex-create-retry-session",
        summary: "",
        content: JSON.stringify({
          content: [
            {
              marks: [
                {
                  attrs: { timestamp: "retry-attempt", source: "ai" },
                  type: "authorship",
                },
              ],
              text: "AI prose",
              type: "text",
            },
          ],
          type: "doc",
        }),
      },
    });

    expect(retry).toEqual(first);
    expect(first.entityId).not.toBe("ignored-retry-entry-id");
    expect(first.undoJournalId).toBe(requestId);
    expect(
      await rows(
        mock,
        `SELECT context_mode, icon, children_budget, notes
           FROM codex_entries WHERE id = ?`,
        [first.entityId],
      ),
    ).toEqual([
      {
        context_mode: "always",
        icon: "star",
        children_budget: "standard",
        notes: "private",
      },
    ]);
    const [journal] = await rows(
      mock,
      "SELECT after_json FROM undo_journal WHERE id = ?",
      [requestId],
    );
    expect(JSON.parse(String(journal?.after_json))).toMatchObject({
      contextMode: "always",
      icon: "star",
      childrenBudget: "standard",
      notes: "private",
    });
    expect(
      await rows(
        mock,
        `SELECT project_id, tombstone_json
           FROM idempotency_requests
          WHERE domain = 'agent_codex_create' AND request_id = ?`,
        [requestId],
      ),
    ).toEqual([
      {
        project_id: "default-project",
        tombstone_json: JSON.stringify(first),
      },
    ]);
    expect(
      await rows(
        mock,
        "SELECT id FROM codex_entries WHERE id = 'ignored-retry-entry-id'",
      ),
    ).toEqual([]);
    expect(
      await rows(
        mock,
        `SELECT payload FROM change_events
          WHERE event_uid = ? AND entity_id = ?`,
        [first.changeEventUid, first.entityId],
      ),
    ).toEqual([
      {
        payload: expect.stringContaining('"requestHash"'),
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM codex_entries) AS entries,
           (SELECT COUNT(*) FROM authorship_spans) AS spans,
           (SELECT COUNT(*) FROM change_events) AS events,
           (SELECT COUNT(*) FROM undo_journal) AS journals,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'agent_codex_create') AS receipts`,
      ),
    ).toEqual(countsAfterFirst);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyAfterFirst);
  });

  it.each([
    ["contextMode", "mentioned"],
    ["icon", "moon"],
    ["childrenBudget", "generous"],
    ["notes", "changed private notes"],
  ] as const)(
    "rejects a same-request create retry when %s changes",
    async (field, changedValue) => {
      const requestId = `codex-create-semantic-conflict:${field}`;
      const payload = {
        requestId,
        projectId: "default-project",
        sessionId: "codex-create-semantic-session",
        surface: "manual",
        typeSlug: "character",
        name: "Semantic character",
        summary: "",
        content: "{}",
        contextMode: "always",
        icon: "star",
        childrenBudget: "standard",
        notes: "private",
        authorshipSpans: [],
      };
      const first = await mock.invoke<{ entityId: string }>(
        "agent_codex_create",
        { payload },
      );

      await expect(
        mock.invoke("agent_codex_create", {
          payload: {
            ...payload,
            sessionId: "codex-create-semantic-retry-session",
            [field]: changedValue,
          },
        }),
      ).rejects.toThrow("AGENT_CODEX_CREATE_IDEMPOTENCY_CONFLICT");

      expect(
        await rows(
          mock,
          `SELECT context_mode, icon, children_budget, notes
             FROM codex_entries WHERE id = ?`,
          [first.entityId],
        ),
      ).toEqual([
        {
          context_mode: "always",
          icon: "star",
          children_budget: "standard",
          notes: "private",
        },
      ]);
    },
  );

  it("replays create results from the journal across update, undo/redo, and delete state", async () => {
    const historyCounts = () =>
      rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM codex_entries) AS entries,
           (SELECT COUNT(*) FROM authorship_spans) AS spans,
           (SELECT COUNT(*) FROM change_events) AS events,
           (SELECT COUNT(*) FROM undo_journal) AS journals,
           (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
      );
    const payload = (suffix: string) => ({
      requestId: `codex-create-state-${suffix}`,
      entryId: `codex-create-state-entry-${suffix}`,
      projectId: "default-project",
      sessionId: "codex-occ-session",
      typeSlug: "character",
      name: `State ${suffix}`,
      authorshipSpans: [{ fromPos: 1, toPos: 2, source: "ai" }],
    });

    const updatePayload = payload("update");
    const beforeUpdate = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_codex_create", { payload: updatePayload });
    await mock.invoke("agent_codex_update", {
      payload: {
        projectId: "default-project",
        sessionId: "codex-occ-session",
        entryId: beforeUpdate.entityId,
        baseVersion: beforeUpdate.version,
        name: "Legitimate update",
      },
    });
    const countsBeforeUpdateRetry = await historyCounts();
    const dirtyBeforeUpdateRetry = onDatabaseDirty.mock.calls.length;
    expect(
      await mock.invoke("agent_codex_create", { payload: updatePayload }),
    ).toEqual(beforeUpdate);
    expect(await historyCounts()).toEqual(countsBeforeUpdateRetry);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBeforeUpdateRetry);

    const replayPayload = payload("replay");
    const beforeReplay = await mock.invoke<typeof beforeUpdate>(
      "agent_codex_create",
      { payload: replayPayload },
    );
    await replay(mock, beforeReplay.undoJournalId, "undo", "create-state-undo");
    const countsBeforeUndoRetry = await historyCounts();
    const dirtyBeforeUndoRetry = onDatabaseDirty.mock.calls.length;
    expect(
      await mock.invoke("agent_codex_create", { payload: replayPayload }),
    ).toEqual(beforeReplay);
    expect(await historyCounts()).toEqual(countsBeforeUndoRetry);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBeforeUndoRetry);
    expect(
      await rows(mock, "SELECT id FROM codex_entries WHERE id = ?", [
        beforeReplay.entityId,
      ]),
    ).toEqual([]);

    await replay(mock, beforeReplay.undoJournalId, "redo", "create-state-redo");
    const countsBeforeRedoRetry = await historyCounts();
    const dirtyBeforeRedoRetry = onDatabaseDirty.mock.calls.length;
    expect(
      await mock.invoke<typeof beforeReplay>("agent_codex_create", {
        payload: replayPayload,
      }),
    ).toEqual({ ...beforeReplay, version: 2 });
    expect(await historyCounts()).toEqual(countsBeforeRedoRetry);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBeforeRedoRetry);

    const deletePayload = payload("delete");
    const beforeDelete = await mock.invoke<typeof beforeUpdate>(
      "agent_codex_create",
      { payload: deletePayload },
    );
    await mock.invoke("agent_codex_delete", {
      payload: {
        projectId: "default-project",
        sessionId: "codex-occ-session",
        entryId: beforeDelete.entityId,
        baseVersion: beforeDelete.version,
      },
    });
    const countsBeforeDeleteRetry = await historyCounts();
    const dirtyBeforeDeleteRetry = onDatabaseDirty.mock.calls.length;
    expect(
      await mock.invoke("agent_codex_create", { payload: deletePayload }),
    ).toEqual(beforeDelete);
    expect(await historyCounts()).toEqual(countsBeforeDeleteRetry);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBeforeDeleteRetry);
    expect(
      await rows(mock, "SELECT id FROM codex_entries WHERE id = ?", [
        beforeDelete.entityId,
      ]),
    ).toEqual([]);
  });

  it("rejects create request drift and incomplete or inconsistent replay state", async () => {
    const requestId = "codex-create-conflict";
    const payload = {
      requestId,
      entryId: "codex-create-conflict-entry",
      projectId: "default-project",
      sessionId: "codex-occ-session",
      typeSlug: "character",
      name: "Original",
      authorshipSpans: [{ fromPos: 1, toPos: 3, source: "ai" }],
    };
    const first = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_codex_create", { payload });
    const conflict = /AGENT_CODEX_CREATE_IDEMPOTENCY_CONFLICT/;

    await expect(
      mock.invoke("agent_codex_create", {
        payload: {
          ...payload,
          authorshipSpans: [{ fromPos: 1, toPos: 4, source: "ai" }],
        },
      }),
    ).rejects.toThrow(conflict);
    await mock.invoke("db_execute", {
      sql: `UPDATE idempotency_requests
               SET tombstone_json = '{}'
             WHERE domain = 'agent_codex_create' AND request_id = ?`,
      params: [requestId],
      method: "run",
    });
    await expect(
      mock.invoke("agent_codex_create", { payload }),
    ).rejects.toThrow(conflict);
    await mock.invoke("db_execute", {
      sql: `UPDATE idempotency_requests
               SET tombstone_json = ?
             WHERE domain = 'agent_codex_create' AND request_id = ?`,
      params: [JSON.stringify(first), requestId],
      method: "run",
    });
    await mock.invoke("db_execute", {
      sql: `UPDATE undo_journal
               SET after_json = json_set(after_json, '$.id', 'wrong-entry')
             WHERE id = ?`,
      params: [first.undoJournalId],
      method: "run",
    });
    const historyBeforeRetry = await rows(
      mock,
      `SELECT
         (SELECT COUNT(*) FROM change_events) AS events,
         (SELECT COUNT(*) FROM undo_journal) AS journals,
         (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
    );
    const dirtyBeforeRetry = onDatabaseDirty.mock.calls.length;

    await expect(
      mock.invoke("agent_codex_create", { payload }),
    ).rejects.toThrow(conflict);
    expect(
      await rows(mock, "SELECT name FROM codex_entries WHERE id = ?", [
        first.entityId,
      ]),
    ).toEqual([{ name: "Original" }]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM change_events) AS events,
           (SELECT COUNT(*) FROM undo_journal) AS journals,
           (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
      ),
    ).toEqual(historyBeforeRetry);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBeforeRetry);
  });

  it("uses legacy entryId as the create request key and rolls failed receipts back", async () => {
    const legacyPayload = {
      entryId: "codex-legacy-request",
      projectId: "default-project",
      sessionId: "legacy-session",
      typeSlug: "character",
      name: "Legacy retry",
      authorshipSpans: [],
    };
    const first = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_codex_create", { payload: legacyPayload });
    const retry = await mock.invoke<typeof first>("agent_codex_create", {
      payload: { ...legacyPayload, sessionId: "legacy-retry-session" },
    });
    expect(retry).toEqual(first);
    expect(first.undoJournalId).toBe(legacyPayload.entryId);
    expect(
      await rows(
        mock,
        `SELECT request_id FROM idempotency_requests
          WHERE domain = 'agent_codex_create' AND request_id = ?`,
        [legacyPayload.entryId],
      ),
    ).toEqual([{ request_id: legacyPayload.entryId }]);

    const dirtyBeforeFailure = onDatabaseDirty.mock.calls.length;
    await expect(
      mock.invoke("agent_codex_create", {
        payload: {
          requestId: "codex-create-rollback-request",
          entryId: "codex-create-rollback-entry",
          projectId: "default-project",
          sessionId: "codex-occ-session",
          typeSlug: "missing-type",
          name: "Must roll back",
          authorshipSpans: [],
        },
      }),
    ).rejects.toThrow(/codex type.*not in project/i);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM codex_entries
             WHERE id = 'codex-create-rollback-entry') AS entries,
           (SELECT COUNT(*) FROM change_events
             WHERE entity_id = 'codex-create-rollback-entry') AS events,
           (SELECT COUNT(*) FROM undo_journal
             WHERE entity_id = 'codex-create-rollback-entry') AS journals,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'agent_codex_create'
               AND request_id = 'codex-create-rollback-request') AS receipts`,
      ),
    ).toEqual([{ entries: 0, events: 0, journals: 0, receipts: 0 }]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBeforeFailure);
  });

  it("preserves Native empty-string values across Codex create and update", async () => {
    await mock.invoke("agent_codex_create", {
      payload: {
        projectId: "default-project",
        sessionId: "codex-occ-session",
        entryId: "codex-empty-create",
        typeSlug: "character",
        name: "Empty create",
        summary: "",
        content: "",
        aliases: "",
        parentId: "",
      },
    });
    expect(
      await rows(
        mock,
        `SELECT summary, content, aliases, parent_id
           FROM codex_entries WHERE id = 'codex-empty-create'`,
      ),
    ).toEqual([{ summary: "", content: "", aliases: "", parent_id: null }]);

    await createEntry(mock, "codex-empty-update");
    const updated = await mock.invoke<{ version: number }>(
      "agent_codex_update",
      {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-empty-update",
          baseVersion: 1,
          summary: "",
          content: "",
          aliases: "",
        },
      },
    );
    expect(updated.version).toBe(2);
    expect(
      await rows(
        mock,
        `SELECT summary, content, aliases, version
           FROM codex_entries WHERE id = 'codex-empty-update'`,
      ),
    ).toEqual([{ summary: "", content: "", aliases: "", version: 2 }]);
  });

  it("rejects malformed Codex CRUD payload types without mutation", async () => {
    await createEntry(mock, "codex-malformed-update");
    const countsBefore = await rows(
      mock,
      `SELECT
         (SELECT COUNT(*) FROM codex_entries) AS entries,
         (SELECT COUNT(*) FROM change_events) AS events,
         (SELECT COUNT(*) FROM undo_journal) AS journals,
         (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
    );
    const dirtyBefore = onDatabaseDirty.mock.calls.length;

    await expect(
      mock.invoke("agent_codex_create", {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-malformed-create",
          typeSlug: "character",
          name: 42,
        },
      }),
    ).rejects.toThrow(/name must be a string/i);
    await expect(
      mock.invoke("agent_codex_update", {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-malformed-update",
          baseVersion: 1,
          content: 42,
        },
      }),
    ).rejects.toThrow(/content must be a string or null/i);
    await expect(
      mock.invoke("agent_codex_delete", {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-malformed-update",
          baseVersion: "1",
        },
      }),
    ).rejects.toThrow(/baseVersion must be an integer/i);

    expect(
      await rows(
        mock,
        "SELECT id FROM codex_entries WHERE id = 'codex-malformed-create'",
      ),
    ).toEqual([]);
    expect(
      await rows(
        mock,
        "SELECT content, version FROM codex_entries WHERE id = 'codex-malformed-update'",
      ),
    ).toEqual([{ content: "{}", version: 1 }]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM codex_entries) AS entries,
           (SELECT COUNT(*) FROM change_events) AS events,
           (SELECT COUNT(*) FROM undo_journal) AS journals,
           (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
      ),
    ).toEqual(countsBefore);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBefore);
  });

  it("persists create authorship spans and journals them in deterministic order", async () => {
    const created = await mock.invoke<{ undoJournalId: string }>(
      "agent_codex_create",
      {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          surface: "in-app-agent",
          entryId: "codex-create-spans",
          typeSlug: "character",
          name: "Attributed",
          summary: "Summary",
          content: "{}",
          model: "fallback-model",
          chatMessageId: "fallback-chat",
          traceId: "fallback-trace",
          authorshipSpans: [
            {
              fromPos: 10,
              toPos: 20,
              source: "ai",
              model: "specific-model",
              chatMsgId: "specific-chat",
              traceId: "specific-trace",
            },
            { fromPos: 1, toPos: 5, source: "human" },
          ],
        },
      },
    );

    expect(await authorshipRows(mock, "codex-create-spans")).toEqual([
      {
        codex_entry_id: "codex-create-spans",
        from_pos: 1,
        to_pos: 5,
        source: "human",
        model: "fallback-model",
        chat_msg_id: "fallback-chat",
        trace_id: "fallback-trace",
      },
      {
        codex_entry_id: "codex-create-spans",
        from_pos: 10,
        to_pos: 20,
        source: "ai",
        model: "specific-model",
        chat_msg_id: "specific-chat",
        trace_id: "specific-trace",
      },
    ]);
    const journal = (
      await rows(mock, "SELECT after_json FROM undo_journal WHERE id = ?", [
        created.undoJournalId,
      ])
    )[0];
    const snapshot = JSON.parse(String(journal.after_json)) as {
      authorshipSpans: Array<Record<string, unknown>>;
    };
    expect(snapshot.authorshipSpans).toEqual([
      {
        fromPos: 1,
        toPos: 5,
        source: "human",
        model: "fallback-model",
        chatMsgId: "fallback-chat",
        traceId: "fallback-trace",
      },
      {
        fromPos: 10,
        toPos: 20,
        source: "ai",
        model: "specific-model",
        chatMsgId: "specific-chat",
        traceId: "specific-trace",
      },
    ]);

    await replay(mock, created.undoJournalId, "undo", "span-create-undo");
    expect(await authorshipRows(mock, "codex-create-spans")).toEqual([]);
    await replay(mock, created.undoJournalId, "redo", "span-create-redo");
    expect(await authorshipRows(mock, "codex-create-spans")).toEqual([
      {
        codex_entry_id: "codex-create-spans",
        from_pos: 1,
        to_pos: 5,
        source: "human",
        model: "fallback-model",
        chat_msg_id: "fallback-chat",
        trace_id: "fallback-trace",
      },
      {
        codex_entry_id: "codex-create-spans",
        from_pos: 10,
        to_pos: 20,
        source: "ai",
        model: "specific-model",
        chat_msg_id: "specific-chat",
        trace_id: "specific-trace",
      },
    ]);
  });

  it("restores update authorship spans exactly across undo, redo, undo", async () => {
    const created = await mock.invoke<{ undoJournalId: string }>(
      "agent_codex_create",
      {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-update-spans",
          typeSlug: "character",
          name: "Before",
          summary: "Before summary",
          content: "{}",
          authorshipSpans: [
            {
              fromPos: 2,
              toPos: 8,
              source: "human",
              model: "before-model",
              chatMsgId: "before-chat",
              traceId: "before-trace",
            },
          ],
        },
      },
    );
    const updated = await mock.invoke<{ undoJournalId: string }>(
      "agent_codex_update",
      {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-update-spans",
          baseVersion: 1,
          summary: "After summary",
          content: '{"type":"doc"}',
          model: "after-fallback",
          chatMessageId: "after-chat",
          traceId: "after-trace",
          authorshipSpans: [
            { fromPos: 11, toPos: 17, source: "ai" },
            {
              fromPos: 1,
              toPos: 4,
              source: "unknown",
              model: "explicit-model",
            },
          ],
          authorshipSpanLanes: ["content", "summary"],
        },
      },
    );
    const beforeSpans = [
      {
        codex_entry_id: "codex-update-spans",
        from_pos: 2,
        to_pos: 8,
        source: "human",
        model: "before-model",
        chat_msg_id: "before-chat",
        trace_id: "before-trace",
      },
    ];
    const afterSpans = [
      {
        codex_entry_id: "codex-update-spans",
        from_pos: 1,
        to_pos: 4,
        source: "unknown",
        model: "__lane_summary__",
        chat_msg_id: "after-chat",
        trace_id: "after-trace",
      },
      {
        codex_entry_id: "codex-update-spans",
        from_pos: 11,
        to_pos: 17,
        source: "ai",
        model: "__lane_content__",
        chat_msg_id: "after-chat",
        trace_id: "after-trace",
      },
    ];
    expect(await authorshipRows(mock, "codex-update-spans")).toEqual(
      afterSpans,
    );

    await replay(mock, updated.undoJournalId, "undo", "span-update-undo-1");
    expect(await authorshipRows(mock, "codex-update-spans")).toEqual(
      beforeSpans,
    );
    await replay(mock, updated.undoJournalId, "redo", "span-update-redo");
    expect(await authorshipRows(mock, "codex-update-spans")).toEqual(
      afterSpans,
    );
    await replay(mock, updated.undoJournalId, "undo", "span-update-undo-2");
    expect(await authorshipRows(mock, "codex-update-spans")).toEqual(
      beforeSpans,
    );

    await replay(mock, created.undoJournalId, "undo", "span-stack-create-undo");
    expect(await authorshipRows(mock, "codex-update-spans")).toEqual([]);
    await replay(mock, created.undoJournalId, "redo", "span-stack-create-redo");
    expect(await authorshipRows(mock, "codex-update-spans")).toEqual(
      beforeSpans,
    );
    await replay(mock, updated.undoJournalId, "redo", "span-stack-update-redo");
    expect(await authorshipRows(mock, "codex-update-spans")).toEqual(
      afterSpans,
    );
  });

  it("restores only the deleted entry spans and rolls malformed replay back atomically", async () => {
    await mock.invoke("agent_codex_create", {
      payload: {
        projectId: "default-project",
        sessionId: "codex-occ-session",
        entryId: "codex-span-neighbor",
        typeSlug: "character",
        name: "Neighbor",
        authorshipSpans: [
          { fromPos: 40, toPos: 44, source: "human", model: "neighbor" },
        ],
      },
    });
    await mock.invoke("agent_codex_create", {
      payload: {
        projectId: "default-project",
        sessionId: "codex-occ-session",
        entryId: "codex-delete-spans",
        typeSlug: "character",
        name: "Delete me",
        authorshipSpans: [
          { fromPos: 3, toPos: 9, source: "ai", model: "target" },
        ],
      },
    });
    const deleted = await mock.invoke<{ undoJournalId: string }>(
      "agent_codex_delete",
      {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-delete-spans",
          baseVersion: 1,
        },
      },
    );
    expect(await authorshipRows(mock, "codex-delete-spans")).toEqual([]);

    await replay(mock, deleted.undoJournalId, "undo", "span-delete-undo");
    expect(await authorshipRows(mock, "codex-delete-spans")).toEqual([
      {
        codex_entry_id: "codex-delete-spans",
        from_pos: 3,
        to_pos: 9,
        source: "ai",
        model: "target",
        chat_msg_id: null,
        trace_id: null,
      },
    ]);
    expect(await authorshipRows(mock, "codex-span-neighbor")).toEqual([
      {
        codex_entry_id: "codex-span-neighbor",
        from_pos: 40,
        to_pos: 44,
        source: "human",
        model: "neighbor",
        chat_msg_id: null,
        trace_id: null,
      },
    ]);
    await replay(mock, deleted.undoJournalId, "redo", "span-delete-redo");
    expect(await authorshipRows(mock, "codex-delete-spans")).toEqual([]);

    await mock.invoke("db_execute", {
      sql: `UPDATE undo_journal
               SET before_json = json_set(
                 before_json,
                 '$.authorshipSpans[0].codexEntryId',
                 'codex-span-neighbor'
               )
             WHERE id = ?`,
      params: [deleted.undoJournalId],
      method: "run",
    });
    const eventsBefore = await rows(
      mock,
      "SELECT COUNT(*) AS count FROM change_events",
    );
    await expect(
      replay(mock, deleted.undoJournalId, "undo", "span-delete-malformed"),
    ).rejects.toThrow(/authorship.*owner|invalid snapshot/i);
    expect(
      await rows(
        mock,
        "SELECT id FROM codex_entries WHERE id = 'codex-delete-spans'",
      ),
    ).toEqual([]);
    expect(await authorshipRows(mock, "codex-span-neighbor")).toHaveLength(1);
    expect(
      await rows(mock, "SELECT COUNT(*) AS count FROM change_events"),
    ).toEqual(eventsBefore);
    expect(
      await rows(
        mock,
        `SELECT request_id FROM idempotency_requests
          WHERE domain = 'agent_apply_undo_journal'
            AND request_id = 'span-delete-malformed'`,
      ),
    ).toEqual([]);
  });

  it("replays create as undo then redo with a fresh monotonic token", async () => {
    const created = await createEntry(mock, "codex-create-replay");
    await replay(mock, created.undoJournalId, "undo", "create-undo");
    expect(
      await rows(
        mock,
        "SELECT id FROM codex_entries WHERE id = 'codex-create-replay'",
      ),
    ).toEqual([]);

    await replay(mock, created.undoJournalId, "redo", "create-redo");
    expect(
      await rows(
        mock,
        "SELECT name, version FROM codex_entries WHERE id = 'codex-create-replay'",
      ),
    ).toEqual([{ name: "Original", version: 2 }]);
    expect(
      await rows(
        mock,
        "SELECT base_version, result_version FROM undo_journal WHERE id = ?",
        [created.undoJournalId],
      ),
    ).toEqual([{ base_version: 0, result_version: 2 }]);
  });

  it("replays update as undo, redo, undo while advancing the journal chain", async () => {
    const created = await createEntry(mock, "codex-update-replay");
    const updated = await mock.invoke<{ undoJournalId: string }>(
      "agent_codex_update",
      {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-update-replay",
          baseVersion: 1,
          name: "Changed",
          summary: "Changed summary",
        },
      },
    );

    await replay(mock, updated.undoJournalId, "undo", "update-undo-1");
    expect(
      await rows(
        mock,
        "SELECT name, summary, version FROM codex_entries WHERE id = 'codex-update-replay'",
      ),
    ).toEqual([{ name: "Original", summary: "Before summary", version: 3 }]);

    await replay(mock, updated.undoJournalId, "redo", "update-redo");
    expect(
      await rows(
        mock,
        "SELECT name, summary, version FROM codex_entries WHERE id = 'codex-update-replay'",
      ),
    ).toEqual([{ name: "Changed", summary: "Changed summary", version: 4 }]);

    await replay(mock, updated.undoJournalId, "undo", "update-undo-2");
    expect(
      await rows(
        mock,
        "SELECT name, summary, version FROM codex_entries WHERE id = 'codex-update-replay'",
      ),
    ).toEqual([{ name: "Original", summary: "Before summary", version: 5 }]);
    expect(
      await rows(
        mock,
        `SELECT id, base_version, result_version
           FROM undo_journal WHERE id IN (?, ?) ORDER BY op_kind`,
        [created.undoJournalId, updated.undoJournalId],
      ),
    ).toEqual([
      { id: created.undoJournalId, base_version: 0, result_version: 5 },
      { id: updated.undoJournalId, base_version: 5, result_version: 4 },
    ]);
  });

  it("replays delete as undo then redo without resurrecting a stale token", async () => {
    await createEntry(mock, "codex-delete-replay");
    const deleted = await mock.invoke<{ undoJournalId: string }>(
      "agent_codex_delete",
      {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-delete-replay",
          baseVersion: 1,
        },
      },
    );
    expect(
      await rows(
        mock,
        "SELECT id FROM codex_entries WHERE id = 'codex-delete-replay'",
      ),
    ).toEqual([]);

    await replay(mock, deleted.undoJournalId, "undo", "delete-undo");
    expect(
      await rows(
        mock,
        "SELECT name, version FROM codex_entries WHERE id = 'codex-delete-replay'",
      ),
    ).toEqual([{ name: "Original", version: 2 }]);

    await replay(mock, deleted.undoJournalId, "redo", "delete-redo");
    expect(
      await rows(
        mock,
        "SELECT id FROM codex_entries WHERE id = 'codex-delete-replay'",
      ),
    ).toEqual([]);
    expect(
      await rows(
        mock,
        "SELECT base_version, result_version FROM undo_journal WHERE id = ?",
        [deleted.undoJournalId],
      ),
    ).toEqual([{ base_version: 2, result_version: 2 }]);
    const deleteJournal = (
      await rows(
        mock,
        "SELECT before_json, after_json FROM undo_journal WHERE id = ?",
        [deleted.undoJournalId],
      )
    )[0];
    expect(JSON.parse(String(deleteJournal.before_json))).toMatchObject({
      id: "codex-delete-replay",
      name: "Original",
    });
    expect(deleteJournal.after_json).toBeNull();
  });

  it("rolls a stale replay back without appending its event or idempotency receipt", async () => {
    await createEntry(mock, "codex-replay-conflict");
    const firstUpdate = await mock.invoke<{ undoJournalId: string }>(
      "agent_codex_update",
      {
        payload: {
          projectId: "default-project",
          sessionId: "codex-occ-session",
          entryId: "codex-replay-conflict",
          baseVersion: 1,
          name: "First update",
        },
      },
    );
    await mock.invoke("agent_codex_update", {
      payload: {
        projectId: "default-project",
        sessionId: "codex-occ-session",
        entryId: "codex-replay-conflict",
        baseVersion: 2,
        name: "External winner",
      },
    });
    const eventCountBefore = await rows(
      mock,
      "SELECT COUNT(*) AS count FROM change_events",
    );

    await expect(
      replay(mock, firstUpdate.undoJournalId, "undo", "stale-replay-request"),
    ).rejects.toThrow(/version conflict/i);

    expect(
      await rows(
        mock,
        "SELECT name, version FROM codex_entries WHERE id = 'codex-replay-conflict'",
      ),
    ).toEqual([{ name: "External winner", version: 3 }]);
    expect(
      await rows(mock, "SELECT COUNT(*) AS count FROM change_events"),
    ).toEqual(eventCountBefore);
    expect(
      await rows(
        mock,
        `SELECT request_id FROM idempotency_requests
          WHERE domain = 'agent_apply_undo_journal'
            AND request_id = 'stale-replay-request'`,
      ),
    ).toEqual([]);
  });
});

describe("browser mock Detail writer OCC and tracked-event audit", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = withCanonicalWriterTestContext(
      await createBrowserMock({ onDatabaseDirty }),
    );
    onDatabaseDirty.mockClear();
    await createEntry(mock, "detail-owner");
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("rejects malformed Detail strings without appending rows or events", async () => {
    await mock.invoke("agent_codex_mutate", {
      payload: {
        operation: "detail.definition.create",
        projectId: "default-project",
        sessionId: "detail-session",
        definitionId: "detail-malformed-value-definition",
        typeSlug: "character",
        name: "Strict value",
      },
    });
    const countsBefore = await rows(
      mock,
      `SELECT
         (SELECT COUNT(*) FROM codex_detail_definitions) AS definitions,
         (SELECT COUNT(*) FROM codex_detail_values) AS values_count,
         (SELECT COUNT(*) FROM change_events) AS events`,
    );
    const dirtyBefore = onDatabaseDirty.mock.calls.length;

    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          operation: "detail.definition.create",
          projectId: "default-project",
          sessionId: "detail-session",
          definitionId: "detail-missing-name",
          typeSlug: "character",
        },
      }),
    ).rejects.toThrow(/name is required/i);
    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          operation: "detail.value.upsert",
          projectId: "default-project",
          sessionId: "detail-session",
          valueId: "detail-malformed-value",
          entryId: "detail-owner",
          definitionId: "detail-malformed-value-definition",
          value: 42,
        },
      }),
    ).rejects.toThrow(/value must be a string or null/i);

    expect(
      await rows(
        mock,
        `SELECT id FROM codex_detail_definitions
          WHERE id = 'detail-missing-name'`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        mock,
        "SELECT id FROM codex_detail_values WHERE id = 'detail-malformed-value'",
      ),
    ).toEqual([]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM codex_detail_definitions) AS definitions,
           (SELECT COUNT(*) FROM codex_detail_values) AS values_count,
           (SELECT COUNT(*) FROM change_events) AS events`,
      ),
    ).toEqual(countsBefore);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBefore);
  });

  it("checks affected rows for Definition writes and returns a persisted event", async () => {
    const created = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId?: string;
    }>("agent_codex_mutate", {
      payload: {
        operation: "detail.definition.create",
        projectId: "default-project",
        sessionId: "detail-session",
        surface: "manual",
        definitionId: "detail-definition-occ",
        typeSlug: "character",
        name: "Role",
      },
    });
    expect(created).toMatchObject({
      entityId: "detail-definition-occ",
      version: 0,
    });
    expect(created.undoJournalId).toBeUndefined();
    expect(
      await rows(
        mock,
        "SELECT event_uid, op_type FROM change_events WHERE event_uid = ?",
        [created.changeEventUid],
      ),
    ).toEqual([
      {
        event_uid: created.changeEventUid,
        op_type: "detail.definition.create",
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT COUNT(*) AS count FROM undo_journal
          WHERE entity_kind IN ('codex_detail_definition', 'codex_detail_value')`,
      ),
    ).toEqual([{ count: 0 }]);

    const updated = await mock.invoke<{
      version: number;
      changeEventUid: string;
    }>("agent_codex_mutate", {
      payload: {
        operation: "detail.definition.update",
        projectId: "default-project",
        sessionId: "detail-session",
        definitionId: "detail-definition-occ",
        baseVersion: 0,
        name: "Updated role",
      },
    });
    expect(updated.version).toBe(1);
    const eventsBeforeStale = await rows(
      mock,
      "SELECT COUNT(*) AS count FROM change_events",
    );
    const dirtyBeforeStale = onDatabaseDirty.mock.calls.length;

    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          operation: "detail.definition.update",
          projectId: "default-project",
          sessionId: "detail-session",
          definitionId: "detail-definition-occ",
          baseVersion: 0,
          name: "Stale role",
        },
      }),
    ).rejects.toThrow(/version conflict/i);
    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          operation: "detail.definition.delete",
          projectId: "default-project",
          sessionId: "detail-session",
          definitionId: "missing-definition",
        },
      }),
    ).rejects.toThrow(/not found/i);

    expect(
      await rows(
        mock,
        "SELECT name, version FROM codex_detail_definitions WHERE id = 'detail-definition-occ'",
      ),
    ).toEqual([{ name: "Updated role", version: 1 }]);
    expect(
      await rows(mock, "SELECT COUNT(*) AS count FROM change_events"),
    ).toEqual(eventsBeforeStale);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBeforeStale);
  });

  it("checks Detail Value ownership/CAS and persists only successful events", async () => {
    await mock.invoke("agent_codex_mutate", {
      payload: {
        operation: "detail.definition.create",
        projectId: "default-project",
        sessionId: "detail-session",
        definitionId: "detail-value-definition",
        typeSlug: "character",
        name: "Goal",
      },
    });
    const created = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
    }>("agent_codex_mutate", {
      payload: {
        operation: "detail.value.upsert",
        projectId: "default-project",
        sessionId: "detail-session",
        valueId: "detail-value-occ",
        entryId: "detail-owner",
        definitionId: "detail-value-definition",
        value: "First",
      },
    });
    expect(created).toMatchObject({
      entityId: "detail-value-occ",
      version: 1,
    });
    expect(
      await rows(
        mock,
        "SELECT event_uid FROM change_events WHERE event_uid = ?",
        [created.changeEventUid],
      ),
    ).toHaveLength(1);

    await mock.invoke("agent_codex_mutate", {
      payload: {
        operation: "detail.value.upsert",
        projectId: "default-project",
        sessionId: "detail-session",
        entryId: "detail-owner",
        definitionId: "detail-value-definition",
        value: "Winner",
        baseVersion: 1,
      },
    });
    const eventsBeforeStale = await rows(
      mock,
      "SELECT COUNT(*) AS count FROM change_events",
    );
    const dirtyBeforeStale = onDatabaseDirty.mock.calls.length;

    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          operation: "detail.value.upsert",
          projectId: "default-project",
          sessionId: "detail-session",
          entryId: "detail-owner",
          definitionId: "detail-value-definition",
          value: "Stale loser",
          baseVersion: 1,
        },
      }),
    ).rejects.toThrow(/version conflict/i);

    expect(
      await rows(
        mock,
        `SELECT id, value, version FROM codex_detail_values
          WHERE entry_id = 'detail-owner'
            AND definition_id = 'detail-value-definition'`,
      ),
    ).toEqual([{ id: "detail-value-occ", value: "Winner", version: 2 }]);
    expect(
      await rows(mock, "SELECT COUNT(*) AS count FROM change_events"),
    ).toEqual(eventsBeforeStale);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyBeforeStale);
  });

  it("digests a null Detail Value as JSON null and preserves continuity", async () => {
    await mock.invoke("agent_codex_mutate", {
      payload: {
        operation: "detail.definition.create",
        projectId: "default-project",
        sessionId: "detail-session",
        definitionId: "detail-null-definition",
        typeSlug: "character",
        name: "Nullable",
      },
    });
    await mock.invoke("agent_codex_mutate", {
      payload: {
        operation: "detail.value.upsert",
        projectId: "default-project",
        sessionId: "detail-session",
        valueId: "detail-null-value",
        entryId: "detail-owner",
        definitionId: "detail-null-definition",
        value: "Before null",
      },
    });
    const nullWrite = await mock.invoke<{ changeEventUid: string }>(
      "agent_codex_mutate",
      {
        payload: {
          operation: "detail.value.upsert",
          projectId: "default-project",
          sessionId: "detail-session",
          entryId: "detail-owner",
          definitionId: "detail-null-definition",
          value: null,
          baseVersion: 1,
        },
      },
    );
    const [persisted] = await rows(
      mock,
      `SELECT id, entry_id, definition_id, value, version, created_at, updated_at
         FROM codex_detail_values
        WHERE entry_id = 'detail-owner'
          AND definition_id = 'detail-null-definition'`,
    );
    const expectedNullDigest = browserNarrativeStateDigest({
      id: persisted.id,
      entryId: persisted.entry_id,
      definitionId: persisted.definition_id,
      value: null,
      version: persisted.version,
      createdAt: persisted.created_at,
      updatedAt: persisted.updated_at,
    });
    const [nullFeed] = await rows(
      mock,
      `SELECT event.after_digest
         FROM narrative_change_events event
         JOIN narrative_change_transactions tx
           ON tx.id = event.transaction_id
        WHERE tx.source_change_event_uid = ?`,
      [nullWrite.changeEventUid],
    );
    expect(nullFeed.after_digest).toBe(expectedNullDigest);

    const nextWrite = await mock.invoke<{ changeEventUid: string }>(
      "agent_codex_mutate",
      {
        payload: {
          operation: "detail.value.upsert",
          projectId: "default-project",
          sessionId: "detail-session",
          entryId: "detail-owner",
          definitionId: "detail-null-definition",
          value: "After null",
          baseVersion: 2,
        },
      },
    );
    expect(
      await rows(
        mock,
        `SELECT event.before_digest
           FROM narrative_change_events event
           JOIN narrative_change_transactions tx
             ON tx.id = event.transaction_id
          WHERE tx.source_change_event_uid = ?`,
        [nextWrite.changeEventUid],
      ),
    ).toEqual([{ before_digest: expectedNullDigest }]);
  });
});
