import { Fragment, useCallback } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "./layoutStore";
import { Splitter } from "./Splitter";
import { SlotView } from "./SlotView";
import type { RegionId } from "./layoutTypes";
import {
  getOpenSlotPixelSizes,
  getRegionContentSize,
} from "./layoutStateUtils";

interface RegionContentProps {
  region: RegionId;
  orientation: "vertical" | "horizontal";
}

export function RegionContent({ region, orientation }: RegionContentProps) {
  const layout = useLayoutStore((s) => s.layout);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const setSlotRatios = useLayoutStore((s) => s.setSlotRatios);
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);

  const contentSize = getRegionContentSize(region, layout);
  const regionState = layout.regions[region];
  const openSlots = regionState.slots.filter((s) => s.activePanel !== null);
  const pixelSizes = getOpenSlotPixelSizes(region, layout);

  const handleSlotDrop = useCallback(
    (slotId: string, e: React.DragEvent) => {
      e.preventDefault();
      if (layoutLocked) return;
      const panelId =
        draggingPanel ??
        (e.dataTransfer.getData("application/grimodex-toolwindow-reassign") as
          | import("./layoutTypes").ToolWindowPanelId
          | "");
      if (!panelId) return;
      movePanelToSlot(panelId, region, slotId);
      setDraggingPanel(null);
    },
    [
      draggingPanel,
      layoutLocked,
      movePanelToSlot,
      region,
      setDraggingPanel,
    ],
  );

  const handleSlotDragOver = useCallback(
    (e: React.DragEvent) => {
      if (layoutLocked) return;
      if (
        e.dataTransfer.types.includes(
          "application/grimodex-toolwindow-reassign",
        )
      ) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    },
    [layoutLocked],
  );

  if (contentSize <= 0) return null;

  return (
    <div
      data-region-content={region}
      className={cn(
        "flex h-full min-h-0 w-full min-w-0 overflow-hidden",
        orientation === "vertical" ? "flex-col" : "flex-row",
      )}
    >
      {openSlots.map((slot, index) => {
        const sizePx = pixelSizes.get(slot.id) ?? 0;
        const style =
          orientation === "vertical"
            ? { height: sizePx, flexShrink: 0 }
            : { width: sizePx, flexShrink: 0 };

        return (
          <Fragment key={slot.id}>
            {index > 0 && (
              <Splitter
                orientation={
                  orientation === "vertical" ? "horizontal" : "vertical"
                }
                disabled={layoutLocked}
                onDrag={(delta) => {
                  const prevSlot = openSlots[index - 1];
                  const prevPx = pixelSizes.get(prevSlot.id) ?? 0;
                  const currPx = pixelSizes.get(slot.id) ?? 0;
                  const newPrev = Math.max(40, prevPx + delta);
                  const newCurr = Math.max(40, currPx - delta);
                  setSlotRatios(
                    region,
                    prevSlot.id,
                    slot.id,
                    newPrev,
                    newCurr,
                  );
                }}
              />
            )}
            <div
              data-drop-slot={slot.id}
              style={style}
              className="relative min-h-0 min-w-0 overflow-hidden"
              onDragOver={handleSlotDragOver}
              onDrop={(e) => handleSlotDrop(slot.id, e)}
            >
              {slot.activePanel && <SlotView panelId={slot.activePanel} />}
            </div>
          </Fragment>
        );
      })}

      {draggingPanel && !layoutLocked && (
        <div
          data-drop-new-slot={region}
          className="flex-1 opacity-0"
          onDragOver={handleSlotDragOver}
          onDrop={(e) => {
            e.preventDefault();
            if (!draggingPanel) return;
            movePanelToNewSlot(draggingPanel, region, openSlots.length);
            setDraggingPanel(null);
          }}
        />
      )}
    </div>
  );
}
