import { generateKeyBetween, cmpKeys } from "@/features/tree/fractionalIndex";

export interface SeasonBoundary {
  /** 季節名（例「冬」）。 */
  name: string;
  /** その季節が始まる年内通日（0-based, 0..daysPerYear-1）。 */
  startDayOfYear: number;
}

/** 暦の月定義（名前＋日数）。 */
export interface MonthDef {
  name: string;
  /** その月の日数（正整数）。 */
  days: number;
}

/**
 * 閏年ルール。none=年長一定（既定）。gregorian=暦年（startYear 基準の絶対年）に
 * 対し 4/100/400 で閏判定し、monthIndex の月へ +1 日（既定は 2 月相当 index 1）。
 */
export type LeapRule =
  | { kind: "none" }
  | { kind: "gregorian"; monthIndex: number };

/** 年齢の数え方。full=満年齢（既定）。counting=数え年（暦年差+1）。 */
export type AgeReckoning = "full" | "counting";

export interface ChronicleCalendar {
  /**
   * 1年の「基準」日数（作中暦。グレゴリオなら 365）。閏年でも本値は基準のまま
   * （閏日は daysInYear で加算）。months がある場合は月長合計が正本
   * （calendarDaysPerYear で導出）で、この stored 値は months 未定義時のフォールバック。
   */
  daysPerYear: number;
  /** 季節境界。startDayOfYear 昇順の循環区間として解釈する。 */
  seasonBoundaries: SeasonBoundary[];
  /** 暦の開始年ラベル。day番号 0 = startYear の最初の月の1日。未指定=0。 */
  startYear?: number;
  /** 月定義。空/未指定なら月概念なし（年内通日のみ扱う）。 */
  months?: MonthDef[];
  /** 曜日名。空/未指定なら曜日概念なし。週長=配列長。 */
  weekdayNames?: string[];
  /** 閏年ルール。未指定=none（年長一定）。 */
  leap?: LeapRule;
  /** 年齢の数え方。未指定=full（満年齢）。 */
  ageReckoning?: AgeReckoning;
}

/** day番号から導出した作中日付の構成要素。 */
export interface ChronicleDate {
  /** 暦上の年（startYear 基準）。 */
  year: number;
  /** 月インデックス(0-based)。月未定義なら null。 */
  monthIndex: number | null;
  /** 月内日(1-based)。月未定義なら null。 */
  dayOfMonth: number | null;
  /** 年内通日(0-based)。 */
  dayOfYear: number;
  /** 曜日インデックス(0-based)。曜日未定義なら null。 */
  weekdayIndex: number | null;
}

/** 表示ロケール（日付整形用）。 */
export type DateLang = "ja" | "en";

const MINUTES_PER_DAY = 24 * 60;

/** 正の剰余（負の被除数でも 0..b-1 を返す）。 */
function mod(a: number, b: number): number {
  return ((a % b) + b) % b;
}

/** 暦の実効「基準1年の日数」。months があれば月長合計、無ければ stored daysPerYear（閏日は含まない）。 */
export function calendarDaysPerYear(cal: ChronicleCalendar): number {
  if (cal.months && cal.months.length > 0) {
    const sum = cal.months.reduce(
      (acc, m) => acc + Math.max(1, Math.floor(m.days)),
      0,
    );
    if (sum > 0) return sum;
  }
  return cal.daysPerYear;
}

/** グレゴリオ閏年判定（暦年 year に対する 4/100/400 ルール）。 */
function isGregorianLeap(year: number): boolean {
  const y = Math.floor(year);
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}

/** 暦年 year が閏年か（leap ルール非グレゴリオなら常に false）。 */
export function isLeapYear(year: number, cal: ChronicleCalendar): boolean {
  return cal.leap?.kind === "gregorian" && isGregorianLeap(year);
}

/** 暦年 year の総日数（基準＋閏日）。 */
export function daysInYear(year: number, cal: ChronicleCalendar): number {
  return calendarDaysPerYear(cal) + (isLeapYear(year, cal) ? 1 : 0);
}

/** 暦年 year・monthIndex の月の日数（閏月なら +1）。月未定義なら 0。 */
export function monthLength(
  year: number,
  monthIndex: number,
  cal: ChronicleCalendar,
): number {
  const m = cal.months?.[monthIndex];
  if (!m) return 0;
  const base = Math.max(1, Math.floor(m.days));
  const leap = cal.leap;
  if (
    leap?.kind === "gregorian" &&
    monthIndex === leap.monthIndex &&
    isLeapYear(year, cal)
  ) {
    return base + 1;
  }
  return base;
}

/** 半開区間 [lo, hi) 内で m の倍数の個数（負数対応・floor 一貫）。 */
function divisibleCount(lo: number, hi: number, m: number): number {
  if (hi <= lo) return 0;
  return Math.floor((hi - 1) / m) - Math.floor((lo - 1) / m);
}

