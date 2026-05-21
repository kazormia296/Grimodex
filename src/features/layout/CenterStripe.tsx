import { useMemo } from "react";
import { cn } from "@/lib/utils";
import { CenterStripeBands } from "./CenterStripeBands";
import { isCenterBandVisible } from "./layoutStateUtils";
import {
  buildCenterStripeGridTemplateColumns,
  computeLayoutGridMetrics,
} from "./layoutMetrics";
import { useLayoutStore } from "./layoutStore";
import { useCenterSegments } from "./useCenterSegments";
import { useRegionSegments } from "./useRegionSegments";

function regionIsOpen(slots: { activePanel: string | null }[]): boolean {
  return slots.some((slot) => slot.activePanel !== null);
}

/**
 * 中央領域の最上段に常設される水平ストライプ（§4 of layout design doc）。
 *
 * center content 列と同じ segment 順・比率で editor / center tool アイコンを並べる。
 */
export function CenterStripe() {
  const segments = useCenterSegments();
  const regionSegments = useRegionSegments();
  const layout = useLayoutStore((s) => s.layout);

  const leftOpen = regionIsOpen(layout.regions.left.slots);
  const rightOpen = regionIsOpen(layout.regions.right.slots);
  const bottomOpen = regionIsOpen(layout.regions.bottom.slots);
  const hasLeft = regionSegments.left.some((s) => s.panels.length > 0);
  const hasRight = regionSegments.right.some((s) => s.panels.length > 0);
  const hasBottom = regionSegments.bottom.some((s) => s.panels.length > 0);
  const centerBandVisible = isCenterBandVisible(layout);

  const stripeColumns = useMemo(() => {
    const metrics = computeLayoutGridMetrics({
      hasLeft,
      hasRight,
      hasBottom,
      leftOpen,
      rightOpen,
      bottomOpen,
      centerBandVisible,
      leftSize: layout.regions.left.size,
      rightSize: layout.regions.right.size,
      bottomSize: layout.regions.bottom.size,
    });
    return buildCenterStripeGridTemplateColumns(metrics);
  }, [
    bottomOpen,
    centerBandVisible,
    hasBottom,
    hasLeft,
    hasRight,
    layout.regions.bottom.size,
    layout.regions.left.size,
    layout.regions.right.size,
    leftOpen,
    rightOpen,
  ]);

  return (
    <div
      data-center-stripe
      className="grid h-full w-full min-w-0 overflow-hidden border-b border-border bg-background/40"
      style={{ gridTemplateColumns: stripeColumns }}
    >
      <div aria-hidden className="min-h-0 min-w-0" />
      <div aria-hidden className="min-h-0 min-w-0" />
      <div
        className={cn(
          "min-h-0 overflow-hidden",
          centerBandVisible ? "min-w-0" : "min-w-max shrink-0",
        )}
      >
        <CenterStripeBands segments={segments} />
      </div>
      <div aria-hidden className="min-h-0 min-w-0" />
      <div aria-hidden className="min-h-0 min-w-0" />
    </div>
  );
}
