// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

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
});
