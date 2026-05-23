import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { PANEL_ICON_MAP } from "./panelIcons";
import { useLayoutStore } from "./layoutStore";

/** Follows the pointer during stripe / dropdown pointer-drag sessions. */
export function LayoutPanelDragGhost() {
  const { t } = useTranslation();
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const dragSource = useLayoutStore((s) => s.panelDragSource);
  const dragOffset = useLayoutStore((s) => s.panelDragOffset);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!draggingPanel || dragSource !== "pointer") {
      setPos(null);
      return;
    }

    function onMove(e: PointerEvent) {
      setPos({ x: e.clientX, y: e.clientY });
    }

    document.addEventListener("pointermove", onMove);
    return () => document.removeEventListener("pointermove", onMove);
  }, [dragSource, draggingPanel]);

  if (!draggingPanel || dragSource !== "pointer" || !pos) return null;

  const Icon = PANEL_ICON_MAP[draggingPanel];
  const offsetX = dragOffset?.x ?? 14;
  const offsetY = dragOffset?.y ?? 14;

  return createPortal(
    <div
      data-panel-drag-ghost
      className={cn(
        "pointer-events-none fixed z-[9999] flex items-center gap-1.5 rounded-full",
        "border border-primary/40 bg-popover/95 px-2 py-1 shadow-lg backdrop-blur-sm",
      )}
      style={{
        left: pos.x - offsetX,
        top: pos.y - offsetY,
      }}
    >
      <Icon className="h-4 w-4 shrink-0 text-foreground" />
      <span className="max-w-[10rem] truncate text-xs text-foreground">
        {t(`layout.panel.${draggingPanel}`)}
      </span>
    </div>,
    document.body,
  );
}
