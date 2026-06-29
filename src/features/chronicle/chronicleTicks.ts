import {
  calendarDaysPerYear,
  dayNumberToDate,
  type ChronicleCalendar,
  type ChronicleDate,
  type DateLang,
} from "./chronicleTime";

/** ルーラー上の 1 目盛り（x=トラック左端からの px、label=表示文字列）。 */
export interface Tick {
  x: number;
  label: string;
}

/**
 * 適応的ルーラーの目盛り集合。
 * minor=細かい目盛り、major=より粗いグリッド線、unitLabel=刻み幅の説明、
 * level=採用した刻みの粒度名（"year"|"month"|"day"|"hour"|"minute"|"order"）。
 */
export interface RulerTicks {
  minor: Tick[];
  major: Tick[];
  unitLabel: string;
  level: string;
}

interface Step {
  d: number;
  level: string;
}

const MAJOR_UNIT_OF: Record<string, "day" | "month" | "year" | null> = {
  minute: "day",
  hour: "day",
  day: "month",
  month: "year",
  year: null,
};

/**
 * day 番号タイムラインに対する暦対応の適応的ルーラー目盛りを計算する。
 * 画面上の間隔が minTickPx 以上を保てる最も細かい "nice" な日数刻みを選び、
 * 各目盛りをプロジェクト暦で解決してラベル付けし、より粗い major グリッド線も出す。
 * 実暦軸が無い場合は並び順（order）ルーラーへフォールバックする。
 * 決定性: 乱数/時刻/IO なし、純関数。
 */
