import { Fragment, memo, useCallback, useRef } from "react";
import { cn } from "@/lib/utils";
import {
  acceptsToolWindowReassignDrag,
  TOOL_WINDOW_REASSIGN_TYPE,
} from "./layoutDnD";
import { useLayoutStore } from "./layoutStore";
import {
  DND_NEW_SLOT_BETWEEN_HALF_PX,
  DND_NEW_SLOT_EDGE_HIT_PX,
  PANEL_GAP_PX,
} from "./layoutConstants";
import { useDragDropZonesReady } from "./useDragDropZonesReady";
import { Splitter } from "./Splitter";
import { AnimatedSlotPanel } from "./AnimatedSlotPanel";
import { normalizeFlexGrow } from "./layoutStateUtils";
import type { RegionId } from "./layoutTypes";

interface RegionContentProps {
  region: RegionId;
  orientation: "vertical" | "horizontal";
}

function regionHasOpenSlots(slots: { activePanel: string | null }[]): boolean {
  return slots.some((slot) => slot.activePanel !== null);
}

function insertIndexBeforeSlot(
  slots: { id: string }[],
  slotId: string,
): number {
  const index = slots.findIndex((slot) => slot.id === slotId);
  return index < 0 ? slots.length : index;
}

function insertIndexAfterSlot(slots: { id: string }[], slotId: string): number {
  const index = slots.findIndex((slot) => slot.id === slotId);
  return index < 0 ? slots.length : index + 1;
}

