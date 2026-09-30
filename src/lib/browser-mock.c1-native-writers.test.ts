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

describe("BrowserMock remaining C1 canonical Native writers", () => {
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
        ('c1-project', 'C1'), ('c1-foreign-project', 'Foreign')`,
    );
    await run(
      mock,
      `INSERT INTO codex_entries
        (id, project_id, type, name, summary, version, created_at, updated_at)
       VALUES
        ('c1-person-a', 'c1-project', 'character', 'A', 'Old summary', 0,
         '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
        ('c1-person-b', 'c1-project', 'character', 'B', NULL, 0,
         '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z'),
        ('c1-person-foreign', 'c1-foreign-project', 'character', 'Foreign', NULL, 0,
         '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
    );
    await run(
      mock,
      `INSERT INTO events (id, project_id, title, ordinal, version, updated_at)
       VALUES
        ('c1-event', 'c1-project', 'Event', 'a0', 0, '2026-08-13T00:00:00.000Z'),
        ('c1-event-foreign', 'c1-foreign-project', 'Foreign', 'a0', 0,
         '2026-08-13T00:00:00.000Z')`,
    );
    await run(
      mock,
      `INSERT INTO codex_tags (id, project_id, name, color) VALUES
        ('c1-tag', 'c1-project', 'Local', '#111111'),
        ('c1-tag-foreign', 'c1-foreign-project', 'Foreign', '#222222')`,
    );
    await run(
      mock,
      `INSERT INTO snippets
        (id, project_id, title, content, version, created_at, updated_at)
       VALUES ('c1-snippet', 'c1-project', 'Snippet', '{}', 0,
               '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
    );
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order, version, created_at, updated_at)
       VALUES ('c1-scene', 'c1-project', 'scene', 'Old title', 'a0', 0,
               '2026-08-13T00:00:00.000Z', '2026-08-13T00:00:00.000Z')`,
    );
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("tracks participant replacement with exact retry, conflict, project scope, and Feed rollback", async () => {
    const semantic = {
      requestId: "c1-participants",
      projectId: "c1-project",
      eventId: "c1-event",
      codexEntryIds: ["c1-person-a", "c1-person-b"],
      baseVersion: 0,
      updatedAt: "2026-08-13T01:00:00.000Z",
    };
    const first = await mock.invoke<number | null>("event_set_participants", {
      payload: {
        ...semantic,
        sessionId: "participants-session:first",
        eventUid: "participants-event:first",
      },
    });
    const retry = await mock.invoke<number | null>("event_set_participants", {
      payload: {
        ...semantic,
        sessionId: "participants-session:retry",
        eventUid: "participants-event:retry",
      },
    });
    expect(first).toBe(1);
    expect(retry).toBe(1);
    await expect(
      mock.invoke("event_set_participants", {
        payload: {
          ...semantic,
          sessionId: "participants-session:conflict",
          eventUid: "participants-event:conflict",
          codexEntryIds: ["c1-person-a"],
        },
      }),
    ).rejects.toThrow("EVENT_SET_PARTICIPANTS_IDEMPOTENCY_CONFLICT");
    await expect(
      mock.invoke("event_set_participants", {
        payload: {
          ...semantic,
          requestId: "c1-participants-cross-project",
          sessionId: "participants-session:foreign",
          eventUid: "participants-event:foreign",
          eventId: "c1-event-foreign",
          codexEntryIds: ["c1-person-a"],
          projectId: "c1-foreign-project",
        },
      }),
    ).rejects.toThrow("not in project");

    await run(
      mock,
      `CREATE TRIGGER reject_c1_participant_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN SELECT RAISE(ABORT, 'forced participant Feed failure'); END`,
    );
    await expect(
      mock.invoke("event_set_participants", {
        payload: {
          ...semantic,
          requestId: "c1-participants-rollback",
          sessionId: "participants-session:rollback",
          eventUid: "participants-event:rollback",
          codexEntryIds: ["c1-person-a"],
          baseVersion: 1,
        },
      }),
    ).rejects.toThrow("forced participant Feed failure");
    expect(
      await rows(
        mock,
        `SELECT event.version,
                (SELECT COUNT(*) FROM event_participants
                  WHERE event_id = event.id) AS participant_count,
                (SELECT COUNT(*) FROM change_events
                  WHERE event_uid = 'participants-event:rollback') AS canonical_count,
                (SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = 'event_set_participants'
                    AND request_id = 'c1-participants-rollback') AS receipt_count
           FROM events event WHERE event.id = 'c1-event'`,
      ),
    ).toEqual([
      {
        version: 1,
        participant_count: 2,
        canonical_count: 0,
        receipt_count: 0,
      },
    ]);
  });

  it("tracks Calendar and tag aggregates with stable receipts and fail-closed ownership", async () => {
    const calendar = {
      requestId: "c1-calendar",
      projectId: "c1-project",
      daysPerYear: 360,
      seasonBoundaries: "[]",
      startYear: 100,
      months: "[]",
      weekdayNames: "[]",
      weekdayStartIndex: 0,
      leapRule: '{"kind":"none"}',
      ageReckoning: "full",
      eras: "[]",
      reform: "null",
      timezone: "null",
      lunarTzMinutes: 480,
      baseVersion: null,
      updatedAt: "2026-08-13T02:00:00.000Z",
    };
    const firstCalendar = await mock.invoke<Record<string, unknown> | null>(
      "project_calendar_upsert",
      {
        payload: {
          ...calendar,
          sessionId: "calendar-session:first",
          eventUid: "calendar-event:first",
        },
      },
    );
    const retriedCalendar = await mock.invoke<Record<string, unknown> | null>(
      "project_calendar_upsert",
      {
        payload: {
          ...calendar,
          sessionId: "calendar-session:retry",
          eventUid: "calendar-event:retry",
        },
      },
    );
    expect(retriedCalendar).toEqual(firstCalendar);
    await expect(
      mock.invoke("project_calendar_upsert", {
        payload: {
          ...calendar,
          sessionId: "calendar-session:conflict",
          eventUid: "calendar-event:conflict",
          daysPerYear: 365,
        },
      }),
    ).rejects.toThrow("PROJECT_CALENDAR_UPSERT_IDEMPOTENCY_CONFLICT");

    const tagPayload = {
      projectId: "c1-project",
      requestId: "c1-tags",
      sessionId: "tag-session:first",
      eventUid: "tag-event:first",
      origin: "human",
      originalTransactionId: null,
      undoJournalId: null,
      entityKind: "codex",
      entityId: "c1-person-a",
      tagIds: ["c1-tag"],
      updatedAt: "2026-08-13T02:30:00.000Z",
    };
    await mock.invoke("entity_tags_set", { payload: tagPayload });
    await mock.invoke("entity_tags_set", {
      payload: {
        ...tagPayload,
        sessionId: "tag-session:retry",
        eventUid: "tag-event:retry",
      },
    });
    await expect(
      mock.invoke("entity_tags_set", {
        payload: {
          ...tagPayload,
          requestId: "c1-tags-foreign",
          eventUid: "tag-event:foreign",
          tagIds: ["c1-tag-foreign"],
        },
      }),
    ).rejects.toThrow("not in the entity project");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id IN ('c1-calendar', 'c1-tags')) AS feed_count,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id IN ('c1-calendar', 'c1-tags')) AS receipt_count,
           (SELECT COUNT(*) FROM codex_entry_tags
             WHERE entry_id = 'c1-person-a' AND tag_id = 'c1-tag') AS tag_count`,
      ),
    ).toEqual([{ feed_count: 2, receipt_count: 2, tag_count: 1 }]);
  });

  it("rolls tag changes back when the Feed append fails", async () => {
    await run(
      mock,
      `CREATE TRIGGER reject_c1_tag_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN SELECT RAISE(ABORT, 'forced tag Feed failure'); END`,
    );
    await expect(
      mock.invoke("entity_tags_set", {
        payload: {
          projectId: "c1-project",
          requestId: "c1-tags-rollback",
          sessionId: "tag-session:rollback",
          eventUid: "tag-event:rollback",
          origin: "human",
          originalTransactionId: null,
          undoJournalId: null,
          entityKind: "snippet",
          entityId: "c1-snippet",
          tagIds: ["c1-tag"],
          updatedAt: null,
        },
      }),
    ).rejects.toThrow("forced tag Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM snippet_entry_tags
             WHERE snippet_id = 'c1-snippet') AS tag_count,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'tag-event:rollback') AS canonical_count,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'entity_tags_set'
               AND request_id = 'c1-tags-rollback') AS receipt_count`,
      ),
    ).toEqual([{ tag_count: 0, canonical_count: 0, receipt_count: 0 }]);
  });

  it("preserves entity tag origin and validates Undo/Redo project lineage", async () => {
    await mock.invoke("entity_tags_set", {
      payload: {
        projectId: "c1-project",
        requestId: "c1-tags-import",
        sessionId: "tag-session:import",
        eventUid: "tag-event:import",
        origin: "import",
        originalTransactionId: null,
        undoJournalId: null,
        entityKind: "codex",
        entityId: "c1-person-a",
        tagIds: ["c1-tag"],
        updatedAt: "2026-08-13T02:45:00.000Z",
      },
    });
    const forward = (
      await rows(
        mock,
        `SELECT id FROM narrative_change_transactions
          WHERE project_id = 'c1-project' AND request_id = 'c1-tags-import'`,
      )
    )[0]!.id as string;
    await run(
      mock,
      `INSERT INTO undo_journal
        (id, project_id, surface, entity_kind, entity_id, op_kind,
         before_json, after_json, base_version, result_version,
         change_event_uid, created_at)
       VALUES ('c1-tags-journal', 'c1-project', 'manual', 'codex_entry',
               'c1-person-a', 'update', '{}', '{}', 0, 0,
               'tag-event:import', '2026-08-13T02:45:00.000Z')`,
    );
    await run(
      mock,
      `UPDATE narrative_change_transactions
          SET undo_journal_id = 'c1-tags-journal'
        WHERE id = ?`,
      [forward],
    );

    await mock.invoke("entity_tags_set", {
      payload: {
        projectId: "c1-project",
        requestId: "c1-tags-undo",
        sessionId: "tag-session:undo",
        eventUid: "tag-event:undo",
        origin: "undo",
        originalTransactionId: forward,
        undoJournalId: "c1-tags-journal",
        entityKind: "codex",
        entityId: "c1-person-a",
        tagIds: [],
        updatedAt: "2026-08-13T02:46:00.000Z",
      },
    });
    expect(
      await rows(
        mock,
        `SELECT request_id, cause_kind, origin, original_transaction_id,
                undo_journal_id
           FROM narrative_change_transactions
          WHERE request_id IN ('c1-tags-import', 'c1-tags-undo')
          ORDER BY request_id`,
      ),
    ).toEqual([
      {
        request_id: "c1-tags-import",
        cause_kind: "forward",
        origin: "import",
        original_transaction_id: null,
        undo_journal_id: "c1-tags-journal",
      },
      {
        request_id: "c1-tags-undo",
        cause_kind: "undo",
        origin: "undo",
        original_transaction_id: forward,
        undo_journal_id: "c1-tags-journal",
      },
    ]);

    await expect(
      mock.invoke("entity_tags_set", {
        payload: {
          projectId: "c1-project",
          requestId: "c1-tags-bad-forward",
          sessionId: "tag-session:bad-forward",
          eventUid: "tag-event:bad-forward",
          origin: "human",
          originalTransactionId: forward,
          undoJournalId: "c1-tags-journal",
          entityKind: "codex",
          entityId: "c1-person-a",
          tagIds: [],
          updatedAt: "2026-08-13T02:47:00.000Z",
        },
      }),
    ).rejects.toThrow("undo/redo");
    await expect(
      mock.invoke("entity_tags_set", {
        payload: {
          projectId: "c1-project",
          requestId: "c1-tags-bad-undo",
          sessionId: "tag-session:bad-undo",
          eventUid: "tag-event:bad-undo",
          origin: "undo",
          originalTransactionId: forward,
          undoJournalId: null,
          entityKind: "codex",
          entityId: "c1-person-a",
          tagIds: [],
          updatedAt: "2026-08-13T02:48:00.000Z",
        },
      }),
    ).rejects.toThrow("undo/redo");
    await expect(
      mock.invoke("entity_tags_set", {
        payload: {
          projectId: "c1-foreign-project",
          requestId: "c1-tags-cross-project",
          sessionId: "tag-session:cross-project",
          eventUid: "tag-event:cross-project",
          origin: "human",
          originalTransactionId: null,
          undoJournalId: null,
          entityKind: "codex",
          entityId: "c1-person-a",
          tagIds: [],
          updatedAt: "2026-08-13T02:49:00.000Z",
        },
      }),
    ).rejects.toThrow("not in project");
  });

  it("tracks Codex rename forward, Undo, and Redo as deterministic typed transactions", async () => {
    const updates = [
      {
        kind: "scene-body",
        refId: "c1-scene",
        detailDefinitionId: null,
        baseVersion: 0,
        value: '{"type":"doc","content":[]}',
        charCount: 0,
        placedBeatPreview: null,
      },
      {
        kind: "codex-summary",
        refId: "c1-person-a",
        detailDefinitionId: null,
        baseVersion: 0,
        value: "New summary",
        charCount: null,
        placedBeatPreview: null,
      },
    ];
    const forwardPayload = {
      requestId: "c1-rename-forward",
      projectId: "c1-project",
      sessionId: "rename-session:first",
      surface: "codex-rename-propagation",
      entryId: "c1-person-a",
      updatedAt: "2026-08-13T03:00:00.000Z",
      updates,
      eventSummary: '{"entryId":"c1-person-a","applied":true}',
      eventUid: "rename-event:first",
      timestamp: Date.parse("2026-08-13T03:00:00.000Z"),
      redo: false,
      originalTransactionId: null,
      undoJournalId: null,
    };
    const forward = await mock.invoke<Record<string, unknown>>(
      "codex_rename_apply",
      { payload: forwardPayload },
    );
    const retry = await mock.invoke<Record<string, unknown>>(
      "codex_rename_apply",
      {
        payload: {
          ...forwardPayload,
          sessionId: "rename-session:retry",
          eventUid: "rename-event:retry",
        },
      },
    );
    expect(retry).toEqual(forward);
    expect(forward).toMatchObject({
      changeEventUid: "rename-event:first",
      maintenanceTransactionId: expect.any(String),
      undoJournalId: expect.any(String),
    });
    await expect(
      mock.invoke("codex_rename_apply", {
        payload: {
          ...forwardPayload,
          sessionId: "rename-session:conflict",
          eventUid: "rename-event:conflict",
          eventSummary: '{"entryId":"c1-person-a","applied":false}',
        },
      }),
    ).rejects.toThrow("CODEX_RENAME_APPLY_REQUEST_CONFLICT");

    const undoUpdates = [
      { ...updates[0]!, baseVersion: 1, value: "{}" },
      { ...updates[1]!, baseVersion: 1, value: "Old summary" },
    ];
    const undo = await mock.invoke<Record<string, unknown>>(
      "codex_rename_undo",
      {
        payload: {
          requestId: "c1-rename-undo",
          eventUid: "rename-undo-event",
          originalTransactionId: forward.maintenanceTransactionId,
          undoJournalId: forward.undoJournalId,
          projectId: "c1-project",
          sessionId: "rename-undo-session",
          updatedAt: "2026-08-13T03:30:00.000Z",
          updates: undoUpdates,
        },
      },
    );
    expect(undo).toMatchObject({
      changeEventUid: "rename-undo-event",
      maintenanceTransactionId: expect.any(String),
    });
    const redo = await mock.invoke<Record<string, unknown>>(
      "codex_rename_apply",
      {
        payload: {
          ...forwardPayload,
          requestId: "c1-rename-redo",
          sessionId: "rename-redo-session",
          eventUid: "rename-redo-event",
          updatedAt: "2026-08-13T04:00:00.000Z",
          timestamp: Date.parse("2026-08-13T04:00:00.000Z"),
          updates: updates.map((update) => ({ ...update, baseVersion: 2 })),
          redo: true,
          originalTransactionId: forward.maintenanceTransactionId,
          undoJournalId: forward.undoJournalId,
        },
      },
    );
    expect(redo).toMatchObject({
      changeEventUid: "rename-redo-event",
      maintenanceTransactionId: expect.any(String),
      undoJournalId: forward.undoJournalId,
    });
    expect(
      await rows(
        mock,
        `SELECT transaction_row.cause_kind, transaction_row.origin,
                event.event_ordinal, event.object_key_json
           FROM narrative_change_transactions transaction_row
           JOIN narrative_change_events event
             ON event.transaction_id = transaction_row.id
          WHERE transaction_row.request_id IN
                ('c1-rename-forward', 'c1-rename-undo', 'c1-rename-redo')
          ORDER BY transaction_row.created_at, transaction_row.request_id,
                   event.event_ordinal`,
      ),
    ).toEqual([
      expect.objectContaining({
        event_ordinal: 0,
        object_key_json: expect.stringContaining("codex-entry"),
      }),
      expect.objectContaining({
        event_ordinal: 1,
        object_key_json: expect.stringContaining("scene"),
      }),
      expect.objectContaining({
        cause_kind: "undo",
        origin: "undo",
        event_ordinal: 0,
      }),
      expect.objectContaining({
        cause_kind: "undo",
        origin: "undo",
        event_ordinal: 1,
      }),
      expect.objectContaining({
        cause_kind: "redo",
        origin: "redo",
        event_ordinal: 0,
      }),
      expect.objectContaining({
        cause_kind: "redo",
        origin: "redo",
        event_ordinal: 1,
      }),
    ]);
  });

  it("orders same-entry Codex rename versions before emitting the Feed", async () => {
    const result = await mock.invoke<Record<string, unknown>>(
      "codex_rename_apply",
      {
        payload: {
          requestId: "c1-rename-multi-field",
          projectId: "c1-project",
          sessionId: "rename-multi-field-session",
          surface: "codex-rename-propagation",
          entryId: "c1-person-a",
          updatedAt: "2026-08-13T04:30:00.000Z",
          updates: [
            {
              kind: "codex-summary",
              refId: "c1-person-a",
              detailDefinitionId: null,
              baseVersion: 0,
              value: "Summary after content",
              charCount: null,
              placedBeatPreview: null,
            },
            {
              kind: "codex-content",
              refId: "c1-person-a",
              detailDefinitionId: null,
              baseVersion: 0,
              value: '{"type":"doc","content":[]}',
              charCount: null,
              placedBeatPreview: null,
            },
          ],
          eventSummary: '{"entryId":"c1-person-a","applied":true}',
          eventUid: "c1-rename-multi-field-event",
          timestamp: Date.parse("2026-08-13T04:30:00.000Z"),
          redo: false,
          originalTransactionId: null,
          undoJournalId: null,
        },
      },
    );
    expect(result.versions).toEqual([
      expect.objectContaining({
        kind: "codex-summary",
        baseVersion: 1,
        version: 2,
      }),
      expect.objectContaining({
        kind: "codex-content",
        baseVersion: 0,
        version: 1,
      }),
    ]);
    expect(
      await rows(
        mock,
        `SELECT event.event_ordinal, event.changed_paths_json,
                event.before_version, event.after_version
           FROM narrative_change_events event
           JOIN narrative_change_transactions transaction_row
             ON transaction_row.id = event.transaction_id
          WHERE transaction_row.request_id = 'c1-rename-multi-field'
          ORDER BY event.event_ordinal`,
      ),
    ).toEqual([
      {
        event_ordinal: 0,
        changed_paths_json: '["/content"]',
        before_version: 0,
        after_version: 1,
      },
      {
        event_ordinal: 1,
        changed_paths_json: '["/summary"]',
        before_version: 1,
        after_version: 2,
      },
    ]);
  });

  it("rejects cross-project rename targets and rolls the entire batch back on Feed failure", async () => {
    const basePayload = {
      requestId: "c1-rename-rollback",
      projectId: "c1-project",
      sessionId: "rename-rollback-session",
      surface: "codex-rename-propagation",
      entryId: "c1-person-a",
      updatedAt: "2026-08-13T05:00:00.000Z",
      eventSummary: '{"entryId":"c1-person-a","applied":true}',
      eventUid: "rename-rollback-event",
      timestamp: Date.parse("2026-08-13T05:00:00.000Z"),
      redo: false,
      originalTransactionId: null,
      undoJournalId: null,
    };
    await expect(
      mock.invoke("codex_rename_apply", {
        payload: {
          ...basePayload,
          requestId: "c1-rename-cross-project",
          eventUid: "rename-cross-project-event",
          updates: [
            {
              kind: "codex-summary",
              refId: "c1-person-foreign",
              detailDefinitionId: null,
              baseVersion: 0,
              value: "Must not write",
              charCount: null,
              placedBeatPreview: null,
            },
          ],
        },
      }),
    ).rejects.toThrow("outside project");
    await run(
      mock,
      `CREATE TRIGGER reject_c1_rename_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN SELECT RAISE(ABORT, 'forced rename Feed failure'); END`,
    );
    await expect(
      mock.invoke("codex_rename_apply", {
        payload: {
          ...basePayload,
          updates: [
            {
              kind: "codex-summary",
              refId: "c1-person-a",
              detailDefinitionId: null,
              baseVersion: 0,
              value: "Must roll back",
              charCount: null,
              placedBeatPreview: null,
            },
            {
              kind: "node-title",
              refId: "c1-scene",
              detailDefinitionId: null,
              baseVersion: 0,
              value: "Must roll back",
              charCount: null,
              placedBeatPreview: null,
            },
          ],
        },
      }),
    ).rejects.toThrow("forced rename Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT summary FROM codex_entries WHERE id = 'c1-person-a') AS summary,
           (SELECT version FROM codex_entries WHERE id = 'c1-person-a') AS codex_version,
           (SELECT title FROM tree_nodes WHERE id = 'c1-scene') AS scene_title,
           (SELECT version FROM tree_nodes WHERE id = 'c1-scene') AS scene_version,
           (SELECT COUNT(*) FROM undo_journal
             WHERE change_event_uid = 'rename-rollback-event') AS journal_count,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'rename-rollback-event') AS canonical_count,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'codex_rename_apply'
               AND request_id = 'c1-rename-rollback') AS receipt_count`,
      ),
    ).toEqual([
      {
        summary: "Old summary",
        codex_version: 0,
        scene_title: "Old title",
        scene_version: 0,
        journal_count: 0,
        canonical_count: 0,
        receipt_count: 0,
      },
    ]);
  });
});
