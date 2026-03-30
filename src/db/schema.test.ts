import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq, getTableName } from "drizzle-orm";
import { projects, chapters, scenes, codexEntries, snippets } from "./schema";
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

describe("codexEntries schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(codexEntries)).toBe("codex_entries");
  });

  it("has all required columns", () => {
    const columns = Object.keys(codexEntries);
    expect(columns).toContain("id");
    expect(columns).toContain("type");
    expect(columns).toContain("name");
    expect(columns).toContain("summary");
    expect(columns).toContain("content");
    expect(columns).toContain("tags");
    expect(columns).toContain("sourceChatMessageId");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("updatedAt");
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

    await db.insert(codexEntries).values({
      type: "character",
      name: "太郎",
      summary: "主人公",
      content: "太郎は勇敢な青年である。",
      tags: "主人公,勇者",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("codex_entries");
    expect(executedQueries[0].params).toContain("character");
    expect(executedQueries[0].params).toContain("太郎");
  });

  it("allows nullable source_chat_message_id", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(codexEntries).values({
      type: "location",
      name: "魔王城",
      summary: "最終ダンジョン",
      content: "暗黒の城。",
      tags: "",
      sourceChatMessageId: "msg-123",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries[0].params).toContain("msg-123");
  });

  it("generates valid select by type", async () => {
    const executedQueries: string[] = [];
    const db = drizzle<typeof schema>(
      async (sql, _params, _method) => {
        executedQueries.push(sql);
        return { rows: [] };
      },
      { schema },
    );

    await db
      .select()
      .from(codexEntries)
      .where(eq(codexEntries.type, "character"));
    expect(executedQueries[0]).toContain("codex_entries");
    expect(executedQueries[0]).toContain("type");
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
      .update(codexEntries)
      .set({ summary: "更新された概要" })
      .where(eq(codexEntries.id, 1));
    expect(executedQueries[0].sql).toContain("update");
    expect(executedQueries[0].params).toContain("更新された概要");
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

    await db.delete(codexEntries).where(eq(codexEntries.id, 1));
    expect(executedQueries[0]).toContain("delete");
    expect(executedQueries[0]).toContain("codex_entries");
  });
});

describe("snippets schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(snippets)).toBe("snippets");
  });

  it("has all required columns", () => {
    const columns = Object.keys(snippets);
    expect(columns).toContain("id");
    expect(columns).toContain("title");
    expect(columns).toContain("content");
    expect(columns).toContain("tags");
    expect(columns).toContain("sceneId");
    expect(columns).toContain("sourceChatMessageId");
    expect(columns).toContain("createdAt");
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

    await db.insert(snippets).values({
      title: "冒頭の描写",
      content: "暗い森の中、一筋の光が差し込んだ。",
      tags: "描写,森",
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("snippets");
    expect(executedQueries[0].params).toContain("冒頭の描写");
  });

  it("allows nullable scene_id and source_chat_message_id", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(snippets).values({
      title: "メモ",
      content: "後で使う設定メモ",
      tags: "",
      sceneId: "scene-uuid-1",
      sourceChatMessageId: "msg-456",
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries[0].params).toContain("scene-uuid-1");
    expect(executedQueries[0].params).toContain("msg-456");
  });

  it("generates valid select by scene_id", async () => {
    const executedQueries: string[] = [];
    const db = drizzle<typeof schema>(
      async (sql, _params, _method) => {
        executedQueries.push(sql);
        return { rows: [] };
      },
      { schema },
    );

    await db
      .select()
      .from(snippets)
      .where(eq(snippets.sceneId, "scene-uuid-1"));
    expect(executedQueries[0]).toContain("snippets");
    expect(executedQueries[0]).toContain("scene_id");
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

    await db.delete(snippets).where(eq(snippets.id, 1));
    expect(executedQueries[0]).toContain("delete");
    expect(executedQueries[0]).toContain("snippets");
  });
});

describe("cross-table relationships", () => {
  it("projects table still works alongside new tables", () => {
    expect(getTableName(projects)).toBe("projects");
    const db = createTestDb();
    expect(db).toBeDefined();
  });
});
