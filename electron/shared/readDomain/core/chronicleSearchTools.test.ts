// MP-4b PR-7b: `search_events` of the read core, on in-memory ports. What is
// fixed here is the behaviour moved from the renderer (the query is checked
// before the project, the order of the awaits, dense hits sliced after narrowing,
// the key order of the result) and the three differences that are
// recorded in DR-MP4-38 (a failure of the dense read is not caught, a malformed
// wire throws, a blank project is no project). The equality with the renderer is
// the PR-0 golden (`readCore.mainAdapter.test.ts`, the real-addon spec). Relative
// imports only (the electron vitest config has no `@` alias).
import { describe, expect, it, vi } from "vitest";

import {
  CoreProjectRequiredError,
  type CoreChronicleSearchContext,
  type CoreTreeNode,
  type CoreTreeState,
} from "../../mastraRead/ports.js";
import type { EventRow } from "../features/chronicle/eventRows.js";
import {
  CHRONICLE_READ_TOOL_NAMES,
  CHRONICLE_SEARCH_TOOL_NAMES,
  createChronicleSearchExecutors,
} from "./chronicleReadExecutors.js";
import {
  eventSearchFetchLimit,
  eventSearchLimit,
} from "./chronicleSearchTools.js";
import { CORE_READ_TOOL_NAMES } from "./readExecutors.js";

const event = (id: string, over: Partial<EventRow> = {}): EventRow => ({
  id,
  projectId: "p1",
  title: `title-${id}`,
  note: null,
  detail: null,
  ordinal: "a0",
  primaryCodexId: null,
  laneGroup: null,
  locationCodexId: null,
  startTime: null,
  endTime: null,
  startMinute: null,
  endMinute: null,
  startGranularity: "none",
  endGranularity: "none",
  precision: "exact",
  kind: "generic",
  secret: false,
  revealSceneId: null,
  version: 0,
  createdAt: "c",
  updatedAt: "u",
  ...over,
});

const scene = (
  id: string,
  sortOrder: string,
  over: Partial<CoreTreeNode> = {},
): CoreTreeNode => ({
  id,
  parentId: null,
  nodeType: "scene",
  title: `Scene ${id.slice(1)}`,
  sortOrder,
  storyTimeOrder: null,
  archivedAt: null,
  ...over,
});

const hit = (
  eventId: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  eventId,
  title: `title-${eventId}`,
  kind: "generic",
  score: 0.9,
  ...over,
});

interface World {
  projectId?: string;
  /** What the dense read answers (the wire as it is, not narrowed). */
  wire?: unknown;
  events?: EventRow[];
  nodes?: CoreTreeNode[];
  activeSceneId?: string | null;
  readingOrder?: ReadonlyMap<string, number>;
}

function makeCtx(world: World = {}) {
  const log: string[] = [];
  let state: CoreTreeState = {
    projectId: "projectId" in world ? (world.projectId as string) : "p1",
    nodes: world.nodes ?? [],
    activeSceneId: world.activeSceneId ?? null,
  };
  const getTreeState = vi.fn(() => {
    log.push("getTreeState");
    return state;
  });
  const native = {
    eventsSemantic: vi.fn(
      async (_args: { projectId: string; query: string; limit: number }) => {
        log.push("eventsSemantic");
        return world.wire === undefined ? [] : world.wire;
      },
    ),
  };
  const countTokens = vi.fn((text: string) => {
    log.push("countTokens");
    return text.length;
  });
  const chronicle = {
    getEvents: vi.fn(async (_projectId: string) => {
      log.push("getEvents");
      return world.events ?? [];
    }),
    getReadingOrder: vi.fn((nodes: readonly CoreTreeNode[]) => {
      log.push("getReadingOrder");
      return (
        world.readingOrder ??
        new Map(
          nodes
            .filter((node) => node.nodeType === "scene" && !node.archivedAt)
            .map((node, index) => [node.id, index]),
        )
      );
    }),
  };
  const ctx: CoreChronicleSearchContext = {
    getTreeState,
    countTokens,
    native,
    chronicle,
  };
  return {
    ctx,
    executors: createChronicleSearchExecutors(ctx),
    native,
    chronicle,
    getTreeState,
    countTokens,
    log,
    setState: (next: Partial<CoreTreeState>) => {
      state = { ...state, ...next };
    },
  };
}

const idsOf = (r: { content: unknown }) =>
  (r.content as Array<{ eventId: string }>).map((e) => e.eventId);

