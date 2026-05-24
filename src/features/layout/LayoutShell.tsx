import { memo, useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import type { PanelId } from "./panelIds";
import {
  BottomCornerToggle,
  BOTTOM_CORNER_TOGGLE_CLEARANCE_PX,
} from "./BottomCornerToggle";
import { AnimatedRegionChrome } from "./AnimatedRegionChrome";
import { CenterContent } from "./CenterContent";
import { CenterStripe } from "./CenterStripe";
import { EditorArea } from "./EditorArea";
import { getBottomCorners, isCenterContentVisible } from "./layoutStateUtils";
import { presetCrossfadeTransition } from "./layoutAnimation";
import { RegionDock, SideRegionStripeColumn } from "./RegionDock";
import { RegionContent } from "./RegionContent";
import { RegionResizeSplitter } from "./RegionResizeSplitter";
import { SlotView } from "./SlotView";
import {
  buildLayoutGridTemplateAreas,
  buildLayoutGridTemplateColumns,
  buildLayoutGridTemplateRows,
  computeLayoutGridMetrics,
} from "./layoutMetrics";
import { useLayoutStore } from "./layoutStore";
import { useCardLayout } from "./cardLayout";
import { useRegionSegments } from "./useRegionSegments";
import { LayoutDnDHighlightOverlay } from "./LayoutDnDHighlightOverlay";
import { LayoutPanelDragGhost } from "./LayoutPanelDragGhost";
import { StripeInsertIndicator } from "./StripeInsertIndicator";
import { useLayoutPresetCrossfade } from "./useLayoutPresetCrossfade";

interface LayoutShellProps {
  /** Screenshot mode: hide stripes and show a single panel full-screen */
  hidden?: boolean;
  screenshotPanelId?: PanelId | null;
}

function regionIsOpen(slots: { activePanel: string | null }[]): boolean {
  return slots.some((slot) => slot.activePanel !== null);
}

/**
 * IntelliJ-style asymmetric layout shell (§3 of layout design doc).
 *
 * Center Stripe is a full-width permanent top band — it spans every column
 * and owns the top corners. Side stripes span only the main row (plus the
 * bottom row when they own a bottom corner), so their top edge is flush with
 * the content / editor top edge. The bottom region is a wide bottom band.
 */
export const LayoutShell = memo(function LayoutShell({
  hidden = false,
  screenshotPanelId = null,
}: LayoutShellProps) {
  const segments = useRegionSegments();
  const layout = useLayoutStore((s) => s.layout);
  const { crossfadeKey, animateEntry, reduced } = useLayoutPresetCrossfade();

  const leftOpen = regionIsOpen(layout.regions.left.slots);
  const rightOpen = regionIsOpen(layout.regions.right.slots);
  const bottomOpen = regionIsOpen(layout.regions.bottom.slots);

  const hasLeft = segments.left.some((s) => s.panels.length > 0);
  const hasRight = segments.right.some((s) => s.panels.length > 0);
  const hasBottom = segments.bottom.some((s) => s.panels.length > 0);

  const centerBandVisible = isCenterContentVisible(layout);
  const cardLayout = useCardLayout();

  // カードレイアウト ON/OFF 切替で chrome 量が変わるため、切替時に保存済みの
  // region サイズを即座に再クランプする（初回マウントでは何もしない）。
  const cardLayoutRef = useRef(cardLayout);
  useEffect(() => {
    if (cardLayoutRef.current === cardLayout) return;
    cardLayoutRef.current = cardLayout;
    useLayoutStore.getState().reclampForViewport();
  }, [cardLayout]);

  const metrics = useMemo(
    () =>
      computeLayoutGridMetrics({
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
        cardLayout,
      }),
    [
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
      cardLayout,
    ],
  );

  const gridTemplateColumns = useMemo(
    () => buildLayoutGridTemplateColumns(metrics),
    [metrics],
  );

  const gridTemplateRows = useMemo(
    () => buildLayoutGridTemplateRows(metrics, hasBottom),
    [metrics, hasBottom],
  );

  if (hidden && screenshotPanelId) {
    if (screenshotPanelId === "editor") {
      return (
        <div className="h-full w-full overflow-hidden">
          <EditorArea />
        </div>
      );
    }
    return (
      <div className="h-full w-full overflow-hidden">
        <SlotView panelId={screenshotPanelId} />
      </div>
    );
  }

  if (hidden) {
    return (
      <div className="h-full w-full overflow-hidden">
        <EditorArea />
      </div>
    );
  }

  // 9 列 (stripe/gap/content/splitter/center/splitter/content/gap/stripe) ×
  // 行 (center stripe / gap 行 / main / 任意 bottom)。bottom 行の両端は
  // 角オーナーシップで side stripe ↔ bottom region を切り替える。
  const bottomCorners = getBottomCorners(layout);
  const gridTemplateAreas = buildLayoutGridTemplateAreas(
    hasBottom,
    bottomCorners,
  );

  return (
    <>
      <LayoutDnDHighlightOverlay />
      <StripeInsertIndicator />
      <LayoutPanelDragGhost />
      <motion.div
        key={crossfadeKey}
        data-layout-shell
        className="relative grid h-full w-full overflow-hidden"
        initial={animateEntry && !reduced ? { opacity: 0 } : false}
        animate={{ opacity: 1 }}
        transition={presetCrossfadeTransition(reduced)}
        style={{
          gridTemplateColumns,
          gridTemplateRows,
          gridTemplateAreas,
          padding: cardLayout ? "var(--gx-outer-pad)" : undefined,
        }}
      >
        <div style={{ gridArea: "cstripe" }} className="min-h-0 min-w-0">
          <CenterStripe />
        </div>

        {hasLeft && (
          <div style={{ gridArea: "lstripe" }} className="min-h-0">
            <SideRegionStripeColumn
              region="left"
              stripeOrientation="vertical"
              segments={segments.left}
              reserveEndPx={
                hasBottom && !bottomCorners.left
                  ? BOTTOM_CORNER_TOGGLE_CLEARANCE_PX
                  : 0
              }
            />
          </div>
        )}

        {hasLeft && (
          <div style={{ gridArea: "lcontent" }} className="min-h-0 min-w-0">
            <AnimatedRegionChrome
              region="left"
              open={leftOpen}
              className="h-full w-full min-h-0 min-w-0"
            >
              <RegionContent region="left" orientation="vertical" />
            </AnimatedRegionChrome>
          </div>
        )}

        {metrics.leftSplitterPx > 0 && (
          <div
            style={{ gridArea: "lspl" }}
            className="flex h-full min-h-0 overflow-hidden"
          >
            <RegionResizeSplitter region="left" />
          </div>
        )}

        {centerBandVisible && (
          <div style={{ gridArea: "editor" }} className="min-h-0 min-w-0">
            <CenterContent />
          </div>
        )}

        {metrics.rightSplitterPx > 0 && (
          <div
            style={{ gridArea: "rspl" }}
            className="flex h-full min-h-0 overflow-hidden"
          >
            <RegionResizeSplitter region="right" />
          </div>
        )}

        {hasRight && (
          <div style={{ gridArea: "rcontent" }} className="min-h-0 min-w-0">
            <AnimatedRegionChrome
              region="right"
              open={rightOpen}
              className="h-full w-full min-h-0 min-w-0"
            >
              <RegionContent region="right" orientation="vertical" />
            </AnimatedRegionChrome>
          </div>
        )}

        {hasRight && (
          <div style={{ gridArea: "rstripe" }} className="min-h-0">
            <SideRegionStripeColumn
              region="right"
              stripeOrientation="vertical"
              segments={segments.right}
              reserveEndPx={
                hasBottom && !bottomCorners.right
                  ? BOTTOM_CORNER_TOGGLE_CLEARANCE_PX
                  : 0
              }
            />
          </div>
        )}

        {hasBottom && (
          <div
            style={{ gridArea: "bottom" }}
            className="flex min-h-0 min-w-0 flex-col"
          >
            {bottomOpen ? (
              <RegionResizeSplitter region="bottom" />
            ) : cardLayout ? (
              // content を閉じていても bottom stripe を浮かせるギャップ。
              <div
                aria-hidden
                className="shrink-0"
                style={{ height: "var(--gx-stripe-gap)" }}
              />
            ) : null}
            <RegionDock
              region="bottom"
              stripeOrientation="horizontal"
              contentOrientation="horizontal"
              segments={segments.bottom}
              stripeReserveStartPx={
                hasLeft && bottomCorners.left
                  ? BOTTOM_CORNER_TOGGLE_CLEARANCE_PX
                  : 0
              }
              stripeReserveEndPx={
                hasRight && bottomCorners.right
                  ? BOTTOM_CORNER_TOGGLE_CLEARANCE_PX
                  : 0
              }
            />
          </div>
        )}

        {/* 角オーナーシップ切替。side region と bottom region の両方が
            あるときだけ、その角の取り合いが意味を持つ。 */}
        {hasBottom && hasLeft && <BottomCornerToggle side="left" />}
        {hasBottom && hasRight && <BottomCornerToggle side="right" />}
      </motion.div>
    </>
  );
});
