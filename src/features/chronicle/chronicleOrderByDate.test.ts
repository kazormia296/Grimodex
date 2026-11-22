import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveChronicleAnchorByDate,
  resolveSceneAnchorByDate,
  type ChronicleAnchorEventRow,
} from "@/../electron/shared/readDomain/features/chronicle/chronicleAnchorByDate";
import {
  provisionalBaseDay,
  provisionalEventDates,
  type ChronicleProvisionalEventRow,
  type ChronicleProvisionalSceneDate,
} from "@/../electron/shared/readDomain/features/chronicle/chronicleProvisionalDate";
import type { SceneChronicle } from "@/../electron/shared/readDomain/features/chronicle/resolveSceneAnchor";
import {
  classifyEventRelation,
  compareChronicleEvents,
  relationOfSpans,
  sortChronicleEvents,
  type ChronicleOrderRow,
  type ChronicleRelation,
} from "@/../electron/shared/readDomain/features/chronicle/chronicleOrder";
import {
  anchorSpan,
  chronicleDateSpan,
  eventSpan,
  hasChronicleDate,
  type ChronicleEventSpanRow,
  type ChronicleSpan,
} from "@/../electron/shared/readDomain/features/chronicle/chronicleSpan";
import type { ChronicleCalendar } from "@/../electron/shared/readDomain/features/chronicle/chronicleTime";
import type { ChronicleAnchor } from "@/../electron/shared/readDomain/features/chronicle/resolveSceneAnchor";

// CED/1（K1・K2・K2a）、DR-CED-3〜6。
// fixture（Native と共有する試験用の例）の期待値は、暦の定義から手で数えた値で、関数の出力ではない。
// 画面側は、fixture の全件を照合する。fixture に無い細かい境界は、下の単体の試験で足す。

type FixtureEvent = ChronicleOrderRow;

interface FixtureAnchor {
  readonly ordinal: string;
  readonly startTime: number | null;
  readonly startMinute: number | null;
  readonly startGranularity: string;
  readonly precision: "exact" | "approx" | "unknown" | null;
  readonly source: ChronicleAnchor["source"];
  readonly proxySceneId: string | null;
}

interface Vectors {
  readonly schemaVersion: number;
  readonly purpose: string;
  readonly calendars: Record<string, unknown>;
  readonly spanCases: {
    id: string;
    description: string;
    calendar: string | null;
    event: FixtureEvent;
    expected: ChronicleSpan | null;
  }[];
  readonly orderCases: {
    id: string;
    description: string;
    calendar: string | null;
    events: FixtureEvent[];
    expectedOrder: string[];
  }[];
  readonly relationCases: {
    id: string;
    description: string;
    calendar: string | null;
    event: FixtureEvent;
    anchor: FixtureAnchor;
    expected: ChronicleRelation;
  }[];
  readonly anchorCases: { id: string }[];
  readonly provisionalCases: { id: string }[];
}

const vectors = JSON.parse(
  readFileSync(
    resolve(
      __dirname,
      "../../../src-tauri/crates/grimodex-core/src/chronicle_order/chronicle_order_vectors.json",
    ),
    "utf8",
  ),
) as Vectors;

/** JSON の null を、省略された任意の欄に戻す（Rust の側は null を Option として読む）。 */
function dropNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(dropNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, dropNulls(v)]),
    );
  }
  return value;
}

function calendarOf(name: string | null): ChronicleCalendar | null {
  if (name === null) return null;
  const raw = vectors.calendars[name];
  if (raw === undefined) throw new Error(`unknown calendar: ${name}`);
  return dropNulls(raw) as ChronicleCalendar;
}

