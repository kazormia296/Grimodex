import { cn } from "@/lib/utils";
import type { PanelId } from "./panelIds";
import { EditorArea } from "./EditorArea";
import { RegionDock } from "./RegionDock";
import { SlotView } from "./SlotView";
import { useRegionSegments } from "./useRegionSegments";

interface LayoutShellProps {
  /** Screenshot mode: hide stripes and show a single panel full-screen */
  hidden?: boolean;
  screenshotPanelId?: PanelId | null;
}

/**
 * IntelliJ-style asymmetric layout shell.
 * Central editor cell + left/right/bottom tool window regions.
 */
export function LayoutShell({
  hidden = false,
  screenshotPanelId = null,
}: LayoutShellProps) {
  const segments = useRegionSegments();

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
      className={cn(
        "grid h-full w-full overflow-hidden",
        hasBottom ? "grid-rows-[1fr_auto]" : "grid-rows-1",
        "grid-cols-[auto_1fr_auto]",
      )}
      style={{
        gridTemplateAreas: hasBottom
          ? '"left content right" "left bottom right"'
          : '"left content right"',
      }}
    >
      <div style={{ gridArea: "left" }} className="flex min-h-0 overflow-hidden">
        {hasLeft && (
          <RegionDock
            region="left"
            stripeOrientation="vertical"
            contentOrientation="vertical"
            segments={segments.left}
            edge="before-editor"
          />
        )}
      </div>

      <div
        style={{ gridArea: "content" }}
        className="min-h-0 min-w-0 overflow-hidden"
      >
        <EditorArea />
      </div>

      <div
        style={{ gridArea: "right" }}
        className="flex min-h-0 justify-end overflow-hidden"
      >
        {hasRight && (
          <RegionDock
            region="right"
            stripeOrientation="vertical"
            contentOrientation="vertical"
            segments={segments.right}
            edge="after-editor"
          />
        )}
      </div>

      {hasBottom && (
        <div
          style={{ gridArea: "bottom" }}
          className="flex min-w-0 overflow-hidden"
        >
          <RegionDock
            region="bottom"
            stripeOrientation="horizontal"
            contentOrientation="horizontal"
            segments={segments.bottom}
            edge="before-editor"
          />
        </div>
      )}
    </div>
  );
}
