import { useTranslation } from "react-i18next";
import {
  Trash2,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
} from "lucide-react";
import { EVENT_PRECISIONS } from "@/db/schema";
import type { EventRow } from "./api";
import type { SeasonConflict } from "./seasonCheck";
import type { AgeConflict } from "./ageCheck";

export interface ChronicleInspectorProps {
  event: EventRow;
  people: { id: string; name: string }[];
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
  people,
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

  const numOrNull = (v: string): number | null => {
    const n = Number(v);
    return v.trim() === "" || Number.isNaN(n) ? null : n;
  };

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
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <label className="flex items-center gap-1">
          {t("chronicle.startTime", "開始")}
          <input
            type="number"
            value={event.startTime ?? ""}
            onChange={(e) => onPatch({ startTime: numOrNull(e.target.value) })}
            className="w-20 rounded border bg-transparent px-1 py-0.5"
          />
        </label>
        <label className="flex items-center gap-1">
          {t("chronicle.endTime", "終了")}
          <input
            type="number"
            value={event.endTime ?? ""}
            onChange={(e) => onPatch({ endTime: numOrNull(e.target.value) })}
            className="w-20 rounded border bg-transparent px-1 py-0.5"
          />
        </label>
        <label className="flex items-center gap-1">
          {t("chronicle.precisionLabel", "確度")}
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
          <select
            value={event.primaryCodexId ?? ""}
            onChange={(e) =>
              onPatch({ primaryCodexId: e.target.value || null })
            }
            className="max-w-32 rounded border bg-transparent px-1 py-0.5"
          >
            <option value="">{t("chronicle.none", "なし")}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1">
          {t("chronicle.location", "場所")}
          <select
            value={event.locationCodexId ?? ""}
            onChange={(e) =>
              onPatch({ locationCodexId: e.target.value || null })
            }
            className="max-w-32 rounded border bg-transparent px-1 py-0.5"
          >
            <option value="">{t("chronicle.none", "なし")}</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label
          className="flex items-center gap-1"
          title={t("chronicle.birthHint", "主人物の出生。年齢計算の基準点")}
        >
          <input
            type="checkbox"
            checked={event.kind === "birth"}
            onChange={(e) =>
              onPatch({ kind: e.target.checked ? "birth" : "generic" })
            }
          />
          {t("chronicle.birth", "出生")}
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
