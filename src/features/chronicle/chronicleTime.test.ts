import { describe, it, expect } from "vitest";
import {
  seasonOf,
  nextEventOrdinal,
  calendarDaysPerYear,
  dayNumberToDate,
  dateToDayNumber,
  weekdayOf,
  formatTimeOfDay,
  formatChronicleDate,
  type ChronicleCalendar,
} from "./chronicleTime";

const CAL: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [
    { name: "春", startDayOfYear: 0 },
    { name: "夏", startDayOfYear: 90 },
    { name: "秋", startDayOfYear: 180 },
    { name: "冬", startDayOfYear: 270 },
  ],
};

describe("seasonOf", () => {
  it("各境界の代表日を正しい季節へ写像", () => {
    expect(seasonOf(0, CAL)).toBe("春");
    expect(seasonOf(100, CAL)).toBe("夏");
    expect(seasonOf(200, CAL)).toBe("秋");
    expect(seasonOf(300, CAL)).toBe("冬");
  });
  it("年をまたいでも mod で循環（720=2年後の0日目→春）", () => {
    expect(seasonOf(720, CAL)).toBe("春");
    expect(seasonOf(720 + 300, CAL)).toBe("冬");
  });
  it("負の時刻も循環で処理（-1→最終日→冬）", () => {
    expect(seasonOf(-1, CAL)).toBe("冬");
  });
  it("最初の境界より前の日（境界が0始まりでない場合）は最後の季節へ巻き戻る", () => {
    const cal: ChronicleCalendar = {
      daysPerYear: 100,
      seasonBoundaries: [
        { name: "A", startDayOfYear: 10 },
        { name: "B", startDayOfYear: 60 },
      ],
    };
    expect(seasonOf(5, cal)).toBe("B");
    expect(seasonOf(10, cal)).toBe("A");
    expect(seasonOf(59, cal)).toBe("A");
    expect(seasonOf(60, cal)).toBe("B");
  });
  it("境界が空 or daysPerYear<=0 なら null", () => {
    expect(seasonOf(10, { daysPerYear: 360, seasonBoundaries: [] })).toBeNull();
    expect(
      seasonOf(10, { daysPerYear: 0, seasonBoundaries: CAL.seasonBoundaries }),
    ).toBeNull();
  });
});

describe("nextEventOrdinal", () => {
  it("空配列なら初期キーを返す", () => {
    expect(typeof nextEventOrdinal([])).toBe("string");
    expect(nextEventOrdinal([]).length).toBeGreaterThan(0);
  });
  it("既存の最大キーより後（cmpKeys で大）のキーを返す", () => {
    const a = nextEventOrdinal([]);
    const b = nextEventOrdinal([a]);
    expect(b > a).toBe(true);
    const c = nextEventOrdinal([a, b]);
    expect(c > b).toBe(true);
  });
});

// 月長合計=365 のグレゴリオ風暦（開始年1247・週7日）。
const GREG: ChronicleCalendar = {
  startYear: 1247,
  daysPerYear: 999, // months 有時は無視される（導出が優先）
  months: [
    { name: "一月", days: 31 },
    { name: "二月", days: 28 },
    { name: "三月", days: 31 },
    { name: "四月", days: 30 },
    { name: "五月", days: 31 },
    { name: "六月", days: 30 },
    { name: "七月", days: 31 },
    { name: "八月", days: 31 },
    { name: "九月", days: 30 },
    { name: "十月", days: 31 },
    { name: "十一月", days: 30 },
    { name: "十二月", days: 31 },
  ],
  weekdayNames: ["月", "火", "水", "木", "金", "土", "日"],
  seasonBoundaries: [
    { name: "春", startDayOfYear: 0 },
    { name: "夏", startDayOfYear: 90 },
    { name: "秋", startDayOfYear: 180 },
    { name: "冬", startDayOfYear: 270 },
  ],
};

describe("calendarDaysPerYear", () => {
  it("months があれば月長合計を導出（stored daysPerYear は無視）", () => {
    expect(calendarDaysPerYear(GREG)).toBe(365);
  });
  it("months が空なら stored daysPerYear へフォールバック", () => {
    expect(
      calendarDaysPerYear({ daysPerYear: 360, seasonBoundaries: [] }),
    ).toBe(360);
  });
});

