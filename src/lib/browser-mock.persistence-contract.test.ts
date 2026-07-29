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
  const mock = await createPersistentBrowserMock(options);
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
