import { useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import type { EventGranularity } from "@/db/schema";
import {
  calendarDaysPerYear,
  formatChronicleDate,
  seasonOf,
  type ChronicleCalendar,
  type DateLang,
} from "./chronicleTime";

export interface ChronicleDatePickerProps {
  which: "start" | "end";
  granularity: EventGranularity;
  calendar: ChronicleCalendar;
  /** この端点の現在の日番号。 */
  day: number;
  /** この端点の現在の分(0..1439)。 */
  minute: number;
  /** 固定配置のアンカー（left＝左端 px、bottom＝下端からの px）。 */
  anchor: { left: number; bottom: number };
  onCommitDay: (day: number) => void;
  onCommitMinute: (minute: number) => void;
  onClose: () => void;
  lang?: DateLang;
}

const mod = (a: number, b: number) => ((a % b) + b) % b;
const pad2 = (n: number) => (n < 10 ? `0${n}` : `${n}`);
const MINUTES = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55];

/**
 * 暦駆動の日付/時刻ピッカー popover。粒度に応じて年ナビ・季節/月グリッド・
 * 日グリッド（曜日見出し）・時刻グリッドを出し分ける。月長/曜日長/季節境界は
 * プロジェクト暦から算出するため任意のファンタジー暦に対応する。
 */