describe("the table of the search tool", () => {
  it("is one tool, and none of the other two tables has it", () => {
    expect([...CHRONICLE_SEARCH_TOOL_NAMES]).toEqual(["search_events"]);
    const c = makeCtx();
    expect(Object.keys(c.executors)).toEqual(["search_events"]);
    expect(Object.isFrozen(c.executors)).toBe(true);
    for (const other of [CORE_READ_TOOL_NAMES, CHRONICLE_READ_TOOL_NAMES]) {
      expect((other as readonly string[]).includes("search_events")).toBe(
        false,
      );
    }
  });

  it("the three tables (11, 4 and 1 tools) share no name", () => {
    const all = [
      ...CORE_READ_TOOL_NAMES,
      ...CHRONICLE_READ_TOOL_NAMES,
      ...CHRONICLE_SEARCH_TOOL_NAMES,
    ];
    expect(all).toHaveLength(16);
    expect(new Set(all).size).toBe(16);
  });

  it("making the executor reads nothing from the ports", () => {
    const c = makeCtx();
    expect(c.log).toEqual([]);
  });
});

describe("the order: query, project, dense, then countTokens", () => {
  it("reads in that order, and counts tokens last", async () => {
    const c = makeCtx({ wire: [hit("e1")] });
    await c.executors.search_events({ query: "q" });
    expect(c.log).toEqual([
      "getTreeState",
      "eventsSemantic",
      "getEvents",
      "countTokens",
    ]);
  });

  it.each([[""], ["   "], [undefined]])(
    "query=%j answers `0 events found` and reads nothing (no project, no dense, no tree state, no token count)",
    async (query) => {
      const c = makeCtx({ projectId: "" });
      const r = await c.executors.search_events(
        query === undefined ? {} : { query },
      );
      expect(r).toEqual({
        name: "search_events",
        content: [],
        summary: "0 events found",
        tokensUsed: 0,
      });
      expect(c.log).toEqual([]);
    },
  );

  it("an empty query is answered before the project is looked at; a valid query with no project throws CoreProjectRequiredError", async () => {
    for (const projectId of ["", "   "]) {
      const c = makeCtx({ projectId, wire: [hit("e1")] });
      await expect(
        c.executors.search_events({ query: "q" }),
      ).rejects.toBeInstanceOf(CoreProjectRequiredError);
      expect(c.native.eventsSemantic).not.toHaveBeenCalled();
      expect(c.countTokens).not.toHaveBeenCalled();
      expect(c.getTreeState).toHaveBeenCalledTimes(1);
    }
  });

  it("a falsy project (empty, null, undefined) is no project, as in the renderer; a blank one (spaces only) is no project here too, where the renderer read on (a difference of the same kind as DR-MP4-37d; a project id is a UUID and never blank)", async () => {
    for (const projectId of ["", null, undefined, "  "]) {
      const c = makeCtx({ projectId: projectId as never });
      await expect(
        c.executors.search_events({ query: "q" }),
      ).rejects.toBeInstanceOf(CoreProjectRequiredError);
      expect(c.native.eventsSemantic).not.toHaveBeenCalled();
    }
  });

  it("takes the project once, from the tree state at the moment of the call: a project that changes during the dense read is not used", async () => {
    const c = makeCtx({ wire: [hit("e1")] });
    c.native.eventsSemantic.mockImplementation(async () => {
      c.setState({ projectId: "p2" });
      return [hit("e1")];
    });
    await c.executors.search_events({ query: "q" });
    expect(c.native.eventsSemantic).toHaveBeenCalledWith({
      projectId: "p1",
      query: "q",
      limit: 30,
    });
    expect(c.getTreeState).toHaveBeenCalledTimes(1);
  });

  it("loads event rows only after dense hits and does not read order when they have no reveal scene", async () => {
    const c = makeCtx({ wire: [hit("e1")] });
    await c.executors.search_events({ query: "q" });
    expect(c.ctx).toHaveProperty("chronicle");
    expect(c.getTreeState).toHaveBeenCalledTimes(1);
    expect(c.log).toEqual([
      "getTreeState",
      "eventsSemantic",
      "getEvents",
      "countTokens",
    ]);
    expect(c.chronicle.getReadingOrder).not.toHaveBeenCalled();
  });
});

