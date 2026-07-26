import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { cn } from "@/lib/utils";
import { CenterStripeBands } from "./CenterStripeBands";
import { SideDockToggle } from "./SideDockToggle";
import { CenterStripeDropOverlay } from "./CenterStripeDropOverlay";
import { isCenterContentVisible } from "./layoutStateUtils";
import {
  buildCenterStripeGridTemplateColumns,
  computeLayoutGridMetrics,
} from "./layoutMetrics";
import { useLayoutStore } from "./layoutStore";
import { useCenterSegments } from "./useCenterSegments";
import { useDragDropZonesReady } from "./useDragDropZonesReady";
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
  const centerBandVisible = isCenterContentVisible(layout);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const isDragging = Boolean(draggingPanel && !layoutLocked);
  const showDropZones = useDragDropZonesReady(isDragging);
  const slotIds = useLayoutStore(
    useShallow((s) => s.layout.center.segments.map((seg) => seg.id)),
  );
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

  const dropSegments = useMemo(
    () =>
      segments.map((segment) => ({
        kind: segment.kind,
        slotId: segment.slotId,
        open: segment.open,
        sizeRatio: segment.sizeRatio,
      })),
    [segments],
  );

  const stripeEndInsertIndex = useMemo(() => {
    if (segments.length === 0) return 0;
    const lastSlotId = segments[segments.length - 1].slotId;
    const index = slotIds.indexOf(lastSlotId);
    return index < 0 ? slotIds.length : index + 1;
  }, [segments, slotIds]);

  return (
    <div
      data-center-stripe
      data-ambient-glass-surface="stripe"
      className="gx-panel relative grid h-full w-full min-w-0 overflow-hidden"
      style={{ gridTemplateColumns: stripeColumns }}
    >
      {/* 9 列構成: stripe / gap / content / splitter。先頭の stripe 列に
          左ドック開閉トグルを置き、bands セルを下の editor 列と揃える。 */}
      <div className="flex min-h-0 min-w-0 items-center justify-center">
        {hasLeft && <SideDockToggle region="left" />}
      </div>
      <div aria-hidden className="min-h-0 min-w-0" />
      <div aria-hidden className="min-h-0 min-w-0" />
      <div aria-hidden className="min-h-0 min-w-0" />
      <div
        data-center-stripe-column
        className={cn(
          "relative min-h-0 overflow-hidden",
          centerBandVisible || isDragging
            ? "min-w-0 w-full"
            : "min-w-max shrink-0",
        )}
      >
        <CenterStripeBands segments={segments} />
      </div>
      <div aria-hidden className="min-h-0 min-w-0" />
      <div aria-hidden className="min-h-0 min-w-0" />
      <div aria-hidden className="min-h-0 min-w-0" />
      {/* 末尾の stripe 列に右ドック開閉トグルを置く。 */}
      <div className="flex min-h-0 min-w-0 items-center justify-center">
        {hasRight && <SideDockToggle region="right" />}
      </div>
      <div aria-hidden className="min-h-0 min-w-0" />
      {showDropZones && (
        <CenterStripeDropOverlay
          segments={dropSegments}
          slotIds={slotIds}
          stripeEndInsertIndex={stripeEndInsertIndex}
        />
      )}
    </div>
  );
}
