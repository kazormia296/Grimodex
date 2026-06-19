import { describe, it, expect } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { eq, and, sql, desc } from "drizzle-orm";
import { promptTemplates } from "@/db/schema";
import * as schema from "@/db/schema";

function createQueryCapture() {
  const queries: { sql: string; params: unknown[]; method: string }[] = [];
  const db = drizzle<typeof schema>(
    async (sqlText, params, method) => {
      queries.push({ sql: sqlText, params, method });
      return { rows: [] };
    },
    { schema },
  );
  return { db, queries };
}

describe("prompt-library API query generation", () => {
  it("lists templates scoped by project_id, newest first", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .select()
      .from(promptTemplates)
      .where(eq(promptTemplates.projectId, "project-1"))
      .orderBy(desc(promptTemplates.createdAt));
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("prompt_templates");
    expect(queries[0].sql).toContain("project_id");
    expect(queries[0].sql).toContain("order by");
    expect(queries[0].params).toContain("project-1");
  });

  it("gets a single template scoped by id AND project_id", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .select()
      .from(promptTemplates)
      .where(
        and(
          eq(promptTemplates.id, "tpl-1"),
          eq(promptTemplates.projectId, "project-1"),
        ),
      );
    expect(queries[0].sql).toContain("prompt_templates");
    // cross-project read を塞ぐため両条件が乗る
    expect(queries[0].params).toContain("tpl-1");
    expect(queries[0].params).toContain("project-1");
  });

  it("creates a template with the required fields", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .insert(promptTemplates)
      .values({
        id: "tpl-1",
        projectId: "project-1",
        title: "文体整形プロンプト",
        content: "次の文章の文体を整えてください。",
        createdAt: "2025-01-01T00:00:00Z",
        updatedAt: "2025-01-01T00:00:00Z",
      })
      .returning();
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toContain("insert");
    expect(queries[0].params).toContain("文体整形プロンプト");
    expect(queries[0].params).toContain("次の文章の文体を整えてください。");
  });

  it("updates title/content with project scope", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(promptTemplates)
      .set({ title: "更新後", content: "更新本文" })
      .where(
        and(
          eq(promptTemplates.id, "tpl-1"),
          eq(promptTemplates.projectId, "project-1"),
        ),
      )
      .returning();
    expect(queries[0].sql).toContain("update");
    expect(queries[0].params).toContain("更新後");
    expect(queries[0].params).toContain("project-1");
  });

  it("increments usage_count via SQL expression scoped by project_id", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .update(promptTemplates)
      .set({ usageCount: sql`${promptTemplates.usageCount} + 1` })
      .where(
        and(
          eq(promptTemplates.id, "tpl-1"),
          eq(promptTemplates.projectId, "project-1"),
        ),
      );
    expect(queries[0].sql).toContain("update");
    expect(queries[0].sql).toContain(
      '"usage_count" = "prompt_templates"."usage_count" + 1',
    );
    expect(queries[0].params).toContain("project-1");
  });

  it("deletes a template scoped by id AND project_id", async () => {
    const { db, queries } = createQueryCapture();
    await db
      .delete(promptTemplates)
      .where(
        and(
          eq(promptTemplates.id, "tpl-1"),
          eq(promptTemplates.projectId, "project-1"),
        ),
      );
    expect(queries[0].sql).toContain("delete");
    expect(queries[0].sql).toContain("prompt_templates");
    expect(queries[0].params).toContain("tpl-1");
    expect(queries[0].params).toContain("project-1");
  });
});
