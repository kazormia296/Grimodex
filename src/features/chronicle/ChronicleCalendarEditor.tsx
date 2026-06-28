import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, X } from "lucide-react";
import {
  DEFAULT_SEASON_BOUNDARIES,
  calendarDaysPerYear,
  type ChronicleCalendar,
  type SeasonBoundary,
  type MonthDef,
} from "./chronicleTime";

export interface ChronicleCalendarEditorProps {
  initial: ChronicleCalendar | null;
  onSave: (cal: ChronicleCalendar) => void;
  onClose: () => void;
}

/**
 * 作中暦エディタ（1年の日数＋季節境界）。新規作成と編集を兼ねる。
 * 保存時は空名の季節を除き、startDayOfYear 昇順に正規化する。
 */
export function ChronicleCalendarEditor({
  initial,
  onSave,
  onClose,
}: ChronicleCalendarEditorProps) {
  const { t } = useTranslation();
  const [daysPerYear, setDaysPerYear] = useState(initial?.daysPerYear ?? 360);
  const [startYear, setStartYear] = useState(initial?.startYear ?? 0);
  const [months, setMonths] = useState<MonthDef[]>(initial?.months ?? []);
  const [weekdays, setWeekdays] = useState<string>(
    (initial?.weekdayNames ?? []).join(", "),
  );
  const [seasons, setSeasons] = useState<SeasonBoundary[]>(
    initial && initial.seasonBoundaries.length
      ? initial.seasonBoundaries
      : DEFAULT_SEASON_BOUNDARIES,
  );

  const updateSeason = (i: number, patch: Partial<SeasonBoundary>) =>
    setSeasons((s) => s.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  const addSeason = () =>
    setSeasons((s) => [...s, { name: "", startDayOfYear: 0 }]);
  const removeSeason = (i: number) =>
    setSeasons((s) => s.filter((_, idx) => idx !== i));

  const updateMonth = (i: number, patch: Partial<MonthDef>) =>
    setMonths((m) => m.map((b, idx) => (idx === i ? { ...b, ...patch } : b)));
  const addMonth = () => setMonths((m) => [...m, { name: "", days: 30 }]);
  const removeMonth = (i: number) =>
    setMonths((m) => m.filter((_, idx) => idx !== i));

  const handleSave = () => {
    const cleaned = seasons
      .filter((b) => b.name.trim() !== "")
      .map((b) => ({
        name: b.name.trim(),
        startDayOfYear: Math.max(0, Math.floor(b.startDayOfYear)),
      }))
      .sort((a, b) => a.startDayOfYear - b.startDayOfYear);
    const cleanedMonths = months
      .map((m) => ({
        name: m.name.trim(),
        days: Math.max(1, Math.floor(m.days)),
      }))
      .filter((m) => m.name !== "");
    const weekdayNames = weekdays
      .split(",")
      .map((w) => w.trim())
      .filter((w) => w !== "");
    // months があれば 1年の日数は月長合計を正本にする（手入力 daysPerYear は無視）。
    const cal: ChronicleCalendar = {
      daysPerYear: Math.max(1, Math.floor(daysPerYear)),
      seasonBoundaries: cleaned,
      startYear: Math.floor(startYear),
      months: cleanedMonths,
      weekdayNames,
    };
    onSave({ ...cal, daysPerYear: calendarDaysPerYear(cal) });
    onClose();
  };

  return (
    <div
      className="shrink-0 space-y-2 border-b bg-muted/30 p-3 text-sm"
      data-testid="chronicle-calendar-editor"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">
          {t("chronicle.calendarEditor", "暦の設定")}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-1 hover:bg-accent"
          aria-label={t("chronicle.close", "閉じる")}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-2">
          {t("chronicle.startYear", "開始年")}
          <input
            type="number"
            value={startYear}
            onChange={(e) => setStartYear(Number(e.target.value))}
            className="w-20 rounded border bg-transparent px-1 py-0.5"
          />
        </label>
        <label className="flex items-center gap-2">
          {t("chronicle.daysPerYear", "1年の日数")}
          <input
            type="number"
            min={1}
            value={
              months.length > 0
                ? calendarDaysPerYear({
                    daysPerYear,
                    seasonBoundaries: [],
                    months,
                  })
                : daysPerYear
            }
            onChange={(e) => setDaysPerYear(Number(e.target.value))}
            disabled={months.length > 0}
            className="w-24 rounded border bg-transparent px-1 py-0.5 disabled:opacity-50"
          />
          {months.length > 0 && (
            <span className="text-muted-foreground">
              {t("chronicle.daysDerived", "（月から自動）")}
            </span>
          )}
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs">
        {t("chronicle.weekdayNames", "曜日名")}
        <input
          value={weekdays}
          onChange={(e) => setWeekdays(e.target.value)}
          placeholder={t("chronicle.weekdayPlaceholder", "月, 火, 水, …")}
          className="w-56 rounded border bg-transparent px-1 py-0.5"
        />
      </label>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          {t("chronicle.months", "月（名前・日数）")}
        </div>
        {months.map((m, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <input
              value={m.name}
              onChange={(e) => updateMonth(i, { name: e.target.value })}
              placeholder={t("chronicle.monthName", "月名")}
              className="w-24 rounded border bg-transparent px-1 py-0.5"
            />
            <input
              type="number"
              min={1}
              value={m.days}
              onChange={(e) => updateMonth(i, { days: Number(e.target.value) })}
              aria-label={t("chronicle.daysInMonth", "日数")}
              className="w-16 rounded border bg-transparent px-1 py-0.5"
            />
            <button
              type="button"
              onClick={() => removeMonth(i)}
              className="rounded p-1 hover:bg-destructive/10"
              aria-label={t("chronicle.delete", "削除")}
            >
              <Trash2 className="size-3.5 opacity-60" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addMonth}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" />
          {t("chronicle.addMonth", "月を追加")}
        </button>
      </div>

      <div className="space-y-1">
        {seasons.map((b, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <input
              value={b.name}
              onChange={(e) => updateSeason(i, { name: e.target.value })}
              placeholder={t("chronicle.seasonName", "季節名")}
              className="w-24 rounded border bg-transparent px-1 py-0.5"
            />
            <input
              type="number"
              min={0}
              value={b.startDayOfYear}
              onChange={(e) =>
                updateSeason(i, { startDayOfYear: Number(e.target.value) })
              }
              aria-label={t("chronicle.startDay", "開始日")}
              className="w-20 rounded border bg-transparent px-1 py-0.5"
            />
            <button
              type="button"
              onClick={() => removeSeason(i)}
              className="rounded p-1 hover:bg-destructive/10"
              aria-label={t("chronicle.delete", "削除")}
            >
              <Trash2 className="size-3.5 opacity-60" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addSeason}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" />
          {t("chronicle.addSeason", "季節を追加")}
        </button>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded px-2 py-1 text-xs hover:bg-accent"
        >
          {t("chronicle.cancel", "キャンセル")}
        </button>
        <button
          type="button"
          onClick={handleSave}
          className="rounded bg-primary px-2 py-1 text-xs text-primary-foreground hover:opacity-90"
        >
          {t("chronicle.save", "保存")}
        </button>
      </div>
    </div>
  );
}
