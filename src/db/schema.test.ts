import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq, getTableName } from "drizzle-orm";
import {
  projects,
  treeNodes,
  codexEntries,
  codexTypes,
  codexTags,
  codexEntryTags,
  codexDetailDefinitions,
  codexDetailValues,
  snippets,
  chatSessions,
  chatMessages,
  authorshipSpans,
  contentVersions,
  projectSnapshots,
  projectSnapshotEntries,
  settings,
  codexRelationDismissed,
} from "./schema";
import * as schema from "./schema";

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

  it("generates valid insert query with text id", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(projects).values({
      id: "proj-001",
      title: "My Novel",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries.length).toBe(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("projects");
    expect(executedQueries[0].params).toContain("proj-001");
    expect(executedQueries[0].params).toContain("My Novel");
  });
});

describe("treeNodes schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(treeNodes)).toBe("tree_nodes");
  });

  it("has all required columns", () => {
    const columns = Object.keys(treeNodes);
    expect(columns).toContain("id");
    expect(columns).toContain("projectId");
    expect(columns).toContain("parentId");
    expect(columns).toContain("nodeType");
    expect(columns).toContain("title");
    expect(columns).toContain("synopsis");
    expect(columns).toContain("sortOrder");
    expect(columns).toContain("status");
    expect(columns).toContain("content");
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
    await db.insert(treeNodes).values({
      id: uuid,
      projectId: "proj-001",
      nodeType: "scene",
      title: "Opening Scene",
      sortOrder: 0,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("tree_nodes");
    expect(executedQueries[0].params).toContain(uuid);
  });

  it("generates valid insert with parentId for nested nodes", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(treeNodes).values({
      id: "node-child",
      projectId: "proj-001",
      parentId: "node-parent",
      nodeType: "chapter",
      title: "Chapter 1",
      sortOrder: 1,
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries[0].params).toContain("node-parent");
    expect(executedQueries[0].params).toContain("chapter");
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

    await db
      .select()
      .from(treeNodes)
      .where(eq(treeNodes.projectId, "proj-001"));
    expect(executedQueries[0]).toContain("tree_nodes");
    expect(executedQueries[0]).toContain("project_id");
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
      .update(treeNodes)
      .set({ title: "Updated Scene" })
      .where(eq(treeNodes.id, "some-uuid"));
    expect(executedQueries[0].sql).toContain("update");
    expect(executedQueries[0].sql).toContain("tree_nodes");
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

    await db.delete(treeNodes).where(eq(treeNodes.id, "some-uuid"));
    expect(executedQueries[0]).toContain("delete");
    expect(executedQueries[0]).toContain("tree_nodes");
  });
});

