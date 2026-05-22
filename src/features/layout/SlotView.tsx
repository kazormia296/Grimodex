import { memo } from "react";
import { cn } from "@/lib/utils";
import type { ToolWindowPanelId } from "./layoutTypes";
import { PANEL_COMPONENT_MAP } from "./panelComponents";
import { useLayoutStore } from "./layoutStore";

interface SlotViewProps {
  panelId: ToolWindowPanelId;
}

/** Renders the active panel component for a slot. Unmounts when inactive. */
export const SlotView = memo(function SlotView({ panelId }: SlotViewProps) {
  const Component = PANEL_COMPONENT_MAP[panelId];
  // Lift the card while its panel is being dragged (D案 drag-only treatment).
  const isDragging = useLayoutStore((s) => s.draggingPanel === panelId);
  return (
    <div
      data-slot-panel={panelId}
      className={cn(
        "gx-panel glass-region-panel flex h-full min-h-0 w-full min-w-0 flex-col overflow-hidden",
        isDragging && "gx-panel--dragging",
      )}
    >
      <Component />
    </div>
  );
});