describe("search_events revealScene", () => {
  const nodes = [scene("s1", "a0"), scene("s2", "a1"), scene("s3", "a2")];

  it.each([
    ["s1", false],
    ["s2", true],
    [null, undefined],
  ] as const)(
    "marks disclosure relative to active scene %s",
    async (activeSceneId, revealed) => {
      const c = makeCtx({
        wire: [hit("e1")],
        events: [event("e1", { revealSceneId: "s2" })],
        nodes,
        activeSceneId,
      });
      const r = await c.executors.search_events({ query: "q" });
      const result = (r.content as Array<Record<string, unknown>>)[0]!;
      expect(result.revealScene).toEqual(
        revealed === undefined
          ? { id: "s2", title: "Scene 2" }
          : { id: "s2", title: "Scene 2", revealedToReader: revealed },
      );
      expect(c.log.indexOf("eventsSemantic")).toBeLessThan(
        c.log.indexOf("getEvents"),
      );
      expect(c.log.indexOf("getEvents")).toBeLessThan(
        c.log.indexOf("getReadingOrder"),
      );
      expect(Object.keys(result)).toEqual([
        "eventId",
        "title",
        "kind",
        "score",
        "revealScene",
      ]);
    },
  );

  it.each([
    [
      "s2",
      [nodes[0]!, scene("s2", "a1", { archivedAt: "archived" }), nodes[2]!],
    ],
    ["missing", nodes],
  ] as const)(
    "omits an archived or missing reveal scene (%s)",
    async (revealSceneId, sceneNodes) => {
      const c = makeCtx({
        wire: [hit("e1")],
        events: [event("e1", { revealSceneId })],
        nodes: [...sceneNodes],
        activeSceneId: "s3",
      });
      const r = await c.executors.search_events({ query: "q" });
      const result = (r.content as Array<Record<string, unknown>>)[0]!;
      expect(Object.keys(result)).toEqual([
        "eventId",
        "title",
        "kind",
        "score",
      ]);
    },
  );

  it("does not read event rows when there are no dense hits", async () => {
    const c = makeCtx({ wire: [] });
    await c.executors.search_events({ query: "q" });
    expect(c.chronicle.getEvents).not.toHaveBeenCalled();
    expect(c.chronicle.getReadingOrder).not.toHaveBeenCalled();
  });
});

describe("limit and fetchLimit", () => {
  const many = Array.from({ length: 40 }, (_, i) => hit(`e${i}`));
  // limit → [limit, fetchLimit, count]
  const table: Array<[unknown, number, number, number]> = [
    [undefined, 10, 30, 10],
    [null, 10, 30, 10],
    [0, 10, 30, 10],
    [-1, 10, 30, 10],
    ["abc", 10, 30, 10],
    [Number.NaN, 10, 30, 10],
    [Number.POSITIVE_INFINITY, 10, 30, 10],
    [0.5, 0, 0, 0],
    [1, 1, 3, 1],
    [2, 2, 6, 2],
    ["5", 5, 15, 5],
    [5.7, 5, 15, 5],
    [10, 10, 30, 10],
    [11, 11, 30, 11],
    [30, 30, 30, 30],
    [100, 30, 30, 30],
  ];
  it.each(table)(
    "limit=%s → limit %i, dense asked for %i, %i results",
    async (raw, limit, fetchLimit, count) => {
      const c = makeCtx({ wire: many });
      const r = await c.executors.search_events({ query: "q", limit: raw });
      expect(c.native.eventsSemantic).toHaveBeenCalledTimes(1);
      // the exact argument: no extra key
      expect(c.native.eventsSemantic.mock.calls[0]![0]).toEqual({
        projectId: "p1",
        query: "q",
        limit: fetchLimit,
      });
      expect(Object.keys(c.native.eventsSemantic.mock.calls[0]![0])).toEqual([
        "projectId",
        "query",
        "limit",
      ]);
      expect((r.content as unknown[]).length).toBe(count);
      expect(eventSearchLimit({ limit: raw })).toBe(limit);
      expect(eventSearchFetchLimit(limit)).toBe(fetchLimit);
    },
  );

  it("a limit that rounds to 0 still asks the dense read (with 0) and answers no hit", async () => {
    const c = makeCtx({ wire: many });
    const r = await c.executors.search_events({ query: "q", limit: 0.5 });
    expect(c.native.eventsSemantic).toHaveBeenCalledTimes(1);
    expect(c.native.eventsSemantic.mock.calls[0]![0].limit).toBe(0);
    expect(r.summary).toBe("0 events found");
  });

  it("the query is a trimmed string (a number is '5')", async () => {
    const c = makeCtx();
    await c.executors.search_events({ query: 5 });
    await c.executors.search_events({ query: "  abc  " });
    expect(c.native.eventsSemantic.mock.calls.map((a) => a[0].query)).toEqual([
      "5",
      "abc",
    ]);
  });
});

