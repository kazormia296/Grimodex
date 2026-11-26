import { describe, expect, it } from "vitest";
import { chronicleCreateDay } from "./chronicleCreateDate";

const event = (startTime: number | null) => ({
  id: "e",
  ordinal: "a0",
  createdAt: "2026-01-01T00:00:00Z",
  startTime,
  startGranularity: startTime === null ? "none" : "day",
  endTime: null,
  endGranularity: "none",
});

describe("chronicleCreateDay（CED/1 の N5）", () => {
  it("作者が選んだ位置を使い、確度は確定", () => {
    expect(
      chronicleCreateDay({
        selectedDay: 12.5,
        viewCenterDay: 90,
        events: [event(500)],
        sceneDates: [],
      }),
    ).toEqual({ day: 12.5, precision: "exact" });
  });

  it("選んでいなければ画面の中央を使い、確度は確定", () => {
    expect(
      chronicleCreateDay({
        selectedDay: null,
        viewCenterDay: 90,
        events: [event(500)],
        sceneDates: [],
      }),
    ).toEqual({ day: 90, precision: "exact" });
  });

  it("どちらも無ければ最も後の日の翌日で、確度は不明", () => {
    expect(
      chronicleCreateDay({
        selectedDay: null,
        viewCenterDay: null,
        events: [event(3), event(null)],
        sceneDates: [{ startTime: 10, startGranularity: "day" }],
      }),
    ).toEqual({ day: 11, precision: "unknown" });
  });

  it("年表にも場面にも日付が無ければ暦の起点の日", () => {
    expect(
      chronicleCreateDay({
        selectedDay: null,
        viewCenterDay: null,
        events: [],
        sceneDates: [{ startTime: null, startGranularity: "none" }],
      }),
    ).toEqual({ day: 0, precision: "unknown" });
  });
});
