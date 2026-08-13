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

describe("BrowserMock scene revision restore", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  const oldContent = JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: "old" }] }],
  });
  const targetContent = JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "restored" }] },
    ],
  });

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({
      onDatabaseDirty,
      allowProtectedWriterTestFixtures: true,
    });
    await run(
      mock,
      `INSERT INTO projects (id, title) VALUES
        ('revision-project', 'Revision'), ('revision-foreign', 'Foreign')`,
    );
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order, content, char_count,
         placed_beat_preview, version, created_at, updated_at)
       VALUES
        ('revision-scene', 'revision-project', 'scene', 'Scene', 'a0', ?, 3,
         '["old beat"]', 4, '2026-08-13T00:00:00.000Z',
         '2026-08-13T00:00:00.000Z')`,
      [oldContent],
    );
    await run(
      mock,
      `INSERT INTO content_versions
        (id, entity_type, entity_id, content, version_number, snapshot_type,
         created_at)
       VALUES ('revision-target', 'scene', 'revision-scene', ?, 1, 'auto',
               '2026-08-13T00:00:00.000Z')`,
      [targetContent],
    );
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  function payload(requestId = "revision-restore-request") {
    return {
      requestId,
      sessionId: "revision-session:first",
      projectId: "revision-project",
      entityType: "scene",
      entityId: "revision-scene",
      revisionId: "revision-target",
      content: targetContent,
      currentContent: oldContent,
      expectedVersion: 4,
      charCount: 8,
      placedBeatPreview: null,
    };
  }

  it("commits the safety revision, scene, canonical event, Feed, and stable retry receipt atomically", async () => {
    const first = await mock.invoke<Record<string, unknown>>(
      "revision_scene_restore",
      { payload: payload() },
    );
    expect(first).toMatchObject({
      sceneId: "revision-scene",
      revisionId: "revision-target",
      safetyRevisionId: expect.any(String),
      version: 5,
      changeEventUid: expect.any(String),
      canonicalSequence: 1,
      maintenanceTransactionId: expect.any(String),
      replayed: false,
    });

    const retry = await mock.invoke<Record<string, unknown>>(
      "revision_scene_restore",
      {
        payload: {
          ...payload(),
          sessionId: "revision-session:after-restart",
        },
      },
    );
    expect(retry).toEqual({ ...first, replayed: true });
    await expect(
      mock.invoke("revision_scene_restore", {
        payload: { ...payload(), content: oldContent },
      }),
    ).rejects.toThrow("REVISION_CONTENT_RESTORE_IDEMPOTENCY_CONFLICT");

    expect(
      await rows(
        mock,
        `SELECT scene.content, scene.char_count, scene.placed_beat_preview,
                scene.version,
                safety.content AS safety_content,
                safety.snapshot_type AS safety_type,
                canonical.domain, canonical.op_type,
                transaction_row.origin, transaction_row.cause_kind,
                event.event_ordinal, event.object_key_json,
                event.change_kind, event.mutation_kind,
                (SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = 'revision_scene_restore'
                    AND request_id = 'revision-restore-request') AS receipts
           FROM tree_nodes scene
           JOIN content_versions safety ON safety.id = ?
           JOIN change_events canonical
             ON canonical.event_uid = ? AND canonical.project_id = scene.project_id
           JOIN narrative_change_transactions transaction_row
             ON transaction_row.id = ?
           JOIN narrative_change_events event
             ON event.transaction_id = transaction_row.id
          WHERE scene.id = 'revision-scene'`,
        [
          first.safetyRevisionId,
          first.changeEventUid,
          first.maintenanceTransactionId,
        ],
      ),
    ).toEqual([
      expect.objectContaining({
        content: targetContent,
        char_count: 8,
        placed_beat_preview: null,
        version: 5,
        safety_content: oldContent,
        safety_type: "manual",
        domain: "revision",
        op_type: "content.restore",
        origin: "restore",
        cause_kind: "forward",
        event_ordinal: 0,
        object_key_json: JSON.stringify({
          kind: "scene",
          sceneId: "revision-scene",
        }),
        change_kind: "content",
        mutation_kind: "update",
        receipts: 1,
      }),
    ]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });

  it("fails closed on project scope and rolls the complete restore back when Feed append fails", async () => {
    await expect(
      mock.invoke("revision_scene_restore", {
        payload: {
          ...payload("revision-cross-project"),
          projectId: "revision-foreign",
        },
      }),
    ).rejects.toThrow("REVISION_CONTENT_RESTORE_PROJECT_MISMATCH");

    await run(
      mock,
      `CREATE TRIGGER reject_revision_restore_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN SELECT RAISE(ABORT, 'forced revision restore Feed failure'); END`,
    );
    onDatabaseDirty.mockClear();
    await expect(
      mock.invoke("revision_scene_restore", {
        payload: payload("revision-feed-failure"),
      }),
    ).rejects.toThrow("forced revision restore Feed failure");

    expect(
      await rows(
        mock,
        `SELECT scene.content, scene.char_count, scene.version,
                (SELECT COUNT(*) FROM content_versions
                  WHERE entity_type = 'scene'
                    AND entity_id = 'revision-scene') AS revisions,
                (SELECT COUNT(*) FROM change_events
                  WHERE project_id = 'revision-project') AS canonical_count,
                (SELECT COUNT(*) FROM narrative_change_transactions
                  WHERE project_id = 'revision-project') AS feed_count,
                (SELECT COUNT(*) FROM idempotency_requests
                  WHERE domain = 'revision_scene_restore'
                    AND request_id = 'revision-feed-failure') AS receipt_count
           FROM tree_nodes scene WHERE scene.id = 'revision-scene'`,
      ),
    ).toEqual([
      {
        content: oldContent,
        char_count: 3,
        version: 4,
        revisions: 1,
        canonical_count: 0,
        feed_count: 0,
        receipt_count: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });
});
