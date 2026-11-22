// MP-4b PR-7b: `search_events` of the read core, on in-memory ports. What is
// fixed here is the behaviour moved from the renderer (the query is checked
// before the project, the order of the awaits, the tree state read once after
// them, hidden hits dropped before the slice, a hit that no event of the project
// knows passes, the key order of the result) and the three differences that are
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
import type {
  EventRow,
  SceneEventRow,
} from "../features/chronicle/eventRows.js";
import {
  CHRONICLE_READ_TOOL_NAMES,
  CHRONICLE_SEARCH_TOOL_NAMES,
  createChronicleSearchExecutors,
} from "./chronicleReadExecutors.js";
import {
  eventSearchFetchLimit,
  eventSearchLimit,
} from "./chronicleSearchTools.js";
import { hiddenEventIds } from "./chronicleTools.js";
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

const scene = (id: string, sortOrder: string): CoreTreeNode => ({
  id,
  parentId: null,
  nodeType: "scene",
  title: `scene-${id}`,
  sortOrder,
  storyTimeOrder: null,
  archivedAt: null,
});

// s1 < s2 < s3 in the reading order.
const NODES: CoreTreeNode[] = [
  scene("s1", "a0"),
  scene("s2", "a1"),
  scene("s3", "a2"),
];

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
  nodes?: CoreTreeNode[];
  activeSceneId?: string | null;
  events?: EventRow[];
  sceneEvents?: SceneEventRow[];
  /** What the dense read answers (the wire as it is, not narrowed). */
  wire?: unknown;
  readingOrder?: ReadonlyMap<string, number>;
}

