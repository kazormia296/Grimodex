import { useMemo } from "react";
import { useLayoutStore } from "./layoutStore";
import type { ToolWindowPanelId } from "./layoutTypes";
import { getToolSegments } from "./layoutStateUtils";
import type { RegionSegment } from "./useRegionSegments";

function segmentFromCenterTool(
  segment: ReturnType<typeof getToolSegments>[number],
  hiddenStripePanels: ReadonlySet<ToolWindowPanelId>,
): RegionSegment | null {
  const visiblePanels = segment.panels.filter(
    (id) => !hiddenStripePanels.has(id),
  );
  if (visiblePanels.length === 0) return null;

  return {
    key: segment.id,
    slotId: segment.id,
    sizeRatio: segment.sizeRatio,
    open: segment.activePanel !== null,
    panels: visiblePanels.map((id) => ({
      id,
      active: segment.activePanel === id,
    })),
  };
}

export function useCenterSegments(): RegionSegment[] {
  const center = useLayoutStore((s) => s.layout.center);
  const hiddenStripePanels = useLayoutStore((s) => s.hiddenStripePanels);

  return useMemo(() => {
    const segments: RegionSegment[] = [];
    for (const toolSegment of getToolSegments(center)) {
      const segment = segmentFromCenterTool(toolSegment, hiddenStripePanels);
      if (segment) segments.push(segment);
    }
    return segments;
  }, [center, hiddenStripePanels]);
}