const SPANCASES_IDS = [
  "time-with-minute",
  "time-minute-null",
  "time-calendar-null",
  "time-last-minute",
  "day-leftover-minute",
  "day-calendar-null",
  "day-negative",
  "month-plain-mid",
  "month-plain-first",
  "month-plain-last",
  "month-leftover-minute",
  "month-negative-day",
  "month-gregorian-leap-feb",
  "month-gregorian-common-feb",
  "month-gregorian-century-feb",
  "month-leap-december",
  "month-leap-december-year4",
  "month-no-months-fallback",
  "month-no-year-fallback",
  "month-calendar-null",
  "month-reform-cutover",
  "month-reform-cutover-julian-day",
  "month-reform-after-cutover",
  "month-reform-gregorian-common-feb",
  "month-reform-gregorian-leap-feb",
  "month-reform-julian-common-feb",
  "month-reform-julian-leap-feb",
  "month-reform-julian-century-leap-feb",
  "year-plain-mid",
  "year-negative",
  "year-leftover-minute",
  "year-gregorian-leap-400",
  "year-gregorian-common",
  "year-gregorian-leap-4",
  "year-gregorian-century-common",
  "year-leap-december",
  "year-leap-december-common",
  "year-leap-december-year4",
  "year-no-months-calendar",
  "year-single-season-calendar",
  "year-no-year-fallback",
  "year-calendar-null",
  "year-reform-cutover",
  "year-reform-after",
  "year-reform-julian-leap-century",
  "season-plain-summer",
  "season-plain-winter",
  "season-plain-spring-year1",
  "season-plain-boundary-day",
  "season-plain-negative",
  "season-unsorted-boundaries",
  "season-leftover-minute",
  "season-gregorian-spring",
  "season-gregorian-autumn-boundary",
  "season-gregorian-winter-crosses-year",
  "season-gregorian-winter-before-first-boundary",
  "season-gregorian-winter-before-first-boundary-year0",
  "season-gregorian-winter-into-leap-year",
  "season-single-boundary-after",
  "season-single-boundary-before-first",
  "season-no-boundaries-fallback",
  "season-no-year-fallback",
  "season-no-boundaries-no-months-fallback",
  "season-calendar-null",
  "season-reform-spring",
  "season-reform-winter-crosses-cutover-year",
  "season-reform-spring-after",
  "end-day-day",
  "end-day-same-day",
  "end-time",
  "end-time-minute-null",
  "end-time-start-time",
  "end-day-after-start-time",
  "end-month",
  "end-season",
  "end-year",
  "end-none",
  "end-unknown-granularity",
  "end-time-null-with-granularity",
  "end-before-start",
  "end-ends-where-start-begins",
  "end-month-ends-where-start-month-begins",
  "end-start-month",
  "end-start-season-end-month",
  "end-start-year-end-year",
  "end-calendar-null-month",
  "end-reform-month",
  "none-start-null",
  "none-granularity-none",
  "none-unknown-granularity",
  "none-end-only",
  "none-all-null",
  "none-time-granularity-start-null",
  "none-calendar-null",
  "month-gregorian-negative-leap",
  "year-gregorian-negative-leap",
  "end-inside-start-month-before-stored-day",
  "time-minute-above-range",
  "time-minute-negative",
];
const ORDERCASES_IDS = [
  "order-tie-ordinal-then-id",
  "order-date-before-ordinal",
  "order-month-uses-span-start",
  "order-season-and-year-use-span-start",
  "order-calendar-null-no-span-start",
  "order-undated-last",
  "order-ordinal-forms",
  "order-time-vs-day",
  "order-end-ignored",
  "order-reform-month",
  "order-gregorian-year",
  "order-negative-days",
  "order-all-undated",
  "order-empty",
];
const RELATIONCASES_IDS = [
  "rel-all-before",
  "rel-all-after",
  "rel-same-day-concurrent",
  "rel-adjacent-day-before",
  "rel-adjacent-day-after",
  "rel-month-event-contains-anchor",
  "rel-interval-overlap",
  "rel-interval-ends-before-anchor",
  "rel-interval-starts-after-anchor",
  "rel-time-event-day-anchor-concurrent",
  "rel-time-event-day-anchor-before",
  "rel-time-event-day-anchor-after",
  "rel-day-event-time-anchor-concurrent",
  "rel-time-vs-time-before",
  "rel-time-vs-time-same",
  "rel-time-vs-time-after",
  "rel-day-event-time-anchor-prev-day",
  "rel-month-anchor-event-before-stored-day",
  "rel-month-anchor-event-end-of-month",
  "rel-month-anchor-next-month",
  "rel-month-anchor-prev-month",
  "rel-season-anchor-inside",
  "rel-season-anchor-next",
  "rel-year-anchor-prev",
  "rel-year-anchor-first",
  "rel-year-anchor-last",
  "rel-year-anchor-next",
  "rel-stamped-anchor-concurrent",
  "rel-stamped-month-anchor-whole-month",
  "rel-proxy-same-day-before",
  "rel-proxy-month-overlap-before",
  "rel-proxy-anchor-month-overlap-before",
  "rel-proxy-after",
  "rel-proxy-before",
  "rel-proxy-interval-overlap-before",
  "rel-anchor-none-unknown",
  "rel-anchor-none-with-fields-unknown",
  "rel-event-undated-unknown",
  "rel-event-granularity-none-unknown",
  "rel-event-undated-proxy-unknown",
  "rel-anchor-granularity-none-unknown",
  "rel-anchor-time-null-unknown",
  "rel-month-event-calendar-null-before",
  "rel-month-event-calendar-null-concurrent",
  "rel-gregorian-leap-day-month",
  "rel-gregorian-leap-day-next-month",
  "rel-gregorian-leap-day-next-day",
  "rel-reform-consecutive-days",
  "rel-reform-cutover-month-concurrent",
  "rel-reform-year-concurrent",
  "rel-reform-next-month-after",
  "rel-season-event-vs-day-anchor",
  "rel-winter-crossing-year",
  "rel-anchor-unknown-granularity-string-unknown",
];

const MIN = 1440;

function row(over: Partial<FixtureEvent> = {}): FixtureEvent {
  return {
    id: "e",
    ordinal: "a0",
    startTime: null,
    startMinute: null,
    startGranularity: "none",
    endTime: null,
    endMinute: null,
    endGranularity: "none",
    ...over,
  };
}

const PLAIN: ChronicleCalendar = calendarOf("plain360") as ChronicleCalendar;

