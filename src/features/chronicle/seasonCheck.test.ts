import { describe, it, expect, vi } from "vitest";
import {
  findSeasonConflicts,
  conflictingEventIds,
  type SeasonCheckInput,
} from "./seasonCheck";
import type { ChronicleCalendar } from "./chronicleTime";

// useSeasonConflicts は db/client につながる api モジュールを取り込むため、
// 純関数 collectLoadedSceneTexts だけを安全に import できるようにモックする。
vi.mock("@/features/tree/api", () => ({ loadSceneContents: vi.fn() }));
vi.mock("./api", () => ({
  getProjectCalendar: vi.fn(),
  upsertProjectCalendar: vi.fn(),
}));
import { collectLoadedSceneTexts } from "./useSeasonConflicts";

const calendar: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [
    { name: "春", startDayOfYear: 0 },
    { name: "夏", startDayOfYear: 90 },
    { name: "秋", startDayOfYear: 180 },
    { name: "冬", startDayOfYear: 270 },
  ],
};

type CheckEvent = SeasonCheckInput["events"][number];

function ev(
  id: string,
  startTime: number | null,
  precision: CheckEvent["precision"] = "exact",
  startGranularity: CheckEvent["startGranularity"] = "day",
): CheckEvent {
  return { id, startTime, precision, startGranularity };
}

function input(over: Partial<SeasonCheckInput>): SeasonCheckInput {
  return {
    events: [],
    calendar,
    links: [],
    sceneTexts: new Map(),
    ...over,
  };
}

describe("findSeasonConflicts", () => {
  it("冬の出来事のシーンに『蝉』→ 矛盾(冬 vs 夏)", () => {
    const conflicts = findSeasonConflicts(
      input({
        events: [ev("e1", 300)], // 300 → 冬
        links: [{ sceneId: "s1", eventId: "e1" }],
        sceneTexts: new Map([["s1", "真夜中に蝉が鳴いていた"]]),
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({
      eventId: "e1",
      sceneId: "s1",
      eventSeason: "冬",
      sceneSeasons: ["夏"],
    });
  });

  it("季節が一致すれば矛盾なし", () => {
    const conflicts = findSeasonConflicts(
      input({
        events: [ev("e1", 300)], // 冬
        links: [{ sceneId: "s1", eventId: "e1" }],
        sceneTexts: new Map([["s1", "雪が静かに降っていた"]]),
      }),
    );
    expect(conflicts).toHaveLength(0);
  });

  it("unknown と日時なしを除外し、approx と exact は検査する", () => {
    const eventIds = ["unknown", "undated", "approx", "exact"];
    const conflicts = findSeasonConflicts(
      input({
        events: [
          ev("unknown", 300, "unknown"),
          ev("undated", 300, "exact", "none"),
          ev("approx", 300, "approx"),
          ev("exact", 300),
        ],
        links: eventIds.map((eventId) => ({ sceneId: eventId, eventId })),
        sceneTexts: new Map(eventIds.map((sceneId) => [sceneId, "蝉"])),
      }),
    );

    expect(conflicts.map((conflict) => conflict.eventId)).toEqual([
      "approx",
      "exact",
    ]);
  });

  it("startTime 無しはスキップ（false-positive を出さない）", () => {
    const conflicts = findSeasonConflicts(
      input({
        events: [ev("e1", null)],
        links: [{ sceneId: "s1", eventId: "e1" }],
        sceneTexts: new Map([["s1", "蝉が鳴く"]]),
      }),
    );
    expect(conflicts).toHaveLength(0);
  });

  it("本文未取得(sceneTexts に無い)はスキップ", () => {
    const conflicts = findSeasonConflicts(
      input({
        events: [ev("e1", 300)],
        links: [{ sceneId: "s1", eventId: "e1" }],
        sceneTexts: new Map(),
      }),
    );
    expect(conflicts).toHaveLength(0);
  });

  it("暦未設定（境界空）は空", () => {
    const conflicts = findSeasonConflicts(
      input({
        calendar: { daysPerYear: 360, seasonBoundaries: [] },
        events: [ev("e1", 300)],
        links: [{ sceneId: "s1", eventId: "e1" }],
        sceneTexts: new Map([["s1", "蝉"]]),
      }),
    );
    expect(conflicts).toHaveLength(0);
  });

  it("conflictingEventIds は矛盾 event の集合", () => {
    const conflicts = findSeasonConflicts(
      input({
        events: [ev("e1", 300), ev("e2", 100)], // e2 は夏
        links: [
          { sceneId: "s1", eventId: "e1" },
          { sceneId: "s2", eventId: "e2" },
        ],
        sceneTexts: new Map([
          ["s1", "蝉が鳴く"], // 冬の e1 と矛盾
          ["s2", "海水浴に行った"], // 夏の e2 と一致(synonym 海水浴=夏)
        ]),
      }),
    );
    const ids = conflictingEventIds(conflicts);
    expect(ids.has("e1")).toBe(true);
    expect(ids.has("e2")).toBe(false);
  });

  it("自季節を含む回想シーン(両季節)は矛盾にしない", () => {
    const conflicts = findSeasonConflicts(
      input({
        events: [ev("e1", 300)], // 冬
        links: [{ sceneId: "s1", eventId: "e1" }],
        // 冬(自季節)が出ている上での蝉(夏)は回想/比喩 → 矛盾にしない。
        sceneTexts: new Map([
          ["s1", "雪が降る中、彼は去年の蝉の声を思い出した"],
        ]),
      }),
    );
    expect(conflicts).toHaveLength(0);
  });
});

describe("collectLoadedSceneTexts (batch degradation)", () => {
  it("欠損行があっても取得済みシーンの警告は残る", () => {
    const sceneTexts = collectLoadedSceneTexts(
      ["s1", "missing"],
      new Map([
        [
          "s1",
          JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "真夜中に蝉が鳴いていた" }],
              },
            ],
          }),
        ],
      ]),
    );
    expect(sceneTexts.size).toBe(2);
    expect(sceneTexts.has("s1")).toBe(true);
    expect(sceneTexts.get("missing")).toBe("");

    // 欠損シーンを空扱いにしても、取得済み s1 の矛盾は引き続き検出される。
    const conflicts = findSeasonConflicts(
      input({
        events: [ev("e1", 300)], // 冬
        links: [{ sceneId: "s1", eventId: "e1" }],
        sceneTexts,
      }),
    );
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].eventSeason).toBe("冬");
  });
});
