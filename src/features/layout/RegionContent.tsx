import { Fragment, memo, useCallback, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useLayoutStore } from "./layoutStore";
import { Splitter } from "./Splitter";
import { SlotView } from "./SlotView";
import { getOpenSlotPixelSizesForRegion } from "./layoutStateUtils";
import type { RegionId } from "./layoutTypes";

interface RegionContentProps {
  region: RegionId;
  orientation: "vertical" | "horizontal";
}

function regionHasOpenSlots(
  slots: { activePanel: string | null }[],
): boolean {
  return slots.some((slot) => slot.activePanel !== null);
}

export const RegionContent = memo(function RegionContent({
  region,
  orientation,
}: RegionContentProps) {
  const slots = useLayoutStore((s) => s.layout.regions[region].slots);
  const regionSize = useLayoutStore((s) => s.layout.regions[region].size);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const nudgeAdjacentSlotSizes = useLayoutStore((s) => s.nudgeAdjacentSlotSizes);
  const finalizeLayoutResize = useLayoutStore((s) => s.finalizeLayoutResize);
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);

  const openSlots = slots.filter((s) => s.activePanel !== null);
  const pixelSizes = useMemo(
    () => getOpenSlotPixelSizesForRegion({ size: regionSize, slots }),
    [regionSize, slots],
  );

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

  if (!regionHasOpenSlots(slots)) return null;

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
        const sizeStyle =
          orientation === "vertical"
            ? { height: sizePx, flexShrink: 0, minHeight: 0 }
            : { width: sizePx, flexShrink: 0, minWidth: 0 };

        return (
          <Fragment key={slot.id}>
            {index > 0 && (
              <Splitter
                orientation={orientation}
                disabled={layoutLocked}
                onDrag={(delta) => {
                  const prevSlot = openSlots[index - 1];
                  nudgeAdjacentSlotSizes(region, prevSlot.id, slot.id, delta);
                }}
                onDragEnd={finalizeLayoutResize}
              />
            )}
            <div
              data-drop-slot={slot.id}
              style={sizeStyle}
              className="relative flex min-h-0 min-w-0 flex-col overflow-hidden"
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
});
