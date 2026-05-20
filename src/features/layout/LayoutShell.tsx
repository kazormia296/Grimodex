import { memo, useMemo } from "react";
import type { PanelId } from "./panelIds";
import { EditorArea } from "./EditorArea";
import { RegionDock, SideRegionStripeColumn } from "./RegionDock";
import { RegionContent } from "./RegionContent";
import { RegionResizeSplitter } from "./RegionResizeSplitter";
import { SlotView } from "./SlotView";
import {
  buildLayoutGridTemplateColumns,
  computeLayoutGridMetrics,
} from "./layoutMetrics";
import { useLayoutStore } from "./layoutStore";
import { useRegionSegments } from "./useRegionSegments";
import { LayoutDnDHighlightOverlay } from "./LayoutDnDHighlightOverlay";
import { LayoutPanelDragGhost } from "./LayoutPanelDragGhost";

interface LayoutShellProps {
  /** Screenshot mode: hide stripes and show a single panel full-screen */
  hidden?: boolean;
  screenshotPanelId?: PanelId | null;
}

function regionIsOpen(
  slots: { activePanel: string | null }[],
): boolean {
  return slots.some((slot) => slot.activePanel !== null);
}

/**
 * IntelliJ-style asymmetric layout shell (§3 of layout design doc).
 *
 * Bottom region spans left content + editor + right content (wide band between
 * side stripes). Side stripes span both rows; only stripe columns sit in corners.
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

  const metrics = useMemo(
    () =>
      computeLayoutGridMetrics({
        hasLeft,
        hasRight,
        hasBottom,
        leftOpen,
        rightOpen,
        bottomOpen,
        leftSize: layout.regions.left.size,
        rightSize: layout.regions.right.size,
        bottomSize: layout.regions.bottom.size,
      }),
    [
      bottomOpen,
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

  const mainRowAreas =
    '"lstripe lcontent lspl editor rspl rcontent rstripe"';
  const gridTemplateAreas = hasBottom
    ? `${mainRowAreas} "lstripe bottom bottom bottom bottom bottom rstripe"`
    : mainRowAreas;

  return (
    <>
      <LayoutDnDHighlightOverlay />
      <LayoutPanelDragGhost />
      <div
        data-layout-shell
        className="grid h-full w-full overflow-hidden"
        style={{
          gridTemplateColumns,
          gridTemplateRows: hasBottom ? `1fr ${metrics.bottomCellPx}px` : "1fr",
          gridTemplateAreas,
        }}
      >
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

        {leftOpen && (
          <div
            style={{ gridArea: "lspl" }}
            className="flex h-full min-h-0 overflow-hidden"
          >
            <RegionResizeSplitter region="left" />
          </div>
        )}

        <div
          style={{ gridArea: "editor" }}
          className="min-h-0 min-w-0 overflow-hidden"
        >
          <EditorArea />
        </div>

        {rightOpen && (
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
