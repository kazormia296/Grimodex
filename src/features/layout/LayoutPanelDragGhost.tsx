import { createPortal } from "react-dom";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLayoutStore } from "./layoutStore";

/** Follows the pointer during panel dropdown pointer-drag sessions. */
export function LayoutPanelDragGhost() {
  const { t } = useTranslation();
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const dragSource = useLayoutStore((s) => s.panelDragSource);
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

  return createPortal(
    <div
      data-panel-drag-ghost
      className="pointer-events-none fixed z-[9999] -translate-x-1/2 -translate-y-1/2 rounded-md border border-primary/40 bg-popover px-2 py-1 text-xs shadow-lg"
      style={{ left: pos.x, top: pos.y }}
    >
      {t(`layout.panel.${draggingPanel}`)}
    </div>,
    document.body,
  );
}
