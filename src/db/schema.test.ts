import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq, getTableName } from "drizzle-orm";
import { projects, chapters, scenes } from "./schema";
import * as schema from "./schema";

function createTestDb() {
  return drizzle<typeof schema>(
    async (_sql, _params, _method) => {
      return { rows: [] };
    },
    { schema },
  );
}

describe("chapters schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(chapters)).toBe("chapters");
  });

  it("has all required columns", () => {
    const columns = Object.keys(chapters);
    expect(columns).toContain("id");
    expect(columns).toContain("projectId");
    expect(columns).toContain("title");
    expect(columns).toContain("sortOrder");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("updatedAt");
  });

  it("generates valid insert query with projectId FK", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(chapters).values({
      projectId: 1,
      title: "Chapter 1",
      sortOrder: 0,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("chapters");
    expect(executedQueries[0].params).toContain("Chapter 1");
    expect(executedQueries[0].params).toContain(1); // projectId
  });

  it("generates valid select with where clause", async () => {
    const executedQueries: string[] = [];
    const db = drizzle<typeof schema>(
      async (sql, _params, _method) => {
        executedQueries.push(sql);
        return { rows: [] };
      },
      { schema },
    );

    await db.select().from(chapters).where(eq(chapters.projectId, 1));
    expect(executedQueries[0]).toContain("chapters");
    expect(executedQueries[0]).toContain("project_id");
  });
});

describe("scenes schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(scenes)).toBe("scenes");
  });

  it("has all required columns", () => {
    const columns = Object.keys(scenes);
    expect(columns).toContain("id");
    expect(columns).toContain("chapterId");
    expect(columns).toContain("title");
    expect(columns).toContain("sortOrder");
    expect(columns).toContain("synopsis");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("updatedAt");
  });

  it("uses text primary key for UUID", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    await db.insert(scenes).values({
      id: uuid,
      chapterId: 1,
      title: "Opening Scene",
      sortOrder: 0,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("scenes");
    expect(executedQueries[0].params).toContain(uuid);
  });

  it("generates valid update query", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db
      .update(scenes)
      .set({ title: "Updated Scene" })
      .where(eq(scenes.id, "some-uuid"));
    expect(executedQueries[0].sql).toContain("update");
    expect(executedQueries[0].sql).toContain("scenes");
    expect(executedQueries[0].params).toContain("Updated Scene");
  });

  it("generates valid delete query", async () => {
    const executedQueries: string[] = [];
    const db = drizzle<typeof schema>(
      async (sql, _params, _method) => {
        executedQueries.push(sql);
        return { rows: [] };
      },
      { schema },
    );

    await db.delete(scenes).where(eq(scenes.id, "some-uuid"));
    expect(executedQueries[0]).toContain("delete");
    expect(executedQueries[0]).toContain("scenes");
  });
});

describe("cross-table relationships", () => {
  it("projects table still works alongside new tables", () => {
    expect(getTableName(projects)).toBe("projects");
    const db = createTestDb();
    expect(db).toBeDefined();
  });
});