export function ChronicleDatePicker({
  which,
  granularity,
  calendar,
  day,
  minute,
  anchor,
  onCommitDay,
  onCommitMinute,
  onClose,
  lang,
}: ChronicleDatePickerProps) {
  const { t } = useTranslation();
  const ja = (lang ?? "ja") === "ja";

  const dpy = calendarDaysPerYear(calendar);
  const startYear = calendar.startYear ?? 0;
  const monthDefs =
    calendar.months && calendar.months.length ? calendar.months : null;
  const monthCount = monthDefs ? monthDefs.length : 12;
  const monthLen = (mi: number) =>
    monthDefs
      ? Math.max(1, Math.floor(monthDefs[mi].days))
      : Math.max(1, Math.floor(dpy / monthCount));
  const monthName = (mi: number) =>
    monthDefs ? monthDefs[mi].name : ja ? `${mi + 1}月` : `${mi + 1}`;
  const weekNames =
    calendar.weekdayNames && calendar.weekdayNames.length
      ? calendar.weekdayNames
      : ja
        ? ["日", "月", "火", "水", "木", "金", "土"]
        : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const weekLen = weekNames.length;
  const seasons =
    calendar.seasonBoundaries && calendar.seasonBoundaries.length
      ? calendar.seasonBoundaries
      : [];

  const monthStartDoy = (mi: number) => {
    let s = 0;
    for (let i = 0; i < mi; i++) s += monthLen(i);
    return s;
  };
  const toDay = (year: number, mi: number, dom: number) =>
    (year - startYear) * dpy + monthStartDoy(mi) + (dom - 1);
  const fromDay = (d: number) => {
    const year = startYear + Math.floor(d / dpy);
    let doy = mod(Math.floor(d), dpy);
    let mi = 0;
    while (mi < monthCount - 1 && doy >= monthLen(mi)) {
      doy -= monthLen(mi);
      mi++;
    }
    return { year, monthIndex: mi, dayOfMonth: doy + 1 };
  };
  const weekdayOfDay = (d: number) => mod(Math.floor(d), weekLen);

  const cur = fromDay(day);
  const [view, setView] = useState(() => ({
    year: cur.year,
    monthIndex: cur.monthIndex,
  }));

  const commitDay = (d: number) => onCommitDay(d);
  // 月/年を移動するとき、現在の日付が遷移先の月日数を超えると toDay が翌月へ
  // 桁あふれする（例: 31日→28日の月）。遷移先の月長へクランプしてから確定する。
  const clampDom = (mi: number) =>
    Math.min(fromDay(day).dayOfMonth, monthLen(mi));
  const pkYear = (delta: number) => {
    const year = view.year + delta;
    setView((v) => ({ ...v, year }));
    commitDay(toDay(year, view.monthIndex, clampDom(view.monthIndex)));
  };
  const pkMonth = (delta: number) => {
    let mi = view.monthIndex + delta;
    let year = view.year;
    if (mi < 0) {
      mi = monthCount - 1;
      year--;
    }
    if (mi >= monthCount) {
      mi = 0;
      year++;
    }
    setView({ year, monthIndex: mi });
    commitDay(toDay(year, mi, clampDom(mi)));
  };
  const pkPickDay = (d: number) =>
    commitDay(toDay(view.year, view.monthIndex, d));
  const pkPickMonth = (i: number) => {
    setView((v) => ({ ...v, monthIndex: i }));
    commitDay(toDay(view.year, i, clampDom(i)));
  };
  const pkPickSeason = (startDayOfYear: number) =>
    commitDay((view.year - startYear) * dpy + startDayOfYear);
  const pkPickHour = (h: number) => onCommitMinute(h * 60 + (minute % 60));
  const pkPickMin = (m: number) =>
    onCommitMinute(Math.floor(minute / 60) * 60 + m);

  const showYearNav = granularity !== "none";
  const showMonthNav = granularity === "day" || granularity === "time";
  const showMonthGrid = granularity === "month";
  const showSeason = granularity === "season";
  const showDayGrid = granularity === "day" || granularity === "time";
  const showTime = granularity === "time";

  const cellBase = (sel: boolean): CSSProperties => ({
    height: 30,
    borderRadius: 7,
    border: `1px solid ${sel ? "var(--primary)" : "var(--border)"}`,
    background: sel
      ? "color-mix(in oklch, var(--primary) 12%, transparent)"
      : "var(--card)",
    color: sel ? "var(--primary)" : "var(--foreground)",
    fontSize: 12,
    cursor: "pointer",
    fontWeight: sel ? 600 : 400,
  });
  const tcell = (sel: boolean): CSSProperties => ({
    height: 24,
    borderRadius: 6,
    border: `1px solid ${sel ? "var(--primary)" : "var(--border)"}`,
    background: sel
      ? "color-mix(in oklch, var(--primary) 12%, transparent)"
      : "var(--card)",
    color: sel ? "var(--primary)" : "var(--muted-foreground)",
    fontSize: 11,
    cursor: "pointer",
    padding: 0,
  });
  const navBtn: CSSProperties = {
    width: 30,
    height: 28,
    borderRadius: 7,
    border: "1px solid var(--border)",
    background: "var(--card)",
    color: "var(--muted-foreground)",
    cursor: "pointer",
    fontSize: 11,
  };

  // 日グリッド（先頭曜日オフセット＋当月日数）。
  const firstDay = toDay(view.year, view.monthIndex, 1);
  const offset = weekdayOfDay(firstDay);
  const daysInMonth = monthLen(view.monthIndex);

  const curHour = Math.floor(mod(minute, 1440) / 60);
  const curMin = mod(minute, 60);
  const curSeason = seasonOf(day, calendar);

  return (
    <>
      <div className="fixed inset-0 z-[60]" onClick={onClose} />
      <div
        className="fixed z-[61] w-[296px] rounded-xl border border-border bg-card p-3 shadow-xl"
        style={{ left: anchor.left, bottom: anchor.bottom }}
      >
        <div className="mb-2.5 flex items-center">
          <span className="text-xs font-semibold text-foreground">
            {which === "start"
              ? t("chronicle.startDateTime", "開始日時")
              : t("chronicle.endDateTime", "終了日時")}
          </span>
          <span
            className="ml-auto text-xs text-muted-foreground"
            style={{ fontFeatureSettings: "'tnum'" }}
          >
            {formatChronicleDate(day, minute, granularity, calendar, lang)}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("chronicle.close", "閉じる")}
            className="ml-2 size-[22px] rounded-md border border-border bg-card text-xs text-muted-foreground"
          >
            ×
          </button>
        </div>

        {showYearNav && (
          <div className="mb-2 flex items-center gap-2">
            <button type="button" style={navBtn} onClick={() => pkYear(-1)}>
              ◀
            </button>
            <span className="flex-1 text-center text-[13px] font-semibold text-foreground">
              {ja ? `${view.year}年` : `Y${view.year}`}
            </span>
            <button type="button" style={navBtn} onClick={() => pkYear(1)}>
              ▶
            </button>
          </div>
        )}

        {showMonthNav && (
          <div className="mb-2 flex items-center gap-2">
            <button type="button" style={navBtn} onClick={() => pkMonth(-1)}>
              ◀
            </button>
            <span className="flex-1 text-center text-[13px] text-foreground/80">
              {monthName(view.monthIndex)}
            </span>
            <button type="button" style={navBtn} onClick={() => pkMonth(1)}>
              ▶
            </button>
          </div>
        )}

        {showSeason && (
          <div className="grid grid-cols-4 gap-1.5">
            {seasons.map((s) => (
              <button
                key={s.startDayOfYear}
                type="button"
                style={cellBase(curSeason === s.name)}
                onClick={() => pkPickSeason(s.startDayOfYear)}
              >
                {s.name}
              </button>
            ))}
          </div>
        )}

        {showMonthGrid && (
          <div className="grid grid-cols-3 gap-1.5">
            {Array.from({ length: monthCount }, (_, i) => (
              <button
                key={i}
                type="button"
                style={cellBase(i === cur.monthIndex && view.year === cur.year)}
                onClick={() => pkPickMonth(i)}
              >
                {monthName(i)}
              </button>
            ))}
          </div>
        )}

        {showDayGrid && (
          <>
            <div
              className="mb-1 grid gap-[3px]"
              style={{ gridTemplateColumns: `repeat(${weekLen}, 1fr)` }}
            >
              {weekNames.map((w, i) => (
                <div
                  key={i}
                  className="py-0.5 text-center text-[10px] text-muted-foreground"
                >
                  {w}
                </div>
              ))}
            </div>
            <div
              className="grid gap-[3px]"
              style={{ gridTemplateColumns: `repeat(${weekLen}, 1fr)` }}
            >
              {Array.from({ length: offset }, (_, i) => (
                <div key={`b${i}`} />
              ))}
              {Array.from({ length: daysInMonth }, (_, i) => {
                const d = i + 1;
                const sel =
                  view.year === cur.year &&
                  view.monthIndex === cur.monthIndex &&
                  d === cur.dayOfMonth;
                return (
                  <button
                    key={d}
                    type="button"
                    style={cellBase(sel)}
                    onClick={() => pkPickDay(d)}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </>
        )}

        {showTime && (
          <div className="mt-2.5 border-t border-border pt-2.5">
            <div className="mb-1.5 text-[10px] text-muted-foreground">
              {t("chronicle.timeOfDay", "時刻")}
            </div>
            <div className="mb-1.5 grid grid-cols-8 gap-[3px]">
              {Array.from({ length: 24 }, (_, h) => (
                <button
                  key={h}
                  type="button"
                  style={tcell(curHour === h)}
                  onClick={() => pkPickHour(h)}
                >
                  {h}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-6 gap-[3px]">
              {MINUTES.map((m) => (
                <button
                  key={m}
                  type="button"
                  style={tcell(curMin === m)}
                  onClick={() => pkPickMin(m)}
                >
                  {pad2(m)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
