import { useMemo } from "react";
import { useLayoutStore } from "./layoutStore";
import type { RegionId, SlotState, ToolWindowPanelId } from "./layoutTypes";

export interface RegionSegment {
  key: string;
  slotId: string;
  sizeRatio: number;
  panels: Array<{ id: ToolWindowPanelId; active: boolean }>;
}

function segmentFromSlot(slot: SlotState): RegionSegment {
  return {
    key: slot.id,
    slotId: slot.id,
    sizeRatio: slot.sizeRatio,
    panels: slot.panels.map((id) => ({
      id,
      active: slot.activePanel === id,
    })),
  };
}

function segmentsFromSlots(slots: SlotState[]): RegionSegment[] {
  return slots
    .filter((slot) => slot.panels.length > 0)
    .map((slot) => segmentFromSlot(slot));
}

export function useRegionSegments(): Record<RegionId, RegionSegment[]> {
  const leftSlots = useLayoutStore((s) => s.layout.regions.left.slots);
  const rightSlots = useLayoutStore((s) => s.layout.regions.right.slots);
  const bottomSlots = useLayoutStore((s) => s.layout.regions.bottom.slots);

  const left = useMemo(
    () => segmentsFromSlots(leftSlots),
    [leftSlots],
  );
  const right = useMemo(
    () => segmentsFromSlots(rightSlots),
    [rightSlots],
  );
  const bottom = useMemo(
    () => segmentsFromSlots(bottomSlots),
    [bottomSlots],
  );

  return useMemo(
    () => ({ left, right, bottom }),
    [bottom, left, right],
  );
}

export { getOpenSlotPixelSizes, getRegionContentSize } from "./layoutStateUtils";
