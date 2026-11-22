// MP-4b PR-7a: the four chronicle tools of the read core, on in-memory ports.
// What is fixed here is the behaviour moved from the renderer (the project is
// checked before the arguments, the order of the reads, the secrecy rule, the
// shape and key order of every result); the equality with the renderer is the
// PR-0 golden (`readCore.mainAdapter.test.ts`, the real-addon spec). Relative
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
    getReadingOrder: vi.fn((ns: readonly CoreTreeNode[]) => {
      log.push("getReadingOrder");
      return (
        world.readingOrder ??
        new Map(
          ns.filter((n) => n.nodeType === "scene").map((n, i) => [n.id, i]),
        )
      );
    }),
    listParticipants: vi.fn(async (_p: string, _ids?: string[]) => {
      log.push("listParticipants");
      return world.participants ?? [];
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
    for (const fn of [
      c.chronicle.getCodexNames,
      c.chronicle.getCalendar,
      c.chronicle.getSceneEvents,
    ]) {
      expect(fn).toHaveBeenCalledWith("p1");
    }
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
  });

  it("reads in the order getEvents, getCodexNames, getCalendar, then the tree state and getSceneEvents (the secrecy check)", async () => {
    const c = makeCtx(world);
    await c.executors.list_events({});
    expect(c.log).toEqual([
      "getTreeState", // the project
      "getEvents",
      "getCodexNames",
      "getCalendar",
      "getTreeState", // visibleEventIds: the state is read, then the bridges are awaited
      "getReadingOrder",
      "getSceneEvents",
    ]);
  });
});

