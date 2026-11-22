import { describe, expect, it, vi } from "vitest";

import {
  CoreProjectRequiredError,
  type CoreNativeReads,
  type CoreReadContext,
  type CoreReadDbClient,
  type CoreTreeState,
} from "../../mastraRead/ports.js";
import { checkReadSql } from "../../mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../../mastraRead/tables.js";
import { createCoreReadDb } from "./readDb.js";
import { CORE_READ_TOOL_NAMES, createReadExecutors } from "./readExecutors.js";
import { createDbSceneBodyReader } from "./sceneBody.js";

interface Captured {
  readonly sql: string;
  readonly params: unknown[];
  readonly method: string;
}

/**
 * A statement client that records what it is given and answers by the table the
 * statement reads. Rows are positional, in the order of the select's columns.
 */
function scriptedClient(answers: Record<string, unknown[][]> = {}): {
  client: CoreReadDbClient;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const client: CoreReadDbClient = async (sql, params, method) => {
    captured.push({ sql, params, method });
    const table = /from "([a-z_]+)"/u.exec(sql)?.[1] ?? "";
    return { rows: answers[table] ?? [] };
  };
  return { client, captured };
}

function makeCtx(
  opts: {
    tree?: () => Partial<CoreTreeState>;
    answers?: Record<string, unknown[][]>;
    fts?: CoreNativeReads["fts"];
    foreshadowOpen?: CoreNativeReads["foreshadowOpen"];
    readSceneBody?: (id: string) => Promise<string>;
    readSceneBodies?: (ids: readonly string[]) => Promise<Map<string, string>>;
  } = {},
) {
  const { client, captured } = scriptedClient(opts.answers);
  const getDb = vi.fn(() => createCoreReadDb(client));
  const getTreeState = vi.fn(
    () =>
      ({
        projectId: "p1",
        nodes: [],
        activeSceneId: null,
        ...(opts.tree?.() ?? {}),
      }) as CoreTreeState,
  );
  const readSceneBody = vi.fn(opts.readSceneBody ?? (async () => ""));
  const readSceneBodies = vi.fn(
    opts.readSceneBodies ?? (async () => new Map<string, string>()),
  );
  const countTokens = vi.fn((text: string) => text.length);
  const fts = vi.fn(opts.fts ?? (async () => []));
  const foreshadowOpen = vi.fn(
    opts.foreshadowOpen ?? (async () => ({ foreshadows: [], setups: [] })),
  );
  const ctx: CoreReadContext = {
    getDb,
    getTreeState,
    body: { barrier: "none", readSceneBody, readSceneBodies },
    native: { fts, foreshadowOpen },
    countTokens,
  };
  return {
    ctx,
    captured,
    fts,
    foreshadowOpen,
    getDb,
    getTreeState,
    readSceneBody,
    readSceneBodies,
    countTokens,
  };
}

