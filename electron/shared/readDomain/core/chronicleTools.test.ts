// MP-4b PR-7a: the four chronicle tools of the read core, on in-memory ports.
// These tests fix the project gate, read order, CSR/1 Codex visibility rule,
// and result shape. Renderer parity is updated separately in PR-3d. Relative
// imports only (the electron vitest config has no `@` alias).
import { describe, expect, it, vi } from "vitest";

import {
  CoreProjectRequiredError,
  type CoreChronicleReadContext,
  type CoreTreeNode,
  type CoreTreeState,
  type CoreUiLanguage,
} from "../../mastraRead/ports.js";
import type {
  CalendarRow,
  EventRelationRow,
  EventRow,
  ParticipantRow,
  SceneEventRow,
} from "../features/chronicle/eventRows.js";
import { normalizeCalendarRow } from "../features/chronicle/readRows.js";
import {
  CHRONICLE_READ_TOOL_NAMES,
  createChronicleReadExecutors,
} from "./chronicleReadExecutors.js";
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
  title: `scene-${id}`,
  sortOrder,
  storyTimeOrder: null,
  archivedAt: null,
  ...over,
});

const CALENDAR: CalendarRow = normalizeCalendarRow({ projectId: "p1" });

// s1 < s2 < s3 in the reading order.
const NODES: CoreTreeNode[] = [
  scene("s1", "a0"),
  scene("s2", "a1"),
  scene("s3", "a2"),
];

interface World {
  projectId?: string;
  nodes?: CoreTreeNode[];
  activeSceneId?: string | null;
  events?: EventRow[];
  sceneEvents?: SceneEventRow[];
  participants?: ParticipantRow[];
  relations?: EventRelationRow[];
  calendar?: CalendarRow | null;
  names?: Record<string, string>;
  /** The reading order the port answers; default: the scenes of `nodes` in array order. */
  readingOrder?: ReadonlyMap<string, number>;
  lang?: CoreUiLanguage;
}

function makeCtx(world: World = {}) {
  const log: string[] = [];
  const nodes = world.nodes ?? NODES;
  const state: CoreTreeState = {
    projectId: world.projectId ?? "p1",
    nodes,
    activeSceneId:
      world.activeSceneId === undefined ? "s3" : world.activeSceneId,
  };
  const names = new Map(Object.entries(world.names ?? {}));
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
    getCodexNames: vi.fn(async (_p: string) => {
      log.push("getCodexNames");
      return names;
    }),
    listHiddenCodexIds: vi.fn(async (_p: string, _ids: readonly string[]) => {
      log.push("listHiddenCodexIds");
      return new Set<string>();
    }),
    getReadingOrder: vi.fn((ns: readonly CoreTreeNode[]) => {
      log.push("getReadingOrder");
      return (
        world.readingOrder ??
        new Map(
          ns
            .filter((n) => n.nodeType === "scene" && !n.archivedAt)
            .map((n, i) => [n.id, i]),
        )
      );
    }),
    listParticipants: vi.fn(async (_p: string, ids?: string[]) => {
      log.push("listParticipants");
      return (world.participants ?? []).filter(
        (participant) => !ids || ids.includes(participant.eventId),
      );
    }),
    listRelations: vi.fn(async (_p: string) => {
      log.push("listRelations");
      return world.relations ?? [];
    }),
    getCalendar: vi.fn(async (_p: string) => {
      log.push("getCalendar");
      return world.calendar === undefined ? CALENDAR : world.calendar;
    }),
  };
  const getUiLanguage = vi.fn(() => world.lang ?? "ja");
  const ctx: CoreChronicleReadContext = {
    getTreeState,
    countTokens: (text) => text.length,
    getUiLanguage,
    chronicle,
  };
  return {
    executors: createChronicleReadExecutors(ctx),
    chronicle,
    getTreeState,
    getUiLanguage,
    log,
    nodes,
  };
}

/** The ports of the four tools, in one place: a tool that has no project must touch none of them. */
function portCalls(c: ReturnType<typeof makeCtx>): number {
  return Object.values(c.chronicle).reduce(
    (n, fn) => n + fn.mock.calls.length,
    0,
  );
}

