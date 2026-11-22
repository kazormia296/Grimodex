/**
 * 年表の「日時の幅」（CED/1 の K2、判断の記録 DR-CED-3・4・5）。
 *
 * 出来事・場面の作中日付・現在地を、同じ部品で「分の区間」にする。
 *  - 単位は分（日 × 1440 ＋ 分）。区間は、始まりを含み、終わりを含まない。
 *  - 日時が無ければ null（開始の日が無いか、粒度が none／知らない文字列）。
 *  - 粒度の幅：time=1 分、day=1 日、month／season／year=暦から求めたその期間。
 *    暦から求められない粒度（月の定義が無い、季節の境界が無い、1 年の日数が決まらない、
 *    暦が null）は、保存された開始の 1 日にする（決定 13）。
 *  - 分は、粒度が time のときだけ数える（無ければ 0 分）。day 以上の粒度に残った分は数えない。
 *
 * 純粋な関数だけ。DOM・Node・DB・store・React を使わない。
 */
import {
  type ChronicleCalendar,
  type SeasonBoundary,
  calendarDaysPerYear,
  dateToDayNumber,
  dayNumberToDate,
  daysInYear,
  monthLength,
} from "./chronicleTime.js";
import type { EventRow } from "./eventRows.js";
import type { ChronicleAnchor } from "./resolveSceneAnchor.js";

/**
 * 1 日の分数。このファイルを正本とする（chronicleTime.ts にも非公開の同じ定数があるが、
 * 既にあるファイルなので、この PR では変えない。切り替えの PR で統合する）。
 */
export const MINUTES_PER_DAY = 24 * 60;

/** 分の区間（始まりを含み、終わりを含まない）。常に end > start。 */
export interface ChronicleSpan {
  start: number;
  end: number;
}

/** 日時の始まり 1 点分の入力（出来事の開始・場面の作中日付・現在地に共通）。 */
export interface ChronicleDateInput {
  startTime: number | null;
  startMinute: number | null;
  /** 知らない文字列も受ける（日時が無いものとして扱う）。 */
  startGranularity: string;
}

/** 出来事の幅を出すのに要る欄。粒度は、知らない文字列も受ける。 */
export type ChronicleEventSpanRow = Pick<
  EventRow,
  "startTime" | "startMinute" | "endTime" | "endMinute"
> & {
  startGranularity: string;
  endGranularity: string;
};

/** 現在地の幅を出すのに要る欄。 */
export type ChronicleAnchorSpanInput = Pick<
  ChronicleAnchor,
  "source" | "startTime" | "startMinute" | "startGranularity"
>;

/** 日時を持てる粒度（none と知らない文字列は含まない）。 */
const DATED_GRANULARITIES: ReadonlySet<string> = new Set([
  "time",
  "day",
  "month",
  "season",
  "year",
]);

/** 日時がある＝開始の日が有限の数で、粒度が time／day／month／season／year（DR-CED-3）。 */
export function hasChronicleDate(date: ChronicleDateInput): boolean {
  return (
    typeof date.startTime === "number" &&
    Number.isFinite(date.startTime) &&
    DATED_GRANULARITIES.has(date.startGranularity)
  );
}

/** 保存された日 1 日ぶんの幅。 */
function daySpan(day: number): ChronicleSpan {
  return { start: day * MINUTES_PER_DAY, end: (day + 1) * MINUTES_PER_DAY };
}

/**
 * 求めた期間（日数の始まりと終わり）を分の区間にする。
 * 暦が壊れていて、始まりか終わりが有限でない（NaN・Infinity）ときは null にして、
 * 呼び出す側が「求められない」として、保存された 1 日に戻れるようにする。
 */
function spanOfDays(startDay: number, endDay: number): ChronicleSpan | null {
  if (!Number.isFinite(startDay) || !Number.isFinite(endDay)) return null;
  if (!(endDay > startDay)) return null;
  return { start: startDay * MINUTES_PER_DAY, end: endDay * MINUTES_PER_DAY };
}

/** 1 年の日数が決まっているか（改暦は年長を実暦から求める）。 */
function yearLengthKnown(cal: ChronicleCalendar): boolean {
  return cal.reform != null || calendarDaysPerYear(cal) > 0;
}

/** その日が入る月の、初日から末日まで。月の定義が無ければ null。 */
function monthSpanOf(
  day: number,
  cal: ChronicleCalendar,
): ChronicleSpan | null {
  const date = dayNumberToDate(day, cal);
  if (date.monthIndex == null) return null;
  // 改暦の月は、切替の日飛ばしで「日 − 月内日 + 1」が月初にならないので、暦に月初を聞く。
  const first = dateToDayNumber(
    { year: date.year, monthIndex: date.monthIndex, dayOfMonth: 1 },
    cal,
  );
  const length = monthLength(date.year, date.monthIndex, cal);
  if (!(length > 0) || day < first || day >= first + length) return null;
  return spanOfDays(first, first + length);
}

/** その日が入る年の、初日から末日まで。1 年の日数が決まらなければ null。 */
function yearSpanOf(day: number, cal: ChronicleCalendar): ChronicleSpan | null {
  if (!yearLengthKnown(cal)) return null;
  const date = dayNumberToDate(day, cal);
  const first = day - date.dayOfYear;
  const length = daysInYear(date.year, cal);
  if (!(length > 0) || day >= first + length) return null;
  return spanOfDays(first, first + length);
}

