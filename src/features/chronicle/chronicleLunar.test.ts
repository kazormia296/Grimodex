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

  it("節気の日本(UTC+9)オフセット: 大雪2024 は中国Dec6→日本Dec7へ移る", () => {
    // 大雪2024 の瞬間 = 2024-12-06 23:17 (UTC+8) → 日本(UTC+9)では Dec7。
    const china = gregorian(2023); // 既定=中国農暦(UTC+8)
    expect(lunarInfoForDay(dayOf(2024, 12, 6, china), china)?.solarTerm).toBe(
      "大雪",
    );
    expect(
      lunarInfoForDay(dayOf(2024, 12, 7, china), china)?.solarTerm,
    ).toBeNull();

    const japan: ChronicleCalendar = { ...china, lunarTzMinutes: 540 };
    expect(
      lunarInfoForDay(dayOf(2024, 12, 6, japan), japan)?.solarTerm,
    ).toBeNull();
    expect(lunarInfoForDay(dayOf(2024, 12, 7, japan), japan)?.solarTerm).toBe(
      "大雪",
    );
    // 旧暦月日・六曜は中国農暦のまま（オフセットの影響を受けない）。
    const d = dayOf(2024, 12, 6, japan);
    expect(lunarInfoForDay(d, japan)?.month).toBe(
      lunarInfoForDay(d, china)?.month,
    );
    expect(lunarInfoForDay(d, japan)?.rokuyo).toBe(
      lunarInfoForDay(d, china)?.rokuyo,
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
