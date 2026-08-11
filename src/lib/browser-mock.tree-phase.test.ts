// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  verifyChain,
  type EventForVerify,
} from "@/features/timelapse/hashChain";
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

async function seedPhaseAggregate(mock: PersistentBrowserMock): Promise<void> {
  const now = "2026-08-11T00:00:00.000Z";
  await mock.invoke("db_execute_batch", {
    statements: [
      {
        sql: `INSERT INTO codex_entries
          (id, project_id, type, name, content, version, created_at, updated_at)
         VALUES (?, 'default-project', 'character', 'Phase owner', '{}', 1, ?, ?)`,
        params: ["phase-owner", now, now],
        method: "run",
      },
      {
        sql: `INSERT INTO codex_detail_definitions
          (id, project_id, type_slug, name, field_type, sort_order,
           include_in_context, version, created_at, updated_at)
         VALUES (?, 'default-project', 'character', ?, 'text', 0, 0, 0, ?, ?)`,
        params: ["phase-def", "Phase field", now, now],
        method: "run",
      },
      {
        sql: `INSERT INTO codex_entry_phases
          (id, entry_id, label, summary_override, content_override,
           context_mode_override, version, created_at, updated_at)
         VALUES (?, ?, 'Before', 'before-summary', 'before-content',
                 'mentioned', 3, ?, ?)`,
        params: ["phase-1", "phase-owner", now, now],
        method: "run",
      },
      {
        sql: `INSERT INTO codex_phase_detail_overrides
          (phase_id, definition_id, value) VALUES (?, ?, ?)`,
        params: ["phase-1", "phase-def", "before-value"],
        method: "run",
      },
    ],
  });
}

