import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import { codexTags, codexEntryTags, codexEntries } from "@/db/schema";
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

describe("tagApi query generation", () => {
  it("lists codex tags by projectId", async () => {
    const { db, queries } = createQueryCapture();
    await db.select().from(codexTags).where(eq(codexTags.projectId, "proj-1"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("codex_tags");
    expect(queries[0].params).toContain("proj-1");
  });

  it("creates a codex tag with name and color", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(codexTags)
      .values({
        id: "tag-1",
        projectId: "proj-1",
        name: "主人公",
        color: "#534AB7",
        createdAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].params).toContain("tag-1");
    expect(queries[0].params).toContain("主人公");
    expect(queries[0].params).toContain("#534AB7");
  });

  it("creates a codex tag without color", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(codexTags)
      .values({
        id: "tag-2",
        projectId: "proj-1",
        name: "サブキャラ",
        createdAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries[0].params).toContain("サブキャラ");
  });

  it("updates a codex tag name and color", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(codexTags)
      .set({ name: "新しい名前", color: "#0F6E56" })
      .where(eq(codexTags.id, "tag-1"))
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain("新しい名前");
    expect(queries[0].params).toContain("#0F6E56");
  });

  it("deletes a codex tag by id", async () => {
    const { db, queries } = createQueryCapture();
    await db.delete(codexTags).where(eq(codexTags.id, "tag-1"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("delete");
    expect(queries[0].sql).toContain("codex_tags");
  });

  it("lists entry tags by entryId via join", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .select({ tag: codexTags })
      .from(codexEntryTags)
      .innerJoin(codexTags, eq(codexEntryTags.tagId, codexTags.id))
      .where(eq(codexEntryTags.entryId, "entry-1"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("codex_entry_tags");
    expect(queries[0].sql).toContain("codex_tags");
    expect(queries[0].params).toContain("entry-1");
  });

  it("inserts entry-tag associations", async () => {
    const { db, queries } = createQueryCapture();
    await db.insert(codexEntryTags).values([
      { entryId: "entry-1", tagId: "tag-1" },
      { entryId: "entry-1", tagId: "tag-2" },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].sql).toContain("codex_entry_tags");
  });

  it("deletes all entry-tag associations for an entry", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .delete(codexEntryTags)
      .where(eq(codexEntryTags.entryId, "entry-1"));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("delete");
    expect(queries[0].params).toContain("entry-1");
  });

  it("updates tagsCache on codex entries", async () => {
    const { db, queries } = createQueryCapture();
    const tagNames = JSON.stringify(["主人公", "魔法使い"]);
    await db
      .update(codexEntries)
      .set({ tagsCache: tagNames, updatedAt: "2025-06-01T00:00:00Z" })
      .where(eq(codexEntries.id, "entry-1"))
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain(tagNames);
  });
});
