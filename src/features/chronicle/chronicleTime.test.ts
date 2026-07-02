import { describe, it, expect } from "vitest";
import {
  seasonOf,
  nextEventOrdinal,
  calendarDaysPerYear,
  dayNumberToDate,
  dateToDayNumber,
  weekdayOf,
  gregorianWeekdayIndex,
  eraOf,
  activeTimeZone,
  formatTimeOfDay,
  formatChronicleDate,
  formatRelativeDays,
  type ChronicleCalendar,
} from "./chronicleTime";

describe("activeTimeZone / 時刻ラベル（TZ・DST）", () => {
  const cal: ChronicleCalendar = {
    daysPerYear: 360,
    seasonBoundaries: [],
    startYear: 0,
    timezone: {
      label: "JST",
      offsetMinutes: 540,
      dst: {
        label: "JDT",
        offsetMinutes: 600,
        startDayOfYear: 90,
        endDayOfYear: 270,
      },
    },
  };
  it("DST 期間内は DST 側、外は標準時", () => {
    expect(activeTimeZone(100, cal)).toEqual({
      label: "JDT",
      offsetMinutes: 600,
    });
    expect(activeTimeZone(10, cal)).toEqual({
      label: "JST",
      offsetMinutes: 540,
    });
    expect(activeTimeZone(300, cal)).toEqual({
      label: "JST",
      offsetMinutes: 540,
    });
  });
  it("年跨ぎ DST（start>end・南半球型）", () => {
    const south: ChronicleCalendar = {
      ...cal,
      timezone: {
        ...cal.timezone!,
        dst: { ...cal.timezone!.dst!, startDayOfYear: 300, endDayOfYear: 90 },
      },
    };
    expect(activeTimeZone(10, south)?.label).toBe("JDT"); // 年初は DST
    expect(activeTimeZone(150, south)?.label).toBe("JST"); // 年央は標準
  });
  it("formatChronicleDate(time) に TZ ラベルを付す", () => {
    expect(formatChronicleDate(10, 540, "time", cal, "ja")).toContain("JST");
    expect(formatChronicleDate(100, 540, "time", cal, "ja")).toContain("JDT");
  });
  it("TZ 未設定なら時刻にラベルなし", () => {
    const plain: ChronicleCalendar = { daysPerYear: 360, seasonBoundaries: [] };
    expect(formatChronicleDate(10, 540, "time", plain, "ja")).not.toContain(
      "JST",
    );
  });
});
import { REFORM_PRESETS } from "./chronicleReform";

describe("gregorianWeekdayIndex（実暦グレゴリオ曜日, 0=日）", () => {
  it("既知の元日曜日に一致（先発グレゴリオ）", () => {
    expect(gregorianWeekdayIndex(2000)).toBe(6); // 2000-01-01 土
    expect(gregorianWeekdayIndex(2001)).toBe(1); // 2001-01-01 月
    expect(gregorianWeekdayIndex(2024)).toBe(1); // 2024-01-01 月
    expect(gregorianWeekdayIndex(1)).toBe(1); // 0001-01-01 月（proleptic）
    expect(gregorianWeekdayIndex(1970)).toBe(4); // 1970-01-01 木
  });
});

describe("改暦（reform）統合: chronicleTime 経由", () => {
  const cal: ChronicleCalendar = {
    daysPerYear: 365,
    seasonBoundaries: [],
    startYear: 1582,
    weekdayNames: ["日", "月", "火", "水", "木", "金", "土"],
    // day0 = 1582-01-01(ユリウス) は月曜 → weekdayStartIndex=1 で実暦曜日に一致。
    weekdayStartIndex: 1,
    reform: REFORM_PRESETS.gregorian1582,
  };
  it("ユリウス Oct4 の翌日がグレゴリオ Oct15（日付スキップ）", () => {
    const oct4 = dateToDayNumber(
      { year: 1582, monthIndex: 9, dayOfMonth: 4 },
      cal,
    );
    const next = dayNumberToDate(oct4 + 1, cal);
    expect([next.year, next.monthIndex, next.dayOfMonth]).toEqual([
      1582, 9, 15,
    ]);
  });
  it("曜日はスキップを跨いでも連続（Oct4=木 → Oct15=金）", () => {
    const oct4 = dateToDayNumber(
      { year: 1582, monthIndex: 9, dayOfMonth: 4 },
      cal,
    );
    // 4=木(實:1582-10-04 ユリウス=木), 5=金(1582-10-15 グレゴリオ=金)。
    expect(weekdayOf(oct4, cal)).toBe(4);
    expect(weekdayOf(oct4 + 1, cal)).toBe(5);
  });
  it("date↔day 往復（改暦後の任意日）", () => {
    const d = dateToDayNumber(
      { year: 1700, monthIndex: 2, dayOfMonth: 1 },
      cal,
    );
    const back = dayNumberToDate(d, cal);
    expect([back.year, back.monthIndex, back.dayOfMonth]).toEqual([1700, 2, 1]);
  });
});

