import {
  calendarDaysPerYear,
  dayNumberToDate,
  dateToDayNumber,
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
  // 退行データ防御: dpy<=0 だと年/月ステップが 0 になり everyN=NaN で目盛り生成が
  // 無限ループ（render を凍結）する。他の暦関数と同様に空目盛りへフォールバック。
  if (!(dpy > 0)) {
    return {
      minor: [],
      major: [],
      unitLabel: ja ? "作中時間" : "time",
      level: "year",
    };
  }
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

  const hasMonths = (calendar.months?.length ?? 0) > 0;
  const inX = (d: number): number => (d - viewStartDay) * pxPerDay;
  const startYearAt = (off = 0): number =>
    dayNumberToDate(Math.floor(viewStartDay), calendar).year + off;

  // --- minor（年/月は実暦境界で生成。均等 monthDays は非均等月/閏でずれるため。
  //      日/時/分は固定ステップ） ---
  const minor: Tick[] = [];
  if (step.level === "year") {
    const everyN = Math.max(1, Math.round(stepDays / dpy));
    let y = Math.floor(startYearAt() / everyN) * everyN - everyN;
    for (; ; y += everyN) {
      const d = dateToDayNumber({ year: y }, calendar);
      const x = inX(d);
      if (x > trackW + 2) break;
      if (x >= -2) minor.push({ x, label: tickLabel(d, "year") });
    }
  } else if (step.level === "month" && hasMonths) {
    const everyN = Math.max(1, Math.round(stepDays / monthDays));
    let done = false;
    for (let y = startYearAt(-1); !done; y++) {
      for (let mi = 0; mi < monthCount; mi += everyN) {
        const d = dateToDayNumber(
          { year: y, monthIndex: mi, dayOfMonth: 1 },
          calendar,
        );
        const x = inX(d);
        if (x > trackW + 2) {
          done = true;
          break;
        }
        if (x >= -2) minor.push({ x, label: tickLabel(d, "month") });
      }
    }
  } else {
    // day/hour/minute、または月概念なし暦の month: 固定日ステップ。
    const first = Math.ceil(viewStartDay / stepDays - 1e-9) * stepDays;
    const n = Math.floor((ve - first) / stepDays) + 2;
    for (let i = 0; i <= n; i++) {
      const d = first + i * stepDays;
      const x = inX(d);
      if (x < -2 || x > trackW + 2) continue;
      minor.push({ x, label: tickLabel(d, step.level) });
    }
  }

  // --- major（実暦境界。月 major は年重複を避け 1 月（先頭月）にのみ年を前置） ---
  const major: Tick[] = [];
  const majorUnit = MAJOR_UNIT_OF[step.level] ?? null;
  const pushYearMajor = () => {
    for (let y = startYearAt(-1); ; y++) {
      const d = dateToDayNumber({ year: y }, calendar);
      const x = inX(d);
      if (x > trackW + 2) break;
      if (x >= -2) major.push({ x, label: majorLabel(d, "year") });
    }
  };
  if (majorUnit === "year") {
    pushYearMajor();
  } else if (majorUnit === "month" && hasMonths) {
    let done = false;
    for (let y = startYearAt(-1); !done; y++) {
      for (let mi = 0; mi < monthCount; mi++) {
        const d = dateToDayNumber(
          { year: y, monthIndex: mi, dayOfMonth: 1 },
          calendar,
        );
        const x = inX(d);
        if (x > trackW + 2) {
          done = true;
          break;
        }
        if (x < -2) continue;
        const label =
          mi === 0
            ? majorLabel(d, "month")
            : monthName(dayNumberToDate(d, calendar));
        major.push({ x, label });
      }
    }
  } else if (majorUnit === "month") {
    // 月概念なし暦: 年境界を major に。
    pushYearMajor();
  } else if (majorUnit === "day") {
    for (let d = Math.floor(viewStartDay); ; d += 1) {
      const x = inX(d);
      if (x > trackW + 2) break;
      if (x >= -2) major.push({ x, label: majorLabel(d, "day") });
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
