// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserMock, type BrowserMock } from "./browser-mock";

interface PersistentBrowserMock extends BrowserMock {
  exportDatabase(): Uint8Array;
  close(): void;
}

interface BrowserMockPersistenceOptions {
  databaseBytes?: Uint8Array;
  onDatabaseDirty?: () => void;
  allowProtectedWriterTestFixtures?: boolean;
}

type PersistentBrowserMockFactory = (
  options?: BrowserMockPersistenceOptions,
) => Promise<PersistentBrowserMock>;

const createPersistentBrowserMock =
  createBrowserMock as unknown as PersistentBrowserMockFactory;

const ownedMocks: PersistentBrowserMock[] = [];

async function createMock(
  options?: BrowserMockPersistenceOptions,
): Promise<PersistentBrowserMock> {
  const mock = await createPersistentBrowserMock({
    allowProtectedWriterTestFixtures: true,
    ...options,
  });
  ownedMocks.push(mock);
  return mock;
}

async function queryRows(
  mock: BrowserMock,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const result = await mock.invoke<{ rows: Record<string, unknown>[] }>(
    "db_execute",
    { sql, params, method: "all" },
  );
  return result.rows;
}

afterEach(() => {
  for (const mock of ownedMocks.splice(0)) {
    mock.close?.();
  }
});

