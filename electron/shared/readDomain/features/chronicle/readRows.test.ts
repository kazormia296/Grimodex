// MP-4b PR-7a: the normalizers of the chronicle rows (moved out of the renderer's
// `chronicle/api.ts` with their bodies unchanged) and Main's fail-closed event
// normalizer. Relative imports only.
import { describe, expect, it } from "vitest";

import {
  normalizeCalendarRow,
  normalizeEvent,
  normalizeEventFailClosed,
  normalizeEventRelationRow,
  normalizeParticipantRow,
  normalizeSceneEventRow,
} from "./readRows.js";

const SNAKE = {
  id: "e1",
  project_id: "p1",
  title: "t",
  note: "n",
  detail: "d",
  ordinal: "a3",
  primary_codex_id: "c1",
  lane_group: "g",
  location_codex_id: "c2",
  start_time: 1,
  end_time: 2,
  start_minute: 3,
  end_minute: 4,
  start_granularity: "minute",
  end_granularity: "day",
  precision: "approx",
  kind: "birth",
  secret: 1,
  reveal_scene_id: "s1",
  version: 7,
  created_at: "c",
  updated_at: "u",
};

const CAMEL = {
  id: "e1",
  projectId: "p1",
  title: "t",
  note: "n",
  detail: "d",
  ordinal: "a3",
  primaryCodexId: "c1",
  laneGroup: "g",
  locationCodexId: "c2",
  startTime: 1,
  endTime: 2,
  startMinute: 3,
  endMinute: 4,
  startGranularity: "minute",
  endGranularity: "day",
  precision: "approx",
  kind: "birth",
  secret: true,
  revealSceneId: "s1",
  version: 7,
  createdAt: "c",
  updatedAt: "u",
};

const EXPECTED = {
  id: "e1",
  projectId: "p1",
  title: "t",
  note: "n",
  detail: "d",
  ordinal: "a3",
  primaryCodexId: "c1",
  laneGroup: "g",
  locationCodexId: "c2",
  startTime: 1,
  endTime: 2,
  startMinute: 3,
  endMinute: 4,
  startGranularity: "minute",
  endGranularity: "day",
  precision: "approx",
  kind: "birth",
  secret: true,
  revealSceneId: "s1",
  version: 7,
  createdAt: "c",
  updatedAt: "u",
};

describe("normalizeEvent", () => {
  it("reads a snake_case row and a camelCase row to the same EventRow, key order included", () => {
    expect(normalizeEvent(SNAKE)).toEqual(EXPECTED);
    expect(normalizeEvent(CAMEL)).toEqual(EXPECTED);
    expect(Object.keys(normalizeEvent(SNAKE))).toEqual(Object.keys(EXPECTED));
  });

  it("fills the defaults of an empty or missing row", () => {
    for (const raw of [{}, undefined, null]) {
      expect(normalizeEvent(raw)).toEqual({
        id: "",
        projectId: "",
        title: "",
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
        createdAt: "",
        updatedAt: "",
      });
    }
  });

  it("the camelCase key wins over the snake_case one when both are present", () => {
    expect(
      normalizeEvent({ projectId: "camel", project_id: "snake" }).projectId,
    ).toBe("camel");
  });

  it.each([
    [true, true],
    [false, false],
    [1, true],
    [0, false],
    [2, true],
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["0", false],
    ["false", false],
    ["x", false],
    [null, false],
    [undefined, false],
    [{}, false],
  ])(
    "normalizeEvent turns secret %j into %j (a lost or odd value is public here)",
    (value, expected) => {
      expect(normalizeEvent({ secret: value }).secret).toBe(expected);
    },
  );

  it("converts numbers and strings with the same coercions as before", () => {
    const e = normalizeEvent({ start_time: "12", version: "3", id: 5 });
    expect(e.startTime).toBe(12);
    expect(e.version).toBe(3);
    expect(e.id).toBe("5");
  });
});

