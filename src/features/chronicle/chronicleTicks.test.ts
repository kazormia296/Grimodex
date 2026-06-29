import { describe, it, expect } from "vitest";
import { adaptiveTicks } from "./chronicleTicks";
import type { ChronicleCalendar } from "./chronicleTime";

const MIN = 82;

/** 月概念なしの素朴な 360 日暦。 */
const plainCal: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [],
  startYear: 0,
};

/** 12 ヶ月 x 30 日 ＋ 6 曜日の暦。 */
const monthsCal: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [],
  startYear: 0,
  months: Array.from({ length: 12 }, (_, i) => ({
    name: `M${i + 1}`,
    days: 30,
  })),
  weekdayNames: ["a", "b", "c", "d", "e", "f"],
};

/** 隣接 minor の間隔（最小値）を返す。 */
function minSpacing(xs: number[]): number {
  let m = Infinity;
  for (let i = 1; i < xs.length; i++) m = Math.min(m, xs[i] - xs[i - 1]);
  return m;
}

describe("adaptiveTicks — calendar mode", () => {
  it("(1) coarse pxPerDay yields year/month level with spacing >= MIN", () => {
    const r = adaptiveTicks({
      pxPerDay: 0.5,
      viewStartDay: 0,
      trackW: 1200,
      calendar: plainCal,
      hasCalendarAxis: true,
    });
    expect(["year", "month"]).toContain(r.level);
    expect(r.minor.length).toBeGreaterThanOrEqual(2);
    // 隣接間隔 = stepDays * pxPerDay は MIN 以上に保たれる。
    expect(minSpacing(r.minor.map((t) => t.x))).toBeGreaterThanOrEqual(MIN - 1);
  });

  it("(1b) months calendar coarse → month level, year major labels", () => {
    const r = adaptiveTicks({
      pxPerDay: 2,
      viewStartDay: 0,
      trackW: 1200,
      calendar: monthsCal,
      hasCalendarAxis: true,
    });
    expect(["year", "month"]).toContain(r.level);
    expect(minSpacing(r.minor.map((t) => t.x))).toBeGreaterThanOrEqual(MIN - 1);
    // month level の major は年ラベル（ja => 「N年」）。
    if (r.level === "month") {
      expect(r.major.length).toBeGreaterThanOrEqual(1);
      for (const t of r.major) expect(t.label).toMatch(/年/);
    }
  });

  it("(2) fine pxPerDay (4000) yields hour/minute with clock labels", () => {
    const r = adaptiveTicks({
      pxPerDay: 4000,
      viewStartDay: 0,
      trackW: 1200,
      calendar: monthsCal,
      hasCalendarAxis: true,
    });
    expect(["hour", "minute"]).toContain(r.level);
    expect(r.minor.length).toBeGreaterThanOrEqual(2);
    for (const t of r.minor) expect(t.label).toMatch(/^\d+:\d{2}$/);
  });

  it("(3) all minor.x stay within [-2, trackW+2]", () => {
    const trackW = 900;
    for (const pxPerDay of [0.3, 2, 50, 600, 4000]) {
      const r = adaptiveTicks({
        pxPerDay,
        viewStartDay: 12.37,
        trackW,
        calendar: monthsCal,
        hasCalendarAxis: true,
      });
      for (const t of r.minor) {
        expect(t.x).toBeGreaterThanOrEqual(-2);
        expect(t.x).toBeLessThanOrEqual(trackW + 2);
      }
    }
  });

  it("(5) unitLabel is non-empty in calendar mode", () => {
    for (const pxPerDay of [0.5, 2, 50, 600, 4000]) {
      const r = adaptiveTicks({
        pxPerDay,
        viewStartDay: 0,
        trackW: 1000,
        calendar: monthsCal,
        hasCalendarAxis: true,
      });
      expect(r.unitLabel.length).toBeGreaterThan(0);
    }
  });

  it("(6) lang:'en' changes labels (year tick + unitLabel)", () => {
    const base = {
      pxPerDay: 0.5,
      viewStartDay: 0,
      trackW: 1200,
      calendar: plainCal,
      hasCalendarAxis: true,
    };
    const jaR = adaptiveTicks({ ...base, lang: "ja" });
    const enR = adaptiveTicks({ ...base, lang: "en" });
    expect(jaR.level).toBe("year");
    expect(enR.level).toBe("year");
    // ja は「N年」、en は「YN」。
    expect(jaR.minor[0].label).toMatch(/年$/);
    expect(enR.minor[0].label).toMatch(/^Y\d/);
    expect(jaR.unitLabel).not.toBe(enR.unitLabel);
    expect(enR.unitLabel).toMatch(/^every /);
  });
});

