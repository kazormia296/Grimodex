import { generateKeyBetween, cmpKeys } from "@/features/tree/fractionalIndex";

export interface SeasonBoundary {
  /** 季節名（例「冬」）。 */
  name: string;
  /** その季節が始まる年内通日（0-based, 0..daysPerYear-1）。 */
  startDayOfYear: number;
}

export interface ChronicleCalendar {
  /** 1年の日数（作中暦。グレゴリオなら 365）。 */
  daysPerYear: number;
  /** 季節境界。startDayOfYear 昇順の循環区間として解釈する。 */
  seasonBoundaries: SeasonBoundary[];
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
 * 既存の ordinal 群の「最後」に挿す新しい fractional-index を返す。
 * storyTimeOrder と同 idiom（base62・cmpKeys 辞書順）。
 */
export function nextEventOrdinal(existing: string[]): string {
  if (existing.length === 0) return generateKeyBetween(null, null);
  let max = existing[0];
  for (const k of existing) if (cmpKeys(k, max) > 0) max = k;
  return generateKeyBetween(max, null);
}
