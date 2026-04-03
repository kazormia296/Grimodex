import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
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

describe("relationApi query generation", () => {
  it("listDismissedRelationIds queries codex_relation_dismissed by entry_id", async () => {
    const { db, queries } = createQueryCapture();
    const { codexRelationDismissed } = schema;
    const { eq } = await import("drizzle-orm");

    await db
      .select({ dismissedId: codexRelationDismissed.dismissedId })
      .from(codexRelationDismissed)
      .where(eq(codexRelationDismissed.entryId, "entry-1"));

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("codex_relation_dismissed");
    expect(queries[0].sql).toContain("dismissed_id");
    expect(queries[0].params).toContain("entry-1");
  });

  it("dismissRelation inserts into codex_relation_dismissed", async () => {
    const { db, queries } = createQueryCapture();
    const { codexRelationDismissed } = schema;

    await db
      .insert(codexRelationDismissed)
      .values({ entryId: "entry-1", dismissedId: "entry-2" })
      .onConflictDoNothing();

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].sql).toContain("codex_relation_dismissed");
    expect(queries[0].params).toContain("entry-1");
    expect(queries[0].params).toContain("entry-2");
  });

  it("undismissRelation deletes by both entryId and dismissedId", async () => {
    const { db, queries } = createQueryCapture();
    const { codexRelationDismissed } = schema;
    const { eq, and } = await import("drizzle-orm");

    await db
      .delete(codexRelationDismissed)
      .where(
        and(
          eq(codexRelationDismissed.entryId, "entry-1"),
          eq(codexRelationDismissed.dismissedId, "entry-2"),
        ),
      );

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("delete");
    expect(queries[0].sql).toContain("codex_relation_dismissed");
    expect(queries[0].params).toContain("entry-1");
    expect(queries[0].params).toContain("entry-2");
  });

  it("setParentRelation updates parentId on codexEntries", async () => {
    const { db, queries } = createQueryCapture();
    const { codexEntries } = schema;
    const { eq } = await import("drizzle-orm");

    await db
      .update(codexEntries)
      .set({ parentId: "parent-1", updatedAt: "2025-01-01T00:00:00Z" })
      .where(eq(codexEntries.id, "child-1"));

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].sql).toContain("codex_entries");
    expect(queries[0].sql).toContain("parent_id");
    expect(queries[0].params).toContain("parent-1");
    expect(queries[0].params).toContain("child-1");
  });

  it("setParentRelation with null clears the parentId", async () => {
    const { db, queries } = createQueryCapture();
    const { codexEntries } = schema;
    const { eq } = await import("drizzle-orm");

    await db
      .update(codexEntries)
      .set({ parentId: null, updatedAt: "2025-01-01T00:00:00Z" })
      .where(eq(codexEntries.id, "child-1"));

    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain(null);
  });
});
