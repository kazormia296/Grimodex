import { useTranslation } from "react-i18next";
import {
  Trash2,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
} from "lucide-react";
import { EVENT_PRECISIONS, EVENT_KINDS } from "@/db/schema";
import type { EventRow } from "./api";
import type { SeasonConflict } from "./seasonCheck";
import type { AgeConflict } from "./ageCheck";
import type { ChronicleCalendar } from "./chronicleTime";
import { CodexEntryPicker } from "./CodexEntryPicker";
import { EventDateEditor, type EventDatePatch } from "./EventDateEditor";

export interface ChronicleInspectorProps {
  event: EventRow;
  /** 主人物候補（character 種別で絞り込み済み）。 */
  characters: { id: string; name: string }[];
  /** 場所候補（location 種別で絞り込み済み）。 */
  locations: { id: string; name: string }[];
  /** 暦（日付エディタの年/月/日/季節変換に使う）。 */
  calendar: ChronicleCalendar;
  conflicts?: SeasonConflict[];
  ageConflicts?: AgeConflict[];
  hasTwoPlacesIssue?: boolean;
  /** この出来事が参照するシーン数（pull/stamp の可否）。 */
  linkedSceneCount?: number;
  /** 原因セレクト用の全出来事（自分自身は除外して表示）。 */
  allEvents?: { id: string; title: string }[];
  /** この出来事の原因 event id 群。 */
  causeIds?: string[];
  /** 因果矛盾（効果が原因より前）に関与しているか。 */
  hasCausalIssue?: boolean;
  onAddCause?: (causeId: string) => void;
  onRemoveCause?: (causeId: string) => void;
  onStamp?: () => void;
  onPull?: () => void;
  onPatch: (patch: Partial<EventRow>) => void;
  onDelete: () => void;
}

/** 選択中の出来事を編集する小パネル（時刻/precision/主人物/原因/Timeline同期/削除）。 */
export function ChronicleInspector({
  event,
  characters,
  locations,
  calendar,
  conflicts,
  ageConflicts,
  hasTwoPlacesIssue = false,
  linkedSceneCount = 0,
  allEvents = [],
  causeIds = [],
  hasCausalIssue = false,
  onAddCause,
  onRemoveCause,
  onStamp,
  onPull,
  onPatch,
  onDelete,
}: ChronicleInspectorProps) {
  const { t } = useTranslation();
  const titleById = new Map(allEvents.map((e) => [e.id, e.title]));
  const causeOptions = allEvents.filter(
    (e) => e.id !== event.id && !causeIds.includes(e.id),
  );

  return (
    <div className="shrink-0 space-y-2 border-t p-3 text-sm">
      <input
        value={event.title}
        onChange={(e) => onPatch({ title: e.target.value })}
        placeholder={t("chronicle.untitled", "無題の出来事")}
        className="w-full bg-transparent font-medium outline-none"
      />
      {conflicts && conflicts.length > 0 && (
        <div className="flex items-start gap-1 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
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
          </span>
        </div>
      )}
      {hasCausalIssue && (
        <div className="flex items-start gap-1 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t(
              "chronicle.causalConflict",
              "因果の矛盾: 結果が原因より前にある",
            )}
          </span>
        </div>
      )}
      {ageConflicts && ageConflicts.length > 0 && (
        <div className="flex items-start gap-1 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t(
              "chronicle.ageConflictDetail",
              "年齢の矛盾: 算出{{age}}歳だが本文に「{{word}}」",
              {
                age: ageConflicts[0].computedAge,
                word: ageConflicts[0].ageWord,
              },
            )}
          </span>
        </div>
      )}
      {hasTwoPlacesIssue && (
        <div className="flex items-start gap-1 rounded bg-amber-500/10 px-2 py-1 text-xs text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            {t(
              "chronicle.twoPlacesConflict",
              "2か所同時の矛盾: 同一人物が同時刻に別の場所にいる",
            )}
          </span>
        </div>
      )}
      {(causeIds.length > 0 || onAddCause) && (
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">
            {t("chronicle.causes", "原因")}
          </span>
          {causeIds.map((cid) => (
            <span
              key={cid}
              className="inline-flex items-center gap-1 rounded bg-accent px-1.5 py-0.5"
            >
              {titleById.get(cid) || t("chronicle.untitled", "無題の出来事")}
              {onRemoveCause && (
                <button
                  type="button"
                  onClick={() => onRemoveCause(cid)}
                  aria-label={t("chronicle.removeCause", "原因を外す")}
                  className="opacity-60 hover:opacity-100"
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
              className="rounded border bg-transparent px-1 py-0.5"
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
      <EventDateEditor
        calendar={calendar}
        startTime={event.startTime}
        startMinute={event.startMinute}
        startGranularity={event.startGranularity}
        endTime={event.endTime}
        endMinute={event.endMinute}
        endGranularity={event.endGranularity}
        onPatch={(p: EventDatePatch) => onPatch(p)}
      />
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          {t("chronicle.precisionLabel", "日付の確度")}
          <select
            value={event.precision}
            onChange={(e) =>
              onPatch({ precision: e.target.value as EventRow["precision"] })
            }
            className="rounded border bg-transparent px-1 py-0.5"
          >
            {EVENT_PRECISIONS.map((p) => (
              <option key={p} value={p}>
                {t(`chronicle.precision.${p}`, p)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          {t("chronicle.primaryCodex", "主人物")}
          <CodexEntryPicker
            value={event.primaryCodexId}
            options={characters}
            onChange={(id) => onPatch({ primaryCodexId: id })}
            ariaLabel={t("chronicle.primaryCodex", "主人物")}
          />
        </label>
        <label className="flex items-center gap-1">
          {t("chronicle.location", "場所")}
          <CodexEntryPicker
            value={event.locationCodexId}
            options={locations}
            onChange={(id) => onPatch({ locationCodexId: id })}
            ariaLabel={t("chronicle.location", "場所")}
          />
        </label>
        <label className="flex items-center gap-1">
          {t("chronicle.kindLabel", "種別")}
          <select
            value={event.kind}
            onChange={(e) =>
              onPatch({ kind: e.target.value as EventRow["kind"] })
            }
            className="rounded border bg-transparent px-1 py-0.5"
          >
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {t(`chronicle.kind.${k}`, k)}
              </option>
            ))}
          </select>
        </label>
        {linkedSceneCount > 0 && onStamp && (
          <button
            type="button"
            onClick={onStamp}
            title={t(
              "chronicle.stampHint",
              "この時刻を参照シーンの作中時間へ刻む",
            )}
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-accent"
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
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 hover:bg-accent"
          >
            <ArrowUpFromLine className="size-3.5" />
            {t("chronicle.pull", "シーンから取込")}
          </button>
        )}
        <button
          type="button"
          onClick={onDelete}
          className="ml-auto inline-flex items-center gap-1 rounded px-2 py-1 text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="size-3.5" /> {t("chronicle.delete", "削除")}
        </button>
      </div>
    </div>
  );
}