// 境界の昇順ソートを配列 identity でキャッシュする（seasonOf と同じ idiom）。
const sortedSeasonCache = new WeakMap<SeasonBoundary[], number[]>();

/** 季節の始まり（年内通日）を、昇順・有限の値だけで返す。 */
function sortedSeasonStarts(boundaries: SeasonBoundary[]): number[] {
  const cached = sortedSeasonCache.get(boundaries);
  if (cached) return cached;
  const starts = boundaries
    .map((b) => b.startDayOfYear)
    .filter((s) => Number.isFinite(s))
    .sort((a, b) => a - b);
  sortedSeasonCache.set(boundaries, starts);
  return starts;
}

/**
 * その日が入る季節の、始まりから、次の境界の前まで。
 * seasonOf と同じ巻き込みの規則：最初の境界より前の通日は、前の年の最後の境界から続く季節。
 * 最後の季節は、次の年の最初の境界まで続く（年をまたぐ）。境界が無ければ null。
 */
function seasonSpanOf(
  day: number,
  cal: ChronicleCalendar,
): ChronicleSpan | null {
  if (!yearLengthKnown(cal)) return null;
  const starts = sortedSeasonStarts(cal.seasonBoundaries);
  if (starts.length === 0) return null;
  const date = dayNumberToDate(day, cal);
  const yearFirst = day - date.dayOfYear;
  const doy = date.dayOfYear;
  const firstStart = starts[0];
  let start: number;
  let end: number;
  if (doy < firstStart) {
    // 前の年の最後の季節が、年初まで巻き込んでいる。
    const lastStart = starts[starts.length - 1];
    start = yearFirst - daysInYear(date.year - 1, cal) + lastStart;
    end = yearFirst + firstStart;
  } else {
    let i = 0;
    while (i + 1 < starts.length && starts[i + 1] <= doy) i++;
    start = yearFirst + starts[i];
    end =
      i + 1 < starts.length
        ? yearFirst + starts[i + 1]
        : yearFirst + daysInYear(date.year, cal) + firstStart;
  }
  if (!(end > start) || day < start || day >= end) return null;
  return spanOfDays(start, end);
}

/** 有限の分は切り捨てて、無ければ 0。 */
function minuteOrZero(minute: number | null): number {
  return typeof minute === "number" && Number.isFinite(minute)
    ? Math.floor(minute)
    : 0;
}

/**
 * 日時の始まり 1 点の、粒度の幅（DR-CED-4）。日時が無ければ null。
 * 月・季節・年は、暦から求めた期間（保存された日が期間の初日でなくてよい）。
 * 暦から求められなければ、保存された日の 1 日。
 */
export function chronicleDateSpan(
  date: ChronicleDateInput,
  calendar: ChronicleCalendar | null,
): ChronicleSpan | null {
  if (!hasChronicleDate(date)) return null;
  const day = Math.floor(date.startTime as number);
  switch (date.startGranularity) {
    case "time": {
      const start = day * MINUTES_PER_DAY + minuteOrZero(date.startMinute);
      return { start, end: start + 1 };
    }
    case "month":
      return (calendar && monthSpanOf(day, calendar)) ?? daySpan(day);
    case "season":
      return (calendar && seasonSpanOf(day, calendar)) ?? daySpan(day);
    case "year":
      return (calendar && yearSpanOf(day, calendar)) ?? daySpan(day);
    default:
      // "day"。分が残っていても数えない。
      return daySpan(day);
  }
}

/**
 * 出来事の幅（K2）。開始の幅の始まりから、終わりがあれば、終わりの粒度の幅の終わりまで。
 * 終わりが無い・終わりの粒度が none／知らない文字列・終わりが開始の幅の始まり以前
 * （終わりの幅の全部が開始より前）のときは、終わりが無いものとして、開始の粒度の幅を返す。
 * 開始に日時が無ければ null（終わりだけがある出来事を含む）。
 * 「終わりが開始より前」の「開始」は、開始の幅の始まりである（DR-CED-10）。保存された開始の日ではない。
 * 月・季節・年の開始で、終わりが、その幅の中の、保存された日より前の日のときは、終わりを使う。
 */
export function eventSpan(
  row: ChronicleEventSpanRow,
  calendar: ChronicleCalendar | null,
): ChronicleSpan | null {
  const startSpan = chronicleDateSpan(row, calendar);
  if (!startSpan) return null;
  if (row.endTime == null) return startSpan;
  const endSpan = chronicleDateSpan(
    {
      startTime: row.endTime,
      startMinute: row.endMinute,
      startGranularity: row.endGranularity,
    },
    calendar,
  );
  if (!endSpan || endSpan.end <= startSpan.start) return startSpan;
  return { start: startSpan.start, end: endSpan.end };
}

/**
 * 現在地（ChronicleAnchor）の幅。場面の作中日付で決まった現在地は、その日付の粒度の幅。
 * 出来事で決まった現在地は、その出来事の開始の粒度の幅だけで、終わりは使わない（◇11、DR-CED-5）。
 * 現在地が決まらない（source が none）か、日時が無ければ null。
 */
export function anchorSpan(
  anchor: ChronicleAnchorSpanInput,
  calendar: ChronicleCalendar | null,
): ChronicleSpan | null {
  if (anchor.source === "none") return null;
  return chronicleDateSpan(anchor, calendar);
}
