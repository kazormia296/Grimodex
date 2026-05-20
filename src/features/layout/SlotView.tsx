import type { ToolWindowPanelId } from "./layoutTypes";
import { PANEL_COMPONENT_MAP } from "./panelComponents";

interface SlotViewProps {
  panelId: ToolWindowPanelId;
}

/** Renders the active panel component for a slot. Unmounts when inactive. */
export function SlotView({ panelId }: SlotViewProps) {
  const Component = PANEL_COMPONENT_MAP[panelId];
  return (
    <div
      data-slot-panel={panelId}
      className="glass-region-panel h-full min-h-0 w-full min-w-0 overflow-hidden"
    >
      <Component />
    </div>
  );
}