describe("all events are eligible search hits", () => {
  it("returns a secret event before its reveal scene, then applies only the requested limit", async () => {
    const secretBeforeReveal = event("secret-before-reveal", {
      secret: true,
      revealSceneId: "s2",
    });
    const c = makeCtx({
      wire: [
        hit(secretBeforeReveal.id, { title: secretBeforeReveal.title }),
        hit("public"),
        hit("later"),
      ],
    });
    const r = await c.executors.search_events({ query: "q", limit: 2 });
    expect(idsOf(r)).toEqual(["secret-before-reveal", "public"]);
    expect(r.summary).toBe("2 events found");
  });

  it("keeps the dense hit order and does not de-duplicate hits", async () => {
    const c = makeCtx({ wire: [hit("public"), hit("secret"), hit("public")] });
    expect(idsOf(await c.executors.search_events({ query: "q" }))).toEqual([
      "public",
      "secret",
      "public",
    ]);
  });
});

describe("the result", () => {
  it("has the renderer's key order (eventId, title, kind, score), drops an extra key and counts the tokens of the JSON", async () => {
    const c = makeCtx({
      wire: [
        hit("a", { extra: "dropped", rank: 1 }),
        hit("b", { kind: "birth", score: 0.25 }),
      ],
    });
    const r = await c.executors.search_events({ query: "q" });
    expect(r.name).toBe("search_events");
    expect(r.summary).toBe("2 events found");
    const content = r.content as Array<Record<string, unknown>>;
    expect(content.map((x) => Object.keys(x))).toEqual([
      ["eventId", "title", "kind", "score"],
      ["eventId", "title", "kind", "score"],
    ]);
    expect(r.tokensUsed).toBe(JSON.stringify(content).length);
    expect(c.countTokens).toHaveBeenCalledWith(JSON.stringify(content));
  });

  it("an empty answer is `0 events found`, counted (the tokens of `[]`)", async () => {
    const c = makeCtx({ wire: [] });
    const r = await c.executors.search_events({ query: "q" });
    expect(r.content).toEqual([]);
    expect(r.summary).toBe("0 events found");
    expect(r.tokensUsed).toBe(2);
  });
});

describe("the wire is narrowed (fail closed)", () => {
  it.each([
    ["not an array (null)", null],
    ["not an array (an object)", { eventId: "e" }],
    ["not an array (a string)", "[]"],
    ["a row that is null", [null]],
    ["a row that is a string", ["e1"]],
    ["eventId is a number", [hit("e1", { eventId: 1 })]],
    ["eventId is missing", [{ title: "t", kind: "generic", score: 1 }]],
    ["title is null", [hit("e1", { title: null })]],
    ["kind is a number", [hit("e1", { kind: 3 })]],
    ["score is a string", [hit("e1", { score: "0.9" })]],
    ["score is missing", [{ eventId: "e1", title: "t", kind: "generic" }]],
  ])("%s throws and is not turned into a result", async (_label, wire) => {
    const c = makeCtx({ wire });
    await expect(c.executors.search_events({ query: "q" })).rejects.toThrow(
      /events_semantic_search/,
    );
    expect(c.countTokens).not.toHaveBeenCalled();
  });

  it("a score of null is allowed (Native's f32 becomes null on the wire when it is NaN) and comes out as null", async () => {
    const c = makeCtx({ wire: [hit("e1", { score: null })] });
    const r = await c.executors.search_events({ query: "q" });
    expect(r.content).toEqual([
      { eventId: "e1", title: "title-e1", kind: "generic", score: null },
    ]);
    expect(JSON.stringify(r.content)).toContain('"score":null');
  });
});

describe("a failure of the dense read is not caught by the core (DR-MP4-38)", () => {
  it.each([
    ["an Error", () => new Error("SEMANTIC_INDEX_WORKSPACE_CHANGED")],
    [
      "a timeout",
      () => Object.assign(new Error("timeout"), { code: "timeout" }),
    ],
    ["a string", () => "unavailable"],
  ])(
    "%s comes out as the tool's error, never as `[]` or `0 events found`, and nothing is read after it",
    async (_label, make) => {
      const failure = make();
      const c = makeCtx();
      c.native.eventsSemantic.mockRejectedValue(failure);
      await expect(c.executors.search_events({ query: "q" })).rejects.toBe(
        failure,
      );
      expect(c.getTreeState).toHaveBeenCalledTimes(1);
      expect(c.countTokens).not.toHaveBeenCalled();
    },
  );
});