describe("fixture（Native と共有する試験用の例）", () => {
  it("形式と、case の id の一覧が固定されている", () => {
    expect(vectors.schemaVersion).toBe(1);
    expect(vectors.purpose.length).toBeGreaterThan(0);
    expect(vectors.spanCases.map((c) => c.id)).toEqual(SPANCASES_IDS);
    expect(vectors.orderCases.map((c) => c.id)).toEqual(ORDERCASES_IDS);
    expect(vectors.relationCases.map((c) => c.id)).toEqual(RELATIONCASES_IDS);
    // 件数の下限（case を黙って減らさない）。
    expect(vectors.spanCases.length).toBeGreaterThanOrEqual(99);
    expect(vectors.orderCases.length).toBeGreaterThanOrEqual(14);
    expect(vectors.relationCases.length).toBeGreaterThanOrEqual(54);
    // 2 段目が埋める部は、配列として置かれている。
    expect(Array.isArray(vectors.anchorCases)).toBe(true);
    expect(Array.isArray(vectors.provisionalCases)).toBe(true);
  });

  it("id は一意で、暦の名前は calendars にある", () => {
    for (const cases of [
      vectors.spanCases,
      vectors.orderCases,
      vectors.relationCases,
    ]) {
      expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
      for (const c of cases) {
        if (c.calendar !== null) {
          expect(Object.keys(vectors.calendars), c.id).toContain(c.calendar);
        }
        expect(c.description.length, c.id).toBeGreaterThan(0);
      }
    }
  });

  it("出来事の欄は全部明示されている（欠けたキーが無い）", () => {
    const keys = [
      "id",
      "ordinal",
      "startTime",
      "startMinute",
      "startGranularity",
      "endTime",
      "endMinute",
      "endGranularity",
    ];
    const events = [
      ...vectors.spanCases.map((c) => c.event),
      ...vectors.orderCases.flatMap((c) => c.events),
      ...vectors.relationCases.map((c) => c.event),
    ];
    for (const e of events) expect(Object.keys(e).sort()).toEqual(keys.sort());
    for (const c of vectors.relationCases) {
      expect(Object.keys(c.anchor).sort()).toEqual(
        [
          "ordinal",
          "startTime",
          "startMinute",
          "startGranularity",
          "precision",
          "source",
          "proxySceneId",
        ].sort(),
      );
    }
  });

  it.each(vectors.spanCases.map((c) => [c.id, c] as const))(
    "幅：%s",
    (_id, c) => {
      expect(eventSpan(c.event, calendarOf(c.calendar)), c.description).toEqual(
        c.expected,
      );
    },
  );

  it.each(vectors.orderCases.map((c) => [c.id, c] as const))(
    "並び：%s",
    (_id, c) => {
      const cal = calendarOf(c.calendar);
      const ids = (events: readonly FixtureEvent[]) =>
        sortChronicleEvents(events, cal).map((e) => e.id);
      expect(ids(c.events), c.description).toEqual(c.expectedOrder);
      // 比較関数は全順序なので、入力の並びに依らない。
      expect(ids([...c.events].reverse())).toEqual(c.expectedOrder);
      const rotated = [...c.events.slice(1), ...c.events.slice(0, 1)];
      expect(ids(rotated)).toEqual(c.expectedOrder);
      // 比較関数を直接 sort に渡しても同じ。
      expect(
        [...c.events]
          .sort((a, b) => compareChronicleEvents(a, b, cal))
          .map((e) => e.id),
      ).toEqual(c.expectedOrder);
    },
  );

  it.each(vectors.relationCases.map((c) => [c.id, c] as const))(
    "判定：%s",
    (_id, c) => {
      expect(
        classifyEventRelation(c.event, c.anchor, calendarOf(c.calendar)),
        c.description,
      ).toBe(c.expected);
    },
  );
});

