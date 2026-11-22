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
import { createMainChronicleReadContext } from "./chronicleMainContext.js";
import { createChronicleReadExecutors } from "./chronicleReadExecutors.js";
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
  codex?: Array<{ id: string; name: string }>;
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

  it("uses that reading order for the secrecy rule: a secret event is shown from its reveal scene on, hidden before it, and for a position outside the order", async () => {
    const { client } = makeClient({
      p1: {
        events: [eventRow("sec", { secret: 1, reveal_scene_id: "s2" })],
      },
    });
    const at = async (current: string | null) =>
      listIds(makeMain(client, turnOf("p1", ROWS, current)));
    expect(await at("s1")).toEqual([]);
    expect(await at("s2")).toEqual(["sec"]);
    expect(await at("s3")).toEqual(["sec"]);
    expect(await at("not-a-scene")).toEqual([]);
    expect(await at(null)).toEqual([]);
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
      p1: { events: [eventRow("e1")] },
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
    expect(count("codex_entries")).toBe(1);
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
    const { client, count } = makeClient({ p1: { events: [eventRow("e1")] } });
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    await listIds(m);
    expect([
      count("events"),
      count("scene_events"),
      count("codex_entries"),
    ]).toEqual([1, 1, 1]);
    m.clear();
    m.clear();
    await listIds(m);
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

describe("a change in the middle of a turn (NOT equal to the renderer: held for Q5, DR-MP4-37)", () => {
  // The renderer drops its cache for every batch of tools, so an event's `secret`
  // changed between two batches of one turn is seen by the second batch. Main's
  // cache lives as long as the turn's context, so the second call below does NOT
  // see the change until `clear()`. This is a characterization of the Main side
  // (what it does today), written down so that Q5 changes it on purpose; it is not
  // an equivalence and no equivalence test claims it.
  it("a secret event that becomes public in the database stays hidden for the rest of the turn, and a later turn or clear() sees it", async () => {
    const data = {
      p1: { events: [eventRow("sec", { secret: 1, reveal_scene_id: "s3" })] },
    };
    const { client } = makeClient(data);
    const m = makeMain(client, turnOf("p1", ROWS, "s1"));
    expect(await listIds(m)).toEqual([]);
    data.p1.events = [eventRow("sec", { secret: 0 })];
    expect(await listIds(m)).toEqual([]); // the cache: the change does not reach the next call
    m.clear();
    expect(await listIds(m)).toEqual(["sec"]);
    // a new turn (a new context) starts from the database
    const next = makeMain(client, turnOf("p1", ROWS, "s1"));
    expect(await listIds(next)).toEqual(["sec"]);
  });

  it("and the other way: a public event that becomes secret stays visible until the cache is dropped (the safe direction is not the one that is held)", async () => {
    const data = { p1: { events: [eventRow("e", { secret: 0 })] } };
    const { client } = makeClient(data);
    const m = makeMain(client, turnOf("p1", ROWS, "s1"));
    expect(await listIds(m)).toEqual(["e"]);
    data.p1.events = [eventRow("e", { secret: 1, reveal_scene_id: "s3" })];
    expect(await listIds(m)).toEqual(["e"]);
    m.clear();
    expect(await listIds(m)).toEqual([]);
  });
});

describe("the Codex names", () => {
  it("are every entry of the project by id, hidden ones included, from a two-column select", async () => {
    const codex = [
      { id: "c1", name: "Alice" },
      { id: "c-hidden", name: "Hidden Person" },
      { id: "c3", name: "" },
    ];
    const { client, statements } = makeClient({
      p1: {
        events: [
          eventRow("e1", {
            primary_codex_id: "c-hidden",
            location_codex_id: "c1",
          }),
        ],
        codex,
      },
    });
    const m = makeMain(client, turnOf("p1", ROWS, "s3"));
    const names = await m.ctx.chronicle.getCodexNames("p1");
    expect([...names.entries()]).toEqual(codex.map((c) => [c.id, c.name]));
    const select = statements.find((s) => s.table === "codex_entries")!;
    expect(selectColumns(select.sql).sort()).toEqual(["id", "name"]);
    expect(select.projectId).toBe("p1");
    // and the tools return a hidden entry's name as it is
    const r = await m.executors.list_events({});
    expect(
      (r.content as { events: Array<{ primaryCharacter: unknown }> }).events[0]!
        .primaryCharacter,
    ).toBe("Hidden Person");
  });
});

describe("Main's events read fails closed on the columns that decide what the AI may see (DR-MP4-37)", () => {
  // `readEventsFailClosed` (not `readEvents`) is what Main's context loads
  // events with. The rows below are what a reader that lost a column would
  // return; `normalizeEvent` would turn each of them into a public event.
  // An absent `secret` key is not a case: Drizzle maps the undefined to `false`
  // before the narrow sees it (checked), so only a null `secret` reaches it.
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ["a null secret", { secret: null }, /usable .secret. column/u],
    [
      "a missing revealSceneId (undefined)",
      { reveal_scene_id: undefined },
      /usable .revealSceneId. column/u,
    ],
  ];

  it.each(cases)(
    "%s: list_events and get_event_detail reject (the event is not read as public)",
    async (_name, over, message) => {
      const { client } = makeClient({
        p1: { events: [eventRow("e1", over)] },
      });
      const m = makeMain(client, turnOf("p1", ROWS, "s3"));
      await expect(m.executors.list_events({})).rejects.toThrow(message);
      await expect(
        m.executors.get_event_detail({ eventId: "e1" }),
      ).rejects.toThrow(message);
    },
  );
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