describe("BrowserMock persistence contract", () => {
  it("exports database bytes that restore the committed database", async () => {
    const source = await createMock();
    await source.invoke("db_execute", {
      sql: "insert into app_settings (key, value) values (?, ?)",
      params: ["contract.roundTrip", "preserved"],
      method: "run",
    });

    const databaseBytes = source.exportDatabase();
    expect(databaseBytes).toBeInstanceOf(Uint8Array);
    expect(databaseBytes.byteLength).toBeGreaterThan(0);

    const restored = await createMock({ databaseBytes });
    await expect(
      queryRows(restored, "select value from app_settings where key = ?", [
        "contract.roundTrip",
      ]),
    ).resolves.toEqual([{ value: "preserved" }]);
  });

  it("seeds a new database but does not re-seed a restored database", async () => {
    const fresh = await createMock();
    expect(
      await queryRows(fresh, "select id from projects order by id"),
    ).toEqual([{ id: "default-project" }]);
    expect(await queryRows(fresh, "select id from tree_nodes")).toEqual([]);

    await fresh.invoke("db_execute", {
      sql: "delete from projects",
      params: [],
      method: "run",
    });
    const databaseBytes = fresh.exportDatabase();

    const restored = await createMock({ databaseBytes });
    expect(await queryRows(restored, "select id from projects")).toEqual([]);
  });

  it("migrates an old persisted database to the durable create ledger", async () => {
    const legacy = await createMock();
    await legacy.invoke("db_execute", {
      sql: "DROP INDEX idx_idempotency_requests_project_created",
      params: [],
      method: "run",
    });
    await legacy.invoke("db_execute", {
      sql: "DROP TABLE idempotency_requests",
      params: [],
      method: "run",
    });

    const onDatabaseDirty = vi.fn();
    const migrated = await createMock({
      databaseBytes: legacy.exportDatabase(),
      onDatabaseDirty,
    });
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
    expect(
      await queryRows(
        migrated,
        "select name from sqlite_master where name = 'idempotency_requests'",
      ),
    ).toEqual([{ name: "idempotency_requests" }]);

    const payload = {
      id: "migrated-browser-foreshadow",
      requestId: "migrated-browser-foreshadow",
      projectId: "default-project",
      sessionId: "migrated-browser-foreshadow-session",
      eventUid: "migrated-browser-foreshadow-event",
      origin: "human",
      originalTransactionId: null,
      title: "Migrated durable create",
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
    await expect(
      migrated.invoke<Record<string, unknown>>("foreshadow_create", {
        payload,
      }),
    ).resolves.toMatchObject({
      id: payload.id,
      __idempotency: { replayed: false, entityPresent: true },
    });

    const reopened = await createMock({
      databaseBytes: migrated.exportDatabase(),
    });
    await reopened.invoke("db_execute", {
      sql: "DELETE FROM foreshadows WHERE id = ?",
      params: [payload.id],
      method: "run",
    });
    await expect(
      reopened.invoke<Record<string, unknown>>("foreshadow_create", {
        payload,
      }),
    ).resolves.toMatchObject({
      id: payload.id,
      __idempotency: { replayed: true, entityPresent: false },
    });
    expect(
      await queryRows(reopened, "SELECT id FROM foreshadows WHERE id = ?", [
        payload.id,
      ]),
    ).toEqual([]);
  });

  it("migrates persisted pre-v4 databases to the semantic binding table exactly once", async () => {
    const legacy = await createMock();
    await legacy.invoke("db_execute", {
      sql: "DROP TABLE IF EXISTS codex_detail_semantic_bindings",
      params: [],
      method: "run",
    });

    const onDatabaseDirty = vi.fn();
    const migrated = await createMock({
      databaseBytes: legacy.exportDatabase(),
      onDatabaseDirty,
    });
    expect(
      await queryRows(
        migrated,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ["codex_detail_semantic_bindings"],
      ),
    ).toEqual([{ name: "codex_detail_semantic_bindings" }]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);

    const reopenedDirty = vi.fn();
    const reopened = await createMock({
      databaseBytes: migrated.exportDatabase(),
      onDatabaseDirty: reopenedDirty,
    });
    expect(
      await queryRows(
        reopened,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        ["codex_detail_semantic_bindings"],
      ),
    ).toEqual([{ name: "codex_detail_semantic_bindings" }]);
    expect(reopenedDirty).not.toHaveBeenCalled();
  });

  it("fails closed for a malformed prerelease semantic binding table", async () => {
    const prerelease = await createMock();
    await prerelease.invoke("db_execute", {
      sql: "DROP TABLE codex_detail_semantic_bindings",
      params: [],
      method: "run",
    });
    await prerelease.invoke("db_execute", {
      sql: "CREATE TABLE codex_detail_semantic_bindings (id TEXT PRIMARY KEY)",
      params: [],
      method: "run",
    });
    const bytes = prerelease.exportDatabase();

    await expect(
      createPersistentBrowserMock({ databaseBytes: bytes }),
    ).rejects.toThrow(/Unsupported prerelease codex_detail_semantic_bindings/);
  });

  it("rejects a lookalike semantic binding table without the v4 constraints", async () => {
    const prerelease = await createMock();
    await prerelease.invoke("db_execute", {
      sql: "DROP TABLE codex_detail_semantic_bindings",
      params: [],
      method: "run",
    });
    await prerelease.invoke("db_execute", {
      sql: `CREATE TABLE codex_detail_semantic_bindings (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
              definition_id TEXT NOT NULL,
              facet_key TEXT NOT NULL,
              projection_kind TEXT NOT NULL,
              temporal_policy TEXT NOT NULL,
              source TEXT NOT NULL,
              confirmed INTEGER NOT NULL,
              version INTEGER NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              FOREIGN KEY (project_id, definition_id)
                REFERENCES codex_detail_definitions(project_id, id)
                ON DELETE CASCADE
            )`,
      params: [],
      method: "run",
    });
    await prerelease.invoke("db_execute", {
      sql: `CREATE UNIQUE INDEX uq_codex_detail_semantic_binding_definition_facet
              ON codex_detail_semantic_bindings(definition_id, facet_key)`,
      params: [],
      method: "run",
    });
    await prerelease.invoke("db_execute", {
      sql: `CREATE INDEX idx_codex_detail_semantic_bindings_project_facet
              ON codex_detail_semantic_bindings(project_id, facet_key)`,
      params: [],
      method: "run",
    });

    await expect(
      createPersistentBrowserMock({
        databaseBytes: prerelease.exportDatabase(),
      }),
    ).rejects.toThrow(/Unsupported prerelease codex_detail_semantic_bindings/);
  });

  it("migrates persisted pre-v5 calendar rows to version zero exactly once", async () => {
    const legacy = await createMock();
    await legacy.invoke("db_execute", {
      sql: "INSERT INTO project_calendar (project_id, days_per_year, season_boundaries) VALUES (?, ?, ?)",
      params: ["default-project", 400, "[]"],
      method: "run",
    });
    await legacy.invoke("db_execute", {
      sql: "ALTER TABLE project_calendar DROP COLUMN version",
      params: [],
      method: "run",
    });

    const onDatabaseDirty = vi.fn();
    const migrated = await createMock({
      databaseBytes: legacy.exportDatabase(),
      onDatabaseDirty,
    });
    expect(
      await queryRows(
        migrated,
        "SELECT days_per_year, version FROM project_calendar WHERE project_id = ?",
        ["default-project"],
      ),
    ).toEqual([{ days_per_year: 400, version: 0 }]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);

    const reopenedDirty = vi.fn();
    const reopened = await createMock({
      databaseBytes: migrated.exportDatabase(),
      onDatabaseDirty: reopenedDirty,
    });
    expect(
      await queryRows(reopened, "SELECT version FROM project_calendar"),
    ).toEqual([{ version: 0 }]);
    expect(reopenedDirty).not.toHaveBeenCalled();
  });

  it("migrates persisted scene-event links to the legacy incarnation exactly once", async () => {
    const legacy = await createMock();
    await legacy.invoke("db_execute", {
      sql: `INSERT INTO tree_nodes
              (id, project_id, node_type, title, sort_order)
            VALUES ('legacy-scene-event-scene', 'default-project', 'scene', 'Legacy', 'a0')`,
      params: [],
      method: "run",
    });
    await legacy.invoke("db_execute", {
      sql: `INSERT INTO events
              (id, project_id, title, ordinal, created_at, updated_at)
            VALUES ('legacy-scene-event-event', 'default-project', 'Legacy', 'a0',
                    datetime('now'), datetime('now'))`,
      params: [],
      method: "run",
    });
    await legacy.invoke("db_execute", {
      sql: `INSERT INTO scene_events (scene_id, event_id)
            VALUES ('legacy-scene-event-scene', 'legacy-scene-event-event')`,
      params: [],
      method: "run",
    });
    await legacy.invoke("db_execute", {
      sql: "ALTER TABLE scene_events DROP COLUMN incarnation_token",
      params: [],
      method: "run",
    });

    const onDatabaseDirty = vi.fn();
    const migrated = await createMock({
      databaseBytes: legacy.exportDatabase(),
      onDatabaseDirty,
    });
    expect(
      await queryRows(
        migrated,
        `SELECT scene_id, event_id, incarnation_token
           FROM scene_events WHERE event_id = 'legacy-scene-event-event'`,
      ),
    ).toEqual([
      {
        scene_id: "legacy-scene-event-scene",
        event_id: "legacy-scene-event-event",
        incarnation_token: "",
      },
    ]);
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);

    const reopenedDirty = vi.fn();
    const reopened = await createMock({
      databaseBytes: migrated.exportDatabase(),
      onDatabaseDirty: reopenedDirty,
    });
    expect(
      await queryRows(
        reopened,
        `SELECT incarnation_token FROM scene_events
          WHERE event_id = 'legacy-scene-event-event'`,
      ),
    ).toEqual([{ incarnation_token: "" }]);
    expect(reopenedDirty).not.toHaveBeenCalled();
  });

  it("migrates legacy Plot and Foreshadow bytes with stable keys and payoff data exactly once", async () => {
    const legacy = await createMock();
    const runLegacy = (sql: string, params: unknown[] = []) =>
      legacy.invoke("db_execute", { sql, params, method: "run" });
    for (const index of [
      "idx_plot_thread_links_semantic_key",
      "uq_plot_thread_links_semantic_key",
      "idx_plot_thread_branches_semantic_key",
      "uq_plot_thread_branches_semantic_key",
      "idx_fs_setup_semantic_key",
      "uq_fs_setup_semantic_key",
    ]) {
      await runLegacy(`DROP INDEX ${index}`);
    }
    await runLegacy("DROP TABLE foreshadow_setup_payoff_links");
    await runLegacy("DROP TABLE foreshadow_payoffs");
    for (const [table, column] of [
      ["plot_threads", "version"],
      ["plot_thread_scene_links", "semantic_key"],
      ["plot_thread_scene_links", "version"],
      ["plot_thread_branches", "semantic_key"],
      ["plot_thread_branches", "version"],
      ["foreshadows", "version"],
      ["foreshadows", "mechanism"],
      ["foreshadow_setups", "semantic_key"],
      ["foreshadow_setups", "evidence_anchor_id"],
      ["foreshadow_setups", "role"],
    ]) {
      await runLegacy(`ALTER TABLE ${table} DROP COLUMN ${column}`);
    }
    await runLegacy(
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES ('legacy-domain-scene-a', 'default-project', 'scene', 'A', 'a0'),
              ('legacy-domain-scene-b', 'default-project', 'scene', 'B', 'a1')`,
    );
    await runLegacy(
      `INSERT INTO plot_threads
        (id, project_id, name, sort_order)
       VALUES ('legacy-domain-thread-a', 'default-project', 'A', 'a0'),
              ('legacy-domain-thread-b', 'default-project', 'B', 'a1')`,
    );
    await runLegacy(
      `INSERT INTO plot_thread_scene_links
        (id, thread_id, node_id, phase_type)
       VALUES
        ('legacy-domain-link-a', 'legacy-domain-thread-a',
         'legacy-domain-scene-a', 'introduce'),
        ('legacy-domain-link-b', 'legacy-domain-thread-a',
         'legacy-domain-scene-a', 'introduce')`,
    );
    await runLegacy(
      `INSERT INTO plot_thread_branches
        (id, project_id, from_thread_id, to_thread_id, at_node_id, kind)
       VALUES
        ('legacy-domain-branch-a', 'default-project',
         'legacy-domain-thread-a', 'legacy-domain-thread-b',
         'legacy-domain-scene-a', 'branch'),
        ('legacy-domain-branch-b', 'default-project',
         'legacy-domain-thread-a', 'legacy-domain-thread-b',
         'legacy-domain-scene-a', 'branch')`,
    );
    await runLegacy(
      `INSERT INTO foreshadows
        (id, project_id, title, payoff_scene_id, payoff_from_pos,
         payoff_to_pos, payoff_confirmed, created_at, updated_at)
       VALUES ('legacy-domain-foreshadow', 'default-project', 'Legacy',
               'legacy-domain-scene-a', 4, 8, 1, 100, 200)`,
    );
    await runLegacy(
      `INSERT INTO foreshadow_setups
        (id, foreshadow_id, scene_id, from_pos, to_pos, kind,
         attribution, created_at, updated_at)
       VALUES
        ('legacy-domain-setup-a', 'legacy-domain-foreshadow',
         'legacy-domain-scene-a', 1, 3, 'designated_existing',
         'human', 100, 200),
        ('legacy-domain-setup-b', 'legacy-domain-foreshadow',
         'legacy-domain-scene-a', 1, 3, 'designated_existing',
         'human', 100, 200)`,
    );

    const onDatabaseDirty = vi.fn();
    const migrated = await createMock({
      databaseBytes: legacy.exportDatabase(),
      onDatabaseDirty,
    });
    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
    expect(
      await queryRows(
        migrated,
        `SELECT
          (SELECT COUNT(*) FROM pragma_table_info('plot_threads')
            WHERE name = 'version') AS thread_version,
          (SELECT COUNT(*) FROM pragma_table_info('plot_thread_scene_links')
            WHERE name IN ('semantic_key', 'version')) AS link_columns,
          (SELECT COUNT(*) FROM pragma_table_info('plot_thread_branches')
            WHERE name IN ('semantic_key', 'version')) AS branch_columns,
          (SELECT COUNT(*) FROM pragma_table_info('foreshadows')
            WHERE name IN ('mechanism', 'version')) AS root_columns,
          (SELECT COUNT(*) FROM pragma_table_info('foreshadow_setups')
            WHERE name IN ('role', 'evidence_anchor_id', 'semantic_key')) AS setup_columns,
          (SELECT COUNT(*) FROM sqlite_master
            WHERE type = 'index' AND name IN (
              'uq_plot_thread_links_semantic_key',
              'uq_plot_thread_branches_semantic_key',
              'uq_fs_setup_semantic_key',
              'uq_fs_payoff_semantic_key'
            )) AS unique_indexes`,
      ),
    ).toEqual([
      {
        thread_version: 1,
        link_columns: 2,
        branch_columns: 2,
        root_columns: 2,
        setup_columns: 3,
        unique_indexes: 4,
      },
    ]);
    expect(
      await queryRows(
        migrated,
        `SELECT id, semantic_key, version
           FROM plot_thread_scene_links
          WHERE id LIKE 'legacy-domain-link-%' ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "legacy-domain-link-a",
        semantic_key: "legacy-domain-thread-a|legacy-domain-scene-a|introduce",
        version: 0,
      },
      {
        id: "legacy-domain-link-b",
        semantic_key:
          "legacy-domain-thread-a|legacy-domain-scene-a|introduce#dup:legacy-domain-link-b",
        version: 0,
      },
    ]);
    expect(
      await queryRows(
        migrated,
        `SELECT id, semantic_key, version
           FROM plot_thread_branches
          WHERE id LIKE 'legacy-domain-branch-%' ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "legacy-domain-branch-a",
        semantic_key:
          "legacy-domain-thread-a|legacy-domain-thread-b|legacy-domain-scene-a|branch",
        version: 0,
      },
      {
        id: "legacy-domain-branch-b",
        semantic_key:
          "legacy-domain-thread-a|legacy-domain-thread-b|legacy-domain-scene-a|branch#dup:legacy-domain-branch-b",
        version: 0,
      },
    ]);
    expect(
      await queryRows(
        migrated,
        `SELECT id, role, evidence_anchor_id, semantic_key
           FROM foreshadow_setups
          WHERE id LIKE 'legacy-domain-setup-%' ORDER BY id`,
      ),
    ).toEqual([
      {
        id: "legacy-domain-setup-a",
        role: "unspecified",
        evidence_anchor_id: null,
        semantic_key: "legacy-domain-foreshadow|legacy-domain-scene-a|1|3",
      },
      {
        id: "legacy-domain-setup-b",
        role: "unspecified",
        evidence_anchor_id: null,
        semantic_key:
          "legacy-domain-foreshadow|legacy-domain-scene-a|1|3#dup:legacy-domain-setup-b",
      },
    ]);
    expect(
      await queryRows(
        migrated,
        `SELECT id, foreshadow_id, scene_id, from_pos, to_pos, confirmed,
                is_primary, semantic_key
           FROM foreshadow_payoffs`,
      ),
    ).toEqual([
      {
        id: "legacy-payoff:legacy-domain-foreshadow",
        foreshadow_id: "legacy-domain-foreshadow",
        scene_id: "legacy-domain-scene-a",
        from_pos: 4,
        to_pos: 8,
        confirmed: 1,
        is_primary: 1,
        semantic_key: "legacy-domain-foreshadow|legacy-domain-scene-a|4|8",
      },
    ]);

    await expect(
      migrated.invoke("plot_thread_link_create", {
        payload: {
          id: "legacy-domain-link-new",
          projectId: "default-project",
          requestId: "legacy-domain-link-new",
          sessionId: "legacy-domain-plot-session",
          eventUid: "legacy-domain-link-new-event",
          origin: "human",
          originalTransactionId: null,
          threadId: "legacy-domain-thread-a",
          nodeId: "legacy-domain-scene-b",
          phaseType: "develop",
          note: null,
          sortOrder: null,
        },
      }),
    ).resolves.toMatchObject({
      semantic_key: "legacy-domain-thread-a|legacy-domain-scene-b|develop",
      version: 0,
    });
    await expect(
      migrated.invoke("plot_thread_branch_create", {
        payload: {
          id: "legacy-domain-branch-new",
          projectId: "default-project",
          requestId: "legacy-domain-branch-new",
          sessionId: "legacy-domain-plot-session",
          eventUid: "legacy-domain-branch-new-event",
          origin: "human",
          originalTransactionId: null,
          fromThreadId: "legacy-domain-thread-a",
          toThreadId: "legacy-domain-thread-b",
          atNodeId: "legacy-domain-scene-b",
          kind: "merge",
        },
      }),
    ).resolves.toMatchObject({
      semantic_key:
        "legacy-domain-thread-a|legacy-domain-thread-b|legacy-domain-scene-b|merge",
      version: 0,
    });
    await migrated.invoke("foreshadow_setup_create_ai", {
      projectId: "default-project",
      requestId: "legacy-domain-setup-new-request",
      sessionId: "legacy-domain-foreshadow-session",
      eventUid: "legacy-domain-setup-new-event",
      origin: "human",
      originalTransactionId: null,
      id: "legacy-domain-setup-new",
      foreshadowId: "legacy-domain-foreshadow",
      baseVersion: 0,
      sceneId: "legacy-domain-scene-b",
      fromPos: 5,
      toPos: 7,
      kind: "designated_existing",
      attribution: "human",
    });
    expect(
      await queryRows(
        migrated,
        `SELECT semantic_key FROM foreshadow_setups
          WHERE id = 'legacy-domain-setup-new'`,
      ),
    ).toEqual([
      {
        semantic_key: "legacy-domain-foreshadow|legacy-domain-scene-b|5|7",
      },
    ]);

    const reopenedDirty = vi.fn();
    const reopened = await createMock({
      databaseBytes: migrated.exportDatabase(),
      onDatabaseDirty: reopenedDirty,
    });
    expect(reopenedDirty).not.toHaveBeenCalled();
    expect(
      await queryRows(
        reopened,
        `SELECT
          (SELECT COUNT(*) FROM plot_thread_scene_links) AS links,
          (SELECT COUNT(*) FROM plot_thread_branches) AS branches,
          (SELECT COUNT(*) FROM foreshadow_payoffs) AS payoffs`,
      ),
    ).toEqual([{ links: 3, branches: 3, payoffs: 1 }]);
  });

  it("reopens a current primary payoff with an arbitrary id without remigrating it", async () => {
    const current = await createMock();
    await current.invoke("db_execute", {
      sql: `INSERT INTO tree_nodes
              (id, project_id, node_type, title, sort_order)
            VALUES ('current-payoff-scene', 'default-project', 'scene',
                    'Current payoff scene', 'a0')`,
      params: [],
      method: "run",
    });
    await current.invoke("db_execute", {
      sql: `INSERT INTO foreshadows
              (id, project_id, title, payoff_scene_id, payoff_from_pos,
               payoff_to_pos, payoff_confirmed, created_at, updated_at)
            VALUES ('current-payoff-root', 'default-project', 'Current',
                    'current-payoff-scene', 4, 9, 1, 100, 200)`,
      params: [],
      method: "run",
    });
    await current.invoke("db_execute", {
      sql: `INSERT INTO foreshadow_payoffs
              (id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
               is_primary, attribution, semantic_key, created_at, updated_at)
            VALUES ('payoff-with-domain-id', 'current-payoff-root',
                    'current-payoff-scene', 4, 9, 'payoff', 1, 1, 'human',
                    'current-payoff-root|current-payoff-scene|4|9', 100, 200)`,
      params: [],
      method: "run",
    });

    const onDatabaseDirty = vi.fn();
    const reopened = await createMock({
      databaseBytes: current.exportDatabase(),
      onDatabaseDirty,
    });

    expect(onDatabaseDirty).not.toHaveBeenCalled();
    expect(
      await queryRows(
        reopened,
        `SELECT id, foreshadow_id, scene_id, from_pos, to_pos, is_primary,
                semantic_key
           FROM foreshadow_payoffs
          WHERE foreshadow_id = 'current-payoff-root'`,
      ),
    ).toEqual([
      {
        id: "payoff-with-domain-id",
        foreshadow_id: "current-payoff-root",
        scene_id: "current-payoff-scene",
        from_pos: 4,
        to_pos: 9,
        is_primary: 1,
        semantic_key: "current-payoff-root|current-payoff-scene|4|9",
      },
    ]);
  });

  it("repairs invalid payoff ownership exactly once and preserves the valid aggregate", async () => {
    const current = await createMock();
    const runCurrent = (sql: string, params: unknown[] = []) =>
      current.invoke("db_execute", { sql, params, method: "run" });
    await runCurrent(
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES
        ('repair-payoff-folder', 'default-project', 'folder', 'Folder', 'a0'),
        ('repair-setup-scene', 'default-project', 'scene', 'Setup', 'a1'),
        ('repair-valid-payoff-scene', 'default-project', 'scene', 'Payoff', 'a2')`,
    );
    await runCurrent(
      `INSERT INTO foreshadows
        (id, project_id, title, payoff_scene_id, payoff_from_pos,
         payoff_to_pos, payoff_confirmed, version, created_at, updated_at)
       VALUES
        ('repair-foreshadow', 'default-project', 'Repair me',
         'repair-payoff-folder', 4, 9, 1, 0, 100, 200),
        ('repair-half-null', 'default-project', 'Repair half-null',
         'repair-valid-payoff-scene', 4, NULL, 0, 0, 200, 300)`,
    );
    await runCurrent(
      `INSERT INTO codex_entries (id, project_id, type, name)
       VALUES ('repair-codex', 'default-project', 'character', 'Witness')`,
    );
    await runCurrent(
      `INSERT INTO foreshadow_setups
        (id, foreshadow_id, scene_id, from_pos, to_pos, kind, attribution,
         is_orphan, semantic_key, created_at, updated_at)
       VALUES ('repair-setup', 'repair-foreshadow', 'repair-setup-scene',
               1, 3, 'designated_existing', 'human', 0,
               'repair-foreshadow|repair-setup-scene|1|3', 100, 200)`,
    );
    await runCurrent(
      `INSERT INTO foreshadow_payoffs
        (id, foreshadow_id, scene_id, from_pos, to_pos, role, confirmed,
         is_primary, attribution, is_orphan, semantic_key, created_at, updated_at)
       VALUES
        ('repair-invalid-payoff', 'repair-foreshadow', 'repair-payoff-folder',
         4, 9, 'primary', 1, 1, 'human', 0,
         'repair-foreshadow|repair-payoff-folder|4|9', 100, 200),
        ('repair-valid-payoff', 'repair-foreshadow', 'repair-valid-payoff-scene',
         10, 12, 'supporting', 1, 0, 'human', 0,
         'repair-foreshadow|repair-valid-payoff-scene|10|12', 100, 200)`,
    );
    await runCurrent(
      `INSERT INTO foreshadow_setup_payoff_links
        (foreshadow_id, setup_id, payoff_id, bridge_kind, explanation, created_at)
       VALUES
        ('repair-foreshadow', 'repair-setup', 'repair-invalid-payoff',
         'causal', 'invalid incident edge', 100),
        ('repair-foreshadow', 'repair-setup', 'repair-valid-payoff',
         'causal', 'valid edge', 100)`,
    );
    await runCurrent(
      `INSERT INTO foreshadow_codex_links (foreshadow_id, codex_entry_id)
       VALUES ('repair-foreshadow', 'repair-codex')`,
    );

    const repairDirty = vi.fn();
    const repaired = await createMock({
      databaseBytes: current.exportDatabase(),
      onDatabaseDirty: repairDirty,
    });
    expect(repairDirty).toHaveBeenCalledTimes(1);
    expect(
      await queryRows(
        repaired,
        `SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos,
                payoff_confirmed, version, updated_at
           FROM foreshadows WHERE id = 'repair-foreshadow'`,
      ),
    ).toEqual([
      {
        payoff_scene_id: null,
        payoff_from_pos: null,
        payoff_to_pos: null,
        payoff_confirmed: 1,
        version: 1,
        updated_at: 201,
      },
    ]);
    expect(
      await queryRows(
        repaired,
        `SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos,
                payoff_confirmed, version, updated_at
           FROM foreshadows WHERE id = 'repair-half-null'`,
      ),
    ).toEqual([
      {
        payoff_scene_id: null,
        payoff_from_pos: null,
        payoff_to_pos: null,
        payoff_confirmed: 0,
        version: 1,
        updated_at: 301,
      },
    ]);
    expect(
      await queryRows(
        repaired,
        `SELECT
          (SELECT COUNT(*) FROM foreshadow_setups
            WHERE foreshadow_id = 'repair-foreshadow') AS setups,
          (SELECT COUNT(*) FROM foreshadow_payoffs
            WHERE foreshadow_id = 'repair-foreshadow') AS payoffs,
          (SELECT COUNT(*) FROM foreshadow_setup_payoff_links
            WHERE foreshadow_id = 'repair-foreshadow') AS edges,
          (SELECT COUNT(*) FROM foreshadow_codex_links
            WHERE foreshadow_id = 'repair-foreshadow') AS codex_links`,
      ),
    ).toEqual([{ setups: 1, payoffs: 1, edges: 1, codex_links: 1 }]);
    expect(
      await queryRows(
        repaired,
        `SELECT id FROM foreshadow_payoffs
          WHERE foreshadow_id = 'repair-foreshadow' ORDER BY id`,
      ),
    ).toEqual([{ id: "repair-valid-payoff" }]);
    expect(
      await queryRows(
        repaired,
        `SELECT payoff_id FROM foreshadow_setup_payoff_links
          WHERE foreshadow_id = 'repair-foreshadow' ORDER BY payoff_id`,
      ),
    ).toEqual([{ payoff_id: "repair-valid-payoff" }]);

    const reopenedDirty = vi.fn();
    const reopened = await createMock({
      databaseBytes: repaired.exportDatabase(),
      onDatabaseDirty: reopenedDirty,
    });
    expect(reopenedDirty).not.toHaveBeenCalled();
    expect(
      await queryRows(
        reopened,
        `SELECT payoff_scene_id, payoff_from_pos, payoff_to_pos, version, updated_at
           FROM foreshadows WHERE id = 'repair-foreshadow'`,
      ),
    ).toEqual([
      {
        payoff_scene_id: null,
        payoff_from_pos: null,
        payoff_to_pos: null,
        version: 1,
        updated_at: 201,
      },
    ]);

    const receipt = await reopened.invoke<{ undoJournalId: string }>(
      "foreshadow_delete",
      {
        payload: {
          id: "repair-foreshadow",
          projectId: "default-project",
          requestId: "repair-foreshadow-delete",
          sessionId: "repair-delete",
          eventUid: "repair-foreshadow-delete-event",
          origin: "human",
          originalTransactionId: null,
          baseVersion: 1,
        },
      },
    );
    expect(
      await queryRows(
        reopened,
        "SELECT id FROM foreshadows WHERE id = 'repair-foreshadow'",
      ),
    ).toEqual([]);

    const replay = (direction: "undo" | "redo", requestId: string) =>
      reopened.invoke("agent_apply_undo_journal", {
        payload: {
          requestId,
          projectId: "default-project",
          sessionId: "repair-history",
          journalId: receipt.undoJournalId,
          direction,
        },
      });
    await replay("undo", "repair-delete-undo");
    expect(
      await queryRows(
        reopened,
        `SELECT root.payoff_scene_id, root.payoff_from_pos, root.payoff_to_pos,
                root.payoff_confirmed, root.version,
                (SELECT COUNT(*) FROM foreshadow_setups
                  WHERE foreshadow_id = root.id) AS setups,
                (SELECT COUNT(*) FROM foreshadow_payoffs
                  WHERE foreshadow_id = root.id) AS payoffs,
                (SELECT COUNT(*) FROM foreshadow_setup_payoff_links
                  WHERE foreshadow_id = root.id) AS edges,
                (SELECT COUNT(*) FROM foreshadow_codex_links
                  WHERE foreshadow_id = root.id) AS codex_links
           FROM foreshadows root WHERE root.id = 'repair-foreshadow'`,
      ),
    ).toEqual([
      {
        payoff_scene_id: null,
        payoff_from_pos: null,
        payoff_to_pos: null,
        payoff_confirmed: 1,
        version: 2,
        setups: 1,
        payoffs: 1,
        edges: 1,
        codex_links: 1,
      },
    ]);
    await replay("redo", "repair-delete-redo");
    expect(
      await queryRows(
        reopened,
        "SELECT id FROM foreshadows WHERE id = 'repair-foreshadow'",
      ),
    ).toEqual([]);
  });

  it("repairs an invalid payoff child when the root anchor is already clear", async () => {
    const current = await createMock();
    const runCurrent = (sql: string, params: unknown[] = []) =>
      current.invoke("db_execute", { sql, params, method: "run" });
    await runCurrent(
      `INSERT INTO tree_nodes
        (id, project_id, node_type, title, sort_order)
       VALUES
        ('child-only-payoff-folder', 'default-project', 'folder',
         'Folder', 'a0'),
        ('child-only-setup-scene', 'default-project', 'scene',
         'Setup scene', 'a1')`,
    );
    await runCurrent(
      `INSERT INTO foreshadows
        (id, project_id, title, version, created_at, updated_at)
       VALUES ('child-only-foreshadow', 'default-project', 'Child only',
               0, 100, 200)`,
    );
    await runCurrent(
      `INSERT INTO foreshadow_payoffs
        (id, foreshadow_id, scene_id, role, confirmed, is_primary,
         attribution, is_orphan, semantic_key, created_at, updated_at)
       VALUES ('child-only-invalid-payoff', 'child-only-foreshadow',
               'child-only-payoff-folder', 'primary', 1, 1, 'human', 0,
               'child-only-foreshadow|child-only-payoff-folder||', 100, 200)`,
    );
    await runCurrent(
      `INSERT INTO foreshadow_setups
        (id, foreshadow_id, scene_id, from_pos, to_pos, kind, strength,
         attribution, is_orphan, semantic_key, created_at, updated_at)
       VALUES ('child-only-setup', 'child-only-foreshadow',
               'child-only-setup-scene', 1, 3, 'designated_existing',
               'subtle', 'human', 0,
               'child-only-foreshadow|child-only-setup-scene|1|3', 100, 200)`,
    );

    const repairDirty = vi.fn();
    const repaired = await createMock({
      databaseBytes: current.exportDatabase(),
      onDatabaseDirty: repairDirty,
    });
    expect(repairDirty).toHaveBeenCalledTimes(1);
    expect(
      await queryRows(
        repaired,
        `SELECT id FROM foreshadow_payoffs
          WHERE foreshadow_id = 'child-only-foreshadow'`,
      ),
    ).toEqual([]);
    const stateBeforeStaleWrites = await queryRows(
      repaired,
      `SELECT root.title, root.payoff_scene_id, root.payoff_from_pos,
              root.payoff_to_pos, root.version, root.updated_at,
              setup.strength AS setup_strength,
              setup.updated_at AS setup_updated_at
         FROM foreshadows root
         JOIN foreshadow_setups setup
           ON setup.foreshadow_id = root.id
        WHERE root.id = 'child-only-foreshadow'`,
    );
    expect(stateBeforeStaleWrites).toEqual([
      {
        title: "Child only",
        payoff_scene_id: null,
        payoff_from_pos: null,
        payoff_to_pos: null,
        version: 1,
        updated_at: 201,
        setup_strength: "subtle",
        setup_updated_at: 200,
      },
    ]);
    const historyBeforeStaleWrites = await queryRows(
      repaired,
      `SELECT
        (SELECT COUNT(*) FROM undo_journal) AS undo_journals,
        (SELECT COUNT(*) FROM change_events) AS change_events,
        (SELECT COUNT(*) FROM idempotency_requests) AS idempotency_requests`,
    );
    repairDirty.mockClear();

    await expect(
      repaired.invoke("foreshadow_update", {
        id: "child-only-foreshadow",
        patch: {
          projectId: "default-project",
          requestId: "child-only-stale-root-write",
          sessionId: "child-only-stale-session",
          eventUid: "child-only-stale-event",
          origin: "human",
          originalTransactionId: null,
          baseVersion: 0,
          title: "Stale root write",
        },
      }),
    ).rejects.toThrow(/FORESHADOW_VERSION_MISMATCH|version conflict/i);
    await expect(
      repaired.invoke("foreshadow_update_setup", {
        id: "child-only-setup",
        patch: {
          projectId: "default-project",
          requestId: "child-only-stale-setup-write",
          sessionId: "child-only-stale-session",
          eventUid: "child-only-stale-setup-event",
          origin: "human",
          originalTransactionId: null,
          baseVersion: 0,
          strength: "overt",
        },
      }),
    ).rejects.toThrow(/FORESHADOW_VERSION_MISMATCH|version conflict/i);

    expect(
      await queryRows(
        repaired,
        `SELECT root.title, root.payoff_scene_id, root.payoff_from_pos,
                root.payoff_to_pos, root.version, root.updated_at,
                setup.strength AS setup_strength,
                setup.updated_at AS setup_updated_at
           FROM foreshadows root
           JOIN foreshadow_setups setup
             ON setup.foreshadow_id = root.id
          WHERE root.id = 'child-only-foreshadow'`,
      ),
    ).toEqual(stateBeforeStaleWrites);
    expect(
      await queryRows(
        repaired,
        `SELECT
          (SELECT COUNT(*) FROM undo_journal) AS undo_journals,
          (SELECT COUNT(*) FROM change_events) AS change_events,
          (SELECT COUNT(*) FROM idempotency_requests) AS idempotency_requests`,
      ),
    ).toEqual(historyBeforeStaleWrites);
    expect(repairDirty).not.toHaveBeenCalled();

    const reopenedDirty = vi.fn();
    await createMock({
      databaseBytes: repaired.exportDatabase(),
      onDatabaseDirty: reopenedDirty,
    });
    expect(reopenedDirty).not.toHaveBeenCalled();
  });

  it("closes the SQL.js database and rejects subsequent database access", async () => {
    const mock = await createMock();
    mock.close();

    await expect(queryRows(mock, "select 1 as value")).rejects.toThrow();
  });

  it("does not mark initialization or SELECT statements dirty", async () => {
    const onDatabaseDirty = vi.fn();
    const mock = await createMock({ onDatabaseDirty });

    expect(onDatabaseDirty).not.toHaveBeenCalled();
    await queryRows(mock, "select id from projects");
    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("marks a successful run statement dirty exactly once", async () => {
    const onDatabaseDirty = vi.fn();
    const mock = await createMock({ onDatabaseDirty });

    await mock.invoke("db_execute", {
      sql: "insert into app_settings (key, value) values (?, ?)",
      params: ["contract.run", "saved"],
      method: "run",
    });

    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });

  it("marks a successful returning write dirty and persists its result", async () => {
    const onDatabaseDirty = vi.fn();
    const mock = await createMock({ onDatabaseDirty });

    await expect(
      mock.invoke("db_execute", {
        sql: "insert into app_settings (key, value) values (?, ?) returning value",
        params: ["contract.returning", "saved"],
        method: "all",
      }),
    ).resolves.toEqual({ rows: [{ value: "saved" }] });

    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);

    const restored = await createMock({ databaseBytes: mock.exportDatabase() });
    await expect(
      queryRows(restored, "select value from app_settings where key = ?", [
        "contract.returning",
      ]),
    ).resolves.toEqual([{ value: "saved" }]);
  });

  it("marks a committed batch dirty once, not once per statement", async () => {
    const onDatabaseDirty = vi.fn();
    const mock = await createMock({ onDatabaseDirty });

    await mock.invoke("db_execute_batch", {
      statements: [
        {
          sql: "insert into app_settings (key, value) values (?, ?)",
          params: ["contract.batch.a", "A"],
          method: "run",
        },
        {
          sql: "insert into app_settings (key, value) values (?, ?)",
          params: ["contract.batch.b", "B"],
          method: "run",
        },
      ],
    });

    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });

  it("marks a committed batch with returning writes dirty exactly once", async () => {
    const onDatabaseDirty = vi.fn();
    const mock = await createMock({ onDatabaseDirty });

    await mock.invoke("db_execute_batch", {
      statements: [
        {
          sql: "insert into app_settings (key, value) values (?, ?) returning value",
          params: ["contract.batch.returning", "saved"],
          method: "all",
        },
      ],
    });

    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });

  it("does not mark a rolled-back batch dirty and leaves no partial rows", async () => {
    const onDatabaseDirty = vi.fn();
    const mock = await createMock({ onDatabaseDirty });

    await expect(
      mock.invoke("db_execute_batch", {
        statements: [
          {
            sql: "insert into app_settings (key, value) values (?, ?)",
            params: ["contract.rollback", "must-disappear"],
            method: "run",
          },
          {
            sql: "insert into table_that_does_not_exist (value) values (?)",
            params: ["boom"],
            method: "run",
          },
        ],
      }),
    ).rejects.toThrow();

    expect(onDatabaseDirty).not.toHaveBeenCalled();
    expect(
      await queryRows(mock, "select value from app_settings where key = ?", [
        "contract.rollback",
      ]),
    ).toEqual([]);
  });

  it("does not mark a failed run statement dirty", async () => {
    const onDatabaseDirty = vi.fn();
    const mock = await createMock({ onDatabaseDirty });

    await expect(
      mock.invoke("db_execute", {
        sql: "insert into table_that_does_not_exist (value) values (?)",
        params: ["boom"],
        method: "run",
      }),
    ).rejects.toThrow();

    expect(onDatabaseDirty).not.toHaveBeenCalled();
  });

  it("marks a committed timelapse batch dirty exactly once", async () => {
    const onDatabaseDirty = vi.fn();
    const mock = await createMock({ onDatabaseDirty });

    await mock.invoke("timelapse_append_batch", {
      projectId: "default-project",
      sessionId: "persistence-contract-session",
      events: [
        {
          eventUid: "persistence-contract-event",
          sceneId: null,
          domain: "editor",
          opType: "change",
          entityType: "scene",
          entityId: null,
          payload: "{}",
          timestamp: 1_700_000_000_000,
        },
      ],
    });

    expect(onDatabaseDirty).toHaveBeenCalledTimes(1);
  });
});
