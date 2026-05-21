import {
  acceptsToolWindowReassignDrag,
  performToolWindowDrop,
  resolveCenterStripeDropFromPoint,
  TOOL_WINDOW_REASSIGN_TYPE,
  type CenterStripeDropSegment,
} from "./layoutDnD";
import { useLayoutStore } from "./layoutStore";
import type { ToolWindowPanelId } from "./layoutTypes";

interface CenterStripeDropOverlayProps {
  segments: ReadonlyArray<CenterStripeDropSegment>;
  slotIds: ReadonlyArray<string>;
  stripeEndInsertIndex: number;
}

/** Full-area drop catcher for Center Stripe (sits above bands while dragging). */
export function CenterStripeDropOverlay({
  segments,
  slotIds,
  stripeEndInsertIndex,
}: CenterStripeDropOverlayProps) {
  const layout = useLayoutStore((s) => s.layout);
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

  const fallbackTarget = {
    type: "new-slot" as const,
    region: "center" as const,
    insertIndex: stripeEndInsertIndex,
    surface: "stripe-end" as const,
  };

  const resolveTarget = (clientX: number, clientY: number) =>
    resolveCenterStripeDropFromPoint(
      clientX,
      clientY,
      segments,
      slotIds,
      stripeEndInsertIndex,
      layout,
    ) ?? fallbackTarget;

  const handleDragOver = (e: React.DragEvent) => {
    if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTarget(resolveTarget(e.clientX, e.clientY));
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOverTarget(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (layoutLocked) return;
    const panelId =
      draggingPanel ??
      (e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE) as
        | ToolWindowPanelId
        | "");
    if (!panelId) return;

    performToolWindowDrop(resolveTarget(e.clientX, e.clientY), panelId, {
      movePanelToSlot,
      movePanelToNewSlot,
    });
    setDraggingPanel(null);
    setDragOverTarget(null);
  };

  return (
    <div
      data-center-stripe-drop-overlay
      data-drop-region="center"
      className="absolute inset-0 z-40"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    />
  );
}
