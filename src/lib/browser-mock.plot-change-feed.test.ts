// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

const PLOT_WRITERS = [
  "plot_thread_create",
  "plot_thread_update",
  "plot_thread_delete",
  "plot_thread_link_create",
  "plot_thread_link_update",
  "plot_thread_link_delete",
  "plot_thread_branch_create",
  "plot_thread_branch_update",
  "plot_thread_branch_delete",
  "plot_thread_move_marker_bundle",
  "plot_thread_restore_snapshot",
  "plot_thread_delete_snapshot",
] as const;

type PlotWriter = (typeof PLOT_WRITERS)[number];

function identity(
  requestId: string,
  overrides: Partial<{
    projectId: string;
    sessionId: string;
    eventUid: string;
    origin: "human" | "ai-apply" | "import" | "undo" | "redo" | "restore";
    originalTransactionId: string | null;
  }> = {},
) {
  return {
    projectId: overrides.projectId ?? "default-project",
    requestId,
    sessionId: overrides.sessionId ?? `session:${requestId}`,
    eventUid: overrides.eventUid ?? `event:${requestId}`,
    origin: overrides.origin ?? ("human" as const),
    originalTransactionId: overrides.originalTransactionId ?? null,
  };
}

function identityOnlyArgs(command: PlotWriter, requestId: string) {
  const context = identity(requestId);
  if (
    command === "plot_thread_update" ||
    command === "plot_thread_link_update" ||
    command === "plot_thread_branch_update"
  ) {
    return { id: "missing", patch: { ...context, baseVersion: 0 } };
  }
  return {
    payload: {
      ...context,
      id: "missing",
      baseVersion: 0,
    },
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

async function execute(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await mock.invoke("db_execute", { sql, params, method: "run" });
}

async function seedPlotBase(mock: PersistentBrowserMock): Promise<void> {
  await execute(
    mock,
    `INSERT INTO tree_nodes
       (id, project_id, node_type, title, sort_order)
     VALUES ('plot-scene-old', 'default-project', 'scene', 'Old', 'a0'),
            ('plot-scene-new', 'default-project', 'scene', 'New', 'a1')`,
  );
  await execute(
    mock,
    `INSERT INTO plot_threads (id, project_id, name, sort_order)
     VALUES ('a-thread', 'default-project', 'A', 'a0'),
            ('m-thread', 'default-project', 'M', 'a1'),
            ('z-thread', 'default-project', 'Z', 'a2')`,
  );
}

describe("Browser Mock Plot canonical writers", () => {
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

  it.each(PLOT_WRITERS)(
    "%s requires the complete native Plot identity before mutation",
    async (command) => {
      for (const field of [
        "projectId",
        "requestId",
        "sessionId",
        "eventUid",
      ] as const) {
        const args = identityOnlyArgs(command, `${command}:${field}`);
        const payload =
          "patch" in args
            ? (args.patch as Record<string, unknown>)
            : (args.payload as Record<string, unknown>);
        delete payload[field];
        await expect(mock.invoke(command, args)).rejects.toThrow(field);

        const blankArgs = identityOnlyArgs(
          command,
          `${command}:${field}:blank`,
        );
        const blankPayload =
          "patch" in blankArgs
            ? (blankArgs.patch as Record<string, unknown>)
            : (blankArgs.payload as Record<string, unknown>);
        blankPayload[field] = "   ";
        await expect(mock.invoke(command, blankArgs)).rejects.toThrow(field);
      }
      expect(onDatabaseDirty).not.toHaveBeenCalled();
    },
  );

  it("enforces origin lineage while accepting the Native Plot contract without undoJournalId", async () => {
    await expect(
      mock.invoke("plot_thread_create", {
        payload: {
          ...identity("plot-invalid-origin"),
          origin: "system",
          id: "plot-invalid-origin",
          name: "Rejected",
          color: null,
          description: null,
          sortOrder: "a0",
        },
      }),
    ).rejects.toThrow("unsupported Change Feed origin");
    await expect(
      mock.invoke("plot_thread_create", {
        payload: {
          ...identity("plot-forward-lineage", {
            originalTransactionId: "not-allowed",
          }),
          id: "plot-forward-lineage",
          name: "Rejected",
          color: null,
          description: null,
          sortOrder: "a0",
        },
      }),
    ).rejects.toThrow("forward mutations forbid it");
    await expect(
      mock.invoke("plot_thread_create", {
        payload: {
          ...identity("plot-undo-no-lineage", { origin: "undo" }),
          id: "plot-undo-no-lineage",
          name: "Rejected",
          color: null,
          description: null,
          sortOrder: "a0",
        },
      }),
    ).rejects.toThrow("undo/redo requires originalTransactionId");
  });

  it("atomically records a replay-safe thread lifecycle, field authority, Event, Feed, and typed undo lineage", async () => {
    const created = await mock.invoke<Record<string, unknown>>(
      "plot_thread_create",
      {
        payload: {
          ...identity("plot-thread-create-request"),
          id: "plot-thread-canonical",
          name: "Before",
          color: null,
          description: null,
          sortOrder: "a0",
        },
      },
    );
    expect(created).toMatchObject({
      id: "plot-thread-canonical",
      maintenanceTransactionId: expect.any(String),
      __idempotency: { replayed: false, entityPresent: true },
    });

    const updatePayload = {
      ...identity("plot-thread-update-request"),
      name: "After",
      baseVersion: 0,
    };
    const updated = await mock.invoke<Record<string, unknown>>(
      "plot_thread_update",
      { id: "plot-thread-canonical", patch: updatePayload },
    );
    const retry = await mock.invoke<Record<string, unknown>>(
      "plot_thread_update",
      {
        id: "plot-thread-canonical",
        patch: {
          ...updatePayload,
          sessionId: "session:after-restart",
          eventUid: "event:after-restart",
        },
      },
    );
    expect(retry).toEqual(updated);
    await expect(
      mock.invoke("plot_thread_update", {
        id: "plot-thread-canonical",
        patch: { ...updatePayload, name: "Conflicting retry" },
      }),
    ).rejects.toThrow("PLOT_THREAD_UPDATE_IDEMPOTENCY_CONFLICT");

    const undone = await mock.invoke<Record<string, unknown>>(
      "plot_thread_update",
      {
        id: "plot-thread-canonical",
        patch: {
          ...identity("plot-thread-undo-request", {
            origin: "undo",
            originalTransactionId: String(updated.maintenanceTransactionId),
          }),
          name: "Before",
          baseVersion: 1,
        },
      },
    );
    expect(undone).toMatchObject({ name: "Before", version: 2 });

    await execute(
      mock,
      "INSERT INTO projects (id, title, language) VALUES ('foreign-project', 'Foreign', 'ja')",
    );
    await execute(
      mock,
      `INSERT INTO plot_threads (id, project_id, name, sort_order)
       VALUES ('foreign-plot-thread', 'foreign-project', 'Foreign', 'a0')`,
    );
    await expect(
      mock.invoke("plot_thread_update", {
        id: "foreign-plot-thread",
        patch: {
          ...identity("plot-cross-project-update"),
          name: "Must not change",
          baseVersion: 0,
        },
      }),
    ).rejects.toThrow("another project");

    const deletePayload = {
      ...identity("plot-thread-delete-request"),
      id: "plot-thread-canonical",
      baseVersion: 2,
    };
    const deleted = await mock.invoke<Record<string, unknown>>(
      "plot_thread_delete",
      { payload: deletePayload },
    );
    expect(deleted).toMatchObject({
      id: "plot-thread-canonical",
      deleted: true,
      maintenanceTransactionId: expect.any(String),
    });
    await expect(
      mock.invoke("plot_thread_delete", {
        payload: {
          ...deletePayload,
          sessionId: "session:delete-restart",
          eventUid: "event:delete-restart",
        },
      }),
    ).resolves.toEqual(deleted);
    await expect(
      mock.invoke("plot_thread_delete", {
        payload: { ...deletePayload, baseVersion: 1 },
      }),
    ).rejects.toThrow("PLOT_THREAD_DELETE_IDEMPOTENCY_CONFLICT");

    expect(
      await rows(
        mock,
        `SELECT op_type AS opType, entity_type AS entityType,
                entity_id AS entityId
           FROM change_events
          WHERE entity_id = 'plot-thread-canonical'
          ORDER BY sequence`,
      ),
    ).toEqual([
      {
        opType: "plot.thread.create",
        entityType: "plot-thread",
        entityId: "plot-thread-canonical",
      },
      {
        opType: "plot.thread.update",
        entityType: "plot-thread",
        entityId: "plot-thread-canonical",
      },
      {
        opType: "plot.thread.update",
        entityType: "plot-thread",
        entityId: "plot-thread-canonical",
      },
      {
        opType: "plot.thread.delete",
        entityType: "plot-thread",
        entityId: "plot-thread-canonical",
      },
    ]);

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM plot_threads
             WHERE id = 'plot-thread-canonical') AS domainRows,
           (SELECT COUNT(*) FROM narrative_field_authority
             WHERE entity_kind = 'plot-thread'
               AND entity_id = 'plot-thread-canonical'
               AND owner_kind = 'human' AND version = 3) AS authorityRows,
           (SELECT COUNT(*) FROM change_events
             WHERE domain = 'plot' AND entity_id = 'plot-thread-canonical') AS canonicalEvents,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE project_id = 'default-project'
               AND source_domain LIKE 'plot.thread.%') AS feedTransactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id IN (
               'plot-thread-create-request', 'plot-thread-update-request',
               'plot-thread-undo-request', 'plot-thread-delete-request'
             )) AS receipts,
           (SELECT COUNT(*) FROM undo_journal
             WHERE id IN (
               'plot-thread-create-request', 'plot-thread-update-request',
               'plot-thread-undo-request', 'plot-thread-delete-request'
             )) AS undoJournals`,
      ),
    ).toEqual([
      {
        domainRows: 0,
        authorityRows: 6,
        canonicalEvents: 4,
        feedTransactions: 4,
        receipts: 4,
        undoJournals: 0,
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT cause_kind AS causeKind, origin,
                original_transaction_id AS originalTransactionId,
                undo_journal_id AS undoJournalId
           FROM narrative_change_transactions
          WHERE request_id = 'plot-thread-undo-request'`,
      ),
    ).toEqual([
      {
        causeKind: "undo",
        origin: "undo",
        originalTransactionId: updated.maintenanceTransactionId,
        undoJournalId: null,
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT name, version FROM plot_threads
          WHERE id = 'foreign-plot-thread'`,
      ),
    ).toEqual([{ name: "Foreign", version: 0 }]);
  });

  it("records branch creation once against the canonical child identity", async () => {
    await seedPlotBase(mock);
    const lowerUtf8Root = "\uE000-thread";
    const higherUtf8Root = "\u{10000}-thread";
    await execute(
      mock,
      `INSERT INTO plot_threads (id, project_id, name, sort_order)
       VALUES (?, 'default-project', 'Lower UTF-8 root', 'a3'),
              (?, 'default-project', 'Higher UTF-8 root', 'a4')`,
      [lowerUtf8Root, higherUtf8Root],
    );
    onDatabaseDirty.mockClear();
    const created = await mock.invoke<Record<string, unknown>>(
      "plot_thread_branch_create",
      {
        payload: {
          ...identity("plot-branch-order-request"),
          id: "branch/order~id",
          fromThreadId: higherUtf8Root,
          toThreadId: lowerUtf8Root,
          atNodeId: "plot-scene-old",
          kind: "branch",
        },
      },
    );
    expect(
      await rows(
        mock,
        `SELECT event_ordinal AS ordinal, object_key_json AS objectKey,
                changed_paths_json AS changedPaths
           FROM narrative_change_events
          WHERE transaction_id = ? ORDER BY event_ordinal`,
        [created.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        ordinal: 0,
        objectKey: JSON.stringify({
          branchId: "branch/order~id",
          kind: "plot-branch",
        }),
        changedPaths: '["/"]',
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT COUNT(*) AS authorityRows
           FROM narrative_field_authority
          WHERE entity_kind = 'plot-branch' AND entity_id = 'branch/order~id'`,
      ),
    ).toEqual([{ authorityRows: 5 }]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });

  it("maps marker and branch CRUD to the exact canonical operations and atomic Feed facts", async () => {
    await seedPlotBase(mock);
    onDatabaseDirty.mockClear();

    await mock.invoke("plot_thread_link_create", {
      payload: {
        ...identity("plot-marker-create-request"),
        id: "plot-marker-crud",
        threadId: "a-thread",
        nodeId: "plot-scene-old",
        phaseType: "introduce",
        note: null,
        sortOrder: null,
      },
    });
    await mock.invoke("plot_thread_link_update", {
      id: "plot-marker-crud",
      patch: {
        ...identity("plot-marker-update-request"),
        note: "updated",
        baseVersion: 0,
      },
    });
    await mock.invoke("plot_thread_link_delete", {
      payload: {
        ...identity("plot-marker-delete-request"),
        id: "plot-marker-crud",
        baseVersion: 1,
      },
    });

    await mock.invoke("plot_thread_branch_create", {
      payload: {
        ...identity("plot-branch-create-request"),
        id: "plot-branch-crud",
        fromThreadId: "a-thread",
        toThreadId: "m-thread",
        atNodeId: "plot-scene-old",
        kind: "branch",
      },
    });
    await mock.invoke("plot_thread_branch_update", {
      id: "plot-branch-crud",
      patch: {
        ...identity("plot-branch-update-request"),
        atNodeId: "plot-scene-new",
        baseVersion: 0,
      },
    });
    await mock.invoke("plot_thread_branch_delete", {
      payload: {
        ...identity("plot-branch-delete-request"),
        id: "plot-branch-crud",
        baseVersion: 1,
      },
    });

    expect(
      await rows(
        mock,
        `SELECT event_uid AS eventUid, op_type AS opType,
                entity_type AS entityType, entity_id AS entityId
           FROM change_events
          WHERE event_uid LIKE 'event:plot-%-request'
          ORDER BY sequence`,
      ),
    ).toEqual([
      {
        eventUid: "event:plot-marker-create-request",
        opType: "plot.marker.create",
        entityType: "plot-marker",
        entityId: "plot-marker-crud",
      },
      {
        eventUid: "event:plot-marker-update-request",
        opType: "plot.marker.update",
        entityType: "plot-marker",
        entityId: "plot-marker-crud",
      },
      {
        eventUid: "event:plot-marker-delete-request",
        opType: "plot.marker.delete",
        entityType: "plot-marker",
        entityId: "plot-marker-crud",
      },
      {
        eventUid: "event:plot-branch-create-request",
        opType: "plot.branch.create",
        entityType: "plot-branch",
        entityId: "plot-branch-crud",
      },
      {
        eventUid: "event:plot-branch-update-request",
        opType: "plot.branch.update",
        entityType: "plot-branch",
        entityId: "plot-branch-crud",
      },
      {
        eventUid: "event:plot-branch-delete-request",
        opType: "plot.branch.delete",
        entityType: "plot-branch",
        entityId: "plot-branch-crud",
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id LIKE 'plot-marker-%-request'
                OR request_id LIKE 'plot-branch-%-request') AS feedTransactions,
           (SELECT COUNT(*) FROM narrative_change_events event
             JOIN narrative_change_transactions transaction_row
               ON transaction_row.id = event.transaction_id
            WHERE transaction_row.request_id LIKE 'plot-marker-%-request'
               OR transaction_row.request_id LIKE 'plot-branch-%-request') AS feedEvents,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id LIKE 'plot-marker-%-request'
                OR request_id LIKE 'plot-branch-%-request') AS receipts,
           (SELECT COUNT(*) FROM undo_journal
             WHERE id LIKE 'plot-marker-%-request'
                OR id LIKE 'plot-branch-%-request') AS undoJournals`,
      ),
    ).toEqual([
      {
        feedTransactions: 6,
        feedEvents: 6,
        receipts: 6,
        undoJournals: 0,
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT entity_kind AS entityKind, COUNT(*) AS authorityRows
           FROM narrative_field_authority
          WHERE (entity_kind = 'plot-marker' AND entity_id = 'plot-marker-crud'
                 AND version = 2)
             OR (entity_kind = 'plot-branch' AND entity_id = 'plot-branch-crud'
                 AND version = 2)
          GROUP BY entity_kind ORDER BY entity_kind`,
      ),
    ).toEqual([
      { entityKind: "plot-branch", authorityRows: 5 },
      { entityKind: "plot-marker", authorityRows: 6 },
    ]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(6);
  });

  it("rolls simple create, update, and delete writers fully back when Feed append fails", async () => {
    await execute(
      mock,
      `INSERT INTO plot_threads (id, project_id, name, sort_order)
       VALUES ('plot-existing-rollback', 'default-project', 'Before', 'a0')`,
    );
    await execute(
      mock,
      `CREATE TRIGGER reject_plot_simple_feed
       BEFORE INSERT ON narrative_change_transactions
       BEGIN
         SELECT RAISE(ABORT, 'forced Plot simple Feed failure');
       END`,
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("plot_thread_create", {
        payload: {
          ...identity("plot-create-rollback"),
          id: "plot-created-rollback",
          name: "Must roll back",
          color: null,
          description: null,
          sortOrder: "a1",
        },
      }),
    ).rejects.toThrow("forced Plot simple Feed failure");
    await expect(
      mock.invoke("plot_thread_update", {
        id: "plot-existing-rollback",
        patch: {
          ...identity("plot-update-rollback"),
          name: "Must roll back",
          baseVersion: 0,
        },
      }),
    ).rejects.toThrow("forced Plot simple Feed failure");
    await expect(
      mock.invoke("plot_thread_delete", {
        payload: {
          ...identity("plot-delete-rollback"),
          id: "plot-existing-rollback",
          baseVersion: 0,
        },
      }),
    ).rejects.toThrow("forced Plot simple Feed failure");

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM plot_threads
             WHERE id = 'plot-created-rollback') AS createdRows,
           (SELECT name FROM plot_threads
             WHERE id = 'plot-existing-rollback') AS existingName,
           (SELECT version FROM plot_threads
             WHERE id = 'plot-existing-rollback') AS existingVersion,
           (SELECT COUNT(*) FROM narrative_field_authority
             WHERE entity_id IN ('plot-created-rollback', 'plot-existing-rollback')) AS authorityRows,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid LIKE 'event:plot-%-rollback') AS canonicalEvents,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id IN (
               'plot-create-rollback', 'plot-update-rollback', 'plot-delete-rollback'
             )) AS receipts`,
      ),
    ).toEqual([
      {
        createdRows: 0,
        existingName: "Before",
        existingVersion: 0,
        authorityRows: 0,
        canonicalEvents: 0,
        receipts: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("moves a marker and branch with deterministic Feed order, exact replay, conflict detection, and atomic rollback", async () => {
    await seedPlotBase(mock);
    await execute(
      mock,
      `INSERT INTO plot_thread_scene_links
         (id, thread_id, node_id, phase_type, note, sort_order,
          semantic_key, version, created_at, updated_at)
       VALUES ('move-marker', 'z-thread', 'plot-scene-old', 'turn', NULL, NULL,
               'z-thread|plot-scene-old|turn', 0, 'c1', 'u1')`,
    );
    await execute(
      mock,
      `INSERT INTO plot_thread_branches
         (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
          semantic_key, version, created_at, updated_at)
       VALUES ('move-branch', 'default-project', 'm-thread', 'z-thread',
               'plot-scene-old', 'branch',
               'm-thread|z-thread|plot-scene-old|branch', 0, 'c3', 'u1')`,
    );
    onDatabaseDirty.mockClear();

    const markerBefore = {
      id: "move-marker",
      threadId: "z-thread",
      nodeId: "plot-scene-old",
      phaseType: "turn",
      note: null,
      sortOrder: null,
      semanticKey: "z-thread|plot-scene-old|turn",
      version: 0,
      createdAt: "c1",
      updatedAt: "u1",
    };
    const markerAfter = {
      ...markerBefore,
      threadId: "a-thread",
      nodeId: "plot-scene-new",
      semanticKey: "a-thread|plot-scene-new|turn",
      version: 1,
      updatedAt: "u2",
    };
    const branchBefore = {
      id: "move-branch",
      projectId: "default-project",
      fromThreadId: "m-thread",
      toThreadId: "z-thread",
      atNodeId: "plot-scene-old",
      kind: "branch",
      semanticKey: "m-thread|z-thread|plot-scene-old|branch",
      version: 0,
      createdAt: "c3",
      updatedAt: "u1",
    };
    const branchAfter = {
      ...branchBefore,
      toThreadId: "a-thread",
      atNodeId: "plot-scene-new",
      semanticKey: "m-thread|a-thread|plot-scene-new|branch",
      version: 1,
      updatedAt: "u2",
    };
    const payload = {
      ...identity("plot-move-request"),
      markerBefore,
      markerAfter,
      branchTransitions: [{ before: branchBefore, after: branchAfter }],
    };
    const first = await mock.invoke<Record<string, unknown>>(
      "plot_thread_move_marker_bundle",
      { payload },
    );
    const replay = await mock.invoke<Record<string, unknown>>(
      "plot_thread_move_marker_bundle",
      {
        payload: {
          ...payload,
          sessionId: "session:move-restart",
          eventUid: "event:move-restart",
        },
      },
    );
    expect(replay).toMatchObject({
      maintenanceTransactionId: first.maintenanceTransactionId,
      __idempotency: { replayed: true, entityPresent: true },
    });
    await expect(
      mock.invoke("plot_thread_move_marker_bundle", {
        payload: {
          ...payload,
          markerAfter: { ...markerAfter, updatedAt: "u-conflict" },
        },
      }),
    ).rejects.toThrow("PLOT_THREAD_MOVE_MARKER_IDEMPOTENCY_CONFLICT");

    expect(
      await rows(
        mock,
        `SELECT op_type AS opType, entity_type AS entityType,
                entity_id AS entityId
           FROM change_events WHERE event_uid = 'event:plot-move-request'`,
      ),
    ).toEqual([
      {
        opType: "plot.marker.move",
        entityType: "plot-marker",
        entityId: "move-marker",
      },
    ]);

    expect(
      await rows(
        mock,
        `SELECT object_key_json AS objectKey, changed_paths_json AS changedPaths
           FROM narrative_change_events
          WHERE transaction_id = ? ORDER BY event_ordinal`,
        [first.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        objectKey: '{"kind":"plot-marker","markerId":"move-marker"}',
        changedPaths: '["/sceneId","/semanticKey","/threadId"]',
      },
      {
        objectKey: '{"branchId":"move-branch","kind":"plot-branch"}',
        changedPaths: '["/atSceneId","/semanticKey","/toThreadId"]',
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT entity_kind AS entityKind, COUNT(*) AS authorityRows
           FROM narrative_field_authority
          WHERE entity_id IN ('move-marker', 'move-branch')
          GROUP BY entity_kind ORDER BY entity_kind`,
      ),
    ).toEqual([
      { entityKind: "plot-branch", authorityRows: 5 },
      { entityKind: "plot-marker", authorityRows: 6 },
    ]);

    await execute(
      mock,
      `INSERT INTO plot_thread_scene_links
         (id, thread_id, node_id, phase_type, note, sort_order,
          semantic_key, version, created_at, updated_at)
       VALUES ('move-rollback-marker', 'z-thread', 'plot-scene-old',
               'develop', NULL, NULL,
               'z-thread|plot-scene-old|develop', 0, 'c2', 'u1')`,
    );
    await execute(
      mock,
      `CREATE TRIGGER reject_plot_move_feed
       BEFORE INSERT ON narrative_change_transactions
       BEGIN
         SELECT RAISE(ABORT, 'forced Plot move Feed failure');
       END`,
    );
    await expect(
      mock.invoke("plot_thread_move_marker_bundle", {
        payload: {
          ...identity("plot-move-rollback"),
          markerBefore: {
            ...markerBefore,
            id: "move-rollback-marker",
            phaseType: "develop",
            semanticKey: "z-thread|plot-scene-old|develop",
            createdAt: "c2",
          },
          markerAfter: {
            ...markerAfter,
            id: "move-rollback-marker",
            phaseType: "develop",
            semanticKey: "a-thread|plot-scene-new|develop",
            createdAt: "c2",
          },
          branchTransitions: [],
        },
      }),
    ).rejects.toThrow("forced Plot move Feed failure");
    expect(
      await rows(
        mock,
        `SELECT thread_id AS threadId, node_id AS nodeId, version
           FROM plot_thread_scene_links WHERE id = 'move-rollback-marker'`,
      ),
    ).toEqual([{ threadId: "z-thread", nodeId: "plot-scene-old", version: 0 }]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM narrative_field_authority
             WHERE entity_id = 'move-rollback-marker') AS authorityRows,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'event:plot-move-rollback') AS canonicalEvents,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id = 'plot-move-rollback') AS receipts`,
      ),
    ).toEqual([{ authorityRows: 0, canonicalEvents: 0, receipts: 0 }]);
  });

  it("restores and deletes aggregate snapshots in deterministic order and rolls both back on Feed failure", async () => {
    await seedPlotBase(mock);
    const thread = {
      id: "z-restored-thread",
      projectId: "default-project",
      name: "Restored",
      color: null,
      description: null,
      sortOrder: "a9",
      startNodeId: null,
      endNodeId: null,
      version: 0,
      createdAt: "c10",
      updatedAt: "u10",
    };
    const link = {
      id: "restored-marker",
      threadId: thread.id,
      nodeId: "plot-scene-old",
      phaseType: "develop",
      note: null,
      sortOrder: null,
      semanticKey: `${thread.id}|plot-scene-old|develop`,
      version: 0,
      createdAt: "c11",
      updatedAt: "u11",
    };
    const branch = {
      id: "restored-branch",
      projectId: "default-project",
      fromThreadId: thread.id,
      toThreadId: "a-thread",
      atNodeId: "plot-scene-old",
      kind: "merge",
      semanticKey: `${thread.id}|a-thread|plot-scene-old|merge`,
      version: 0,
      createdAt: "c12",
      updatedAt: "u12",
    };
    const restorePayload = {
      ...identity("plot-restore-rollback", { origin: "restore" }),
      thread,
      links: [link],
      branches: [branch],
    };
    await execute(
      mock,
      `CREATE TRIGGER reject_plot_restore_feed
       BEFORE INSERT ON narrative_change_transactions
       BEGIN
         SELECT RAISE(ABORT, 'forced Plot restore Feed failure');
       END`,
    );
    onDatabaseDirty.mockClear();
    await expect(
      mock.invoke("plot_thread_restore_snapshot", { payload: restorePayload }),
    ).rejects.toThrow("forced Plot restore Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM plot_threads
             WHERE id = 'z-restored-thread') AS threads,
           (SELECT COUNT(*) FROM plot_thread_scene_links
             WHERE id = 'restored-marker') AS links,
           (SELECT COUNT(*) FROM plot_thread_branches
             WHERE id = 'restored-branch') AS branches,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'event:plot-restore-rollback') AS canonicalEvents,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id = 'plot-restore-rollback') AS receipts`,
      ),
    ).toEqual([
      { threads: 0, links: 0, branches: 0, canonicalEvents: 0, receipts: 0 },
    ]);

    await execute(mock, "DROP TRIGGER reject_plot_restore_feed");
    const restored = await mock.invoke<{
      thread: Record<string, unknown>;
      links: Record<string, unknown>[];
      branches: Record<string, unknown>[];
      maintenanceTransactionId: string;
    }>("plot_thread_restore_snapshot", {
      payload: {
        ...restorePayload,
        ...identity("plot-restore-success", { origin: "restore" }),
      },
    });
    expect(
      await rows(
        mock,
        `SELECT object_key_json AS objectKey, changed_paths_json AS changedPaths
           FROM narrative_change_events
          WHERE transaction_id = ? ORDER BY event_ordinal`,
        [restored.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        objectKey: '{"kind":"plot-thread","threadId":"z-restored-thread"}',
        changedPaths: '["/"]',
      },
      {
        objectKey:
          '{"kind":"plot-marker","markerId":"restored-marker"}',
        changedPaths: '["/"]',
      },
      {
        objectKey:
          '{"branchId":"restored-branch","kind":"plot-branch"}',
        changedPaths: '["/"]',
      },
    ]);

    const deletePayload = {
      ...identity("plot-delete-snapshot-rollback"),
      thread: restored.thread,
      links: restored.links,
      branches: restored.branches,
    };
    await execute(
      mock,
      `CREATE TRIGGER reject_plot_delete_snapshot_feed
       BEFORE INSERT ON narrative_change_transactions
       BEGIN
         SELECT RAISE(ABORT, 'forced Plot delete snapshot Feed failure');
       END`,
    );
    await expect(
      mock.invoke("plot_thread_delete_snapshot", { payload: deletePayload }),
    ).rejects.toThrow("forced Plot delete snapshot Feed failure");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM plot_threads
             WHERE id = 'z-restored-thread') AS threads,
           (SELECT COUNT(*) FROM plot_thread_scene_links
             WHERE id = 'restored-marker') AS links,
           (SELECT COUNT(*) FROM plot_thread_branches
             WHERE id = 'restored-branch') AS branches,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'event:plot-delete-snapshot-rollback') AS canonicalEvents,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id = 'plot-delete-snapshot-rollback') AS receipts`,
      ),
    ).toEqual([
      { threads: 1, links: 1, branches: 1, canonicalEvents: 0, receipts: 0 },
    ]);

    await execute(mock, "DROP TRIGGER reject_plot_delete_snapshot_feed");
    const deleted = await mock.invoke<Record<string, unknown>>(
      "plot_thread_delete_snapshot",
      {
        payload: {
          ...deletePayload,
          ...identity("plot-delete-snapshot-success"),
        },
      },
    );
    expect(deleted).toMatchObject({
      deleted: true,
      maintenanceTransactionId: expect.any(String),
    });
    expect(
      await rows(
        mock,
        `SELECT event_uid AS eventUid, op_type AS opType,
                entity_type AS entityType, entity_id AS entityId
           FROM change_events
          WHERE event_uid IN (
            'event:plot-restore-success',
            'event:plot-delete-snapshot-success'
          )
          ORDER BY sequence`,
      ),
    ).toEqual([
      {
        eventUid: "event:plot-restore-success",
        opType: "plot.history.restore",
        entityType: "plot-history",
        entityId: "z-restored-thread",
      },
      {
        eventUid: "event:plot-delete-snapshot-success",
        opType: "plot.history.delete",
        entityType: "plot-history",
        entityId: "z-restored-thread",
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT object_key_json AS objectKey, changed_paths_json AS changedPaths
           FROM narrative_change_events
          WHERE transaction_id = ? ORDER BY event_ordinal`,
        [deleted.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        objectKey: '{"kind":"plot-thread","threadId":"z-restored-thread"}',
        changedPaths: '["/"]',
      },
      {
        objectKey:
          '{"kind":"plot-marker","markerId":"restored-marker"}',
        changedPaths: '["/"]',
      },
      {
        objectKey:
          '{"branchId":"restored-branch","kind":"plot-branch"}',
        changedPaths: '["/"]',
      },
    ]);
  });
});
