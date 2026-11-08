// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

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

const SCHEMA_SQL =
  "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name";

// createBrowserMock clones a per-process template of the canonical renderer
// schema instead of replaying the DDL. The canonical-schema sync itself is
// asserted by src/db/schema.contract.test.ts against a template-built mock.
describe("browser mock schema template", () => {
  it("gives every new mock the identical schema and a compact page size", async () => {
    const first = await createBrowserMock();
    const second = await createBrowserMock();
    try {
      const firstSchema = await rows(first, SCHEMA_SQL);
      expect(firstSchema.length).toBeGreaterThan(50);
      expect(await rows(second, SCHEMA_SQL)).toEqual(firstSchema);
      for (const mock of [first, second]) {
        expect(await rows(mock, "PRAGMA page_size")).toEqual([
          { page_size: 1024 },
        ]);
        expect(await rows(mock, "PRAGMA foreign_keys")).toEqual([
          { foreign_keys: 1 },
        ]);
      }
    } finally {
      first.close();
      second.close();
    }
  });

  it("seeds only the default project, its default board and built-in Codex types", async () => {
    const mock = await createBrowserMock();
    try {
      const tables = await rows(
        mock,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      const populated: string[] = [];
      for (const { name } of tables) {
        const [{ n }] = await rows(
          mock,
          `SELECT COUNT(*) AS n FROM "${String(name)}"`,
        );
        if (Number(n) > 0) populated.push(String(name));
      }
      expect(populated.sort()).toEqual([
        "codex_types",
        "map_boards",
        "projects",
      ]);
    } finally {
      mock.close();
    }
  });

  it("keeps clones independent of each other and of the template", async () => {
    const first = await createBrowserMock({
      allowProtectedWriterTestFixtures: true,
    });
    try {
      await rows(
        first,
        "INSERT INTO projects (id, title, language, created_at, updated_at) VALUES ('extra', 'Only first', 'ja', 'x', 'x')",
      );
      expect(await rows(first, "SELECT id FROM projects ORDER BY id")).toEqual([
        { id: "default-project" },
        { id: "extra" },
      ]);
    } finally {
      first.close();
    }
    const second = await createBrowserMock();
    try {
      expect(await rows(second, "SELECT id FROM projects ORDER BY id")).toEqual(
        [{ id: "default-project" }],
      );
    } finally {
      second.close();
    }
  });

  it("keeps a persisted database round-trip identical to a fresh one", async () => {
    const first = await createBrowserMock();
    const bytes = first.exportDatabase();
    const fresh = await createBrowserMock();
    const restored = await createBrowserMock({ databaseBytes: bytes });
    try {
      expect(await rows(restored, SCHEMA_SQL)).toEqual(
        await rows(fresh, SCHEMA_SQL),
      );
    } finally {
      first.close();
      fresh.close();
      restored.close();
    }
  });

  // Each fresh module re-initialises the ASM.js SQLite and (re)builds a
  // template, which is slow when the whole suite runs in parallel.
  describe(
    "on a fresh module (template state is per process)",
    { timeout: 60_000 },
    () => {
      afterEach(() => {
        vi.doUnmock("sql.js/dist/sql-asm.js");
        vi.resetModules();
      });

      // Loads browser-mock with its own template state. `seedScratch` leaves a
      // row in the template's scratch database (the first `new Database()` of
      // the module), as a future seeding migration would. `dropLedger` removes
      // the idempotency ledger right after the canonical DDL runs, so the
      // ensure migrations fire a dirty event on every database that replays
      // them (the current schema fires none, which would make a count of 0
      // pass vacuously).
      async function freshModule(
        shims: { seedScratch?: boolean; dropLedger?: boolean } = {},
      ) {
        vi.resetModules();
        vi.doUnmock("sql.js/dist/sql-asm.js");
        const constructed = { count: 0 };
        if (shims.seedScratch || shims.dropLedger) {
          const actual = await vi.importActual<{
            default: () => Promise<import("sql.js").SqlJsStatic>;
          }>("sql.js/dist/sql-asm.js");
          vi.doMock("sql.js/dist/sql-asm.js", () => ({
            default: async () => {
              const SQL = await actual.default();
              const RealDatabase = SQL.Database;
              class SpyDatabase extends RealDatabase {
                constructor(data?: ArrayLike<number> | Buffer | null) {
                  super(data);
                  constructed.count += 1;
                  if (shims.seedScratch && constructed.count === 1) {
                    this.run(
                      "CREATE TABLE zz_seeded (x); INSERT INTO zz_seeded VALUES (1);",
                    );
                  }
                }
                run(sql: string, params?: never) {
                  const result = super.run(sql, params);
                  if (
                    shims.dropLedger &&
                    sql.includes("CREATE TABLE") &&
                    sql.includes("idempotency_requests")
                  ) {
                    super.run("DROP TABLE idempotency_requests");
                  }
                  return result;
                }
              }
              return { ...SQL, Database: SpyDatabase };
            },
          }));
        }
        const mod = await import("./browser-mock");
        return { create: mod.createBrowserMock, constructed };
      }

      it("replays the same dirty events for a clone as the non-template path fires", async () => {
        const shims = { dropLedger: true };
        const templated = await freshModule(shims);
        let built = 0;
        let cloned = 0;
        // The first new mock builds the template; the second is a pure clone
        // that must replay the dirty events recorded during that build.
        const first = await templated.create({
          onDatabaseDirty: () => {
            built += 1;
          },
        });
        const second = await templated.create({
          onDatabaseDirty: () => {
            cloned += 1;
          },
        });
        // Reference: a template that is unusable makes every new mock run the
        // DDL and the ensure migrations itself, so its dirty count is what a
        // new database always fired before the template existed.
        const legacy = await freshModule({ ...shims, seedScratch: true });
        let replayed = 0;
        const third = await legacy.create({
          onDatabaseDirty: () => {
            replayed += 1;
          },
        });
        try {
          expect(replayed).toBeGreaterThan(0);
          expect(built).toBe(replayed);
          expect(cloned).toBe(replayed);
        } finally {
          first.close();
          second.close();
          third.close();
        }
      });

      it("falls back to replaying the DDL when the template build leaves rows behind", async () => {
        const reference = await freshModule();
        const expected = await reference.create();
        let expectedSchema: Record<string, unknown>[];
        try {
          expectedSchema = await rows(expected, SCHEMA_SQL);
        } finally {
          expected.close();
        }

        const seeded = await freshModule({ seedScratch: true });
        let dirty = 0;
        const first = await seeded.create({
          onDatabaseDirty: () => {
            dirty += 1;
          },
        });
        const second = await seeded.create();
        try {
          // scratch + first mock, then only the second mock: the unusable
          // verdict is cached and no second template build is attempted.
          expect(seeded.constructed.count).toBe(3);
          expect(dirty).toBe(0);
          for (const mock of [first, second]) {
            expect(await rows(mock, SCHEMA_SQL)).toEqual(expectedSchema);
            expect(await rows(mock, "PRAGMA page_size")).toEqual([
              { page_size: 1024 },
            ]);
            expect(
              await rows(mock, "SELECT COUNT(*) AS n FROM projects"),
            ).toEqual([{ n: 1 }]);
          }
        } finally {
          first.close();
          second.close();
        }
      });
    },
  );
});
