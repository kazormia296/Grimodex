import { useMemo } from "react";
import { useLayoutStore } from "./layoutStore";
import {
  getOpenSlotPixelSizes,
  getRegionContentSize,
} from "./layoutStateUtils";
import type { RegionId, SlotState, ToolWindowPanelId } from "./layoutTypes";


export interface RegionSegment {
  key: string;
  slotId: string;
  sizeRatio: number;
  panels: Array<{ id: ToolWindowPanelId; active: boolean }>;
}

export function useRegionSegments(): Record<RegionId, RegionSegment[]> {
  const layout = useLayoutStore((s) => s.layout);

  return useMemo(() => {
    const result = {} as Record<RegionId, RegionSegment[]>;
    for (const regionId of ["left", "right", "bottom"] as RegionId[]) {
      const region = layout.regions[regionId];
      result[regionId] = region.slots
        .filter((slot) => slot.panels.length > 0)
        .map((slot) => segmentFromSlot(slot));
    }
    return result;
  }, [layout]);
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

export { getOpenSlotPixelSizes, getRegionContentSize };
