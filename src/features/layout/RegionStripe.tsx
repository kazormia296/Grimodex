import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { ToolWindowIcon, TOOL_WINDOW_REASSIGN_TYPE } from "./ToolWindowIcon";
import { useLayoutStore } from "./layoutStore";
import type { RegionId } from "./layoutTypes";
import type { RegionSegment } from "./useRegionSegments";

interface StripeGroupProps {
  segment: RegionSegment;
  orientation: "vertical" | "horizontal";
  region: RegionId;
}

function StripeGroup({ segment, orientation, region }: StripeGroupProps) {
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

  const handleDragOver = (e: React.DragEvent) => {
    if (
      !layoutLocked &&
      e.dataTransfer.types.includes(TOOL_WINDOW_REASSIGN_TYPE)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (layoutLocked) return;
    const panelId = e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE) as
      | import("./layoutTypes").ToolWindowPanelId
      | "";
    if (!panelId) return;
    movePanelToSlot(panelId, region, segment.slotId);
    setDraggingPanel(null);
  };

  return (
    <div
      data-drop-segment={segment.key}
      data-drop-slot-id={segment.slotId}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      style={{ flexGrow: segment.sizeRatio, flexBasis: 0 }}
      className={cn(
        "flex flex-1",
        orientation === "vertical"
          ? "w-full flex-col items-center gap-1"
          : "h-full flex-row items-center gap-1",
        draggingPanel && !layoutLocked && "ring-1 ring-primary/20",
      )}
    >
      {segment.panels.map((panel) => (
        <ToolWindowIcon
          key={panel.id}
          panelId={panel.id}
          region={region}
          active={panel.active}
        />
      ))}
    </div>
  );
}

interface RegionStripeProps {
  region: RegionId;
  orientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
}

export function RegionStripe({
  region,
  orientation,
  segments,
}: RegionStripeProps) {
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

  if (segments.length === 0) return null;

  const handleEdgeDrop = (e: React.DragEvent, insertIndex: number) => {
    e.preventDefault();
    if (layoutLocked) return;
    const panelId =
      draggingPanel ??
      (e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE) as
        | import("./layoutTypes").ToolWindowPanelId
        | "");
    if (!panelId) return;
    movePanelToNewSlot(panelId, region, insertIndex);
    setDraggingPanel(null);
  };

  const handleEdgeDragOver = (e: React.DragEvent) => {
    if (
      !layoutLocked &&
      e.dataTransfer.types.includes(TOOL_WINDOW_REASSIGN_TYPE)
    ) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };

  return (
    <div
      data-stripe-root
      data-stripe-region={region}
      className={cn(
        "relative flex h-full w-full bg-background/40",
        orientation === "vertical"
          ? "flex-col items-center gap-1 py-1"
          : "flex-row items-center gap-1 px-1",
        region === "left" && "border-r border-border",
        region === "right" && "border-l border-border",
        region === "bottom" && "border-t border-border",
      )}
    >
      {draggingPanel && !layoutLocked && (
        <div
          data-drop-edge="start"
          className={cn(
            "absolute z-20 opacity-0",
            orientation === "vertical"
              ? "left-0 right-0 top-0 h-4"
              : "bottom-0 left-0 top-0 w-4",
          )}
          onDragOver={handleEdgeDragOver}
          onDrop={(e) => handleEdgeDrop(e, 0)}
        />
      )}

      {segments.map((segment, i) => (
        <Fragment key={segment.key}>
          <StripeGroup
            segment={segment}
            orientation={orientation}
            region={region}
          />
          {i < segments.length - 1 && (
            <div
              data-stripe-divider
              aria-hidden
              className={cn(
                "shrink-0 rounded-full bg-muted-foreground/50",
                orientation === "vertical"
                  ? "my-1 h-[3px] w-6"
                  : "mx-1 h-6 w-[3px]",
              )}
            />
          )}
        </Fragment>
      ))}

      {draggingPanel && !layoutLocked && (
        <div
          data-drop-edge="end"
          className={cn(
            "absolute z-20 opacity-0",
            orientation === "vertical"
              ? "bottom-0 left-0 right-0 h-4"
              : "bottom-0 right-0 top-0 w-4",
          )}
          onDragOver={handleEdgeDragOver}
          onDrop={(e) => handleEdgeDrop(e, segments.length)}
        />
      )}
    </div>
  );
}