describe("codexEntries schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(codexEntries)).toBe("codex_entries");
  });

  it("has all required columns", () => {
    const columns = Object.keys(codexEntries);
    expect(columns).toContain("id");
    expect(columns).toContain("projectId");
    expect(columns).toContain("parentId");
    expect(columns).toContain("type");
    expect(columns).toContain("name");
    expect(columns).toContain("aliases");
    expect(columns).toContain("excludedAliases");
    expect(columns).toContain("summary");
    expect(columns).toContain("content");
    expect(columns).toContain("icon");
    expect(columns).toContain("tagsCache");
    expect(columns).toContain("contextMode");
    expect(columns).toContain("sourceChatMessageId");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("updatedAt");
  });

  it("generates valid insert query with text id", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(codexEntries).values({
      id: "codex-001",
      projectId: "proj-001",
      type: "character",
      name: "太郎",
      summary: "主人公",
      tagsCache: '["主人公","勇者"]',
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("codex_entries");
    expect(executedQueries[0].params).toContain("character");
    expect(executedQueries[0].params).toContain("太郎");
  });

  it("allows nullable parentId and sourceChatMessageId", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(codexEntries).values({
      id: "codex-002",
      projectId: "proj-001",
      parentId: "codex-001",
      type: "location",
      name: "魔王城",
      summary: "最終ダンジョン",
      sourceChatMessageId: "msg-123",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries[0].params).toContain("codex-001");
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
      .where(eq(codexEntries.id, "codex-001"));
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

    await db.delete(codexEntries).where(eq(codexEntries.id, "codex-001"));
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
    expect(columns).toContain("projectId");
    expect(columns).toContain("title");
    expect(columns).toContain("content");
    expect(columns).toContain("tagsCache");
    expect(columns).toContain("contentSource");
    expect(columns).toContain("sceneId");
    expect(columns).toContain("sourceChatMessageId");
    expect(columns).toContain("usageCount");
    expect(columns).toContain("createdAt");
    expect(columns).toContain("updatedAt");
    expect(columns).not.toContain("tags");
  });

  it("generates valid insert query with text id", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(snippets).values({
      id: "snip-001",
      projectId: "proj-001",
      title: "冒頭の描写",
      content: "暗い森の中、一筋の光が差し込んだ。",
      tagsCache: '["描写","森"]',
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("snippets");
    expect(executedQueries[0].params).toContain("冒頭の描写");
  });

  it("allows nullable sceneId and sourceChatMessageId", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(snippets).values({
      id: "snip-002",
      projectId: "proj-001",
      title: "メモ",
      content: "後で使う設定メモ",
      tagsCache: "[]",
      contentSource: "ai",
      sceneId: "scene-uuid-1",
      sourceChatMessageId: "msg-456",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries[0].params).toContain("scene-uuid-1");
    expect(executedQueries[0].params).toContain("msg-456");
  });

  it("generates valid select by projectId", async () => {
    const executedQueries: string[] = [];
    const db = drizzle<typeof schema>(
      async (sql, _params, _method) => {
        executedQueries.push(sql);
        return { rows: [] };
      },
      { schema },
    );

    await db.select().from(snippets).where(eq(snippets.projectId, "proj-001"));
    expect(executedQueries[0]).toContain("snippets");
    expect(executedQueries[0]).toContain("project_id");
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

    await db.delete(snippets).where(eq(snippets.id, "snip-001"));
    expect(executedQueries[0]).toContain("delete");
    expect(executedQueries[0]).toContain("snippets");
  });
});

describe("chatSessions schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(chatSessions)).toBe("chat_sessions");
  });

  it("has all required columns", () => {
    const columns = Object.keys(chatSessions);
    expect(columns).toContain("id");
    expect(columns).toContain("projectId");
    expect(columns).toContain("nodeId");
    expect(columns).toContain("title");
    expect(columns).toContain("titleManual");
    expect(columns).toContain("model");
    expect(columns).toContain("pinnedCodex");
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

    await db.insert(chatSessions).values({
      id: "sess-001",
      projectId: "proj-001",
      nodeId: "node-001",
      title: "Character discussion",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("chat_sessions");
    expect(executedQueries[0].params).toContain("sess-001");
  });
});

describe("chatMessages schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(chatMessages)).toBe("chat_messages");
  });

  it("has all required columns", () => {
    const columns = Object.keys(chatMessages);
    expect(columns).toContain("id");
    expect(columns).toContain("sessionId");
    expect(columns).toContain("role");
    expect(columns).toContain("content");
    expect(columns).toContain("model");
    expect(columns).toContain("tokensIn");
    expect(columns).toContain("tokensOut");
    expect(columns).toContain("durationMs");
    expect(columns).toContain("metadata");
    expect(columns).toContain("createdAt");
  });

  it("generates valid insert query with sessionId FK", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(chatMessages).values({
      id: "msg-001",
      sessionId: "sess-001",
      role: "user",
      content: "キャラクターの設定について",
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("chat_messages");
    expect(executedQueries[0].params).toContain("sess-001");
    expect(executedQueries[0].params).toContain("user");
  });

  it("generates valid select by sessionId", async () => {
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
      .from(chatMessages)
      .where(eq(chatMessages.sessionId, "sess-001"));
    expect(executedQueries[0]).toContain("chat_messages");
    expect(executedQueries[0]).toContain("session_id");
  });
});