describe("幅の単体の境界", () => {
  const span = (
    over: Partial<FixtureEvent>,
    cal: ChronicleCalendar | null = PLAIN,
  ) => eventSpan(row(over), cal);

  it("日時がある＝開始の日が有限の数で、粒度が time／day／month／season／year", () => {
    const has = (startTime: number | null, startGranularity: string) =>
      hasChronicleDate({ startTime, startMinute: null, startGranularity });
    expect(has(0, "day")).toBe(true);
    expect(has(-3, "time")).toBe(true);
    expect(has(0, "none")).toBe(false);
    expect(has(0, "")).toBe(false);
    expect(has(0, "Day")).toBe(false);
    expect(has(null, "day")).toBe(false);
    expect(has(Number.NaN, "day")).toBe(false);
    expect(has(Number.POSITIVE_INFINITY, "day")).toBe(false);
  });

  it("幅は常に end > start で、時刻は 1 分、日は 1440 分", () => {
    const t = span({ startTime: 0, startGranularity: "time" });
    const d = span({ startTime: 0, startGranularity: "day" });
    expect(t).toEqual({ start: 0, end: 1 });
    expect(d).toEqual({ start: 0, end: MIN });
  });

  it("時刻で分が範囲外でも、日 × 1440 + 分のまま（丸めない）", () => {
    expect(
      span({ startTime: 2, startMinute: 90, startGranularity: "time" }),
    ).toEqual({ start: 2 * MIN + 90, end: 2 * MIN + 91 });
  });

  it("日の分が非有限の値でも 0 分として扱う", () => {
    expect(
      span({ startTime: 1, startMinute: Number.NaN, startGranularity: "time" }),
    ).toEqual({ start: MIN, end: MIN + 1 });
  });

  it("季節の境界の昇順ソートは入力を変えない", () => {
    const boundaries = [
      { name: "b", startDayOfYear: 200 },
      { name: "a", startDayOfYear: 10 },
    ];
    const cal: ChronicleCalendar = {
      daysPerYear: 360,
      seasonBoundaries: boundaries,
    };
    expect(span({ startTime: 50, startGranularity: "season" }, cal)).toEqual({
      start: 10 * MIN,
      end: 200 * MIN,
    });
    expect(boundaries.map((b) => b.name)).toEqual(["b", "a"]);
  });

  it("季節の境界が重複しても、幅は正で、保存された日を含む", () => {
    const cal: ChronicleCalendar = {
      daysPerYear: 100,
      seasonBoundaries: [
        { name: "x", startDayOfYear: 20 },
        { name: "y", startDayOfYear: 20 },
        { name: "z", startDayOfYear: 70 },
      ],
    };
    // 境界 20 が 2 つ：20..69 を 1 つの区間とみなす（最後の境界を採る seasonOf と同じ）。
    expect(span({ startTime: 30, startGranularity: "season" }, cal)).toEqual({
      start: 20 * MIN,
      end: 70 * MIN,
    });
    expect(span({ startTime: 80, startGranularity: "season" }, cal)).toEqual({
      start: 70 * MIN,
      end: 120 * MIN,
    });
  });

  it("季節の境界に有限でない値があっても、残りの境界で求める", () => {
    const cal: ChronicleCalendar = {
      daysPerYear: 100,
      seasonBoundaries: [
        { name: "bad", startDayOfYear: Number.NaN },
        { name: "only", startDayOfYear: 40 },
      ],
    };
    expect(span({ startTime: 50, startGranularity: "season" }, cal)).toEqual({
      start: 40 * MIN,
      end: 140 * MIN,
    });
  });

  it("季節の境界がすべて有限でなければ、保存された開始の 1 日", () => {
    const cal: ChronicleCalendar = {
      daysPerYear: 100,
      seasonBoundaries: [{ name: "bad", startDayOfYear: Number.NaN }],
    };
    expect(span({ startTime: 50, startGranularity: "season" }, cal)).toEqual({
      start: 50 * MIN,
      end: 51 * MIN,
    });
  });

  it("月の定義はあるが季節の境界が無い暦：月は求まり、季節は 1 日", () => {
    const cal: ChronicleCalendar = {
      daysPerYear: 60,
      seasonBoundaries: [],
      months: [
        { name: "a", days: 20 },
        { name: "b", days: 40 },
      ],
    };
    expect(span({ startTime: 30, startGranularity: "month" }, cal)).toEqual({
      start: 20 * MIN,
      end: 60 * MIN,
    });
    expect(span({ startTime: 30, startGranularity: "season" }, cal)).toEqual({
      start: 30 * MIN,
      end: 31 * MIN,
    });
  });

  it("月が空配列の暦は、月の定義が無いものとして 1 日", () => {
    const cal: ChronicleCalendar = {
      daysPerYear: 100,
      seasonBoundaries: [],
      months: [],
    };
    expect(span({ startTime: 150, startGranularity: "month" }, cal)).toEqual({
      start: 150 * MIN,
      end: 151 * MIN,
    });
    expect(span({ startTime: 150, startGranularity: "year" }, cal)).toEqual({
      start: 100 * MIN,
      end: 200 * MIN,
    });
  });

  it("終わりの日が小数のときも、日は切り捨てて扱う", () => {
    expect(
      span({
        startTime: 10,
        startGranularity: "day",
        endTime: 12.9,
        endGranularity: "day",
      }),
    ).toEqual({ start: 10 * MIN, end: 13 * MIN });
  });

  it("終わりの終端が、開始の幅の終端より手前でも、終わりの幅の端を使う（開始の幅の始まりは保つ）", () => {
    // 開始が月（30..59）で、終わりが同じ月の中の 35 日。幅は 30 日の始まりから 35 日の終わりまで。
    expect(
      span({
        startTime: 50,
        startGranularity: "month",
        endTime: 35,
        endGranularity: "day",
      }),
    ).toEqual({ start: 30 * MIN, end: 36 * MIN });
  });

  it("終わりが開始の時刻と同じ分の 1 分幅のとき、終わりの幅の終端が開始以前なら終わりを使わない", () => {
    // 開始 10 日 600 分（time）、終わり 10 日 599 分（time、幅の終端 600 分 = 開始の始まり）。
    expect(
      span({
        startTime: 10,
        startMinute: 600,
        startGranularity: "time",
        endTime: 10,
        endMinute: 599,
        endGranularity: "time",
      }),
    ).toEqual({ start: 10 * MIN + 600, end: 10 * MIN + 601 });
  });

  it("暦が壊れていて、期間の端が有限でないときは、保存された 1 日に戻る（NaN・Infinity を幅に出さない）", () => {
    const month = (cal: ChronicleCalendar) =>
      span({ startTime: 5, startGranularity: "month" }, cal);
    const year = (cal: ChronicleCalendar) =>
      span({ startTime: 5, startGranularity: "year" }, cal);
    const season = (cal: ChronicleCalendar) =>
      span({ startTime: 5, startGranularity: "season" }, cal);
    const oneDay = { start: 5 * MIN, end: 6 * MIN };
    // 月の日数が Infinity。
    expect(
      month({
        daysPerYear: 360,
        seasonBoundaries: [],
        months: [{ name: "M1", days: Number.POSITIVE_INFINITY }],
      }),
    ).toEqual(oneDay);
    // 起点の年が NaN。
    expect(
      month({
        daysPerYear: 360,
        seasonBoundaries: [],
        startYear: Number.NaN,
        months: [{ name: "M1", days: 30 }],
      }),
    ).toEqual(oneDay);
    // 1 年の日数が Infinity。
    const infiniteYear: ChronicleCalendar = {
      daysPerYear: Number.POSITIVE_INFINITY,
      seasonBoundaries: [{ name: "s", startDayOfYear: 0 }],
    };
    expect(year(infiniteYear)).toEqual(oneDay);
    expect(season(infiniteYear)).toEqual(oneDay);
    // 結果は、常に有限の区間になる。
    for (const s of [
      month(infiniteYear),
      year(infiniteYear),
      season(infiniteYear),
    ]) {
      expect(Number.isFinite(s?.start)).toBe(true);
      expect(Number.isFinite(s?.end)).toBe(true);
    }
  });

  it("終わりだけがあって開始が無い出来事は、幅が無い", () => {
    expect(span({ endTime: 5, endGranularity: "day" })).toBeNull();
  });

  it("負の幅の端でも -0 を返さない", () => {
    const s = span({ startTime: -1, startGranularity: "year" });
    expect(s).toEqual({ start: -360 * MIN, end: 0 });
  });

  it("現在地の幅：scene・stamped・proxy は粒度の幅、none は null", () => {
    const base = {
      startTime: 100,
      startMinute: null,
      startGranularity: "month",
    };
    const want = { start: 90 * MIN, end: 120 * MIN };
    for (const source of ["scene", "stamped", "proxy"] as const) {
      expect(anchorSpan({ ...base, source }, PLAIN), source).toEqual(want);
    }
    expect(anchorSpan({ ...base, source: "none" }, PLAIN)).toBeNull();
    expect(
      anchorSpan({ ...base, startGranularity: "none", source: "scene" }, PLAIN),
    ).toBeNull();
  });

  it("現在地の幅は、出来事の終わりを持たない（開始の粒度の幅だけ。◇11）", () => {
    // 現在地の入力は開始の欄だけ。期間のある出来事で決めても、開始の粒度の幅になる。
    const anchor = {
      startTime: 10,
      startMinute: null,
      startGranularity: "day",
      source: "stamped" as const,
    };
    expect(anchorSpan(anchor, PLAIN)).toEqual({
      start: 10 * MIN,
      end: 11 * MIN,
    });
  });

  it("場面の作中日付も、同じ部品で幅になる", () => {
    expect(
      chronicleDateSpan(
        { startTime: 100, startMinute: 30, startGranularity: "time" },
        null,
      ),
    ).toEqual({ start: 100 * MIN + 30, end: 100 * MIN + 31 });
    expect(
      chronicleDateSpan(
        { startTime: null, startMinute: null, startGranularity: "day" },
        PLAIN,
      ),
    ).toBeNull();
  });
});