export const RegionContent = memo(function RegionContent({
  region,
  orientation,
}: RegionContentProps) {
  const slots = useLayoutStore((s) => s.layout.regions[region].slots);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const containerRef = useRef<HTMLDivElement>(null);
  const nudgeAdjacentSlotSizes = useLayoutStore(
    (s) => s.nudgeAdjacentSlotSizes,
  );
  const finalizeLayoutResize = useLayoutStore((s) => s.finalizeLayoutResize);
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const showDropZones = useDragDropZonesReady(
    Boolean(draggingPanel && !layoutLocked),
  );

  const openSlots = slots.filter((s) => s.activePanel !== null);
  const slotFlexGrow = normalizeFlexGrow(openSlots.map((s) => s.sizeRatio));

  const getLayoutBudgetPx = useCallback(() => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return orientation === "vertical" ? rect.height : rect.width;
  }, [orientation]);

  const handleSlotDrop = useCallback(
    (slotId: string, e: React.DragEvent) => {
      e.preventDefault();
      if (layoutLocked) return;
      const panelId =
        draggingPanel ??
        (e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE) as
          | import("./layoutTypes").ToolWindowPanelId
          | "");
      if (!panelId) return;
      movePanelToSlot(panelId, region, slotId);
      setDraggingPanel(null);
      setDragOverTarget(null);
    },
    [
      draggingPanel,
      layoutLocked,
      movePanelToSlot,
      region,
      setDragOverTarget,
      setDraggingPanel,
    ],
  );

  const handleSlotDragOver = useCallback(
    (slotId: string, e: React.DragEvent) => {
      if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel))
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverTarget({ type: "slot", region, slotId });
    },
    [layoutLocked, region, setDragOverTarget],
  );

  const handleSlotDragLeave = useCallback(
    (e: React.DragEvent) => {
      if (e.currentTarget.contains(e.relatedTarget as Node)) return;
      setDragOverTarget(null);
    },
    [setDragOverTarget],
  );

  const handleNewSlotDragOver = useCallback(
    (
      insertIndex: number,
      surface: "content-start" | "content-end",
      e: React.DragEvent,
    ) => {
      if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel))
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverTarget({
        type: "new-slot",
        region,
        insertIndex,
        surface,
      });
    },
    [draggingPanel, layoutLocked, region, setDragOverTarget],
  );

  const handleBetweenSlotDragOver = useCallback(
    (insertIndex: number, e: React.DragEvent) => {
      if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel))
        return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOverTarget({
        type: "new-slot",
        region,
        insertIndex,
        surface: "content-between",
      });
    },
    [draggingPanel, layoutLocked, region, setDragOverTarget],
  );

  const handleNewSlotDrop = useCallback(
    (insertIndex: number, e: React.DragEvent) => {
      e.preventDefault();
      if (layoutLocked || !draggingPanel) return;
      movePanelToNewSlot(draggingPanel, region, insertIndex);
      setDraggingPanel(null);
      setDragOverTarget(null);
    },
    [
      draggingPanel,
      layoutLocked,
      movePanelToNewSlot,
      region,
      setDragOverTarget,
      setDraggingPanel,
    ],
  );

  const contentEndInsertIndex =
    openSlots.length > 0
      ? insertIndexAfterSlot(slots, openSlots[openSlots.length - 1].id)
      : slots.length;
  const contentStartInsertIndex =
    openSlots.length > 0 ? insertIndexBeforeSlot(slots, openSlots[0].id) : 0;

  if (!regionHasOpenSlots(slots)) return null;

  return (
    <div
      ref={containerRef}
      data-region-content={region}
      className={cn(
        // overflow visible: each slot's card draws its shadow into the gap.
        "relative flex h-full min-h-0 w-full min-w-0",
        orientation === "vertical" ? "flex-col" : "flex-row",
      )}
    >
      {openSlots.map((slot, index) => {
        const sizeStyle =
          orientation === "vertical"
            ? {
                flexGrow: slotFlexGrow[index],
                flexBasis: 0,
                flexShrink: 0,
                minHeight: 0,
              }
            : {
                flexGrow: slotFlexGrow[index],
                flexBasis: 0,
                flexShrink: 0,
                minWidth: 0,
              };

        return (
          <Fragment key={slot.id}>
            {index > 0 && (
              <div className="relative shrink-0">
                <Splitter
                  orientation={orientation}
                  thickness={PANEL_GAP_PX}
                  disabled={layoutLocked}
                  onDrag={(delta) => {
                    const prevSlot = openSlots[index - 1];
                    const layoutBudgetPx = getLayoutBudgetPx();
                    if (layoutBudgetPx <= 0) return;
                    nudgeAdjacentSlotSizes(
                      region,
                      prevSlot.id,
                      slot.id,
                      delta,
                      layoutBudgetPx,
                    );
                  }}
                  onDragEnd={finalizeLayoutResize}
                />
                {showDropZones && (
                  <div
                    data-drop-between
                    data-drop-region={region}
                    data-insert-index={insertIndexBeforeSlot(slots, slot.id)}
                    data-drop-surface="content-between"
                    className={cn(
                      "absolute z-30 opacity-0",
                      orientation === "vertical"
                        ? "left-0 right-0 cursor-row-resize"
                        : "bottom-0 top-0 cursor-col-resize",
                    )}
                    style={
                      orientation === "vertical"
                        ? {
                            top: -DND_NEW_SLOT_BETWEEN_HALF_PX,
                            bottom: -DND_NEW_SLOT_BETWEEN_HALF_PX,
                          }
                        : {
                            left: -DND_NEW_SLOT_BETWEEN_HALF_PX,
                            right: -DND_NEW_SLOT_BETWEEN_HALF_PX,
                          }
                    }
                    onDragOver={(e) =>
                      handleBetweenSlotDragOver(
                        insertIndexBeforeSlot(slots, slot.id),
                        e,
                      )
                    }
                    onDragLeave={handleSlotDragLeave}
                    onDrop={(e) =>
                      handleNewSlotDrop(
                        insertIndexBeforeSlot(slots, slot.id),
                        e,
                      )
                    }
                  />
                )}
              </div>
            )}
            <div
              data-drop-slot={slot.id}
              data-drop-region={region}
              style={sizeStyle}
              className="relative flex min-h-0 min-w-0 flex-col"
              onDragOver={(e) => handleSlotDragOver(slot.id, e)}
              onDragLeave={handleSlotDragLeave}
              onDrop={(e) => handleSlotDrop(slot.id, e)}
            >
              {slot.activePanel && (
                <AnimatedSlotPanel panelId={slot.activePanel} />
              )}
            </div>
          </Fragment>
        );
      })}

      {showDropZones && (
        <>
          <div
            data-drop-new-slot={region}
            data-drop-region={region}
            data-insert-index={contentStartInsertIndex}
            data-drop-surface="content-start"
            className="absolute z-10 opacity-0"
            style={
              orientation === "vertical"
                ? {
                    top: 0,
                    left: 0,
                    right: 0,
                    height: DND_NEW_SLOT_EDGE_HIT_PX,
                  }
                : {
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: DND_NEW_SLOT_EDGE_HIT_PX,
                  }
            }
            onDragOver={(e) =>
              handleNewSlotDragOver(contentStartInsertIndex, "content-start", e)
            }
            onDragLeave={handleSlotDragLeave}
            onDrop={(e) => handleNewSlotDrop(contentStartInsertIndex, e)}
          />
          <div
            data-drop-new-slot={region}
            data-drop-region={region}
            data-insert-index={contentEndInsertIndex}
            data-drop-surface="content-end"
            className="absolute z-10 opacity-0"
            style={
              orientation === "vertical"
                ? {
                    bottom: 0,
                    left: 0,
                    right: 0,
                    height: DND_NEW_SLOT_EDGE_HIT_PX,
                  }
                : {
                    top: 0,
                    bottom: 0,
                    right: 0,
                    width: DND_NEW_SLOT_EDGE_HIT_PX,
                  }
            }
            onDragOver={(e) =>
              handleNewSlotDragOver(contentEndInsertIndex, "content-end", e)
            }
            onDragLeave={handleSlotDragLeave}
            onDrop={(e) => handleNewSlotDrop(contentEndInsertIndex, e)}
          />
        </>
      )}
    </div>
  );
});
