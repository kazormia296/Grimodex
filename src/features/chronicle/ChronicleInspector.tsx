import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Trash2,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  CalendarDays,
} from "lucide-react";
import {
  EVENT_PRECISIONS,
  EVENT_KINDS,
  EVENT_GRANULARITIES,
  type EventGranularity,
} from "@/db/schema";
import type { EventRow } from "./api";
import type { SeasonConflict } from "./seasonCheck";
import type { AgeConflict } from "./ageCheck";
import {
  dateToDayNumber,
  formatChronicleDate,
  type ChronicleCalendar,
  type DateLang,
} from "./chronicleTime";
import { laneColorFor } from "./laneColor";
import { ChronicleDatePicker } from "./ChronicleDatePicker";

export interface ChronicleInspectorProps {
  event: EventRow;
  /** レーン（主人物）候補。任意の Codex を割り当て可能なので全件＋種別。 */
  laneOptions: { id: string; name: string; type: string }[];
  /** 場所候補（location 種別）。 */
  locations: { id: string; name: string }[];
  /** AI 秘匿の reveal アンカー候補（読む順のシーン）。 */
  scenes?: { id: string; title: string }[];
  calendar: ChronicleCalendar;
  conflicts?: SeasonConflict[];
  ageConflicts?: AgeConflict[];
  hasTwoPlacesIssue?: boolean;
  hasCausalIssue?: boolean;
  linkedSceneCount?: number;
  allEvents?: { id: string; title: string }[];
  causeIds?: string[];
  onAddCause?: (causeId: string) => void;
  onRemoveCause?: (causeId: string) => void;
  onStamp?: () => void;
  onPull?: () => void;
  onPatch: (patch: Partial<EventRow>) => void;
  onDelete: () => void;
  onClose: () => void;
  lang?: DateLang;
}

const selectCls =
  "h-7 min-w-0 max-w-44 rounded-md border border-border bg-card px-2 text-xs text-foreground";
const labelCls =
  "flex min-w-0 flex-col gap-1 text-[11px] text-muted-foreground";

function Banner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-xs text-amber-700 dark:text-amber-400">
      <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </div>
  );
}

