import { useTranslation } from "react-i18next";
import { Trash2, AlertTriangle } from "lucide-react";
import { EVENT_PRECISIONS } from "@/db/schema";
import type { EventRow } from "./api";
import type { SeasonConflict } from "./seasonCheck";

export interface ChronicleInspectorProps {
  event: EventRow;
  people: { id: string; name: string }[];
  conflicts?: SeasonConflict[];
  onPatch: (patch: Partial<EventRow>) => void;
  onDelete: () => void;
}

/** 選択中の出来事を編集する小パネル（時刻/precision/主人物/削除）。 */
export function ChronicleInspector({
  event,
  people,
  conflicts,
  onPatch,
  onDelete,
}: ChronicleInspectorProps) {
  const { t } = useTranslation();

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
