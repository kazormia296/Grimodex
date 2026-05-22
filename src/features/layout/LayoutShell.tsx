import { memo, useEffect, useMemo, useRef } from "react";
import type { PanelId } from "./panelIds";
import {
  BottomCornerToggle,
  BOTTOM_CORNER_TOGGLE_CLEARANCE_PX,
} from "./BottomCornerToggle";
import { CenterContent } from "./CenterContent";
import { CenterStripe } from "./CenterStripe";
import { EditorArea } from "./EditorArea";
import { getBottomCorners, isCenterBandVisible } from "./layoutStateUtils";
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
import { useMochiLayout } from "./mochiLayout";
import { useRegionSegments } from "./useRegionSegments";
import { LayoutDnDHighlightOverlay } from "./LayoutDnDHighlightOverlay";
import { LayoutPanelDragGhost } from "./LayoutPanelDragGhost";

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
 * Center Stripe is a permanent top band and the bottom region a wide bottom
 * band — both span left content + editor + right content between the side
 * stripes. Side stripes span all rows; only stripe columns sit in the corners.
 */
export const LayoutShell = memo(function LayoutShell({
  hidden = false,
  screenshotPanelId = null,
}: LayoutShellProps) {
  const segments = useRegionSegments();
  const layout = useLayoutStore((s) => s.layout);

  const leftOpen = regionIsOpen(layout.regions.left.slots);
  const rightOpen = regionIsOpen(layout.regions.right.slots);
  const bottomOpen = regionIsOpen(layout.regions.bottom.slots);

  const hasLeft = segments.left.some((s) => s.panels.length > 0);
  const hasRight = segments.right.some((s) => s.panels.length > 0);
  const hasBottom = segments.bottom.some((s) => s.panels.length > 0);

  const centerBandVisible = isCenterBandVisible(layout);
  const mochi = useMochiLayout();

  // もちもち ON/OFF 切替で chrome 量が変わるため、切替時に保存済みの
  // region サイズを即座に再クランプする（初回マウントでは何もしない）。
  const mochiRef = useRef(mochi);
  useEffect(() => {
    if (mochiRef.current === mochi) return;
    mochiRef.current = mochi;
    useLayoutStore.getState().reclampForViewport();
  }, [mochi]);

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
        mochi,
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
      mochi,
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
      <LayoutPanelDragGhost />
      <div
        data-layout-shell
        className="relative grid h-full w-full overflow-hidden"
        style={{
          gridTemplateColumns,
          gridTemplateRows,
          gridTemplateAreas,
          padding: mochi ? "var(--gx-outer-pad)" : undefined,
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
              bottomRowInset={bottomCorners.left ? 0 : metrics.bottomRowInset}
            />
          </div>
        )}

        {leftOpen && (
          <div style={{ gridArea: "lcontent" }} className="min-h-0 min-w-0">
            <RegionContent region="left" orientation="vertical" />
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

        {rightOpen && (
          <div style={{ gridArea: "rcontent" }} className="min-h-0 min-w-0">
            <RegionContent region="right" orientation="vertical" />
          </div>
        )}

        {hasRight && (
          <div style={{ gridArea: "rstripe" }} className="min-h-0">
            <SideRegionStripeColumn
              region="right"
              stripeOrientation="vertical"
              segments={segments.right}
              bottomRowInset={bottomCorners.right ? 0 : metrics.bottomRowInset}
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
            ) : mochi ? (
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
      </div>
    </>
  );
});