describe("並びと判定の単体の境界", () => {
  it("比較関数は反対称で、自分自身とは 0", () => {
    const events = [
      row({ id: "a", ordinal: "a0", startTime: 1, startGranularity: "day" }),
      row({ id: "b", ordinal: "a0", startTime: 1, startGranularity: "day" }),
      row({ id: "c", ordinal: "a1", startTime: 1, startGranularity: "day" }),
      row({ id: "d", startTime: 2, startGranularity: "month" }),
      row({ id: "e", ordinal: "a0" }),
      row({ id: "f", ordinal: "a0" }),
    ];
    for (const x of events) {
      expect(compareChronicleEvents(x, x, PLAIN)).toBe(0);
      for (const y of events) {
        if (x === y) continue;
        const xy = compareChronicleEvents(x, y, PLAIN);
        const yx = compareChronicleEvents(y, x, PLAIN);
        expect(xy, `${x.id} ${y.id}`).not.toBe(0);
        expect(Math.sign(xy)).toBe(-Math.sign(yx));
      }
    }
  });

  it("sortChronicleEvents は入力を変えず、新しい配列を返す", () => {
    const events = [
      row({ id: "b", startTime: 5, startGranularity: "day" }),
      row({ id: "a", startTime: 1, startGranularity: "day" }),
    ];
    const sorted = sortChronicleEvents(events, PLAIN);
    expect(sorted.map((e) => e.id)).toEqual(["a", "b"]);
    expect(events.map((e) => e.id)).toEqual(["b", "a"]);
    expect(sorted).not.toBe(events);
  });

  it("元の行の型（余分な欄）を保って返す", () => {
    const events = [
      { ...row({ id: "x", startTime: 1, startGranularity: "day" }), tag: 7 },
    ];
    expect(sortChronicleEvents(events, PLAIN)[0].tag).toBe(7);
  });

  it("同じ日時なら、日時の無い出来事は 裏の並び → id で全部の後ろ", () => {
    const events = [
      row({ id: "u2", ordinal: "a0" }),
      row({ id: "d", startTime: 99999, startGranularity: "year" }),
      row({ id: "u1", ordinal: "a0" }),
    ];
    expect(sortChronicleEvents(events, PLAIN).map((e) => e.id)).toEqual([
      "d",
      "u1",
      "u2",
    ]);
  });

  it("relationOfSpans：どちらかが null なら unknown（借りた現在地でも）", () => {
    const s: ChronicleSpan = { start: 0, end: 10 };
    expect(relationOfSpans(null, s, false)).toBe("unknown");
    expect(relationOfSpans(s, null, false)).toBe("unknown");
    expect(relationOfSpans(s, null, true)).toBe("unknown");
    expect(relationOfSpans(null, null, false)).toBe("unknown");
  });

  it("relationOfSpans：接する 2 通りは重ならない（終わりを含まない区間）", () => {
    const anchor: ChronicleSpan = { start: 10, end: 20 };
    expect(relationOfSpans({ start: 0, end: 10 }, anchor, false)).toBe(
      "before",
    );
    expect(relationOfSpans({ start: 20, end: 30 }, anchor, false)).toBe(
      "after",
    );
    expect(relationOfSpans({ start: 0, end: 11 }, anchor, false)).toBe(
      "concurrent",
    );
    expect(relationOfSpans({ start: 19, end: 30 }, anchor, false)).toBe(
      "concurrent",
    );
    // 出来事の幅が現在地の幅を含む／含まれる。
    expect(relationOfSpans({ start: 0, end: 30 }, anchor, false)).toBe(
      "concurrent",
    );
    expect(relationOfSpans({ start: 12, end: 15 }, anchor, false)).toBe(
      "concurrent",
    );
  });

  it("relationOfSpans：借りた現在地では、重なりは before、重ならなければそのまま", () => {
    const anchor: ChronicleSpan = { start: 10, end: 20 };
    expect(relationOfSpans({ start: 15, end: 25 }, anchor, true)).toBe(
      "before",
    );
    expect(relationOfSpans({ start: 0, end: 10 }, anchor, true)).toBe("before");
    expect(relationOfSpans({ start: 20, end: 30 }, anchor, true)).toBe("after");
  });

  it("classifyEventRelation：現在地の source が none なら、日時の欄が残っていても unknown", () => {
    const event = row({ startTime: 1, startGranularity: "day" });
    expect(
      classifyEventRelation(
        event,
        {
          source: "none",
          startTime: 1,
          startMinute: null,
          startGranularity: "day",
        },
        PLAIN,
      ),
    ).toBe("unknown");
  });

  it("classifyEventRelation：終わりのある出来事は、終わりの粒度の幅の端まで重なる", () => {
    const event: ChronicleEventSpanRow = row({
      startTime: 10,
      startGranularity: "day",
      endTime: 70,
      endGranularity: "month",
    });
    const at = (day: number) =>
      classifyEventRelation(
        event,
        {
          source: "scene",
          startTime: day,
          startMinute: null,
          startGranularity: "day",
        },
        PLAIN,
      );
    expect(at(9)).toBe("after");
    expect(at(10)).toBe("concurrent");
    expect(at(89)).toBe("concurrent"); // 終わりの月（60..89）の末日まで
    expect(at(90)).toBe("before");
  });
});

// ───────── 現在地（DR-CED-7）と仮の日時（DR-CED-8）の fixture と単体の試験 ─────────
// 期待値は、規則（C3・C3a・C4、I2）から手で決めた値で、関数の出力ではない。

