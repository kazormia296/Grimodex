// MP-4b PR-7a: Main's context of the chronicle tools (`createMainChronicleReadContext`).
// What is fixed here: one cache per turn (two turns that run at once never meet),
// the shared in-flight load, the failure that is not kept, `clear()`, no module
// state, the Codex names of every entry, the nodes of the turn's tree select, and
// two differences from the renderer that are NOT claimed equal (the cache's
// lifetime, the active scene). Relative imports only.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { CoreReadDbClient } from "../../mastraRead/ports.js";
import { checkReadSql } from "../../mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../../mastraRead/tables.js";
import {
  createMainChronicleReadContext,
  createMainChronicleSearchContext,
} from "./chronicleMainContext.js";
import {
  createChronicleReadExecutors,
  createChronicleSearchExecutors,
} from "./chronicleReadExecutors.js";
import { createCoreReadDb } from "./readDb.js";
import { buildChronicleNodes, buildReadInputs } from "./readInputs.js";
import type { ReadChronicleTreeRow } from "./readInputs.js";
import type { ChronicleReadInputs } from "./readInputsReader.js";

interface Deferred {
  readonly promise: Promise<void>;
  release(): void;
}
function deferred(): Deferred {
  let release!: () => void;
  const promise = new Promise<void>((r) => {
    release = r;
  });
  return { promise, release };
}

/** The columns a select names, in order (the rows are positional). */
function selectColumns(sql: string): string[] {
  const lower = sql.toLowerCase();
  const body = sql.slice(
    lower.indexOf("select ") + "select ".length,
    lower.indexOf(" from "),
  );
  return body
    .split(",")
    .map((c) => c.trim().replace(/^.*\./u, "").replace(/"/gu, ""));
}

const eventRow = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  project_id: "p1",
  title: `title-${id}`,
  note: null,
  detail: null,
  ordinal: "a0",
  primary_codex_id: null,
  lane_group: null,
  location_codex_id: null,
  start_time: null,
  end_time: null,
  start_minute: null,
  end_minute: null,
  start_granularity: "none",
  end_granularity: "none",
  precision: "exact",
  kind: "generic",
  secret: 0,
  reveal_scene_id: null,
  created_at: "c",
  updated_at: "u",
  version: 0,
  ...over,
});

interface ProjectData {
  events: Array<Record<string, unknown>>;
  sceneEvents?: Array<{ scene_id: string; event_id: string }>;
  codex?: Array<{
    id: string;
    name: string;
    summary?: string | null;
    context_mode?: string;
  }>;
}

/**
 * A client that answers from `data[projectId]` (the first parameter of every
 * chronicle statement), counts the statements by table, and can hold the answer
 * of a table until it is released.
 */
function makeClient(data: Record<string, ProjectData>) {
  const statements: Array<{ table: string; projectId: unknown; sql: string }> =
    [];
  const hold: Partial<Record<string, Deferred>> = {};
  const failNext: Partial<Record<string, Error>> = {};
  const client: CoreReadDbClient = async (sql, params, method) => {
    const checked = checkReadSql(sql, MAIN_READ_TABLE_SET);
    if (!checked.ok) throw new Error(`refused: ${checked.code}`);
    expect(method).toBe("all");
    const table = /from "([a-z_]+)"/u.exec(sql)?.[1] ?? "";
    const projectId = params[0];
    statements.push({ table, projectId, sql });
    const gate = hold[table];
    if (gate) await gate.promise;
    const failure = failNext[table];
    if (failure) {
      delete failNext[table];
      throw failure;
    }
    const d = data[String(projectId)] ?? { events: [] };
    const columns = selectColumns(sql);
    const source: Array<Record<string, unknown>> =
      table === "events"
        ? d.events
        : table === "scene_events"
          ? (d.sceneEvents ?? [])
          : table === "codex_entries"
            ? (d.codex ?? [])
            : [];
    return { rows: source.map((row) => columns.map((c) => row[c])) };
  };
  const count = (table: string, projectId?: string) =>
    statements.filter(
      (s) =>
        s.table === table &&
        (projectId === undefined || s.projectId === projectId),
    ).length;
  return { client, statements, hold, failNext, count };
}

