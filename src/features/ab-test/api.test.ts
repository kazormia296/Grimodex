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

import { createAbRun, listAbRuns, setAbRunChosen } from "./api";

beforeEach(() => {
  h.queries.length = 0;
  h.rowsRef.current = { rows: [] };
});

describe("ab-test api (N-slot runs)", () => {
  it("createAbRun inserts surface/prompt/chosen and serializes slots as JSON", async () => {
    await createAbRun({
      projectId: "p1",
      surface: "chat",
      prompt: "prompt text",
      slots: [
        {
          slotId: "baseline",
          provider: null,
          model: null,
          promptVariant: null,
          ok: true,
          response: "resp base",
        },
        {
          slotId: "s2",
          provider: "sakana",
          model: "fugu",
          promptVariant: "terse",
          ok: true,
          response: "resp s2",
        },
      ],
    });
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("insert");
    expect(h.queries[0].sql).toContain("ab_comparison_runs");
    expect(h.queries[0].params).toContain("p1");
    expect(h.queries[0].params).toContain("chat");
    // slots is a JSON string holding both slot records.
    const slotsParam = h.queries[0].params.find(
      (p): p is string => typeof p === "string" && p.startsWith("["),
    );
    expect(slotsParam).toBeDefined();
    const parsed = JSON.parse(slotsParam!);
    expect(parsed).toHaveLength(2);
    expect(parsed[1]).toMatchObject({
      slotId: "s2",
      provider: "sakana",
      model: "fugu",
      response: "resp s2",
    });
  });

  it("listAbRuns filters by project and orders by created_at desc", async () => {
    await listAbRuns("p1");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("ab_comparison_runs");
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].sql.toLowerCase()).toContain("order by");
    expect(h.queries[0].params).toContain("p1");
  });

  it("setAbRunChosen updates with id AND project_id scope (fail-closed)", async () => {
    await setAbRunChosen("p1", "id-1", "s2");
    expect(h.queries).toHaveLength(1);
    expect(h.queries[0].sql).toContain("update");
    expect(h.queries[0].sql).toContain("ab_comparison_runs");
    expect(h.queries[0].sql).toContain("project_id");
    expect(h.queries[0].params).toContain("s2");
    expect(h.queries[0].params).toContain("p1");
    expect(h.queries[0].params).toContain("id-1");
  });
});
