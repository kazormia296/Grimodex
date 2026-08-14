// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

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

async function run(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await mock.invoke("db_execute", { sql, params, method: "run" });
}

async function createAgentForeshadow(
  mock: PersistentBrowserMock,
  requestId: string,
  foreshadowId: string,
): Promise<{
  changeEventUid: string;
  maintenanceTransactionId: string;
  undoJournalId: string;
}> {
  return mock.invoke("agent_foreshadow_create", {
    payload: {
      requestId,
      foreshadowId,
      projectId: "default-project",
      sessionId: `${requestId}:session`,
      title: "Tracked foreshadow",
      intent: null,
      notes: null,
      loadBearing: null,
      secret: true,
    },
  });
}

describe("BrowserMock canonical Undo/Redo Change Feed", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({
      onDatabaseDirty,
      allowProtectedWriterTestFixtures: true,
    });
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("stores complete renderer Foreshadow create/update receipts and validates retries", async () => {
    const createSemantic = {
      id: "renderer-foreshadow-retry",
      projectId: "default-project",
      requestId: "renderer-foreshadow-create",
      origin: "human",
      originalTransactionId: null,
      title: "Before",
      intent: null,
      notes: null,
      payoffSceneId: null,
      payoffFromPos: null,
      payoffToPos: null,
      payoffConfirmed: false,
      abandoned: false,
      secret: true,
      loadBearing: null,
      codexLinkDirtyAt: null,
    };
    const created = await mock.invoke<{
      changeEventUid: string;
      maintenanceTransactionId: string;
    }>("foreshadow_create", {
      payload: {
        ...createSemantic,
        sessionId: "renderer-create-session:first",
        eventUid: "renderer-create-event:first",
      },
    });
    const createRetry = await mock.invoke<{
      changeEventUid: string;
      maintenanceTransactionId: string;
    }>("foreshadow_create", {
      payload: {
        ...createSemantic,
        sessionId: "renderer-create-session:after-restart",
        eventUid: "renderer-create-event:after-restart",
      },
    });
    expect(createRetry).toMatchObject({
      changeEventUid: created.changeEventUid,
      maintenanceTransactionId: created.maintenanceTransactionId,
    });

    const updateSemantic = {
      projectId: "default-project",
      requestId: "renderer-foreshadow-update",
      origin: "human",
      originalTransactionId: null,
      baseVersion: 0,
      title: "After",
    };
    const updated = await mock.invoke<Record<string, unknown>>(
      "foreshadow_update",
      {
        id: createSemantic.id,
        patch: {
          ...updateSemantic,
          sessionId: "renderer-update-session:first",
          eventUid: "renderer-update-event:first",
        },
      },
    );
    const updateRetry = await mock.invoke<Record<string, unknown>>(
      "foreshadow_update",
      {
        id: createSemantic.id,
        patch: {
          ...updateSemantic,
          sessionId: "renderer-update-session:after-restart",
          eventUid: "renderer-update-event:after-restart",
        },
      },
    );
    expect(updateRetry).toEqual(updated);
    expect(updated.maintenanceTransactionId).not.toBe("");
    expect(updated.changeEventUid).toBe("renderer-update-event:first");

    await expect(
      mock.invoke("foreshadow_update", {
        id: createSemantic.id,
        patch: {
          ...updateSemantic,
          sessionId: "renderer-update-session:conflict",
          eventUid: "renderer-update-event:conflict",
          title: "Conflicting retry",
        },
      }),
    ).rejects.toThrow("FORESHADOW_UPDATE_IDEMPOTENCY_CONFLICT");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM foreshadows WHERE id = ?) AS domain_rows,
           (SELECT COUNT(*) FROM change_events WHERE entity_id = ?) AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE project_id = 'default-project') AS feed_transactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id IN (?, ?)) AS receipts`,
        [
          createSemantic.id,
          createSemantic.id,
          createSemantic.requestId,
          updateSemantic.requestId,
        ],
      ),
    ).toEqual([
      {
        domain_rows: 1,
        canonical_events: 2,
        feed_transactions: 2,
        receipts: 2,
      },
    ]);
  });

  it("rolls renderer Foreshadow create/update mutations back on Feed failure", async () => {
    await run(
      mock,
      `CREATE TRIGGER reject_renderer_foreshadow_create_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN
         SELECT RAISE(ABORT, 'forced renderer Foreshadow create Feed failure');
       END`,
    );
    onDatabaseDirty.mockClear();
    await expect(
      mock.invoke("foreshadow_create", {
        payload: {
          id: "renderer-foreshadow-create-rollback",
          projectId: "default-project",
          requestId: "renderer-foreshadow-create-rollback",
          sessionId: "renderer-foreshadow-create-rollback-session",
          eventUid: "renderer-foreshadow-create-rollback-event",
          origin: "human",
          originalTransactionId: null,
          title: "Must roll back",
        },
      }),
    ).rejects.toThrow("forced renderer Foreshadow create Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM foreshadows
             WHERE id = 'renderer-foreshadow-create-rollback') AS domain_rows,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'renderer-foreshadow-create-rollback-event') AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'renderer-foreshadow-create-rollback') AS feed_transactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'foreshadow_create'
               AND request_id = 'renderer-foreshadow-create-rollback') AS receipts`,
      ),
    ).toEqual([
      {
        domain_rows: 0,
        canonical_events: 0,
        feed_transactions: 0,
        receipts: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();

    await run(mock, "DROP TRIGGER reject_renderer_foreshadow_create_feed");
    await mock.invoke("foreshadow_create", {
      payload: {
        id: "renderer-foreshadow-update-rollback",
        projectId: "default-project",
        requestId: "renderer-foreshadow-update-rollback-seed",
        sessionId: "renderer-foreshadow-update-rollback-session",
        eventUid: "renderer-foreshadow-update-rollback-seed-event",
        origin: "human",
        originalTransactionId: null,
        title: "Before",
      },
    });
    await run(
      mock,
      `CREATE TRIGGER reject_renderer_foreshadow_update_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN
         SELECT RAISE(ABORT, 'forced renderer Foreshadow update Feed failure');
       END`,
    );
    onDatabaseDirty.mockClear();
    await expect(
      mock.invoke("foreshadow_update", {
        id: "renderer-foreshadow-update-rollback",
        patch: {
          projectId: "default-project",
          requestId: "renderer-foreshadow-update-rollback",
          sessionId: "renderer-foreshadow-update-rollback-session",
          eventUid: "renderer-foreshadow-update-rollback-event",
          origin: "human",
          originalTransactionId: null,
          baseVersion: 0,
          title: "Must roll back",
        },
      }),
    ).rejects.toThrow("forced renderer Foreshadow update Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           root.title, root.version,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'renderer-foreshadow-update-rollback-event') AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'renderer-foreshadow-update-rollback') AS feed_transactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'foreshadow_update'
               AND request_id = 'renderer-foreshadow-update-rollback') AS receipts
         FROM foreshadows root
        WHERE root.id = 'renderer-foreshadow-update-rollback'`,
      ),
    ).toEqual([
      {
        title: "Before",
        version: 0,
        canonical_events: 0,
        feed_transactions: 0,
        receipts: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("requires the complete replay identity before touching domain state", async () => {
    const forward = await createAgentForeshadow(
      mock,
      "strict-replay-forward",
      "strict-replay-foreshadow",
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId: "strict-replay-undo",
          projectId: "default-project",
          journalId: forward.undoJournalId,
          direction: "undo",
        },
      }),
    ).rejects.toThrow("sessionId");

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM foreshadows WHERE id = 'strict-replay-foreshadow') AS domain_rows,
           (SELECT COUNT(*) FROM change_events WHERE event_uid <> ?) AS replay_events,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'agent_apply_undo_journal') AS replay_receipts`,
        [forward.changeEventUid],
      ),
    ).toEqual([{ domain_rows: 1, replay_events: 0, replay_receipts: 0 }]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("stores one complete Undo receipt and returns it on an exact transport retry", async () => {
    const forward = await createAgentForeshadow(
      mock,
      "retry-replay-forward",
      "retry-replay-foreshadow",
    );
    const semantic = {
      requestId: "retry-replay-undo",
      projectId: "default-project",
      journalId: forward.undoJournalId,
      direction: "undo" as const,
    };
    const first = await mock.invoke<{
      ok: true;
      changeEventUid: string;
      maintenanceTransactionId: string;
      undoJournalId: string;
    }>("agent_apply_undo_journal", {
      payload: { ...semantic, sessionId: "retry-replay-session:first" },
    });
    const retry = await mock.invoke("agent_apply_undo_journal", {
      payload: { ...semantic, sessionId: "retry-replay-session:after-restart" },
    });

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      ok: true,
      undoJournalId: forward.undoJournalId,
    });
    expect(first.changeEventUid).not.toBe("");
    expect(first.maintenanceTransactionId).not.toBe("");
    expect(
      await rows(
        mock,
        `SELECT transaction_row.cause_kind, transaction_row.origin,
                transaction_row.original_transaction_id,
                transaction_row.undo_journal_id,
                event.event_ordinal, event.object_key_json,
                event.change_kind, event.mutation_kind,
                event.changed_paths_json
           FROM narrative_change_transactions transaction_row
           JOIN narrative_change_events event
             ON event.project_id = transaction_row.project_id
            AND event.transaction_id = transaction_row.id
          WHERE transaction_row.id = ?`,
        [first.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        cause_kind: "undo",
        origin: "undo",
        original_transaction_id: forward.maintenanceTransactionId,
        undo_journal_id: forward.undoJournalId,
        event_ordinal: 0,
        object_key_json:
          '{"foreshadowId":"retry-replay-foreshadow","kind":"foreshadow"}',
        change_kind: "metadata",
        mutation_kind: "delete",
        changed_paths_json: '["/"]',
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM foreshadows WHERE id = 'retry-replay-foreshadow') AS domain_rows,
           (SELECT COUNT(*) FROM change_events WHERE event_uid = ?) AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = ?) AS feed_transactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'agent_apply_undo_journal' AND request_id = ?) AS receipts`,
        [first.changeEventUid, semantic.requestId, semantic.requestId],
      ),
    ).toEqual([
      {
        domain_rows: 0,
        canonical_events: 1,
        feed_transactions: 1,
        receipts: 1,
      },
    ]);

    await expect(
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          ...semantic,
          sessionId: "retry-replay-session:conflict",
          direction: "redo",
        },
      }),
    ).rejects.toThrow("UNDO_JOURNAL_IDEMPOTENCY_CONFLICT");
  });

  it("rolls the domain replay and all history back when its Feed append fails", async () => {
    const forward = await createAgentForeshadow(
      mock,
      "rollback-replay-forward",
      "rollback-replay-foreshadow",
    );
    await run(
      mock,
      `CREATE TRIGGER reject_undo_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN
         SELECT RAISE(ABORT, 'forced Undo Feed failure');
       END`,
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId: "rollback-replay-undo",
          projectId: "default-project",
          sessionId: "rollback-replay-session",
          journalId: forward.undoJournalId,
          direction: "undo",
        },
      }),
    ).rejects.toThrow("forced Undo Feed failure");

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM foreshadows WHERE id = 'rollback-replay-foreshadow') AS domain_rows,
           (SELECT COUNT(*) FROM change_events
             WHERE project_id = 'default-project') AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'rollback-replay-undo') AS replay_transactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'agent_apply_undo_journal'
               AND request_id = 'rollback-replay-undo') AS replay_receipts`,
      ),
    ).toEqual([
      {
        domain_rows: 1,
        canonical_events: 1,
        replay_transactions: 0,
        replay_receipts: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("fails closed for cross-project and untracked legacy journals", async () => {
    const forward = await createAgentForeshadow(
      mock,
      "scope-replay-forward",
      "scope-replay-foreshadow",
    );
    await run(
      mock,
      "INSERT INTO projects (id, title, language) VALUES ('other-project', 'Other', 'ja')",
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId: "scope-replay-cross-project",
          projectId: "other-project",
          sessionId: "scope-replay-session",
          journalId: forward.undoJournalId,
          direction: "undo",
        },
      }),
    ).rejects.toThrow("not found");

    await run(
      mock,
      `INSERT INTO undo_journal
        (id, project_id, surface, entity_kind, entity_id, op_kind,
         before_json, after_json, base_version, result_version, created_at)
       SELECT 'legacy-untracked-journal', project_id, 'legacy', 'foreshadow', id,
              'create', NULL,
              json_object('id', id, 'projectId', project_id, 'title', title,
                          'version', version, 'updatedAt', updated_at),
              0, version, datetime('now')
         FROM foreshadows WHERE id = 'scope-replay-foreshadow'`,
    );
    onDatabaseDirty.mockClear();
    await expect(
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId: "legacy-untracked-replay",
          projectId: "default-project",
          sessionId: "legacy-replay-session",
          journalId: "legacy-untracked-journal",
          direction: "undo",
        },
      }),
    ).rejects.toThrow("has no project-scoped forward Change Feed transaction");

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM foreshadows WHERE id = 'scope-replay-foreshadow') AS domain_rows,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'agent_apply_undo_journal') AS replay_receipts`,
      ),
    ).toEqual([{ domain_rows: 1, replay_receipts: 0 }]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("replays a typed-inverse Foreshadow journal against its root forward lineage", async () => {
    const created = await mock.invoke<{
      maintenanceTransactionId: string;
    }>("foreshadow_create", {
      payload: {
        id: "typed-inverse-foreshadow",
        projectId: "default-project",
        requestId: "typed-inverse-create",
        sessionId: "typed-inverse-session",
        eventUid: "typed-inverse-create-event",
        origin: "human",
        originalTransactionId: null,
        title: "Typed inverse",
        intent: null,
        notes: null,
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
        payoffConfirmed: false,
        abandoned: false,
        secret: true,
        loadBearing: null,
        codexLinkDirtyAt: null,
      },
    });
    const deleted = await mock.invoke<{
      maintenanceTransactionId: string;
      undoJournalId: string;
    }>("foreshadow_delete", {
      payload: {
        id: "typed-inverse-foreshadow",
        projectId: "default-project",
        requestId: "typed-inverse-delete",
        sessionId: "typed-inverse-session",
        eventUid: "typed-inverse-delete-event",
        origin: "undo",
        originalTransactionId: created.maintenanceTransactionId,
        baseVersion: 0,
      },
    });
    expect(
      await rows(
        mock,
        `SELECT cause_kind, original_transaction_id
           FROM narrative_change_transactions WHERE id = ?`,
        [deleted.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        cause_kind: "undo",
        original_transaction_id: created.maintenanceTransactionId,
      },
    ]);

    const restored = await mock.invoke<{
      maintenanceTransactionId: string;
    }>("agent_apply_undo_journal", {
      payload: {
        requestId: "typed-inverse-restore",
        projectId: "default-project",
        sessionId: "typed-inverse-replay-session",
        journalId: deleted.undoJournalId,
        direction: "undo",
      },
    });
    expect(
      await rows(
        mock,
        `SELECT transaction_row.cause_kind,
                transaction_row.original_transaction_id,
                transaction_row.undo_journal_id,
                event.mutation_kind
           FROM narrative_change_transactions transaction_row
           JOIN narrative_change_events event
             ON event.transaction_id = transaction_row.id
            AND event.project_id = transaction_row.project_id
          WHERE transaction_row.id = ?`,
        [restored.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        cause_kind: "undo",
        original_transaction_id: created.maintenanceTransactionId,
        undo_journal_id: deleted.undoJournalId,
        mutation_kind: "restore",
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT id, version FROM foreshadows
          WHERE id = 'typed-inverse-foreshadow'`,
      ),
    ).toEqual([{ id: "typed-inverse-foreshadow", version: 1 }]);
  });

  it("tracks a sorted Chronicle scene-link batch and its Undo association snapshot", async () => {
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('undo-scene-b', 'default-project', 'scene', 'B', 'b0'),
              ('undo-scene-a', 'default-project', 'scene', 'A', 'a0')`,
    );
    await run(
      mock,
      `INSERT INTO events (id, project_id, title, ordinal, version)
       VALUES ('undo-batch-event', 'default-project', 'Batch', 'a0', 0)`,
    );

    const forward = await mock.invoke<{
      changeEventUid: string;
      maintenanceTransactionId: string;
      undoJournalId: string;
    }>("agent_scene_event_link_batch", {
      payload: {
        requestId: "undo-batch-forward",
        projectId: "default-project",
        sessionId: "undo-batch-session",
        eventId: "undo-batch-event",
        sceneIds: ["undo-scene-b", "undo-scene-a", "undo-scene-b"],
      },
    });
    expect(forward.maintenanceTransactionId).not.toBe("");
    expect(
      await rows(
        mock,
        `SELECT event_ordinal, change_kind, changed_paths_json
           FROM narrative_change_events
          WHERE transaction_id = ?`,
        [forward.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        event_ordinal: 0,
        change_kind: "association",
        changed_paths_json: '["/sceneIds"]',
      },
    ]);

    const undo = await mock.invoke<{
      changeEventUid: string;
      maintenanceTransactionId: string;
    }>("agent_apply_undo_journal", {
      payload: {
        requestId: "undo-batch-replay",
        projectId: "default-project",
        sessionId: "undo-batch-replay-session",
        journalId: forward.undoJournalId,
        direction: "undo",
      },
    });
    expect(
      await rows(
        mock,
        `SELECT payload FROM change_events
          WHERE project_id = 'default-project' AND event_uid = ?`,
        [undo.changeEventUid],
      ),
    ).toEqual([
      {
        payload: JSON.stringify({
          direction: "undo",
          opKind: "update",
          journalId: forward.undoJournalId,
          eventId: "undo-batch-event",
          sceneIds: ["undo-scene-a", "undo-scene-b"],
          linked: false,
        }),
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT transaction_row.original_transaction_id,
                event.event_ordinal, event.object_key_json,
                event.change_kind, event.changed_paths_json
           FROM narrative_change_transactions transaction_row
           JOIN narrative_change_events event
             ON event.transaction_id = transaction_row.id
            AND event.project_id = transaction_row.project_id
          WHERE transaction_row.id = ?`,
        [undo.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        original_transaction_id: forward.maintenanceTransactionId,
        event_ordinal: 0,
        object_key_json:
          '{"eventId":"undo-batch-event","kind":"chronicle-event"}',
        change_kind: "association",
        changed_paths_json: '["/sceneIds"]',
      },
    ]);
    expect(
      await rows(
        mock,
        "SELECT scene_id FROM scene_events WHERE event_id = 'undo-batch-event'",
      ),
    ).toEqual([]);
  });

  it("rolls a Chronicle scene-link batch back when its forward Feed append fails", async () => {
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('batch-rollback-scene', 'default-project', 'scene', 'Scene', 'a0')`,
    );
    await run(
      mock,
      `INSERT INTO events (id, project_id, title, ordinal, version)
       VALUES ('batch-rollback-event', 'default-project', 'Event', 'a0', 0)`,
    );
    await run(
      mock,
      `CREATE TRIGGER reject_batch_forward_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN
         SELECT RAISE(ABORT, 'forced batch Feed failure');
       END`,
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("agent_scene_event_link_batch", {
        payload: {
          requestId: "batch-rollback-forward",
          projectId: "default-project",
          sessionId: "batch-rollback-session",
          eventId: "batch-rollback-event",
          sceneIds: ["batch-rollback-scene"],
        },
      }),
    ).rejects.toThrow("forced batch Feed failure");

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM scene_events
             WHERE event_id = 'batch-rollback-event') AS links,
           (SELECT COUNT(*) FROM undo_journal
             WHERE id = 'batch-rollback-forward') AS journals,
           (SELECT COUNT(*) FROM change_events
             WHERE entity_id = 'batch-rollback-event') AS canonical_events,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'batch-rollback-forward') AS feed_transactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'agent_scene_event_link_batch'
               AND request_id = 'batch-rollback-forward') AS receipts`,
      ),
    ).toEqual([
      {
        links: 0,
        journals: 0,
        canonical_events: 0,
        feed_transactions: 0,
        receipts: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });
});