describe("normalizeEventFailClosed (Main's read path)", () => {
  it("gives the same row as normalizeEvent for a row that has both columns, from either key style", () => {
    expect(normalizeEventFailClosed(SNAKE)).toEqual(normalizeEvent(SNAKE));
    expect(normalizeEventFailClosed(CAMEL)).toEqual(normalizeEvent(CAMEL));
    expect(normalizeEventFailClosed({ ...CAMEL, secret: 0 }).secret).toBe(
      false,
    );
    expect(normalizeEventFailClosed({ ...CAMEL, secret: 1 }).secret).toBe(true);
    expect(
      normalizeEventFailClosed({ ...CAMEL, revealSceneId: null }).revealSceneId,
    ).toBeNull();
  });

  it.each([
    ["missing", undefined, false],
    ["null", null, false],
    ["text 1", "1", true],
    ["text true", "true", true],
    ["2", 2, true],
    ["-1", -1, true],
    ["an object", {}, false],
  ])(
    "normalizes `secret` when it is %s without rejecting the row",
    (_label, value, expected) => {
      expect(normalizeEventFailClosed({ ...CAMEL, secret: value }).secret).toBe(
        expected,
      );
    },
  );

  it("does not reject a row when the secret key is absent", () => {
    const { secret: _secret, ...without } = CAMEL;
    expect(normalizeEventFailClosed(without).secret).toBe(false);
  });

  it.each([
    ["absent", undefined],
    ["a number", 5],
    ["an object", {}],
  ])("throws when `revealSceneId` is %s", (_label, value) => {
    const row: Record<string, unknown> = { ...CAMEL };
    if (value === undefined) delete row.revealSceneId;
    else row.revealSceneId = value;
    expect(() => normalizeEventFailClosed(row)).toThrow(
      /usable `revealSceneId` column/u,
    );
  });

  it("reads `reveal_scene_id` of a raw row, and a raw row that lost it is an error", () => {
    expect(normalizeEventFailClosed(SNAKE).revealSceneId).toBe("s1");
    expect(() =>
      normalizeEventFailClosed({ ...SNAKE, reveal_scene_id: undefined }),
    ).toThrow(/revealSceneId/u);
  });

  it("throws for a row that is not an object (nothing is read from it)", () => {
    for (const raw of [undefined, null, {}]) {
      expect(() => normalizeEventFailClosed(raw)).toThrow(/chronicle events/u);
    }
  });
});

describe("the other rows", () => {
  it("participant: both key styles, a null role stays null", () => {
    expect(
      normalizeParticipantRow({
        event_id: "e",
        codex_entry_id: "c",
        role: "w",
      }),
    ).toEqual({ eventId: "e", codexEntryId: "c", role: "w" });
    expect(
      normalizeParticipantRow({ eventId: "e", codexEntryId: "c", role: null }),
    ).toEqual({ eventId: "e", codexEntryId: "c", role: null });
    expect(normalizeParticipantRow({})).toEqual({
      eventId: "",
      codexEntryId: "",
      role: null,
    });
  });

  it("scene-event bridge: both key styles", () => {
    expect(normalizeSceneEventRow({ scene_id: "s", event_id: "e" })).toEqual({
      sceneId: "s",
      eventId: "e",
    });
    expect(normalizeSceneEventRow({ sceneId: "s", eventId: "e" })).toEqual({
      sceneId: "s",
      eventId: "e",
    });
  });

  it("relation: the cause and the effect come from the *_event_id columns", () => {
    expect(
      normalizeEventRelationRow({ cause_event_id: "a", effect_event_id: "b" }),
    ).toEqual({ causeId: "a", effectId: "b" });
    expect(
      normalizeEventRelationRow({ causeEventId: "a", effectEventId: "b" }),
    ).toEqual({ causeId: "a", effectId: "b" });
    expect(normalizeEventRelationRow({})).toEqual({
      causeId: "",
      effectId: "",
    });
  });

  it("calendar: both key styles, and the documented defaults", () => {
    const snake = normalizeCalendarRow({
      project_id: "p",
      days_per_year: 365,
      season_boundaries: "[1]",
      start_year: 10,
      months: "[2]",
      weekday_names: "[3]",
      weekday_start_index: 2,
      leap_rule: '{"kind":"x"}',
      age_reckoning: "counting",
      eras: "[4]",
      reform: "{}",
      timezone: "{}",
      lunar_tz_minutes: 540,
      version: 4,
      created_at: "c",
      updated_at: "u",
    });
    expect(snake).toEqual({
      projectId: "p",
      daysPerYear: 365,
      seasonBoundaries: "[1]",
      startYear: 10,
      months: "[2]",
      weekdayNames: "[3]",
      weekdayStartIndex: 2,
      leapRule: '{"kind":"x"}',
      ageReckoning: "counting",
      eras: "[4]",
      reform: "{}",
      timezone: "{}",
      lunarTzMinutes: 540,
      version: 4,
      createdAt: "c",
      updatedAt: "u",
    });
    expect(
      normalizeCalendarRow({
        projectId: "p",
        daysPerYear: 365,
        lunarTzMinutes: 540,
      }),
    ).toMatchObject({ daysPerYear: 365, lunarTzMinutes: 540 });
    expect(normalizeCalendarRow({})).toEqual({
      projectId: "",
      daysPerYear: 360,
      seasonBoundaries: "[]",
      startYear: 0,
      months: "[]",
      weekdayNames: "[]",
      weekdayStartIndex: 0,
      leapRule: '{"kind":"none"}',
      ageReckoning: "full",
      eras: "[]",
      reform: "null",
      timezone: "null",
      lunarTzMinutes: 480,
      version: 0,
      createdAt: "",
      updatedAt: "",
    });
  });
});