interface AnchorCase {
  id: string;
  description: string;
  calendar: string | null;
  currentSceneId: string;
  events: ChronicleAnchorEventRow[];
  sceneEvents: { sceneId: string; eventId: string }[];
  readingOrder: string[];
  sceneChronicle: Record<
    string,
    {
      startTime: number | null;
      startMinute: number | null;
      startGranularity: string;
      precision: "exact" | "approx" | "unknown";
    }
  >;
  hasDatedLiveScene: boolean;
  expected: {
    source: ChronicleAnchor["source"];
    startTime: number | null;
    startMinute: number | null;
    startGranularity: string;
    precision: "exact" | "approx" | "unknown" | null;
    proxySceneId: string | null;
    eventId: string | null;
  };
}

interface ProvisionalCase {
  id: string;
  description: string;
  events: ChronicleProvisionalEventRow[];
  liveSceneDates: ChronicleProvisionalSceneDate[];
  expected: { id: string; startTime: number }[];
}

const anchorCases = vectors.anchorCases as unknown as AnchorCase[];
const provisionalCases =
  vectors.provisionalCases as unknown as ProvisionalCase[];

const ANCHORCASES_IDS = [
  "anchor-scene-date-beats-stamped",
  "anchor-scene-date-time-approx",
  "anchor-scene-date-unknown-precision",
  "anchor-scene-granularity-none-not-a-date",
  "anchor-scene-granularity-unknown-string-not-a-date",
  "anchor-scene-start-null-not-a-date",
  "anchor-stamped-single",
  "anchor-stamped-latest-by-date-all-a0",
  "anchor-stamped-date-beats-ordinal",
  "anchor-stamped-same-date-ordinal-breaks-tie",
  "anchor-stamped-same-date-same-ordinal-id-breaks-tie",
  "anchor-stamped-month-event-sorts-by-span-start",
  "anchor-stamped-time-event-beats-day-with-leftover-minute",
  "anchor-stamped-time-later-minute",
  "anchor-stamped-end-time-ignored",
  "anchor-approx-is-material",
  "anchor-unknown-excluded-when-exact-exists",
  "anchor-unknown-only-scene-borrows",
  "anchor-undated-event-is-not-material",
  "anchor-undated-event-not-material-even-under-c3a",
  "anchor-proxy-skips-scene-with-only-non-material",
  "anchor-proxy-from-scene-date",
  "anchor-proxy-scene-date-nearer-than-event-scene",
  "anchor-proxy-scene-date-beats-its-own-events",
  "anchor-proxy-nearest-by-reading-order-not-by-date",
  "anchor-proxy-uses-reading-order-not-input-order",
  "anchor-no-borrow-from-later-scene",
  "anchor-current-scene-not-in-reading-order",
  "anchor-current-scene-not-in-reading-order-own-event",
  "anchor-orphan-link-ignored",
  "anchor-orphan-link-only-is-none",
  "anchor-empty",
  "anchor-c3a-all-unknown-stamped",
  "anchor-c3a-all-unknown-proxy",
  "anchor-c3a-undated-event-counts-as-unknown",
  "anchor-c3a-off-when-dated-live-scene",
  "anchor-c3a-off-when-one-event-not-unknown",
  "anchor-c3a-off-when-one-event-approx",
  "anchor-calendar-null",
];

const PROVISIONALCASES_IDS = [
  "prov-after-latest-start",
  "prov-end-day-counts",
  "prov-end-granularity-none-ignored",
  "prov-end-before-start",
  "prov-scene-date-later",
  "prov-scene-date-earlier",
  "prov-scene-granularity-none-ignored",
  "prov-scene-only",
  "prov-no-dates-at-all",
  "prov-nothing-to-place",
  "prov-no-events",
  "prov-order-ordinal-then-created-then-id",
  "prov-all-ordinal-a0-created-order",
  "prov-created-at-mixed-formats",
  "prov-created-at-same-instant-id-breaks-tie",
  "prov-created-at-fractional-seconds",
  "prov-granularity-none-with-day-is-not-a-target",
  "prov-month-event-uses-stored-day",
  "prov-end-only-event-is-a-target",
  "prov-negative-days",
  "prov-start-granularity-unknown-string-day-counts",
  "prov-end-granularity-unknown-string-ignored",
  "prov-scene-granularity-unknown-string-ignored",
  "prov-season-event-uses-stored-day",
  "prov-year-event-uses-stored-day",
  "prov-end-month-event-uses-stored-end-day",
  "prov-created-at-unreadable-sorts-last",
  "prov-created-at-identical-unreadable-id-breaks-tie",
  "prov-created-at-both-unreadable-different-id-breaks-tie",
];

function anchorCtx(c: AnchorCase) {
  return {
    events: c.events,
    sceneEvents: c.sceneEvents,
    readingOrder: new Map(c.readingOrder.map((id, i) => [id, i] as const)),
    sceneChronicle: new Map(Object.entries(c.sceneChronicle)) as Map<
      string,
      SceneChronicle
    >,
    calendar: calendarOf(c.calendar),
    hasDatedLiveScene: c.hasDatedLiveScene,
  };
}

