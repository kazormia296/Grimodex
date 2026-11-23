import { describe, expect, it } from "vitest";

import type { CoreReadDbClient } from "../../mastraRead/ports.js";
import { checkReadSql } from "../../mastraRead/sql.js";
import { MAIN_READ_TABLE_SET } from "../../mastraRead/tables.js";
import {
  readCodexNames,
  readEventParticipantsForProject,
  readEventRelations,
  readEvents,
  readEventsFailClosed,
  readProjectCalendar,
  readSceneEventsForProject,
} from "./chronicleReaders.js";
import { createCoreReadDb } from "./readDb.js";

interface Captured {
  readonly sql: string;
  readonly params: unknown[];
  readonly method: string;
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

/** A client that answers a select with the object it is given, laid out by the select's own columns. */
function clientAnswering(rows: Array<Record<string, unknown>>): {
  client: CoreReadDbClient;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  const client: CoreReadDbClient = async (sql, params, method) => {
    captured.push({ sql, params, method });
    const columns = selectColumns(sql);
    return { rows: rows.map((row) => columns.map((c) => row[c])) };
  };
  return { client, captured };
}

const EVENT_ROW = {
  id: "ev-1",
  project_id: "p1",
  title: "t",
  note: null,
  detail: null,
  ordinal: "a0",
  primary_codex_id: null,
  lane_group: null,
  location_codex_id: null,
  start_time: 5,
  end_time: null,
  start_minute: null,
  end_minute: null,
  start_granularity: "day",
  end_granularity: "none",
  precision: "exact",
  kind: "generic",
  secret: 1,
  reveal_scene_id: null,
  created_at: "c",
  updated_at: "u",
  version: 2,
};

describe("readEvents / readEventsFailClosed", () => {
  it("select every column of the project's events, ordered by ordinal then id, within the allowlist", async () => {
    const { client, captured } = clientAnswering([EVENT_ROW]);
    const rows = await readEventsFailClosed(createCoreReadDb(client), "p1");
    expect(captured).toHaveLength(1);
    expect(captured[0]!.params).toEqual(["p1"]);
    expect(captured[0]!.method).toBe("all");
    expect(selectColumns(captured[0]!.sql).sort()).toEqual(
      Object.keys(EVENT_ROW).sort(),
    );
    expect(captured[0]!.sql.toLowerCase()).toContain(
      'order by "events"."ordinal" asc, "events"."id" asc',
    );
    expect(checkReadSql(captured[0]!.sql, MAIN_READ_TABLE_SET)).toMatchObject({
      ok: true,
      tables: ["events"],
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: "ev-1",
      secret: true,
      revealSceneId: null,
      version: 2,
    });
  });

  it.each([
    ["1", 1, true],
    ["0", 0, false],
  ])(
    "maps the stored %s of `secret` through Drizzle's boolean column",
    async (_l, stored, expected) => {
      const { client } = clientAnswering([{ ...EVENT_ROW, secret: stored }]);
      const [row] = await readEventsFailClosed(createCoreReadDb(client), "p1");
      expect(row!.secret).toBe(expected);
    },
  );

  it("normalizes null and other stored `secret` values through the Main read path", async () => {
    // Drizzle's boolean column leaves a null as null and maps any other stored
    // value with `Number(v) === 1`; normalizeEvent then converts null to false.
    const seen: unknown[] = [];
    for (const stored of [2, "x", 0, 1, "1"]) {
      const { client } = clientAnswering([{ ...EVENT_ROW, secret: stored }]);
      const [row] = await readEventsFailClosed(createCoreReadDb(client), "p1");
      seen.push(row!.secret);
    }
    expect(seen).toEqual([false, false, false, true, true]);
    const nulled = clientAnswering([{ ...EVENT_ROW, secret: null }]);
    const [main] = await readEventsFailClosed(
      createCoreReadDb(nulled.client),
      "p1",
    );
    expect(main!.secret).toBe(false);
    const renderer = await readEvents(createCoreReadDb(nulled.client), "p1");
    expect(renderer[0]!.secret).toBe(false);
  });
});

/** Every statement the readers send passes the pre-send check of Main, and names these tables. */
function expectAllowed(sql: string, tables: string[]): void {
  const checked = checkReadSql(sql, MAIN_READ_TABLE_SET);
  expect(checked.ok).toBe(true);
  if (checked.ok)
    expect([...checked.tables].sort()).toEqual([...tables].sort());
}

/** The project condition (XPROJ) is in the SQL and its value is the first parameter. */
function expectProjectCondition(call: Captured, projectId: string): void {
  expect(call.params[0]).toBe(projectId);
  expect(call.sql.toLowerCase()).toContain('"events"."project_id" = ?');
}

describe("readEvents (the renderer's read)", () => {
  it("sends the same statement as Main's read and normalizes every row, secret included", async () => {
    const a = clientAnswering([
      EVENT_ROW,
      { ...EVENT_ROW, id: "ev-2", secret: 0 },
    ]);
    const b = clientAnswering([EVENT_ROW]);
    const rows = await readEvents(createCoreReadDb(a.client), "p1");
    await readEventsFailClosed(createCoreReadDb(b.client), "p1");
    expect(a.captured[0]!.sql).toBe(b.captured[0]!.sql);
    expect(rows.map((r) => [r.id, r.secret])).toEqual([
      ["ev-1", true],
      ["ev-2", false],
    ]);
    expectProjectCondition(a.captured[0]!, "p1");
  });

  it("does not check the project id: an empty one reads project_id = '' (the renderer's reader never threw)", async () => {
    const { client, captured } = clientAnswering([]);
    expect(await readEvents(createCoreReadDb(client), "")).toEqual([]);
    expect(captured[0]!.params).toEqual([""]);
  });

  it("returns the rows in the order the database answered (the order is in the SQL, not applied again)", async () => {
    const { client } = clientAnswering([
      { ...EVENT_ROW, id: "z", ordinal: "a9" },
      { ...EVENT_ROW, id: "a", ordinal: "a0" },
    ]);
    const rows = await readEvents(createCoreReadDb(client), "p1");
    expect(rows.map((r) => r.id)).toEqual(["z", "a"]);
  });
});

describe("readEventParticipantsForProject", () => {
  const ROW = { event_id: "ev-1", codex_entry_id: "c1", role: "witness" };

  it("joins events and scopes by events.project_id (event_participants has no project column), without a filter for undefined ids", async () => {
    const { client, captured } = clientAnswering([ROW]);
    const rows = await readEventParticipantsForProject(
      createCoreReadDb(client),
      "p1",
    );
    expect(rows).toEqual([
      { eventId: "ev-1", codexEntryId: "c1", role: "witness" },
    ]);
    expect(captured).toHaveLength(1);
    expect(selectColumns(captured[0]!.sql).sort()).toEqual([
      "codex_entry_id",
      "event_id",
      "role",
    ]);
    expect(captured[0]!.sql.toLowerCase()).toContain('inner join "events"');
    expect(captured[0]!.params).toEqual(["p1"]);
    expectProjectCondition(captured[0]!, "p1");
    expect(captured[0]!.sql.toLowerCase()).not.toContain(" in (");
    expectAllowed(captured[0]!.sql, ["event_participants", "events"]);
  });

  it("filters by the given event ids after the project parameter, and an empty list sends nothing", async () => {
    const { client, captured } = clientAnswering([ROW]);
    await readEventParticipantsForProject(createCoreReadDb(client), "p1", [
      "ev-1",
      "ev-2",
    ]);
    expect(captured[0]!.params).toEqual(["p1", "ev-1", "ev-2"]);
    expect(captured[0]!.sql.toLowerCase()).toContain(
      '"event_participants"."event_id" in (?, ?)',
    );
    expectProjectCondition(captured[0]!, "p1");
    expect(
      await readEventParticipantsForProject(createCoreReadDb(client), "p1", []),
    ).toEqual([]);
    expect(captured).toHaveLength(1);
  });

  it("keeps the project condition when ids are given (an id of another project's event reads nothing of it)", async () => {
    const { client, captured } = clientAnswering([]);
    await readEventParticipantsForProject(createCoreReadDb(client), "p-other", [
      "ev-1",
    ]);
    expectProjectCondition(captured[0]!, "p-other");
  });
});

describe("readSceneEventsForProject", () => {
  const ROW = { scene_id: "s1", event_id: "ev-1" };

  it("joins events and scopes by events.project_id, selecting the two bridge columns", async () => {
    const { client, captured } = clientAnswering([ROW]);
    const rows = await readSceneEventsForProject(
      createCoreReadDb(client),
      "p1",
    );
    expect(rows).toEqual([{ sceneId: "s1", eventId: "ev-1" }]);
    expect(selectColumns(captured[0]!.sql).sort()).toEqual([
      "event_id",
      "scene_id",
    ]);
    expect(captured[0]!.sql.toLowerCase()).toContain('inner join "events"');
    expectProjectCondition(captured[0]!, "p1");
    expectAllowed(captured[0]!.sql, ["scene_events", "events"]);
  });

  it("filters by event ids and by scene ids, in that parameter order; an empty list of either sends nothing", async () => {
    const { client, captured } = clientAnswering([ROW]);
    const db = createCoreReadDb(client);
    await readSceneEventsForProject(db, "p1", {
      eventIds: ["e1"],
      sceneIds: ["s1", "s2"],
    });
    expect(captured[0]!.params).toEqual(["p1", "e1", "s1", "s2"]);
    expectProjectCondition(captured[0]!, "p1");
    expect(await readSceneEventsForProject(db, "p1", { eventIds: [] })).toEqual(
      [],
    );
    expect(await readSceneEventsForProject(db, "p1", { sceneIds: [] })).toEqual(
      [],
    );
    expect(captured).toHaveLength(1);
  });
});

describe("readEventRelations", () => {
  it("reads the project's relations as cause and effect, with the project condition on the relation row", async () => {
    const { client, captured } = clientAnswering([
      { id: "r1", project_id: "p1", cause_event_id: "a", effect_event_id: "b" },
    ]);
    const rows = await readEventRelations(createCoreReadDb(client), "p1");
    expect(rows).toEqual([{ causeId: "a", effectId: "b" }]);
    expect(captured[0]!.params).toEqual(["p1"]);
    expect(captured[0]!.sql.toLowerCase()).toContain(
      '"event_relations"."project_id" = ?',
    );
    expectAllowed(captured[0]!.sql, ["event_relations"]);
  });
});

describe("readProjectCalendar", () => {
  it("is null when the project has no calendar row", async () => {
    const { client, captured } = clientAnswering([]);
    expect(
      await readProjectCalendar(createCoreReadDb(client), "p1"),
    ).toBeNull();
    expect(captured[0]!.params).toEqual(["p1"]);
    expect(captured[0]!.sql.toLowerCase()).toContain(
      '"project_calendar"."project_id" = ?',
    );
    expectAllowed(captured[0]!.sql, ["project_calendar"]);
  });

  it("is the normalized row otherwise (the first one)", async () => {
    const { client } = clientAnswering([
      {
        project_id: "p1",
        days_per_year: 365,
        season_boundaries: "[]",
        start_year: 3,
        months: "[]",
        weekday_names: "[]",
        weekday_start_index: 1,
        leap_rule: '{"kind":"none"}',
        age_reckoning: "counting",
        eras: "[]",
        reform: "null",
        timezone: "null",
        lunar_tz_minutes: 540,
        version: 2,
        created_at: "c",
        updated_at: "u",
      },
    ]);
    const row = await readProjectCalendar(createCoreReadDb(client), "p1");
    expect(row).toMatchObject({
      projectId: "p1",
      daysPerYear: 365,
      startYear: 3,
      weekdayStartIndex: 1,
      ageReckoning: "counting",
      lunarTzMinutes: 540,
      version: 2,
    });
  });
});

describe("readCodexNames", () => {
  it("is the id to name map of every entry of the project, from two columns and one project condition", async () => {
    const { client, captured } = clientAnswering([
      { id: "c1", name: "Alice" },
      { id: "c2", name: "" },
    ]);
    const names = await readCodexNames(createCoreReadDb(client), "p1");
    expect([...names]).toEqual([
      ["c1", "Alice"],
      ["c2", ""],
    ]);
    expect(selectColumns(captured[0]!.sql).sort()).toEqual(["id", "name"]);
    expect(captured[0]!.params).toEqual(["p1"]);
    expect(captured[0]!.sql.toLowerCase()).toContain(
      '"codex_entries"."project_id" = ?',
    );
    // no `hidden` / `secret` condition: the name of a hidden entry is in the map
    expect(captured[0]!.sql.toLowerCase()).not.toMatch(
      /hidden|secret|archived/u,
    );
    expectAllowed(captured[0]!.sql, ["codex_entries"]);
  });
});