const treeRow = (
  id: string,
  sortOrder: string,
  over: Partial<ReadChronicleTreeRow> = {},
): ReadChronicleTreeRow => ({
  id,
  parentId: null,
  nodeType: "scene",
  sortOrder,
  storyTimeOrder: null,
  archivedAt: null,
  title: `scene-${id}`,
  chronicleStartTime: null,
  chronicleStartMinute: null,
  chronicleStartGranularity: "none",
  chroniclePrecision: "exact",
  ...over,
});

function turnOf(
  projectId: string,
  rows: ReadChronicleTreeRow[],
  currentSceneId: string | null,
): ChronicleReadInputs {
  return {
    inputs: buildReadInputs({
      projectId,
      treeRows: rows,
      project: { phaseResolutionMode: "reading" },
      currentSceneId,
    }),
    nodes: buildChronicleNodes(rows),
  };
}

const ROWS = [treeRow("s1", "a0"), treeRow("s2", "a1"), treeRow("s3", "a2")];

function makeMain(
  client: CoreReadDbClient,
  turn: ChronicleReadInputs,
  lang: "ja" | "en" = "ja",
) {
  const getUiLanguage = vi.fn(() => lang);
  const made = createMainChronicleReadContext({
    db: createCoreReadDb(client),
    turn,
    countTokens: (text) => text.length,
    getUiLanguage,
  });
  return {
    ...made,
    getUiLanguage,
    executors: createChronicleReadExecutors(made.ctx),
  };
}

const listIds = async (m: ReturnType<typeof makeMain>) =>
  (
    (await m.executors.list_events({})).content as {
      events: Array<{ id: string }>;
    }
  ).events.map((e) => e.id);

describe("the turn's tree state", () => {
  it("is one fixed object: the turn's project, the nodes of the turn's tree select (same reference each time), the turn's current scene", () => {
    const { client } = makeClient({});
    const turn = turnOf("p1", ROWS, "s2");
    const m = makeMain(client, turn);
    const a = m.ctx.getTreeState();
    const b = m.ctx.getTreeState();
    expect(a).toBe(b);
    expect(a.projectId).toBe("p1");
    expect(a.nodes).toBe(turn.nodes);
    expect(a.activeSceneId).toBe("s2");
  });

  it("answers the reading order of the turn whatever nodes it is asked about", () => {
    const { client } = makeClient({});
    const turn = turnOf("p1", ROWS, null);
    const m = makeMain(client, turn);
    expect(m.ctx.chronicle.getReadingOrder([])).toBe(turn.inputs.readingOrder);
    expect(m.ctx.chronicle.getReadingOrder(turn.nodes)).toBe(
      turn.inputs.readingOrder,
    );
    expect([...turn.inputs.readingOrder.keys()]).toEqual(["s1", "s2", "s3"]);
  });

  it("uses the turn's reading order to find the prior anchor for get_chronicle_state", async () => {
    const { client } = makeClient({
      p1: {
        events: [eventRow("e1", { start_time: 10, start_granularity: "day" })],
        sceneEvents: [{ scene_id: "s2", event_id: "e1" }],
      },
    });
    const m = makeMain(client, turnOf("p1", ROWS, null));
    const result = await m.executors.get_chronicle_state({ sceneId: "s3" });
    expect(result.summary).toBe("Chronicle state at scene (proxy)");
  });

  it("reads nothing when the context is made, and the language only when a tool asks for it", async () => {
    const { client, statements } = makeClient({
      p1: { events: [eventRow("e1")] },
    });
    const m = makeMain(client, turnOf("p1", ROWS, "s3"), "en");
    expect(statements).toEqual([]);
    expect(m.getUiLanguage).not.toHaveBeenCalled();
    await m.executors.list_events({});
    expect(m.getUiLanguage).toHaveBeenCalledTimes(1);
  });
});

