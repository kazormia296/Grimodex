import { memo, useMemo } from "react";
import type { PanelId } from "./panelIds";
import { CenterContent } from "./CenterContent";
import { CenterStripe } from "./CenterStripe";
import { EditorArea } from "./EditorArea";
import { isCenterBandVisible } from "./layoutStateUtils";
import { RegionDock, SideRegionStripeColumn } from "./RegionDock";
import { RegionContent } from "./RegionContent";
import { RegionResizeSplitter } from "./RegionResizeSplitter";
import { SlotView } from "./SlotView";
import {
  buildLayoutGridTemplateColumns,
  computeLayoutGridMetrics,
} from "./layoutMetrics";
import { STRIPE_SIZE } from "./layoutConstants";
import { useLayoutStore } from "./layoutStore";
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
    ],
  );

  const gridTemplateColumns = useMemo(
    () => buildLayoutGridTemplateColumns(metrics),
    [metrics],
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

  const cstripeRowAreas =
    '"lstripe cstripe cstripe cstripe cstripe cstripe rstripe"';
  const mainRowAreas = '"lstripe lcontent lspl editor rspl rcontent rstripe"';
  const bottomRowAreas = '"lstripe bottom bottom bottom bottom bottom rstripe"';
  const gridTemplateAreas = hasBottom
    ? `${cstripeRowAreas} ${mainRowAreas} ${bottomRowAreas}`
    : `${cstripeRowAreas} ${mainRowAreas}`;

  return (
    <>
      <LayoutDnDHighlightOverlay />
      <LayoutPanelDragGhost />
      <div
        data-layout-shell
        className="grid h-full w-full overflow-hidden"
        style={{
          gridTemplateColumns,
          gridTemplateRows: hasBottom
            ? `${STRIPE_SIZE}px 1fr ${metrics.bottomCellPx}px`
            : `${STRIPE_SIZE}px 1fr`,
          gridTemplateAreas,
        }}
      >
        <div
          style={{ gridArea: "cstripe" }}
          className="min-h-0 min-w-0 overflow-hidden"
        >
          <CenterStripe />
        </div>

        {hasLeft && (
          <div
            style={{ gridArea: "lstripe" }}
            className="min-h-0 overflow-hidden"
          >
            <SideRegionStripeColumn
              region="left"
              stripeOrientation="vertical"
              segments={segments.left}
              bottomRowInset={metrics.bottomRowInset}
            />
          </div>
        )}

        {leftOpen && (
          <div
            style={{ gridArea: "lcontent" }}
            className="min-h-0 min-w-0 overflow-hidden"
          >
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
          <div
            style={{ gridArea: "editor" }}
            className="min-h-0 min-w-0 overflow-hidden"
          >
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
          <div
            style={{ gridArea: "rcontent" }}
            className="min-h-0 min-w-0 overflow-hidden"
          >
            <RegionContent region="right" orientation="vertical" />
          </div>
        )}

        {hasRight && (
          <div
            style={{ gridArea: "rstripe" }}
            className="min-h-0 overflow-hidden"
          >
            <SideRegionStripeColumn
              region="right"
              stripeOrientation="vertical"
              segments={segments.right}
              bottomRowInset={metrics.bottomRowInset}
            />
          </div>
        )}

        {hasBottom && (
          <div
            style={{ gridArea: "bottom" }}
            className="flex min-h-0 min-w-0 flex-col overflow-hidden"
          >
            {bottomOpen && <RegionResizeSplitter region="bottom" />}
            <RegionDock
              region="bottom"
              stripeOrientation="horizontal"
              contentOrientation="horizontal"
              segments={segments.bottom}
            />
          </div>
        )}
      </div>
    </>
  );
});