describe("fixture：現在地と仮の日時（Native と共有する試験用の例）", () => {
  it("case の id の一覧と件数の下限が固定されている", () => {
    expect(anchorCases.map((c) => c.id)).toEqual(ANCHORCASES_IDS);
    expect(provisionalCases.map((c) => c.id)).toEqual(PROVISIONALCASES_IDS);
    expect(anchorCases.length).toBeGreaterThanOrEqual(39);
    expect(provisionalCases.length).toBeGreaterThanOrEqual(29);
  });

  it("id は一意で、暦の名前は calendars にあり、欄は全部明示されている", () => {
    for (const cases of [anchorCases, provisionalCases]) {
      expect(new Set(cases.map((c) => c.id)).size).toBe(cases.length);
      for (const c of cases)
        expect(c.description.length, c.id).toBeGreaterThan(0);
    }
    const eventKeys = [
      "id",
      "ordinal",
      "startTime",
      "startMinute",
      "startGranularity",
      "endTime",
      "endMinute",
      "endGranularity",
      "precision",
    ].sort();
    const anchorKeys = [
      "source",
      "startTime",
      "startMinute",
      "startGranularity",
      "precision",
      "proxySceneId",
      "eventId",
    ].sort();
    for (const c of anchorCases) {
      if (c.calendar !== null) {
        expect(Object.keys(vectors.calendars), c.id).toContain(c.calendar);
      }
      for (const e of c.events)
        expect(Object.keys(e).sort(), c.id).toEqual(eventKeys);
      expect(Object.keys(c.expected).sort(), c.id).toEqual(anchorKeys);
      expect(typeof c.hasDatedLiveScene, c.id).toBe("boolean");
      for (const sc of Object.values(c.sceneChronicle)) {
        expect(Object.keys(sc).sort(), c.id).toEqual(
          ["precision", "startGranularity", "startMinute", "startTime"].sort(),
        );
      }
    }
    const provKeys = [
      "id",
      "ordinal",
      "createdAt",
      "startTime",
      "startGranularity",
      "endTime",
      "endGranularity",
    ].sort();
    for (const c of provisionalCases) {
      for (const e of c.events)
        expect(Object.keys(e).sort(), c.id).toEqual(provKeys);
      for (const s of c.liveSceneDates) {
        expect(Object.keys(s).sort(), c.id).toEqual([
          "startGranularity",
          "startTime",
        ]);
      }
    }
  });

  it.each(anchorCases.map((c) => [c.id, c] as const))(
    "現在地：%s",
    (_id, c) => {
      const ctx = anchorCtx(c);
      const { anchor, eventId } = resolveChronicleAnchorByDate(
        c.currentSceneId,
        ctx,
      );
      expect(
        {
          source: anchor.source,
          startTime: anchor.startTime,
          startMinute: anchor.startMinute,
          startGranularity: anchor.startGranularity,
          precision: anchor.precision,
          proxySceneId: anchor.proxySceneId ?? null,
          eventId,
        },
        c.description,
      ).toEqual(c.expected);
      // 現在地だけを返す関数も同じ。
      expect(resolveSceneAnchorByDate(c.currentSceneId, ctx)).toEqual(anchor);
      // 出来事・結び付きの並びを逆にしても、結果は変わらない。
      const reversed = resolveChronicleAnchorByDate(c.currentSceneId, {
        ...ctx,
        events: [...c.events].reverse(),
        sceneEvents: [...c.sceneEvents].reverse(),
      });
      expect(reversed.eventId).toBe(eventId);
      expect(reversed.anchor.source).toBe(anchor.source);
      expect(reversed.anchor.startTime).toBe(anchor.startTime);
    },
  );

  it.each(provisionalCases.map((c) => [c.id, c] as const))(
    "仮の日時：%s",
    (_id, c) => {
      expect(
        provisionalEventDates(c.events, c.liveSceneDates),
        c.description,
      ).toEqual(c.expected);
      // 入力の並びに依らない。
      expect(
        provisionalEventDates([...c.events].reverse(), c.liveSceneDates),
      ).toEqual(c.expected);
    },
  );
});

