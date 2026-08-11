// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  verifyChain,
  type EventForVerify,
} from "@/features/timelapse/hashChain";
import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";

async function query(
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

describe("browser mock project delete", () => {
  it("validates the typed payload, cascades the row, and dirties only on change", async () => {
    const onDatabaseDirty = vi.fn();
    const mock = await createBrowserMock({ onDatabaseDirty });
    try {
      await run(
        mock,
        `INSERT INTO projects (id, title, language)
         VALUES ('delete-project', 'Delete me', 'ja'),
                ('fail-project', 'Keep me', 'ja')`,
      );
      await run(
        mock,
        `INSERT INTO tree_nodes
          (id, project_id, node_type, title, sort_order)
         VALUES ('delete-project-scene', 'delete-project', 'scene', 'Scene', 'a0')`,
      );
      await run(
        mock,
        `INSERT INTO lint_term_dictionary
          (id, project_id, preferred, variants, severity, note, enabled,
           sort_order, created_at, updated_at)
         VALUES ('delete-project-term', 'delete-project', 'term', '[]',
                 'warning', NULL, 1, 0, 1, 1),
                ('fail-project-term', 'fail-project', 'keep', '[]',
                 'warning', NULL, 1, 0, 1, 1)`,
      );
      await run(
        mock,
        `CREATE TRIGGER fail_project_delete
         BEFORE DELETE ON projects
         WHEN OLD.id = 'fail-project'
         BEGIN
           SELECT RAISE(ABORT, 'forced project delete failure');
         END`,
      );
      onDatabaseDirty.mockClear();

      await mock.invoke("project_delete", {
        payload: { projectId: "delete-project" },
      });
      expect(
        await query(
          mock,
          `SELECT
            (SELECT COUNT(*) FROM projects WHERE id = 'delete-project') AS projects,
            (SELECT COUNT(*) FROM tree_nodes WHERE project_id = 'delete-project') AS nodes,
            (SELECT COUNT(*) FROM lint_term_dictionary
              WHERE project_id = 'delete-project') AS terms`,
        ),
      ).toEqual([{ projects: 0, nodes: 0, terms: 0 }]);
      expect(onDatabaseDirty).toHaveBeenCalledTimes(1);

      await expect(
        mock.invoke("project_delete", {
          payload: { projectId: "fail-project" },
        }),
      ).rejects.toThrow("forced project delete failure");
      expect(
        await query(
          mock,
          `SELECT
            (SELECT COUNT(*) FROM projects WHERE id = 'fail-project') AS projects,
            (SELECT COUNT(*) FROM lint_term_dictionary
              WHERE id = 'fail-project-term') AS terms`,
        ),
      ).toEqual([{ projects: 1, terms: 1 }]);
      expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
      await expect(
        mock.invoke("project_delete", {
          payload: { projectId: "delete-project" },
        }),
      ).rejects.toThrow("project 'delete-project' not found");
      expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
      await expect(
        mock.invoke("project_delete", { payload: { projectId: "" } }),
      ).rejects.toThrow("projectId must be a non-empty string");
      expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
    } finally {
      mock.close();
    }
  });
});

describe("browser mock Plot command parity", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({ onDatabaseDirty });
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('plot-scene-a', 'default-project', 'scene', 'A', 'a0'),
              ('plot-scene-b', 'default-project', 'scene', 'B', 'a1')`,
    );
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("rejects updates for missing rows without dirtying the database", async () => {
    await expect(
      mock.invoke("plot_thread_update", {
        id: "missing-thread",
        patch: { name: "missing", baseVersion: 0 },
      }),
    ).rejects.toThrow("plot thread not found");
    await expect(
      mock.invoke("plot_thread_link_update", {
        id: "missing-link",
        patch: { note: "missing", baseVersion: 0 },
      }),
    ).rejects.toThrow("plot thread link not found");
    await expect(
      mock.invoke("plot_thread_branch_update", {
        id: "missing-branch",
        patch: { atNodeId: "plot-scene-b", baseVersion: 0 },
      }),
    ).rejects.toThrow("plot thread branch not found");
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("rejects non-scene Plot anchors across create, update, restore, and move", async () => {
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('plot-folder', 'default-project', 'folder', 'Folder', 'f0')`,
    );
    for (const [id, sortOrder] of [
      ["plot-scene-type-thread-a", "b0"],
      ["plot-scene-type-thread-b", "b1"],
    ]) {
      await mock.invoke("plot_thread_create", {
        payload: {
          id,
          projectId: "default-project",
          name: id,
          color: null,
          description: null,
          sortOrder,
        },
      });
    }
    await run(
      mock,
      `INSERT INTO plot_thread_scene_links
        (id, thread_id, node_id, phase_type, note, sort_order,
         semantic_key, version, created_at, updated_at)
       VALUES ('plot-scene-type-link', 'plot-scene-type-thread-a',
               'plot-scene-a', 'turn', NULL, NULL,
               'plot-scene-type-thread-a|plot-scene-a|turn', 0, 'c1', 'u1')`,
    );
    await run(
      mock,
      `INSERT INTO plot_thread_branches
        (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
         semantic_key, version, created_at, updated_at)
       VALUES ('plot-scene-type-branch', 'default-project',
               'plot-scene-type-thread-a', 'plot-scene-type-thread-b',
               'plot-scene-a', 'branch',
               'plot-scene-type-thread-a|plot-scene-type-thread-b|plot-scene-a|branch',
               0, 'c2', 'u1')`,
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("plot_thread_link_create", {
        payload: {
          id: "plot-nonscene-link-create",
          threadId: "plot-scene-type-thread-a",
          nodeId: "plot-folder",
          phaseType: "develop",
          note: null,
          sortOrder: null,
        },
      }),
    ).rejects.toThrow("scene in the same project");
    await expect(
      mock.invoke("plot_thread_branch_create", {
        payload: {
          id: "plot-nonscene-branch-create",
          projectId: "default-project",
          fromThreadId: "plot-scene-type-thread-a",
          toThreadId: "plot-scene-type-thread-b",
          atNodeId: "plot-folder",
          kind: "merge",
        },
      }),
    ).rejects.toThrow("scene in the same project");
    await expect(
      mock.invoke("plot_thread_link_update", {
        id: "plot-scene-type-link",
        patch: { nodeId: "plot-folder", baseVersion: 0 },
      }),
    ).rejects.toThrow("owning project");
    await expect(
      mock.invoke("plot_thread_branch_update", {
        id: "plot-scene-type-branch",
        patch: { atNodeId: "plot-folder", baseVersion: 0 },
      }),
    ).rejects.toThrow("reference a scene");
    await expect(
      mock.invoke("plot_thread_restore_snapshot", {
        payload: {
          requestId: "plot-nonscene-restore",
          projectId: "default-project",
          thread: {
            id: "plot-nonscene-restored-thread",
            projectId: "default-project",
            name: "Invalid boundary",
            color: null,
            description: null,
            sortOrder: "b2",
            startNodeId: "plot-folder",
            endNodeId: null,
            version: 0,
            createdAt: "c3",
            updatedAt: "u1",
          },
          links: [],
          branches: [],
        },
      }),
    ).rejects.toThrow("boundary must reference a scene");
    await expect(
      mock.invoke("plot_thread_move_marker_bundle", {
        payload: {
          requestId: "plot-nonscene-move",
          projectId: "default-project",
          markerBefore: {
            id: "plot-scene-type-link",
            threadId: "plot-scene-type-thread-a",
            nodeId: "plot-scene-a",
            phaseType: "turn",
            note: null,
            sortOrder: null,
            semanticKey: "plot-scene-type-thread-a|plot-scene-a|turn",
            version: 0,
            createdAt: "c1",
            updatedAt: "u1",
          },
          markerAfter: {
            id: "plot-scene-type-link",
            threadId: "plot-scene-type-thread-a",
            nodeId: "plot-folder",
            phaseType: "turn",
            note: null,
            sortOrder: null,
            semanticKey: "plot-scene-type-thread-a|plot-folder|turn",
            version: 1,
            createdAt: "c1",
            updatedAt: "u2",
          },
          branchTransitions: [],
        },
      }),
    ).rejects.toThrow("must reference a scene");

    expect(
      await query(
        mock,
        `SELECT
           (SELECT node_id FROM plot_thread_scene_links
             WHERE id = 'plot-scene-type-link') AS link_node,
           (SELECT version FROM plot_thread_scene_links
             WHERE id = 'plot-scene-type-link') AS link_version,
           (SELECT at_node_id FROM plot_thread_branches
             WHERE id = 'plot-scene-type-branch') AS branch_node,
           (SELECT version FROM plot_thread_branches
             WHERE id = 'plot-scene-type-branch') AS branch_version,
           (SELECT COUNT(*) FROM idempotency_requests
             WHERE request_id LIKE 'plot-nonscene-%') AS ledgers`,
      ),
    ).toEqual([
      {
        link_node: "plot-scene-a",
        link_version: 0,
        branch_node: "plot-scene-a",
        branch_version: 0,
        ledgers: 0,
      },
    ]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("executes all six mandatory update/delete commands against persisted rows", async () => {
    for (const [id, name, sortOrder] of [
      ["plot-thread-a", "Thread A", "a0"],
      ["plot-thread-b", "Thread B", "a1"],
    ]) {
      await mock.invoke("plot_thread_create", {
        payload: {
          id,
          projectId: "default-project",
          name,
          color: null,
          description: null,
          sortOrder,
        },
      });
    }
    await mock.invoke("plot_thread_link_create", {
      payload: {
        id: "plot-link",
        threadId: "plot-thread-a",
        nodeId: "plot-scene-a",
        phaseType: "introduce",
        note: null,
        sortOrder: null,
      },
    });
    await mock.invoke("plot_thread_branch_create", {
      payload: {
        id: "plot-branch",
        projectId: "default-project",
        fromThreadId: "plot-thread-a",
        toThreadId: "plot-thread-b",
        atNodeId: "plot-scene-a",
        kind: "branch",
      },
    });

    await expect(
      mock.invoke("plot_thread_update", {
        id: "plot-thread-a",
        patch: { name: "missing token" },
      }),
    ).rejects.toThrow("baseVersion must be a non-negative integer");
    await expect(
      mock.invoke("plot_thread_link_update", {
        id: "plot-link",
        patch: { note: "missing token" },
      }),
    ).rejects.toThrow("baseVersion must be a non-negative integer");
    await expect(
      mock.invoke("plot_thread_branch_update", {
        id: "plot-branch",
        patch: { atNodeId: "plot-scene-b" },
      }),
    ).rejects.toThrow("baseVersion must be a non-negative integer");
    expect(
      await query(
        mock,
        `SELECT
           (SELECT version FROM plot_threads WHERE id = 'plot-thread-a') AS thread_version,
           (SELECT version FROM plot_thread_scene_links WHERE id = 'plot-link') AS link_version,
           (SELECT version FROM plot_thread_branches WHERE id = 'plot-branch') AS branch_version`,
      ),
    ).toEqual([{ thread_version: 0, link_version: 0, branch_version: 0 }]);

    const thread = await mock.invoke<Record<string, unknown>>(
      "plot_thread_update",
      {
        id: "plot-thread-a",
        patch: { name: "Thread A2", color: "#123456", baseVersion: 0 },
      },
    );
    expect(thread).toMatchObject({ name: "Thread A2", version: 1 });

    const link = await mock.invoke<Record<string, unknown>>(
      "plot_thread_link_update",
      {
        id: "plot-link",
        patch: {
          threadId: "plot-thread-b",
          nodeId: "plot-scene-b",
          phaseType: "turn",
          note: "moved",
          baseVersion: 0,
        },
      },
    );
    expect(link).toMatchObject({
      thread_id: "plot-thread-b",
      node_id: "plot-scene-b",
      phase_type: "turn",
      semantic_key: "plot-thread-b|plot-scene-b|turn",
      version: 1,
    });

    const branch = await mock.invoke<Record<string, unknown>>(
      "plot_thread_branch_update",
      {
        id: "plot-branch",
        patch: { atNodeId: "plot-scene-b", baseVersion: 0 },
      },
    );
    expect(branch).toMatchObject({
      at_node_id: "plot-scene-b",
      version: 1,
    });

    await expect(
      mock.invoke("plot_thread_update", {
        id: "plot-thread-a",
        patch: { name: "stale", baseVersion: 0 },
      }),
    ).rejects.toThrow("version conflict");
    await expect(
      mock.invoke("plot_thread_link_update", {
        id: "plot-link",
        patch: { note: "stale", baseVersion: 0 },
      }),
    ).rejects.toThrow("VERSION_MISMATCH");
    await expect(
      mock.invoke("plot_thread_branch_update", {
        id: "plot-branch",
        patch: { atNodeId: "plot-scene-a", baseVersion: 0 },
      }),
    ).rejects.toThrow("VERSION_MISMATCH");
    for (const [command, id] of [
      ["plot_thread_delete", "plot-thread-a"],
      ["plot_thread_link_delete", "plot-link"],
      ["plot_thread_branch_delete", "plot-branch"],
    ] as const) {
      await expect(mock.invoke(command, { id })).rejects.toThrow(
        "baseVersion must be a non-negative integer",
      );
      await expect(
        mock.invoke(command, { id, baseVersion: 0 }),
      ).rejects.toThrow("VERSION_MISMATCH");
    }
    expect(
      await query(
        mock,
        `SELECT
           (SELECT version FROM plot_threads WHERE id = 'plot-thread-a') AS thread_version,
           (SELECT version FROM plot_thread_scene_links WHERE id = 'plot-link') AS link_version,
           (SELECT version FROM plot_thread_branches WHERE id = 'plot-branch') AS branch_version`,
      ),
    ).toEqual([{ thread_version: 1, link_version: 1, branch_version: 1 }]);

    await mock.invoke("plot_thread_link_delete", {
      id: "plot-link",
      baseVersion: 1,
    });
    await mock.invoke("plot_thread_branch_delete", {
      id: "plot-branch",
      baseVersion: 1,
    });
    await mock.invoke("plot_thread_delete", {
      id: "plot-thread-a",
      baseVersion: 1,
    });
    expect(
      await query(
        mock,
        `SELECT
           (SELECT COUNT(*) FROM plot_thread_scene_links) AS links,
           (SELECT COUNT(*) FROM plot_thread_branches) AS branches,
           (SELECT COUNT(*) FROM plot_threads WHERE id = 'plot-thread-a') AS threads`,
      ),
    ).toEqual([{ links: 0, branches: 0, threads: 0 }]);
  });

  it("stores canonical keys for multiple creates and preserves legacy duplicate keys on no-op natural updates", async () => {
    for (const [id, name, sortOrder] of [
      ["plot-key-thread-a", "Thread A", "a0"],
      ["plot-key-thread-b", "Thread B", "a1"],
    ]) {
      await mock.invoke("plot_thread_create", {
        payload: {
          id,
          projectId: "default-project",
          name,
          color: null,
          description: null,
          sortOrder,
        },
      });
    }
    for (const [id, nodeId, phaseType] of [
      ["plot-key-link-a", "plot-scene-a", "introduce"],
      ["plot-key-link-b", "plot-scene-b", "develop"],
    ]) {
      await mock.invoke("plot_thread_link_create", {
        payload: {
          id,
          threadId: "plot-key-thread-a",
          nodeId,
          phaseType,
          note: null,
          sortOrder: null,
        },
      });
    }
    for (const [id, atNodeId] of [
      ["plot-key-branch-a", "plot-scene-a"],
      ["plot-key-branch-b", "plot-scene-b"],
    ]) {
      await mock.invoke("plot_thread_branch_create", {
        payload: {
          id,
          projectId: "default-project",
          fromThreadId: "plot-key-thread-a",
          toThreadId: "plot-key-thread-b",
          atNodeId,
          kind: "branch",
        },
      });
    }
    expect(
      await query(
        mock,
        `SELECT id, semantic_key, version
           FROM plot_thread_scene_links
          WHERE id LIKE 'plot-key-link-%' ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "plot-key-link-a",
        semantic_key: "plot-key-thread-a|plot-scene-a|introduce",
        version: 0,
      },
      {
        id: "plot-key-link-b",
        semantic_key: "plot-key-thread-a|plot-scene-b|develop",
        version: 0,
      },
    ]);
    expect(
      await query(
        mock,
        `SELECT id, semantic_key, version
           FROM plot_thread_branches
          WHERE id LIKE 'plot-key-branch-%' ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "plot-key-branch-a",
        semantic_key: "plot-key-thread-a|plot-key-thread-b|plot-scene-a|branch",
        version: 0,
      },
      {
        id: "plot-key-branch-b",
        semantic_key: "plot-key-thread-a|plot-key-thread-b|plot-scene-b|branch",
        version: 0,
      },
    ]);

    await run(
      mock,
      `INSERT INTO plot_thread_scene_links
        (id, thread_id, node_id, phase_type, note, sort_order,
         semantic_key, version)
       VALUES (
         'plot-key-link-dup', 'plot-key-thread-a', 'plot-scene-a',
         'introduce', NULL, NULL,
         'plot-key-thread-a|plot-scene-a|introduce#dup:plot-key-link-dup', 0
       )`,
    );
    await run(
      mock,
      `INSERT INTO plot_thread_branches
        (id, project_id, from_thread_id, to_thread_id, at_node_id, kind,
         semantic_key, version)
       VALUES (
         'plot-key-branch-dup', 'default-project', 'plot-key-thread-a',
         'plot-key-thread-b', 'plot-scene-a', 'branch',
         'plot-key-thread-a|plot-key-thread-b|plot-scene-a|branch#dup:plot-key-branch-dup',
         0
       )`,
    );
    await mock.invoke("plot_thread_link_update", {
      id: "plot-key-link-dup",
      patch: { note: "metadata only", baseVersion: 0 },
    });
    await mock.invoke("plot_thread_branch_update", {
      id: "plot-key-branch-dup",
      patch: { atNodeId: "plot-scene-a", baseVersion: 0 },
    });
    expect(
      await query(
        mock,
        `SELECT semantic_key, version FROM plot_thread_scene_links
          WHERE id = 'plot-key-link-dup'`,
      ),
    ).toEqual([
      {
        semantic_key:
          "plot-key-thread-a|plot-scene-a|introduce#dup:plot-key-link-dup",
        version: 1,
      },
    ]);
    expect(
      await query(
        mock,
        `SELECT semantic_key, version FROM plot_thread_branches
          WHERE id = 'plot-key-branch-dup'`,
      ),
    ).toEqual([
      {
        semantic_key:
          "plot-key-thread-a|plot-key-thread-b|plot-scene-a|branch#dup:plot-key-branch-dup",
        version: 1,
      },
    ]);

    await expect(
      mock.invoke("plot_thread_link_update", {
        id: "plot-key-link-dup",
        patch: {
          nodeId: "plot-scene-b",
          phaseType: "develop",
          baseVersion: 1,
        },
      }),
    ).rejects.toThrow();
    await expect(
      mock.invoke("plot_thread_branch_update", {
        id: "plot-key-branch-dup",
        patch: { atNodeId: "plot-scene-b", baseVersion: 1 },
      }),
    ).rejects.toThrow();
    expect(
      await query(
        mock,
        `SELECT
           (SELECT semantic_key FROM plot_thread_scene_links
             WHERE id = 'plot-key-link-dup') AS link_key,
           (SELECT semantic_key FROM plot_thread_branches
             WHERE id = 'plot-key-branch-dup') AS branch_key`,
      ),
    ).toEqual([
      {
        link_key:
          "plot-key-thread-a|plot-scene-a|introduce#dup:plot-key-link-dup",
        branch_key:
          "plot-key-thread-a|plot-key-thread-b|plot-scene-a|branch#dup:plot-key-branch-dup",
      },
    ]);
  });

  it("rejects moving both link endpoints into a different project atomically", async () => {
    await run(
      mock,
      `INSERT INTO projects (id, title, language)
       VALUES ('plot-foreign-project', 'Foreign', 'ja')`,
    );
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('plot-foreign-scene', 'plot-foreign-project', 'scene',
               'Foreign', 'a0')`,
    );
    for (const [id, projectId] of [
      ["plot-owner-thread", "default-project"],
      ["plot-foreign-thread", "plot-foreign-project"],
    ]) {
      await mock.invoke("plot_thread_create", {
        payload: {
          id,
          projectId,
          name: id,
          color: null,
          description: null,
          sortOrder: "a0",
        },
      });
    }
    await mock.invoke("plot_thread_link_create", {
      payload: {
        id: "plot-owner-link",
        threadId: "plot-owner-thread",
        nodeId: "plot-scene-a",
        phaseType: "introduce",
        note: "owned",
        sortOrder: null,
      },
    });
    const before = await query(
      mock,
      `SELECT thread_id, node_id, phase_type, note, semantic_key, version
         FROM plot_thread_scene_links WHERE id = 'plot-owner-link'`,
    );

    await expect(
      mock.invoke("plot_thread_link_update", {
        id: "plot-owner-link",
        patch: {
          threadId: "plot-foreign-thread",
          nodeId: "plot-foreign-scene",
          phaseType: "develop",
          note: "must roll back",
          baseVersion: 0,
        },
      }),
    ).rejects.toThrow("must stay within its owning project");
    expect(
      await query(
        mock,
        `SELECT thread_id, node_id, phase_type, note, semantic_key, version
           FROM plot_thread_scene_links WHERE id = 'plot-owner-link'`,
      ),
    ).toEqual(before);
  });
});

describe("browser mock Foreshadow command parity", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = await createBrowserMock({ onDatabaseDirty });
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('fs-scene-a', 'default-project', 'scene', 'A', 'a0'),
              ('fs-scene-b', 'default-project', 'scene', 'B', 'a1')`,
    );
    const now = "2026-08-11T00:00:00.000Z";
    await run(
      mock,
      `INSERT INTO codex_entries
        (id, project_id, type, name, content, created_at, updated_at)
       VALUES ('fs-codex', 'default-project', 'character', 'Linked', '{}', ?, ?)`,
      [now, now],
    );
    onDatabaseDirty.mockClear();
  });

  afterEach(() => mock.close());

  it("does not mark an anchor save dirty when it executes no mutation", async () => {
    mock.close();
    const onDatabaseDirty = vi.fn();
    mock = await createBrowserMock({ onDatabaseDirty });
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('fs-empty-scene', 'default-project', 'scene', 'Empty', 'a0')`,
    );
    onDatabaseDirty.mockClear();

    for (const docContentSize of [12, 2]) {
      await mock.invoke("foreshadow_save_anchors_for_scene", {
        sceneId: "fs-empty-scene",
        setups: [],
        payoffs: [],
        baseVersions: {},
        docContentSize,
      });
    }

    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("persists CRUD, setup/orphan, Codex link, dirty, strength, and anchor commands", async () => {
    await mock.invoke("foreshadow_create", {
      payload: {
        id: "fs-plain",
        projectId: "default-project",
        title: "Plain",
        intent: null,
        notes: null,
        payoffSceneId: null,
        payoffFromPos: null,
        payoffToPos: null,
        payoffConfirmed: false,
        abandoned: false,
        secret: false,
        loadBearing: null,
        codexLinkDirtyAt: null,
      },
    });
    expect(
      await query(
        mock,
        "SELECT version FROM foreshadows WHERE id = 'fs-plain'",
      ),
    ).toEqual([{ version: 0 }]);
    await mock.invoke("foreshadow_update", {
      id: "fs-plain",
      patch: { baseVersion: 0, title: "Updated", loadBearing: "critical" },
    });
    expect(
      await query(
        mock,
        "SELECT version FROM foreshadows WHERE id = 'fs-plain'",
      ),
    ).toEqual([{ version: 1 }]);
    await mock.invoke("foreshadow_update", {
      id: "fs-plain",
      patch: { baseVersion: 1 },
    });
    expect(
      await query(
        mock,
        "SELECT version FROM foreshadows WHERE id = 'fs-plain'",
      ),
    ).toEqual([{ version: 1 }]);
    await mock.invoke("foreshadow_setup_create_ai", {
      id: "fs-setup",
      foreshadowId: "fs-plain",
      baseVersion: 1,
      sceneId: "fs-scene-a",
      fromPos: 1,
      toPos: 3,
      kind: "designated_existing",
      strength: "subtle",
      aiStrength: null,
      attribution: "human",
      aiRationale: null,
      aiReasoning: null,
      lastEvaluatedAt: null,
    });
    expect(
      await mock.invoke<Record<string, unknown>>("foreshadow_get_setup", {
        setupId: "fs-setup",
      }),
    ).toMatchObject({
      id: "fs-setup",
      foreshadow_id: "fs-plain",
      strength: "subtle",
    });
    await mock.invoke("foreshadow_update_setup", {
      id: "fs-setup",
      patch: { baseVersion: 2, aiStrength: "moderate", isOrphan: true },
    });
    await mock.invoke("foreshadow_set_setup_strength", {
      setupId: "fs-setup",
      strength: "overt",
      baseVersion: 3,
    });
    await mock.invoke("foreshadow_resolve_orphan", {
      payload: {
        setupId: "fs-setup",
        action: "reanchor",
        baseVersion: 4,
        sceneId: "fs-scene-b",
        fromPos: 2,
        toPos: 5,
      },
    });
    const reinserted = await mock.invoke<{ setupId: string | null }>(
      "foreshadow_resolve_orphan",
      {
        payload: {
          setupId: "fs-setup",
          action: "reinsert",
          baseVersion: 5,
          sceneId: "fs-scene-a",
          fromPos: 6,
          toPos: 8,
        },
      },
    );
    const reinsertedId = reinserted.setupId;
    expect(reinsertedId).toBeTruthy();

    await mock.invoke("foreshadow_link_codex", {
      foreshadowId: "fs-plain",
      codexId: "fs-codex",
      baseVersion: 6,
    });
    await mock.invoke("foreshadow_mark_linked_codex_dirty", {
      projectId: "default-project",
      codexEntryId: "fs-codex",
    });
    expect(
      await query(
        mock,
        `SELECT codex_link_dirty_at, version
           FROM foreshadows WHERE id = 'fs-plain'`,
      ),
    ).toEqual([{ codex_link_dirty_at: expect.any(Number), version: 8 }]);

    await mock.invoke("foreshadow_save_anchors_for_scene", {
      sceneId: "fs-scene-a",
      setups: [
        {
          id: "fs-saved-anchor",
          foreshadowId: "fs-plain",
          baseVersion: 8,
          sceneId: "fs-scene-a",
          fromPos: 10,
          toPos: 12,
        },
      ],
      payoffs: [
        {
          foreshadowId: "fs-plain",
          baseVersion: 8,
          sceneId: "fs-scene-a",
          fromPos: 13,
          toPos: 15,
        },
      ],
      baseVersions: { "fs-plain": 8 },
      docContentSize: 20,
    });
    expect(
      await query(
        mock,
        `SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
           FROM foreshadows WHERE id = 'fs-plain'`,
      ),
    ).toEqual([
      {
        payoff_scene_id: "fs-scene-a",
        payoff_from_pos: 13,
        payoff_to_pos: 15,
        version: 9,
      },
    ]);
    const setupRows = await query(
      mock,
      `SELECT id, is_orphan FROM foreshadow_setups
        WHERE scene_id = 'fs-scene-a' ORDER BY id`,
    );
    expect(setupRows).toHaveLength(2);
    expect(setupRows).toEqual(
      expect.arrayContaining([
        { id: "fs-saved-anchor", is_orphan: 0 },
        { id: reinsertedId, is_orphan: 1 },
      ]),
    );

    await mock.invoke("foreshadow_unlink_codex", {
      foreshadowId: "fs-plain",
      codexId: "fs-codex",
      baseVersion: 9,
    });
    await mock.invoke("foreshadow_delete", {
      id: "fs-plain",
      projectId: "default-project",
      sessionId: "fs-domain-parity",
      baseVersion: 10,
    });
    expect(
      await query(mock, "SELECT id FROM foreshadows WHERE id = 'fs-plain'"),
    ).toEqual([]);
  });

  it("rejects malformed foreshadow booleans and OCC tokens before mutation", async () => {
    await mock.invoke("foreshadow_create", {
      payload: {
        id: "fs-typed-guard",
        projectId: "default-project",
        title: "Typed",
        payoffConfirmed: false,
        abandoned: false,
        secret: true,
      },
    });
    const before = await query(
      mock,
      `SELECT title, payoff_confirmed, version
         FROM foreshadows WHERE id = 'fs-typed-guard'`,
    );

    await expect(
      mock.invoke("foreshadow_update", {
        id: "fs-typed-guard",
        patch: { baseVersion: 0, payoffConfirmed: "false" },
      }),
    ).rejects.toThrow("must be a boolean");
    await expect(
      mock.invoke("foreshadow_update", {
        id: "fs-typed-guard",
        patch: { baseVersion: "0", title: "Rejected" },
      }),
    ).rejects.toThrow("baseVersion");
    await expect(
      mock.invoke("agent_foreshadow_update", {
        payload: {
          projectId: "default-project",
          sessionId: "fs-typed-session",
          foreshadowId: "fs-typed-guard",
          baseVersion: 0,
          abandoned: "false",
        },
      }),
    ).rejects.toThrow("must be a boolean");
    expect(
      await query(
        mock,
        `SELECT title, payoff_confirmed, version
           FROM foreshadows WHERE id = 'fs-typed-guard'`,
      ),
    ).toEqual(before);
  });

  it("rejects a same-project folder as a payoff scene without persistence", async () => {
    await mock.invoke("tree_node_create", {
      payload: {
        id: "fs-payoff-folder",
        projectId: "default-project",
        parentId: null,
        nodeType: "folder",
        title: "Not a scene",
        sortOrder: "a2",
      },
    });
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("foreshadow_create", {
        payload: {
          id: "fs-folder-payoff",
          projectId: "default-project",
          title: "Invalid folder payoff",
          payoffSceneId: "fs-payoff-folder",
          payoffFromPos: 1,
          payoffToPos: 3,
        },
      }),
    ).rejects.toThrow("existing same project scene");

    expect(
      await query(
        mock,
        "SELECT id FROM foreshadows WHERE id = 'fs-folder-payoff'",
      ),
    ).toEqual([]);
    expect(
      await query(
        mock,
        `SELECT COUNT(*) AS count FROM idempotency_requests
          WHERE domain = 'foreshadow_create'
            AND request_id = 'fs-folder-payoff'`,
      ),
    ).toEqual([{ count: 0 }]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("rejects a same-project note payoff update without row, history, or dirty changes", async () => {
    await mock.invoke("tree_node_create", {
      payload: {
        id: "fs-payoff-note",
        projectId: "default-project",
        parentId: null,
        nodeType: "note",
        title: "Not a scene",
        sortOrder: "a2",
      },
    });
    await mock.invoke("foreshadow_create", {
      payload: {
        id: "fs-note-payoff-update",
        projectId: "default-project",
        title: "Valid before update",
        payoffSceneId: "fs-scene-a",
        payoffFromPos: 2,
        payoffToPos: 5,
      },
    });
    const rowBefore = await query(
      mock,
      `SELECT title, payoff_scene_id, payoff_from_pos, payoff_to_pos,
              version, updated_at
         FROM foreshadows WHERE id = 'fs-note-payoff-update'`,
    );
    const historyBefore = await query(
      mock,
      `SELECT
        (SELECT COUNT(*) FROM idempotency_requests) AS idempotency_requests,
        (SELECT COUNT(*) FROM undo_journal) AS undo_journals,
        (SELECT COUNT(*) FROM change_events) AS change_events`,
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("foreshadow_update", {
        id: "fs-note-payoff-update",
        patch: { baseVersion: 0, payoffSceneId: "fs-payoff-note" },
      }),
    ).rejects.toThrow("existing same project scene");

    expect(
      await query(
        mock,
        `SELECT title, payoff_scene_id, payoff_from_pos, payoff_to_pos,
                version, updated_at
           FROM foreshadows WHERE id = 'fs-note-payoff-update'`,
      ),
    ).toEqual(rowBefore);
    expect(
      await query(
        mock,
        `SELECT
          (SELECT COUNT(*) FROM idempotency_requests) AS idempotency_requests,
          (SELECT COUNT(*) FROM undo_journal) AS undo_journals,
          (SELECT COUNT(*) FROM change_events) AS change_events`,
      ),
    ).toEqual(historyBefore);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("accepts scene payoff anchors on create and effective-tuple update", async () => {
    await mock.invoke("foreshadow_create", {
      payload: {
        id: "fs-valid-payoff-scenes",
        projectId: "default-project",
        title: "Valid scene payoff",
        payoffSceneId: "fs-scene-a",
        payoffFromPos: 1,
        payoffToPos: 3,
      },
    });

    await mock.invoke("foreshadow_update", {
      id: "fs-valid-payoff-scenes",
      patch: {
        baseVersion: 0,
        payoffSceneId: "fs-scene-b",
        payoffFromPos: 4,
        payoffToPos: 8,
      },
    });

    expect(
      await query(
        mock,
        `SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
           FROM foreshadows WHERE id = 'fs-valid-payoff-scenes'`,
      ),
    ).toEqual([
      {
        payoff_scene_id: "fs-scene-b",
        payoff_from_pos: 4,
        payoff_to_pos: 8,
        version: 1,
      },
    ]);
  });

  it("guards setup identity, preserves duplicate suffixes, and rolls back stale reinserts", async () => {
    for (const [id, title] of [
      ["fs-owner-a", "Owner A"],
      ["fs-owner-b", "Owner B"],
    ]) {
      await mock.invoke("foreshadow_create", {
        payload: {
          id,
          projectId: "default-project",
          title,
          intent: null,
          notes: null,
          payoffSceneId: null,
          payoffFromPos: null,
          payoffToPos: null,
          payoffConfirmed: false,
          abandoned: false,
          secret: false,
          loadBearing: null,
          codexLinkDirtyAt: null,
        },
      });
    }
    const createSetup = (id: string, sceneId: string, baseVersion: number) =>
      mock.invoke("foreshadow_setup_create_ai", {
        id,
        foreshadowId: "fs-owner-a",
        baseVersion,
        sceneId,
        fromPos: 1,
        toPos: 3,
        kind: "designated_existing",
        strength: null,
        aiStrength: null,
        attribution: "human",
        aiRationale: null,
        aiReasoning: null,
        lastEvaluatedAt: null,
      });
    await createSetup("fs-identity-guard", "fs-scene-a", 0);
    const identityBefore = await query(
      mock,
      `SELECT foreshadow_id, scene_id, from_pos, to_pos, semantic_key
         FROM foreshadow_setups WHERE id = 'fs-identity-guard'`,
    );
    await expect(
      mock.invoke("foreshadow_setup_create_ai", {
        id: "fs-identity-guard",
        foreshadowId: "fs-owner-a",
        baseVersion: 1,
        sceneId: "fs-scene-b",
        fromPos: 4,
        toPos: 6,
        kind: "designated_existing",
        attribution: "human",
      }),
    ).rejects.toThrow("owner or scene conflicts");
    await expect(
      mock.invoke("foreshadow_setup_create_ai", {
        id: "fs-identity-guard",
        foreshadowId: "fs-owner-b",
        baseVersion: 0,
        sceneId: "fs-scene-a",
        fromPos: 4,
        toPos: 6,
        kind: "designated_existing",
        attribution: "human",
      }),
    ).rejects.toThrow("owner or scene conflicts");
    expect(
      await query(
        mock,
        `SELECT foreshadow_id, scene_id, from_pos, to_pos, semantic_key
           FROM foreshadow_setups WHERE id = 'fs-identity-guard'`,
      ),
    ).toEqual(identityBefore);

    await run(
      mock,
      `UPDATE foreshadow_setups
          SET semantic_key = semantic_key || '#dup:' || id
        WHERE id = 'fs-identity-guard'`,
    );
    await mock.invoke("foreshadow_save_anchors_for_scene", {
      sceneId: "fs-scene-b",
      setups: [
        {
          id: "fs-identity-guard",
          foreshadowId: "fs-owner-a",
          baseVersion: 1,
          sceneId: "fs-scene-b",
          fromPos: 4,
          toPos: 7,
        },
      ],
      payoffs: [],
      baseVersions: { "fs-owner-a": 1 },
      docContentSize: 10,
    });
    const moved = await query(
      mock,
      `SELECT foreshadow_id, scene_id, from_pos, to_pos, semantic_key
         FROM foreshadow_setups WHERE id = 'fs-identity-guard'`,
    );
    expect(moved).toEqual([
      {
        foreshadow_id: "fs-owner-a",
        scene_id: "fs-scene-b",
        from_pos: 4,
        to_pos: 7,
        semantic_key: "fs-owner-a|fs-scene-b|4|7#dup:fs-identity-guard",
      },
    ]);
    await expect(
      mock.invoke("foreshadow_save_anchors_for_scene", {
        sceneId: "fs-scene-b",
        setups: [
          {
            id: "fs-identity-guard",
            foreshadowId: "fs-owner-b",
            baseVersion: 0,
            sceneId: "fs-scene-b",
            fromPos: 8,
            toPos: 9,
          },
        ],
        payoffs: [],
        baseVersions: { "fs-owner-b": 0 },
        docContentSize: 10,
      }),
    ).rejects.toThrow("belongs to a different foreshadow");
    expect(
      await query(
        mock,
        `SELECT foreshadow_id, scene_id, from_pos, to_pos, semantic_key
           FROM foreshadow_setups WHERE id = 'fs-identity-guard'`,
      ),
    ).toEqual(moved);

    await createSetup("fs-reinsert-guard", "fs-scene-a", 2);
    await run(
      mock,
      `CREATE TRIGGER ignore_guarded_setup_delete
       BEFORE DELETE ON foreshadow_setups
       WHEN OLD.id = 'fs-reinsert-guard'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    );
    const beforeStaleReinsert = await query(
      mock,
      "SELECT * FROM foreshadow_setups WHERE id = 'fs-reinsert-guard'",
    );
    await expect(
      mock.invoke("foreshadow_resolve_orphan", {
        payload: {
          setupId: "fs-reinsert-guard",
          action: "reinsert",
          baseVersion: 3,
          sceneId: "fs-scene-b",
          fromPos: 5,
          toPos: 8,
        },
      }),
    ).rejects.toThrow("vanished during reinsert");
    expect(
      await query(
        mock,
        "SELECT * FROM foreshadow_setups WHERE id = 'fs-reinsert-guard'",
      ),
    ).toEqual(beforeStaleReinsert);
    await expect(
      mock.invoke("foreshadow_resolve_orphan", {
        payload: {
          setupId: "fs-missing-setup",
          action: "reinsert",
          baseVersion: 3,
          sceneId: "fs-scene-b",
          fromPos: 5,
          toPos: 8,
        },
      }),
    ).resolves.toEqual({ setupId: null, foreshadow: null });
    expect(
      await query(
        mock,
        `SELECT id FROM foreshadow_setups
          WHERE foreshadow_id = 'fs-owner-a' ORDER BY id`,
      ),
    ).toEqual([{ id: "fs-identity-guard" }, { id: "fs-reinsert-guard" }]);
  });

  it("rejects non-scene setup anchors without mutation or dirty state", async () => {
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('fs-anchor-folder', 'default-project', 'folder', 'Folder', 'a2')`,
    );
    await mock.invoke("foreshadow_create", {
      payload: {
        id: "fs-scene-only",
        projectId: "default-project",
        title: "Scene only",
        payoffConfirmed: false,
        abandoned: false,
        secret: true,
      },
    });
    await mock.invoke("foreshadow_setup_create_ai", {
      id: "fs-scene-only-setup",
      foreshadowId: "fs-scene-only",
      baseVersion: 0,
      sceneId: "fs-scene-a",
      fromPos: 1,
      toPos: 3,
      kind: "designated_existing",
      attribution: "human",
    });
    const setupBefore = await query(
      mock,
      `SELECT scene_id, from_pos, to_pos, semantic_key
         FROM foreshadow_setups WHERE id = 'fs-scene-only-setup'`,
    );
    const rootBefore = await query(
      mock,
      `SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
         FROM foreshadows WHERE id = 'fs-scene-only'`,
    );
    onDatabaseDirty.mockClear();

    await expect(
      mock.invoke("foreshadow_setup_create_ai", {
        id: "fs-folder-setup",
        foreshadowId: "fs-scene-only",
        baseVersion: 1,
        sceneId: "fs-anchor-folder",
        fromPos: 1,
        toPos: 3,
        kind: "designated_existing",
        attribution: "human",
      }),
    ).rejects.toThrow();
    for (const action of ["reanchor", "reinsert"]) {
      await expect(
        mock.invoke("foreshadow_resolve_orphan", {
          payload: {
            setupId: "fs-scene-only-setup",
            action,
            baseVersion: 1,
            sceneId: "fs-anchor-folder",
            fromPos: 4,
            toPos: 6,
          },
        }),
      ).rejects.toThrow();
    }
    await expect(
      mock.invoke("foreshadow_save_anchors_for_scene", {
        sceneId: "fs-anchor-folder",
        setups: [
          {
            id: "fs-folder-saved",
            foreshadowId: "fs-scene-only",
            baseVersion: 1,
            sceneId: "fs-anchor-folder",
            fromPos: 1,
            toPos: 3,
          },
        ],
        payoffs: [
          {
            foreshadowId: "fs-scene-only",
            baseVersion: 1,
            sceneId: "fs-anchor-folder",
            fromPos: 4,
            toPos: 6,
          },
        ],
        baseVersions: { "fs-scene-only": 1 },
        docContentSize: 10,
      }),
    ).rejects.toThrow("not found");

    expect(
      await query(
        mock,
        `SELECT scene_id, from_pos, to_pos, semantic_key
           FROM foreshadow_setups WHERE id = 'fs-scene-only-setup'`,
      ),
    ).toEqual(setupBefore);
    expect(
      await query(
        mock,
        `SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version
           FROM foreshadows WHERE id = 'fs-scene-only'`,
      ),
    ).toEqual(rootBefore);
    expect(
      await query(
        mock,
        "SELECT id FROM foreshadow_setups WHERE id = 'fs-folder-setup'",
      ),
    ).toEqual([]);
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("writes real agent receipts and replays create/update journals", async () => {
    const created = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_foreshadow_create", {
      payload: {
        requestId: "agent-fs-create-request",
        foreshadowId: "agent-fs",
        projectId: "default-project",
        sessionId: "agent-fs-session",
        title: "Agent before",
        intent: null,
        notes: null,
        loadBearing: null,
        secret: true,
      },
    });
    expect(created.undoJournalId).toBe("agent-fs-create-request");
    expect(created.version).toBe(0);
    const updated = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_foreshadow_update", {
      payload: {
        projectId: "default-project",
        sessionId: "agent-fs-session",
        foreshadowId: "agent-fs",
        baseVersion: 0,
        title: "Agent after",
        intent: null,
        notes: null,
        loadBearing: "supporting",
        payoffConfirmed: null,
        abandoned: null,
        secret: null,
      },
    });
    expect(updated.version).toBe(1);
    expect(
      await query(
        mock,
        `SELECT COUNT(*) AS count FROM undo_journal
          WHERE entity_kind = 'foreshadow' AND entity_id = 'agent-fs'`,
      ),
    ).toEqual([{ count: 2 }]);

    const replay = async (
      requestId: string,
      journalId: string,
      direction: "undo" | "redo",
    ) =>
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId,
          projectId: "default-project",
          sessionId: "agent-fs-session",
          journalId,
          direction,
        },
      });
    await replay("agent-fs-update-undo", updated.undoJournalId, "undo");
    expect(
      await query(
        mock,
        "SELECT title, version FROM foreshadows WHERE id = 'agent-fs'",
      ),
    ).toEqual([{ title: "Agent before", version: 2 }]);
    const afterUndo = await query(
      mock,
      `SELECT title, version FROM foreshadows WHERE id = 'agent-fs'`,
    );
    await expect(
      mock.invoke("agent_foreshadow_update", {
        payload: {
          projectId: "default-project",
          sessionId: "agent-fs-session",
          foreshadowId: "agent-fs",
          baseVersion: 0,
          title: "ABA must stay stale",
        },
      }),
    ).rejects.toThrow("version conflict");
    expect(
      await query(
        mock,
        "SELECT title, version FROM foreshadows WHERE id = 'agent-fs'",
      ),
    ).toEqual(afterUndo);
    await replay("agent-fs-create-undo", created.undoJournalId, "undo");
    expect(
      await query(mock, "SELECT id FROM foreshadows WHERE id = 'agent-fs'"),
    ).toEqual([]);
    await replay("agent-fs-create-redo", created.undoJournalId, "redo");
    expect(
      await query(
        mock,
        "SELECT version FROM foreshadows WHERE id = 'agent-fs'",
      ),
    ).toEqual([{ version: 3 }]);
    await replay("agent-fs-update-redo", updated.undoJournalId, "redo");
    expect(
      await query(
        mock,
        `SELECT title, load_bearing, version
           FROM foreshadows WHERE id = 'agent-fs'`,
      ),
    ).toEqual([
      { title: "Agent after", load_bearing: "supporting", version: 4 },
    ]);
    await replay("agent-fs-update-undo-repeat", updated.undoJournalId, "undo");
    expect(
      await query(
        mock,
        "SELECT title, version FROM foreshadows WHERE id = 'agent-fs'",
      ),
    ).toEqual([{ title: "Agent before", version: 5 }]);
    await replay("agent-fs-update-redo-repeat", updated.undoJournalId, "redo");
    expect(
      await query(
        mock,
        "SELECT title, version FROM foreshadows WHERE id = 'agent-fs'",
      ),
    ).toEqual([{ title: "Agent after", version: 6 }]);
  });

  it("replays an explicit foreshadow create receipt while undone", async () => {
    const payload = {
      requestId: "agent-fs-deleted-replay-request",
      foreshadowId: "agent-fs-deleted-replay",
      projectId: "default-project",
      sessionId: "agent-fs-session",
      title: "Deleted replay",
      intent: null,
      notes: null,
      loadBearing: null,
      secret: true,
    };
    const first = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_foreshadow_create", { payload });
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "agent-fs-deleted-replay-undo",
        projectId: "default-project",
        sessionId: "agent-fs-session",
        journalId: first.undoJournalId,
        direction: "undo",
      },
    });

    await expect(
      mock.invoke("agent_foreshadow_create", {
        payload: { ...payload, sessionId: "agent-fs-retry-session" },
      }),
    ).resolves.toEqual(first);
    expect(
      await query(
        mock,
        "SELECT id FROM foreshadows WHERE id = 'agent-fs-deleted-replay'",
      ),
    ).toEqual([]);
    expect(
      await query(
        mock,
        `SELECT COUNT(*) AS count FROM undo_journal
          WHERE id = 'agent-fs-deleted-replay-request'`,
      ),
    ).toEqual([{ count: 1 }]);
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "agent-fs-deleted-replay-redo",
        projectId: "default-project",
        sessionId: "agent-fs-session",
        journalId: first.undoJournalId,
        direction: "redo",
      },
    });
    expect(
      await query(
        mock,
        "SELECT version FROM foreshadows WHERE id = 'agent-fs-deleted-replay'",
      ),
    ).toEqual([{ version: 1 }]);
  });
});

describe("browser mock scene-event batch tracked write", () => {
  let mock: PersistentBrowserMock;

  beforeEach(async () => {
    mock = await createBrowserMock();
    await run(
      mock,
      `INSERT INTO projects (id, title, language) VALUES ('foreign-project', 'Foreign', 'ja')`,
    );
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('batch-existing', 'default-project', 'scene', 'Existing', 'a0'),
              ('batch-new', 'default-project', 'scene', 'New', 'a1'),
              ('batch-fail', 'default-project', 'scene', 'Fail', 'a2'),
              ('batch-later', 'default-project', 'scene', 'Later', 'a3'),
              ('batch-foreign', 'foreign-project', 'scene', 'Foreign', 'a0')`,
    );
    const now = "2026-08-11T00:00:00.000Z";
    await run(
      mock,
      `INSERT INTO events
        (id, project_id, title, ordinal, version, created_at, updated_at)
       VALUES ('batch-event', 'default-project', 'Batch', 'a0', 7, ?, ?),
              ('batch-fail-event', 'default-project', 'Fail', 'a1', 2, ?, ?)`,
      [now, now, now, now],
    );
    await run(
      mock,
      `INSERT INTO scene_events (scene_id, event_id)
       VALUES ('batch-existing', 'batch-event')`,
    );
  });

  afterEach(() => mock.close());

  it("accepts 10,000 raw ids after dedupe and rejects 10,001 before writes", async () => {
    const boundaryReceipt = await mock.invoke<{
      entityId: string;
      undoJournalId: string;
    }>("agent_scene_event_link_batch", {
      payload: {
        requestId: "browser-batch-boundary",
        projectId: "default-project",
        sessionId: "batch-session",
        eventId: "batch-event",
        sceneIds: Array<string>(10_000).fill("batch-existing"),
      },
    });
    expect(boundaryReceipt).toMatchObject({
      entityId: "batch-event",
      undoJournalId: "browser-batch-boundary",
    });
    expect(
      await query(
        mock,
        `SELECT before_json, after_json
           FROM undo_journal WHERE id = 'browser-batch-boundary'`,
      ),
    ).toEqual([
      {
        before_json: JSON.stringify({
          snapshotKind: "sceneEventLinkBatch",
          eventId: "batch-event",
          sceneIds: [],
          linked: false,
        }),
        after_json: JSON.stringify({
          snapshotKind: "sceneEventLinkBatch",
          eventId: "batch-event",
          sceneIds: [],
          linked: true,
        }),
      },
    ]);

    const beforeReject = await query(
      mock,
      `SELECT
        (SELECT COUNT(*) FROM scene_events) AS links,
        (SELECT COUNT(*) FROM undo_journal) AS journals,
        (SELECT COUNT(*) FROM change_events) AS changes,
        (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
    );
    await expect(
      mock.invoke("agent_scene_event_link_batch", {
        payload: {
          requestId: "browser-batch-over-limit",
          projectId: "default-project",
          sessionId: "batch-session",
          eventId: "batch-event",
          sceneIds: Array<string>(10_001).fill("batch-existing"),
        },
      }),
    ).rejects.toThrow("at most 10000 ids");
    await expect(
      mock.invoke("agent_scene_event_link_batch", {
        payload: {
          requestId: "browser-batch-non-string",
          projectId: "default-project",
          sessionId: "batch-session",
          eventId: "batch-event",
          sceneIds: ["batch-existing", 42],
        },
      }),
    ).rejects.toThrow("sceneIds[1] must be a non-empty string");
    expect(
      await query(
        mock,
        `SELECT
          (SELECT COUNT(*) FROM scene_events) AS links,
          (SELECT COUNT(*) FROM undo_journal) AS journals,
          (SELECT COUNT(*) FROM change_events) AS changes,
          (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
      ),
    ).toEqual(beforeReject);
  });

  it("dedupes, journals mixed state once, replays exactly, and rejects XPROJ atomically", async () => {
    const receipt = await mock.invoke<{
      entityId: string;
      version: number;
      changeEventUid: string;
      undoJournalId: string;
    }>("agent_scene_event_link_batch", {
      payload: {
        requestId: "browser-batch-request",
        projectId: "default-project",
        sessionId: "batch-session",
        surface: "manual",
        eventId: "batch-event",
        sceneIds: ["batch-new", "batch-existing", "batch-new"],
      },
    });
    expect(receipt).toMatchObject({
      entityId: "batch-event",
      version: 7,
      undoJournalId: "browser-batch-request",
    });
    const journal = (
      await query(
        mock,
        `SELECT before_json, after_json FROM undo_journal WHERE id = ?`,
        [receipt.undoJournalId],
      )
    )[0];
    expect(JSON.parse(String(journal.before_json))).toEqual({
      snapshotKind: "sceneEventLinkBatch",
      eventId: "batch-event",
      sceneIds: ["batch-new"],
      linked: false,
    });
    const afterSnapshot = JSON.parse(String(journal.after_json)) as {
      snapshotKind: string;
      eventId: string;
      sceneIds: string[];
      linked: boolean;
      incarnationTokens: Record<string, string>;
    };
    expect(afterSnapshot).toMatchObject({
      snapshotKind: "sceneEventLinkBatch",
      eventId: "batch-event",
      sceneIds: ["batch-new"],
      linked: true,
    });
    expect(afterSnapshot.incarnationTokens["batch-new"]).toMatch(
      /^[0-9a-f-]{36}$/,
    );

    const exactReplay = await mock.invoke("agent_scene_event_link_batch", {
      payload: {
        requestId: "browser-batch-request",
        projectId: "default-project",
        sessionId: "different-session",
        surface: "in-app-agent",
        eventId: "batch-event",
        sceneIds: ["batch-existing", "batch-new"],
      },
    });
    expect(exactReplay).toEqual(receipt);
    expect(
      await query(
        mock,
        `SELECT
          (SELECT COUNT(*) FROM undo_journal WHERE id = 'browser-batch-request') AS journals,
          (SELECT COUNT(*) FROM change_events WHERE event_uid = ?) AS changes`,
        [receipt.changeEventUid],
      ),
    ).toEqual([{ journals: 1, changes: 1 }]);

    await run(
      mock,
      "DELETE FROM scene_events WHERE scene_id = 'batch-existing' AND event_id = 'batch-event'",
    );
    await run(
      mock,
      "INSERT INTO scene_events (scene_id, event_id) VALUES ('batch-later', 'batch-event')",
    );
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "browser-batch-undo",
        projectId: "default-project",
        sessionId: "batch-session",
        journalId: receipt.undoJournalId,
        direction: "undo",
      },
    });
    expect(
      await query(
        mock,
        "SELECT scene_id FROM scene_events WHERE event_id = 'batch-event' ORDER BY scene_id",
      ),
    ).toEqual([{ scene_id: "batch-later" }]);
    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "browser-batch-redo",
        projectId: "default-project",
        sessionId: "batch-session",
        journalId: receipt.undoJournalId,
        direction: "redo",
      },
    });
    expect(
      await query(
        mock,
        "SELECT scene_id FROM scene_events WHERE event_id = 'batch-event' ORDER BY scene_id",
      ),
    ).toEqual([{ scene_id: "batch-later" }, { scene_id: "batch-new" }]);

    const batchChanges = await query(
      mock,
      `SELECT op_type, payload FROM change_events
        WHERE entity_type = 'event' AND entity_id = 'batch-event'
        ORDER BY sequence`,
    );
    expect(batchChanges.map((change) => change.op_type)).toEqual([
      "event.stamp",
      "event.unstamp",
      "event.stamp",
    ]);
    expect(
      batchChanges.map(
        (change) =>
          (JSON.parse(String(change.payload)) as { sceneIds: string[] })
            .sceneIds,
      ),
    ).toEqual([["batch-new"], ["batch-new"], ["batch-new"]]);

    const beforeFailure = await query(
      mock,
      `SELECT
        (SELECT COUNT(*) FROM scene_events) AS links,
        (SELECT COUNT(*) FROM undo_journal) AS journals,
        (SELECT COUNT(*) FROM change_events) AS changes`,
    );
    await expect(
      mock.invoke("agent_scene_event_link_batch", {
        payload: {
          requestId: "browser-batch-xproj",
          projectId: "default-project",
          sessionId: "batch-session",
          eventId: "batch-event",
          sceneIds: ["batch-new", "batch-foreign"],
        },
      }),
    ).rejects.toThrow("batch-foreign");
    expect(
      await query(
        mock,
        `SELECT
          (SELECT COUNT(*) FROM scene_events) AS links,
          (SELECT COUNT(*) FROM undo_journal) AS journals,
          (SELECT COUNT(*) FROM change_events) AS changes`,
      ),
    ).toEqual(beforeFailure);

    const changes = await query(
      mock,
      `SELECT project_id AS projectId, scene_id AS sceneId, domain,
              op_type AS opType, entity_type AS entityType,
              entity_id AS entityId, payload, session_id AS sessionId,
              sequence, timestamp, prev_hash AS prevHash, hash
         FROM change_events WHERE project_id = 'default-project'
        ORDER BY sequence`,
    );
    expect(
      await verifyChain(changes as unknown as EventForVerify[]),
    ).toMatchObject({
      ok: true,
    });
  });

  it("rolls back every link, journal, event, and receipt when one insert fails", async () => {
    await run(
      mock,
      `CREATE TRIGGER fail_browser_batch_link
       BEFORE INSERT ON scene_events
       WHEN NEW.scene_id = 'batch-fail'
       BEGIN
         SELECT RAISE(ABORT, 'forced browser batch failure');
       END`,
    );
    const before = await query(
      mock,
      `SELECT
        (SELECT COUNT(*) FROM scene_events WHERE event_id = 'batch-fail-event') AS links,
        (SELECT COUNT(*) FROM undo_journal) AS journals,
        (SELECT COUNT(*) FROM change_events) AS changes,
        (SELECT COUNT(*) FROM idempotency_requests
          WHERE domain = 'agent_scene_event_link_batch') AS receipts`,
    );
    await expect(
      mock.invoke("agent_scene_event_link_batch", {
        payload: {
          requestId: "browser-batch-trigger-failure",
          projectId: "default-project",
          sessionId: "batch-session",
          eventId: "batch-fail-event",
          sceneIds: ["batch-new", "batch-fail"],
        },
      }),
    ).rejects.toThrow("forced browser batch failure");
    expect(
      await query(
        mock,
        `SELECT
          (SELECT COUNT(*) FROM scene_events WHERE event_id = 'batch-fail-event') AS links,
          (SELECT COUNT(*) FROM undo_journal) AS journals,
          (SELECT COUNT(*) FROM change_events) AS changes,
          (SELECT COUNT(*) FROM idempotency_requests
            WHERE domain = 'agent_scene_event_link_batch') AS receipts`,
      ),
    ).toEqual(before);
  });

  it("rejects an ABA-stale batch undo without mutating the replacement or unrelated link", async () => {
    const receipt = await mock.invoke<{ undoJournalId: string }>(
      "agent_scene_event_link_batch",
      {
        payload: {
          requestId: "browser-batch-aba",
          projectId: "default-project",
          sessionId: "batch-session",
          eventId: "batch-event",
          sceneIds: ["batch-new"],
        },
      },
    );
    const original = await query(
      mock,
      `SELECT incarnation_token FROM scene_events
        WHERE scene_id = 'batch-new' AND event_id = 'batch-event'`,
    );
    expect(String(original[0].incarnation_token)).not.toBe("");

    await run(
      mock,
      "DELETE FROM scene_events WHERE scene_id = 'batch-new' AND event_id = 'batch-event'",
    );
    await run(
      mock,
      `INSERT INTO scene_events (scene_id, event_id, incarnation_token)
       VALUES ('batch-new', 'batch-event', 'replacement-incarnation'),
              ('batch-later', 'batch-event', 'unrelated-incarnation')`,
    );
    const before = await query(
      mock,
      `SELECT
        (SELECT COUNT(*) FROM undo_journal) AS journals,
        (SELECT COUNT(*) FROM change_events) AS changes,
        (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
    );

    await expect(
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId: "browser-batch-aba-undo",
          projectId: "default-project",
          sessionId: "batch-session",
          journalId: receipt.undoJournalId,
          direction: "undo",
        },
      }),
    ).rejects.toThrow("incarnation");
    expect(
      await query(
        mock,
        `SELECT scene_id, incarnation_token FROM scene_events
          WHERE event_id = 'batch-event' AND scene_id IN ('batch-new', 'batch-later')
          ORDER BY scene_id`,
      ),
    ).toEqual([
      {
        scene_id: "batch-later",
        incarnation_token: "unrelated-incarnation",
      },
      {
        scene_id: "batch-new",
        incarnation_token: "replacement-incarnation",
      },
    ]);
    expect(
      await query(
        mock,
        `SELECT
          (SELECT COUNT(*) FROM undo_journal) AS journals,
          (SELECT COUNT(*) FROM change_events) AS changes,
          (SELECT COUNT(*) FROM idempotency_requests) AS receipts`,
      ),
    ).toEqual(before);
  });

  it("rewrites stacked batch journal tokens when replay creates a fresh incarnation", async () => {
    const link = await mock.invoke<{ undoJournalId: string }>(
      "agent_scene_event_link_batch",
      {
        payload: {
          requestId: "browser-batch-chain-link",
          projectId: "default-project",
          sessionId: "batch-session",
          eventId: "batch-event",
          sceneIds: ["batch-new"],
        },
      },
    );
    const firstToken = String(
      (
        await query(
          mock,
          `SELECT incarnation_token FROM scene_events
            WHERE scene_id = 'batch-new' AND event_id = 'batch-event'`,
        )
      )[0].incarnation_token,
    );
    const linkedSnapshot = JSON.stringify({
      snapshotKind: "sceneEventLinkBatch",
      eventId: "batch-event",
      sceneIds: ["batch-new"],
      linked: true,
      incarnationTokens: { "batch-new": firstToken },
    });
    const unlinkedSnapshot = JSON.stringify({
      snapshotKind: "sceneEventLinkBatch",
      eventId: "batch-event",
      sceneIds: ["batch-new"],
      linked: false,
    });
    await run(
      mock,
      `INSERT INTO undo_journal
        (id, project_id, surface, entity_kind, entity_id, op_kind,
         before_json, after_json, base_version, result_version, created_at)
       VALUES ('browser-batch-chain-unlink', 'default-project', 'test',
               'event', 'batch-event', 'update', ?, ?, 7, 7, datetime('now'))`,
      [linkedSnapshot, unlinkedSnapshot],
    );
    await run(
      mock,
      "DELETE FROM scene_events WHERE scene_id = 'batch-new' AND event_id = 'batch-event'",
    );

    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "browser-batch-chain-undo-unlink",
        projectId: "default-project",
        sessionId: "batch-session",
        journalId: "browser-batch-chain-unlink",
        direction: "undo",
      },
    });
    const secondToken = String(
      (
        await query(
          mock,
          `SELECT incarnation_token FROM scene_events
            WHERE scene_id = 'batch-new' AND event_id = 'batch-event'`,
        )
      )[0].incarnation_token,
    );
    expect(secondToken).not.toBe(firstToken);

    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "browser-batch-chain-undo-link",
        projectId: "default-project",
        sessionId: "batch-session",
        journalId: link.undoJournalId,
        direction: "undo",
      },
    });
    expect(
      await query(
        mock,
        `SELECT scene_id FROM scene_events
          WHERE scene_id = 'batch-new' AND event_id = 'batch-event'`,
      ),
    ).toEqual([]);

    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "browser-batch-chain-redo-link",
        projectId: "default-project",
        sessionId: "batch-session",
        journalId: link.undoJournalId,
        direction: "redo",
      },
    });
    const thirdToken = String(
      (
        await query(
          mock,
          `SELECT incarnation_token FROM scene_events
            WHERE scene_id = 'batch-new' AND event_id = 'batch-event'`,
        )
      )[0].incarnation_token,
    );
    expect(thirdToken).not.toBe(secondToken);

    await mock.invoke("agent_apply_undo_journal", {
      payload: {
        requestId: "browser-batch-chain-redo-unlink",
        projectId: "default-project",
        sessionId: "batch-session",
        journalId: "browser-batch-chain-unlink",
        direction: "redo",
      },
    });
    expect(
      await query(
        mock,
        `SELECT scene_id FROM scene_events
          WHERE scene_id = 'batch-new' AND event_id = 'batch-event'`,
      ),
    ).toEqual([]);
  });
});