describe("revealScene marks on the four chronicle read tools", () => {
  const run = async (
    tool: "list_events" | "get_event_detail" | "get_character_timeline",
    activeSceneId: string | null,
    revealSceneId: string | null = "s2",
    nodes = NODES,
  ) => {
    const c = makeCtx({
      activeSceneId,
      nodes,
      events: [event("e1", { primaryCodexId: "c1", revealSceneId })],
    });
    const result =
      tool === "list_events"
        ? await c.executors.list_events({})
        : tool === "get_event_detail"
          ? await c.executors.get_event_detail({ eventId: "e1" })
          : await c.executors.get_character_timeline({ codexId: "c1" });
    const item =
      tool === "get_event_detail"
        ? (result.content as Record<string, unknown> | null)
        : (result.content as { events: Array<Record<string, unknown>> })
            .events[0];
    return { item, c };
  };

  it.each([
    ["list_events", "s1", false],
    ["get_event_detail", "s1", false],
    ["get_character_timeline", "s1", false],
    ["list_events", "s2", true],
    ["get_event_detail", "s2", true],
    ["get_character_timeline", "s2", true],
    ["list_events", null, undefined],
    ["get_event_detail", null, undefined],
    ["get_character_timeline", null, undefined],
  ] as const)(
    "%s at %s marks disclosure as %s",
    async (tool, activeSceneId, revealed) => {
      const { item } = await run(tool, activeSceneId);
      expect(item?.revealScene).toEqual(
        revealed === undefined
          ? { id: "s2", title: "scene-s2" }
          : { id: "s2", title: "scene-s2", revealedToReader: revealed },
      );
    },
  );

  it.each([
    "list_events",
    "get_event_detail",
    "get_character_timeline",
  ] as const)(
    "%s omits an archived or missing disclosure scene",
    async (tool) => {
      for (const [revealSceneId, nodes] of [
        [
          "s2",
          [NODES[0]!, scene("s2", "a1", { archivedAt: "archived" }), NODES[2]!],
        ],
        ["missing", NODES],
      ] as const) {
        const { item } = await run(tool, "s3", revealSceneId, [...nodes]);
        expect(item && Object.hasOwn(item, "revealScene")).toBe(false);
      }
    },
  );

  it.each([
    "list_events",
    "get_event_detail",
    "get_character_timeline",
  ] as const)(
    "%s leaves unmarked output and reads unchanged when no event has a disclosure scene",
    async (tool) => {
      const { item, c } = await run(tool, "s3", null);
      expect(item && Object.hasOwn(item, "revealScene")).toBe(false);
      expect(c.chronicle.getReadingOrder).not.toHaveBeenCalled();
      expect(c.getTreeState).toHaveBeenCalledTimes(
        tool === "get_event_detail" ? 2 : 1,
      );
    },
  );
});

describe("the table of the chronicle tools", () => {
  it("has the four tools, and none of them is in the 11-tool table of the database-reading core", () => {
    expect([...CHRONICLE_READ_TOOL_NAMES]).toEqual([
      "list_events",
      "get_event_detail",
      "get_character_timeline",
      "get_chronicle_state",
    ]);
    const c = makeCtx();
    expect(Object.keys(c.executors)).toEqual([...CHRONICLE_READ_TOOL_NAMES]);
    for (const name of CHRONICLE_READ_TOOL_NAMES) {
      expect((CORE_READ_TOOL_NAMES as readonly string[]).includes(name)).toBe(
        false,
      );
    }
    expect(Object.isFrozen(c.executors)).toBe(true);
  });

  it("making the executors reads nothing from the ports", () => {
    const c = makeCtx();
    expect(portCalls(c)).toBe(0);
    expect(c.getTreeState).not.toHaveBeenCalled();
  });
});

describe("the project is checked before the arguments and before any read", () => {
  // `projectId: ""` is the empty project; the arguments are missing too, so a
  // tool that looked at them first would answer "… is required" instead.
  it.each(CHRONICLE_READ_TOOL_NAMES)(
    "%s throws CoreProjectRequiredError and touches no data port (empty or blank project)",
    async (tool) => {
      for (const projectId of ["", "   "]) {
        const c = makeCtx({ projectId, events: [event("e1")] });
        await expect(c.executors[tool]({})).rejects.toBeInstanceOf(
          CoreProjectRequiredError,
        );
        expect(portCalls(c)).toBe(0);
      }
    },
  );

  it("takes the project from the tree state at the moment of the call (a getter, never captured earlier)", async () => {
    const c = makeCtx({ events: [event("e1")] });
    await c.executors.list_events({});
    expect(c.chronicle.getEvents).toHaveBeenCalledWith("p1");
    for (const fn of [c.chronicle.getCodexNames, c.chronicle.getCalendar]) {
      expect(fn).toHaveBeenCalledWith("p1");
    }
    expect(c.chronicle.getSceneEvents).not.toHaveBeenCalled();
    expect(c.chronicle.listHiddenCodexIds).not.toHaveBeenCalled();
  });
});