describe("one cache per turn", () => {
  const data = {
    pA: { events: [eventRow("a-e", { project_id: "pA" })] },
    pB: { events: [eventRow("b-e", { project_id: "pB" })] },
  };

  it("two turns that run at once, started alternately, never see each other's events (even while one of them clears)", async () => {
    const { client, hold, count } = makeClient(data);
    hold.events = deferred();
    const a = makeMain(client, turnOf("pA", ROWS, "s3"));
    const b = makeMain(client, turnOf("pB", ROWS, "s3"));
    const pa = listIds(a);
    const pb = listIds(b);
    // B clears while both loads are in flight: A's load must still answer A.
    b.clear();
    hold.events.release();
    expect(await pa).toEqual(["a-e"]);
    expect(await pb).toEqual(["b-e"]);
    expect(count("events", "pA")).toBe(1);
    expect(count("events", "pB")).toBe(1);
    // Each is kept by its own turn: the second round does not load again, and
    // B's clear() did not touch A's slot.
    expect(await listIds(a)).toEqual(["a-e"]);
    expect(count("events", "pA")).toBe(1);
    expect(await listIds(b)).toEqual(["b-e"]);
    expect(count("events", "pB")).toBe(2); // B cleared, so it loaded once more
  });

  it("two turns of the SAME project do not share a slot either", async () => {
    const { client, count } = makeClient({ p1: { events: [eventRow("e1")] } });
    const a = makeMain(client, turnOf("p1", ROWS, "s3"));
    const b = makeMain(client, turnOf("p1", ROWS, "s3"));
    await listIds(a);
    await listIds(b);
    expect(count("events")).toBe(2);
  });

  it("two tools that run at the same time in one turn share ONE in-flight load", async () => {
    const { client, hold, count } = makeClient({
      p1: {
        events: [eventRow("e1", { primary_codex_id: "c1" })],
        codex: [
          { id: "c1", name: "Alice", summary: null, context_mode: "always" },
        ],
      },
    });
    hold.events = deferred();
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    const first = m.executors.list_events({});
    const second = m.executors.get_event_detail({ eventId: "e1" });
    const third = m.executors.get_character_timeline({ codexId: "c1" });
    hold.events.release();
    await Promise.all([first, second, third]);
    expect(count("events")).toBe(1);
    expect(count("scene_events")).toBe(1);
    expect(count("codex_entries")).toBe(4); // one names load and three uncached visibility reads
    expect(count("codex_entry_phases")).toBe(3);
  });

  it("does not keep a failed load: the next call asks again", async () => {
    const { client, failNext, count } = makeClient({
      p1: { events: [eventRow("e1")] },
    });
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    failNext.events = new Error("db down");
    await expect(m.executors.list_events({})).rejects.toThrow(/Failed query/u);
    expect(await listIds(m)).toEqual(["e1"]);
    expect(count("events")).toBe(2);
  });

  it("a load that was in flight at clear() does not come back into the slot", async () => {
    const data1 = { p1: { events: [eventRow("old")] } };
    const { client, hold, count } = makeClient(data1);
    hold.events = deferred();
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    const pending = listIds(m);
    m.clear();
    hold.events.release();
    expect(await pending).toEqual(["old"]);
    delete hold.events;
    // the data changed after the load that was cleared
    data1.p1.events = [eventRow("new")];
    expect(await listIds(m)).toEqual(["new"]);
    expect(count("events")).toBe(2);
  });

  it("clear() drops events, bridges and names together, and a second clear() is harmless", async () => {
    const { client, count } = makeClient({
      p1: {
        events: [eventRow("e1")],
        sceneEvents: [{ scene_id: "s2", event_id: "e1" }],
      },
    });
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    const readWithBridgeAndNames = async () => {
      await m.executors.get_event_detail({ eventId: "e1" });
      await m.executors.get_chronicle_state({ sceneId: "s3" });
    };
    await readWithBridgeAndNames();
    expect([
      count("events"),
      count("scene_events"),
      count("codex_entries"),
    ]).toEqual([1, 1, 1]);
    m.clear();
    m.clear();
    await readWithBridgeAndNames();
    expect([
      count("events"),
      count("scene_events"),
      count("codex_entries"),
    ]).toEqual([2, 2, 2]);
  });

  it("reads the calendar, participants and relations on every call (only events, bridges and names are held)", async () => {
    const { client, count } = makeClient({ p1: { events: [eventRow("e1")] } });
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    await m.executors.list_events({});
    await m.executors.list_events({});
    await m.executors.get_event_detail({ eventId: "e1" });
    await m.executors.get_event_detail({ eventId: "e1" });
    expect(count("events")).toBe(1);
    expect(count("project_calendar")).toBe(4);
    expect(count("event_participants")).toBe(2);
    expect(count("event_relations")).toBe(2);
  });
});