describe("createReadExecutors", () => {
  it("builds the eleven tools of groups B1, B2, B3 and B4, in a frozen table, and reads no port", () => {
    const { ctx, getDb, getTreeState, countTokens, fts, foreshadowOpen } =
      makeCtx();
    const executors = createReadExecutors(ctx);
    expect(Object.keys(executors).sort()).toEqual(
      [...CORE_READ_TOOL_NAMES].sort(),
    );
    expect(CORE_READ_TOOL_NAMES).toHaveLength(11);
    expect(Object.isFrozen(executors)).toBe(true);
    expect(fts).not.toHaveBeenCalled();
    expect(foreshadowOpen).not.toHaveBeenCalled();
    expect(getDb).not.toHaveBeenCalled();
    expect(getTreeState).not.toHaveBeenCalled();
    expect(countTokens).not.toHaveBeenCalled();
  });

  it.each(CORE_READ_TOOL_NAMES)(
    "%s: with no project it throws CoreProjectRequiredError before it reads anything",
    async (tool) => {
      for (const projectId of ["", "   ", undefined, null]) {
        const {
          ctx,
          captured,
          fts,
          foreshadowOpen,
          getDb,
          readSceneBody,
          readSceneBodies,
        } = makeCtx({
          tree: () => ({ projectId: projectId as unknown as string }),
        });
        await expect(
          createReadExecutors(ctx)[tool]({
            id: "x",
            sceneId: "x",
            threadId: "x",
            query: "x",
          }),
        ).rejects.toBeInstanceOf(CoreProjectRequiredError);
        expect(getDb).not.toHaveBeenCalled();
        expect(fts).not.toHaveBeenCalled();
        expect(foreshadowOpen).not.toHaveBeenCalled();
        expect(captured).toEqual([]);
        expect(readSceneBody).not.toHaveBeenCalled();
        expect(readSceneBodies).not.toHaveBeenCalled();
      }
    },
  );

  it.each([
    ["get_scene", "id", "No id provided"],
    ["get_scene_timeline_neighbors", "sceneId", "No sceneId provided"],
    ["get_thread_scenes", "threadId", "No threadId provided"],
    ["search_scenes", "query", "0 scenes found"],
    ["search_snippets", "query", "0 snippets found"],
    ["get_foreshadow_detail", "id", "No id provided"],
  ] as const)(
    "%s: an empty %s is answered before the project is looked at",
    async (tool, key, summary) => {
      const { ctx, getTreeState } = makeCtx({
        tree: () => ({ projectId: "" }),
      });
      const result = await createReadExecutors(ctx)[tool]({ [key]: "  " });
      expect(result.summary).toBe(summary);
      expect(result.tokensUsed).toBe(0);
      expect(getTreeState).not.toHaveBeenCalled();
    },
  );

  it("takes the project when a tool runs, not when the executors are made (getter form)", async () => {
    let projectId = "p-first";
    const { ctx, captured } = makeCtx({ tree: () => ({ projectId }) });
    const executors = createReadExecutors(ctx);
    await executors.list_chapters({});
    projectId = "p-second";
    await executors.list_chapters({});
    expect(captured.map((c) => c.params)).toEqual([
      ["p-first", "folder", "scene"],
      ["p-second", "folder", "scene"],
    ]);
  });

  it("takes the project once per call and uses it for every statement of get_thread_scenes", async () => {
    let calls = 0;
    const { ctx, captured, getTreeState } = makeCtx({
      tree: () => ({ projectId: `p-${++calls}` }),
      answers: {
        plot_threads: [["t1", "Thread", "desc"]],
        plot_thread_scene_links: [["n1", "develop", "note", "a0"]],
        tree_nodes: [["n1", "Scene 1"]],
        plot_thread_branches: [],
      },
    });
    const result = await createReadExecutors(ctx).get_thread_scenes({
      threadId: "t1",
    });
    expect(getTreeState).toHaveBeenCalledTimes(1);
    expect(result.summary).toBe("Thread 'Thread': 1/1 scene(s)");
    const projectParams = captured
      .flatMap((c) => c.params)
      .filter((p) => typeof p === "string" && p.startsWith("p-"));
    expect(new Set(projectParams)).toEqual(new Set(["p-1"]));
  });

  it("get_thread_scenes: a failed body batch is not swallowed by the core (the legacy port does that), and an unknown phase is normalized", async () => {
    const answers = {
      plot_threads: [["t1", "Thread", null]],
      plot_thread_scene_links: [["n1", "not-a-phase", null, "a0"]],
      tree_nodes: [["n1", "Scene 1"]],
    };
    const failing = makeCtx({
      answers,
      readSceneBodies: async () => {
        throw new Error("body store down");
      },
    });
    await expect(
      createReadExecutors(failing.ctx).get_thread_scenes({ threadId: "t1" }),
    ).rejects.toThrow("body store down");
    expect(failing.readSceneBodies).toHaveBeenCalledWith(["n1"]);

    // A port that already turned its failure into an empty map (the legacy port)
    // gives empty excerpts, and the unknown phase is normalized.
    const swallowed = makeCtx({
      answers,
      readSceneBodies: async () => new Map<string, string>(),
    });
    const result = await createReadExecutors(swallowed.ctx).get_thread_scenes({
      threadId: "t1",
    });
    expect(result.content).toMatchObject({
      sceneCount: 1,
      scenes: [
        { id: "n1", title: "Scene 1", phaseType: "develop", excerpt: "" },
      ],
    });
  });

  it("get_scene: reads the body through the body port, after the node is checked", async () => {
    const { ctx, readSceneBody } = makeCtx({
      answers: { tree_nodes: [["n1", "Scene 1", "scene"]] },
      readSceneBody: async () =>
        JSON.stringify({
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
          ],
        }),
    });
    const result = await createReadExecutors(ctx).get_scene({ id: " n1 " });
    expect(readSceneBody).toHaveBeenCalledWith("n1");
    expect(result.content).toEqual({
      id: "n1",
      title: "Scene 1",
      content: "Hello\n",
    });
    expect(result.summary).toBe("Scene 'Scene 1' (6 chars)");
  });

  it("get_scene: an archived or non-scene node is not found and its body is not read", async () => {
    const { ctx, readSceneBody } = makeCtx({
      answers: { tree_nodes: [["n1", "Folder", "folder"]] },
    });
    const result = await createReadExecutors(ctx).get_scene({ id: "n1" });
    expect(result.summary).toBe("Scene not found");
    expect(readSceneBody).not.toHaveBeenCalled();
  });

  it("every statement of every tool passes main's checker and is a plain select", async () => {
    const all: Captured[] = [];
    for (const tool of CORE_READ_TOOL_NAMES) {
      const { ctx, captured } = makeCtx({
        answers: {
          tree_nodes: [
            ["n1", "n0", "scene", "T", "outline", "a0", "syn", "k1", "L"],
          ],
          plot_threads: [["t1", "Thread", "d", "a0"]],
          plot_thread_scene_links: [["n1", "develop", "", "a0"]],
          // get_foreshadow_detail: a foreshadow (every column, in the schema's order) with a
          // payoff scene, so that its three statements (the foreshadow, its setups joined to
          // the scenes, the payoff scene) are all sent.
          foreshadows: [
            [
              "n1",
              "p1",
              "F",
              null,
              null,
              "n1",
              null,
              null,
              0,
              0,
              1,
              null,
              null,
              0,
              null,
              0,
              0,
            ],
          ],
          foreshadow_setups: [
            ["n1", "designated_existing", null, null, "human", null, 0, "T"],
          ],
        },
      });
      await createReadExecutors(ctx)[tool]({
        id: "n1",
        sceneId: "n1",
        threadId: "t1",
        type: "character",
        // 3 字未満の語：search 2 本は fts を呼ばず LIKE-OR の文を出す。
        query: "魔法",
      });
      all.push(...captured);
    }
    expect(all.length).toBeGreaterThan(CORE_READ_TOOL_NAMES.length);
    for (const { sql, method } of all) {
      expect(method, sql).toBe("all");
      expect(checkReadSql(sql, MAIN_READ_TABLE_SET), sql).toMatchObject({
        ok: true,
      });
    }
    const tables = new Set(
      all.flatMap(({ sql }) =>
        [...sql.matchAll(/(?:from|join) "([a-z_]+)"/gu)].map((m) => m[1]!),
      ),
    );
    expect([...tables].sort()).toEqual([
      "codex_entry_tags",
      "codex_tags",
      "foreshadow_setups",
      "foreshadows",
      "plot_thread_branches",
      "plot_thread_scene_links",
      "plot_threads",
      "snippets",
      "tree_nodes",
    ]);
  });
});