describe("dayNumberToDate", () => {
  it("day 0 = 開始年の最初の月の1日（週0=月）", () => {
    expect(dayNumberToDate(0, GREG)).toEqual({
      year: 1247,
      monthIndex: 0,
      dayOfMonth: 1,
      dayOfYear: 0,
      weekdayIndex: 0,
    });
  });
  it("月境界をまたぐ（day31=二月1日, day59=三月1日）", () => {
    expect(dayNumberToDate(31, GREG)).toMatchObject({
      monthIndex: 1,
      dayOfMonth: 1,
      dayOfYear: 31,
    });
    expect(dayNumberToDate(59, GREG)).toMatchObject({
      monthIndex: 2,
      dayOfMonth: 1,
      dayOfYear: 59,
    });
  });
  it("年末・翌年頭（day364=1247年十二月31日, day365=1248年一月1日）", () => {
    expect(dayNumberToDate(364, GREG)).toMatchObject({
      year: 1247,
      monthIndex: 11,
      dayOfMonth: 31,
    });
    expect(dayNumberToDate(365, GREG)).toMatchObject({
      year: 1248,
      monthIndex: 0,
      dayOfMonth: 1,
      dayOfYear: 0,
    });
  });
  it("負の day も floor 除算で前年へ（-1=1246年十二月31日, 週=日）", () => {
    expect(dayNumberToDate(-1, GREG)).toEqual({
      year: 1246,
      monthIndex: 11,
      dayOfMonth: 31,
      dayOfYear: 364,
      weekdayIndex: 6,
    });
  });
  it("months 未定義なら monthIndex/dayOfMonth は null（dayOfYear のみ）", () => {
    const d = dayNumberToDate(100, { daysPerYear: 360, seasonBoundaries: [] });
    expect(d).toMatchObject({
      year: 0,
      monthIndex: null,
      dayOfMonth: null,
      dayOfYear: 100,
      weekdayIndex: null,
    });
  });
});

describe("weekdayOf", () => {
  it("週長で循環（0→0, 7→0, 8→1, -1→6）", () => {
    expect(weekdayOf(0, GREG)).toBe(0);
    expect(weekdayOf(7, GREG)).toBe(0);
    expect(weekdayOf(8, GREG)).toBe(1);
    expect(weekdayOf(-1, GREG)).toBe(6);
  });
  it("weekdayNames が空なら null", () => {
    expect(weekdayOf(3, { daysPerYear: 360, seasonBoundaries: [] })).toBeNull();
  });
});

describe("dateToDayNumber / round-trip", () => {
  it("dayNumberToDate の逆変換が一致（全粒度: 年月日）", () => {
    for (const n of [0, 31, 59, 200, 364, 365, 800, -1, -400, 1000]) {
      const d = dayNumberToDate(n, GREG);
      expect(
        dateToDayNumber(
          { year: d.year, monthIndex: d.monthIndex, dayOfMonth: d.dayOfMonth },
          GREG,
        ),
      ).toBe(n);
    }
  });
  it("月指定なし（年だけ）は年頭の day を返す", () => {
    expect(dateToDayNumber({ year: 1248 }, GREG)).toBe(365);
    expect(dateToDayNumber({ year: 1247 }, GREG)).toBe(0);
  });
});

describe("formatTimeOfDay", () => {
  it("分→HH:MM（24h・ゼロ詰め）", () => {
    expect(formatTimeOfDay(0)).toBe("00:00");
    expect(formatTimeOfDay(870)).toBe("14:30");
    expect(formatTimeOfDay(5)).toBe("00:05");
  });
  it("null は null", () => {
    expect(formatTimeOfDay(null)).toBeNull();
  });
});

describe("formatChronicleDate", () => {
  it("粒度ごとの整形（ja）", () => {
    expect(formatChronicleDate(0, null, "none", GREG, "ja")).toBe("");
    expect(formatChronicleDate(0, null, "year", GREG, "ja")).toBe("1247年");
    expect(formatChronicleDate(0, null, "season", GREG, "ja")).toBe(
      "1247年・春",
    );
    expect(formatChronicleDate(0, null, "month", GREG, "ja")).toBe(
      "1247年一月",
    );
    expect(formatChronicleDate(0, null, "day", GREG, "ja")).toBe(
      "1247年一月1日",
    );
    expect(formatChronicleDate(0, 870, "time", GREG, "ja")).toBe(
      "1247年一月1日 14:30",
    );
  });
  it("英語ロケール", () => {
    expect(formatChronicleDate(0, null, "year", GREG, "en")).toBe("Year 1247");
  });
  it("dayNumber が null なら空", () => {
    expect(formatChronicleDate(null, null, "day", GREG, "ja")).toBe("");
  });
});

import {
  isLeapYear,
  daysInYear,
  monthLength,
  computeAge,
  GREGORIAN_MONTH_DAYS,
  GREGORIAN_LEAP,
} from "./chronicleTime";

// 現実準拠グレゴリオ暦（startYear=2000, 閏2月）。
const GREGORIAN: ChronicleCalendar = {
  daysPerYear: 365,
  seasonBoundaries: [],
  startYear: 2000,
  months: GREGORIAN_MONTH_DAYS.map((days, i) => ({ name: `${i + 1}`, days })),
  weekdayNames: ["日", "月", "火", "水", "木", "金", "土"],
  leap: GREGORIAN_LEAP,
};

