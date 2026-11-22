import { describe, expect, it, vi } from "vitest";

import type {
  CoreNativeReads,
  CoreReadContext,
  CoreReadDbClient,
  CoreTreeState,
} from "../../mastraRead/ports.js";
import { checkReadSql } from "../../mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../../mastraRead/tables.js";
import { createCoreReadDb } from "./readDb.js";
import { createReadExecutors } from "./readExecutors.js";
import {
  buildLikeOrCondition,
  EXCERPT_MAX_CHARS,
  ftsHitIds,
  orderByIds,
  parseTagsCacheNames,
  plainTextExcerpt,
} from "./searchHelpers.js";
import { treeNodes } from "../db/schema.js";

interface Captured {
  readonly sql: string;
  readonly params: unknown[];
  readonly method: string;
}

const doc = (text: string): string =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  });

/** A statement client that records what it is given and answers by the table of the statement. */
function makeCtx(
  opts: {
    answers?: Record<string, unknown[][]>;
    fts?: CoreNativeReads["fts"];
    projectId?: string | (() => string);
  } = {},
) {
  const captured: Captured[] = [];
  const client: CoreReadDbClient = async (sql, params, method) => {
    captured.push({ sql, params, method });
    const table = /from "([a-z_]+)"/u.exec(sql)?.[1] ?? "";
    return { rows: opts.answers?.[table] ?? [] };
  };
  const fts = vi.fn(opts.fts ?? (async () => []));
  const getTreeState = vi.fn(
    () =>
      ({
        projectId:
          typeof opts.projectId === "function"
            ? opts.projectId()
            : (opts.projectId ?? "p1"),
        nodes: [],
        activeSceneId: null,
      }) as CoreTreeState,
  );
  const ctx: CoreReadContext = {
    getDb: () => createCoreReadDb(client),
    getTreeState,
    body: {
      barrier: "none",
      readSceneBody: async () => "",
      readSceneBodies: async () => new Map<string, string>(),
    },
    native: { fts },
    countTokens: (text) => text.length,
  };
  return { executors: createReadExecutors(ctx), captured, fts, getTreeState };
}

describe("search_scenes", () => {
  it("asks fts for scope scenes with Native's cap (50), trims the query, and passes the project", async () => {
    const { executors, fts } = makeCtx();
    const result = await executors.search_scenes({ query: "  アリア  " });
    expect(fts).toHaveBeenCalledTimes(1);
    expect(fts).toHaveBeenCalledWith({
      projectId: "p1",
      query: "アリア",
      scope: "scenes",
      limit: 50,
    });
    expect(result).toEqual({
      name: "search_scenes",
      content: [],
      summary: "0 scenes found",
      tokensUsed: 2,
    });
  });

  it("does not read the database when fts finds nothing", async () => {
    const { executors, captured } = makeCtx({ fts: async () => [] });
    await executors.search_scenes({ query: "アリア" });
    expect(captured).toEqual([]);
  });

  it("drops an archived scene in its own condition, keeps fts order and cuts to 10", async () => {
    // fts answers 12 scenes, the first two archived: the statement carries the
    // `archived_at is null` condition, and the rows come back in fts order.
    const ids = Array.from({ length: 12 }, (_, i) => `n${i}`);
    const live = ids.slice(2);
    const { executors, captured, fts } = makeCtx({
      fts: async () => ids.map((id) => ({ sourceType: "scene", id })),
      answers: {
        tree_nodes: [...live]
          .reverse()
          .map((id) => [id, `T ${id}`, doc(`本文 ${id}`)]),
      },
    });
    const result = await executors.search_scenes({ query: "アリア" });
    expect(fts).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    const { sql, params, method } = captured[0]!;
    expect(sql).toMatch(/"tree_nodes"\."archived_at" is null/u);
    expect(sql).toMatch(/"tree_nodes"\."node_type" = \?/u);
    expect(params).toEqual(["p1", "scene", ...ids]);
    expect(method).toBe("all");
    expect(checkReadSql(sql, MAIN_READ_TABLE_SET)).toMatchObject({ ok: true });
    expect((result.content as Array<{ id: string }>).map((r) => r.id)).toEqual(
      live.slice(0, 10),
    );
    expect(result.summary).toBe("10 scenes found");
  });

  it("drops a hit whose source type is another scope's, and a short token goes to LIKE-OR without fts", async () => {
    const mixed = makeCtx({
      fts: async () => [
        { sourceType: "codex", id: "c1" },
        { sourceType: "scene", id: "n1" },
      ],
      answers: { tree_nodes: [["n1", "T", doc("x")]] },
    });
    await mixed.executors.search_scenes({ query: "アリア" });
    expect(mixed.captured[0]!.params).toEqual(["p1", "scene", "n1"]);

    const short = makeCtx({
      answers: { tree_nodes: [["n1", "T", doc("魔法")]] },
    });
    const result = await short.executors.search_scenes({ query: "魔法" });
    expect(short.fts).not.toHaveBeenCalled();
    expect(short.captured[0]!.sql).toMatch(/limit \?/u);
    expect(short.captured[0]!.params).toEqual([
      "p1",
      "scene",
      "%魔法%",
      "%魔法%",
      10,
    ]);
    expect(result.content).toEqual([{ id: "n1", title: "T", excerpt: "魔法" }]);
  });

  it("fails closed on a malformed fts answer instead of turning it into 0 found", async () => {
    for (const bad of [
      undefined,
      null,
      "x",
      {},
      { hits: [] },
      [null],
      [1],
      [{ sourceType: "scene" }],
      [{ id: "n1" }],
      [{ sourceType: "scene", id: 3 }],
      [{ sourceType: 1, id: "n1" }],
      [{ sourceType: "scene", id: "n1" }, null],
    ]) {
      const { executors, captured } = makeCtx({ fts: async () => bad });
      await expect(
        executors.search_scenes({ query: "アリア" }),
        JSON.stringify(bad),
      ).rejects.toThrow(/^fts_search: /u);
      expect(captured, JSON.stringify(bad)).toEqual([]);
    }
  });

  it("does not swallow a failure of fts", async () => {
    const { executors } = makeCtx({
      fts: async () => {
        throw new Error("fts down");
      },
    });
    await expect(executors.search_scenes({ query: "アリア" })).rejects.toThrow(
      "fts down",
    );
  });
});

