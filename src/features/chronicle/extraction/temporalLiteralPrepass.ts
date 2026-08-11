import type {
  AbsoluteTemporalLiteral,
  DurationTemporalLiteral,
  QualitativeTemporalLiteral,
  RelativeTemporalLiteral,
  TemporalLiteral,
} from "@/features/narrative-extraction/temporal/constraints";
import type { ExtractionCalendarSnapshot } from "../calendar/extractionCalendarSnapshot";

export interface LiteralPrepassHit {
  readonly surface: string;
  readonly from: number;
  readonly to: number;
  readonly expression: TemporalLiteral;
}

function monthNameToRef(
  calendar: ExtractionCalendarSnapshot | null,
  name: string,
): string | null {
  if (!calendar) return null;
  const hit = calendar.months.find((m) => m.name === name);
  return hit?.ref ?? null;
}

function eraNameToRef(
  calendar: ExtractionCalendarSnapshot | null,
  name: string,
): string | null {
  if (!calendar) return null;
  const hit = calendar.eras.find((e) => e.name === name);
  return hit?.ref ?? null;
}

/**
 * Deterministic temporal literal prepass. Does not invent calendar refs.
 */
export function runTemporalLiteralPrepass(
  text: string,
  calendar: ExtractionCalendarSnapshot | null = null,
): readonly LiteralPrepassHit[] {
  const hits: LiteralPrepassHit[] = [];

  const push = (surface: string, from: number, expression: TemporalLiteral) => {
    hits.push({ surface, from, to: from + surface.length, expression });
  };

  // Absolute: N年
  for (const match of text.matchAll(/(\d{1,4})\s*年/g)) {
    const surface = match[0]!;
    const year = Number(match[1]);
    const expression: AbsoluteTemporalLiteral = {
      kind: "absolute",
      calendarRef: calendar?.calendarRef ?? null,
      year,
      granularity: "year",
      precision: "exact",
    };
    push(surface, match.index ?? 0, expression);
  }

  // Absolute: N月N日
  for (const match of text.matchAll(/(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)) {
    const surface = match[0]!;
    const monthNum = Number(match[1]);
    const day = Number(match[2]);
    const monthName = calendar?.months[monthNum - 1]?.name;
    const monthRef = monthName ? monthNameToRef(calendar, monthName) : null;
    const expression: AbsoluteTemporalLiteral = {
      kind: "absolute",
      calendarRef: calendar?.calendarRef ?? null,
      ...(monthRef ? { monthRef } : {}),
      day,
      granularity: "day",
      precision: "exact",
    };
    push(surface, match.index ?? 0, expression);
  }

  // Relative: 三日後 / 3日後 / 十年以上前
  for (const match of text.matchAll(
    /([0-9一二三四五六七八九十百]+)\s*(分|時間|日|週|週間|か?月|年)\s*(以上)?\s*(前|後)/g,
  )) {
    const surface = match[0]!;
    const amountRaw = match[1]!;
    const unitRaw = match[2]!;
    const atLeast = Boolean(match[3]);
    const direction = match[4] === "前" ? "before" : "after";
    const amount = parseJaNumber(amountRaw);
    if (amount === null) continue;
    const unit = mapUnit(unitRaw);
    if (!unit) continue;
    const expression: RelativeTemporalLiteral = {
      kind: "relative",
      direction,
      amount: {
        min: atLeast && direction === "before" ? amount : amount,
        max:
          atLeast && direction === "before" ? Number.MAX_SAFE_INTEGER : amount,
        unit,
      },
      anchorSurface: null,
      qualifier: atLeast ? "at-least" : "exact",
    };
    push(surface, match.index ?? 0, {
      ...expression,
      amount: expression.amount
        ? {
            ...expression.amount,
            max:
              expression.amount.max > 1_000_000
                ? amount * 100
                : expression.amount.max,
          }
        : null,
    });
  }

  // Duration: 三日間
  for (const match of text.matchAll(
    /([0-9一二三四五六七八九十]+)\s*(分|時間|日|週|週間|か?月|年)\s*間/g,
  )) {
    const surface = match[0]!;
    const amount = parseJaNumber(match[1]!);
    const unit = mapUnit(match[2]!);
    if (amount === null || !unit) continue;
    const expression: DurationTemporalLiteral = {
      kind: "duration",
      min: amount,
      max: amount,
      unit,
      qualifier: "exact",
    };
    push(surface, match.index ?? 0, expression);
  }

  // Qualitative / symbolic
  for (const match of text.matchAll(/同じ夜|しばらく後|明け方|夜/g)) {
    const surface = match[0]!;
    const category =
      surface === "同じ夜" || surface === "夜"
        ? "night"
        : surface === "明け方"
          ? "dawn"
          : "soon";
    const expression: QualitativeTemporalLiteral = {
      kind: "qualitative",
      category,
      label: surface,
    };
    push(surface, match.index ?? 0, expression);
  }

  // Era names from calendar — exact match only
  if (calendar) {
    for (const era of calendar.eras) {
      let from = 0;
      while (from < text.length) {
        const idx = text.indexOf(era.name, from);
        if (idx < 0) break;
        const eraRef = eraNameToRef(calendar, era.name);
        if (eraRef) {
          push(era.name, idx, {
            kind: "absolute",
            calendarRef: calendar.calendarRef,
            eraRef,
            granularity: "year",
            precision: "exact",
          });
        }
        from = idx + era.name.length;
      }
    }
  }

  return hits.sort((a, b) => a.from - b.from || a.to - b.to);
}

function mapUnit(
  raw: string,
): "minute" | "hour" | "day" | "week" | "month" | "year" | null {
  if (raw === "分") return "minute";
  if (raw === "時間") return "hour";
  if (raw === "日") return "day";
  if (raw === "週" || raw === "週間") return "week";
  if (raw === "月" || raw === "か月" || raw === "ヵ月") return "month";
  if (raw === "年") return "year";
  return null;
}

function parseJaNumber(raw: string): number | null {
  if (/^\d+$/.test(raw)) return Number(raw);
  const map: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  if (raw === "十") return 10;
  if (raw.length === 1 && map[raw] !== undefined) return map[raw]!;
  if (raw.startsWith("十") && raw.length === 2) {
    return 10 + (map[raw[1]!] ?? 0);
  }
  if (raw.endsWith("十") && raw.length === 2) {
    return (map[raw[0]!] ?? 0) * 10;
  }
  if (raw.length === 3 && raw[1] === "十") {
    return (map[raw[0]!] ?? 0) * 10 + (map[raw[2]!] ?? 0);
  }
  return null;
}