/** 半開区間 [lo, hi) 内のグレゴリオ閏年数。 */
function gregLeapsIn(lo: number, hi: number): number {
  return (
    divisibleCount(lo, hi, 4) -
    divisibleCount(lo, hi, 100) +
    divisibleCount(lo, hi, 400)
  );
}

/**
 * 暦年 year の「年内通日 0」が載る day 番号（startYear の年初=day0 基準）。
 * 閏なしは線形。グレゴリオは基準年長×年差＋区間内閏日数で O(1) 算出。
 */
function yearStartDay(year: number, cal: ChronicleCalendar): number {
  const startYear = cal.startYear ?? 0;
  const base = calendarDaysPerYear(cal);
  const y = Math.floor(year);
  let extra = 0;
  if (cal.leap?.kind === "gregorian") {
    extra =
      y >= startYear ? gregLeapsIn(startYear, y) : -gregLeapsIn(y, startYear);
  }
  return (y - startYear) * base + extra;
}

/** day番号 → 曜日インデックス。weekdayNames 未定義なら null。 */
export function weekdayOf(
  dayNumber: number,
  cal: ChronicleCalendar,
): number | null {
  const wl = cal.weekdayNames?.length ?? 0;
  if (wl <= 0) return null;
  return mod(Math.floor(dayNumber), wl);
}

/**
 * day番号（紀元からの通日）→ 作中日付の構成要素。
 * day 0 = startYear の最初の月の1日。負の day も floor 除算で前年へ循環。
 * 決定性: 乱数/時刻なし。
 */
export function dayNumberToDate(
  dayNumber: number,
  cal: ChronicleCalendar,
): ChronicleDate {
  const d = Math.floor(dayNumber);
  const dpy = calendarDaysPerYear(cal);
  const startYear = cal.startYear ?? 0;
  const weekdayIndex = weekdayOf(d, cal);
  if (dpy <= 0) {
    return {
      year: startYear,
      monthIndex: null,
      dayOfMonth: null,
      dayOfYear: 0,
      weekdayIndex,
    };
  }
  let year: number;
  let dayOfYear: number;
  if (cal.leap?.kind === "gregorian") {
    // 平均年長より基準年長は短いので推定 year は真値以上。while で前後補正（数回）。
    year = startYear + Math.floor(d / dpy);
    while (yearStartDay(year, cal) > d) year--;
    while (yearStartDay(year + 1, cal) <= d) year++;
    dayOfYear = d - yearStartDay(year, cal);
  } else {
    year = startYear + Math.floor(d / dpy);
    dayOfYear = mod(d, dpy);
  }
  let monthIndex: number | null = null;
  let dayOfMonth: number | null = null;
  if (cal.months && cal.months.length > 0) {
    let rem = dayOfYear;
    for (let i = 0; i < cal.months.length; i++) {
      const len = monthLength(year, i, cal);
      if (rem < len) {
        monthIndex = i;
        dayOfMonth = rem + 1;
        break;
      }
      rem -= len;
    }
    // months 合計 < dayOfYear（stored daysPerYear が月長合計を超える場合の防御）。
    if (monthIndex === null) {
      monthIndex = cal.months.length - 1;
      dayOfMonth = monthLength(year, monthIndex, cal);
    }
  }
  return { year, monthIndex, dayOfMonth, dayOfYear, weekdayIndex };
}

/**
 * 作中日付 → day番号。dayNumberToDate の逆。
 * monthIndex/dayOfMonth が無い（年だけ・年月だけ）場合は当該期間の先頭日を返す。
 */
export function dateToDayNumber(
  date: {
    year: number;
    monthIndex?: number | null;
    dayOfMonth?: number | null;
  },
  cal: ChronicleCalendar,
): number {
  // yearStartDay は閏なしなら (year-startYear)*dpy と一致（従来挙動を保存）。
  const base = yearStartDay(date.year, cal);
  let dayOfYear = 0;
  if (cal.months && cal.months.length > 0 && date.monthIndex != null) {
    const mi = Math.max(0, Math.min(cal.months.length - 1, date.monthIndex));
    for (let i = 0; i < mi; i++) {
      dayOfYear += monthLength(date.year, i, cal);
    }
    dayOfYear += Math.max(0, (date.dayOfMonth ?? 1) - 1);
  } else if (date.dayOfMonth != null) {
    dayOfYear = Math.max(0, date.dayOfMonth - 1);
  }
  return base + dayOfYear;
}

/** 分(0..1439) → "HH:MM"（24h・ゼロ詰め）。null は null。 */
export function formatTimeOfDay(minute: number | null): string | null {
  if (minute == null) return null;
  const m = mod(Math.floor(minute), MINUTES_PER_DAY);
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  const p2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
  return `${p2(hh)}:${p2(mm)}`;
}

/**
 * day番号＋分＋粒度 → 表示文字列。粒度に応じて段階的に省略する。
 * none/null は空文字。season は seasonOf を用いる。time は HH:MM を付す。
 */
