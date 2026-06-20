import { describe, it, expect, vi, beforeEach } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq, getTableName } from "drizzle-orm";
import { projects } from "@/db/schema";
import * as schema from "@/db/schema";

const invokeMock = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const returningMock = vi.fn().mockResolvedValue([{ id: "p1", language: "en" }]);
vi.mock("@/db/client", () => ({
  db: {
    update: () => ({
      set: () => ({ where: () => ({ returning: returningMock }) }),
    }),
  },
}));

import { updateProject } from "./api";

// In-memory store simulating SQLite via the proxy interface
function createTestDb() {
  return drizzle<typeof schema>(
    async (_sql, _params, _method) => {
      return { rows: [] };
    },
    { schema },
  );
}

describe("projects schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(projects)).toBe("projects");
  });

  it("has all required columns", () => {
    const columns = Object.keys(projects);
    expect(columns).toContain("id");
    expect(columns).toContain("title");
    expect(columns).toContain("genre");
    expect(columns).toContain("pov");
    expect(columns).toContain("tense");
    expect(columns).toContain("language");
    expect(columns).toContain("styleGuide");
    expect(columns).toContain("aiInstructions");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("updatedAt");
  });

  it("creates a drizzle db instance with sqlite-proxy", () => {
    const db = createTestDb();
    expect(db).toBeDefined();
    expect(db.select).toBeDefined();
    expect(db.insert).toBeDefined();
    expect(db.update).toBeDefined();
    expect(db.delete).toBeDefined();
  });

  it("generates valid select query", async () => {
    const executedQueries: string[] = [];
    const db = drizzle<typeof schema>(
      async (sql, _params, _method) => {
        executedQueries.push(sql);
        return { rows: [] };
      },
      { schema },
    );

    await db.select().from(projects);
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0]).toContain("select");
    expect(executedQueries[0]).toContain("projects");
  });

  it("generates valid insert query", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(projects).values({
      id: "proj-1",
      title: "My Novel",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("projects");
    expect(executedQueries[0].params).toContain("My Novel");
  });

  it("generates valid update query with where clause", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db
      .update(projects)
      .set({ title: "Updated Title" })
      .where(eq(projects.id, "proj-1"));
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0].sql).toContain("update");
    expect(executedQueries[0].sql).toContain("projects");
    expect(executedQueries[0].params).toContain("Updated Title");
  });

  it("generates valid delete query with where clause", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.delete(projects).where(eq(projects.id, "proj-1"));
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0].sql).toContain("delete");
    expect(executedQueries[0].sql).toContain("projects");
  });
});

describe("updateProject", () => {
  beforeEach(() => invokeMock.mockClear());

  it("rebuilds _en FTS when language is in the patch", async () => {
    await updateProject("p1", { language: "en" });
    expect(invokeMock).toHaveBeenCalledWith("fts_rebuild_en");
  });

  it("does not rebuild _en FTS when language is absent", async () => {
    await updateProject("p1", { title: "New Title" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
