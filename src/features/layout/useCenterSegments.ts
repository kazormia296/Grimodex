import { useMemo } from "react";
import { useLayoutStore } from "./layoutStore";
import type { ToolWindowPanelId } from "./layoutTypes";
import type { CenterSegment } from "./layoutTypes";

export interface CenterStripeSegment {
  kind: "editor" | "tool";
  key: string;
  slotId: string;
  sizeRatio: number;
  /** stripe 比率配分: editor は editorOpen、tool は activePanel !== null */
  open: boolean;
  panels: Array<{ id: ToolWindowPanelId; active: boolean }>;
}

function segmentFromCenterTool(
  segment: Extract<CenterSegment, { kind: "tool" }>,
  hiddenStripePanels: ReadonlySet<ToolWindowPanelId>,
): CenterStripeSegment | null {
  let visiblePanels = segment.panels.filter(
    (id) => !hiddenStripePanels.has(id),
  );
  // useRegionSegments と同様: 展開中の activePanel は stripe に出す。
  if (
    visiblePanels.length === 0 &&
    segment.activePanel !== null &&
    segment.panels.includes(segment.activePanel)
  ) {
    visiblePanels = [segment.activePanel];
  }
  if (visiblePanels.length === 0) return null;

  return {
    kind: "tool",
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

export function useCenterSegments(): CenterStripeSegment[] {
  const center = useLayoutStore((s) => s.layout.center);
  const hiddenStripePanels = useLayoutStore((s) => s.hiddenStripePanels);

  return useMemo(() => {
    const segments: CenterStripeSegment[] = [];
    for (const segment of center.segments) {
      if (segment.kind === "editor") {
        segments.push({
          kind: "editor",
          key: segment.id,
          slotId: segment.id,
          sizeRatio: segment.sizeRatio,
          open: center.editorOpen,
          panels: [],
        });
        continue;
      }
      const toolSegment = segmentFromCenterTool(segment, hiddenStripePanels);
      if (toolSegment) segments.push(toolSegment);
    }
    return segments;
  }, [center, hiddenStripePanels]);
}