describe("authorshipSpans schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(authorshipSpans)).toBe("authorship_spans");
  });

  it("has all required columns", () => {
    const columns = Object.keys(authorshipSpans);
    expect(columns).toContain("id");
    expect(columns).toContain("nodeId");
    expect(columns).toContain("codexEntryId");
    expect(columns).toContain("snippetId");
    expect(columns).toContain("detailValueId");
    expect(columns).toContain("fromPos");
    expect(columns).toContain("toPos");
    expect(columns).toContain("source");
    expect(columns).toContain("model");
    expect(columns).toContain("timestamp");
    expect(columns).toContain("chatMsgId");
    expect(columns).toContain("phaseId");
  });

  it("generates valid insert query for scene span", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(authorshipSpans).values({
      id: "span-001",
      nodeId: "node-001",
      fromPos: 0,
      toPos: 100,
      source: "human",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("insert");
    expect(executedQueries[0].sql).toContain("authorship_spans");
    expect(executedQueries[0].params).toContain("human");
  });

  it("generates valid insert query for codex span", async () => {
    const executedQueries: { sql: string; params: unknown[] }[] = [];
    const db = drizzle<typeof schema>(
      async (sql, params, _method) => {
        executedQueries.push({ sql, params });
        return { rows: [] };
      },
      { schema },
    );

    await db.insert(authorshipSpans).values({
      id: "span-002",
      codexEntryId: "codex-001",
      fromPos: 10,
      toPos: 50,
      source: "ai",
      model: "claude-sonnet",
    });
    expect(executedQueries[0].params).toContain("codex-001");
    expect(executedQueries[0].params).toContain("ai");
  });
});

describe("settings schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(settings)).toBe("settings");
  });

  it("has all required columns", () => {
    const columns = Object.keys(settings);
    expect(columns).toContain("key");
    expect(columns).toContain("value");
  });
});

describe("codexRelationDismissed schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(codexRelationDismissed)).toBe(
      "codex_relation_dismissed",
    );
  });

  it("has all required columns", () => {
    const columns = Object.keys(codexRelationDismissed);
    expect(columns).toContain("entryId");
    expect(columns).toContain("dismissedId");
  });
});

describe("codexTypes schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(codexTypes)).toBe("codex_types");
  });

  it("has all required columns", () => {
    const columns = Object.keys(codexTypes);
    expect(columns).toContain("id");
    expect(columns).toContain("projectId");
    expect(columns).toContain("slug");
    expect(columns).toContain("label");
    expect(columns).toContain("color");
    expect(columns).toContain("icon");
    expect(columns).toContain("isBuiltin");
    expect(columns).toContain("sortOrder");
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

    await db.insert(codexTypes).values({
      id: "type-001",
      projectId: "proj-001",
      slug: "faction",
      label: "勢力",
      color: "#ff6b6b",
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("codex_types");
    expect(executedQueries[0].params).toContain("faction");
    expect(executedQueries[0].params).toContain("勢力");
  });
});

describe("codexTags schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(codexTags)).toBe("codex_tags");
  });

  it("has all required columns", () => {
    const columns = Object.keys(codexTags);
    expect(columns).toContain("id");
    expect(columns).toContain("projectId");
    expect(columns).toContain("name");
    expect(columns).toContain("color");
    expect(columns).toContain("typeFilter");
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

    await db.insert(codexTags).values({
      id: "tag-001",
      projectId: "proj-001",
      name: "protagonist",
      color: "#534AB7",
      typeFilter: '["character"]',
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("codex_tags");
    expect(executedQueries[0].params).toContain("protagonist");
  });
});

describe("codexEntryTags schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(codexEntryTags)).toBe("codex_entry_tags");
  });

  it("has all required columns", () => {
    const columns = Object.keys(codexEntryTags);
    expect(columns).toContain("entryId");
    expect(columns).toContain("tagId");
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

    await db.insert(codexEntryTags).values({
      entryId: "codex-001",
      tagId: "tag-001",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("codex_entry_tags");
  });
});

