import { useTranslation } from "react-i18next";
import {
  EVENT_PRECISIONS,
  type EventGranularity,
  type EventPrecision,
} from "@/db/schema";
import {
  useTreeStore,
  type TreeNodeData,
  type ChronicleDatePatch,
} from "@/features/tree/treeStore";
import type { ChronicleCalendar } from "./chronicleTime";
import { useProjectCalendar } from "./useProjectCalendar";
import { EventDateEditor, type EventDatePatch } from "./EventDateEditor";

interface SceneDateEditorProps {
  node: TreeNodeData;
}

/** 暦未設定時のフォールバック暦（ChronicleInspector と同じ挙動）。 */
const FALLBACK_CALENDAR: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [],
};

/** EventDateEditor の patch（start/end ベース）を node の chronicle* 列へ写像する。 */
function toChroniclePatch(p: EventDatePatch): ChronicleDatePatch {
  const out: ChronicleDatePatch = {};
  if ("startTime" in p) out.chronicleStartTime = p.startTime;
  if ("startMinute" in p) out.chronicleStartMinute = p.startMinute;
  if ("startGranularity" in p)
    out.chronicleStartGranularity = p.startGranularity;
  if ("endTime" in p) out.chronicleEndTime = p.endTime;
  if ("endMinute" in p) out.chronicleEndMinute = p.endMinute;
  if ("endGranularity" in p) out.chronicleEndGranularity = p.endGranularity;
  return out;
}

/**
 * シーンの作中暦日付を閲覧・編集する小セクション。events と同じ日付モデル
 * （EventDateEditor）をシーンに共有し、変更を treeStore.updateChronicleDate で
 * 永続化＋楽観反映する（POV/場所の保存と同経路）。scene 以外では描画しない。
 */
export function SceneDateEditor({ node }: SceneDateEditorProps) {
  const { t } = useTranslation();
  const { calendar } = useProjectCalendar(node.projectId);
  const updateChronicleDate = useTreeStore((s) => s.updateChronicleDate);

  if (node.nodeType !== "scene") return null;

  const cal = calendar ?? FALLBACK_CALENDAR;

  return (
    <div className="flex flex-shrink-0 flex-col gap-1.5 border-b border-border bg-muted/30 px-3 py-2">
      <span className="text-xs font-medium text-muted-foreground">
        {t("chronicle.sceneDate", "作中日付")}
      </span>
      <EventDateEditor
        calendar={cal}
        startTime={node.chronicleStartTime ?? null}
        startMinute={node.chronicleStartMinute ?? null}
        startGranularity={
          (node.chronicleStartGranularity ?? "none") as EventGranularity
        }
        endTime={node.chronicleEndTime ?? null}
        endMinute={node.chronicleEndMinute ?? null}
        endGranularity={
          (node.chronicleEndGranularity ?? "none") as EventGranularity
        }
        onPatch={(p) => void updateChronicleDate(node.id, toChroniclePatch(p))}
      />
      <label className="flex items-center gap-1 text-xs">
        <span className="text-muted-foreground">
          {t("chronicle.precisionLabel", "日付の確度")}
        </span>
        <select
          value={(node.chroniclePrecision ?? "exact") as EventPrecision}
          onChange={(e) =>
            void updateChronicleDate(node.id, {
              chroniclePrecision: e.target.value as EventPrecision,
            })
          }
          aria-label={t("chronicle.precisionLabel", "日付の確度")}
          className="rounded border bg-transparent px-1 py-0.5"
        >
          {EVENT_PRECISIONS.map((p) => (
            <option key={p} value={p}>
              {t(`chronicle.precision.${p}`, p)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