export function formatChronicleDate(
  dayNumber: number | null,
  minute: number | null,
  granularity: string,
  cal: ChronicleCalendar,
  lang: DateLang = "ja",
): string {
  if (granularity === "none" || dayNumber == null) return "";
  const ja = lang === "ja";
  const date = dayNumberToDate(dayNumber, cal);
  const monthName =
    date.monthIndex != null && cal.months?.[date.monthIndex]
      ? cal.months[date.monthIndex].name
      : date.monthIndex != null
        ? `${date.monthIndex + 1}`
        : null;

  if (granularity === "year")
    return ja ? `${date.year}年` : `Year ${date.year}`;
  if (granularity === "season") {
    const s = seasonOf(dayNumber, cal) ?? "?";
    return ja ? `${date.year}年・${s}` : `${s} ${date.year}`;
  }
  if (granularity === "month") {
    return ja
      ? `${date.year}年${monthName ?? ""}`
      : `${monthName ?? ""} ${date.year}`.trim();
  }

  // day / time
  const dayPart =
    date.dayOfMonth != null
      ? ja
        ? `${date.dayOfMonth}日`
        : `${date.dayOfMonth}`
      : ja
        ? `第${date.dayOfYear + 1}日`
        : `${date.dayOfYear + 1}`;
  const dayStr = ja
    ? `${date.year}年${monthName ?? ""}${dayPart}`
    : `${monthName ?? ""} ${dayPart}, ${date.year}`.trim();
  if (granularity === "time") {
    const tod = formatTimeOfDay(minute);
    return tod ? `${dayStr} ${tod}` : dayStr;
  }
  return dayStr;
}

/** 既定の 360日・春夏秋冬 4季暦（新規作成/エディタの初期値）。 */
export const DEFAULT_SEASON_BOUNDARIES: SeasonBoundary[] = [
  { name: "春", startDayOfYear: 0 },
  { name: "夏", startDayOfYear: 90 },
  { name: "秋", startDayOfYear: 180 },
  { name: "冬", startDayOfYear: 270 },
];

/**
 * 数値時刻（紀元からの日数）→ その日の作中季節名。
 * 境界は startDayOfYear 昇順に並べた循環区間。最初の境界より前の通日は
 * 「最後の季節が年末から巻き込んでいる」とみなして最後の境界へ巻き戻す。
 * 決定性: 乱数/時刻なし。
 */
export function seasonOf(
  time: number,
  calendar: ChronicleCalendar,
): string | null {
  const { daysPerYear, seasonBoundaries } = calendar;
  if (daysPerYear <= 0 || seasonBoundaries.length === 0) return null;
  const dayOfYear =
    ((Math.floor(time) % daysPerYear) + daysPerYear) % daysPerYear;
  const sorted = [...seasonBoundaries].sort(
    (a, b) => a.startDayOfYear - b.startDayOfYear,
  );
  let current = sorted[sorted.length - 1]; // 巻き戻し既定値（年末→年初の循環）
  for (const b of sorted) {
    if (dayOfYear >= b.startDayOfYear) current = b;
    else break;
  }
  return current.name;
}

/**
 * 出生日→出来事日の年齢。reckoning 既定は cal.ageReckoning（未指定=満年齢）。
 * full=満年齢（誕生日の記念日を過ぎた回数）。counting=数え年（暦年差+1）。
 * 出生前（負）はそのまま負を返す（呼び元で対象外判定）。決定性: 純関数。
 */
export function computeAge(
  birthDay: number,
  eventDay: number,
  cal: ChronicleCalendar,
  reckoning: AgeReckoning = cal.ageReckoning ?? "full",
): number {
  const b = dayNumberToDate(birthDay, cal);
  const e = dayNumberToDate(eventDay, cal);
  if (reckoning === "counting") return e.year - b.year + 1;
  let age = e.year - b.year;
  const beforeAnniversary =
    e.monthIndex != null && b.monthIndex != null
      ? e.monthIndex < b.monthIndex ||
        (e.monthIndex === b.monthIndex &&
          (e.dayOfMonth ?? 0) < (b.dayOfMonth ?? 0))
      : e.dayOfYear < b.dayOfYear;
  if (beforeAnniversary) age -= 1;
  return age;
}

/** 現実準拠グレゴリオ暦の月長（1〜12月、2月は平年28）。閏は GREGORIAN_LEAP が +1。 */
export const GREGORIAN_MONTH_DAYS: readonly number[] = [
  31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
];
/** グレゴリオ閏ルール（2月=index 1 に +1 日）。 */
export const GREGORIAN_LEAP: LeapRule = { kind: "gregorian", monthIndex: 1 };

/**
 * 既存の ordinal 群の「最後」に挿す新しい fractional-index を返す。
 * storyTimeOrder と同 idiom（base62・cmpKeys 辞書順）。
 */
export function nextEventOrdinal(existing: string[]): string {
  if (existing.length === 0) return generateKeyBetween(null, null);
  let max = existing[0];
  for (const k of existing) if (cmpKeys(k, max) > 0) max = k;
  return generateKeyBetween(max, null);
}
