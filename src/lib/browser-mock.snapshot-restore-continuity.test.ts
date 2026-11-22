// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";
import { withCanonicalWriterTestContext } from "./browser-mock.canonical-test-context";

const PROJECT = "restore-continuity-project";
const SCENE = "restore-continuity-scene";

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

const canonicalTreeRow = {
  id: SCENE,
  project_id: PROJECT,
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

describe("browser mock: writes after a project snapshot restore", () => {
  let mock: PersistentBrowserMock;

  beforeEach(async () => {
    mock = withCanonicalWriterTestContext(
      await createBrowserMock({ allowProtectedWriterTestFixtures: true }),
    );
    await mock.invoke("db_execute", {
      sql: `INSERT INTO projects (id, title) VALUES ('${PROJECT}', 'Continuity')`,
      params: [],
      method: "run",
    });
    await mock.invoke("tree_node_create", {
      payload: {
        id: SCENE,
        projectId: PROJECT,
        parentId: null,
        nodeType: "scene",
        title: "Snapshot title",
        sortOrder: "a",
      },
    });
    await mock.invoke("project_snapshot_create", {
      payload: {
        projectId: PROJECT,
        snapshotId: "restore-continuity-snapshot",
        name: "Snapshot",
        description: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        treeRows: [
          {
            snapshot_id: "restore-continuity-snapshot",
            node_id: SCENE,
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

  async function patchTitle(title: string, requestId: string): Promise<void> {
    const [{ version }] = await rows(
      mock,
      "SELECT version FROM tree_nodes WHERE id = ?",
      [SCENE],
    );
    await mock.invoke("tree_node_patch", {
      payload: {
        projectId: PROJECT,
        nodeId: SCENE,
        requestId,
        patch: { title },
        baseVersion: Number(version),
        bumpVersion: false,
        updatedAt: "2026-08-11T01:00:00.000Z",
      },
    });
  }

  async function restore(requestId: string): Promise<void> {
    await mock.invoke("project_snapshot_apply_restore", {
      payload: {
        requestId,
        sessionId: "restore-continuity-session",
        projectId: PROJECT,
        snapshotId: "restore-continuity-snapshot",
        scopes: ["body"],
        inserts: [
          { table: "tree_nodes", mode: "insert", row: canonicalTreeRow },
        ],
      },
    });
  }

  async function tamper(): Promise<void> {
    await mock.invoke("db_execute", {
      sql: "UPDATE tree_nodes SET title = ? WHERE id = ?",
      params: ["Changed outside the Change Feed", SCENE],
      method: "run",
    });
  }

  it("writes the object again after a restore that reverted it", async () => {
    await patchTitle("Edited after the snapshot", "edit-1");
    await restore("restore-1");
    await patchTitle("Edited after the restore", "edit-2");
    expect(
      await rows(mock, "SELECT title FROM tree_nodes WHERE id = ?", [SCENE]),
    ).toEqual([{ title: "Edited after the restore" }]);
    // The exemption was used once: the head follows the row again.
    await patchTitle("Edited once more", "edit-3");
    await tamper();
    await expect(patchTitle("After tampering", "edit-4")).rejects.toThrow(
      "continuity mismatch",
    );
  });

  it("still refuses a mismatch when there was no restore", async () => {
    await patchTitle("Edited", "edit-1");
    await tamper();
    await expect(patchTitle("After tampering", "edit-2")).rejects.toThrow(
      "continuity mismatch",
    );
  });

  it("does not let a restore marker of another project exempt a mismatch", async () => {
    await mock.invoke("db_execute", {
      sql: "INSERT INTO projects (id, title) VALUES ('other-project', 'Other')",
      params: [],
      method: "run",
    });
    await patchTitle("Edited", "edit-1");
    await tamper();
    // A restore in the other project leaves a marker that is newer than this
    // object's head, but it belongs to another project.
    await mock.invoke("project_snapshot_create", {
      payload: {
        projectId: "other-project",
        snapshotId: "other-snapshot",
        name: "Other",
        description: null,
        createdAt: "2026-07-30T00:00:00.000Z",
        treeRows: [],
        codexRows: [],
        snippetRows: [],
        versionIds: [],
      },
    });
    // Enough writes in the other project that its marker's sequence is
    // numerically newer than this project's head.
    for (const id of ["other-scene-1", "other-scene-2", "other-scene-3"]) {
      await mock.invoke("tree_node_create", {
        payload: {
          id,
          projectId: "other-project",
          parentId: null,
          nodeType: "scene",
          title: id,
          sortOrder: id,
        },
      });
    }
    await mock.invoke("project_snapshot_apply_restore", {
      payload: {
        requestId: "other-restore",
        sessionId: "other-session",
        projectId: "other-project",
        snapshotId: "other-snapshot",
        scopes: ["body"],
        inserts: [],
      },
    });
    await expect(patchTitle("After tampering", "edit-2")).rejects.toThrow(
      "continuity mismatch",
    );
  });

  it("refuses to replay what predates a restore and replays what follows it", async () => {
    const created = await mock.invoke<{ version: number }>(
      "agent_codex_create",
      {
        payload: {
          projectId: PROJECT,
          sessionId: "restore-continuity-session",
          surface: "in-app-agent",
          entryId: "restore-continuity-codex",
          typeSlug: "character",
          name: "Original",
          summary: "s",
          content: "{}",
        },
      },
    );
    const before = await mock.invoke<{
      version: number;
      undoJournalId: string;
    }>("agent_codex_update", {
      payload: {
        projectId: PROJECT,
        sessionId: "restore-continuity-session",
        surface: "in-app-agent",
        entryId: "restore-continuity-codex",
        baseVersion: created.version,
        name: "Edited before the restore",
        content: "{}",
      },
    });
    await restore("restore-1");
    const replay = (
      journalId: string,
      direction: "undo" | "redo",
      requestId: string,
    ) =>
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId,
          projectId: PROJECT,
          sessionId: "restore-continuity-session",
          journalId,
          direction,
        },
      });
    await expect(
      replay(before.undoJournalId, "undo", "undo-old"),
    ).rejects.toThrow("NARRATIVE_CHANGE_FEED_REPLAY_SUPERSEDED_BY_RESTORE");
    expect(
      await rows(mock, "SELECT name FROM codex_entries WHERE id = ?", [
        "restore-continuity-codex",
      ]),
    ).toEqual([{ name: "Edited before the restore" }]);
    const after = await mock.invoke<{ undoJournalId: string }>(
      "agent_codex_update",
      {
        payload: {
          projectId: PROJECT,
          sessionId: "restore-continuity-session",
          surface: "in-app-agent",
          entryId: "restore-continuity-codex",
          baseVersion: before.version,
          name: "Edited after the restore",
          content: "{}",
        },
      },
    );
    await replay(after.undoJournalId, "undo", "undo-new");
    expect(
      await rows(mock, "SELECT name FROM codex_entries WHERE id = ?", [
        "restore-continuity-codex",
      ]),
    ).toEqual([{ name: "Edited before the restore" }]);
    await replay(after.undoJournalId, "redo", "redo-new");
  });
});
