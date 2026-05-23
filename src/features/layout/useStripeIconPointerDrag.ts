import { useCallback, useRef } from "react";
import {
  PANEL_POINTER_DRAG_THRESHOLD_PX,
  performToolWindowDrop,
  resolveCenterStripeDropFromPoint,
  resolveDropTargetFromPoint,
  type CenterStripeDropSegment,
} from "./layoutDnD";
import {
  STRIPE_DRAG_LONG_PRESS_MS,
  STRIPE_ICON_GAP_PX,
  STRIPE_SWAP_AXIS_LOCK_PX,
} from "./layoutConstants";
import { useLayoutStore } from "./layoutStore";
import {
  axisPointerCoord,
  collectStripeIconRects,
  computeStripeAxisLockInsertIndex,
  computeStripeAxisLockPxOffsets,
  getSlotPanelIds,
  offAxisDelta,
  resolveStripeDragMode,
  stripeAxisForRegion,
  type StripeAxis,
  type StripeDragMode,
  type StripeIconRect,
} from "./layoutStripeSwap";
import type { LayoutRegionId, ToolWindowPanelId } from "./layoutTypes";

/**
 * Pointer drag for stripe tool window icons.
 * Pattern reference: leoweyr/react-ide-workspace-layout GlobalSideBar long-press drag
 * https://github.com/leoweyr/react-ide-workspace-layout
 * Axis-lock swap mirrors src/features/grid/gridDndUtils.ts + GridPanel.tsx.
 */

interface UseStripeIconPointerDragOptions {
  panelId: ToolWindowPanelId;
  region: LayoutRegionId;
  slotId: string;
  layoutLocked: boolean;
}

interface AxisLockSession {
  mode: StripeDragMode;
  startX: number;
  startY: number;
  region: LayoutRegionId;
  slotId: string;
  panels: ToolWindowPanelId[];
  siblingRects: Record<string, StripeIconRect>;
  axis: StripeAxis;
}

