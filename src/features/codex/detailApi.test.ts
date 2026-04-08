import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import { codexDetailDefinitions, codexDetailValues } from "@/db/schema";
import { eq, and } from "drizzle-orm";

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

describe("detailApi query generation", () => {
  describe("definitions", () => {
    it("lists definitions by projectId and typeSlug, ordered by sortOrder", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .select()
        .from(codexDetailDefinitions)
        .where(
          and(
            eq(codexDetailDefinitions.projectId, "proj-1"),
            eq(codexDetailDefinitions.typeSlug, "character"),
          ),
        )
        .orderBy(codexDetailDefinitions.sortOrder);
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("codex_detail_definitions");
      expect(queries[0].params).toContain("proj-1");
      expect(queries[0].params).toContain("character");
      expect(queries[0].sql).toContain("sort_order");
    });

    it("creates a definition with text fieldType", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .insert(codexDetailDefinitions)
        .values({
          id: "def-1",
          projectId: "proj-1",
          typeSlug: "character",
          name: "身長",
          fieldType: "text",
          sortOrder: 1.0,
          includeInContext: 0,
          createdAt: "2024-01-01T00:00:00Z",
        })
        .returning();
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("insert");
      expect(queries[0].params).toContain("def-1");
      expect(queries[0].params).toContain("身長");
      expect(queries[0].params).toContain("text");
    });

    it("creates a definition with dropdown fieldType and fieldConfig", async () => {
      const { db, queries } = createQueryCapture();
      const fieldConfig = JSON.stringify({ options: ["人間", "エルフ"] });
      await db
        .insert(codexDetailDefinitions)
        .values({
          id: "def-2",
          projectId: "proj-1",
          typeSlug: "character",
          name: "種族",
          fieldType: "dropdown",
          fieldConfig,
          sortOrder: 2.0,
          includeInContext: 1,
          createdAt: "2024-01-01T00:00:00Z",
        })
        .returning();
      expect(queries[0].params).toContain("dropdown");
      expect(queries[0].params).toContain(fieldConfig);
      expect(queries[0].params).toContain(1);
    });

    it("updates a definition name and includeInContext", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .update(codexDetailDefinitions)
        .set({ name: "新しい名前", includeInContext: 1 })
        .where(eq(codexDetailDefinitions.id, "def-1"))
        .returning();
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("update");
      expect(queries[0].params).toContain("新しい名前");
      expect(queries[0].params).toContain(1);
    });

    it("deletes a definition by id", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .delete(codexDetailDefinitions)
        .where(eq(codexDetailDefinitions.id, "def-1"));
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("delete");
      expect(queries[0].params).toContain("def-1");
    });
  });

  describe("values", () => {
    it("lists values by entryId with definition join", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .select({
          value: codexDetailValues,
          definition: codexDetailDefinitions,
        })
        .from(codexDetailValues)
        .innerJoin(
          codexDetailDefinitions,
          eq(codexDetailValues.definitionId, codexDetailDefinitions.id),
        )
        .where(eq(codexDetailValues.entryId, "entry-1"));
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("codex_detail_values");
      expect(queries[0].sql).toContain("codex_detail_definitions");
      expect(queries[0].params).toContain("entry-1");
    });

    it("inserts a new value", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .insert(codexDetailValues)
        .values({
          id: "val-1",
          entryId: "entry-1",
          definitionId: "def-1",
          value: "170cm",
        })
        .returning();
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("insert");
      expect(queries[0].params).toContain("val-1");
      expect(queries[0].params).toContain("170cm");
    });

    it("updates an existing value by entryId and definitionId", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .update(codexDetailValues)
        .set({ value: "175cm" })
        .where(
          and(
            eq(codexDetailValues.entryId, "entry-1"),
            eq(codexDetailValues.definitionId, "def-1"),
          ),
        )
        .returning();
      expect(queries).toHaveLength(1);
      expect(queries[0].sql).toContain("update");
      expect(queries[0].params).toContain("175cm");
    });

    it("queries existing value before upsert (entry+definition lookup)", async () => {
      const { db, queries } = createQueryCapture();
      await db
        .select()
        .from(codexDetailValues)
        .where(
          and(
            eq(codexDetailValues.entryId, "entry-1"),
            eq(codexDetailValues.definitionId, "def-1"),
          ),
        );
      expect(queries).toHaveLength(1);
      expect(queries[0].params).toContain("entry-1");
      expect(queries[0].params).toContain("def-1");
    });
  });
});