describe("list_events", () => {
  const world: World = {
    events: [
      event("e1", {
        ordinal: "a0",
        kind: "birth",
        startTime: 10,
        startGranularity: "day",
        primaryCodexId: "c1",
      }),
      event("e2", { ordinal: "a1", kind: "death", primaryCodexId: "c-gone" }),
      event("e3", { ordinal: "a2", kind: "generic" }),
    ],
    names: { c1: "Alice" },
  };

  it("lists the events in the order the port gave them, with the key order of the renderer's result", async () => {
    const c = makeCtx(world);
    const r = await c.executors.list_events({});
    expect(r.name).toBe("list_events");
    expect(r.summary).toBe("3 events");
    const content = r.content as { events: Array<Record<string, unknown>> };
    expect(content.events.map((e) => e.id)).toEqual(["e1", "e2", "e3"]);
    expect(Object.keys(content.events[0]!)).toEqual([
      "id",
      "title",
      "kind",
      "ordinal",
      "startTime",
      "startDate",
      "primaryCharacter",
    ]);
    expect(Object.keys(content)).toEqual(["events"]);
    expect(r.tokensUsed).toBe(JSON.stringify(r.content).length);
  });

  it("names the primary character, and null for a name the project has not got or no character", async () => {
    const r = await makeCtx(world).executors.list_events({});
    const events = (r.content as { events: Array<Record<string, unknown>> })
      .events;
    expect(events.map((e) => e.primaryCharacter)).toEqual([
      "Alice",
      null,
      null,
    ]);
  });

  it("keeps an event whose primary character is hidden and replaces only the name with null", async () => {
    const hiddenWorld: World = {
      events: [
        event("e-hidden-person", { primaryCodexId: "c1" }),
        event("e-hidden-person-again", { primaryCodexId: "c1" }),
      ],
      names: { c1: "Alice" },
    };
    const baseline = await makeCtx(hiddenWorld).executors.list_events({});
    expect(
      (
        baseline.content as {
          events: Array<{ primaryCharacter: string | null }>;
        }
      ).events.map((e) => e.primaryCharacter),
    ).toEqual(["Alice", "Alice"]);

    const c = makeCtx(hiddenWorld);
    c.chronicle.listHiddenCodexIds.mockImplementation(async (_p, ids) => {
      c.log.push("listHiddenCodexIds");
      return new Set(ids);
    });
    const r = await c.executors.list_events({});
    const events = (
      r.content as {
        events: Array<{ id: string; primaryCharacter: string | null }>;
      }
    ).events;
    expect(events).toMatchObject([
      { id: "e-hidden-person", primaryCharacter: null },
      { id: "e-hidden-person-again", primaryCharacter: null },
    ]);
    expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", ["c1"]);
  });

  it("asks the port about an empty-string Codex id too (a row whose id is empty and hidden must not slip through)", async () => {
    const emptyIdWorld: World = {
      events: [event("e-empty", { primaryCodexId: "" })],
      names: { "": "Ghost" },
    };
    // 基準：判定が hidden にしなければ、空文字の id の人物の名前も出る。
    const baseline = await makeCtx(emptyIdWorld).executors.list_events({});
    expect(
      (
        baseline.content as {
          events: Array<{ primaryCharacter: string | null }>;
        }
      ).events[0]?.primaryCharacter,
    ).toBe("Ghost");

    const c = makeCtx(emptyIdWorld);
    c.chronicle.listHiddenCodexIds.mockImplementation(async (_p, ids) => {
      c.log.push("listHiddenCodexIds");
      return new Set(ids);
    });
    const r = await c.executors.list_events({});
    expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", [""]);
    expect(
      (r.content as { events: Array<{ primaryCharacter: string | null }> })
        .events[0]?.primaryCharacter,
    ).toBeNull();
  });

  it("skips Codex visibility when no event has a primary Codex id", async () => {
    const c = makeCtx({ events: [event("e1")] });
    await c.executors.list_events({});
    expect(c.chronicle.listHiddenCodexIds).not.toHaveBeenCalled();
  });

  it("writes the date with the calendar, and null without a calendar or without a granularity", async () => {
    const withCal = await makeCtx(world).executors.list_events({});
    const dated = (
      withCal.content as { events: Array<Record<string, unknown>> }
    ).events;
    expect(typeof dated[0]!.startDate).toBe("string");
    expect(dated[0]!.startDate).not.toBe("");
    expect(dated[1]!.startDate).toBeNull();
    const noCal = await makeCtx({
      ...world,
      calendar: null,
    }).executors.list_events({});
    expect(
      (noCal.content as { events: Array<Record<string, unknown>> }).events.map(
        (e) => e.startDate,
      ),
    ).toEqual([null, null, null]);
  });

  it("takes the language of the ui for the date, once per call", async () => {
    const ja = makeCtx({ ...world, lang: "ja" });
    const en = makeCtx({ ...world, lang: "en" });
    const a = await ja.executors.list_events({});
    const b = await en.executors.list_events({});
    expect(ja.getUiLanguage).toHaveBeenCalledTimes(1);
    expect(en.getUiLanguage).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(a.content)).not.toBe(JSON.stringify(b.content));
  });

  it("filters by kind only for birth, death and generic; any other kind is no filter", async () => {
    const kinds = async (kind: unknown) =>
      (
        (await makeCtx(world).executors.list_events({ kind })).content as {
          events: Array<{ id: string }>;
        }
      ).events.map((e) => e.id);
    expect(await kinds("birth")).toEqual(["e1"]);
    expect(await kinds(" death ")).toEqual(["e2"]);
    expect(await kinds("generic")).toEqual(["e3"]);
    expect(await kinds("other")).toEqual(["e1", "e2", "e3"]);
    expect(await kinds(undefined)).toEqual(["e1", "e2", "e3"]);

    const birthOnly = makeCtx(world);
    await birthOnly.executors.list_events({ kind: "birth" });
    expect(birthOnly.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", [
      "c1",
    ]);
  });

  it("reads events, names, and calendar before Codex visibility, without a secrecy tree/order/scene read", async () => {
    const c = makeCtx(world);
    await c.executors.list_events({});
    expect(c.log).toEqual([
      "getTreeState", // the project
      "getEvents",
      "getCodexNames",
      "getCalendar",
      "listHiddenCodexIds",
    ]);
    expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", [
      "c1",
      "c-gone",
    ]);
    expect(c.chronicle.getReadingOrder).not.toHaveBeenCalled();
    expect(c.chronicle.getSceneEvents).not.toHaveBeenCalled();
  });
});

describe("event secrecy is retired from the chronicle read tools", () => {
  const secretWorld = (over: World = {}): World => ({
    events: [
      event("open"),
      event("hid", { secret: true, revealSceneId: "s2" }),
      event("never", { secret: true, revealSceneId: null }),
    ],
    sceneEvents: [],
    ...over,
  });
  const ids = async (c: ReturnType<typeof makeCtx>) =>
    (
      (await c.executors.list_events({})).content as {
        events: Array<{ id: string }>;
      }
    ).events.map((e) => e.id);

  it("shows every secret event regardless of reveal, active scene, or reading order", async () => {
    const c = makeCtx(
      secretWorld({ activeSceneId: null, readingOrder: new Map() }),
    );
    expect(await ids(c)).toEqual(["open", "hid", "never"]);
    expect(c.chronicle.listHiddenCodexIds).not.toHaveBeenCalled();
    expect(c.getTreeState).toHaveBeenCalledTimes(2); // project id and reveal mark
    expect(c.chronicle.getReadingOrder).toHaveBeenCalledTimes(1);
    expect(c.chronicle.getSceneEvents).not.toHaveBeenCalled();
  });
});