describe("event row changes during a turn", () => {
  // Main holds the first events read for the context lifetime; clear() reloads it.
  it("a title changed after list_events first reads remains held until clear()", async () => {
    const data = { p1: { events: [eventRow("e1", { title: "Before" })] } };
    const { client } = makeClient(data);
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    const titles = async () =>
      (
        (await m.executors.list_events({})).content as {
          events: Array<{ title: string }>;
        }
      ).events.map((event) => event.title);
    expect(await titles()).toEqual(["Before"]);
    data.p1.events = [eventRow("e1", { title: "After" })];
    expect(await titles()).toEqual(["Before"]);
    m.clear();
    expect(await titles()).toEqual(["After"]);
  });

  it("a title changed after get_event_detail first reads remains held across tools until clear()", async () => {
    const data = { p1: { events: [eventRow("e1", { title: "Before" })] } };
    const { client } = makeClient(data);
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    const detail = await m.executors.get_event_detail({ eventId: "e1" });
    expect((detail.content as { title: string }).title).toBe("Before");
    data.p1.events = [eventRow("e1", { title: "After" })];
    const listed = await m.executors.list_events({});
    expect(
      (listed.content as { events: Array<{ title: string }> }).events[0]!.title,
    ).toBe("Before");
    m.clear();
    const reloaded = await m.executors.get_event_detail({ eventId: "e1" });
    expect((reloaded.content as { title: string }).title).toBe("After");
  });
});

describe("the Codex names", () => {
  it("returns every project's entry name by id, including hidden ones, from a two-column select", async () => {
    const codex = [
      { id: "c1", name: "Alice" },
      {
        id: "c-hidden",
        name: "Hidden Person",
        summary: null,
        context_mode: "hidden",
      },
      { id: "c3", name: "" },
    ];
    const { client, statements } = makeClient({
      p1: {
        events: [eventRow("e1")],
        codex,
      },
    });
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    const names = await m.ctx.chronicle.getCodexNames("p1");
    expect([...names.entries()]).toEqual(codex.map((c) => [c.id, c.name]));
    const select = statements.find((s) => s.table === "codex_entries")!;
    expect(selectColumns(select.sql).sort()).toEqual(["id", "name"]);
    expect(select.projectId).toBe("p1");
  });
});

it("list_events hides a base-hidden primary Codex name after a visible-name baseline", async () => {
  const data = {
    p1: {
      events: [eventRow("e1", { primary_codex_id: "c-hidden" })],
      codex: [
        {
          id: "c-hidden",
          name: "Hidden Person",
          summary: null,
          context_mode: "always",
        },
      ],
    },
  };
  const { client } = makeClient(data);
  const visible = makeMain(client, turnOf("p1", ROWS, "s3"));
  const baseline = await visible.executors.list_events({});
  expect(
    (baseline.content as { events: Array<{ primaryCharacter: unknown }> })
      .events[0]!.primaryCharacter,
  ).toBe("Hidden Person");

  data.p1.codex[0]!.context_mode = "hidden";
  const hidden = makeMain(client, turnOf("p1", ROWS, "s3"));
  expect([
    ...(await hidden.ctx.chronicle.getCodexNames("p1")).entries(),
  ]).toContainEqual(["c-hidden", "Hidden Person"]);
  const result = await hidden.executors.list_events({});
  expect(
    (result.content as { events: Array<{ primaryCharacter: unknown }> })
      .events[0]!.primaryCharacter,
  ).toBeNull();
});