describe("the secrecy rule of the chronicle (a secret event is hidden until the reading position reaches its reveal scene)", () => {
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

  it("hides before the reveal scene, shows from it on, and keeps a secret with no reveal hidden for good", async () => {
    expect(await ids(makeCtx(secretWorld({ activeSceneId: "s1" })))).toEqual([
      "open",
    ]);
    expect(await ids(makeCtx(secretWorld({ activeSceneId: "s2" })))).toEqual([
      "open",
      "hid",
    ]);
    expect(await ids(makeCtx(secretWorld({ activeSceneId: "s3" })))).toEqual([
      "open",
      "hid",
    ]);
  });

  it("fails closed when the position is unknown: no active scene, or a scene that is not in the reading order", async () => {
    expect(await ids(makeCtx(secretWorld({ activeSceneId: null })))).toEqual([
      "open",
    ]);
    expect(
      await ids(makeCtx(secretWorld({ activeSceneId: "not-a-scene" }))),
    ).toEqual(["open"]);
  });

  it("fails closed when the reading order is EMPTY: nothing the port does not know about reveals a secret", async () => {
    // A reader that lost the reading order (an empty map) must hide every
    // secret event, even for a scene that would otherwise have reached it.
    expect(
      await ids(
        makeCtx(secretWorld({ activeSceneId: "s3", readingOrder: new Map() })),
      ),
    ).toEqual(["open"]);
  });

  it("derives the reveal from the first stamped scene in the reading order when there is no explicit one", async () => {
    const w = secretWorld({
      events: [event("auto", { secret: true, revealSceneId: null })],
      sceneEvents: [
        { sceneId: "s3", eventId: "auto" },
        { sceneId: "s2", eventId: "auto" },
      ],
    });
    expect(await ids(makeCtx({ ...w, activeSceneId: "s1" }))).toEqual([]);
    expect(await ids(makeCtx({ ...w, activeSceneId: "s2" }))).toEqual(["auto"]);
  });

  it("copies the reading order of the port before it uses it (the port's answer is never the object the rule reads)", async () => {
    // An object that can only be iterated: `new Map(it)` works on it, `.has`
    // does not exist. A core that passed the port's answer on would throw.
    const iterableOnly = {
      [Symbol.iterator]: () =>
        new Map([
          ["s1", 0],
          ["s2", 1],
          ["s3", 2],
        ])[Symbol.iterator](),
    } as unknown as ReadonlyMap<string, number>;
    const w = secretWorld({ activeSceneId: "s2", readingOrder: iterableOnly });
    expect(await ids(makeCtx(w))).toEqual(["open", "hid"]);
    const detail = makeCtx({ ...w, events: [event("e1")] });
    await expect(
      detail.executors.get_event_detail({ eventId: "e1" }),
    ).resolves.toMatchObject({ summary: "Event 'title-e1'" });
    const state = makeCtx({ ...w, events: [event("e1")] });
    await expect(
      state.executors.get_chronicle_state({ sceneId: "s2" }),
    ).resolves.toMatchObject({ name: "get_chronicle_state" });
  });

  it("hands the SAME nodes array of the tree state to the reading-order port (the renderer memoizes by its reference)", async () => {
    for (const run of [
      (c: ReturnType<typeof makeCtx>) => c.executors.list_events({}),
      (c: ReturnType<typeof makeCtx>) =>
        c.executors.get_event_detail({ eventId: "e1" }),
      (c: ReturnType<typeof makeCtx>) =>
        c.executors.get_character_timeline({ codexId: "c1" }),
      (c: ReturnType<typeof makeCtx>) => c.executors.get_chronicle_state({}),
    ]) {
      const c = makeCtx({ events: [event("e1")] });
      await run(c);
      expect(c.chronicle.getReadingOrder).toHaveBeenCalled();
      for (const call of c.chronicle.getReadingOrder.mock.calls) {
        expect(call[0]).toBe(c.nodes);
      }
    }
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
    participants: [
      { eventId: "e1", codexEntryId: "c3", role: "witness" },
      { eventId: "e1", codexEntryId: "c-gone", role: null },
    ],
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

  it("answers Event not found for an event that does not exist AND for one that is hidden (no oracle)", async () => {
    const missing = await makeCtx(detailWorld()).executors.get_event_detail({
      eventId: "nope",
    });
    const hidden = await makeCtx(detailWorld()).executors.get_event_detail({
      eventId: "hid",
    });
    expect(hidden).toEqual(missing);
    expect(missing).toEqual({
      name: "get_event_detail",
      content: null,
      summary: "Event not found",
      tokensUsed: 0,
    });
    // from its reveal scene on, the same event is found
    const later = await makeCtx(
      detailWorld({ activeSceneId: "s3" }),
    ).executors.get_event_detail({ eventId: "hid" });
    expect(later.summary).toBe("Event 'hidden'");
  });

  it("returns the detail with the key order, names, scene titles, and only the relations whose both ends are visible", async () => {
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
      { codexId: "c-gone", name: null, role: null },
    ]);
    expect(content.scenes).toEqual([
      { sceneId: "s2", title: "scene-s2" },
      { sceneId: "s-gone", title: null },
    ]);
    // e1->hid is dropped (the other end is hidden); both directions of e1<->e2 stay.
    expect(content.relations).toEqual([
      { cause: "title-e1", effect: "effect" },
      { cause: "effect", effect: "title-e1" },
    ]);
    expect(typeof content.startDate).toBe("string");
    expect(typeof content.endDate).toBe("string");
    // The participants are asked for this one event.
    expect(c.chronicle.listParticipants).toHaveBeenCalledWith("p1", ["e1"]);
  });

  it("reads getEvents, then the secrecy check (tree state, getSceneEvents), then the five loads", async () => {
    const c = makeCtx(detailWorld());
    await c.executors.get_event_detail({ eventId: "e1" });
    expect(c.log).toEqual([
      "getTreeState",
      "getEvents",
      "getTreeState",
      "getReadingOrder",
      "getSceneEvents",
      "getCodexNames",
      "listParticipants",
      "getSceneEvents",
      "listRelations",
      "getCalendar",
      "getTreeState", // the nodes, for the scene titles
    ]);
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

  it("lists the involved visible events by ordinal, with the age from the earliest visible birth (a hidden birth is no base)", async () => {
    const r = await makeCtx(timelineWorld).executors.get_character_timeline({
      codexId: "c1",
    });
    expect(r.summary).toBe("3 events for Alice");
    const content = r.content as {
      character: string;
      events: Array<Record<string, unknown>>;
    };
    expect(Object.keys(content)).toEqual(["character", "events"]);
    expect(content.events.map((e) => e.id)).toEqual(["birth", "with", "late"]);
    expect(Object.keys(content.events[0]!)).toEqual([
      "id",
      "title",
      "kind",
      "ordinal",
      "startTime",
      "ageAtEvent",
    ]);
    // base: 360 (the hidden birth at 0 is not one), 360 days per year
    expect(content.events.map((e) => e.ageAtEvent)).toEqual([0, 0, 1]);
    // from its reveal scene on, the earlier birth is the base
    const later = await makeCtx({
      ...timelineWorld,
      activeSceneId: "s3",
    }).executors.get_character_timeline({ codexId: "c1" });
    expect(
      (later.content as { events: Array<{ ageAtEvent: unknown }> }).events.map(
        (e) => e.ageAtEvent,
      ),
    ).toEqual([0, 1, 1, 2]);
  });

  it("gives no age without a calendar, and names an unknown character by its id", async () => {
    const r = await makeCtx({
      ...timelineWorld,
      calendar: null,
      names: {},
    }).executors.get_character_timeline({ codexId: "c1" });
    const content = r.content as {
      character: string;
      events: Array<{ ageAtEvent: unknown }>;
    };
    expect(content.character).toBe("c1");
    expect(content.events.map((e) => e.ageAtEvent)).toEqual([null, null, null]);
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

  it("takes the smallest start time of the visible births as the base, wherever it is in the list (not the first and not the last)", async () => {
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

  it("loads the four sources together, then the secrecy check", async () => {
    const c = makeCtx(timelineWorld);
    await c.executors.get_character_timeline({ codexId: "c1" });
    expect(c.log).toEqual([
      "getTreeState",
      "getEvents",
      "listParticipants",
      "getCalendar",
      "getCodexNames",
      "getTreeState",
      "getReadingOrder",
      "getSceneEvents",
    ]);
    expect(c.chronicle.listParticipants).toHaveBeenCalledWith("p1");
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

  it("takes the model's sceneId as the position of the secrecy check, over the active scene (an existing behaviour, moved as it is)", async () => {
    // active = s3 (the reveal scene s2 is behind it), the model asks for s1.
    const asked = await makeCtx(stateWorld()).executors.get_chronicle_state({
      sceneId: "s1",
    });
    expect(JSON.stringify(asked.content)).not.toContain("SECRET-TITLE");
    const active = await makeCtx(stateWorld()).executors.get_chronicle_state(
      {},
    );
    expect(JSON.stringify(active.content)).toContain("SECRET-TITLE");
    expect(active.name).toBe("get_chronicle_state");
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

  it("loads the five sources together after the events and the order, with the nodes read last", async () => {
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
    ]);
  });

  it("is the result of the renderer's own functions for the same data (token count of the content included)", async () => {
    const r = await makeCtx(stateWorld()).executors.get_chronicle_state({});
    expect(r.tokensUsed).toBe(JSON.stringify(r.content).length);
  });
});