describe("eraOf（元号・年号）", () => {
  const cal: ChronicleCalendar = {
    daysPerYear: 365,
    seasonBoundaries: [],
    startYear: 1868,
    eras: [
      { name: "明治", startYear: 1868 },
      { name: "大正", startYear: 1912 },
    ],
  };
  it("該当元号の元号年（startYear=元号1年）", () => {
    expect(eraOf(1868, cal)).toEqual({ name: "明治", year: 1 });
    expect(eraOf(1869, cal)).toEqual({ name: "明治", year: 2 });
    expect(eraOf(1912, cal)).toEqual({ name: "大正", year: 1 });
  });
  it("元号開始前・元号なしは null", () => {
    expect(eraOf(1867, cal)).toBeNull();
    expect(eraOf(1900, { daysPerYear: 365, seasonBoundaries: [] })).toBeNull();
  });
  it("formatChronicleDate は西暦年を元号年に置換", () => {
    expect(formatChronicleDate(0, null, "year", cal, "ja")).toBe("明治1年");
    expect(formatChronicleDate(365, null, "year", cal, "ja")).toBe("明治2年");
    // 元号外の年（1867=day -365）は西暦のまま。
    expect(formatChronicleDate(-365, null, "year", cal, "ja")).toBe("1867年");
  });
});

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
  it("未ソート境界でも正しく、同一配列の反復呼び出し（ソートキャッシュ）でも結果が安定", () => {
    // 逆順の境界配列。identity キャッシュ導入後も入力は破壊されない。
    const boundaries = [
      { name: "冬", startDayOfYear: 270 },
      { name: "春", startDayOfYear: 0 },
      { name: "秋", startDayOfYear: 180 },
      { name: "夏", startDayOfYear: 90 },
    ];
    const cal: ChronicleCalendar = {
      daysPerYear: 360,
      seasonBoundaries: boundaries,
    };
    for (let i = 0; i < 3; i++) {
      expect(seasonOf(0, cal)).toBe("春");
      expect(seasonOf(100, cal)).toBe("夏");
      expect(seasonOf(200, cal)).toBe("秋");
      expect(seasonOf(300, cal)).toBe("冬");
    }
    // 入力配列は非破壊（元の順序のまま）。
    expect(boundaries.map((b) => b.name)).toEqual(["冬", "春", "秋", "夏"]);
    // 別 identity の配列（内容違い）はキャッシュを共有しない。
    const cal2: ChronicleCalendar = {
      daysPerYear: 360,
      seasonBoundaries: [
        { name: "乾季", startDayOfYear: 0 },
        { name: "雨季", startDayOfYear: 180 },
      ],
    };
    expect(seasonOf(100, cal2)).toBe("乾季");
    expect(seasonOf(200, cal2)).toBe("雨季");
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
  weekdayStartIndex: 0,
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
  it("weekdayStartIndex で day0 の曜日を指定できる", () => {
    const cal = { ...GREG, weekdayStartIndex: 5 };
    expect(weekdayOf(0, cal)).toBe(5);
    expect(weekdayOf(2, cal)).toBe(0);
    expect(weekdayOf(-1, cal)).toBe(4);
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

describe("formatRelativeDays（アンカーからの相対時間）", () => {
  const CAL360: ChronicleCalendar = { daysPerYear: 360, seasonBoundaries: [] };
  const CAL_MONTHS: ChronicleCalendar = {
    daysPerYear: 360,
    seasonBoundaries: [],
    months: Array.from({ length: 12 }, (_, i) => ({
      name: `${i + 1}月`,
      days: 30,
    })),
  };

  it("暦なし / 日付欠落は null（省略）", () => {
    expect(formatRelativeDays(0, 100, false, null)).toBeNull();
    expect(formatRelativeDays(null, 100, false, CAL360)).toBeNull();
    expect(formatRelativeDays(0, null, false, CAL360)).toBeNull();
  });

  it("未来（delta<0）は嘘ラベルを出さず null", () => {
    expect(formatRelativeDays(100, 0, false, CAL360)).toBeNull();
  });

  it("同日", () => {
    expect(formatRelativeDays(50, 50, false, CAL360)).toBe("同日");
    expect(formatRelativeDays(50, 50, false, CAL360, "en")).toBe("same day");
  });

  it("年スケール（delta>=dpy、四捨五入）", () => {
    expect(formatRelativeDays(0, 360, false, CAL360)).toBe("約1年前");
    // 7100/360 = 19.72 → 20（fixture 01 と一致）
    expect(formatRelativeDays(0, 7100, false, CAL360)).toBe("約20年前");
    // 540/360 = 1.5 → 2（round-half-up）
    expect(formatRelativeDays(0, 540, false, CAL360)).toBe("約2年前");
    // approx でも年は常に「約」（差分なし）
    expect(formatRelativeDays(0, 360, true, CAL360)).toBe("約1年前");
    expect(formatRelativeDays(0, 360, false, CAL360, "en")).toBe(
      "about 1 year earlier",
    );
    expect(formatRelativeDays(0, 720, false, CAL360, "en")).toBe(
      "about 2 years earlier",
    );
  });

  it("月スケール（months 定義あり && 概算 >= 2ヶ月）", () => {
    // 212·12/360 = 7.07 → 7（fixture 05 と一致）
    expect(formatRelativeDays(0, 212, false, CAL_MONTHS)).toBe("約7ヶ月前");
    // 45·12/360 = 1.5 → 2
    expect(formatRelativeDays(0, 45, false, CAL_MONTHS)).toBe("約2ヶ月前");
    expect(formatRelativeDays(0, 45, false, CAL_MONTHS, "en")).toBe(
      "about 2 months earlier",
    );
  });

  it("日スケール（月未満 / months 未定義）", () => {
    // months なし → 月ブランチをスキップして日表記
    expect(formatRelativeDays(0, 30, false, CAL360)).toBe("30日前");
    // months あり・概算 1ヶ月 → まだ日表記
    expect(formatRelativeDays(0, 30, false, CAL_MONTHS)).toBe("30日前");
    // approx は日に「約」を付す
    expect(formatRelativeDays(0, 30, true, CAL360)).toBe("約30日前");
    expect(formatRelativeDays(0, 5, false, CAL360, "en")).toBe(
      "5 days earlier",
    );
    expect(formatRelativeDays(0, 1, false, CAL360, "en")).toBe("1 day earlier");
    expect(formatRelativeDays(0, 5, true, CAL360, "en")).toBe(
      "about 5 days earlier",
    );
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

  it("seasonOf は閏日累積後も年内通日に基づいて季節を判定する", () => {
    const seasonal: ChronicleCalendar = {
      ...GREGORIAN,
      seasonBoundaries: [
        { name: "春", startDayOfYear: 0 },
        { name: "夏", startDayOfYear: 90 },
        { name: "秋", startDayOfYear: 180 },
        { name: "冬", startDayOfYear: 270 },
      ],
    };
    const dec31_2001 = dateToDayNumber(
      { year: 2001, monthIndex: 11, dayOfMonth: 31 },
      seasonal,
    );
    expect(dayNumberToDate(dec31_2001, seasonal).dayOfYear).toBe(364);
    expect(seasonOf(dec31_2001, seasonal)).toBe("冬");
  });

  it("dateToDayNumber は存在しない月内日をその月の末日にクランプする", () => {
    const feb29_2001 = dateToDayNumber(
      { year: 2001, monthIndex: 1, dayOfMonth: 29 },
      GREGORIAN,
    );
    expect(dayNumberToDate(feb29_2001, GREGORIAN)).toMatchObject({
      year: 2001,
      monthIndex: 1,
      dayOfMonth: 28,
    });
    const apr31_2000 = dateToDayNumber(
      { year: 2000, monthIndex: 3, dayOfMonth: 31 },
      GREGORIAN,
    );
    expect(dayNumberToDate(apr31_2000, GREGORIAN)).toMatchObject({
      year: 2000,
      monthIndex: 3,
      dayOfMonth: 30,
    });
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
