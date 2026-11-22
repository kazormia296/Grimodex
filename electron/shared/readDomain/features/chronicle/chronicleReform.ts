/**
 * ユリウス暦 → グレゴリオ暦 改暦（#1）。実暦の Julian/Gregorian 変換を JDN 経由で行い、
 * 切替（cutover）前はユリウス閏（4年毎）・後はグレゴリオ閏（4/100/400）、切替で N 日スキップ
 * （例: 1582-10-04 の翌日 = 1582-10-15）を自然に表現する。日番号(=連続通日)は飛ばさず、
 * 日付ラベルだけが飛ぶ（曜日サイクルは連続）。純関数のみ・乱数/時刻/IO なし。
 *
 * 注: 改暦は現実準拠の 12ヶ月グレゴリオ暦にのみ意味を持つ（ファンタジー暦には適用しない）。
 */

/** 改暦定義。gregorianStart 以降がグレゴリオ暦、その前がユリウス暦。 */
export interface CalendarReform {
  /** 切替後の最初のグレゴリオ暦日付（monthIndex は 0 始まり）。 */
  gregorianStart: { year: number; monthIndex: number; dayOfMonth: number };
  /** プリセット識別（UI 用・任意）。 */
  region?: string;
}

const fl = Math.floor;

/** グレゴリオ暦 (year, month=1..12, day) → ユリウス通日 JDN。 */
export function gregorianToJDN(
  year: number,
  month: number,
  day: number,
): number {
  const a = fl((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return (
    day +
    fl((153 * m + 2) / 5) +
    365 * y +
    fl(y / 4) -
    fl(y / 100) +
    fl(y / 400) -
    32045
  );
}

/** ユリウス暦 (year, month=1..12, day) → ユリウス通日 JDN。 */
export function julianToJDN(year: number, month: number, day: number): number {
  const a = fl((14 - month) / 12);
  const y = year + 4800 - a;
  const m = month + 12 * a - 3;
  return day + fl((153 * m + 2) / 5) + 365 * y + fl(y / 4) - 32083;
}

/** JDN → グレゴリオ暦 (year, month=1..12, day)。 */
export function jdnToGregorian(jdn: number): {
  year: number;
  month: number;
  day: number;
} {
  const a = jdn + 32044;
  const b = fl((4 * a + 3) / 146097);
  const c = a - fl((146097 * b) / 4);
  const d = fl((4 * c + 3) / 1461);
  const e = c - fl((1461 * d) / 4);
  const m = fl((5 * e + 2) / 153);
  return {
    day: e - fl((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * fl(m / 10),
    year: 100 * b + d - 4800 + fl(m / 10),
  };
}

/** JDN → ユリウス暦 (year, month=1..12, day)。 */
export function jdnToJulian(jdn: number): {
  year: number;
  month: number;
  day: number;
} {
  const c = jdn + 32082;
  const d = fl((4 * c + 3) / 1461);
  const e = c - fl((1461 * d) / 4);
  const m = fl((5 * e + 2) / 153);
  return {
    day: e - fl((153 * m + 2) / 5) + 1,
    month: m + 3 - 12 * fl(m / 10),
    year: d - 4800 + fl(m / 10),
  };
}

/** 切替先頭グレゴリオ日付の JDN（これ以上 = グレゴリオ）。 */
export function cutoverJDN(reform: CalendarReform): number {
  const g = reform.gregorianStart;
  return gregorianToJDN(g.year, g.monthIndex + 1, g.dayOfMonth);
}

/** day番号0 = (startYear, 1月, 1日) の JDN（その日が切替前ならユリウス, 後ならグレゴリオ）。 */
export function reformJDN0(startYear: number, reform: CalendarReform): number {
  const j = julianToJDN(startYear, 1, 1);
  return j >= cutoverJDN(reform) ? gregorianToJDN(startYear, 1, 1) : j;
}

/** (year, monthIndex, dayOfMonth) が切替後（グレゴリオ）か。日付の辞書順比較。 */
function isAfterCutover(
  year: number,
  monthIndex: number,
  dayOfMonth: number,
  reform: CalendarReform,
): boolean {
  const g = reform.gregorianStart;
  if (year !== g.year) return year > g.year;
  if (monthIndex !== g.monthIndex) return monthIndex > g.monthIndex;
  return dayOfMonth >= g.dayOfMonth;
}

/** 改暦暦の day番号 → {year, monthIndex(0始まり), dayOfMonth}。 */
export function reformDayToDate(
  day: number,
  startYear: number,
  reform: CalendarReform,
): { year: number; monthIndex: number; dayOfMonth: number } {
  const jdn = Math.floor(day) + reformJDN0(startYear, reform);
  const dt = jdn >= cutoverJDN(reform) ? jdnToGregorian(jdn) : jdnToJulian(jdn);
  return { year: dt.year, monthIndex: dt.month - 1, dayOfMonth: dt.day };
}

/** 改暦暦の {year, monthIndex, dayOfMonth} → day番号。 */
export function reformDateToDay(
  year: number,
  monthIndex: number,
  dayOfMonth: number,
  startYear: number,
  reform: CalendarReform,
): number {
  const after = isAfterCutover(year, monthIndex, dayOfMonth, reform);
  const jdn = after
    ? gregorianToJDN(year, monthIndex + 1, dayOfMonth)
    : julianToJDN(year, monthIndex + 1, dayOfMonth);
  return jdn - reformJDN0(startYear, reform);
}

/** 改暦暦の (year, monthIndex) の月日数（切替月は短縮、12ヶ月固定）。 */
export function reformMonthLength(
  year: number,
  monthIndex: number,
  reform: CalendarReform,
): number {
  const ny = monthIndex >= 11 ? year + 1 : year;
  const nm = monthIndex >= 11 ? 0 : monthIndex + 1;
  // 月初どうしの JDN 差（startYear 不問＝差分なので相殺）。
  return (
    reformDateToDay(ny, nm, 1, 0, reform) -
    reformDateToDay(year, monthIndex, 1, 0, reform)
  );
}

/** 改暦暦の暦年 year の総日数（切替年は短縮）。 */
export function reformDaysInYear(year: number, reform: CalendarReform): number {
  return (
    reformDateToDay(year + 1, 0, 1, 0, reform) -
    reformDateToDay(year, 0, 1, 0, reform)
  );
}

/** 改暦のプリセット（国別の切替日）。 */
export const REFORM_PRESETS: Record<string, CalendarReform> = {
  // ローマ・カトリック圏: 1582-10-04(ユリウス) → 1582-10-15(グレゴリオ)。10日飛ばし。
  gregorian1582: {
    gregorianStart: { year: 1582, monthIndex: 9, dayOfMonth: 15 },
    region: "gregorian1582",
  },
  // イギリス（および植民地）: 1752-09-02 → 1752-09-14。11日飛ばし。
  britain1752: {
    gregorianStart: { year: 1752, monthIndex: 8, dayOfMonth: 14 },
    region: "britain1752",
  },
  // ロシア: 1918-01-31 → 1918-02-14。13日飛ばし。
  russia1918: {
    gregorianStart: { year: 1918, monthIndex: 1, dayOfMonth: 14 },
    region: "russia1918",
  },
};
