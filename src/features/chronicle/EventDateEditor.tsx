import { useTranslation } from "react-i18next";
import { EVENT_GRANULARITIES, type EventGranularity } from "@/db/schema";
import {
  dayNumberToDate,
  dateToDayNumber,
  formatTimeOfDay,
  type ChronicleCalendar,
} from "./chronicleTime";

type Which = "start" | "end";

export interface EventDatePatch {
  startTime?: number | null;
  startMinute?: number | null;
  startGranularity?: EventGranularity;
  endTime?: number | null;
  endMinute?: number | null;
  endGranularity?: EventGranularity;
}

export interface EventDateEditorProps {
  calendar: ChronicleCalendar;
  startTime: number | null;
  startMinute: number | null;
  startGranularity: EventGranularity;
  endTime: number | null;
  endMinute: number | null;
  endGranularity: EventGranularity;
  onPatch: (patch: EventDatePatch) => void;
}

/** "HH:MM" → 分(0..1439)。空/不正は null。 */
function parseTimeOfDay(v: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * 暦駆動の出来事日時エディタ。粒度(none/season/year/month/day/time)に応じて
 * 年・月・日・季節・時刻の入力を出し分け、内部は day番号(startTime)＋分＋粒度で保持する。
 * 日付数学は chronicleTime（純関数）へ委譲。
 */
export function EventDateEditor({
  calendar,
  startTime,
  startMinute,
  startGranularity,
  endTime,
  endMinute,
  endGranularity,
  onPatch,
}: EventDateEditorProps) {
  const { t } = useTranslation();
  const months = calendar.months ?? [];
  const seasons = calendar.seasonBoundaries ?? [];

  const endpoint = (which: Which) => {
    const time = which === "start" ? startTime : endTime;
    const minute = which === "start" ? startMinute : endMinute;
    const gran = which === "start" ? startGranularity : endGranularity;
    const date = time != null ? dayNumberToDate(time, calendar) : null;
    const year = date?.year ?? calendar.startYear ?? 0;
    const monthIndex = date?.monthIndex ?? 0;
    const dayOfMonth = date?.dayOfMonth ?? 1;

    // 年/月/日の一部を変更 → day番号を再計算して onPatch。
    const patchParts = (parts: {
      year?: number;
      monthIndex?: number | null;
      dayOfMonth?: number | null;
    }) => {
      const next = dateToDayNumber(
        {
          year: parts.year ?? year,
          monthIndex: parts.monthIndex ?? monthIndex,
          dayOfMonth: parts.dayOfMonth ?? dayOfMonth,
        },
        calendar,
      );
      onPatch(which === "start" ? { startTime: next } : { endTime: next });
    };

    const setGran = (g: EventGranularity) => {
      if (g === "none") {
        onPatch(
          which === "start"
            ? { startGranularity: "none", startTime: null, startMinute: null }
            : { endGranularity: "none", endTime: null, endMinute: null },
        );
        return;
      }
      // none → 何か: 既存 time が無ければ暦開始日で初期化。
      const base =
        time ?? dateToDayNumber({ year: calendar.startYear ?? 0 }, calendar);
      onPatch(
        which === "start"
          ? { startGranularity: g, startTime: base }
          : { endGranularity: g, endTime: base },
      );
    };

    const setMinute = (v: string) => {
      const min = parseTimeOfDay(v);
      onPatch(which === "start" ? { startMinute: min } : { endMinute: min });
    };

    const setSeason = (startDayOfYear: number) => {
      const next =
        dateToDayNumber({ year }, calendar) + Math.max(0, startDayOfYear);
      onPatch(which === "start" ? { startTime: next } : { endTime: next });
    };

    const showYear = gran !== "none";
    const showSeason = gran === "season";
    const showMonth = gran === "month" || gran === "day" || gran === "time";
    const showDay = gran === "day" || gran === "time";
    const showTime = gran === "time";

    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="w-8 text-muted-foreground">
          {which === "start"
            ? t("chronicle.startTime", "開始")
            : t("chronicle.endTime", "終了")}
        </span>
        <select
          value={gran}
          onChange={(e) => setGran(e.target.value as EventGranularity)}
          aria-label={
            which === "start"
              ? t("chronicle.startGranularity", "開始の粒度")
              : t("chronicle.endGranularity", "終了の粒度")
          }
          className="rounded border bg-transparent px-1 py-0.5"
        >
          {EVENT_GRANULARITIES.map((g) => (
            <option key={g} value={g}>
              {t(`chronicle.granularity.${g}`, g)}
            </option>
          ))}
        </select>
        {showYear && (
          <input
            type="number"
            value={year}
            onChange={(e) => patchParts({ year: Number(e.target.value) })}
            aria-label={t("chronicle.year", "年")}
            className="w-16 rounded border bg-transparent px-1 py-0.5"
          />
        )}
        {showSeason && (
          <select
            value={String(
              seasons.find((s) => {
                const d = time != null ? dayNumberToDate(time, calendar) : null;
                return d != null && d.dayOfYear >= s.startDayOfYear;
              })?.startDayOfYear ??
                seasons[0]?.startDayOfYear ??
                0,
            )}
            onChange={(e) => setSeason(Number(e.target.value))}
            aria-label={t("chronicle.season", "季節")}
            className="rounded border bg-transparent px-1 py-0.5"
          >
            {seasons.map((s) => (
              <option key={s.startDayOfYear} value={s.startDayOfYear}>
                {s.name}
              </option>
            ))}
          </select>
        )}
        {showMonth &&
          (months.length > 0 ? (
            <select
              value={monthIndex}
              onChange={(e) =>
                patchParts({ monthIndex: Number(e.target.value) })
              }
              aria-label={t("chronicle.month", "月")}
              className="rounded border bg-transparent px-1 py-0.5"
            >
              {months.map((m, i) => (
                <option key={i} value={i}>
                  {m.name || `${i + 1}`}
                </option>
              ))}
            </select>
          ) : (
            <input
              type="number"
              min={1}
              value={monthIndex + 1}
              onChange={(e) =>
                patchParts({
                  monthIndex: Math.max(0, Number(e.target.value) - 1),
                })
              }
              aria-label={t("chronicle.month", "月")}
              className="w-12 rounded border bg-transparent px-1 py-0.5"
            />
          ))}
        {showDay && (
          <input
            type="number"
            min={1}
            value={dayOfMonth}
            onChange={(e) => patchParts({ dayOfMonth: Number(e.target.value) })}
            aria-label={t("chronicle.day", "日")}
            className="w-12 rounded border bg-transparent px-1 py-0.5"
          />
        )}
        {showTime && (
          <input
            type="time"
            value={formatTimeOfDay(minute) ?? ""}
            onChange={(e) => setMinute(e.target.value)}
            aria-label={t("chronicle.timeOfDay", "時刻")}
            className="rounded border bg-transparent px-1 py-0.5"
          />
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-1 text-xs">
      {endpoint("start")}
      {endpoint("end")}
    </div>
  );
}