describe("get_event_detail", () => {
  const detailWorld = (over: World = {}): World => ({
    events: [
      event("e1", {
        note: "n",
        ordinal: "a0",
        startTime: 3,
        startGranularity: "day",
        endTime: 4,
        endGranularity: "day",
        primaryCodexId: "c1",
        locationCodexId: "c2",
        kind: "birth",
      }),
      event("e2", { title: "effect" }),
      event("hid", { title: "hidden", secret: true, revealSceneId: "s3" }),
    ],
    names: { c1: "Alice", c2: "Place", c3: "Bob" },
    participants: [{ eventId: "e1", codexEntryId: "c3", role: "witness" }],
    sceneEvents: [
      { sceneId: "s2", eventId: "e1" },
      { sceneId: "s-gone", eventId: "e1" },
      { sceneId: "s1", eventId: "e2" },
    ],
    relations: [
      { causeId: "e1", effectId: "e2" },
      { causeId: "e2", effectId: "e1" },
      { causeId: "e1", effectId: "hid" },
      { causeId: "e2", effectId: "e2" },
    ],
    activeSceneId: "s2",
    ...over,
  });

  it("drops a participant whose Codex id is the empty string when the port says it is hidden", async () => {
    const emptyIdWorld = detailWorld({
      events: [event("e1", { primaryCodexId: "", locationCodexId: "" })],
      names: { "": "Ghost" },
      participants: [{ eventId: "e1", codexEntryId: "", role: "witness" }],
    });
    // 基準：hidden にしなければ、名前・参加者が出る。
    const baseline = await makeCtx(emptyIdWorld).executors.get_event_detail({
      eventId: "e1",
    });
    expect(baseline.content).toMatchObject({
      primaryCharacter: "Ghost",
      participants: [{ codexId: "", name: "Ghost" }],
    });

    const c = makeCtx(emptyIdWorld);
    c.chronicle.listHiddenCodexIds.mockImplementation(async (_p, ids) => {
      c.log.push("listHiddenCodexIds");
      return new Set(ids);
    });
    const r = await c.executors.get_event_detail({ eventId: "e1" });
    expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", [""]);
    expect(r.content).toMatchObject({
      primaryCharacter: null,
      location: null,
      participants: [],
    });
  });

  it("answers eventId is required AFTER the project check, with no read", async () => {
    const c = makeCtx(detailWorld());
    const r = await c.executors.get_event_detail({ eventId: "  " });
    expect(r).toEqual({
      name: "get_event_detail",
      content: null,
      summary: "eventId is required",
      tokensUsed: 0,
    });
    expect(c.chronicle.getEvents).not.toHaveBeenCalled();
  });

  it("answers Event not found only when the event does not exist, and reads a secret event", async () => {
    const missing = await makeCtx(detailWorld()).executors.get_event_detail({
      eventId: "nope",
    });
    const secret = await makeCtx(detailWorld()).executors.get_event_detail({
      eventId: "hid",
    });
    expect(missing).toEqual({
      name: "get_event_detail",
      content: null,
      summary: "Event not found",
      tokensUsed: 0,
    });
    expect(secret.summary).toBe("Event 'hidden'");
    expect(
      (secret.content as { relations: unknown[] }).relations,
    ).toContainEqual({ cause: "title-e1", effect: "hidden" });
  });

  it("returns the detail with the key order, names, scene titles, and every causal title", async () => {
    const c = makeCtx(detailWorld());
    const r = await c.executors.get_event_detail({ eventId: " e1 " });
    expect(r.summary).toBe("Event 'title-e1'");
    const content = r.content as Record<string, unknown>;
    expect(Object.keys(content)).toEqual([
      "id",
      "title",
      "note",
      "kind",
      "ordinal",
      "startTime",
      "endTime",
      "startMinute",
      "endMinute",
      "startGranularity",
      "endGranularity",
      "startDate",
      "endDate",
      "precision",
      "primaryCharacter",
      "location",
      "participants",
      "scenes",
      "relations",
    ]);
    expect(content.primaryCharacter).toBe("Alice");
    expect(content.location).toBe("Place");
    expect(content.participants).toEqual([
      { codexId: "c3", name: "Bob", role: "witness" },
    ]);
    expect(content.scenes).toEqual([
      { sceneId: "s2", title: "scene-s2" },
      { sceneId: "s-gone", title: null },
    ]);
    // Causal partners are titles only and are not filtered by event secrecy.
    expect(content.relations).toEqual([
      { cause: "title-e1", effect: "effect" },
      { cause: "effect", effect: "title-e1" },
      { cause: "title-e1", effect: "hidden" },
    ]);
    expect(typeof content.startDate).toBe("string");
    expect(typeof content.endDate).toBe("string");
    // The participants are asked for this one event.
    expect(c.chronicle.listParticipants).toHaveBeenCalledWith("p1", ["e1"]);
  });

  it("hides Codex names and participant rows while keeping the event and causal titles", async () => {
    const world = detailWorld();
    const baseline = await makeCtx(world).executors.get_event_detail({
      eventId: "e1",
    });
    expect(baseline.content).toMatchObject({
      primaryCharacter: "Alice",
      location: "Place",
      participants: [{ codexId: "c3", name: "Bob", role: "witness" }],
    });

    const c = makeCtx(world);
    c.chronicle.listHiddenCodexIds.mockImplementation(async (_p, ids) => {
      c.log.push("listHiddenCodexIds");
      return new Set(ids);
    });
    const r = await c.executors.get_event_detail({ eventId: "e1" });
    const content = r.content as Record<string, unknown>;
    expect(content).toMatchObject({
      id: "e1",
      primaryCharacter: null,
      location: null,
      participants: [],
      relations: [
        { cause: "title-e1", effect: "effect" },
        { cause: "effect", effect: "title-e1" },
        { cause: "title-e1", effect: "hidden" },
      ],
    });
    expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", [
      "c1",
      "c2",
      "c3",
    ]);
  });

  it("reads the five detail sources before Codex visibility and scene titles", async () => {
    const c = makeCtx(detailWorld());
    await c.executors.get_event_detail({ eventId: "e1" });
    expect(c.log).toEqual([
      "getTreeState",
      "getEvents",
      "getCodexNames",
      "listParticipants",
      "getSceneEvents",
      "listRelations",
      "getCalendar",
      "listHiddenCodexIds",
      "getTreeState", // the nodes, for the scene titles
    ]);
    expect(c.chronicle.getReadingOrder).not.toHaveBeenCalled();
  });
});

