import { useCallback, useRef } from "react";
import type { PanelId } from "./panelIds";
import {
  PANEL_POINTER_DRAG_THRESHOLD_PX,
  performToolWindowDrop,
  resolveDropTargetFromPoint,
} from "./layoutDnD";
import { useLayoutStore } from "./layoutStore";
import type { ToolWindowPanelId } from "./layoutTypes";

interface UsePanelDropdownPointerDragOptions {
  layoutLocked: boolean;
  onDragSessionStart?: () => void;
  onDragSessionEnd?: () => void;
  togglePanel: (panel: PanelId) => void;
}

export function usePanelDropdownPointerDrag({
  layoutLocked,
  onDragSessionStart,
  onDragSessionEnd,
  togglePanel,
}: UsePanelDropdownPointerDragOptions) {
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const reorderPanelInSlot = useLayoutStore((s) => s.reorderPanelInSlot);
  const sessionRef = useRef<{
    pointerId: number;
    panelId: ToolWindowPanelId;
    startX: number;
    startY: number;
    dragging: boolean;
    element: HTMLElement;
  } | null>(null);

  const endSession = useCallback(
    (clearStore: boolean) => {
      sessionRef.current = null;
      if (clearStore) {
        setDraggingPanel(null);
        setDragOverTarget(null);
      }
      onDragSessionEnd?.();
    },
    [onDragSessionEnd, setDragOverTarget, setDraggingPanel],
  );

  const handleRowPointerDown = useCallback(
    (panelId: ToolWindowPanelId, e: React.PointerEvent<HTMLElement>) => {
      if (layoutLocked || e.button !== 0) return;

      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;

      sessionRef.current = {
        pointerId,
        panelId,
        startX,
        startY,
        dragging: false,
        element: e.currentTarget,
      };

      e.currentTarget.setPointerCapture(pointerId);

      const onMove = (ev: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || ev.pointerId !== pointerId) return;

        const dx = ev.clientX - session.startX;
        const dy = ev.clientY - session.startY;
        if (!session.dragging) {
          if (
            dx * dx + dy * dy <
            PANEL_POINTER_DRAG_THRESHOLD_PX * PANEL_POINTER_DRAG_THRESHOLD_PX
          ) {
            return;
          }
          session.dragging = true;
          const rect = session.element.getBoundingClientRect();
          setDraggingPanel(session.panelId, "pointer", {
            x: session.startX - rect.left,
            y: session.startY - rect.top,
          });
          onDragSessionStart?.();
        }

        setDragOverTarget(resolveDropTargetFromPoint(ev.clientX, ev.clientY));
      };

      const onUp = (ev: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || ev.pointerId !== pointerId) return;

        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);

        if (session.element.hasPointerCapture?.(pointerId)) {
          session.element.releasePointerCapture(pointerId);
        }

        if (session.dragging) {
          ev.preventDefault();
          const target = resolveDropTargetFromPoint(ev.clientX, ev.clientY);
          if (target && !layoutLocked) {
            performToolWindowDrop(target, session.panelId, {
              movePanelToSlot,
              movePanelToNewSlot,
              reorderPanelInSlot,
            });
          }
          endSession(true);
          return;
        }

        togglePanel(session.panelId);
        endSession(false);
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [
      endSession,
      layoutLocked,
      movePanelToNewSlot,
      movePanelToSlot,
      onDragSessionStart,
      reorderPanelInSlot,
      setDragOverTarget,
      setDraggingPanel,
      togglePanel,
    ],
  );

  return { handleRowPointerDown };
}
