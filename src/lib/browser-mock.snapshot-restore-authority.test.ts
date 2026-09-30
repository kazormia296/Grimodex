// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

async function run(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await mock.invoke("db_execute", { sql, params, method: "run" });
}

async function title(mock: PersistentBrowserMock): Promise<string> {
  const result = await mock.invoke<{ rows: Array<{ title: string }> }>(
    "db_execute",
    {
      sql: "SELECT title FROM tree_nodes WHERE id = 'snapshot-authority-scene'",
      params: [],
      method: "all",
    },
  );
  return result.rows[0]?.title ?? "";
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

describe("browser snapshot restore authority", () => {
  let mock: PersistentBrowserMock;

  beforeEach(async () => {
    mock = await createBrowserMock({ allowProtectedWriterTestFixtures: true });
    await run(
      mock,
      "INSERT INTO projects (id, title) VALUES ('snapshot-authority-project', 'Authority')",
    );
    await run(
      mock,
      `INSERT INTO tree_nodes
         (id, project_id, node_type, title, sort_order, created_at, updated_at)
       VALUES
         ('snapshot-authority-scene', 'snapshot-authority-project', 'scene',
          'Live title', 'a', '2026-07-30T00:00:00.000Z',
          '2026-07-30T00:00:00.000Z')`,
    );
    await mock.invoke("project_snapshot_create", {
      payload: {
        projectId: "snapshot-authority-project",
        snapshotId: "snapshot-authority-snapshot",
        name: "Authority snapshot",
        description: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        treeRows: [
          {
            snapshot_id: "snapshot-authority-snapshot",
            node_id: "snapshot-authority-scene",
            parent_id: null,
            node_type: "scene",
            title: "Snapshot title",
            synopsis: null,
            intent: null,
            sort_order: "a",
            story_time_order: null,
            story_time_label: null,
            pov_character_id: null,
            location_id: null,
            chronicle_start_time: null,
            chronicle_start_minute: null,
            chronicle_start_granularity: "none",
            chronicle_end_time: null,
            chronicle_end_minute: null,
            chronicle_end_granularity: "none",
            chronicle_precision: "exact",
            status: null,
            body_version_id: null,
            unplaced_beats_doc: "[]",
            char_count: 0,
            created_at: "2026-07-30T00:00:00.000Z",
            updated_at: "2026-07-30T00:00:00.000Z",
          },
        ],
        codexRows: [],
        snippetRows: [],
        versionIds: [],
      },
    });
  });

  afterEach(() => mock.close());

  const canonicalTreeRow = {
    id: "snapshot-authority-scene",
    project_id: "snapshot-authority-project",
    parent_id: null,
    node_type: "scene",
    title: "Snapshot title",
    synopsis: null,
    intent: null,
    sort_order: "a",
    story_time_order: null,
    story_time_label: null,
    pov_character_id: null,
    location_id: null,
    chronicle_start_time: null,
    chronicle_start_minute: null,
    chronicle_start_granularity: "none",
    chronicle_end_time: null,
    chronicle_end_minute: null,
    chronicle_end_granularity: "none",
    chronicle_precision: "exact",
    status: null,
    content: "{}",
    unplaced_beats_doc: "[]",
    char_count: 0,
    unplaced_beat_preview: null,
    placed_beat_preview: null,
    created_at: "2026-07-30T00:00:00.000Z",
    updated_at: "2026-07-30T00:00:00.000Z",
  };

  it("rejects same-primary-key content injection before wiping live rows", async () => {
    await expect(
      mock.invoke("project_snapshot_apply_restore", {
        payload: {
          requestId: "snapshot-authority-tamper",
          sessionId: "session-1",
          projectId: "snapshot-authority-project",
          snapshotId: "snapshot-authority-snapshot",
          scopes: ["body"],
          inserts: [
            {
              table: "tree_nodes",
              mode: "insert",
              row: { ...canonicalTreeRow, title: "Injected title" },
            },
          ],
        },
      }),
    ).rejects.toThrow("does not match the owned snapshot");
    await expect(title(mock)).resolves.toBe("Live title");
  });

  it("rejects an incomplete renderer plan before wiping live rows", async () => {
    await expect(
      mock.invoke("project_snapshot_apply_restore", {
        payload: {
          requestId: "snapshot-authority-omission",
          sessionId: "session-1",
          projectId: "snapshot-authority-project",
          snapshotId: "snapshot-authority-snapshot",
          scopes: ["body"],
          inserts: [],
        },
      }),
    ).rejects.toThrow("omits owned snapshot rows");
    await expect(title(mock)).resolves.toBe("Live title");
  });

  it("commits the restore, canonical event, typed Feed, and stable retry receipt together", async () => {
    const semantic = {
      requestId: "snapshot-authority-restore",
      projectId: "snapshot-authority-project",
      snapshotId: "snapshot-authority-snapshot",
      scopes: ["body"],
      inserts: [{ table: "tree_nodes", mode: "insert", row: canonicalTreeRow }],
    };
    const first = await mock.invoke<Record<string, unknown>>(
      "project_snapshot_apply_restore",
      {
        payload: { ...semantic, sessionId: "snapshot-session:first" },
      },
    );
    expect(first).toMatchObject({
      canonicalSequence: 1,
      changeEventUid: expect.any(String),
      maintenanceTransactionId: expect.any(String),
      noOp: false,
    });
    expect(await title(mock)).toBe("Snapshot title");
    const retry = await mock.invoke<Record<string, unknown>>(
      "project_snapshot_apply_restore",
      {
        payload: { ...semantic, sessionId: "snapshot-session:retry" },
      },
    );
    expect(retry).toEqual(first);
    await expect(
      mock.invoke("project_snapshot_apply_restore", {
        payload: {
          ...semantic,
          sessionId: "snapshot-session:conflict",
          scopes: ["body", "labels"],
        },
      }),
    ).rejects.toThrow("PROJECT_SNAPSHOT_RESTORE_IDEMPOTENCY_CONFLICT");
    expect(
      await rows(
        mock,
        `SELECT transaction_row.origin, transaction_row.cause_kind,
                event.event_ordinal, event.object_key_json,
                event.mutation_kind, event.changed_paths_json
           FROM narrative_change_transactions transaction_row
           JOIN narrative_change_events event
             ON event.transaction_id = transaction_row.id
          WHERE transaction_row.request_id = 'snapshot-authority-restore'
          ORDER BY event.event_ordinal`,
      ),
    ).toEqual([
      expect.objectContaining({
        origin: "restore",
        cause_kind: "forward",
        event_ordinal: 0,
        object_key_json: JSON.stringify({
          kind: "project",
          projectId: "snapshot-authority-project",
        }),
        mutation_kind: "update",
        changed_paths_json: JSON.stringify(["/"]),
      }),
    ]);
  });

  it("rejects cross-project snapshots and rolls the complete restore back on Feed failure", async () => {
    await expect(
      mock.invoke("project_snapshot_apply_restore", {
        payload: {
          requestId: "snapshot-authority-cross-project",
          sessionId: "snapshot-session:foreign",
          projectId: "default-project",
          snapshotId: "snapshot-authority-snapshot",
          scopes: ["body"],
          inserts: [
            { table: "tree_nodes", mode: "insert", row: canonicalTreeRow },
          ],
        },
      }),
    ).rejects.toThrow("is not owned by project");
    await run(
      mock,
      `CREATE TRIGGER reject_snapshot_restore_feed
       BEFORE INSERT ON narrative_change_events
       BEGIN SELECT RAISE(ABORT, 'forced snapshot Feed failure'); END`,
    );
    await expect(
      mock.invoke("project_snapshot_apply_restore", {
        payload: {
          requestId: "snapshot-authority-rollback",
          sessionId: "snapshot-session:rollback",
          projectId: "snapshot-authority-project",
          snapshotId: "snapshot-authority-snapshot",
          scopes: ["body"],
          inserts: [
            { table: "tree_nodes", mode: "insert", row: canonicalTreeRow },
          ],
        },
      }),
    ).rejects.toThrow("forced snapshot Feed failure");
    expect(await title(mock)).toBe("Live title");
    expect(
      await rows(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM change_events
             WHERE domain = 'revision') AS canonical_count,
           (SELECT COUNT(*) FROM narrative_change_transactions
             WHERE request_id = 'snapshot-authority-rollback') AS feed_count,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE domain = 'project_snapshot_restore'
               AND request_id = 'snapshot-authority-rollback') AS receipt_count`,
      ),
    ).toEqual([{ canonical_count: 0, feed_count: 0, receipt_count: 0 }]);
  });
});
