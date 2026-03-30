import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import { snippets } from "@/db/schema";
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

describe("snippet API query generation", () => {
  it("lists all snippets", async () => {
    const { db, queries } = createQueryCapture();
    await db.select().from(snippets);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("snippets");
  });

  it("lists snippets filtered by scene_id", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .select()
      .from(snippets)
      .where(eq(snippets.sceneId, "scene-uuid-1"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("snippets");
    expect(queries[0].sql).toContain("scene_id");
  });

  it("creates a snippet with required fields", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(snippets)
      .values({
        title: "伏線メモ",
        content: "第3章で回収する伏線の詳細。",
        tags: "伏線,第3章",
        createdAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].params).toContain("伏線メモ");
  });

  it("creates a snippet with optional scene_id and source", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(snippets)
      .values({
        title: "シーン固有メモ",
        content: "このシーンの雰囲気について。",
        tags: "雰囲気",
        sceneId: "scene-uuid-2",
        sourceChatMessageId: "chat-msg-002",
        createdAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries[0].params).toContain("scene-uuid-2");
    expect(queries[0].params).toContain("chat-msg-002");
  });

  it("updates a snippet", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(snippets)
      .set({ title: "更新されたタイトル", content: "更新された内容" })
      .where(eq(snippets.id, 1))
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain("更新されたタイトル");
  });

  it("deletes a snippet by id", async () => {
    const { db, queries } = createQueryCapture();
    await db.delete(snippets).where(eq(snippets.id, 1));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("delete");
    expect(queries[0].sql).toContain("snippets");
  });
});
