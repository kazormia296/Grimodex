import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import { codexEntries } from "@/db/schema";
import * as schema from "@/db/schema";

function createQueryCapture() {
  const queries: { sql: string; params: unknown[]; method: string }[] = [];
  const db = drizzle<typeof schema>(
    async (sql, params, method) => {
      queries.push({ sql, params, method });
      return { rows: [] };
    },
    { schema },
  );
  return { db, queries };
}

describe("codex API query generation", () => {
  it("lists all codex entries", async () => {
    const { db, queries } = createQueryCapture();
    await db.select().from(codexEntries);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("codex_entries");
  });

  it("lists codex entries filtered by type", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .select()
      .from(codexEntries)
      .where(eq(codexEntries.type, "character"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("codex_entries");
    expect(queries[0].sql).toContain("type");
  });

  it("creates a codex entry with all fields", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(codexEntries)
      .values({
        id: "codex-1",
        projectId: "proj-1",
        type: "character",
        name: "花子",
        summary: "ヒロイン",
        tagsCache: "ヒロイン,魔法使い",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].params).toContain("花子");
    expect(queries[0].params).toContain("character");
  });

  it("creates a codex entry with source_chat_message_id", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(codexEntries)
      .values({
        id: "codex-2",
        projectId: "proj-1",
        type: "item",
        name: "聖剣",
        summary: "伝説の武器",
        tagsCache: "武器",
        sourceChatMessageId: "chat-msg-001",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries[0].params).toContain("chat-msg-001");
  });

  it("updates a codex entry", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(codexEntries)
      .set({ name: "更新された名前", updatedAt: "2025-06-01T00:00:00Z" })
      .where(eq(codexEntries.id, "codex-1"))
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain("更新された名前");
  });

  it("deletes a codex entry by id", async () => {
    const { db, queries } = createQueryCapture();
    await db.delete(codexEntries).where(eq(codexEntries.id, "codex-1"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("delete");
    expect(queries[0].sql).toContain("codex_entries");
  });
});