export function adaptiveTicks(args: {
  pxPerDay: number;
  viewStartDay: number;
  trackW: number;
  calendar: ChronicleCalendar;
  hasCalendarAxis: boolean;
  lang?: DateLang;
  minTickPx?: number;
}): RulerTicks {
  const {
    pxPerDay,
    viewStartDay,
    trackW,
    calendar,
    hasCalendarAxis,
    lang,
    minTickPx,
  } = args;
  const MIN = minTickPx ?? 82;
  const ja = (lang ?? "ja") === "ja";

  // --- SEQUENCE MODE（暦軸なし） ---
  if (!hasCalendarAxis) {
    const minor: Tick[] = [];
    const stride = Math.max(1, Math.ceil(MIN / Math.max(pxPerDay, 1e-9)));
    const ve = viewStartDay + trackW / pxPerDay;
    for (let d = Math.ceil(viewStartDay); d <= ve; d += stride) {
      const x = (d - viewStartDay) * pxPerDay;
      if (x >= -2 && x <= trackW + 2) {
        minor.push({ x, label: `#${Math.round(d) + 1}` });
      }
    }
    return {
      minor,
      major: [],
      unitLabel: ja ? "並び順" : "order",
      level: "order",
    };
  }

  // --- CALENDAR MODE ---
  const dpy = calendarDaysPerYear(calendar);
  const weekLen = calendar.weekdayNames?.length || 7;
  const monthCount = calendar.months?.length || 12;
  const monthDays = dpy / monthCount;

  const STEPS: Step[] = [
    { d: 10 * dpy, level: "year" },
    { d: 5 * dpy, level: "year" },
    { d: 2 * dpy, level: "year" },
    { d: dpy, level: "year" },
    { d: 4 * monthDays, level: "month" },
    { d: monthDays, level: "month" },
    { d: weekLen, level: "day" },
    { d: 2, level: "day" },
    { d: 1, level: "day" },
    { d: 0.5, level: "hour" },
    { d: 0.25, level: "hour" },
    { d: 1 / 12, level: "hour" },
    { d: 1 / 24, level: "hour" },
    { d: 30 / 1440, level: "minute" },
    { d: 15 / 1440, level: "minute" },
    { d: 10 / 1440, level: "minute" },
    { d: 5 / 1440, level: "minute" },
    { d: 2 / 1440, level: "minute" },
    { d: 1 / 1440, level: "minute" },
  ];

  const ve = viewStartDay + trackW / pxPerDay;
  const needMin = MIN / pxPerDay;

  // 最も細かい "nice" 刻みで、画面間隔が MIN 以上を保てるものを選ぶ。
  let step: Step = STEPS[0];
  for (let i = STEPS.length - 1; i >= 0; i--) {
    if (STEPS[i].d >= needMin) {
      step = STEPS[i];
      break;
    }
  }
  const stepDays = step.d;

  // --- ローカルラベルヘルパー（calendar/ja をクロージャで参照） ---
  const monthName = (date: ChronicleDate): string => {
    if (date.monthIndex != null && calendar.months?.[date.monthIndex]) {
      return calendar.months[date.monthIndex].name;
    }
    if (date.monthIndex != null) {
      return ja ? `${date.monthIndex + 1}月` : String(date.monthIndex + 1);
    }
    return "";
  };

  const minutesOfDay = (d: number): number => {
    const frac = d - Math.floor(d);
    const x = Math.round(frac * 1440);
    return ((x % 1440) + 1440) % 1440;
  };

  const pad2 = (n: number): string => (n < 10 ? `0${n}` : `${n}`);

  const tickLabel = (d: number, level: string): string => {
    const date = dayNumberToDate(d, calendar);
    switch (level) {
      case "year":
        return ja ? `${date.year}年` : `Y${date.year}`;
      case "month":
        return monthName(date);
      case "day": {
        const dd = date.dayOfMonth ?? date.dayOfYear + 1;
        return ja ? `${dd}日` : String(dd);
      }
      case "hour": {
        const m = minutesOfDay(d);
        return `${Math.floor(m / 60)}:00`;
      }
      case "minute": {
        const m = minutesOfDay(d);
        return `${Math.floor(m / 60)}:${pad2(m % 60)}`;
      }
      default:
        return "";
    }
  };

  const majorLabel = (d: number, unit: "day" | "month" | "year"): string => {
    const date = dayNumberToDate(d, calendar);
    switch (unit) {
      case "year":
        return ja ? `${date.year}年` : `Y${date.year}`;
      case "month":
        return ja
          ? `${date.year}年${monthName(date)}`
          : `${monthName(date)} ${date.year}`;
      case "day": {
        const dd = date.dayOfMonth ?? date.dayOfYear + 1;
        return ja
          ? `${date.year}年${monthName(date)}${dd}日`
          : `${monthName(date)} ${dd}, ${date.year}`;
      }
    }
  };

  // --- minor ---
  const minor: Tick[] = [];
  const first = Math.ceil(viewStartDay / stepDays - 1e-9) * stepDays;
  const n = Math.floor((ve - first) / stepDays) + 2;
  for (let i = 0; i <= n; i++) {
    const d = first + i * stepDays;
    const x = (d - viewStartDay) * pxPerDay;
    if (x < -2 || x > trackW + 2) continue;
    minor.push({ x, label: tickLabel(d, step.level) });
  }

  // --- major ---
  const major: Tick[] = [];
  const majorUnit = MAJOR_UNIT_OF[step.level] ?? null;
  if (majorUnit) {
    const mStep =
      majorUnit === "year" ? dpy : majorUnit === "month" ? monthDays : 1;
    const mFirst = Math.floor(viewStartDay / mStep) * mStep;
    for (let d = mFirst; d <= ve + mStep; d += mStep) {
      const x = (d - viewStartDay) * pxPerDay;
      if (x > trackW + 2) break;
      major.push({ x, label: majorLabel(d, majorUnit) });
    }
  }

  // --- unitLabel ---
  let unitLabel = "";
  switch (step.level) {
    case "year":
      unitLabel = ja ? `${step.d / dpy}年ごと` : `every ${step.d / dpy}y`;
      break;
    case "month":
      unitLabel = ja
        ? `${Math.round(step.d / monthDays)}ヶ月ごと`
        : `every ${Math.round(step.d / monthDays)}mo`;
      break;
    case "day":
      unitLabel = ja
        ? step.d === weekLen
          ? "1週間ごと"
          : `${step.d}日ごと`
        : step.d === weekLen
          ? "weekly"
          : `every ${step.d}d`;
      break;
    case "hour":
      unitLabel = ja
        ? `${Math.round(step.d * 24)}時間ごと`
        : `every ${Math.round(step.d * 24)}h`;
      break;
    case "minute":
      unitLabel = ja
        ? `${Math.round(step.d * 1440)}分ごと`
        : `every ${Math.round(step.d * 1440)}m`;
      break;
  }

  return { minor, major, unitLabel, level: step.level };
}
