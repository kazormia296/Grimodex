import { Solar } from "lunar-typescript";
import { dayNumberToDate, type ChronicleCalendar } from "./chronicleTime";
import { jdnToGregorian, reformJDN0 } from "./chronicleReform";

/**
 * 旧暦・六曜・二十四節気（#4）。lunar-typescript（中国農暦ベース）で算出し、返るラベルを
 * 日本表記へ置換する。注意: 新月/節気の判定は UTC+8 で行われるため、朔が深夜にかかる境界日
 * などで日本の旧暦・六曜とは年に数回ずれることがある（UI で注記する）。
 * 実暦12ヶ月暦（グレゴリオ閏 or 改暦）にのみ意味を持ち、ファンタジー暦では null を返す。
 */

/** 六曜: lunar-typescript（中国字体）→ 日本表記。 */
const ROKUYO_JP: Record<string, string> = {
  先胜: "先勝",
  友引: "友引",
  先负: "先負",
  佛灭: "仏滅",
  大安: "大安",
  赤口: "赤口",
};

/** 二十四節気: 中国字体 → 日本表記（差分のみ。一致するものは素通し）。 */
const JIEQI_JP: Record<string, string> = {
  惊蛰: "啓蟄",
  谷雨: "穀雨",
  小满: "小満",
  芒种: "芒種",
  处暑: "処暑",
};

export interface LunarInfo {
  /** 旧暦月（1..12）。 */
  month: number;
  /** 閏月か。 */
  isLeapMonth: boolean;
  /** 旧暦日（1..30）。 */
  day: number;
  /** 六曜（日本表記）。 */
  rokuyo: string;
  /** その日が二十四節気なら日本表記の節気名、なければ null。 */
  solarTerm: string | null;
}

/**
 * 作中日の「実暦（先発グレゴリオ）」年月日。改暦時は JDN から、非改暦の実暦12ヶ月暦は
 * そのまま。ファンタジー暦（実暦でない）は null。
 */
function gregorianYmd(
  day: number,
  cal: ChronicleCalendar,
): { y: number; m: number; d: number } | null {
  if (cal.reform) {
    const g = jdnToGregorian(
      Math.floor(day) + reformJDN0(cal.startYear ?? 0, cal.reform),
    );
    return { y: g.year, m: g.month, d: g.day };
  }
  if (cal.leap?.kind === "gregorian" && (cal.months?.length ?? 0) === 12) {
    const dt = dayNumberToDate(day, cal);
    if (dt.monthIndex == null || dt.dayOfMonth == null) return null;
    return { y: dt.year, m: dt.monthIndex + 1, d: dt.dayOfMonth };
  }
  return null;
}

/**
 * 作中日 → 旧暦/六曜/節気。実暦12ヶ月暦でない、または変換不能（範囲外）なら null。
 * 決定性: 入力日付に対し一意（乱数/現在時刻なし）。
 */
export function lunarInfoForDay(
  day: number,
  cal: ChronicleCalendar,
): LunarInfo | null {
  const g = gregorianYmd(day, cal);
  if (!g) return null;
  try {
    const lunar = Solar.fromYmd(g.y, g.m, g.d).getLunar();
    const lm = lunar.getMonth(); // 閏月は負
    const term = lunar.getJieQi();
    const liuyao = lunar.getLiuYao();
    return {
      month: Math.abs(lm),
      isLeapMonth: lm < 0,
      day: lunar.getDay(),
      rokuyo: ROKUYO_JP[liuyao] ?? liuyao,
      solarTerm: term ? (JIEQI_JP[term] ?? term) : null,
    };
  } catch {
    return null;
  }
}
