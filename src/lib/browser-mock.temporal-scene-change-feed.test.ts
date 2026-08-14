// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

interface TemporalScenePatchResult {
  sceneId: string;
  version: number;
  updatedAt: string;
  changeEventUid: string;
  maintenanceTransactionId: string;
  undoJournalId: string;
}

function context(
  requestId: string,
  overrides: Partial<{
    projectId: string;
    sessionId: string;
    eventUid: string;
  }> = {},
) {
  return {
    projectId: overrides.projectId ?? "default-project",
    requestId,
    sessionId: overrides.sessionId ?? `session:${requestId}`,
    eventUid: overrides.eventUid ?? `event:${requestId}`,
    origin: "human" as const,
    originalTransactionId: null,
    undoJournalId: null,
  };
}

function temporalPayload(
  requestId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...context(requestId),
    targetId: "temporal-browser-scene",
    baseVersion: 0,
    storyTimeOrder: "a0V",
    storyTimeLabel: "First",
    startTime: 1,
    startMinute: null,
    startGranularity: "day",
    endTime: 2,
    endMinute: null,
    endGranularity: "day",
    precision: "exact",
    ...overrides,
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

async function seedScene(
  mock: PersistentBrowserMock,
  sceneId = "temporal-browser-scene",
  projectId = "default-project",
): Promise<void> {
  await execute(
    mock,
    `INSERT INTO tree_nodes
       (id, project_id, parent_id, node_type, title, sort_order,
        version, updated_at)
     VALUES (?, ?, NULL, 'scene', 'Temporal scene', 'a0', 0,
             '2000-01-01T00:00:00.000Z')`,
    [sceneId, projectId],
  );
}

describe("Browser Mock temporal scene canonical writer", () => {
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

  it.each(["projectId", "requestId", "sessionId", "eventUid"])(
    "rejects missing and blank %s before mutation",
    async (identityField) => {
      await seedScene(mock);
      onDatabaseDirty.mockClear();
      const missing = temporalPayload(`missing-${identityField}`);
      delete missing[identityField];
      await expect(
        mock.invoke("temporal_scene_patch", { payload: missing }),
      ).rejects.toThrow(identityField);
      await expect(
        mock.invoke("temporal_scene_patch", {
          payload: {
            ...temporalPayload(`blank-${identityField}`),
            [identityField]: "   ",
          },
        }),
      ).rejects.toThrow(identityField);

      expect(
        await rows(
          mock,
          `SELECT version, story_time_order AS storyTimeOrder
             FROM tree_nodes WHERE id = 'temporal-browser-scene'`,
        ),
      ).toEqual([{ version: 0, storyTimeOrder: null }]);
      expect(onDatabaseDirty).not.toHaveBeenCalled();
    },
  );

  it("atomically writes domain, canonical Event, Feed, journal, and replay receipt with one timestamp", async () => {
    await seedScene(mock);
    onDatabaseDirty.mockClear();
    const first = await mock.invoke<TemporalScenePatchResult>(
      "temporal_scene_patch",
      { payload: temporalPayload("temporal-request") },
    );
    const retry = await mock.invoke<TemporalScenePatchResult>(
      "temporal_scene_patch",
      {
        payload: temporalPayload("temporal-request", {
          sessionId: "session-after-restart",
          eventUid: "event-after-restart",
        }),
      },
    );

    expect(retry).toEqual(first);
    expect(first).toMatchObject({
      sceneId: "temporal-browser-scene",
      version: 1,
      changeEventUid: "event:temporal-request",
      undoJournalId: "temporal-request",
    });
    expect(first.maintenanceTransactionId).not.toBe("");
    expect(new Date(first.updatedAt).toISOString()).toBe(first.updatedAt);
    await expect(
      mock.invoke("temporal_scene_patch", {
        payload: temporalPayload("temporal-request", {
          sessionId: "session-conflict",
          eventUid: "event-conflict",
          storyTimeLabel: "Conflicting label",
        }),
      }),
    ).rejects.toThrow("TEMPORAL_SCENE_REQUEST_CONFLICT");

    const state = await rows(
      mock,
      `SELECT version, story_time_order AS storyTimeOrder,
              story_time_label AS storyTimeLabel,
              chronicle_start_time AS startTime,
              chronicle_end_time AS endTime,
              updated_at AS updatedAt
         FROM tree_nodes WHERE id = 'temporal-browser-scene'`,
    );
    expect(state).toEqual([
      {
        version: 1,
        storyTimeOrder: "a0V",
        storyTimeLabel: "First",
        startTime: 1,
        endTime: 2,
        updatedAt: first.updatedAt,
      },
    ]);

    const canonical = await rows(
      mock,
      `SELECT project_id AS projectId, scene_id AS sceneId, domain, op_type AS opType,
              entity_type AS entityType, entity_id AS entityId,
              session_id AS sessionId, timestamp, payload
         FROM change_events WHERE event_uid = ?`,
      [first.changeEventUid],
    );
    expect(canonical).toHaveLength(1);
    expect(canonical[0]).toMatchObject({
      projectId: "default-project",
      sceneId: "temporal-browser-scene",
      domain: "tree",
      opType: "temporal.scene.patch",
      entityType: "scene",
      entityId: "temporal-browser-scene",
      sessionId: "session:temporal-request",
      timestamp: Date.parse(first.updatedAt),
    });
    expect(JSON.parse(String(canonical[0].payload))).toMatchObject({
      fields: [
        "/endGranularity",
        "/endTime",
        "/startGranularity",
        "/startTime",
        "/storyTimeLabel",
        "/storyTimeOrder",
      ],
      before: { id: "temporal-browser-scene", version: 0 },
      after: { id: "temporal-browser-scene", version: 1 },
    });

    expect(
      await rows(
        mock,
        `SELECT request_id AS requestId, source_domain AS sourceDomain,
                source_change_event_uid AS sourceEventUid,
                cause_kind AS causeKind, origin,
                undo_journal_id AS undoJournalId, created_at AS createdAt
           FROM narrative_change_transactions WHERE id = ?`,
        [first.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        requestId: "temporal-request",
        sourceDomain: "temporal.scene.patch",
        sourceEventUid: "event:temporal-request",
        causeKind: "forward",
        origin: "human",
        undoJournalId: "temporal-request",
        createdAt: first.updatedAt,
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT canonical_change_event_uid AS canonicalEventUid,
                event_ordinal AS eventOrdinal, object_key_json AS objectKey,
                change_kind AS changeKind, mutation_kind AS mutationKind,
                before_version AS beforeVersion, after_version AS afterVersion,
                changed_paths_json AS changedPaths, occurred_at AS occurredAt
           FROM narrative_change_events WHERE transaction_id = ?`,
        [first.maintenanceTransactionId],
      ),
    ).toEqual([
      {
        canonicalEventUid: "event:temporal-request",
        eventOrdinal: 0,
        objectKey: '{"kind":"scene","sceneId":"temporal-browser-scene"}',
        changeKind: "order",
        mutationKind: "update",
        beforeVersion: 0,
        afterVersion: 1,
        changedPaths:
          '["/endGranularity","/endTime","/startGranularity","/startTime","/storyTimeLabel","/storyTimeOrder"]',
        occurredAt: first.updatedAt,
      },
    ]);

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM tree_nodes
             WHERE id = 'temporal-browser-scene' AND version = 1) AS domainRows,
           (SELECT COUNT(*) FROM undo_journal
             WHERE id = 'temporal-request' AND created_at = ?) AS journals,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'event:temporal-request') AS canonicalEvents,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'temporal-request') AS feedTransactions,
           (SELECT COUNT(*) FROM narrative_change_events
             WHERE transaction_id = ?) AS feedEvents,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'temporal_scene_patch'
               AND request_id = 'temporal-request' AND created_at = ?) AS receipts`,
        [first.updatedAt, first.maintenanceTransactionId, first.updatedAt],
      ),
    ).toEqual([
      {
        domainRows: 1,
        journals: 1,
        canonicalEvents: 1,
        feedTransactions: 1,
        feedEvents: 1,
        receipts: 1,
      },
    ]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a scene belongs to another project", async () => {
    await execute(
      mock,
      "INSERT INTO projects (id, title, language) VALUES ('foreign-project', 'Foreign', 'ja')",
    );
    await seedScene(mock, "foreign-temporal-scene", "foreign-project");
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("temporal_scene_patch", {
        payload: temporalPayload("temporal-cross-project", {
          targetId: "foreign-temporal-scene",
        }),
      }),
    ).rejects.toThrow("not found in project 'default-project'");

    expect(
      await rows(
        mock,
        `SELECT
           (SELECT version FROM tree_nodes
             WHERE id = 'foreign-temporal-scene') AS foreignVersion,
           (SELECT COUNT(*) FROM undo_journal
             WHERE id = 'temporal-cross-project') AS journals,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'event:temporal-cross-project') AS canonicalEvents,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'temporal-cross-project') AS feedTransactions,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'temporal_scene_patch'
               AND request_id = 'temporal-cross-project') AS receipts`,
      ),
    ).toEqual([
      {
        foreignVersion: 0,
        journals: 0,
        canonicalEvents: 0,
        feedTransactions: 0,
        receipts: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("rolls the complete temporal write back when the Feed append fails", async () => {
    await seedScene(mock);
    await execute(
      mock,
      `CREATE TRIGGER reject_temporal_feed
         BEFORE INSERT ON narrative_change_transactions
         BEGIN
           SELECT RAISE(ABORT, 'forced temporal Feed failure');
         END`,
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("temporal_scene_patch", {
        payload: temporalPayload("temporal-feed-rollback"),
      }),
    ).rejects.toThrow("forced temporal Feed failure");

    expect(
      await rows(
        mock,
        `SELECT version, story_time_order AS storyTimeOrder,
                chronicle_start_time AS startTime, updated_at AS updatedAt
           FROM tree_nodes WHERE id = 'temporal-browser-scene'`,
      ),
    ).toEqual([
      {
        version: 0,
        storyTimeOrder: null,
        startTime: null,
        updatedAt: "2000-01-01T00:00:00.000Z",
      },
    ]);
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM undo_journal
             WHERE id = 'temporal-feed-rollback') AS journals,
           (SELECT COUNT(*) FROM change_events
             WHERE event_uid = 'event:temporal-feed-rollback') AS canonicalEvents,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'temporal-feed-rollback') AS feedTransactions,
           (SELECT COUNT(*) FROM narrative_change_events
             WHERE canonical_change_event_uid = 'event:temporal-feed-rollback') AS feedEvents,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'temporal_scene_patch'
               AND request_id = 'temporal-feed-rollback') AS receipts`,
      ),
    ).toEqual([
      {
        journals: 0,
        canonicalEvents: 0,
        feedTransactions: 0,
        feedEvents: 0,
        receipts: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });
});
