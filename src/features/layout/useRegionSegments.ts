import { useMemo } from "react";
import { useLayoutStore } from "./layoutStore";
import type { RegionId, SlotState, ToolWindowPanelId } from "./layoutTypes";

export interface RegionSegment {
  key: string;
  slotId: string;
  sizeRatio: number;
  panels: Array<{ id: ToolWindowPanelId; active: boolean }>;
}

function segmentFromSlot(
  slot: SlotState,
  hiddenStripePanels: ReadonlySet<ToolWindowPanelId>,
): RegionSegment | null {
  const visiblePanels = slot.panels.filter((id) => !hiddenStripePanels.has(id));
  if (visiblePanels.length === 0) return null;

  return {
    key: slot.id,
    slotId: slot.id,
    sizeRatio: slot.sizeRatio,
    panels: visiblePanels.map((id) => ({
      id,
      active: slot.activePanel === id,
    })),
  };
}

function segmentsFromSlots(
  slots: SlotState[],
  hiddenStripePanels: ReadonlySet<ToolWindowPanelId>,
): RegionSegment[] {
  const segments: RegionSegment[] = [];
  for (const slot of slots) {
    const segment = segmentFromSlot(slot, hiddenStripePanels);
    if (segment) segments.push(segment);
  }
  return segments;
}

export function useRegionSegments(): Record<RegionId, RegionSegment[]> {
  const leftSlots = useLayoutStore((s) => s.layout.regions.left.slots);
  const rightSlots = useLayoutStore((s) => s.layout.regions.right.slots);
  const bottomSlots = useLayoutStore((s) => s.layout.regions.bottom.slots);
  const hiddenStripePanels = useLayoutStore((s) => s.hiddenStripePanels);

  const left = useMemo(
    () => segmentsFromSlots(leftSlots, hiddenStripePanels),
    [hiddenStripePanels, leftSlots],
  );
  const right = useMemo(
    () => segmentsFromSlots(rightSlots, hiddenStripePanels),
    [hiddenStripePanels, rightSlots],
  );
  const bottom = useMemo(
    () => segmentsFromSlots(bottomSlots, hiddenStripePanels),
    [bottomSlots, hiddenStripePanels],
  );

  return useMemo(() => ({ left, right, bottom }), [bottom, left, right]);
}

export {
  getOpenSlotPixelSizes,
  getRegionContentSize,
} from "./layoutStateUtils";
