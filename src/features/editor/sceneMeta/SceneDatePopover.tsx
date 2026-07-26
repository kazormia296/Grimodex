import type { RefObject } from "react";
import { useTranslation } from "react-i18next";
import {
  EVENT_PRECISIONS,
  type EventGranularity,
  type EventPrecision,
} from "@/db/schema";
import { cn } from "@/lib/utils";
import {
  useTreeStore,
  type TreeNodeData,
  type ChronicleDatePatch,
} from "@/features/tree/treeStore";
import type { ChronicleCalendar } from "@/features/chronicle/chronicleTime";
import { useProjectCalendar } from "@/features/chronicle/useProjectCalendar";
import {
  EventDateFields,
  type EventDatePatch,
} from "@/features/chronicle/EventDateFields";
import { AnchoredPopoverShell } from "./AnchoredPopoverShell";

/** 暦未設定時のフォールバック暦（SceneDateEditor と同じ挙動）。 */
const FALLBACK_CALENDAR: ChronicleCalendar = {
  daysPerYear: 360,
  seasonBoundaries: [],
};

/** EventDateFields の patch（start/end ベース）を node の chronicle* 列へ写像する。 */
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

/** Radix Popover (ChronicleDatePicker) の portal 先クリックを「内側」扱いにする。 */
function isInsideRadixPopper(target: Node): boolean {
  const el = target instanceof Element ? target : target.parentElement;
  return !!el?.closest("[data-radix-popper-content-wrapper]");
}

interface SceneDatePopoverProps {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLElement | null>;
  node: TreeNodeData;
}

/**
 * 作中日付の編集ポップオーバー (1f/1h 共有)。
 * events と共有の EventDateFields + 確度3ボタン（確定/推定/不明）。
 * 保存は treeStore.updateChronicleDate（undo/OCC 連動の既存経路）。
 */
export function SceneDatePopover({
  open,
  onClose,
  triggerRef,
  node,
}: SceneDatePopoverProps) {
  const { t, i18n } = useTranslation();
  const { calendar } = useProjectCalendar(node.projectId);
  const updateChronicleDate = useTreeStore((s) => s.updateChronicleDate);

  const cal = calendar ?? FALLBACK_CALENDAR;
  const lang = i18n.language?.startsWith("en") ? "en" : "ja";
  const precision = (node.chroniclePrecision ?? "exact") as EventPrecision;

  return (
    <AnchoredPopoverShell
      open={open}
      onClose={onClose}
      triggerRef={triggerRef}
      ariaLabel={t("chronicle.sceneDate", "作中日付")}
      className="w-[300px] p-3"
      isInsideClick={isInsideRadixPopper}
      testId="scene-date-popover"
    >
      <EventDateFields
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
        lang={lang}
      />
      <div className="mt-2.5 flex items-center gap-1.5 border-t border-border/60 pt-2.5">
        <span className="text-[10px] text-muted-foreground">
          {t("chronicle.precisionLabel", "日付の確度")}
        </span>
        <div
          role="radiogroup"
          aria-label={t("chronicle.precisionLabel", "日付の確度")}
          className="flex items-center gap-1"
        >
          {EVENT_PRECISIONS.map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={p === precision}
              onClick={() =>
                void updateChronicleDate(node.id, { chroniclePrecision: p })
              }
              className={cn(
                "rounded-md border px-2 py-0.5 text-[10px] font-medium transition-colors",
                p === precision
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-border bg-background text-muted-foreground hover:bg-accent",
              )}
            >
              {t(`chronicle.precision.${p}`, p)}
            </button>
          ))}
        </div>
      </div>
    </AnchoredPopoverShell>
  );
}