function makeCtx(world: World = {}) {
  const log: string[] = [];
  const nodes = world.nodes ?? NODES;
  let state: CoreTreeState = {
    projectId: "projectId" in world ? (world.projectId as string) : "p1",
    nodes,
    activeSceneId:
      world.activeSceneId === undefined ? "s3" : world.activeSceneId,
  };
  const getTreeState = vi.fn(() => {
    log.push("getTreeState");
    return state;
  });
  const chronicle = {
    getEvents: vi.fn(async (_p: string) => {
      log.push("getEvents");
      return world.events ?? [];
    }),
    getSceneEvents: vi.fn(async (_p: string) => {
      log.push("getSceneEvents");
      return world.sceneEvents ?? [];
    }),
    getReadingOrder: vi.fn((ns: readonly CoreTreeNode[]) => {
      log.push("getReadingOrder");
      return (
        world.readingOrder ??
        new Map(
          ns.filter((n) => n.nodeType === "scene").map((n, i) => [n.id, i]),
        )
      );
    }),
  };
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
  const ctx: CoreChronicleSearchContext = {
    getTreeState,
    countTokens,
    chronicle,
    native,
  };
  return {
    executors: createChronicleSearchExecutors(ctx),
    chronicle,
    native,
    getTreeState,
    countTokens,
    log,
    nodes,
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

describe("the order: query, then project, then dense, events, scene events, tree state", () => {
  it("reads in that order, and counts tokens last", async () => {
    const c = makeCtx({ wire: [hit("e1")], events: [event("e1")] });
    await c.executors.search_events({ query: "q" });
    expect(c.log).toEqual([
      "getTreeState", // the project
      "eventsSemantic",
      "getEvents",
      "getSceneEvents",
      "getTreeState", // nodes and active scene: once, after the awaits
      "getReadingOrder",
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

  it("an empty query is answered before the project is looked at; a valid query with no project throws CoreProjectRequiredError and reads no data port", async () => {
    for (const projectId of ["", "   "]) {
      const c = makeCtx({ projectId, wire: [hit("e1")] });
      await expect(
        c.executors.search_events({ query: "q" }),
      ).rejects.toBeInstanceOf(CoreProjectRequiredError);
      expect(c.native.eventsSemantic).not.toHaveBeenCalled();
      expect(c.chronicle.getEvents).not.toHaveBeenCalled();
      expect(c.chronicle.getSceneEvents).not.toHaveBeenCalled();
      expect(c.countTokens).not.toHaveBeenCalled();
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
    const c = makeCtx({ wire: [hit("e1")], events: [event("e1")] });
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
    expect(c.chronicle.getEvents).toHaveBeenCalledWith("p1");
    expect(c.chronicle.getSceneEvents).toHaveBeenCalledWith("p1");
  });

  it("reads the nodes and the active scene once, after the awaits (a scene that changes during the dense read, the events or the bridges is the one used)", async () => {
    const secret = event("sec", { secret: true, revealSceneId: "s2" });
    for (const during of [
      "eventsSemantic",
      "getEvents",
      "getSceneEvents",
    ] as const) {
      const c = makeCtx({
        activeSceneId: "s1",
        events: [secret],
        wire: [hit("sec")],
      });
      const flip = () => c.setState({ activeSceneId: "s2" });
      if (during === "eventsSemantic")
        c.native.eventsSemantic.mockImplementation(async () => {
          flip();
          return [hit("sec")];
        });
      else if (during === "getEvents")
        c.chronicle.getEvents.mockImplementation(async () => {
          flip();
          return [secret];
        });
      else
        c.chronicle.getSceneEvents.mockImplementation(async () => {
          flip();
          return [];
        });
      const r = await c.executors.search_events({ query: "q" });
      expect(idsOf(r), during).toEqual(["sec"]);
      // and the state was read once for the nodes and the scene (plus the project)
      expect(c.getTreeState, during).toHaveBeenCalledTimes(2);
    }
  });

  it("a scene that changes after the state was read is not seen (one synchronous read of nodes and scene)", async () => {
    const c = makeCtx({
      activeSceneId: "s1",
      events: [event("sec", { secret: true, revealSceneId: "s2" })],
      wire: [hit("sec")],
    });
    c.chronicle.getReadingOrder.mockImplementation((ns) => {
      void Promise.resolve().then(() => c.setState({ activeSceneId: "s2" }));
      return new Map(ns.map((n, i) => [n.id, i]));
    });
    const r = await c.executors.search_events({ query: "q" });
    expect(idsOf(r)).toEqual([]);
  });

  it("passes the nodes of the tree state to the reading-order port as they are (same reference), and copies the answer (a turn's map is never shared out)", async () => {
    const turnOrder = new Map([
      ["s1", 0],
      ["s2", 1],
    ]);
    const c = makeCtx({
      wire: [hit("e1")],
      events: [event("e1")],
      readingOrder: turnOrder,
    });
    await c.executors.search_events({ query: "q" });
    expect(c.chronicle.getReadingOrder.mock.calls[0]![0]).toBe(c.nodes);
    expect([...turnOrder.entries()]).toEqual([
      ["s1", 0],
      ["s2", 1],
    ]);
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

describe("the secrecy rule is applied to the hits", () => {
  const events = [
    event("pub"),
    event("sec", { secret: true, revealSceneId: "s2" }),
    event("perm", { secret: true }),
  ];

  it("drops a secret event before its reveal scene and keeps it from there on; a permanent secret never shows; no active scene hides every secret", async () => {
    const at = async (activeSceneId: string | null) => {
      const c = makeCtx({
        activeSceneId,
        events,
        wire: [hit("sec"), hit("pub"), hit("perm")],
      });
      return idsOf(await c.executors.search_events({ query: "q" }));
    };
    expect(await at("s1")).toEqual(["pub"]);
    expect(await at("s2")).toEqual(["sec", "pub"]);
    expect(await at("s3")).toEqual(["sec", "pub"]);
    expect(await at("not-a-scene")).toEqual(["pub"]);
    expect(await at(null)).toEqual(["pub"]);
  });

  it("drops the hidden hits BEFORE it takes the first `limit` (a hidden hit at the head does not use up the limit)", async () => {
    const evs = [
      event("h1", { secret: true }),
      event("h2", { secret: true }),
      event("v1"),
      event("v2"),
      event("v3"),
    ];
    const c = makeCtx({
      events: evs,
      activeSceneId: "s1",
      wire: [hit("h1"), hit("h2"), hit("v1"), hit("v2"), hit("v3")],
    });
    const r = await c.executors.search_events({ query: "q", limit: 2 });
    expect(idsOf(r)).toEqual(["v1", "v2"]);
    expect(r.summary).toBe("2 events found");
  });

  it("PASSES a hit whose id is not among the project's events (moved as the renderer has it, DR-MP4-38; the port's project scope is what keeps another project's id out) and asks for the events once", async () => {
    const c = makeCtx({
      activeSceneId: "s1",
      events,
      wire: [hit("x-unknown"), hit("sec"), hit("pub"), hit("x-unknown")],
    });
    const r = await c.executors.search_events({ query: "q" });
    expect(idsOf(r)).toEqual(["x-unknown", "pub", "x-unknown"]);
    // no second read to look the unknown id up (that would change the renderer's result)
    expect(c.chronicle.getEvents).toHaveBeenCalledTimes(1);
    expect(c.chronicle.getSceneEvents).toHaveBeenCalledTimes(1);
  });

  it("keeps the order of the hits and does not de-duplicate them", async () => {
    const c = makeCtx({
      events,
      wire: [hit("pub"), hit("sec"), hit("pub")],
    });
    expect(idsOf(await c.executors.search_events({ query: "q" }))).toEqual([
      "pub",
      "sec",
      "pub",
    ]);
  });

  it("the secrecy of an event follows the scenes it is stamped on when it has no reveal scene of its own", async () => {
    const c = makeCtx({
      activeSceneId: "s1",
      events: [event("stamped", { secret: true })],
      sceneEvents: [{ eventId: "stamped", sceneId: "s2" }],
      wire: [hit("stamped")],
    });
    expect(idsOf(await c.executors.search_events({ query: "q" }))).toEqual([]);
    const later = makeCtx({
      activeSceneId: "s2",
      events: [event("stamped", { secret: true })],
      sceneEvents: [{ eventId: "stamped", sceneId: "s2" }],
      wire: [hit("stamped")],
    });
    expect(idsOf(await later.executors.search_events({ query: "q" }))).toEqual([
      "stamped",
    ]);
  });
});

describe("hiddenEventIds is the one place the rule is applied, and the four tools use its complement", () => {
  it("returns exactly the ids that isEventHiddenFromAi hides", () => {
    const evs = [
      event("pub"),
      event("sec", { secret: true, revealSceneId: "s2" }),
      event("perm", { secret: true }),
    ];
    const order = new Map([
      ["s1", 0],
      ["s2", 1],
    ]);
    expect([
      ...hiddenEventIds(evs, "s1", { readingOrder: order, sceneEvents: [] }),
    ]).toEqual(["sec", "perm"]);
    expect([
      ...hiddenEventIds(evs, "s2", { readingOrder: order, sceneEvents: [] }),
    ]).toEqual(["perm"]);
    expect([
      ...hiddenEventIds(evs, "", { readingOrder: order, sceneEvents: [] }),
    ]).toEqual(["sec", "perm"]);
  });
});

describe("the result", () => {
  it("has the renderer's key order (eventId, title, kind, score), drops an extra key and counts the tokens of the JSON", async () => {
    const c = makeCtx({
      events: [event("a")],
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
    const c = makeCtx({ wire, events: [event("e1")] });
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
      const c = makeCtx({ events: [event("e1")] });
      c.native.eventsSemantic.mockRejectedValue(failure);
      await expect(c.executors.search_events({ query: "q" })).rejects.toBe(
        failure,
      );
      expect(c.chronicle.getEvents).not.toHaveBeenCalled();
      expect(c.chronicle.getSceneEvents).not.toHaveBeenCalled();
      expect(c.countTokens).not.toHaveBeenCalled();
    },
  );
});