describe("codexDetailDefinitions schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(codexDetailDefinitions)).toBe(
      "codex_detail_definitions",
    );
  });

  it("has all required columns", () => {
    const columns = Object.keys(codexDetailDefinitions);
    expect(columns).toContain("id");
    expect(columns).toContain("projectId");
    expect(columns).toContain("typeSlug");
    expect(columns).toContain("name");
    expect(columns).toContain("fieldType");
    expect(columns).toContain("fieldConfig");
    expect(columns).toContain("sortOrder");
    expect(columns).toContain("includeInContext");
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

    await db.insert(codexDetailDefinitions).values({
      id: "def-001",
      projectId: "proj-001",
      typeSlug: "character",
      name: "種族",
      fieldType: "dropdown",
      fieldConfig: '{"options":["人間","エルフ","ドワーフ"]}',
      includeInContext: 1,
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("codex_detail_definitions");
    expect(executedQueries[0].params).toContain("種族");
    expect(executedQueries[0].params).toContain("dropdown");
  });
});

describe("codexDetailValues schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(codexDetailValues)).toBe("codex_detail_values");
  });

  it("has all required columns", () => {
    const columns = Object.keys(codexDetailValues);
    expect(columns).toContain("id");
    expect(columns).toContain("entryId");
    expect(columns).toContain("definitionId");
    expect(columns).toContain("value");
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

    await db.insert(codexDetailValues).values({
      id: "val-001",
      entryId: "codex-001",
      definitionId: "def-001",
      value: "人間",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("codex_detail_values");
    expect(executedQueries[0].params).toContain("人間");
  });
});

describe("contentVersions schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(contentVersions)).toBe("content_versions");
  });

  it("has all required columns", () => {
    const columns = Object.keys(contentVersions);
    expect(columns).toContain("id");
    expect(columns).toContain("entityType");
    expect(columns).toContain("entityId");
    expect(columns).toContain("content");
    expect(columns).toContain("versionNumber");
    expect(columns).toContain("snapshotType");
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

    await db.insert(contentVersions).values({
      id: "cv-001",
      entityType: "scene",
      entityId: "node-001",
      content: "{}",
      versionNumber: 1,
      snapshotType: "auto",
      createdAt: "2025-01-01T00:00:00Z",
    });
    expect(executedQueries).toHaveLength(1);
    expect(executedQueries[0].sql).toContain("content_versions");
    expect(executedQueries[0].params).toContain("scene");
  });
});

describe("projectSnapshots schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(projectSnapshots)).toBe("project_snapshots");
  });

  it("has all required columns", () => {
    const columns = Object.keys(projectSnapshots);
    expect(columns).toContain("id");
    expect(columns).toContain("projectId");
    expect(columns).toContain("name");
    expect(columns).toContain("description");
    expect(columns).toContain("createdAt");
  });
});

describe("projectSnapshotEntries schema", () => {
  it("has the correct table name", () => {
    expect(getTableName(projectSnapshotEntries)).toBe(
      "project_snapshot_entries",
    );
  });

  it("has all required columns", () => {
    const columns = Object.keys(projectSnapshotEntries);
    expect(columns).toContain("snapshotId");
    expect(columns).toContain("versionId");
  });
});

describe("cross-table relationships", () => {
  it("all tables are accessible from the schema", () => {
    const db = createTestDb();
    expect(db).toBeDefined();
    expect(getTableName(projects)).toBe("projects");
    expect(getTableName(treeNodes)).toBe("tree_nodes");
    expect(getTableName(codexTypes)).toBe("codex_types");
    expect(getTableName(codexEntries)).toBe("codex_entries");
    expect(getTableName(codexTags)).toBe("codex_tags");
    expect(getTableName(codexEntryTags)).toBe("codex_entry_tags");
    expect(getTableName(codexDetailDefinitions)).toBe(
      "codex_detail_definitions",
    );
    expect(getTableName(codexDetailValues)).toBe("codex_detail_values");
    expect(getTableName(snippets)).toBe("snippets");
    expect(getTableName(chatSessions)).toBe("chat_sessions");
    expect(getTableName(chatMessages)).toBe("chat_messages");
    expect(getTableName(authorshipSpans)).toBe("authorship_spans");
    expect(getTableName(contentVersions)).toBe("content_versions");
    expect(getTableName(projectSnapshots)).toBe("project_snapshots");
    expect(getTableName(projectSnapshotEntries)).toBe(
      "project_snapshot_entries",
    );
    expect(getTableName(settings)).toBe("settings");
  });
});