describe("Main's event read ignores secret and still fails closed on a missing revealSceneId", () => {
  // `readEventsFailClosed` (not `readEvents`) is what Main's context loads
  // events with. The rows below are what a reader that lost a column would
  // return; `normalizeEvent` would turn each of them into a public event.
  // `secret` is no longer a visibility gate, but a missing revealSceneId column
  // remains an invalid row on Main's read path.
  it("does not hide an event when its secret value is null", async () => {
    const { client } = makeClient({
      p1: { events: [eventRow("e1", { secret: null })] },
    });
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    expect(await listIds(m)).toEqual(["e1"]);
    const detail = await m.executors.get_event_detail({ eventId: "e1" });
    expect((detail.content as { id: string }).id).toBe("e1");
  });

  it("rejects list_events and get_event_detail when revealSceneId is missing", async () => {
    const { client } = makeClient({
      p1: { events: [eventRow("e1", { reveal_scene_id: undefined })] },
    });
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    await expect(m.executors.list_events({})).rejects.toThrow(
      /usable .revealSceneId. column/u,
    );
    await expect(
      m.executors.get_event_detail({ eventId: "e1" }),
    ).rejects.toThrow(/usable .revealSceneId. column/u);
  });
});

describe("the active scene (NOT equal to the renderer)", () => {
  // The renderer's tree store hands `activeSceneId` as it is; Main's turn input
  // is the wire's scene already narrowed to a live scene of the reading order
  // (`ReadInputs.currentSceneId`). A scene that is not in the order is therefore
  // "no active scene" here, and `get_chronicle_state` with no sceneId stops,
  // where the renderer goes on with that id. Fixed as a difference.
  const data = {
    p1: {
      events: [eventRow("e1", { start_time: 5, start_granularity: "day" })],
    },
  };

  it("a current scene that is not in the reading order is no active scene, and an omitted sceneId stops with the message", async () => {
    const { client } = makeClient(data);
    const rows = [...ROWS, treeRow("s-arch", "a3", { archivedAt: "x" })];
    for (const current of ["s-arch", "nonexistent", "", null]) {
      const m = makeMain(client, turnOf("p1", rows, current));
      expect(m.ctx.getTreeState().activeSceneId).toBeNull();
      const r = await m.executors.get_chronicle_state({});
      expect(r.summary).toBe("No sceneId and no active scene");
    }
  });

  it("a sceneId the model gives still works (the model's sceneId is the position, moved as it is)", async () => {
    const { client } = makeClient(data);
    const m = makeMain(client, turnOf("p1", ROWS, null));
    const r = await m.executors.get_chronicle_state({ sceneId: "s2" });
    expect(r.summary).toMatch(/^Chronicle state at scene \(/u);
  });

  it("a live scene of the order is the active scene", async () => {
    const { client } = makeClient(data);
    const m = makeMain(client, turnOf("p1", ROWS, "s2"));
    expect(m.ctx.getTreeState().activeSceneId).toBe("s2");
    expect((await m.executors.get_chronicle_state({})).summary).toMatch(
      /^Chronicle state at scene \(/u,
    );
  });
});

describe("search_events' main context loads event rows only after dense hits", () => {
  it("uses the turn's project and marks a hit from its event row", async () => {
    const { client, statements } = makeClient({
      p1: { events: [eventRow("e1", { reveal_scene_id: "s2" })] },
    });
    const eventsSemantic = vi.fn(async () => [
      {
        eventId: "e1",
        title: "title-e1",
        kind: "generic",
        score: 0.5,
      },
    ]);
    const ctx = createMainChronicleSearchContext({
      db: createCoreReadDb(client),
      turn: turnOf("p1", ROWS, "s3"),
      countTokens: (text) => text.length,
      native: { eventsSemantic },
    });
    const executors = createChronicleSearchExecutors(ctx);

    const result = await executors.search_events({ query: "q" });
    expect(result.content).toEqual([
      {
        eventId: "e1",
        title: "title-e1",
        kind: "generic",
        score: 0.5,
        revealScene: {
          id: "s2",
          title: "scene-s2",
          revealedToReader: true,
        },
      },
    ]);
    expect(ctx).toHaveProperty("chronicle");
    expect(eventsSemantic).toHaveBeenCalledWith({
      projectId: "p1",
      query: "q",
      limit: 30,
    });
    expect(statements.map((statement) => statement.table)).toEqual(["events"]);
  });

  it("does not read event rows for an empty dense result", async () => {
    const { client, statements } = makeClient({});
    const ctx = createMainChronicleSearchContext({
      db: createCoreReadDb(client),
      turn: turnOf("p1", ROWS, "s3"),
      countTokens: (text) => text.length,
      native: { eventsSemantic: vi.fn(async () => []) },
    });
    await createChronicleSearchExecutors(ctx).search_events({ query: "q" });
    expect(statements).toEqual([]);
  });
});

it("Main's three chronicle event tools include the same revealScene mark", async () => {
  const { client } = makeClient({
    p1: {
      events: [
        eventRow("e1", {
          primary_codex_id: "c1",
          reveal_scene_id: "s2",
        }),
      ],
      codex: [
        { id: "c1", name: "Alice", summary: null, context_mode: "always" },
      ],
    },
  });
  const m = makeMain(client, turnOf("p1", ROWS, "s3"));
  const expected = {
    id: "s2",
    title: "scene-s2",
    revealedToReader: true,
  };
  const listed = await m.executors.list_events({});
  const detail = await m.executors.get_event_detail({ eventId: "e1" });
  const timeline = await m.executors.get_character_timeline({ codexId: "c1" });
  expect(
    (listed.content as { events: Array<{ revealScene?: unknown }> }).events[0]
      ?.revealScene,
  ).toEqual(expected);
  expect((detail.content as { revealScene?: unknown }).revealScene).toEqual(
    expected,
  );
  expect(
    (timeline.content as { events: Array<{ revealScene?: unknown }> }).events[0]
      ?.revealScene,
  ).toEqual(expected);
});

describe("no state outside the context (static check of the sources)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (name: string) =>
    readFileSync(resolve(here, name), "utf8").replace(
      /\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu,
      "",
    );

  it.each(["chronicleMainContext.ts", "sharedLoader.ts"])(
    "%s has no module-level mutable state, no registry and no singleton",
    (file) => {
      const source = read(file);
      // top level (column 0) `let` / `var`, or a `const x = new Map|Set|SharedLoader`
      expect(source).not.toMatch(/^(let|var)\s/mu);
      expect(source).not.toMatch(
        /^(export\s+)?const\s+\w+\s*(:[^=]+)?=\s*new\s+(Map|Set|WeakMap|WeakSet|SharedLoader|Array)\b/mu,
      );
      expect(source).not.toContain("registerToolTurnReset");
      expect(source).not.toContain("toolTurnCache");
      expect(source).not.toMatch(/globalThis|process\.env/u);
    },
  );

  it("chronicleMainContext.ts builds its three loaders inside the factory, not at module level", () => {
    const source = read("chronicleMainContext.ts");
    const factory = source.indexOf(
      "export function createMainChronicleReadContext",
    );
    expect(factory).toBeGreaterThan(0);
    const before = source.slice(0, factory);
    expect(before).not.toMatch(/new SharedLoader/u);
    expect(source.match(/new SharedLoader/gu)).toHaveLength(3);
  });
});