/** 選択中の出来事を編集する下部インスペクタ（暦駆動の日時ピッカー統合）。 */
export function ChronicleInspector({
  event,
  laneOptions,
  locations,
  scenes = [],
  calendar,
  conflicts,
  ageConflicts,
  hasTwoPlacesIssue = false,
  hasCausalIssue = false,
  linkedSceneCount = 0,
  allEvents = [],
  causeIds = [],
  onAddCause,
  onRemoveCause,
  onStamp,
  onPull,
  onPatch,
  onDelete,
  onClose,
  lang,
}: ChronicleInspectorProps) {
  const { t } = useTranslation();
  const [picker, setPicker] = useState<{
    which: "start" | "end";
    anchor: { left: number; bottom: number };
  } | null>(null);

  const titleById = new Map(allEvents.map((e) => [e.id, e.title]));
  const causeOptions = allEvents.filter(
    (e) => e.id !== event.id && !causeIds.includes(e.id),
  );
  const startYear = calendar.startYear ?? 0;
  const isInterval = event.endTime != null;
  const lc = laneColorFor(event.primaryCodexId);

  const openPicker = (which: "start" | "end", el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.left, window.innerWidth - 308));
    setPicker({
      which,
      anchor: { left, bottom: window.innerHeight - r.top + 8 },
    });
  };

  const setGran = (which: "start" | "end", g: EventGranularity) => {
    if (which === "start") {
      if (g === "none") {
        onPatch({
          startGranularity: "none",
          startTime: null,
          startMinute: null,
        });
      } else {
        const base =
          event.startTime ?? dateToDayNumber({ year: startYear }, calendar);
        onPatch({ startGranularity: g, startTime: base });
      }
    }
  };

  const startResolved =
    event.startGranularity === "none"
      ? ""
      : formatChronicleDate(
          event.startTime,
          event.startMinute,
          event.startGranularity,
          calendar,
          lang,
        );
  const endResolved = isInterval
    ? formatChronicleDate(
        event.endTime,
        event.endMinute,
        event.endGranularity === "none" ? "day" : event.endGranularity,
        calendar,
        lang,
      )
    : "";

  const pickerDay =
    picker?.which === "start"
      ? (event.startTime ?? dateToDayNumber({ year: startYear }, calendar))
      : (event.endTime ??
        event.startTime ??
        dateToDayNumber({ year: startYear }, calendar));
  const pickerMinute =
    picker?.which === "start"
      ? (event.startMinute ?? 0)
      : (event.endMinute ?? 0);
  const pickerGran =
    picker?.which === "start"
      ? event.startGranularity
      : event.endGranularity === "none"
        ? "day"
        : event.endGranularity;

  return (
    <div className="max-h-[348px] shrink-0 overflow-auto border-t border-border bg-card">
      <div className="flex flex-col gap-3 p-3.5">
        {/* タイトル */}
        <div className="flex items-center gap-2.5">
          <span
            style={{
              flex: "none",
              width: 12,
              height: 12,
              borderRadius: "50%",
              background: event.primaryCodexId ? lc : "var(--muted-foreground)",
            }}
          />
          <input
            value={event.title}
            onChange={(e) => onPatch({ title: e.target.value })}
            placeholder={t("chronicle.untitled", "無題の出来事")}
            className="min-w-0 flex-1 bg-transparent text-base font-semibold text-foreground outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={t("chronicle.close", "閉じる")}
            className="grid size-[26px] flex-none place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            ×
          </button>
        </div>

        {/* 整合警告バナー */}
        {conflicts && conflicts.length > 0 && (
          <Banner>
            {t(
              "chronicle.seasonConflictDetail",
              "季節の矛盾: 時刻は{{eventSeason}}だが本文に{{sceneSeasons}}",
              {
                eventSeason: conflicts[0].eventSeason,
                sceneSeasons: [
                  ...new Set(conflicts.flatMap((c) => c.sceneSeasons)),
                ].join("・"),
              },
            )}
          </Banner>
        )}
        {hasCausalIssue && (
          <Banner>
            {t(
              "chronicle.causalConflict",
              "因果の矛盾: 結果が原因より前にある",
            )}
          </Banner>
        )}
        {ageConflicts && ageConflicts.length > 0 && (
          <Banner>
            {t(
              "chronicle.ageConflictDetail",
              "年齢の矛盾: 算出{{age}}歳だが本文に「{{word}}」",
              {
                age: ageConflicts[0].computedAge,
                word: ageConflicts[0].ageWord,
              },
            )}
          </Banner>
        )}
        {hasTwoPlacesIssue && (
          <Banner>
            {t(
              "chronicle.twoPlacesConflict",
              "2か所同時の矛盾: 同一人物が同時刻に別の場所にいる",
            )}
          </Banner>
        )}

        {/* 横幅があれば2カラムに流すカードグリッド（間延び解消） */}
        <div
          className="grid gap-3"
          style={{
            gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
            alignItems: "start",
          }}
        >
          {/* 基本フィールド（レーン/場所/種別/確度） */}
          <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
            <label className={labelCls}>
              {t("chronicle.lane", "レーン")}
              <select
                value={event.primaryCodexId ?? ""}
                onChange={(e) =>
                  onPatch({ primaryCodexId: e.target.value || null })
                }
                className={selectCls}
              >
                <option value="">
                  {t("chronicle.laneUnassigned", "（未割当）")}
                </option>
                {laneOptions.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.type && o.type !== "character"
                      ? `${o.name}（${t(`chronicle.laneType.${o.type}`, o.type)}）`
                      : o.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              {t("chronicle.location", "場所")}
              <select
                value={event.locationCodexId ?? ""}
                onChange={(e) =>
                  onPatch({ locationCodexId: e.target.value || null })
                }
                className={selectCls}
              >
                <option value="">{t("chronicle.none", "なし")}</option>
                {locations.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              {t("chronicle.kindLabel", "種別")}
              <select
                value={event.kind}
                onChange={(e) =>
                  onPatch({ kind: e.target.value as EventRow["kind"] })
                }
                className={selectCls}
              >
                {EVENT_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(`chronicle.kind.${k}`, k)}
                  </option>
                ))}
              </select>
            </label>
            <label className={labelCls}>
              {t("chronicle.precisionLabel", "日付の確度")}
              <select
                value={event.precision}
                onChange={(e) =>
                  onPatch({
                    precision: e.target.value as EventRow["precision"],
                  })
                }
                className={selectCls}
              >
                {EVENT_PRECISIONS.map((p) => (
                  <option key={p} value={p}>
                    {t(`chronicle.precision.${p}`, p)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {/* 開始 / 終了 日時 */}
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-7 flex-none text-[11px] text-muted-foreground">
                {t("chronicle.startTime", "開始")}
              </span>
              <select
                value={event.startGranularity}
                onChange={(e) =>
                  setGran("start", e.target.value as EventGranularity)
                }
                aria-label={t("chronicle.startGranularity", "開始の粒度")}
                className={selectCls}
              >
                {EVENT_GRANULARITIES.map((g) => (
                  <option key={g} value={g}>
                    {t(`chronicle.granularity.${g}`, g)}
                  </option>
                ))}
              </select>
              {event.startGranularity !== "none" ? (
                <button
                  type="button"
                  onClick={(e) => openPicker("start", e.currentTarget)}
                  className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-accent"
                  style={{ fontFeatureSettings: "'tnum'" }}
                >
                  <CalendarDays className="size-3.5 opacity-70" />
                  {startResolved}
                </button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {t("chronicle.timeUnset", "時刻は未指定（並び順のみ）")}
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-7 flex-none text-[11px] text-muted-foreground">
                {t("chronicle.endTime", "終了")}
              </span>
              {isInterval ? (
                <>
                  <button
                    type="button"
                    onClick={(e) => openPicker("end", e.currentTarget)}
                    className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-foreground hover:bg-accent"
                    style={{ fontFeatureSettings: "'tnum'" }}
                  >
                    <CalendarDays className="size-3.5 opacity-70" />
                    {endResolved}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      onPatch({
                        endTime: null,
                        endGranularity: "none",
                        endMinute: null,
                      })
                    }
                    className="h-[26px] rounded-md border border-border bg-card px-2 text-[11px] text-muted-foreground hover:bg-accent"
                  >
                    {t("chronicle.makePoint", "点にする")}
                  </button>
                </>
              ) : (
                <>
                  <span className="text-xs text-muted-foreground">
                    {t("chronicle.unset", "未指定")}
                  </span>
                  {event.startGranularity !== "none" && (
                    <button
                      type="button"
                      onClick={() =>
                        onPatch({
                          endTime: (event.startTime ?? 0) + 60,
                          endGranularity: "day",
                          endMinute: 0,
                        })
                      }
                      className="h-[26px] rounded-md border border-border bg-card px-2 text-[11px] text-muted-foreground hover:bg-accent"
                    >
                      {t("chronicle.makeInterval", "期間にする")}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* 原因 */}
          {(causeIds.length > 0 || onAddCause) && (
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-none text-[11px] text-muted-foreground">
                {t("chronicle.causes", "原因")}
              </span>
              {causeIds.map((cid) => (
                <span
                  key={cid}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-accent/60 py-0.5 pl-2.5 pr-1.5 text-xs"
                >
                  {titleById.get(cid) ||
                    t("chronicle.untitled", "無題の出来事")}
                  {onRemoveCause && (
                    <button
                      type="button"
                      onClick={() => onRemoveCause(cid)}
                      aria-label={t("chronicle.removeCause", "原因を外す")}
                      className="text-muted-foreground hover:text-foreground"
                    >
                      ×
                    </button>
                  )}
                </span>
              ))}
              {onAddCause && causeOptions.length > 0 && (
                <select
                  value=""
                  onChange={(e) => {
                    if (e.target.value) onAddCause(e.target.value);
                  }}
                  aria-label={t("chronicle.addCause", "原因を追加")}
                  className={selectCls}
                >
                  <option value="">
                    {t("chronicle.addCause", "＋原因を追加")}
                  </option>
                  {causeOptions.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.title || t("chronicle.untitled", "無題の出来事")}
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* AI 秘匿 */}
          <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5">
            <label className="flex items-center gap-2 text-xs text-foreground">
              <input
                type="checkbox"
                checked={event.secret}
                onChange={(e) => onPatch({ secret: e.target.checked })}
                style={{ accentColor: "var(--primary)" }}
                className="size-4"
              />
              {t("chronicle.secretLabel", "AI に秘匿（ネタバレ防止）")}
            </label>
            {event.secret && (
              <div className="flex flex-wrap items-center gap-2 pl-6">
                <span className="text-[11px] text-muted-foreground">
                  {t("chronicle.revealSceneLabel", "開示シーン")}
                </span>
                <select
                  value={event.revealSceneId ?? ""}
                  onChange={(e) => onPatch({ revealSceneId: e.target.value })}
                  aria-label={t("chronicle.revealSceneLabel", "開示シーン")}
                  className={selectCls}
                >
                  <option value="">
                    {t("chronicle.revealSceneAuto", "自動（初出シーン）")}
                  </option>
                  {scenes.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || t("chronicle.untitledScene", "無題のシーン")}
                    </option>
                  ))}
                </select>
                <span className="min-w-40 flex-1 text-[11px] text-muted-foreground">
                  {t(
                    "chronicle.secretDescShort",
                    "開示シーン以降を書くときのみ AI に渡されます。",
                  )}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* アクション */}
        <div className="flex items-center gap-2">
          {linkedSceneCount > 0 && onStamp && (
            <button
              type="button"
              onClick={onStamp}
              title={t(
                "chronicle.stampHint",
                "この時刻を参照シーンの作中時間へ刻む",
              )}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs hover:bg-accent"
            >
              <ArrowDownToLine className="size-3.5" />
              {t("chronicle.stamp", "シーンへ刻む")}
            </button>
          )}
          {linkedSceneCount > 0 && onPull && (
            <button
              type="button"
              onClick={onPull}
              title={t(
                "chronicle.pullHint",
                "参照シーンの作中時間をこの出来事へ取り込む",
              )}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-card px-3 text-xs hover:bg-accent"
            >
              <ArrowUpFromLine className="size-3.5" />
              {t("chronicle.pull", "シーンから取込")}
            </button>
          )}
          <button
            type="button"
            onClick={onDelete}
            className="ms-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/30 bg-card px-3 text-xs text-destructive hover:bg-destructive/10"
          >
            <Trash2 className="size-3.5" /> {t("chronicle.delete", "削除")}
          </button>
        </div>
      </div>

      {picker && (
        <ChronicleDatePicker
          which={picker.which}
          granularity={pickerGran as EventGranularity}
          calendar={calendar}
          day={pickerDay}
          minute={pickerMinute}
          anchor={picker.anchor}
          lang={lang}
          onCommitDay={(d) => {
            if (picker.which === "start") onPatch({ startTime: d });
            else onPatch({ endTime: Math.max(d, event.startTime ?? d) });
          }}
          onCommitMinute={(m) => {
            if (picker.which === "start") onPatch({ startMinute: m });
            else onPatch({ endMinute: m });
          }}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}
