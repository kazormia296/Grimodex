import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, X, RotateCcw, CalendarCheck } from "lucide-react";
import {
  DEFAULT_SEASON_BOUNDARIES,
  GREGORIAN_MONTH_DAYS,
  GREGORIAN_LEAP,
  gregorianWeekdayIndex,
  calendarDaysPerYear,
  type ChronicleCalendar,
  type SeasonBoundary,
  type MonthDef,
  type LeapRule,
  type AgeReckoning,
  type EraDef,
  type CalendarReform,
  type TimeZoneDef,
} from "./chronicleTime";
import { REFORM_PRESETS } from "./chronicleReform";

const GREGORIAN_MONTH_NAMES: Record<"ja" | "en", string[]> = {
  ja: [
    "1月",
    "2月",
    "3月",
    "4月",
    "5月",
    "6月",
    "7月",
    "8月",
    "9月",
    "10月",
    "11月",
    "12月",
  ],
  en: [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec",
  ],
};
const GREGORIAN_WEEKDAYS: Record<"ja" | "en", string[]> = {
  ja: ["日", "月", "火", "水", "木", "金", "土"],
  en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};
const DEFAULT_SEASON_NAMES: Record<"ja" | "en", string[]> = {
  ja: ["春", "夏", "秋", "冬"],
  en: ["Spring", "Summer", "Autumn", "Winter"],
};

/** 既定季節境界をロケールの季節名で返す（startDayOfYear は既定のまま）。 */
export function localizedDefaultSeasons(lang: "ja" | "en"): SeasonBoundary[] {
  return DEFAULT_SEASON_BOUNDARIES.map((b, i) => ({
    ...b,
    name: DEFAULT_SEASON_NAMES[lang][i] ?? b.name,
  }));
}

/** エディタの内部フォーム状態（weekdays は表示用のカンマ区切り文字列）。 */
interface CalendarFormState {
  daysPerYear: number;
  startYear: number;
  months: MonthDef[];
  weekdays: string;
  weekdayStartIndex: number;
  seasons: SeasonBoundary[];
  leap: LeapRule;
  ageReckoning: AgeReckoning;
  eras: EraDef[];
  reform: CalendarReform | undefined;
  timezone: TimeZoneDef | undefined;
}

/**
 * 現実準拠グレゴリオ暦（12ヶ月・閏2月・7曜・365日・春夏秋冬4季）の既定フォーム状態。
 * 新規作成時の初期値と「リセット」ボタンの両方で使う。
 */
function gregorianFormState(lang: "ja" | "en"): CalendarFormState {
  return {
    daysPerYear: 365,
    startYear: 0,
    months: GREGORIAN_MONTH_DAYS.map((days, i) => ({
      name: GREGORIAN_MONTH_NAMES[lang][i],
      days,
    })),
    weekdays: GREGORIAN_WEEKDAYS[lang].join(", "),
    weekdayStartIndex: 0,
    seasons: localizedDefaultSeasons(lang),
    leap: { ...GREGORIAN_LEAP },
    ageReckoning: "full",
    eras: [],
    reform: undefined,
    timezone: undefined,
  };
}