export function useStripeIconPointerDrag({
  panelId,
  region,
  slotId,
  layoutLocked,
}: UseStripeIconPointerDragOptions) {
  const togglePanel = useLayoutStore((s) => s.togglePanel);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const setStripeSwapPreview = useLayoutStore((s) => s.setStripeSwapPreview);
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const reorderPanelInSlot = useLayoutStore((s) => s.reorderPanelInSlot);
  const layout = useLayoutStore((s) => s.layout);

  const resolveTarget = useCallback(
    (clientX: number, clientY: number) => {
      const prevTarget = useLayoutStore.getState().dragOverTarget;
      const direct = resolveDropTargetFromPoint(clientX, clientY, {
        draggingPanel: panelId,
        sourceSlotId: slotId,
        prevTarget,
      });
      if (direct) return direct;

      const centerStripe = document.querySelector("[data-center-stripe]");
      if (!centerStripe) return null;
      const rect = centerStripe.getBoundingClientRect();
      if (
        clientX < rect.left ||
        clientX > rect.right ||
        clientY < rect.top ||
        clientY > rect.bottom
      ) {
        return null;
      }

      const slotIds = layout.center.segments.map((seg) => seg.id);
      const segments: CenterStripeDropSegment[] = layout.center.segments.map(
        (segment) => ({
          kind: segment.kind,
          slotId: segment.id,
          open:
            segment.kind === "editor"
              ? layout.center.editorOpen
              : segment.activePanel !== null,
          sizeRatio: segment.sizeRatio,
        }),
      );
      const stripeEndInsertIndex =
        slotIds.length > 0 ? slotIds.length : 0;

      return resolveCenterStripeDropFromPoint(
        clientX,
        clientY,
        segments,
        slotIds,
        stripeEndInsertIndex,
        layout,
      );
    },
    [layout, panelId, slotId],
  );

  const sessionRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    offsetX: number;
    offsetY: number;
    dragging: boolean;
    longPressFired: boolean;
    element: HTMLElement;
    longPressTimer: ReturnType<typeof setTimeout> | null;
    axisLock: AxisLockSession | null;
  } | null>(null);

  const clearSession = useCallback(() => {
    const session = sessionRef.current;
    if (session?.longPressTimer) {
      clearTimeout(session.longPressTimer);
    }
    sessionRef.current = null;
  }, []);

  const initAxisLockSession = useCallback(
    (startX: number, startY: number): AxisLockSession | null => {
      const panels = getSlotPanelIds(layout, region, slotId);
      if (!panels || panels.length <= 1) return null;

      const segmentEl = document.querySelector<HTMLElement>(
        `[data-drop-slot-id="${slotId}"]`,
      );
      if (!segmentEl) return null;

      const axis = stripeAxisForRegion(region);
      const siblingRects = collectStripeIconRects(segmentEl, panels, axis);
      if (!siblingRects[panelId]) return null;

      return {
        mode: "axis-locked",
        startX,
        startY,
        region,
        slotId,
        panels,
        siblingRects,
        axis,
      };
    },
    [layout, panelId, region, slotId],
  );

  const recomputeAxisLock = useCallback(
    (session: AxisLockSession, clientX: number, clientY: number) => {
      const dx = clientX - session.startX;
      const dy = clientY - session.startY;
      session.mode = resolveStripeDragMode(
        session.mode,
        offAxisDelta(session.axis, dx, dy),
        STRIPE_SWAP_AXIS_LOCK_PX,
      );

      if (session.mode === "free") {
        setStripeSwapPreview({
          mode: "free",
          slotId: session.slotId,
          offsets: {},
        });
        setDragOverTarget(resolveTarget(clientX, clientY));
        return;
      }

      const pointerCoord = axisPointerCoord(session.axis, clientX, clientY);
      const offsets = computeStripeAxisLockPxOffsets(
        panelId,
        pointerCoord,
        session.panels,
        session.siblingRects,
        STRIPE_ICON_GAP_PX,
      );
      setStripeSwapPreview({
        mode: "axis-locked",
        slotId: session.slotId,
        offsets,
      });
      setDragOverTarget(null);
    },
    [panelId, resolveTarget, setDragOverTarget, setStripeSwapPreview],
  );

  const startDragSession = useCallback(
    (offsetX: number, offsetY: number) => {
      const session = sessionRef.current;
      if (!session || session.dragging) return;
      session.dragging = true;
      session.longPressFired = true;
      session.axisLock = initAxisLockSession(session.startX, session.startY);
      if (session.axisLock) {
        setStripeSwapPreview({
          mode: "axis-locked",
          slotId,
          offsets: {},
        });
      }
      setDraggingPanel(panelId, "pointer", { x: offsetX, y: offsetY });
    },
    [initAxisLockSession, panelId, setDraggingPanel, setStripeSwapPreview, slotId],
  );

  const handlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLButtonElement>) => {
      if (layoutLocked || e.button !== 0) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const pointerId = e.pointerId;
      const startX = e.clientX;
      const startY = e.clientY;
      const offsetX = e.clientX - rect.left;
      const offsetY = e.clientY - rect.top;

      const longPressTimer = setTimeout(() => {
        startDragSession(offsetX, offsetY);
      }, STRIPE_DRAG_LONG_PRESS_MS);

      sessionRef.current = {
        pointerId,
        startX,
        startY,
        offsetX,
        offsetY,
        dragging: false,
        longPressFired: false,
        element: e.currentTarget,
        longPressTimer,
        axisLock: null,
      };

      e.currentTarget.setPointerCapture(pointerId);

      const onMove = (ev: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || ev.pointerId !== pointerId) return;

        const dx = ev.clientX - session.startX;
        const dy = ev.clientY - session.startY;
        if (!session.dragging) {
          if (
            dx * dx + dy * dy >=
            PANEL_POINTER_DRAG_THRESHOLD_PX * PANEL_POINTER_DRAG_THRESHOLD_PX
          ) {
            if (session.longPressTimer) {
              clearTimeout(session.longPressTimer);
              session.longPressTimer = null;
            }
            startDragSession(session.offsetX, session.offsetY);
          } else {
            return;
          }
        }

        if (session.axisLock) {
          recomputeAxisLock(session.axisLock, ev.clientX, ev.clientY);
          return;
        }

        setDragOverTarget(resolveTarget(ev.clientX, ev.clientY));
      };

      const onUp = (ev: PointerEvent) => {
        const session = sessionRef.current;
        if (!session || ev.pointerId !== pointerId) return;

        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("pointercancel", onUp);

        if (session.longPressTimer) {
          clearTimeout(session.longPressTimer);
        }

        if (session.element.hasPointerCapture?.(pointerId)) {
          session.element.releasePointerCapture(pointerId);
        }

        const dx = ev.clientX - session.startX;
        const dy = ev.clientY - session.startY;
        const moved =
          dx * dx + dy * dy >=
          PANEL_POINTER_DRAG_THRESHOLD_PX * PANEL_POINTER_DRAG_THRESHOLD_PX;

        if (session.dragging && moved) {
          ev.preventDefault();
          const axisLock = session.axisLock;
          if (axisLock?.mode === "axis-locked") {
            const pointerCoord = axisPointerCoord(
              axisLock.axis,
              ev.clientX,
              ev.clientY,
            );
            const insertIndex = computeStripeAxisLockInsertIndex(
              panelId,
              pointerCoord,
              axisLock.panels,
              axisLock.siblingRects,
            );
            if (insertIndex !== null && !layoutLocked) {
              reorderPanelInSlot(
                panelId,
                axisLock.region,
                axisLock.slotId,
                insertIndex,
              );
            }
          } else {
            const target = resolveTarget(ev.clientX, ev.clientY);
            if (target && !layoutLocked) {
              performToolWindowDrop(target, panelId, {
                movePanelToSlot,
                movePanelToNewSlot,
                reorderPanelInSlot,
              });
            }
          }
          setDraggingPanel(null);
          setDragOverTarget(null);
          setStripeSwapPreview(null);
          clearSession();
          return;
        }

        togglePanel(panelId);
        setDraggingPanel(null);
        setDragOverTarget(null);
        setStripeSwapPreview(null);
        clearSession();
      };

      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("pointercancel", onUp);
    },
    [
      clearSession,
      layoutLocked,
      movePanelToNewSlot,
      movePanelToSlot,
      panelId,
      reorderPanelInSlot,
      recomputeAxisLock,
      setDragOverTarget,
      setDraggingPanel,
      setStripeSwapPreview,
      slotId,
      startDragSession,
      togglePanel,
      resolveTarget,
    ],
  );

  return { handlePointerDown };
}