describe("search_snippets", () => {
  it("asks fts for scope snippets with limit 10 and returns the rows in fts order", async () => {
    const { executors, fts, captured } = makeCtx({
      fts: async () => [
        { sourceType: "snippet", id: "s2" },
        { sourceType: "scene", id: "n1" },
        { sourceType: "snippet", id: "s1" },
      ],
      answers: {
        snippets: [
          ["s1", "One", JSON.stringify([{ name: "a", color: null }]), doc("x")],
          ["s2", "Two", null, doc("y")],
        ],
      },
    });
    const result = await executors.search_snippets({ query: "老魔術師" });
    expect(fts).toHaveBeenCalledWith({
      projectId: "p1",
      query: "老魔術師",
      scope: "snippets",
      limit: 10,
    });
    expect(captured[0]!.params).toEqual(["p1", "s2", "s1"]);
    expect(checkReadSql(captured[0]!.sql, MAIN_READ_TABLE_SET)).toMatchObject({
      ok: true,
    });
    expect(result.content).toEqual([
      { id: "s2", title: "Two", tags: [], preview: "y" },
      { id: "s1", title: "One", tags: ["a"], preview: "x" },
    ]);
    expect(result.summary).toBe("2 snippets found");
  });

  it("a short token goes to LIKE-OR over title, content and tags (limit 10, no fts)", async () => {
    const { executors, fts, captured } = makeCtx();
    await executors.search_snippets({ query: "魔法 描写" });
    expect(fts).not.toHaveBeenCalled();
    expect(captured[0]!.params).toEqual([
      "p1",
      ...["魔法", "描写"].flatMap((t) => [`%${t}%`, `%${t}%`, `%${t}%`]),
      10,
    ]);
  });

  it("fails closed on a malformed fts answer", async () => {
    for (const bad of [undefined, {}, [null], [{ sourceType: "snippet" }]]) {
      const { executors } = makeCtx({ fts: async () => bad });
      await expect(
        executors.search_snippets({ query: "老魔術師" }),
        JSON.stringify(bad),
      ).rejects.toThrow(/^fts_search: /u);
    }
  });
});

describe("the project of a search is taken once, before fts is asked", () => {
  it.each([
    ["search_scenes", "アリア", "scene"],
    ["search_snippets", "老魔術師", "snippet"],
  ] as const)(
    "%s: the fts request and the statement that follows it use the same project",
    async (tool, query, sourceType) => {
      let calls = 0;
      const { executors, captured, fts, getTreeState } = makeCtx({
        projectId: () => `p-${++calls}`,
        fts: async () => [{ sourceType, id: "x1" }],
      });
      await executors[tool]({ query });
      expect(getTreeState).toHaveBeenCalledTimes(1);
      expect(fts.mock.calls[0]![0].projectId).toBe("p-1");
      expect(captured[0]!.params[0]).toBe("p-1");
    },
  );
});

describe("the search helpers", () => {
  it("ftsHitIds keeps the ids of one source type in order", () => {
    expect(
      ftsHitIds(
        [
          { sourceType: "scene", id: "b" },
          { sourceType: "snippet", id: "x" },
          { sourceType: "scene", id: "a" },
        ],
        "scene",
      ),
    ).toEqual(["b", "a"]);
    expect(ftsHitIds([], "snippet")).toEqual([]);
  });

  it("orderByIds follows the ids and leaves out a missing row", () => {
    expect(
      orderByIds([{ id: "a" }, { id: "b" }, { id: "c" }], ["c", "z", "a"]),
    ).toEqual([{ id: "c" }, { id: "a" }]);
  });

  it("parseTagsCacheNames reads both stored forms and gives none for a bad value", () => {
    expect(
      parseTagsCacheNames(
        JSON.stringify([{ name: "a", color: "#fff" }, "b", { name: 1 }, ""]),
      ),
    ).toEqual(["a", "b"]);
    for (const v of [null, undefined, "", "not json", "{}", "1"]) {
      expect(parseTagsCacheNames(v as string | null | undefined)).toEqual([]);
    }
  });

  it("plainTextExcerpt centres the cut on the first token and marks the cut sides", () => {
    expect(plainTextExcerpt(null, ["x"])).toBe("");
    expect(plainTextExcerpt(doc("短い本文"), ["本文"])).toBe("短い本文");
    const long = "あ".repeat(300) + "ドラゴン" + "い".repeat(300);
    const excerpt = plainTextExcerpt(doc(long), ["ドラゴン"]);
    expect(excerpt.startsWith("...")).toBe(true);
    expect(excerpt.endsWith("...")).toBe(true);
    expect(excerpt).toContain("ドラゴン");
    expect(excerpt.length).toBe(EXCERPT_MAX_CHARS + 6);
    // No token found: the head, with a mark on the cut side only.
    const head = plainTextExcerpt(doc(long), ["ない語"]);
    expect(head.startsWith("...")).toBe(false);
    expect(head.endsWith("...")).toBe(true);
  });

  it("buildLikeOrCondition needs a token and a column", () => {
    expect(() => buildLikeOrCondition([], [treeNodes.title])).toThrow(
      "search requires at least one token and column",
    );
  });
});