/** 既存暦をフォーム状態へ展開（初期値）。未指定フィールドは素朴な既定へ。 */
function formStateFromCalendar(
  cal: ChronicleCalendar,
  lang: "ja" | "en",
): CalendarFormState {
  return {
    daysPerYear: cal.daysPerYear,
    startYear: cal.startYear ?? 0,
    months: cal.months ?? [],
    weekdays: (cal.weekdayNames ?? []).join(", "),
    weekdayStartIndex: cal.weekdayStartIndex ?? 0,
    seasons: cal.seasonBoundaries.length
      ? cal.seasonBoundaries
      : localizedDefaultSeasons(lang),
    leap: cal.leap ?? { kind: "none" },
    ageReckoning: cal.ageReckoning ?? "full",
    eras: cal.eras ?? [],
    reform: cal.reform,
    timezone: cal.timezone,
  };
}

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
  const { t, i18n } = useTranslation();
  const lang: "ja" | "en" = i18n.language?.startsWith("en") ? "en" : "ja";
  // 既存暦があればそれを、無ければグレゴリオ暦を既定とする（新規作成のデフォルト）。
  const init = initial
    ? formStateFromCalendar(initial, lang)
    : gregorianFormState(lang);
  const [daysPerYear, setDaysPerYear] = useState(init.daysPerYear);
  const [startYear, setStartYear] = useState(init.startYear);
  const [months, setMonths] = useState<MonthDef[]>(init.months);
  const [weekdays, setWeekdays] = useState<string>(init.weekdays);
  const [weekdayStartIndex, setWeekdayStartIndex] = useState(
    init.weekdayStartIndex,
  );
  const [seasons, setSeasons] = useState<SeasonBoundary[]>(init.seasons);
  const [leap, setLeap] = useState<LeapRule>(init.leap);
  const [ageReckoning, setAgeReckoning] = useState<AgeReckoning>(
    init.ageReckoning,
  );
  const [eras, setEras] = useState<EraDef[]>(init.eras);
  const [reform, setReform] = useState<CalendarReform | undefined>(init.reform);
  const [timezone, setTimezone] = useState<TimeZoneDef | undefined>(
    init.timezone,
  );

  // 全フィールドをグレゴリオ暦の既定値へ戻す（リセット）。
  const resetToDefault = () => {
    const g = gregorianFormState(lang);
    setDaysPerYear(g.daysPerYear);
    setStartYear(g.startYear);
    setMonths(g.months);
    setWeekdays(g.weekdays);
    setWeekdayStartIndex(g.weekdayStartIndex);
    setSeasons(g.seasons);
    setLeap(g.leap);
    setAgeReckoning(g.ageReckoning);
    setEras(g.eras);
    setReform(g.reform);
    setTimezone(g.timezone);
  };

  // タイムゾーン編集（label を空にすると TZ 自体を解除）。
  const updateTz = (patch: Partial<TimeZoneDef>) =>
    setTimezone((tz) => ({ label: "", offsetMinutes: 0, ...tz, ...patch }));
  const toggleDst = (on: boolean) =>
    setTimezone((tz) =>
      tz
        ? {
            ...tz,
            dst: on
              ? (tz.dst ?? {
                  label: "",
                  offsetMinutes: tz.offsetMinutes + 60,
                  startDayOfYear: 0,
                  endDayOfYear: 0,
                })
              : undefined,
          }
        : tz,
    );
  const updateDst = (patch: Partial<NonNullable<TimeZoneDef["dst"]>>) =>
    setTimezone((tz) =>
      tz && tz.dst ? { ...tz, dst: { ...tz.dst, ...patch } } : tz,
    );

  const updateEra = (i: number, patch: Partial<EraDef>) =>
    setEras((e) => e.map((x, idx) => (idx === i ? { ...x, ...patch } : x)));
  const addEra = () =>
    setEras((e) => [...e, { name: "", startYear: Math.floor(startYear) }]);
  const removeEra = (i: number) =>
    setEras((e) => e.filter((_, idx) => idx !== i));

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
    const normalizedWeekdayStartIndex =
      weekdayNames.length > 0
        ? ((Math.floor(weekdayStartIndex) % weekdayNames.length) +
            weekdayNames.length) %
          weekdayNames.length
        : 0;
    // months があれば 1年の日数は月長合計を正本にする（手入力 daysPerYear は無視）。
    // 閏（gregorian）は月概念が前提。月が無ければ none に落とし、monthIndex は範囲内へ。
    const effectiveLeap: LeapRule =
      leap.kind === "gregorian" && cleanedMonths.length > 0
        ? {
            kind: "gregorian",
            monthIndex: Math.max(
              0,
              Math.min(cleanedMonths.length - 1, leap.monthIndex),
            ),
          }
        : { kind: "none" };
    const cleanedEras = eras
      .filter((e) => e.name.trim() !== "")
      .map((e) => ({ name: e.name.trim(), startYear: Math.floor(e.startYear) }))
      .sort((a, b) => a.startYear - b.startYear);
    const cal: ChronicleCalendar = {
      daysPerYear: Math.max(1, Math.floor(daysPerYear)),
      seasonBoundaries: cleaned,
      startYear: Math.floor(startYear),
      months: cleanedMonths,
      weekdayNames,
      weekdayStartIndex: normalizedWeekdayStartIndex,
      leap: effectiveLeap,
      ageReckoning,
      eras: cleanedEras,
      reform,
      timezone: timezone && timezone.label.trim() !== "" ? timezone : undefined,
    };
    onSave({ ...cal, daysPerYear: calendarDaysPerYear(cal) });
    onClose();
  };

  return (
    <div
      className="space-y-2 p-3 text-sm"
      data-testid="chronicle-calendar-editor"
    >
      <div className="flex items-center gap-2">
        <span className="font-medium">
          {t("chronicle.calendarEditor", "暦の設定")}
        </span>
        <button
          type="button"
          onClick={resetToDefault}
          className="ml-auto inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t(
            "chronicle.resetCalendarHint",
            "暦をグレゴリオ暦の既定値（12ヶ月・閏2月・7曜・365日）に戻す",
          )}
        >
          <RotateCcw className="size-3.5" />
          {t("chronicle.resetCalendar", "リセット")}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 hover:bg-accent"
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

      <div className="flex flex-wrap items-center gap-3 text-xs">
        <label className="flex items-center gap-2">
          {t("chronicle.weekdayNames", "曜日名")}
          <input
            value={weekdays}
            onChange={(e) => setWeekdays(e.target.value)}
            placeholder={t("chronicle.weekdayPlaceholder", "月, 火, 水, …")}
            className="w-56 rounded border bg-transparent px-1 py-0.5"
          />
        </label>
        <label
          className="flex items-center gap-2"
          title={t(
            "chronicle.weekdayStartHint",
            "day番号0に対応する曜日名のindexです。0始まり。",
          )}
        >
          {t("chronicle.weekdayStartIndex", "day0曜日")}
          <input
            type="number"
            min={0}
            max={Math.max(0, weekdays.split(",").filter(Boolean).length - 1)}
            value={weekdayStartIndex}
            onChange={(e) => setWeekdayStartIndex(Number(e.target.value))}
            className="w-16 rounded border bg-transparent px-1 py-0.5"
          />
        </label>
        <button
          type="button"
          onClick={() => setWeekdayStartIndex(gregorianWeekdayIndex(startYear))}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          title={t(
            "chronicle.weekdayMatchRealHint",
            "開始年1月1日(=day0)の実暦グレゴリオ曜日に合わせる（週=日曜始まり前提）。1582年以前はユリウス暦とずれます。",
          )}
        >
          <CalendarCheck className="size-3.5" />
          {t("chronicle.weekdayMatchReal", "実暦に合わせる")}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
        <label
          className="flex items-center gap-1.5"
          title={t(
            "chronicle.leapHint",
            "グレゴリオ閏年（4/100/400）。月定義が必要です。",
          )}
        >
          <input
            type="checkbox"
            checked={leap.kind === "gregorian"}
            onChange={(e) =>
              setLeap(
                e.target.checked ? { ...GREGORIAN_LEAP } : { kind: "none" },
              )
            }
            disabled={months.length === 0}
            style={{ accentColor: "var(--primary)" }}
            className="size-3.5"
          />
          {t("chronicle.leapEnable", "閏年（グレゴリオ式）")}
          {leap.kind === "gregorian" && months.length > 0 && (
            <select
              value={leap.monthIndex}
              onChange={(e) =>
                setLeap({
                  kind: "gregorian",
                  monthIndex: Number(e.target.value),
                })
              }
              aria-label={t("chronicle.leapMonth", "閏を加える月")}
              className="ml-1 rounded border bg-transparent px-1 py-0.5"
            >
              {months.map((m, i) => (
                <option key={i} value={i}>
                  {m.name || `${i + 1}`}
                </option>
              ))}
            </select>
          )}
        </label>

        <span className="flex items-center gap-1.5">
          {t("chronicle.ageReckoningLabel", "年齢表記")}
          <span className="inline-flex overflow-hidden rounded border border-border">
            {(["full", "counting"] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setAgeReckoning(r)}
                className={`px-2 py-0.5 ${
                  ageReckoning === r
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent"
                }`}
              >
                {r === "full"
                  ? t("chronicle.ageFull", "満年齢")
                  : t("chronicle.ageCounting", "数え年")}
              </button>
            ))}
          </span>
        </span>

        <label
          className="flex items-center gap-1.5"
          title={t(
            "chronicle.reformHint",
            "ユリウス暦→グレゴリオ暦の改暦。切替前はユリウス閏(4年毎)、後はグレゴリオ閏、切替で日飛ばし（実暦12ヶ月暦が前提）。",
          )}
        >
          {t("chronicle.reformLabel", "改暦")}
          <select
            value={reform?.region ?? "none"}
            onChange={(e) =>
              setReform(
                e.target.value === "none"
                  ? undefined
                  : REFORM_PRESETS[e.target.value],
              )
            }
            className="rounded border bg-transparent px-1 py-0.5"
          >
            <option value="none">{t("chronicle.reformNone", "なし")}</option>
            <option value="gregorian1582">
              {t("chronicle.reform1582", "1582 (カトリック圏・10日)")}
            </option>
            <option value="britain1752">
              {t("chronicle.reform1752", "1752 (イギリス・11日)")}
            </option>
            <option value="russia1918">
              {t("chronicle.reform1918", "1918 (ロシア・13日)")}
            </option>
          </select>
        </label>
      </div>

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

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          {t("chronicle.eras", "元号・年号（名前・開始年）")}
        </div>
        {eras.map((e, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <input
              value={e.name}
              onChange={(ev) => updateEra(i, { name: ev.target.value })}
              placeholder={t("chronicle.eraName", "元号名（例: 明治）")}
              className="w-28 rounded border bg-transparent px-1 py-0.5"
            />
            <input
              type="number"
              value={e.startYear}
              onChange={(ev) =>
                updateEra(i, { startYear: Number(ev.target.value) })
              }
              aria-label={t("chronicle.eraStartYear", "開始年")}
              className="w-24 rounded border bg-transparent px-1 py-0.5"
            />
            <span className="text-muted-foreground">
              {t("chronicle.eraStartYearSuffix", "年〜=元号1年")}
            </span>
            <button
              type="button"
              onClick={() => removeEra(i)}
              className="rounded p-1 hover:bg-destructive/10"
              aria-label={t("chronicle.delete", "削除")}
            >
              <Trash2 className="size-3.5 opacity-60" />
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addEra}
          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs hover:bg-accent"
        >
          <Plus className="size-3.5" />
          {t("chronicle.addEra", "元号を追加")}
        </button>
      </div>

      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">
          {t("chronicle.timezone", "タイムゾーン（時刻表示）")}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <input
            value={timezone?.label ?? ""}
            onChange={(e) =>
              e.target.value.trim() === ""
                ? setTimezone(undefined)
                : updateTz({ label: e.target.value })
            }
            placeholder={t("chronicle.tzLabel", "標準時 (例: JST)")}
            className="w-32 rounded border bg-transparent px-1 py-0.5"
          />
          <label className="flex items-center gap-1">
            {t("chronicle.tzOffset", "UTC")}
            <input
              type="number"
              value={timezone?.offsetMinutes ?? 0}
              onChange={(e) =>
                updateTz({ offsetMinutes: Number(e.target.value) })
              }
              disabled={!timezone}
              aria-label={t("chronicle.tzOffset", "UTCオフセット(分)")}
              className="w-20 rounded border bg-transparent px-1 py-0.5 disabled:opacity-50"
            />
            {t("chronicle.tzOffsetUnit", "分")}
          </label>
          {timezone && (
            <label className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={!!timezone.dst}
                onChange={(e) => toggleDst(e.target.checked)}
                style={{ accentColor: "var(--primary)" }}
                className="size-3.5"
              />
              {t("chronicle.dst", "夏時間")}
            </label>
          )}
        </div>
        {timezone?.dst && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <input
              value={timezone.dst.label}
              onChange={(e) => updateDst({ label: e.target.value })}
              placeholder={t("chronicle.dstLabel", "夏時間 (例: JDT)")}
              className="w-32 rounded border bg-transparent px-1 py-0.5"
            />
            <label className="flex items-center gap-1">
              {t("chronicle.tzOffset", "UTC")}
              <input
                type="number"
                value={timezone.dst.offsetMinutes}
                onChange={(e) =>
                  updateDst({ offsetMinutes: Number(e.target.value) })
                }
                className="w-20 rounded border bg-transparent px-1 py-0.5"
              />
              {t("chronicle.tzOffsetUnit", "分")}
            </label>
            <label className="flex items-center gap-1">
              {t("chronicle.dstRange", "通日")}
              <input
                type="number"
                min={0}
                value={timezone.dst.startDayOfYear}
                onChange={(e) =>
                  updateDst({ startDayOfYear: Number(e.target.value) })
                }
                aria-label={t("chronicle.dstStart", "夏時間開始通日")}
                className="w-16 rounded border bg-transparent px-1 py-0.5"
              />
              〜
              <input
                type="number"
                min={0}
                value={timezone.dst.endDayOfYear}
                onChange={(e) =>
                  updateDst({ endDayOfYear: Number(e.target.value) })
                }
                aria-label={t("chronicle.dstEnd", "夏時間終了通日")}
                className="w-16 rounded border bg-transparent px-1 py-0.5"
              />
            </label>
          </div>
        )}
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
