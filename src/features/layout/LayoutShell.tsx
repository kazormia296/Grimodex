import { memo } from "react";
import type { PanelId } from "./panelIds";
import { EditorArea } from "./EditorArea";
import { RegionDock } from "./RegionDock";
import { RegionResizeSplitter } from "./RegionResizeSplitter";
import { SlotView } from "./SlotView";
import { useLayoutStore } from "./layoutStore";
import { useRegionSegments } from "./useRegionSegments";

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
 * IntelliJ-style asymmetric layout shell.
 * Central editor cell + left/right/bottom tool window regions.
 */
export const LayoutShell = memo(function LayoutShell({
  hidden = false,
  screenshotPanelId = null,
}: LayoutShellProps) {
  const segments = useRegionSegments();
  const leftOpen = useLayoutStore((s) =>
    regionIsOpen(s.layout.regions.left.slots),
  );
  const rightOpen = useLayoutStore((s) =>
    regionIsOpen(s.layout.regions.right.slots),
  );
  const bottomOpen = useLayoutStore((s) =>
    regionIsOpen(s.layout.regions.bottom.slots),
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

  const hasLeft = segments.left.some((s) => s.panels.length > 0);
  const hasRight = segments.right.some((s) => s.panels.length > 0);
  const hasBottom = segments.bottom.some((s) => s.panels.length > 0);

  return (
    <div
      data-layout-shell
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      <div className="flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {hasLeft && (
          <RegionDock
            region="left"
            stripeOrientation="vertical"
            contentOrientation="vertical"
            segments={segments.left}
          />
        )}

        {leftOpen && <RegionResizeSplitter region="left" />}

        <div className="h-full min-h-0 min-w-0 flex-1 overflow-hidden">
          <EditorArea />
        </div>

        {rightOpen && <RegionResizeSplitter region="right" />}

        {hasRight && (
          <RegionDock
            region="right"
            stripeOrientation="vertical"
            contentOrientation="vertical"
            segments={segments.right}
          />
        )}
      </div>

      {bottomOpen && <RegionResizeSplitter region="bottom" />}

      {hasBottom && (
        <RegionDock
          region="bottom"
          stripeOrientation="horizontal"
          contentOrientation="horizontal"
          segments={segments.bottom}
        />
      )}
    </div>
  );
});
