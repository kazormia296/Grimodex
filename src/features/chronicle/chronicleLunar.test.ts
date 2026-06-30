import { describe, it, expect } from "vitest";
import { lunarInfoForDay } from "./chronicleLunar";
import {
  dateToDayNumber,
  GREGORIAN_MONTH_DAYS,
  GREGORIAN_LEAP,
  type ChronicleCalendar,
} from "./chronicleTime";

const gregorian = (startYear: number): ChronicleCalendar => ({
  daysPerYear: 365,
  seasonBoundaries: [],
  startYear,
  months: GREGORIAN_MONTH_DAYS.map((days, i) => ({ name: `${i + 1}`, days })),
  weekdayNames: ["日", "月", "火", "水", "木", "金", "土"],
  leap: GREGORIAN_LEAP,
});

const dayOf = (y: number, m1: number, d: number, cal: ChronicleCalendar) =>
  dateToDayNumber({ year: y, monthIndex: m1 - 1, dayOfMonth: d }, cal);

describe("lunarInfoForDay（旧暦・六曜・節気, 日本表記）", () => {
  const cal = gregorian(2023);

  it("2024-02-10 = 旧正月一日・先勝（六曜は日本表記）", () => {
    expect(lunarInfoForDay(dayOf(2024, 2, 10, cal), cal)).toEqual({
      month: 1,
      isLeapMonth: false,
      day: 1,
      rokuyo: "先勝",
      solarTerm: null,
    });
  });

  it("2024-02-04 = 立春・赤口（節気を返す）", () => {
    const info = lunarInfoForDay(dayOf(2024, 2, 4, cal), cal);
    expect(info?.solarTerm).toBe("立春");
    expect(info?.rokuyo).toBe("赤口");
  });

  it("2023-03-22 = 旧暦 閏2月1日（閏月フラグ）", () => {
    const info = lunarInfoForDay(dayOf(2023, 3, 22, cal), cal);
    expect(info?.month).toBe(2);
    expect(info?.isLeapMonth).toBe(true);
    expect(info?.day).toBe(1);
  });

  it("節気の日本表記置換（谷雨→穀雨 / 惊蛰→啓蟄）", () => {
    expect(lunarInfoForDay(dayOf(2024, 4, 19, cal), cal)?.solarTerm).toBe(
      "穀雨",
    );
    expect(lunarInfoForDay(dayOf(2024, 3, 5, cal), cal)?.solarTerm).toBe(
      "啓蟄",
    );
  });

  it("ファンタジー暦（実暦12ヶ月でない）は null", () => {
    const fantasy: ChronicleCalendar = {
      daysPerYear: 360,
      seasonBoundaries: [],
      startYear: 0,
      months: [
        { name: "霜月", days: 30 },
        { name: "雪月", days: 30 },
      ],
    };
    expect(lunarInfoForDay(100, fantasy)).toBeNull();
  });
});
