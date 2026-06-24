import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useTimelineStore } from "./timelineStore";
import { usePlotThreadStore } from "@/features/plot-threads/plotThreadStore";
import { PLOT_PHASE_TYPES, type PlotPhaseType } from "@/db/schema";

interface Props {
  linkId: string;
  phaseType: PlotPhaseType;
  x: number;
  y: number;
  onClose: () => void;
}

/**
 * プロットマーカー（点）の右クリックメニュー。段階変更 / メモ編集（選択 +
 * インスペクタを開く）/ マーカー削除。TimelineContextMenu と同じ portal パターン。
 */
export function PlotMarkerContextMenu({
  linkId,
  phaseType,
  x,
  y,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const updateMarker = usePlotThreadStore((s) => s.updateMarker);
  const deleteMarker = usePlotThreadStore((s) => s.deleteMarker);
  const setSelectedPlotLinkId = useTimelineStore(
    (s) => s.setSelectedPlotLinkId,
  );
  const toggleInspector = useTimelineStore((s) => s.toggleInspector);

  useEffect(() => {
    function handleMouseDown(e: MouseEvent) {
      if (!menuRef.current?.contains(e.target as Node)) onClose();
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const style: React.CSSProperties = {
    position: "fixed",
    left: Math.max(0, Math.min(x, window.innerWidth - 220)),
    top: Math.max(0, Math.min(y, window.innerHeight - 280)),
    zIndex: 9999,
  };

  return createPortal(
    <div
      ref={menuRef}
      data-testid="plot-marker-context-menu"
      style={style}
      className="min-w-[176px] rounded-md border border-border bg-popover py-1 shadow-lg"
    >
      {/* 段階変更 */}
      <div className="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {t("plotThread.phase", "段階")}
      </div>
      {PLOT_PHASE_TYPES.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => {
            void updateMarker(linkId, { phaseType: p });
            onClose();
          }}
          className={cn(
            "flex w-full items-center px-3 py-1.5 text-xs hover:bg-accent",
            phaseType === p && "font-medium text-foreground",
          )}
        >
          {t(`plotThread.phaseType.${p}`, p)}
        </button>
      ))}

      <div className="my-1 border-t border-border" />

      <button
        type="button"
        onClick={() => {
          setSelectedPlotLinkId(linkId);
          if (!useTimelineStore.getState().inspectorOpen) toggleInspector();
          onClose();
        }}
        className="flex w-full items-center px-3 py-1.5 text-left text-xs text-foreground hover:bg-accent"
      >
        {t("plotThread.editNote", "メモを編集")}
      </button>

      <div className="my-1 border-t border-border" />

      <button
        type="button"
        onClick={() => {
          void deleteMarker(linkId);
          if (useTimelineStore.getState().selectedPlotLinkId === linkId) {
            setSelectedPlotLinkId(null);
          }
          onClose();
        }}
        className="flex w-full items-center px-3 py-1.5 text-left text-xs text-[color:var(--destructive)] hover:bg-destructive/10"
      >
        {t("plotThread.deleteMarker", "マーカーを削除")}
      </button>
    </div>,
    document.body,
  );
}
