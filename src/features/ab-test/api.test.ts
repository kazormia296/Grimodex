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
  createAbComparison,
  listAbComparisons,
  getAbComparison,
  setAbChosen,
} from "./api";

beforeEach(() => {
  h.queries.length = 0;
  h.rowsRef.current = { rows: [] };
});

describe("ab-test api", () => {
  it("createAbComparison inserts all fields", async () => {
    h.rowsRef.current = {
      rows: [
        [
          "id-1",
          "p1",
          "chat",
          "prompt text",
          "model-a",
          "model-b",
          null,
          null,
          "resp a",
          "resp b",
          null,
          "2025-01-01T00:00:00Z",
        ],
      ],
    };
    await createAbComparison({
      projectId: "p1",
      surface: "chat",
      prompt: "prompt text",
      modelA: "model-a",
      modelB: "model-b",
      responseA: "resp a",
      responseB: "resp b",
    });
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("insert");
    expect(h.queries[0].sql).toContain("ab_comparisons");
    expect(h.queries[0].params).toContain("p1");
    expect(h.queries[0].params).toContain("resp a");
    expect(h.queries[0].params).toContain("model-b");
  });

  it("listAbComparisons filters by project and orders by created_at desc", async () => {
    await listAbComparisons("p1");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("ab_comparisons");
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].sql.toLowerCase()).toContain("order by");
    expect(h.queries[0].params).toContain("p1");
  });

  it("getAbComparison scopes by both id AND project_id (fail-closed)", async () => {
    await getAbComparison("p1", "id-1");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].params).toContain("p1");
    expect(h.queries[0].params).toContain("id-1");
  });

  it("setAbChosen updates with id AND project_id scope", async () => {
    await setAbChosen("p1", "id-1", "b");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("update");
    expect(h.queries[0].sql).toContain("ab_comparisons");
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].params).toContain("b");
    expect(h.queries[0].params).toContain("p1");
    expect(h.queries[0].params).toContain("id-1");
  });
});
