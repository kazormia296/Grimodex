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

/**
 * getJieQiTable のキーは大半が中国字体だが、年境界（冬至/春先）の項のみ pinyin enum
 * （DA_XUE 等）になる。これらを中国字体へ正規化する（実測で現れる7種のみで十分）。
 */
const JIEQI_PINYIN_CN: Record<string, string> = {
  DA_XUE: "大雪",
  DONG_ZHI: "冬至",
  XIAO_HAN: "小寒",
  DA_HAN: "大寒",
  LI_CHUN: "立春",
  YU_SHUI: "雨水",
  JING_ZHE: "惊蛰",
};

/** 中国農暦の既定 UTC オフセット分（UTC+8）。 */
const CHINA_TZ_MIN = 480;

/**
 * lunarTzMinutes（UTC オフセット）で節気を再ビンし、その日の節気名（中国字体）を返す。
 * lunar-typescript の節気は瞬間(時刻付き, UTC+8)で公開されるので、JD を (offset-480) 分
 * シフトして対象タイムゾーンの civil 日付に割り当て直す。該当なしは null。
 */
function solarTermRebinned(
  solar: ReturnType<typeof Solar.fromYmd>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lunar: any,
  tzMinutes: number,
): string | null {
  const shiftDays = (tzMinutes - CHINA_TZ_MIN) / 1440;
  const table = lunar.getJieQiTable() as Record<
    string,
    ReturnType<typeof Solar.fromYmd>
  >;
  for (const key of Object.keys(table)) {
    const d = Solar.fromJulianDay(table[key].getJulianDay() + shiftDays);
    if (
      d.getYear() === solar.getYear() &&
      d.getMonth() === solar.getMonth() &&
      d.getDay() === solar.getDay()
    ) {
      return JIEQI_PINYIN_CN[key] ?? key;
    }
  }
  return null;
}

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
    const solar = Solar.fromYmd(g.y, g.m, g.d);
    const lunar = solar.getLunar();
    const lm = lunar.getMonth(); // 閏月は負
    const liuyao = lunar.getLiuYao();
    // 節気は lunarTzMinutes で再ビン（既定=中国農暦 UTC+8）。旧暦月日・六曜は中国農暦のまま。
    const tz = cal.lunarTzMinutes ?? CHINA_TZ_MIN;
    const termCn =
      tz === CHINA_TZ_MIN
        ? lunar.getJieQi() || null
        : solarTermRebinned(solar, lunar, tz);
    return {
      month: Math.abs(lm),
      isLeapMonth: lm < 0,
      day: lunar.getDay(),
      rokuyo: ROKUYO_JP[liuyao] ?? liuyao,
      solarTerm: termCn ? (JIEQI_JP[termCn] ?? termCn) : null,
    };
  } catch {
    return null;
  }
}
