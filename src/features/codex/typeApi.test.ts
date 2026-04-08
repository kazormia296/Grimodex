import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import { codexTypes } from "@/db/schema";
import { eq } from "drizzle-orm";

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

describe("typeApi query generation", () => {
  it("lists codex types by projectId, ordered by sortOrder", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .select()
      .from(codexTypes)
      .where(eq(codexTypes.projectId, "proj-1"))
      .orderBy(codexTypes.sortOrder);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("codex_types");
    expect(queries[0].params).toContain("proj-1");
    expect(queries[0].sql).toContain("sort_order");
  });

  it("inserts a new codex type", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(codexTypes)
      .values({
        id: "type-1",
        projectId: "proj-1",
        slug: "faction",
        label: "勢力",
        color: "#4A90D9",
        isBuiltin: 0,
        sortOrder: 5.0,
        createdAt: "2024-01-01T00:00:00Z",
      })
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].params).toContain("faction");
    expect(queries[0].params).toContain("勢力");
    expect(queries[0].params).toContain(0);
  });

  it("inserts a builtin codex type", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(codexTypes)
      .values({
        id: "builtin-char",
        projectId: "proj-1",
        slug: "character",
        label: "キャラクター",
        color: "#6B7ADB",
        isBuiltin: 1,
        sortOrder: 1.0,
        createdAt: "2024-01-01T00:00:00Z",
      })
      .returning();
    expect(queries[0].params).toContain(1);
    expect(queries[0].params).toContain("character");
  });

  it("updates label and color of a type", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(codexTypes)
      .set({ label: "新ラベル", color: "#FF0000" })
      .where(eq(codexTypes.id, "type-1"))
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain("新ラベル");
    expect(queries[0].params).toContain("#FF0000");
  });

  it("deletes a codex type by id", async () => {
    const { db, queries } = createQueryCapture();
    await db.delete(codexTypes).where(eq(codexTypes.id, "type-1"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("delete");
    expect(queries[0].params).toContain("type-1");
  });

  it("queries types by slug for exists check", async () => {
    const { db, queries } = createQueryCapture();
    await db.select().from(codexTypes).where(eq(codexTypes.slug, "character"));
    expect(queries).toHaveLength(1);
    expect(queries[0].params).toContain("character");
  });
});
