// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBrowserMock, type PersistentBrowserMock } from "./browser-mock";
import { withCanonicalWriterTestContext } from "./browser-mock.canonical-test-context";

async function run(
  mock: PersistentBrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  await mock.invoke("db_execute", { sql, params, method: "run" });
}

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

async function seedRoot(
  mock: PersistentBrowserMock,
  id: string,
  title = "Original",
): Promise<void> {
  await run(
    mock,
    `INSERT INTO foreshadows
      (id, project_id, title, intent, notes, payoff_confirmed, abandoned,
       secret, load_bearing, mechanism, version, created_at, updated_at)
     VALUES (?, 'default-project', ?, 'intent', 'notes', 0, 0, 0,
             'critical', 'misdirection', 0, 1, 1)`,
    [id, title],
  );
}

describe("Browser Foreshadow aggregate OCC", () => {
  let mock: PersistentBrowserMock;
  let onDatabaseDirty: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(async () => {
    onDatabaseDirty = vi.fn<() => void>();
    mock = withCanonicalWriterTestContext(
      await createBrowserMock({
        onDatabaseDirty,
        allowProtectedWriterTestFixtures: true,
      }),
    );
  });

  afterEach(() => mock.close());

  it("rejects two-window stale root update and delete without mutation", async () => {
    await seedRoot(mock, "stale-root");
    onDatabaseDirty.mockClear();

    const fresh = await mock.invoke<Record<string, unknown>>(
      "foreshadow_update",
      {
        id: "stale-root",
        patch: { baseVersion: 0, title: "Fresh title" },
      },
    );
    expect(fresh).toMatchObject({
      title: "Fresh title",
      version: 1,
      undoJournalId: expect.any(String),
    });

    await expect(
      mock.invoke("foreshadow_update", {
        id: "stale-root",
        patch: { baseVersion: 0, title: "Stale title" },
      }),
    ).rejects.toThrow(/version conflict/i);
    await expect(
      mock.invoke("foreshadow_delete", {
        payload: {
          id: "stale-root",
          projectId: "default-project",
          requestId: "stale-root-delete",
          sessionId: "stale-window",
          eventUid: "stale-root-delete-event",
          origin: "human",
          originalTransactionId: null,
          baseVersion: 0,
        },
      }),
    ).rejects.toThrow("FORESHADOW_VERSION_MISMATCH");

    expect(
      await query(
        mock,
        `SELECT title, version FROM foreshadows WHERE id = 'stale-root'`,
      ),
    ).toEqual([{ title: "Fresh title", version: 1 }]);
    expect(
      await query(
        mock,
        `SELECT COUNT(*) AS count FROM undo_journal
          WHERE entity_kind = 'foreshadow' AND entity_id = 'stale-root'`,
      ),
    ).toEqual([{ count: 1 }]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });

  it("rolls stale child writes back and groups setup/payoff saves per root", async () => {
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('occ-child-scene', 'default-project', 'scene', 'Child', 'a0'),
              ('occ-group-scene', 'default-project', 'scene', 'Group', 'a1')`,
    );
    await seedRoot(mock, "child-root");
    await seedRoot(mock, "group-root", "Grouped");
    await run(
      mock,
      `INSERT INTO codex_entries (id, project_id, type, name)
       VALUES ('occ-codex', 'default-project', 'character', 'Witness')`,
    );
    await run(
      mock,
      `INSERT INTO foreshadow_setups
        (id, foreshadow_id, scene_id, from_pos, to_pos, kind, attribution,
         is_orphan, semantic_key, created_at, updated_at)
       VALUES
        ('child-setup', 'child-root', 'occ-child-scene', 1, 3,
         'designated_existing', 'human', 0, 'child-root|occ-child-scene|1|3', 1, 1),
        ('group-setup-a', 'group-root', 'occ-group-scene', 1, 3,
         'designated_existing', 'human', 0, 'group-root|occ-group-scene|1|3', 1, 1),
        ('group-setup-b', 'group-root', 'occ-group-scene', 4, 6,
         'designated_existing', 'human', 0, 'group-root|occ-group-scene|4|6', 1, 1)`,
    );

    const first = await mock.invoke<Record<string, unknown>>(
      "foreshadow_update_setup",
      {
        id: "child-setup",
        patch: { baseVersion: 0, strength: "overt" },
      },
    );
    expect(first.version).toBe(1);
    await expect(
      mock.invoke("foreshadow_link_codex", {
        foreshadowId: "child-root",
        codexId: "occ-codex",
        baseVersion: 0,
      }),
    ).rejects.toThrow("FORESHADOW_VERSION_MISMATCH");
    await expect(
      mock.invoke("foreshadow_save_anchors_for_scene", {
        sceneId: "occ-child-scene",
        setups: [
          {
            id: "child-setup",
            foreshadowId: "child-root",
            baseVersion: 0,
            sceneId: "occ-child-scene",
            fromPos: 2,
            toPos: 4,
          },
        ],
        payoffs: [],
        baseVersions: { "child-root": 0 },
        docContentSize: 20,
      }),
    ).rejects.toThrow("FORESHADOW_VERSION_MISMATCH");
    await expect(
      mock.invoke("foreshadow_resolve_orphan", {
        payload: {
          setupId: "child-setup",
          action: "delete",
          baseVersion: 0,
        },
      }),
    ).rejects.toThrow("FORESHADOW_VERSION_MISMATCH");

    expect(
      await query(
        mock,
        `SELECT strength, from_pos, to_pos FROM foreshadow_setups
          WHERE id = 'child-setup'`,
      ),
    ).toEqual([{ strength: "overt", from_pos: 1, to_pos: 3 }]);
    expect(
      await query(
        mock,
        `SELECT COUNT(*) AS count FROM foreshadow_codex_links
          WHERE foreshadow_id = 'child-root'`,
      ),
    ).toEqual([{ count: 0 }]);

    const grouped = await mock.invoke<Record<string, unknown>[]>(
      "foreshadow_save_anchors_for_scene",
      {
        sceneId: "occ-group-scene",
        setups: [
          {
            id: "group-setup-a",
            foreshadowId: "group-root",
            baseVersion: 0,
            sceneId: "occ-group-scene",
            fromPos: 2,
            toPos: 4,
          },
          {
            id: "group-setup-b",
            foreshadowId: "group-root",
            baseVersion: 0,
            sceneId: "occ-group-scene",
            fromPos: 5,
            toPos: 7,
          },
        ],
        payoffs: [
          {
            foreshadowId: "group-root",
            baseVersion: 0,
            sceneId: "occ-group-scene",
            fromPos: 8,
            toPos: 12,
          },
        ],
        baseVersions: { "group-root": 0 },
        docContentSize: 20,
      },
    );
    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ id: "group-root", version: 1 });

    const identical = await mock.invoke<Record<string, unknown>[]>(
      "foreshadow_save_anchors_for_scene",
      {
        sceneId: "occ-group-scene",
        setups: [
          {
            id: "group-setup-a",
            foreshadowId: "group-root",
            baseVersion: 1,
            sceneId: "occ-group-scene",
            fromPos: 2,
            toPos: 4,
          },
          {
            id: "group-setup-b",
            foreshadowId: "group-root",
            baseVersion: 1,
            sceneId: "occ-group-scene",
            fromPos: 5,
            toPos: 7,
          },
        ],
        payoffs: [
          {
            foreshadowId: "group-root",
            baseVersion: 1,
            sceneId: "occ-group-scene",
            fromPos: 8,
            toPos: 12,
          },
        ],
        baseVersions: { "group-root": 1 },
        docContentSize: 20,
      },
    );
    expect(identical).toHaveLength(1);
    expect(identical[0]).toMatchObject({ id: "group-root", version: 1 });
  });

  it("restores every child through delete redo cycles with monotonic versions", async () => {
    await run(
      mock,
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('aggregate-setup-scene', 'default-project', 'scene', 'Plant', 'a0'),
              ('aggregate-payoff-scene', 'default-project', 'scene', 'Payoff', 'a1')`,
    );
    await seedRoot(mock, "aggregate-root");
    await run(
      mock,
      `UPDATE foreshadows
          SET payoff_scene_id = 'aggregate-payoff-scene', payoff_from_pos = 8,
              payoff_to_pos = 12, payoff_confirmed = 1, codex_link_dirty_at = 77
        WHERE id = 'aggregate-root'`,
    );
    await run(
      mock,
      `INSERT INTO codex_entries (id, project_id, type, name)
       VALUES ('aggregate-codex', 'default-project', 'character', 'Witness')`,
    );
    await run(
      mock,
      `INSERT INTO foreshadow_setups
        (id, foreshadow_id, scene_id, from_pos, to_pos, kind, role, strength,
         ai_strength, ai_reasoning, attribution, ai_rationale,
         last_evaluated_at, is_orphan, evidence_anchor_id, semantic_key,
         created_at, updated_at)
       VALUES ('aggregate-setup', 'aggregate-root', 'aggregate-setup-scene',
               2, 5, 'designated_existing', 'primary', 'strong', 'medium',
               'reason', 'human', 'rationale', 44, 0, 'ev-setup',
               'setup-key', 1, 1)`,
    );
    await run(
      mock,
      `INSERT INTO foreshadow_payoffs
        (id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
         is_primary, attribution, ai_rationale, is_orphan, evidence_anchor_id,
         semantic_key, created_at, updated_at)
       VALUES ('aggregate-payoff', 'aggregate-root', 'aggregate-payoff-scene',
               8, 12, 'primary', 1, 1, 'ai', 'payoff rationale', 0,
               'ev-payoff', 'payoff-key', 1, 1)`,
    );
    await run(
      mock,
      `INSERT INTO foreshadow_setup_payoff_links
        (foreshadow_id, setup_id, payoff_id, bridge_kind, explanation, created_at)
       VALUES ('aggregate-root', 'aggregate-setup', 'aggregate-payoff',
               'causal', 'bridge', 1)`,
    );
    await run(
      mock,
      `INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
       VALUES ('aggregate-root', 'aggregate-codex')`,
    );

    const receipt = await mock.invoke<{ undoJournalId: string }>(
      "foreshadow_delete",
      {
        payload: {
          id: "aggregate-root",
          projectId: "default-project",
          requestId: "aggregate-root-delete",
          sessionId: "manual-window",
          eventUid: "aggregate-root-delete-event",
          origin: "human",
          originalTransactionId: null,
          baseVersion: 0,
        },
      },
    );
    expect(
      await query(
        mock,
        `SELECT COUNT(*) AS count FROM foreshadows WHERE id = 'aggregate-root'`,
      ),
    ).toEqual([{ count: 0 }]);

    const replay = async (direction: "undo" | "redo", requestId: string) =>
      mock.invoke("agent_apply_undo_journal", {
        payload: {
          requestId,
          projectId: "default-project",
          sessionId: "history-window",
          journalId: receipt.undoJournalId,
          direction,
        },
      });
    const aggregateState = () =>
      query(
        mock,
        `SELECT root.version,
                (SELECT COUNT(*) FROM foreshadow_setups
                  WHERE foreshadow_id = root.id) AS setups,
                (SELECT COUNT(*) FROM foreshadow_payoffs
                  WHERE foreshadow_id = root.id) AS payoffs,
                (SELECT COUNT(*) FROM foreshadow_setup_payoff_links
                  WHERE foreshadow_id = root.id) AS edges,
                (SELECT COUNT(*) FROM foreshadow_codex_links
                  WHERE foreshadow_id = root.id) AS codex_links
           FROM foreshadows root WHERE root.id = 'aggregate-root'`,
      );

    await replay("undo", "aggregate-undo-1");
    expect(await aggregateState()).toEqual([
      { version: 1, setups: 1, payoffs: 1, edges: 1, codex_links: 1 },
    ]);
    await replay("redo", "aggregate-redo-1");
    expect(await aggregateState()).toEqual([]);
    await replay("undo", "aggregate-undo-2");
    expect(await aggregateState()).toEqual([
      { version: 2, setups: 1, payoffs: 1, edges: 1, codex_links: 1 },
    ]);
    await expect(replay("undo", "aggregate-undo-replay")).rejects.toThrow();
    expect(await aggregateState()).toEqual([
      { version: 2, setups: 1, payoffs: 1, edges: 1, codex_links: 1 },
    ]);
  });
});