describe("現在地の単体の境界", () => {
  const event = (
    over: Partial<ChronicleAnchorEventRow> & { id: string },
  ): ChronicleAnchorEventRow => ({
    ...row(),
    precision: "exact",
    ...over,
  });
  const day = (
    id: string,
    startTime: number,
    precision: ChronicleAnchorEventRow["precision"] = "exact",
  ) => event({ id, startTime, startGranularity: "day", precision });
  const ro = (...ids: string[]) =>
    new Map(ids.map((id, i) => [id, i] as const));

  it("hasDatedLiveScene を省くと、sceneChronicle に日時のある場面があるかで決める", () => {
    const events = [day("e1", 10, "unknown")];
    const base = {
      events,
      sceneEvents: [{ sceneId: "s1", eventId: "e1" }],
      readingOrder: ro("s1", "s2"),
      calendar: PLAIN,
    };
    // 日付のある場面が無い：C3a で、不明の出来事も材料。
    expect(resolveChronicleAnchorByDate("s1", base).eventId).toBe("e1");
    expect(
      resolveChronicleAnchorByDate("s1", { ...base, sceneChronicle: new Map() })
        .eventId,
    ).toBe("e1");
    // 日付のある場面が（後ろに）ある：C3a に当たらず、材料が無い。
    const withDated = new Map<string, SceneChronicle>([
      [
        "s2",
        {
          startTime: 5,
          startMinute: null,
          startGranularity: "day",
          precision: "exact",
        },
      ],
    ]);
    expect(
      resolveChronicleAnchorByDate("s1", { ...base, sceneChronicle: withDated })
        .anchor.source,
    ).toBe("none");
    // 明示した値が、導出より先。
    expect(
      resolveChronicleAnchorByDate("s1", {
        ...base,
        sceneChronicle: withDated,
        hasDatedLiveScene: false,
      }).eventId,
    ).toBe("e1");
    // 粒度が none の場面は、日付のある場面に数えない。
    const noDate = new Map<string, SceneChronicle>([
      [
        "s2",
        {
          startTime: 5,
          startMinute: null,
          startGranularity: "none",
          precision: "exact",
        },
      ],
    ]);
    expect(
      resolveChronicleAnchorByDate("s1", { ...base, sceneChronicle: noDate })
        .eventId,
    ).toBe("e1");
  });

  it("現在地の幅は、決めた出来事の開始の粒度の幅（月の出来事なら月の全体）", () => {
    const events = [
      event({ id: "m", startTime: 50, startGranularity: "month" }),
    ];
    const anchor = resolveSceneAnchorByDate("s1", {
      events,
      sceneEvents: [{ sceneId: "s1", eventId: "m" }],
      readingOrder: ro("s1"),
      calendar: PLAIN,
    });
    expect(anchorSpan(anchor, PLAIN)).toEqual({
      start: 30 * MIN,
      end: 60 * MIN,
    });
    // 現在地が決まらなければ幅も無い。
    expect(
      anchorSpan(
        resolveSceneAnchorByDate("s1", {
          events: [],
          sceneEvents: [],
          readingOrder: ro("s1"),
          calendar: PLAIN,
        }),
        PLAIN,
      ),
    ).toBeNull();
  });

  it("借りた現在地（proxy）は、重なる出来事を before にする（K2a）。今の場面そのものの現在地は concurrent", () => {
    const events = [day("e1", 10), day("e2", 10)];
    const ctx = {
      events,
      sceneEvents: [{ sceneId: "s1", eventId: "e1" }],
      readingOrder: ro("s1", "s2"),
      calendar: PLAIN,
    };
    const own = resolveSceneAnchorByDate("s1", ctx);
    const borrowed = resolveSceneAnchorByDate("s2", ctx);
    expect(own.source).toBe("stamped");
    expect(borrowed.source).toBe("proxy");
    expect(classifyEventRelation(events[1], own, PLAIN)).toBe("concurrent");
    expect(classifyEventRelation(events[1], borrowed, PLAIN)).toBe("before");
  });

  it("scene の現在地の ordinal は、日時が現在地以前の出来事のうち最も後のものの ordinal（無ければ空）", () => {
    const events = [
      day("e1", 10),
      event({
        id: "e2",
        startTime: 20,
        startGranularity: "day",
        ordinal: "a3",
      }),
      event({
        id: "e3",
        startTime: 20,
        startGranularity: "day",
        ordinal: "a5",
      }),
      day("e4", 90),
    ];
    const scenes = new Map<string, SceneChronicle>([
      [
        "s1",
        {
          startTime: 30,
          startMinute: null,
          startGranularity: "day",
          precision: "exact",
        },
      ],
      [
        "s2",
        {
          startTime: 5,
          startMinute: null,
          startGranularity: "day",
          precision: "exact",
        },
      ],
    ]);
    const at = (sceneId: string) =>
      resolveSceneAnchorByDate(sceneId, {
        events,
        sceneEvents: [],
        readingOrder: ro("s1", "s2"),
        sceneChronicle: scenes,
        calendar: PLAIN,
      }).ordinal;
    expect(at("s1")).toBe("a5");
    expect(at("s2")).toBe("");
  });

  it("stamped・proxy の anchor は、選んだ出来事の ordinal・開始の欄・確度を持つ", () => {
    const e = event({
      id: "e1",
      ordinal: "a7",
      startTime: 10,
      startMinute: 125,
      startGranularity: "time",
      precision: "approx",
    });
    const ctx = {
      events: [e],
      sceneEvents: [{ sceneId: "s1", eventId: "e1" }],
      readingOrder: ro("s1", "s2"),
      calendar: PLAIN,
    };
    expect(resolveSceneAnchorByDate("s1", ctx)).toEqual({
      ordinal: "a7",
      startTime: 10,
      startMinute: 125,
      startGranularity: "time",
      precision: "approx",
      source: "stamped",
    });
    expect(resolveSceneAnchorByDate("s2", ctx)).toEqual({
      ordinal: "a7",
      startTime: 10,
      startMinute: 125,
      startGranularity: "time",
      precision: "approx",
      source: "proxy",
      proxySceneId: "s1",
    });
  });

  it("入力を書き換えない", () => {
    const events = [day("e2", 20), day("e1", 10)];
    const links = [{ sceneId: "s1", eventId: "e1" }];
    const snapshot = JSON.stringify({ events, links });
    resolveChronicleAnchorByDate("s2", {
      events,
      sceneEvents: links,
      readingOrder: ro("s1", "s2"),
      calendar: PLAIN,
    });
    expect(JSON.stringify({ events, links })).toBe(snapshot);
  });
});

describe("仮の日時の単体の境界", () => {
  const pe = (
    over: Partial<ChronicleProvisionalEventRow> & { id: string },
  ): ChronicleProvisionalEventRow => ({
    ordinal: "a0",
    createdAt: "2026-01-01T00:00:00.000Z",
    startTime: null,
    endTime: null,
    startGranularity: "none",
    endGranularity: "none",
    ...over,
  });

  it("日が小数でも、切り捨ててから 1 日進める", () => {
    expect(
      provisionalBaseDay(
        [pe({ id: "e1", startTime: 5.5, startGranularity: "day" })],
        [],
      ),
    ).toBe(6);
  });

  it("開始の日があり、粒度が知らない文字列の出来事は、対象にせず、その日を最も後の日に数える", () => {
    const events = [
      pe({ id: "x", startTime: 30, startGranularity: "decade" }),
      pe({ id: "d1" }),
    ];
    expect(provisionalEventDates(events, [])).toEqual([
      { id: "d1", startTime: 31 },
    ]);
  });

  it("非有限の日は、日が無いものとして扱う", () => {
    const events = [
      pe({ id: "n", startTime: Number.NaN, startGranularity: "day" }),
      pe({
        id: "i",
        startTime: Number.POSITIVE_INFINITY,
        startGranularity: "day",
      }),
    ];
    expect(provisionalBaseDay(events, [])).toBe(0);
    expect(provisionalEventDates(events, []).map((p) => p.id)).toEqual([
      "i",
      "n",
    ]);
  });

  it("終わりの粒度が知らない文字列なら、終わりの日は数えない", () => {
    expect(
      provisionalBaseDay(
        [
          pe({
            id: "e1",
            startTime: 10,
            startGranularity: "day",
            endTime: 90,
            endGranularity: "decade",
          }),
        ],
        [],
      ),
    ).toBe(11);
  });

  it("入力を書き換えない", () => {
    const events = [pe({ id: "b" }), pe({ id: "a" })];
    const snapshot = JSON.stringify(events);
    provisionalEventDates(events, []);
    expect(JSON.stringify(events)).toBe(snapshot);
  });
});