describe("createDbSceneBodyReader", () => {
  it("states that it has no barrier", () => {
    const reader = createDbSceneBodyReader(() =>
      createCoreReadDb(scriptedClient().client),
    );
    expect(reader.barrier).toBe("none");
  });

  it("reads one body, and gives an empty string for an id with no row", async () => {
    const { client, captured } = scriptedClient({ tree_nodes: [["BODY"]] });
    const reader = createDbSceneBodyReader(() => createCoreReadDb(client));
    await expect(reader.readSceneBody("n1")).resolves.toBe("BODY");
    expect(captured[0]!.params).toEqual(["n1"]);
    const none = createDbSceneBodyReader(() =>
      createCoreReadDb(scriptedClient().client),
    );
    await expect(none.readSceneBody("n2")).resolves.toBe("");
  });

  it("reads many bodies in statements of at most 500 ids, and leaves out an id with no row", async () => {
    const { client, captured } = scriptedClient({
      tree_nodes: [
        ["a", "A"],
        ["b", null],
      ],
    });
    const reader = createDbSceneBodyReader(() => createCoreReadDb(client));
    const ids = Array.from({ length: 1001 }, (_, i) => `n${i}`);
    const map = await reader.readSceneBodies(ids);
    expect(captured.map((c) => c.params.length)).toEqual([500, 500, 1]);
    expect(map.get("a")).toBe("A");
    expect(map.get("b")).toBe("");
    expect(map.has("n0")).toBe(false);
    const empty = await reader.readSceneBodies([]);
    expect(empty.size).toBe(0);
    expect(captured).toHaveLength(3);
  });
});
