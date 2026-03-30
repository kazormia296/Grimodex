import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import { scenes } from "@/db/schema";
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

describe("scene API query generation", () => {
  it("lists scenes filtered by chapterId", async () => {
    const { db, queries } = createQueryCapture();
    await db.select().from(scenes).where(eq(scenes.chapterId, 1));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("scenes");
    expect(queries[0].sql).toContain("chapter_id");
  });

  it("creates a scene with UUID id", async () => {
    const { db, queries } = createQueryCapture();
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    await db
      .insert(scenes)
      .values({
        id: uuid,
        chapterId: 1,
        title: "冒頭シーン",
        sortOrder: 0,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].params).toContain(uuid);
    expect(queries[0].params).toContain("冒頭シーン");
  });

  it("updates scene title", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(scenes)
      .set({ title: "改名されたシーン", updatedAt: "2025-06-01T00:00:00Z" })
      .where(eq(scenes.id, "some-uuid"))
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain("改名されたシーン");
  });

  it("updates scene synopsis", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(scenes)
      .set({ synopsis: "新しいあらすじ" })
      .where(eq(scenes.id, "some-uuid"))
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].params).toContain("新しいあらすじ");
  });

  it("deletes a scene by id", async () => {
    const { db, queries } = createQueryCapture();
    await db.delete(scenes).where(eq(scenes.id, "some-uuid"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("delete");
  });
});