describe("browser mock typed Tree writes", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({ onDatabaseDirty });
  });

  afterEach(() => mock.close());

  it("persists create sortOrder and rejects stale patches before dirty/readback", async () => {
    const created = await mock.invoke<Record<string, unknown>>(
      "tree_node_create",
      {
        payload: {
          id: "tree-sort-order",
          projectId: "default-project",
          parentId: null,
          nodeType: "scene",
          title: "Sorted scene",
          sortOrder: "a0V",
        },
      },
    );
    expect(created.sortOrder).toBe("a0V");

    const winner = await mock.invoke<Record<string, unknown>>(
      "tree_node_patch",
      {
        payload: {
          projectId: "default-project",
          nodeId: "tree-sort-order",
          patch: { title: "Winner" },
          baseVersion: 0,
          bumpVersion: true,
          updatedAt: "2026-08-11T01:00:00.000Z",
        },
      },
    );
    expect(winner).toMatchObject({
      title: "Winner",
      sortOrder: "a0V",
      version: 1,
      updatedAt: "2026-08-11T01:00:00.000Z",
    });
    const dirtyCallsAfterWinner = onDatabaseDirty.mock.calls.length;

    await expect(
      mock.invoke("tree_node_patch", {
        payload: {
          projectId: "default-project",
          nodeId: "tree-sort-order",
          patch: { title: "Stale loser" },
          baseVersion: 0,
          bumpVersion: true,
          updatedAt: "2026-08-11T02:00:00.000Z",
        },
      }),
    ).rejects.toThrow("TREE_NODE_VERSION_MISMATCH");
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyCallsAfterWinner);
    expect(
      await rows(
        mock,
        "SELECT title, sort_order, version, updated_at FROM tree_nodes WHERE id = ?",
        ["tree-sort-order"],
      ),
    ).toEqual([
      {
        title: "Winner",
        sort_order: "a0V",
        version: 1,
        updated_at: "2026-08-11T01:00:00.000Z",
      },
    ]);
  });

  it("rejects malformed hosted tree payloads before mutation", async () => {
    await mock.invoke("tree_node_create", {
      payload: {
        id: "tree-typed-node",
        projectId: "default-project",
        parentId: null,
        nodeType: "scene",
        title: "Typed",
        sortOrder: "a0",
      },
    });
    const before = await rows(
      mock,
      `SELECT title, char_count, version, updated_at
         FROM tree_nodes WHERE id = 'tree-typed-node'`,
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("tree_node_create", {
        payload: {
          id: "tree-bad-create",
          projectId: "default-project",
          parentId: null,
          nodeType: "scene",
          title: "Bad",
          sortOrder: "a1",
          sourceMtime: 123,
        },
      }),
    ).rejects.toThrow("sourceMtime");
    await expect(
      mock.invoke("tree_node_patch", {
        payload: {
          projectId: "default-project",
          nodeId: "tree-typed-node",
          patch: { title: "Rejected" },
          baseVersion: "0",
          bumpVersion: true,
          updatedAt: "2026-08-11T02:00:00.000Z",
        },
      }),
    ).rejects.toThrow("baseVersion");
    await expect(
      mock.invoke("tree_node_patch", {
        payload: {
          projectId: "default-project",
          nodeId: "tree-typed-node",
          patch: { charCount: "12" },
          baseVersion: 0,
          bumpVersion: true,
          updatedAt: "2026-08-11T02:00:00.000Z",
        },
      }),
    ).rejects.toThrow("charCount");

    expect(
      await rows(
        mock,
        "SELECT id FROM tree_nodes WHERE id = 'tree-bad-create'",
      ),
    ).toEqual([]);
    expect(
      await rows(
        mock,
        `SELECT title, char_count, version, updated_at
           FROM tree_nodes WHERE id = 'tree-typed-node'`,
      ),
    ).toEqual(before);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("rejects cross-project parents on create and patch without mutating or dirtying", async () => {
    await mock.invoke("db_execute_batch", {
      statements: [
        {
          sql: `INSERT INTO projects (id, title, language)
                VALUES ('tree-foreign-project', 'Foreign', 'ja')`,
          params: [],
          method: "run",
        },
        {
          sql: `INSERT INTO tree_nodes
                (id, project_id, node_type, title, sort_order)
                VALUES ('tree-foreign-parent', 'tree-foreign-project',
                        'folder', 'Foreign parent', 'a0')`,
          params: [],
          method: "run",
        },
        {
          sql: `INSERT INTO codex_entries
                (id, project_id, type, name, content, created_at, updated_at)
                VALUES
                  ('tree-foreign-pov', 'tree-foreign-project', 'character',
                   'Foreign POV', '{}', '2026-08-11', '2026-08-11'),
                  ('tree-foreign-location', 'tree-foreign-project', 'location',
                   'Foreign location', '{}', '2026-08-11', '2026-08-11')`,
          params: [],
          method: "run",
        },
      ],
    });
    await mock.invoke("tree_node_create", {
      payload: {
        id: "tree-local-node",
        projectId: "default-project",
        parentId: null,
        nodeType: "scene",
        title: "Local",
        sortOrder: "a0",
        content: '{"type":"doc","content":[]}',
      },
    });
    const before = await rows(
      mock,
      `SELECT parent_id, title, content, version, updated_at
         FROM tree_nodes WHERE id = 'tree-local-node'`,
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("tree_node_create", {
        payload: {
          id: "tree-cross-create",
          projectId: "default-project",
          parentId: "tree-foreign-parent",
          nodeType: "scene",
          title: "Must not exist",
          sortOrder: "a1",
        },
      }),
    ).rejects.toThrow("not a folder in project 'default-project'");
    expect(
      await rows(
        mock,
        "SELECT id FROM tree_nodes WHERE id = 'tree-cross-create'",
      ),
    ).toEqual([]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();

    await expect(
      mock.invoke("tree_node_patch", {
        payload: {
          projectId: "default-project",
          nodeId: "tree-local-node",
          patch: {
            parentId: "tree-foreign-parent",
            title: "Must roll back",
            content: '{"type":"doc","content":[{"type":"paragraph"}]}',
          },
          baseVersion: 0,
          bumpVersion: true,
          updatedAt: "2026-08-11T03:00:00.000Z",
        },
      }),
    ).rejects.toThrow("not a folder in project 'default-project'");
    expect(
      await rows(
        mock,
        `SELECT parent_id, title, content, version, updated_at
           FROM tree_nodes WHERE id = 'tree-local-node'`,
      ),
    ).toEqual(before);
    expect(onDatabaseDirty).not.toHaveBeenCalled();

    for (const [field, foreignId, label] of [
      ["povCharacterId", "tree-foreign-pov", "POV character"],
      ["locationId", "tree-foreign-location", "location"],
    ] as const) {
      await expect(
        mock.invoke("tree_node_patch", {
          payload: {
            projectId: "default-project",
            nodeId: "tree-local-node",
            patch: { [field]: foreignId, title: "Must still roll back" },
            baseVersion: 0,
            bumpVersion: true,
            updatedAt: "2026-08-11T04:00:00.000Z",
          },
        }),
      ).rejects.toThrow(`${label} '${foreignId}' is not in project`);
      expect(
        await rows(
          mock,
          `SELECT parent_id, title, content, version, updated_at
             FROM tree_nodes WHERE id = 'tree-local-node'`,
        ),
      ).toEqual(before);
      expect(onDatabaseDirty).not.toHaveBeenCalled();
    }
  });

  it("requires folder parents and rejects self/descendant cycles atomically", async () => {
    for (const payload of [
      {
        id: "tree-cycle-root",
        projectId: "default-project",
        parentId: null,
        nodeType: "folder",
        title: "Root",
        sortOrder: "a0",
      },
      {
        id: "tree-cycle-child",
        projectId: "default-project",
        parentId: "tree-cycle-root",
        nodeType: "folder",
        title: "Child",
        sortOrder: "a1",
      },
      {
        id: "tree-cycle-scene",
        projectId: "default-project",
        parentId: "tree-cycle-root",
        nodeType: "scene",
        title: "Scene",
        sortOrder: "a2",
      },
    ]) {
      await mock.invoke("tree_node_create", { payload });
    }
    const rootBefore = await rows(
      mock,
      `SELECT parent_id, title, content, version, updated_at
         FROM tree_nodes WHERE id = 'tree-cycle-root'`,
    );
    onDatabaseDirty.mockClear();

    for (const [id, parentId] of [
      ["tree-non-folder-create", "tree-cycle-scene"],
      ["tree-self-create", "tree-self-create"],
    ]) {
      await expect(
        mock.invoke("tree_node_create", {
          payload: {
            id,
            projectId: "default-project",
            parentId,
            nodeType: "scene",
            title: "Rejected",
            sortOrder: "b0",
          },
        }),
      ).rejects.toThrow("not a folder");
    }
    expect(
      await rows(
        mock,
        `SELECT id FROM tree_nodes
          WHERE id IN ('tree-non-folder-create', 'tree-self-create')`,
      ),
    ).toEqual([]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();

    await expect(
      mock.invoke("tree_node_patch", {
        payload: {
          projectId: "default-project",
          nodeId: "tree-cycle-root",
          patch: { parentId: "tree-cycle-root", title: "Self" },
          baseVersion: 0,
          bumpVersion: true,
          updatedAt: "2026-08-11T05:00:00.000Z",
        },
      }),
    ).rejects.toThrow("own parent");
    await expect(
      mock.invoke("tree_node_patch", {
        payload: {
          projectId: "default-project",
          nodeId: "tree-cycle-root",
          patch: { parentId: "tree-cycle-child", title: "Cycle" },
          baseVersion: 0,
          bumpVersion: true,
          updatedAt: "2026-08-11T05:00:00.000Z",
        },
      }),
    ).rejects.toThrow("descendant cycle");
    await expect(
      mock.invoke("tree_node_patch", {
        payload: {
          projectId: "default-project",
          nodeId: "tree-cycle-root",
          patch: { parentId: "tree-cycle-scene", title: "Non-folder" },
          baseVersion: 0,
          bumpVersion: true,
          updatedAt: "2026-08-11T05:00:00.000Z",
        },
      }),
    ).rejects.toThrow("not a folder");
    expect(
      await rows(
        mock,
        `SELECT parent_id, title, content, version, updated_at
           FROM tree_nodes WHERE id = 'tree-cycle-root'`,
      ),
    ).toEqual(rootBefore);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });
});

describe("browser mock Phase aggregate CAS and undo journal", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({ onDatabaseDirty });
    await seedPhaseAggregate(mock);
  });

  afterEach(() => mock.close());

  it("rejects cross-project and non-scene phase anchors atomically", async () => {
    await mock.invoke("db_execute_batch", {
      statements: [
        {
          sql: `INSERT INTO projects (id, title, language)
                VALUES ('phase-foreign-project', 'Foreign', 'ja')`,
          params: [],
          method: "run",
        },
        {
          sql: `INSERT INTO tree_nodes
                (id, project_id, node_type, title, sort_order)
                VALUES
                  ('phase-foreign-scene', 'phase-foreign-project', 'scene',
                   'Foreign', 'a0'),
                  ('phase-local-folder', 'default-project', 'folder',
                   'Folder', 'a0')`,
          params: [],
          method: "run",
        },
      ],
    });
    const before = await rows(
      mock,
      `SELECT label, anchor_node_id, version
         FROM codex_entry_phases WHERE id = 'phase-1'`,
    );
    const overridesBefore = await rows(
      mock,
      `SELECT definition_id, value FROM codex_phase_detail_overrides
        WHERE phase_id = 'phase-1'`,
    );
    onDatabaseDirty.mockClear();

    for (const [phaseId, anchorNodeId] of [
      ["phase-cross-create", "phase-foreign-scene"],
      ["phase-folder-create", "phase-local-folder"],
    ]) {
      await expect(
        mock.invoke("agent_codex_mutate", {
          payload: {
            operation: "phase.create",
            projectId: "default-project",
            entryId: "phase-owner",
            phaseId,
            anchorNodeId,
            label: "Rejected",
            version: 0,
          },
        }),
      ).rejects.toThrow("is not a scene in project");
    }
    for (const anchorNodeId of ["phase-foreign-scene", "phase-local-folder"]) {
      await expect(
        mock.invoke("agent_codex_mutate", {
          payload: {
            operation: "phase.aggregate",
            projectId: "default-project",
            sessionId: "phase-anchor-session",
            phaseId: "phase-1",
            baseVersion: 3,
            anchorNodeId,
            label: "Rejected update",
            detailOverrides: [],
          },
        }),
      ).rejects.toThrow("is not a scene in project");
    }

    expect(
      await rows(
        mock,
        `SELECT id FROM codex_entry_phases
          WHERE id IN ('phase-cross-create', 'phase-folder-create')`,
      ),
    ).toEqual([]);
    expect(
      await rows(
        mock,
        `SELECT label, anchor_node_id, version
           FROM codex_entry_phases WHERE id = 'phase-1'`,
      ),
    ).toEqual(before);
    expect(
      await rows(
        mock,
        `SELECT definition_id, value FROM codex_phase_detail_overrides
          WHERE phase_id = 'phase-1'`,
      ),
    ).toEqual(overridesBefore);
    expect(
      await rows(
        mock,
        `SELECT COUNT(*) AS journals FROM undo_journal
         WHERE entity_kind = 'codex_phase'`,
      ),
    ).toEqual([{ journals: 0 }]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("commits root, exact-after overrides, change event, and one replayable journal", async () => {
    const receipt = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_codex_mutate", {
      payload: {
        operation: "phase.aggregate",
        projectId: "default-project",
        sessionId: "phase-session",
        surface: "manual",
        phaseId: "phase-1",
        baseVersion: 3,
        label: "After",
        summaryOverride: "after-summary",
        detailOverrides: [{ definitionId: "phase-def", value: "after-value" }],
      },
    });

    expect(receipt).toMatchObject({ entityId: "phase-1", version: 4 });
    const journalRows = await rows(
      mock,
      `SELECT id, entity_kind, entity_id, op_kind, before_json, after_json,
              base_version, result_version, change_event_uid
         FROM undo_journal WHERE id = ?`,
      [receipt.undoJournalId],
    );
    expect(journalRows).toHaveLength(1);
    expect(journalRows[0]).toMatchObject({
      entity_kind: "codex_phase",
      entity_id: "phase-1",
      op_kind: "update",
      base_version: 3,
      result_version: 4,
      change_event_uid: receipt.changeEventUid,
    });
    expect(JSON.parse(String(journalRows[0].before_json))).toMatchObject({
      label: "Before",
      version: 3,
      detailOverrides: [{ definitionId: "phase-def", value: "before-value" }],
    });
    expect(JSON.parse(String(journalRows[0].after_json))).toMatchObject({
      label: "After",
      version: 4,
      detailOverrides: [{ definitionId: "phase-def", value: "after-value" }],
    });

    const committedState = async () => ({
      phase: await rows(
        mock,
        `SELECT label, summary_override, content_override, version
           FROM codex_entry_phases WHERE id = 'phase-1'`,
      ),
      overrides: await rows(
        mock,
        `SELECT definition_id, value FROM codex_phase_detail_overrides
          WHERE phase_id = 'phase-1' ORDER BY definition_id`,
      ),
      journals: await rows(
        mock,
        `SELECT id, base_version, result_version
           FROM undo_journal ORDER BY id`,
      ),
      changes: await rows(
        mock,
        "SELECT event_uid FROM change_events ORDER BY id",
      ),
    });
    const afterSuccess = await committedState();
    expect(afterSuccess.phase).toEqual([
      {
        label: "After",
        summary_override: "after-summary",
        content_override: "before-content",
        version: 4,
      },
    ]);
    expect(afterSuccess.overrides).toEqual([
      { definition_id: "phase-def", value: "after-value" },
    ]);
    const dirtyCallsAfterSuccess = onDatabaseDirty.mock.calls.length;

    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          operation: "phase.aggregate",
          projectId: "default-project",
          sessionId: "phase-session",
          phaseId: "phase-1",
          baseVersion: 3,
          label: "Stale",
          detailOverrides: [],
        },
      }),
    ).rejects.toThrow("phase version conflict");
    expect(await committedState()).toEqual(afterSuccess);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyCallsAfterSuccess);

    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          operation: "phase.aggregate",
          projectId: "default-project",
          sessionId: "phase-session",
          phaseId: "phase-1",
          baseVersion: 4,
          label: "Must roll back",
          detailOverrides: [
            { definitionId: "missing-definition", value: "invalid" },
          ],
        },
      }),
    ).rejects.toThrow("is not in project");
    expect(await committedState()).toEqual(afterSuccess);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyCallsAfterSuccess);

    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "phase-undo-request",
        projectId: "default-project",
        sessionId: "phase-session",
        journalId: receipt.undoJournalId,
        direction: "undo",
      },
    });
    const afterUndo = await committedState();
    expect(afterUndo.phase).toEqual([
      {
        label: "Before",
        summary_override: "before-summary",
        content_override: "before-content",
        version: 5,
      },
    ]);
    expect(afterUndo.overrides).toEqual([
      { definition_id: "phase-def", value: "before-value" },
    ]);
    expect(afterUndo.journals).toEqual([
      {
        id: receipt.undoJournalId,
        base_version: 5,
        result_version: 4,
      },
    ]);

    const dirtyCallsAfterUndo = onDatabaseDirty.mock.calls.length;
    await expect(
      mock.invoke("agent_codex_mutate", {
        payload: {
          operation: "phase.update",
          projectId: "default-project",
          sessionId: "phase-session",
          phaseId: "phase-1",
          baseVersion: 3,
          label: "ABA must stay stale",
        },
      }),
    ).rejects.toThrow("phase version conflict");
    expect(await committedState()).toEqual(afterUndo);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(dirtyCallsAfterUndo);

    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "phase-redo-request",
        projectId: "default-project",
        sessionId: "phase-session",
        journalId: receipt.undoJournalId,
        direction: "redo",
      },
    });
    const afterRedo = await committedState();
    expect(afterRedo.phase).toEqual([
      {
        label: "After",
        summary_override: "after-summary",
        content_override: "before-content",
        version: 6,
      },
    ]);
    expect(afterRedo.overrides).toEqual(afterSuccess.overrides);
    expect(afterRedo.journals).toEqual([
      {
        id: receipt.undoJournalId,
        base_version: 5,
        result_version: 6,
      },
    ]);

    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "phase-undo-repeat-request",
        projectId: "default-project",
        sessionId: "phase-session",
        journalId: receipt.undoJournalId,
        direction: "undo",
      },
    });
    expect((await committedState()).phase[0]).toMatchObject({
      label: "Before",
      version: 7,
    });
    expect((await committedState()).journals).toEqual([
      {
        id: receipt.undoJournalId,
        base_version: 7,
        result_version: 6,
      },
    ]);
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "phase-redo-repeat-request",
        projectId: "default-project",
        sessionId: "phase-session",
        journalId: receipt.undoJournalId,
        direction: "redo",
      },
    });
    const afterRepeatedRedo = await committedState();
    expect(afterRepeatedRedo.phase).toEqual([
      {
        label: "After",
        summary_override: "after-summary",
        content_override: "before-content",
        version: 8,
      },
    ]);
    expect(afterRepeatedRedo.overrides).toEqual(afterSuccess.overrides);
    expect(afterRepeatedRedo.journals).toEqual([
      {
        id: receipt.undoJournalId,
        base_version: 7,
        result_version: 8,
      },
    ]);

    const changeEvents = await rows(
      mock,
      `SELECT project_id AS projectId, scene_id AS sceneId, domain,
              op_type AS opType, entity_type AS entityType,
              entity_id AS entityId, payload, session_id AS sessionId,
              sequence, timestamp, prev_hash AS prevHash, hash
         FROM change_events WHERE project_id = 'default-project'
        ORDER BY sequence`,
    );
    expect(changeEvents).toHaveLength(5);
    expect(
      await verifyChain(changeEvents as unknown as EventForVerify[]),
    ).toMatchObject({ ok: true });
  });

  it.each([
    { direction: "undo" as const, replacement: "foreign-scene" as const },
    { direction: "undo" as const, replacement: "local-folder" as const },
    { direction: "redo" as const, replacement: "missing" as const },
  ])(
    "rejects $direction replay when the snapshot anchor is $replacement without partial writes",
    async ({ direction, replacement }) => {
      const anchorId = "phase-replay-anchor";
      await mock.invoke("db_execute_batch", {
        statements: [
          {
            sql: `INSERT INTO tree_nodes
              (id, project_id, node_type, title, sort_order)
             VALUES (?, 'default-project', 'scene', 'Original anchor', 'a0')`,
            params: [anchorId],
            method: "run",
          },
          ...(direction === "undo"
            ? [
                {
                  sql: `UPDATE codex_entry_phases SET anchor_node_id = ?
                         WHERE id = 'phase-1'`,
                  params: [anchorId],
                  method: "run" as const,
                },
              ]
            : []),
        ],
      });

      const receipt = await mock.invoke<{ undoJournalId: string }>(
        "agent_codex_mutate",
        {
          payload: {
            operation: "phase.aggregate",
            projectId: "default-project",
            sessionId: "phase-replay-anchor-session",
            phaseId: "phase-1",
            baseVersion: 3,
            anchorNodeId: direction === "undo" ? null : anchorId,
            label: "After",
            detailOverrides: [
              { definitionId: "phase-def", value: "after-value" },
            ],
          },
        },
      );
      if (direction === "redo") {
        await mock.invoke("agent_apply_undo_journal", {
          payload: {
            requestId: "phase-replay-anchor-prerequisite-undo",
            projectId: "default-project",
            sessionId: "phase-replay-anchor-session",
            journalId: receipt.undoJournalId,
            direction: "undo",
          },
        });
      }

      const replacementStatements: Array<{
        sql: string;
        params: unknown[];
        method: "run";
      }> = [
        {
          sql: "DELETE FROM tree_nodes WHERE id = ?",
          params: [anchorId],
          method: "run",
        },
      ];
      if (replacement === "foreign-scene") {
        replacementStatements.push(
          {
            sql: `INSERT INTO projects (id, title, language)
                  VALUES ('phase-replay-foreign', 'Foreign', 'ja')`,
            params: [],
            method: "run",
          },
          {
            sql: `INSERT INTO tree_nodes
              (id, project_id, node_type, title, sort_order)
             VALUES (?, 'phase-replay-foreign', 'scene', 'Foreign', 'a0')`,
            params: [anchorId],
            method: "run",
          },
        );
      } else if (replacement === "local-folder") {
        replacementStatements.push({
          sql: `INSERT INTO tree_nodes
            (id, project_id, node_type, title, sort_order)
           VALUES (?, 'default-project', 'folder', 'Folder', 'a0')`,
          params: [anchorId],
          method: "run",
        });
      }
      await mock.invoke("db_execute_batch", {
        statements: replacementStatements,
      });

      const replayState = async () => ({
        phase: await rows(
          mock,
          `SELECT anchor_node_id, label, version
             FROM codex_entry_phases WHERE id = 'phase-1'`,
        ),
        overrides: await rows(
          mock,
          `SELECT definition_id, value FROM codex_phase_detail_overrides
            WHERE phase_id = 'phase-1' ORDER BY definition_id`,
        ),
        journals: await rows(
          mock,
          `SELECT id, before_json, after_json, base_version, result_version,
                  change_event_uid
             FROM undo_journal ORDER BY id`,
        ),
        changes: await rows(
          mock,
          `SELECT event_uid, sequence, prev_hash, hash
             FROM change_events ORDER BY id`,
        ),
      });
      const beforeReplay = await replayState();
      onDatabaseDirty.mockClear();

      await expect(
        mock.invoke("agent_apply_undo_journal", {
          payload: {
            requestId: `phase-replay-anchor-${direction}-${replacement}`,
            projectId: "default-project",
            sessionId: "phase-replay-anchor-session",
            journalId: receipt.undoJournalId,
            direction,
          },
        }),
      ).rejects.toThrow("is not a scene in project");

      expect(await replayState()).toEqual(beforeReplay);
      expect(onDatabaseDirty).not.toHaveBeenCalled();
    },
  );

  it("propagates monotonic state tokens across a stacked phase undo chain", async () => {
    const mutate = async (baseVersion: number, label: string) =>
      mock.invoke<{ undoJournalId: string }>("agent_codex_mutate", {
        payload: {
          operation: "phase.update",
          projectId: "default-project",
          sessionId: "phase-stack-session",
          phaseId: "phase-1",
          baseVersion,
          label,
        },
      });
    const apply = async (
      requestId: string,
      journalId: string,
      direction: "undo" | "redo",
    ) =>
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId,
          projectId: "default-project",
          sessionId: "phase-stack-session",
          journalId,
          direction,
        },
      });
    const phase = async () =>
      (
        await rows(
          mock,
          "SELECT label, version FROM codex_entry_phases WHERE id = 'phase-1'",
        )
      )[0];

    const first = await mutate(3, "A");
    const second = await mutate(4, "B");
    expect(await phase()).toEqual({ label: "B", version: 5 });

    await apply("phase-stack-undo-b", second.undoJournalId, "undo");
    expect(await phase()).toEqual({ label: "A", version: 6 });
    await apply("phase-stack-undo-a", first.undoJournalId, "undo");
    expect(await phase()).toEqual({ label: "Before", version: 7 });
    await apply("phase-stack-redo-a", first.undoJournalId, "redo");
    expect(await phase()).toEqual({ label: "A", version: 8 });
    await apply("phase-stack-redo-b", second.undoJournalId, "redo");
    expect(await phase()).toEqual({ label: "B", version: 9 });

    expect(
      await rows(
        mock,
        `SELECT id, base_version, result_version
           FROM undo_journal
          WHERE id IN (?, ?)
          ORDER BY created_at, id`,
        [first.undoJournalId, second.undoJournalId],
      ),
    ).toEqual(
      expect.arrayContaining([
        {
          id: first.undoJournalId,
          base_version: 7,
          result_version: 8,
        },
        {
          id: second.undoJournalId,
          base_version: 8,
          result_version: 9,
        },
      ]),
    );
  });
});
