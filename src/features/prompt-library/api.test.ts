import { describe, it, expect, vi, beforeEach } from "vitest";

// 生成 SQL を捕捉する drizzle-proxy インスタンスで @/db/client を差し替える。
// 状態 (queries / rows) は vi.hoisted で確定させ、async ファクトリから drizzle と
// schema を動的 import して capture db を構築する (alias 解決を Vite に委ねる)。
const h = vi.hoisted(() => {
  const queries: { sql: string; params: unknown[]; method: string }[] = [];
  const rowsRef = { current: { rows: [] as unknown[] | unknown[][] } };
  return { queries, rowsRef };
});

vi.mock("@/db/client", async () => {
  const { drizzle } = await import("drizzle-orm/sqlite-proxy");
  const schema = await import("@/db/schema");
  const db = drizzle<typeof schema>(
    async (sql, params, method) => {
      h.queries.push({ sql, params, method });
      return h.rowsRef.current;
    },
    { schema },
  );
  return { db };
});

import {
  listPromptTemplates,
  getPromptTemplate,
  createPromptTemplate,
  updatePromptTemplate,
  deletePromptTemplate,
  incrementPromptTemplateUsage,
} from "./api";

beforeEach(() => {
  h.queries.length = 0;
  h.rowsRef.current = { rows: [] };
});

describe("prompt-library api", () => {
  it("listPromptTemplates scopes by project_id, newest first", async () => {
    await listPromptTemplates("project-1");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("prompt_templates");
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].sql.toLowerCase()).toContain("order by");
    expect(h.queries[0].params).toContain("project-1");
  });

  it("getPromptTemplate scopes by both id AND project_id (cross-project read を塞ぐ)", async () => {
    await getPromptTemplate("project-1", "tpl-1");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("prompt_templates");
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].params).toContain("tpl-1");
    expect(h.queries[0].params).toContain("project-1");
  });

  it("createPromptTemplate inserts the required fields", async () => {
    h.rowsRef.current = {
      rows: [
        [
          "tpl-1",
          "project-1",
          "文体整形プロンプト",
          "次の文章の文体を整えてください。",
          0,
          "2025-01-01T00:00:00Z",
          "2025-01-01T00:00:00Z",
        ],
      ],
    };
    await createPromptTemplate({
      id: "tpl-1",
      projectId: "project-1",
      title: "文体整形プロンプト",
      content: "次の文章の文体を整えてください。",
    });
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("insert");
    expect(h.queries[0].sql).toContain("prompt_templates");
    expect(h.queries[0].params).toContain("project-1");
    expect(h.queries[0].params).toContain("文体整形プロンプト");
    expect(h.queries[0].params).toContain("次の文章の文体を整えてください。");
  });

  it("updatePromptTemplate updates with id AND project_id scope", async () => {
    await updatePromptTemplate("project-1", "tpl-1", {
      title: "更新後",
      content: "更新本文",
    });
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("update");
    expect(h.queries[0].sql).toContain("prompt_templates");
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].params).toContain("更新後");
    expect(h.queries[0].params).toContain("tpl-1");
    expect(h.queries[0].params).toContain("project-1");
  });

  it("incrementPromptTemplateUsage bumps usage_count scoped by id AND project_id", async () => {
    await incrementPromptTemplateUsage("project-1", "tpl-1");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("update");
    expect(h.queries[0].sql).toContain(
      '"usage_count" = "prompt_templates"."usage_count" + 1',
    );
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].params).toContain("tpl-1");
    expect(h.queries[0].params).toContain("project-1");
  });

  it("deletePromptTemplate deletes with id AND project_id scope", async () => {
    await deletePromptTemplate("project-1", "tpl-1");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("delete");
    expect(h.queries[0].sql).toContain("prompt_templates");
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].params).toContain("tpl-1");
    expect(h.queries[0].params).toContain("project-1");
  });
});