describe("adaptiveTicks — sequence mode", () => {
  it("(4) returns #1/#2 labels, empty major, unitLabel 並び順", () => {
    const r = adaptiveTicks({
      pxPerDay: 100,
      viewStartDay: 0,
      trackW: 600,
      calendar: plainCal,
      hasCalendarAxis: false,
    });
    expect(r.level).toBe("order");
    expect(r.major).toEqual([]);
    expect(r.unitLabel).toBe("並び順");
    expect(r.minor[0].label).toBe("#1");
    expect(r.minor[1].label).toBe("#2");
    for (const t of r.minor) {
      expect(t.label).toMatch(/^#\d+$/);
      expect(t.x).toBeGreaterThanOrEqual(-2);
      expect(t.x).toBeLessThanOrEqual(600 + 2);
    }
  });

  it("(4b) tight pxPerDay strides to keep spacing >= MIN", () => {
    const r = adaptiveTicks({
      pxPerDay: 10,
      viewStartDay: 0,
      trackW: 600,
      calendar: plainCal,
      hasCalendarAxis: false,
    });
    expect(r.level).toBe("order");
    // stride = ceil(82/10) = 9 → 隣接間隔 = 9*10 = 90 px。
    expect(minSpacing(r.minor.map((t) => t.x))).toBeGreaterThanOrEqual(MIN - 1);
  });

  it("(6b) sequence mode en unitLabel = order", () => {
    const r = adaptiveTicks({
      pxPerDay: 100,
      viewStartDay: 0,
      trackW: 600,
      calendar: plainCal,
      hasCalendarAxis: false,
      lang: "en",
    });
    expect(r.unitLabel).toBe("order");
  });
});

import { dateToDayNumber, GREGORIAN_MONTH_DAYS, GREGORIAN_LEAP } from "./chronicleTime";

/** 現実準拠グレゴリオ暦（startYear=2000, 閏2月, 非均等月長）。 */
const gregCal: ChronicleCalendar = {
  daysPerYear: 365,
  seasonBoundaries: [],
  startYear: 2000,
  months: GREGORIAN_MONTH_DAYS.map((days, i) => ({ name: `${i + 1}月`, days })),
  weekdayNames: ["日", "月", "火", "水", "木", "金", "土"],
  leap: GREGORIAN_LEAP,
};

describe("adaptiveTicks — 暦境界の正確さ（バグ修正）", () => {
  it("週ズーム時に月境界が実際の累積位置に並ぶ（均等 dpy/12 ではない）", () => {
    // pxPerDay を週目盛り（level=day, 7日）に入る程度に。
    const r = adaptiveTicks({
      pxPerDay: 14,
      viewStartDay: 0,
      trackW: 1400,
      calendar: gregCal,
      hasCalendarAxis: true,
    });
    expect(r.level).toBe("day");
    // 月境界 major が出る（= 月サブ目盛り）。
    expect(r.major.length).toBeGreaterThanOrEqual(2);
    // 2000-02-01 は day 31（1月=31日）。均等 365/12≈30.4 ではなく実値 31。
    const feb1 = dateToDayNumber(
      { year: 2000, monthIndex: 1, dayOfMonth: 1 },
      gregCal,
    );
    expect(feb1).toBe(31);
    const feb1x = feb1 * 14;
    const hit = r.major.find((t) => Math.abs(t.x - feb1x) < 0.5);
    expect(hit).toBeTruthy();
  });

  it("月 major ラベルは年を毎月繰り返さない（1月のみ年付き）", () => {
    const r = adaptiveTicks({
      pxPerDay: 14,
      viewStartDay: 0,
      trackW: 1400,
      calendar: gregCal,
      hasCalendarAxis: true,
    });
    const withYear = r.major.filter((t) => t.label.includes("年"));
    const monthOnly = r.major.filter((t) => !t.label.includes("年"));
    // 1月（年付き）は表示窓に1個程度、他の月は年なし。
    expect(withYear.length).toBeLessThanOrEqual(2);
    expect(monthOnly.length).toBeGreaterThanOrEqual(1);
    expect(monthOnly[0].label).not.toContain("年");
  });

  it("閏年 2000 の 2月29日が day 59 に存在し境界がずれない", () => {
    const mar1_2000 = dateToDayNumber(
      { year: 2000, monthIndex: 2, dayOfMonth: 1 },
      gregCal,
    );
    // 1月31 + 2月29 = 60 → 3月1日 = day 60。
    expect(mar1_2000).toBe(60);
    const mar1_2001 = dateToDayNumber(
      { year: 2001, monthIndex: 2, dayOfMonth: 1 },
      gregCal,
    );
    // 2001は平年: 366(2000) + 31 + 28 = 425。
    expect(mar1_2001).toBe(425);
  });
});
