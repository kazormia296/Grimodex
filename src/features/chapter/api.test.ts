import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq } from "drizzle-orm";
import { chapters } from "@/db/schema";
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

describe("chapter API query generation", () => {
  it("lists chapters filtered by projectId", async () => {
    const { db, queries } = createQueryCapture();
    await db.select().from(chapters).where(eq(chapters.projectId, 1));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("chapters");
    expect(queries[0].sql).toContain("project_id");
  });

  it("creates a chapter with required fields", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(chapters)
      .values({
        projectId: 1,
        title: "第一章",
        sortOrder: 0,
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].params).toContain("第一章");
    expect(queries[0].params).toContain(1);
    expect(queries[0].params).toContain(0);
  });

  it("updates chapter title and updatedAt", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(chapters)
      .set({ title: "改名された章", updatedAt: "2025-06-01T00:00:00Z" })
      .where(eq(chapters.id, 1))
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain("改名された章");
  });

  it("deletes a chapter by id", async () => {
    const { db, queries } = createQueryCapture();
    await db.delete(chapters).where(eq(chapters.id, 1));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("delete");
  });
});
