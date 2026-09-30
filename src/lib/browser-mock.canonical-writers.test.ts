// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

type Origin =
  | "human"
  | "ai-apply"
  | "import"
  | "undo"
  | "redo"
  | "restore"
  | "migration";

function context(
  requestId: string,
  overrides: Partial<{
    sessionId: string;
    eventUid: string;
    origin: Origin;
    originalTransactionId: string | null;
    undoJournalId: string | null;
  }> = {},
) {
  return {
    requestId,
    sessionId: overrides.sessionId ?? `session:${requestId}`,
    eventUid: overrides.eventUid ?? `event:${requestId}`,
    origin: overrides.origin ?? "human",
    originalTransactionId: overrides.originalTransactionId ?? null,
    undoJournalId: overrides.undoJournalId ?? null,
  };
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

describe("Browser Mock canonical Tree and Codex writers", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({
      onDatabaseDirty,
      allowProtectedWriterTestFixtures: true,
    });
  });

  afterEach(() => mock.close());

  it("rejects incomplete identity and lineage before a Tree mutation", async () => {
    const base = {
      id: "strict-tree",
      projectId: "default-project",
      parentId: null,
      nodeType: "scene",
      title: "Strict",
      sortOrder: "a0",
    };
    await expect(
      mock.invoke("tree_node_create", { payload: base }),
    ).rejects.toThrow("requestId");
    await expect(
      mock.invoke("tree_node_create", {
        payload: {
          ...base,
          ...context("strict-tree-undo", { origin: "undo" }),
        },
      }),
    ).rejects.toThrow("originalTransactionId");
    expect(
      await rows(mock, "SELECT id FROM tree_nodes WHERE id = 'strict-tree'"),
    ).toEqual([]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("atomically writes one Tree canonical event, Feed transaction/event, journal, and receipt", async () => {
    const result = await mock.invoke<{
      id: string;
      __writeReceipt: {
        changeEventUid: string;
        maintenanceTransactionId: string;
        undoJournalId: string;
      };
    }>("tree_node_create", {
      payload: {
        ...context("tree-create-request"),
        id: "tree-feed-scene",
        projectId: "default-project",
        parentId: null,
        nodeType: "scene",
        title: "Feed scene",
        sortOrder: "a0",
      },
    });

    expect(result.__writeReceipt).toMatchObject({
      changeEventUid: "event:tree-create-request",
      undoJournalId: "tree-create-request",
    });
    expect(result.__writeReceipt.maintenanceTransactionId).not.toBe("");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM tree_nodes WHERE id = ?) AS domain_rows,
           (SELECT COUNT(*) FROM undo_journal WHERE id = ?) AS journals,
           (SELECT COUNT(*) FROM change_events WHERE event_uid = ?) AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE id = ? AND source_change_event_uid = ?) AS feed_transactions,
           (SELECT COUNT(*) FROM narrative_change_events
             WHERE transaction_id = ? AND event_ordinal = 0) AS feed_events`,
        [
          result.id,
          result.__writeReceipt.undoJournalId,
          result.__writeReceipt.changeEventUid,
          result.__writeReceipt.maintenanceTransactionId,
          result.__writeReceipt.changeEventUid,
          result.__writeReceipt.maintenanceTransactionId,
        ],
      ),
    ).toEqual([
      {
        domain_rows: 1,
        journals: 1,
        canonical_events: 1,
        feed_transactions: 1,
        feed_events: 1,
      },
    ]);
  });

  it("rolls the complete Tree write back when the Feed append fails", async () => {
    await mock.invoke("db_execute", {
      sql: `CREATE TRIGGER reject_tree_feed
            BEFORE INSERT ON narrative_change_events
            BEGIN
              SELECT RAISE(ABORT, 'forced Tree Feed failure');
            END`,
      params: [],
      method: "run",
    });
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("tree_node_create", {
        payload: {
          ...context("tree-feed-rollback-request"),
          id: "tree-feed-rollback-scene",
          projectId: "default-project",
          parentId: null,
          nodeType: "scene",
          title: "Must roll back",
          sortOrder: "a0",
        },
      }),
    ).rejects.toThrow("forced Tree Feed failure");

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM tree_nodes WHERE id = ?) AS domain_rows,
           (SELECT COUNT(*) FROM undo_journal WHERE id = ?) AS journals,
           (SELECT COUNT(*) FROM change_events WHERE event_uid = ?) AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = ?) AS feed_transactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'tree_node_create' AND request_id = ?) AS receipts`,
        [
          "tree-feed-rollback-scene",
          "tree-feed-rollback-request",
          "event:tree-feed-rollback-request",
          "tree-feed-rollback-request",
          "tree-feed-rollback-request",
        ],
      ),
    ).toEqual([
      {
        domain_rows: 0,
        journals: 0,
        canonical_events: 0,
        feed_transactions: 0,
        receipts: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("fails closed when a Tree parent belongs to another project", async () => {
    await mock.invoke("db_execute", {
      sql: `INSERT INTO projects (id, title, language)
            VALUES ('other-project', 'Other', 'ja')`,
      params: [],
      method: "run",
    });
    await mock.invoke("db_execute", {
      sql: `INSERT INTO tree_nodes
              (id, project_id, parent_id, node_type, title, sort_order)
            VALUES ('other-folder', 'other-project', NULL, 'folder', 'Other', 'a0')`,
      params: [],
      method: "run",
    });
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("tree_node_create", {
        payload: {
          ...context("tree-cross-project-request"),
          id: "tree-cross-project-scene",
          projectId: "default-project",
          parentId: "other-folder",
          nodeType: "scene",
          title: "Must reject",
          sortOrder: "a0",
        },
      }),
    ).rejects.toThrow("is not a folder in project 'default-project'");

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM tree_nodes WHERE id = ?) AS domain_rows,
           (SELECT COUNT(*) FROM undo_journal WHERE id = ?) AS journals,
           (SELECT COUNT(*) FROM change_events WHERE event_uid = ?) AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = ?) AS feed_transactions`,
        [
          "tree-cross-project-scene",
          "tree-cross-project-request",
          "event:tree-cross-project-request",
          "tree-cross-project-request",
        ],
      ),
    ).toEqual([
      {
        domain_rows: 0,
        journals: 0,
        canonical_events: 0,
        feed_transactions: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("replays a Tree request across changed transport identities and conflicts on semantic drift", async () => {
    const semantic = {
      id: "tree-retry-scene",
      projectId: "default-project",
      parentId: null,
      nodeType: "scene",
      title: "Retry scene",
      sortOrder: "a0",
    };
    const first = await mock.invoke<Record<string, unknown>>(
      "tree_node_create",
      {
        payload: { ...context("tree-retry"), ...semantic },
      },
    );
    const retry = await mock.invoke<Record<string, unknown>>(
      "tree_node_create",
      {
        payload: {
          ...context("tree-retry", {
            sessionId: "session-after-restart",
            eventUid: "event-after-restart",
          }),
          ...semantic,
        },
      },
    );
    expect(retry).toEqual(first);
    await expect(
      mock.invoke("tree_node_create", {
        payload: {
          ...context("tree-retry", {
            sessionId: "session-third",
            eventUid: "event-third",
          }),
          ...semantic,
          title: "Conflicting title",
        },
      }),
    ).rejects.toThrow("TREE_NODE_CREATE_REQUEST_CONFLICT");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM tree_nodes WHERE id = ?) AS domain_rows,
           (SELECT COUNT(*) FROM change_events WHERE project_id = ?) AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions WHERE project_id = ?) AS feed_transactions`,
        [semantic.id, semantic.projectId, semantic.projectId],
      ),
    ).toEqual([{ domain_rows: 1, canonical_events: 1, feed_transactions: 1 }]);
  });

  it("deletes a Tree subtree in one ordered, project-scoped, retry-safe transaction", async () => {
    await mock.invoke("db_execute", {
      sql: `INSERT INTO projects (id, title, language)
            VALUES ('tree-foreign-project', 'Foreign', 'ja')`,
      params: [],
      method: "run",
    });
    await mock.invoke("db_execute", {
      sql: `INSERT INTO tree_nodes
              (id, project_id, parent_id, node_type, title, sort_order)
            VALUES
              ('tree-delete-root', 'default-project', NULL, 'folder', 'Root', 'z0'),
              ('tree-delete-a', 'default-project', 'tree-delete-root', 'scene', 'A', 'a0'),
              ('tree-delete-z', 'default-project', 'tree-delete-root', 'folder', 'Z', 'z0'),
              ('tree-delete-grandchild', 'default-project', 'tree-delete-z', 'scene', 'Grandchild', 'a0'),
              ('tree-delete-foreign', 'tree-foreign-project', 'tree-delete-root', 'scene', 'Foreign', 'a0')`,
      params: [],
      method: "run",
    });
    const semantic = {
      projectId: "default-project",
      nodeId: "tree-delete-root",
      canonicalPayload: { id: "tree-delete-root" },
    };
    await expect(
      mock.invoke("tree_node_delete", {
        payload: { ...context("tree-subtree-delete"), ...semantic },
      }),
    ).rejects.toThrow("TREE_SUBTREE_CROSS_PROJECT");
    expect(
      await rows(
        mock,
        "SELECT COUNT(*) AS count FROM tree_nodes WHERE id LIKE 'tree-delete-%'",
      ),
    ).toEqual([{ count: 5 }]);
    await mock.invoke("db_execute", {
      sql: "DELETE FROM tree_nodes WHERE id = 'tree-delete-foreign'",
      params: [],
      method: "run",
    });

    const first = await mock.invoke<{
      deletedIds: string[];
      maintenanceTransactionId: string;
    }>("tree_node_delete", {
      payload: { ...context("tree-subtree-delete"), ...semantic },
    });
    const retry = await mock.invoke("tree_node_delete", {
      payload: {
        ...context("tree-subtree-delete", {
          sessionId: "tree-delete-session-after-restart",
          eventUid: "tree-delete-event-after-restart",
        }),
        ...semantic,
      },
    });
    expect(retry).toEqual(first);
    expect(first.deletedIds).toEqual([
      "tree-delete-root",
      "tree-delete-a",
      "tree-delete-z",
      "tree-delete-grandchild",
    ]);
    expect(
      await rows(
        mock,
        `SELECT event.object_key_json AS objectKey
           FROM narrative_change_events event
          WHERE event.transaction_id = ?
          ORDER BY event.event_ordinal`,
        [first.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        objectKey:
          '{"componentId":"tree-node:tree-delete-root","kind":"component"}',
      },
      { objectKey: '{"kind":"scene","sceneId":"tree-delete-a"}' },
      {
        objectKey:
          '{"componentId":"tree-node:tree-delete-z","kind":"component"}',
      },
      { objectKey: '{"kind":"scene","sceneId":"tree-delete-grandchild"}' },
    ]);
  });

  it("rolls a complete Tree subtree back when a descendant Feed event fails", async () => {
    await mock.invoke("db_execute", {
      sql: `INSERT INTO tree_nodes
              (id, project_id, parent_id, node_type, title, sort_order)
            VALUES
              ('tree-rollback-root', 'default-project', NULL, 'folder', 'Root', 'z1'),
              ('tree-rollback-child', 'default-project', 'tree-rollback-root', 'scene', 'Child', 'a0')`,
      params: [],
      method: "run",
    });
    await mock.invoke("db_execute", {
      sql: `CREATE TRIGGER reject_tree_subtree_feed
            BEFORE INSERT ON narrative_change_events
            WHEN NEW.event_ordinal = 1
            BEGIN
              SELECT RAISE(ABORT, 'forced Tree subtree Feed failure');
            END`,
      params: [],
      method: "run",
    });

    await expect(
      mock.invoke("tree_node_delete", {
        payload: {
          ...context("tree-subtree-rollback"),
          projectId: "default-project",
          nodeId: "tree-rollback-root",
        },
      }),
    ).rejects.toThrow("forced Tree subtree Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM tree_nodes WHERE id LIKE 'tree-rollback-%') AS domain_rows,
           (SELECT COUNT(*) FROM undo_journal WHERE id = 'tree-subtree-rollback') AS journals,
           (SELECT COUNT(*) FROM change_events WHERE event_uid = 'event:tree-subtree-rollback') AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions WHERE request_id = 'tree-subtree-rollback') AS feed_transactions,
           (SELECT COUNT(*) FROM idempotency_requests WHERE domain = 'tree_node_delete' AND request_id = 'tree-subtree-rollback') AS receipts`,
      ),
    ).toEqual([
      {
        domain_rows: 2,
        journals: 0,
        canonical_events: 0,
        feed_transactions: 0,
        receipts: 0,
      },
    ]);
  });

  it("tracks renderer Codex create and a transport-stable update retry", async () => {
    const created = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      maintenanceTransactionId: string;
      undoJournalId: string;
    }>("agent_codex_create", {
      payload: {
        ...context("codex-create-request"),
        projectId: "default-project",
        entryId: "codex-feed-entry",
        surface: "manual",
        typeSlug: "character",
        name: "Before",
        summary: "",
        content: "{}",
      },
    });
    expect(created).toMatchObject({
      entityId: "codex-feed-entry",
      version: 1,
      changeEventUid: "event:codex-create-request",
      undoJournalId: "codex-create-request",
    });
    expect(created.maintenanceTransactionId).not.toBe("");

    const semanticUpdate = {
      projectId: "default-project",
      entryId: created.entityId,
      surface: "manual",
      baseVersion: created.version,
      name: "After",
    };
    const first = await mock.invoke("agent_codex_update", {
      payload: {
        ...context("codex-update-request"),
        ...semanticUpdate,
      },
    });
    const retry = await mock.invoke("agent_codex_update", {
      payload: {
        ...context("codex-update-request", {
          sessionId: "codex-session-after-restart",
          eventUid: "codex-event-after-restart",
        }),
        ...semanticUpdate,
      },
    });
    expect(retry).toEqual(first);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM change_events WHERE entity_id = ?) AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE project_id = 'default-project') AS feed_transactions`,
        [created.entityId],
      ),
    ).toEqual([{ canonical_events: 2, feed_transactions: 2 }]);
  });

  it.each([
    ["agent_event_create", { title: "Missing request" }],
    ["agent_event_update", { eventId: "event", baseVersion: 0 }],
    ["agent_event_delete", { eventId: "event", baseVersion: 0 }],
    [
      "agent_event_set_participants",
      { eventId: "event", baseVersion: 0, codexEntryIds: [] },
    ],
    ["agent_scene_event_link", { sceneId: "scene", eventId: "event" }],
    ["agent_scene_event_link_batch", { sceneIds: ["scene"], eventId: "event" }],
    ["agent_scene_event_unlink", { sceneId: "scene", eventId: "event" }],
    [
      "agent_event_relation_add",
      { causeEventId: "cause", effectEventId: "effect" },
    ],
    [
      "agent_event_relation_remove",
      { causeEventId: "cause", effectEventId: "effect" },
    ],
  ])(
    "%s rejects a missing requestId before mutation",
    async (command, rest) => {
      await expect(
        mock.invoke(command, {
          payload: {
            projectId: "default-project",
            sessionId: "missing-request-session",
            ...rest,
          },
        }),
      ).rejects.toThrow("requestId");
      expect(onDatabaseDirty).not.toHaveBeenCalled();
    },
  );

  it("maps the authoritative Chronicle import surface to import Feed provenance", async () => {
    await mock.invoke("agent_event_create", {
      payload: {
        requestId: "event-import-origin",
        projectId: "default-project",
        sessionId: "event-import-session",
        surface: "import",
        eventId: "browser-imported-event",
        title: "Imported",
        participantCodexIds: [],
        sceneIds: [],
      },
    });

    expect(
      await rows(
        mock,
        `SELECT transaction_row.origin, journal.surface
           FROM narrative_change_transactions transaction_row
           JOIN undo_journal journal
             ON journal.id = transaction_row.undo_journal_id
          WHERE transaction_row.request_id = 'event-import-origin'`,
      ),
    ).toEqual([{ origin: "import", surface: "import" }]);
  });

  it("keeps Chronicle create retry/conflict and undo/redo canonical in Browser Mock", async () => {
    const payload = {
      requestId: "event-create-request",
      projectId: "default-project",
      sessionId: "event-create-session-before-restart",
      surface: "manual",
      eventId: "browser-created-event-attempt-1",
      title: "Arrival",
      participantCodexIds: [],
      sceneIds: [],
    };
    const created = await mock.invoke<Record<string, unknown>>(
      "agent_event_create",
      { payload },
    );
    const retry = await mock.invoke("agent_event_create", {
      payload: {
        ...payload,
        sessionId: "event-create-session-after-restart",
        eventId: "browser-created-event-attempt-2",
      },
    });
    expect(retry).toEqual(created);
    expect(created).toMatchObject({
      entityId: "browser-created-event-attempt-1",
      version: 1,
      undoJournalId: "event-create-request",
    });
    await expect(
      mock.invoke("agent_event_create", {
        payload: { ...payload, title: "Departure" },
      }),
    ).rejects.toThrow("AGENT_EVENT_CREATE_IDEMPOTENCY_CONFLICT");

    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "event-create-undo",
        projectId: "default-project",
        sessionId: "event-create-undo-session",
        journalId: "event-create-request",
        direction: "undo",
      },
    });
    expect(
      await rows(
        mock,
        "SELECT id FROM events WHERE id = 'browser-created-event-attempt-1'",
      ),
    ).toEqual([]);
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "event-create-redo",
        projectId: "default-project",
        sessionId: "event-create-redo-session",
        journalId: "event-create-request",
        direction: "redo",
      },
    });
    expect(
      await rows(
        mock,
        "SELECT id, version FROM events WHERE id = 'browser-created-event-attempt-1'",
      ),
    ).toEqual([{ id: "browser-created-event-attempt-1", version: 2 }]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM events
             WHERE id LIKE 'browser-created-event-attempt-%') AS domain_rows,
           (SELECT COUNT(*) FROM undo_journal
             WHERE id = 'event-create-request') AS journals,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'agent_event_create'
               AND request_id = 'event-create-request') AS receipts`,
      ),
    ).toEqual([{ domain_rows: 1, journals: 1, receipts: 1 }]);
  });

  it("keeps single scene-link and relation retries/conflicts canonical in Browser Mock", async () => {
    await mock.invoke("db_execute", {
      sql: `INSERT INTO tree_nodes
              (id, project_id, parent_id, node_type, title, sort_order,
               content, version, created_at, updated_at)
            VALUES
              ('event-scene-a', 'default-project', NULL, 'scene', 'A', 'a0', '{}', 1, 'now', 'now'),
              ('event-scene-b', 'default-project', NULL, 'scene', 'B', 'a1', '{}', 1, 'now', 'now')`,
      params: [],
      method: "run",
    });
    await mock.invoke("db_execute", {
      sql: `INSERT INTO events (id, project_id, title, ordinal, version)
            VALUES
              ('event-relation-a', 'default-project', 'A', 'a0', 1),
              ('event-relation-b', 'default-project', 'B', 'a1', 1),
              ('event-relation-c', 'default-project', 'C', 'a2', 1)`,
      params: [],
      method: "run",
    });
    onDatabaseDirty.mockClear();

    const linkPayload = {
      requestId: "event-scene-link-request",
      projectId: "default-project",
      sessionId: "event-link-session-before-restart",
      sceneId: "event-scene-a",
      eventId: "event-relation-a",
    };
    const linked = await mock.invoke("agent_scene_event_link", {
      payload: linkPayload,
    });
    expect(
      await mock.invoke("agent_scene_event_link", {
        payload: {
          ...linkPayload,
          sessionId: "event-link-session-after-restart",
        },
      }),
    ).toEqual(linked);
    await expect(
      mock.invoke("agent_scene_event_link", {
        payload: { ...linkPayload, sceneId: "event-scene-b" },
      }),
    ).rejects.toThrow("AGENT_SCENE_EVENT_IDEMPOTENCY_CONFLICT");

    const relationPayload = {
      requestId: "event-relation-add-request",
      projectId: "default-project",
      sessionId: "event-relation-session-before-restart",
      causeEventId: "event-relation-a",
      effectEventId: "event-relation-b",
    };
    const related = await mock.invoke("agent_event_relation_add", {
      payload: relationPayload,
    });
    expect(
      await mock.invoke("agent_event_relation_add", {
        payload: {
          ...relationPayload,
          sessionId: "event-relation-session-after-restart",
        },
      }),
    ).toEqual(related);
    await expect(
      mock.invoke("agent_event_relation_add", {
        payload: {
          ...relationPayload,
          effectEventId: "event-relation-c",
        },
      }),
    ).rejects.toThrow("AGENT_EVENT_RELATION_IDEMPOTENCY_CONFLICT");

    const unlinkPayload = {
      ...linkPayload,
      requestId: "event-scene-unlink-request",
      sessionId: "event-unlink-session-before-restart",
    };
    const unlinked = await mock.invoke("agent_scene_event_unlink", {
      payload: unlinkPayload,
    });
    expect(
      await mock.invoke("agent_scene_event_unlink", {
        payload: {
          ...unlinkPayload,
          sessionId: "event-unlink-session-after-restart",
        },
      }),
    ).toEqual(unlinked);

    const removePayload = {
      ...relationPayload,
      requestId: "event-relation-remove-request",
      sessionId: "event-relation-remove-session-before-restart",
    };
    const removed = await mock.invoke("agent_event_relation_remove", {
      payload: removePayload,
    });
    expect(
      await mock.invoke("agent_event_relation_remove", {
        payload: {
          ...removePayload,
          sessionId: "event-relation-remove-session-after-restart",
        },
      }),
    ).toEqual(removed);

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM scene_events
             WHERE scene_id = 'event-scene-a'
               AND event_id = 'event-relation-a') AS scene_links,
           (SELECT COUNT(*) FROM event_relations
             WHERE cause_event_id = 'event-relation-a'
               AND effect_event_id = 'event-relation-b') AS relations,
           (SELECT COUNT(*) FROM undo_journal
             WHERE id IN ('event-scene-link-request', 'event-scene-unlink-request',
                          'event-relation-add-request', 'event-relation-remove-request')) AS journals,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id IN ('event-scene-link-request', 'event-scene-unlink-request',
                                  'event-relation-add-request', 'event-relation-remove-request')) AS receipts`,
      ),
    ).toEqual([{ scene_links: 0, relations: 0, journals: 4, receipts: 4 }]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(4);
  });

  it("keeps Chronicle update, participants, and delete retries atomic after restart", async () => {
    await mock.invoke("db_execute", {
      sql: `INSERT INTO codex_entries (id, project_id, type, name)
            VALUES ('event-person', 'default-project', 'character', 'Person')`,
      params: [],
      method: "run",
    });
    await mock.invoke("db_execute", {
      sql: `INSERT INTO events
              (id, project_id, title, ordinal, version)
            VALUES ('retry-event', 'default-project', 'Before', 'a0', 0)`,
      params: [],
      method: "run",
    });
    onDatabaseDirty.mockClear();

    const updatePayload = {
      requestId: "event-update-request",
      projectId: "default-project",
      sessionId: "event-session-before-restart",
      surface: "manual",
      eventId: "retry-event",
      baseVersion: 0,
      title: "After",
    };
    const update = await mock.invoke("agent_event_update", {
      payload: updatePayload,
    });
    const updateRetry = await mock.invoke("agent_event_update", {
      payload: {
        ...updatePayload,
        sessionId: "event-session-after-restart",
      },
    });
    expect(updateRetry).toEqual(update);
    const updateReceipt = update as { undoJournalId: string };
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "event-update-undo",
        projectId: "default-project",
        sessionId: "event-undo-session",
        journalId: updateReceipt.undoJournalId,
        direction: "undo",
      },
    });
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "event-update-redo",
        projectId: "default-project",
        sessionId: "event-redo-session",
        journalId: updateReceipt.undoJournalId,
        direction: "redo",
      },
    });

    const participantsPayload = {
      requestId: "event-participants-request",
      projectId: "default-project",
      sessionId: "participants-session-before-restart",
      surface: "manual",
      eventId: "retry-event",
      baseVersion: 3,
      codexEntryIds: ["event-person"],
    };
    const participants = await mock.invoke("agent_event_set_participants", {
      payload: participantsPayload,
    });
    const participantsRetry = await mock.invoke(
      "agent_event_set_participants",
      {
        payload: {
          ...participantsPayload,
          sessionId: "participants-session-after-restart",
        },
      },
    );
    expect(participantsRetry).toEqual(participants);
    const participantReceipt = participants as { undoJournalId: string };
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "event-participants-undo",
        projectId: "default-project",
        sessionId: "event-participants-undo-session",
        journalId: participantReceipt.undoJournalId,
        direction: "undo",
      },
    });
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "event-participants-redo",
        projectId: "default-project",
        sessionId: "event-participants-redo-session",
        journalId: participantReceipt.undoJournalId,
        direction: "redo",
      },
    });

    const deletePayload = {
      requestId: "event-delete-request",
      projectId: "default-project",
      sessionId: "delete-session-before-restart",
      surface: "manual",
      eventId: "retry-event",
      baseVersion: 6,
    };
    const deleted = await mock.invoke("agent_event_delete", {
      payload: deletePayload,
    });
    const deleteRetry = await mock.invoke("agent_event_delete", {
      payload: {
        ...deletePayload,
        sessionId: "delete-session-after-restart",
      },
    });
    expect(deleteRetry).toEqual(deleted);
    const deleteReceipt = deleted as { undoJournalId: string };
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "event-delete-undo",
        projectId: "default-project",
        sessionId: "event-delete-undo-session",
        journalId: deleteReceipt.undoJournalId,
        direction: "undo",
      },
    });
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "event-delete-redo",
        projectId: "default-project",
        sessionId: "event-delete-redo-session",
        journalId: deleteReceipt.undoJournalId,
        direction: "redo",
      },
    });
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM events WHERE id = 'retry-event') AS domain_rows,
           (SELECT COUNT(*) FROM event_participants WHERE event_id = 'retry-event') AS participants,
           (SELECT COUNT(*) FROM undo_journal WHERE entity_id = 'retry-event') AS journals,
           (SELECT COUNT(*) FROM change_events WHERE entity_id = 'retry-event') AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id IN ('event-update-request', 'event-participants-request', 'event-delete-request')) AS feed_transactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id IN ('event-update-request', 'event-participants-request', 'event-delete-request')) AS receipts`,
      ),
    ).toEqual([
      {
        domain_rows: 0,
        participants: 0,
        journals: 3,
        canonical_events: 9,
        feed_transactions: 3,
        receipts: 3,
      },
    ]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(9);
  });

  it.each([
    {
      operation: "tag.create",
      entityId: "browser-tag",
      fields: { tagId: "browser-tag", name: "Tag", color: "#123456" },
      table: "codex_tags",
    },
    {
      operation: "type.create",
      entityId: "browser-type",
      fields: {
        typeId: "browser-type",
        slug: "browser-type",
        label: "Browser type",
        color: "#654321",
        isBuiltin: false,
        sortOrder: 10,
      },
      table: "codex_types",
    },
  ])(
    "tracks $operation through the canonical Codex mutate transaction",
    async ({ operation, entityId, fields, table }) => {
      const receipt = await mock.invoke<{
        entityId: string;
        version: number;
        changeEventUid: string;
        maintenanceTransactionId: string;
      }>("agent_codex_mutate", {
        payload: {
          ...context(`request:${operation}`),
          operation,
          projectId: "default-project",
          surface: "manual",
          ...fields,
        },
      });
      expect(receipt.entityId).toBe(entityId);
      expect(receipt.changeEventUid).toBe(`event:request:${operation}`);
      expect(receipt.maintenanceTransactionId).not.toBe("");
      expect(
        await rows(
          mock,
          `SELECT
             (SELECT COUNT(*) FROM ${table} WHERE id = ?) AS domain_rows,
             (SELECT COUNT(*) FROM change_events WHERE event_uid = ?) AS canonical_events,
             (SELECT COUNT(*) FROM narrative_change_transactions WHERE id = ?) AS feed_transactions,
             (SELECT COUNT(*) FROM narrative_change_events WHERE transaction_id = ?) AS feed_events`,
          [
            entityId,
            receipt.changeEventUid,
            receipt.maintenanceTransactionId,
            receipt.maintenanceTransactionId,
          ],
        ),
      ).toEqual([
        {
          domain_rows: 1,
          canonical_events: 1,
          feed_transactions: 1,
          feed_events: 1,
        },
      ]);
    },
  );

  it("tracks icon-only and mixed Codex type updates without losing Feed paths", async () => {
    const typeId = "browser-type-icon-update";
    await mock.invoke("agent_codex_mutate", {
      payload: {
        ...context("request:type-icon-create"),
        operation: "type.create",
        projectId: "default-project",
        surface: "manual",
        typeId,
        slug: typeId,
        label: "Icon type",
        color: "#123456",
        icon: null,
        isBuiltin: false,
        sortOrder: 20,
      },
    });

    await mock.invoke("agent_codex_mutate", {
      payload: {
        ...context("request:type-icon-only"),
        operation: "type.update",
        projectId: "default-project",
        surface: "manual",
        typeId,
        icon: "star",
      },
    });
    await mock.invoke("agent_codex_mutate", {
      payload: {
        ...context("request:type-icon-mixed"),
        operation: "type.update",
        projectId: "default-project",
        surface: "manual",
        typeId,
        label: "Updated icon type",
        icon: null,
      },
    });

    expect(
      await rows(mock, `SELECT label, icon FROM codex_types WHERE id = ?`, [
        typeId,
      ]),
    ).toEqual([{ label: "Updated icon type", icon: null }]);
    expect(
      await rows(
        mock,
        `SELECT transaction_row.request_id, event.changed_paths_json
           FROM narrative_change_transactions transaction_row
           JOIN narrative_change_events event
             ON event.transaction_id = transaction_row.id
          WHERE transaction_row.request_id IN (?, ?)
          ORDER BY transaction_row.request_id`,
        ["request:type-icon-only", "request:type-icon-mixed"],
      ),
    ).toEqual([
      {
        request_id: "request:type-icon-mixed",
        changed_paths_json: JSON.stringify(["/icon", "/label"]),
      },
      {
        request_id: "request:type-icon-only",
        changed_paths_json: JSON.stringify(["/icon"]),
      },
    ]);
  });
});