describe("get_character_timeline", () => {
  const timelineWorld: World = {
    events: [
      event("late", {
        ordinal: "a5",
        startTime: 720,
        kind: "generic",
        primaryCodexId: "c1",
      }),
      event("birth", {
        ordinal: "a1",
        startTime: 360,
        kind: "birth",
        primaryCodexId: "c1",
      }),
      event("with", { ordinal: "a3", startTime: 400 }),
      event("other", { ordinal: "a2", primaryCodexId: "c2" }),
      event("hidden-birth", {
        ordinal: "a0",
        startTime: 0,
        kind: "birth",
        primaryCodexId: "c1",
        secret: true,
        revealSceneId: "s3",
      }),
    ],
    participants: [{ eventId: "with", codexEntryId: "c1", role: null }],
    names: { c1: "Alice" },
    activeSceneId: "s1",
  };

  it("answers codexId is required after the project check, with an empty events list", async () => {
    const c = makeCtx(timelineWorld);
    expect(await c.executors.get_character_timeline({ codexId: " " })).toEqual({
      name: "get_character_timeline",
      content: { events: [] },
      summary: "codexId is required",
      tokensUsed: 0,
    });
    expect(c.chronicle.getEvents).not.toHaveBeenCalled();
  });

  it("lists every involved event by ordinal and uses the earliest birth, including a secret birth", async () => {
    const r = await makeCtx(timelineWorld).executors.get_character_timeline({
      codexId: "c1",
    });
    expect(r.summary).toBe("4 events for Alice");
    const content = r.content as {
      character: string;
      events: Array<Record<string, unknown>>;
    };
    expect(Object.keys(content)).toEqual(["character", "events"]);
    expect(content.events.map((e) => e.id)).toEqual([
      "hidden-birth",
      "birth",
      "with",
      "late",
    ]);
    expect(Object.keys(content.events[0]!)).toEqual([
      "id",
      "title",
      "kind",
      "ordinal",
      "startTime",
      "ageAtEvent",
      "revealScene",
    ]);
    expect(content.events[0]!.revealScene).toEqual({
      id: "s3",
      title: "scene-s3",
      revealedToReader: false,
    });
    // base: the secret birth at 0, 360 days per year
    expect(content.events.map((e) => e.ageAtEvent)).toEqual([0, 1, 1, 2]);
  });

  it("returns the same not-found result for a hidden id and an absent id", async () => {
    const baseline = await makeCtx(
      timelineWorld,
    ).executors.get_character_timeline({
      codexId: "c1",
    });
    expect(baseline.content).toMatchObject({ character: "Alice" });

    for (const codexId of ["c1", "not-in-project"]) {
      const c = makeCtx(timelineWorld);
      c.chronicle.listHiddenCodexIds.mockImplementation(async (_p, ids) => {
        c.log.push("listHiddenCodexIds");
        return new Set(ids);
      });
      await expect(
        c.executors.get_character_timeline({ codexId }),
      ).resolves.toEqual({
        name: "get_character_timeline",
        content: null,
        summary: "Character not found",
        tokensUsed: 0,
      });
      expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", [
        codexId,
      ]);
      expect(c.chronicle.listHiddenCodexIds.mock.calls[0]).toHaveLength(2);
    }
  });

  it("gives no age without a calendar", async () => {
    const r = await makeCtx({
      ...timelineWorld,
      calendar: null,
    }).executors.get_character_timeline({ codexId: "c1" });
    const content = r.content as {
      character: string;
      events: Array<{ ageAtEvent: unknown }>;
    };
    expect(content.character).toBe("Alice");
    expect(content.events.map((e) => e.ageAtEvent)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  const timelineOf = async (world: World) => {
    const r = await makeCtx({
      ...world,
      names: { c1: "Alice" },
    }).executors.get_character_timeline({ codexId: "c1" });
    return (
      r.content as {
        events: Array<{ id: string; ordinal: string; ageAtEvent: unknown }>;
      }
    ).events;
  };

  it("rounds the age down (1.6 years is 1), also before the birth (-0.4 years is -1, not -0)", async () => {
    // 360 days per year, the birth at 360
    const events = await timelineOf({
      events: [
        event("before", {
          ordinal: "a0",
          startTime: 216,
          primaryCodexId: "c1",
        }),
        event("birth", {
          ordinal: "a1",
          startTime: 360,
          kind: "birth",
          primaryCodexId: "c1",
        }),
        event("later", {
          ordinal: "a2",
          startTime: 936,
          primaryCodexId: "c1",
        }),
      ],
      activeSceneId: "s3",
    });
    expect(events.map((e) => [e.id, e.ageAtEvent])).toEqual([
      ["before", -1],
      ["birth", 0],
      ["later", 1],
    ]);
  });

  it("takes the smallest start time of every birth as the base, wherever it is in the list", async () => {
    const birth = (id: string, ordinal: string, startTime: number) =>
      event(id, {
        ordinal,
        startTime,
        kind: "birth",
        primaryCodexId: "c1",
      });
    const events = await timelineOf({
      events: [
        birth("b500", "a0", 500),
        birth("b100", "a1", 100),
        birth("b300", "a2", 300),
        event("later", { ordinal: "a3", startTime: 460, primaryCodexId: "c1" }),
      ],
      activeSceneId: "s3",
    });
    // base 100: (500 - 100) / 360 is 1, (100 - 100) is 0, (300 - 100) is 0, (460 - 100) is 1
    expect(events.map((e) => [e.id, e.ageAtEvent])).toEqual([
      ["b500", 1],
      ["b100", 0],
      ["b300", 0],
      ["later", 1],
    ]);
  });

  it("orders the events by the plain string order of the ordinal (not by its number, not by the locale)", async () => {
    const at = (ordinal: string) =>
      event(`e-${ordinal}`, { ordinal, primaryCodexId: "c1" });
    const events = await timelineOf({
      events: [at("a2"), at("a10"), at("Zz"), at("a0")],
      activeSceneId: "s3",
    });
    // ASCII: "Zz" < "a0" < "a10" < "a2"
    expect(events.map((e) => e.ordinal)).toEqual(["Zz", "a0", "a10", "a2"]);
  });

  it("loads the four sources together, then checks only the requested Codex id", async () => {
    const c = makeCtx(timelineWorld);
    await c.executors.get_character_timeline({ codexId: "c1" });
    expect(c.log).toEqual([
      "getTreeState",
      "getEvents",
      "listParticipants",
      "getCalendar",
      "getCodexNames",
      "listHiddenCodexIds",
      "getTreeState",
      "getReadingOrder",
    ]);
    expect(c.chronicle.listParticipants).toHaveBeenCalledWith("p1");
    expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", ["c1"]);
    expect(c.chronicle.getReadingOrder).toHaveBeenCalledTimes(1);
    expect(c.chronicle.getSceneEvents).not.toHaveBeenCalled();
  });
});

describe("get_chronicle_state", () => {
  const stateWorld = (over: World = {}): World => ({
    events: [
      event("e1", {
        ordinal: "a0",
        startTime: 100,
        startGranularity: "day",
        primaryCodexId: "c1",
        title: "found",
      }),
      event("sec", {
        ordinal: "a1",
        startTime: 200,
        startGranularity: "day",
        primaryCodexId: "c1",
        title: "SECRET-TITLE",
        secret: true,
        revealSceneId: "s2",
      }),
    ],
    sceneEvents: [
      { sceneId: "s1", eventId: "e1" },
      { sceneId: "s2", eventId: "sec" },
    ],
    participants: [{ eventId: "e1", codexEntryId: "c1", role: null }],
    names: { c1: "Alice" },
    activeSceneId: "s3",
    ...over,
  });

  it("answers No sceneId and no active scene when neither is given (the project is checked first)", async () => {
    const c = makeCtx(stateWorld({ activeSceneId: null }));
    expect(await c.executors.get_chronicle_state({})).toEqual({
      name: "get_chronicle_state",
      content: null,
      summary: "No sceneId and no active scene",
      tokensUsed: 0,
    });
    expect(c.chronicle.getEvents).not.toHaveBeenCalled();
    const blank = makeCtx(stateWorld({ activeSceneId: null }));
    expect(
      (await blank.executors.get_chronicle_state({ sceneId: "  " })).summary,
    ).toBe("No sceneId and no active scene");
  });

  it("answers No chronicle events before it loads anything else", async () => {
    const c = makeCtx(stateWorld({ events: [] }));
    expect(await c.executors.get_chronicle_state({})).toEqual({
      name: "get_chronicle_state",
      content: null,
      summary: "No chronicle events",
      tokensUsed: 0,
    });
    for (const fn of [
      c.chronicle.listParticipants,
      c.chronicle.getSceneEvents,
      c.chronicle.getCalendar,
      c.chronicle.listRelations,
      c.chronicle.getCodexNames,
    ]) {
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("returns the calendar summary only when a calendar exists", async () => {
    const withCalendar = await makeCtx(
      stateWorld(),
    ).executors.get_chronicle_state({
      sceneId: "s3",
    });
    expect(withCalendar.content).toHaveProperty("calendar", {
      daysPerYear: CALENDAR.daysPerYear,
      startYear: CALENDAR.startYear,
      months: CALENDAR.months,
      leapRule: CALENDAR.leapRule,
      reform: CALENDAR.reform,
    });
    const withoutCalendar = await makeCtx(
      stateWorld({ calendar: null }),
    ).executors.get_chronicle_state({ sceneId: "s3" });
    expect(withoutCalendar.content).not.toHaveProperty("calendar");
  });

  it("reads the tree state for the active scene ONLY when no sceneId was given", async () => {
    const given = makeCtx(stateWorld());
    await given.executors.get_chronicle_state({ sceneId: "s3" });
    // the project, and the nodes after the events
    expect(given.getTreeState).toHaveBeenCalledTimes(2);
    const omitted = makeCtx(stateWorld());
    await omitted.executors.get_chronicle_state({});
    // the project, the active scene, and the nodes
    expect(omitted.getTreeState).toHaveBeenCalledTimes(3);
  });

  it("copies the anchor reading order and passes it the tree's nodes array", async () => {
    const iterableOnly = {
      [Symbol.iterator]: () =>
        new Map([
          ["s1", 0],
          ["s2", 1],
          ["s3", 2],
        ])[Symbol.iterator](),
    } as unknown as ReadonlyMap<string, number>;
    const c = makeCtx({
      events: [event("e1")],
      sceneEvents: [{ sceneId: "s2", eventId: "e1" }],
      readingOrder: iterableOnly,
    });
    const r = await c.executors.get_chronicle_state({ sceneId: "s3" });
    expect(r.summary).toBe("Chronicle state at scene (proxy)");
    expect(c.chronicle.getReadingOrder).toHaveBeenCalledWith(c.nodes);
    expect(c.chronicle.listHiddenCodexIds).not.toHaveBeenCalled();
  });

  it("uses the model's sceneId for the anchor, while Codex visibility takes only project and ids", async () => {
    // active = s3 (the reveal scene s2 is behind it), the model asks for s1.
    const askedCtx = makeCtx(stateWorld());
    const asked = await askedCtx.executors.get_chronicle_state({
      sceneId: "s1",
    });
    expect(JSON.stringify(asked.content)).not.toContain("SECRET-TITLE");
    const activeCtx = makeCtx(stateWorld());
    const active = await activeCtx.executors.get_chronicle_state({});
    expect(JSON.stringify(active.content)).toContain("SECRET-TITLE");
    expect(active.name).toBe("get_chronicle_state");
    for (const c of [askedCtx, activeCtx]) {
      expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", ["c1"]);
      expect(c.chronicle.listHiddenCodexIds.mock.calls[0]).toHaveLength(2);
    }
  });

  it("marks get_chronicle_state relative to the requested scene or the active scene", async () => {
    const world = {
      events: [event("e1", { ordinal: "a0", revealSceneId: "s2" })],
      sceneEvents: [{ sceneId: "s1", eventId: "e1" }],
      activeSceneId: "s3",
    };
    const requested = await makeCtx(world).executors.get_chronicle_state({
      sceneId: "s1",
    });
    expect(
      (requested.content as { recentEvents: Array<Record<string, unknown>> })
        .recentEvents[0]?.revealScene,
    ).toEqual({
      id: "s2",
      title: "scene-s2",
      revealedToReader: false,
    });

    const active = await makeCtx(world).executors.get_chronicle_state({});
    expect(
      (active.content as { recentEvents: Array<Record<string, unknown>> })
        .recentEvents[0]?.revealScene,
    ).toEqual({ id: "s2", title: "scene-s2", revealedToReader: true });
  });

  it("removes hidden people before selecting snapshot characters", async () => {
    const baseline = await makeCtx(stateWorld()).executors.get_chronicle_state({
      sceneId: "s3",
    });
    expect(
      (baseline.content as { characters: Array<Record<string, unknown>> })
        .characters,
    ).toContainEqual(expect.objectContaining({ codexId: "c1", name: "Alice" }));

    const c = makeCtx(stateWorld());
    c.chronicle.listHiddenCodexIds.mockImplementation(async (_p, ids) => {
      c.log.push("listHiddenCodexIds");
      return new Set(ids);
    });
    const r = await c.executors.get_chronicle_state({ sceneId: "s1" });
    const characters = (
      r.content as { characters: Array<Record<string, unknown>> }
    ).characters;
    expect(characters).toEqual([]);
    expect(JSON.stringify(characters)).not.toContain("Alice");
    expect(JSON.stringify(characters)).not.toContain("c1");
    expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", ["c1"]);
    expect(c.chronicle.listHiddenCodexIds.mock.calls[0]).toHaveLength(2);
  });

  it("does not restore an older location when the latest location Codex is hidden", async () => {
    const world: World = {
      events: [
        event("old-place", {
          ordinal: "a0",
          startTime: 100,
          primaryCodexId: "c1",
          locationCodexId: "old-place-id",
        }),
        event("hidden-place", {
          ordinal: "a1",
          startTime: 200,
          primaryCodexId: "c1",
          locationCodexId: "hidden-place-id",
        }),
      ],
      sceneEvents: [{ sceneId: "s3", eventId: "hidden-place" }],
      names: {
        c1: "Alice",
        "old-place-id": "Old Place",
        "hidden-place-id": "Hidden Place",
      },
    };
    const baseline = await makeCtx(world).executors.get_chronicle_state({
      sceneId: "s3",
    });
    expect(
      (baseline.content as { characters: Array<{ location: string | null }> })
        .characters[0]?.location,
    ).toBe("Hidden Place");

    const c = makeCtx(world);
    c.chronicle.listHiddenCodexIds.mockImplementation(async (_p, ids) => {
      c.log.push("listHiddenCodexIds");
      return new Set(ids.filter((id) => id === "hidden-place-id"));
    });
    const r = await c.executors.get_chronicle_state({ sceneId: "s3" });
    const characters = (
      r.content as {
        characters: Array<{
          codexId: string;
          name: string;
          location: string | null;
        }>;
      }
    ).characters;
    expect(characters).toEqual([
      {
        codexId: "c1",
        name: "Alice",
        status: "unknown",
        age: null,
        location: null,
      },
    ]);
    expect(c.chronicle.listHiddenCodexIds).toHaveBeenCalledWith("p1", [
      "c1",
      "hidden-place-id",
      "old-place-id",
    ]);
  });

  it("skips Codex visibility when the snapshot has no Codex candidates", async () => {
    const c = makeCtx({
      events: [event("e1")],
      sceneEvents: [{ sceneId: "s3", eventId: "e1" }],
    });
    await c.executors.get_chronicle_state({ sceneId: "s3" });
    expect(c.chronicle.listHiddenCodexIds).not.toHaveBeenCalled();
  });

  it("anchors on the scene's own date when it has one (the nodes carry the chronicle columns), and on the stamped events otherwise", async () => {
    const own = makeCtx(
      stateWorld({
        nodes: [
          scene("s1", "a0"),
          scene("s2", "a1"),
          scene("s3", "a2", {
            chronicleStartTime: 300,
            chronicleStartMinute: null,
            chronicleStartGranularity: "day",
            chroniclePrecision: "exact",
          }),
        ],
      }),
    );
    expect((await own.executors.get_chronicle_state({})).summary).toBe(
      "Chronicle state at scene (scene)",
    );
    const stamped = await makeCtx(stateWorld()).executors.get_chronicle_state({
      sceneId: "s1",
    });
    expect(stamped.summary).toBe("Chronicle state at scene (stamped)");
    // a node with no chronicle columns (the optional fields absent) is a node with no date
    const none = await makeCtx(
      stateWorld({ sceneEvents: [], participants: [] }),
    ).executors.get_chronicle_state({ sceneId: "s3" });
    expect(none.summary).toBe("Chronicle state at scene (none)");
  });

  it("takes the defaults of a scene node that lacks the chronicle columns: no granularity is no date, an absent precision is exact", async () => {
    // a start time with no granularity is not a date (the default granularity is "none")
    const undated = await makeCtx(
      stateWorld({
        sceneEvents: [],
        nodes: [
          scene("s1", "a0"),
          scene("s2", "a1"),
          scene("s3", "a2", { chronicleStartTime: 300 }),
        ],
      }),
    ).executors.get_chronicle_state({ sceneId: "s3" });
    expect(undated.summary).toBe("Chronicle state at scene (none)");
    // a dated scene with no precision column reads as "exact"
    const dated = await makeCtx(
      stateWorld({
        sceneEvents: [],
        nodes: [
          scene("s1", "a0"),
          scene("s2", "a1"),
          scene("s3", "a2", {
            chronicleStartTime: 300,
            chronicleStartGranularity: "day",
          }),
        ],
      }),
    ).executors.get_chronicle_state({ sceneId: "s3" });
    expect(dated.summary).toBe("Chronicle state at scene (scene)");
    expect(
      (dated.content as { time: { precision: unknown } }).time.precision,
    ).toBe("exact");
  });

  it("ignores a note and a folder as a source of the scene's own date", async () => {
    const r = await makeCtx(
      stateWorld({
        sceneEvents: [],
        nodes: [
          scene("s3", "a2", { nodeType: "note", chronicleStartTime: 5 }),
          scene("s1", "a0"),
        ],
        readingOrder: new Map([["s3", 0]]),
      }),
    ).executors.get_chronicle_state({ sceneId: "s3" });
    expect(r.summary).toBe("Chronicle state at scene (none)");
  });

  it("keeps the tree and reading-order reads for the anchor, then checks Codex visibility", async () => {
    const c = makeCtx(stateWorld());
    await c.executors.get_chronicle_state({ sceneId: "s3" });
    expect(c.log).toEqual([
      "getTreeState",
      "getEvents",
      "listParticipants",
      "getSceneEvents",
      "getCalendar",
      "listRelations",
      "getCodexNames",
      "getTreeState",
      "getReadingOrder",
      "listHiddenCodexIds",
    ]);
  });

  it("counts tokens from the structured snapshot", async () => {
    const r = await makeCtx(stateWorld()).executors.get_chronicle_state({});
    expect(r.tokensUsed).toBe(JSON.stringify(r.content).length);
  });
});

describe("Codex visibility port failures", () => {
  it("propagates a rejected visibility check from each chronicle read tool", async () => {
    const run = [
      (c: ReturnType<typeof makeCtx>) => c.executors.list_events({}),
      (c: ReturnType<typeof makeCtx>) =>
        c.executors.get_event_detail({ eventId: "e1" }),
      (c: ReturnType<typeof makeCtx>) =>
        c.executors.get_character_timeline({ codexId: "c1" }),
      (c: ReturnType<typeof makeCtx>) => c.executors.get_chronicle_state({}),
    ];
    for (const invoke of run) {
      const c = makeCtx({
        events: [event("e1", { primaryCodexId: "c1" })],
        names: { c1: "Alice" },
      });
      const failure = new Error("Codex visibility failed");
      c.chronicle.listHiddenCodexIds.mockRejectedValue(failure);
      await expect(invoke(c)).rejects.toBe(failure);
    }
  });
});