describe("グレゴリオ閏年エンジン", () => {
  it("isLeapYear が 4/100/400 ルール", () => {
    expect(isLeapYear(2000, GREGORIAN)).toBe(true); // /400
    expect(isLeapYear(2004, GREGORIAN)).toBe(true); // /4
    expect(isLeapYear(2001, GREGORIAN)).toBe(false);
    expect(isLeapYear(1900, GREGORIAN)).toBe(false); // /100 not /400
    expect(isLeapYear(2100, GREGORIAN)).toBe(false);
  });

  it("daysInYear が閏年で 366", () => {
    expect(daysInYear(2000, GREGORIAN)).toBe(366);
    expect(daysInYear(2001, GREGORIAN)).toBe(365);
    expect(daysInYear(1900, GREGORIAN)).toBe(365);
  });

  it("monthLength: 2月は閏年29・平年28、他は固定", () => {
    expect(monthLength(2000, 1, GREGORIAN)).toBe(29);
    expect(monthLength(2001, 1, GREGORIAN)).toBe(28);
    expect(monthLength(2000, 0, GREGORIAN)).toBe(31);
    expect(monthLength(2000, 11, GREGORIAN)).toBe(31);
  });

  it("day 0 = startYear 1月1日", () => {
    const d = dayNumberToDate(0, GREGORIAN);
    expect(d.year).toBe(2000);
    expect(d.monthIndex).toBe(0);
    expect(d.dayOfMonth).toBe(1);
  });

  it("閏年（2000）は 366 日で翌年初へ", () => {
    // 2000-12-31 は day 365（0..365 の 366 日目）。
    const dec31 = dayNumberToDate(365, GREGORIAN);
    expect(dec31.year).toBe(2000);
    expect(dec31.monthIndex).toBe(11);
    expect(dec31.dayOfMonth).toBe(31);
    // 翌日 day 366 = 2001-01-01。
    const jan1 = dayNumberToDate(366, GREGORIAN);
    expect(jan1.year).toBe(2001);
    expect(jan1.monthIndex).toBe(0);
    expect(jan1.dayOfMonth).toBe(1);
  });

  it("2000-02-29 が存在し day 番号が round-trip", () => {
    const feb29 = dateToDayNumber(
      { year: 2000, monthIndex: 1, dayOfMonth: 29 },
      GREGORIAN,
    );
    const back = dayNumberToDate(feb29, GREGORIAN);
    expect(back.year).toBe(2000);
    expect(back.monthIndex).toBe(1);
    expect(back.dayOfMonth).toBe(29);
  });

  it("平年 2001 に 2月29日は無い（3月1日へ繰上げず 3/1 相当へ）", () => {
    // 2001-03-01 の day から逆算で 3月1日。
    const mar1 = dateToDayNumber(
      { year: 2001, monthIndex: 2, dayOfMonth: 1 },
      GREGORIAN,
    );
    const d = dayNumberToDate(mar1, GREGORIAN);
    expect(d.monthIndex).toBe(2);
    expect(d.dayOfMonth).toBe(1);
  });

  it("100年スパンの round-trip（閏日累積が正しい）", () => {
    for (const y of [2000, 2050, 2099, 2100, 2400]) {
      const dn = dateToDayNumber(
        { year: y, monthIndex: 6, dayOfMonth: 15 },
        GREGORIAN,
      );
      const d = dayNumberToDate(dn, GREGORIAN);
      expect([d.year, d.monthIndex, d.dayOfMonth]).toEqual([y, 6, 15]);
    }
  });

  it("負の day（startYear より前）も round-trip", () => {
    const dn = dateToDayNumber(
      { year: 1996, monthIndex: 1, dayOfMonth: 29 },
      GREGORIAN,
    );
    expect(dn).toBeLessThan(0);
    const d = dayNumberToDate(dn, GREGORIAN);
    expect([d.year, d.monthIndex, d.dayOfMonth]).toEqual([1996, 1, 29]);
  });
});

describe("年齢（満年齢/数え年）", () => {
  const birth = dateToDayNumber(
    { year: 2000, monthIndex: 5, dayOfMonth: 15 },
    GREGORIAN,
  );
  it("満年齢: 誕生日前は据え置き、誕生日以降で+1", () => {
    const beforeBday = dateToDayNumber(
      { year: 2020, monthIndex: 5, dayOfMonth: 14 },
      GREGORIAN,
    );
    const onBday = dateToDayNumber(
      { year: 2020, monthIndex: 5, dayOfMonth: 15 },
      GREGORIAN,
    );
    expect(computeAge(birth, beforeBday, GREGORIAN, "full")).toBe(19);
    expect(computeAge(birth, onBday, GREGORIAN, "full")).toBe(20);
  });
  it("数え年: 暦年差+1", () => {
    const ev = dateToDayNumber(
      { year: 2020, monthIndex: 0, dayOfMonth: 1 },
      GREGORIAN,
    );
    expect(computeAge(birth, ev, GREGORIAN, "counting")).toBe(21);
  });
  it("既定 reckoning は cal.ageReckoning を尊重", () => {
    const cal = { ...GREGORIAN, ageReckoning: "counting" as const };
    const ev = dateToDayNumber(
      { year: 2010, monthIndex: 0, dayOfMonth: 1 },
      GREGORIAN,
    );
    expect(computeAge(birth, ev, cal)).toBe(11);
  });
});

describe("閏なし暦は従来挙動を維持", () => {
  it("CAL(360日) の day↔date が線形のまま", () => {
    expect(dateToDayNumber({ year: 2, monthIndex: null }, CAL)).toBe(720);
    expect(dayNumberToDate(720, CAL).year).toBe(2);
    expect(dayNumberToDate(365, CAL).year).toBe(1);
  });
});
