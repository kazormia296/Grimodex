import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { ToolWindowIcon } from "./ToolWindowIcon";
import {
  acceptsToolWindowReassignDrag,
  TOOL_WINDOW_REASSIGN_TYPE,
} from "./layoutDnD";
import { useLayoutStore } from "./layoutStore";
import { DND_NEW_SLOT_BETWEEN_HALF_PX } from "./layoutConstants";
import { useDragDropZonesReady } from "./useDragDropZonesReady";
import { normalizeFlexGrow } from "./layoutStateUtils";
import type { RegionId } from "./layoutTypes";
import type { RegionSegment } from "./useRegionSegments";

interface StripeGroupProps {
  segment: RegionSegment;
  orientation: "vertical" | "horizontal";
  region: RegionId;
  /** 正規化済み flex-grow（segment 間の合計 = 1） */
  flexGrow: number;
}

function StripeGroup({
  segment,
  orientation,
  region,
  flexGrow,
}: StripeGroupProps) {
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

  const handleDragOver = (e: React.DragEvent) => {
    if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTarget({
      type: "slot",
      region,
      slotId: segment.slotId,
    });
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOverTarget(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (layoutLocked) return;
    const panelId =
      draggingPanel ??
      (e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE) as
        | import("./layoutTypes").ToolWindowPanelId
        | "");
    if (!panelId) return;
    movePanelToSlot(panelId, region, segment.slotId);
    setDraggingPanel(null);
    setDragOverTarget(null);
  };

  return (
    <div
      data-drop-segment={segment.key}
      data-drop-slot-id={segment.slotId}
      data-drop-region={region}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{ flexGrow, flexBasis: 0 }}
      className={cn(
        "flex min-h-0 min-w-0",
        orientation === "vertical"
          ? "w-full flex-col items-center justify-start gap-0.5 overflow-y-auto overflow-x-hidden"
          : "h-full flex-row items-center justify-start gap-0.5 overflow-x-auto overflow-y-hidden",
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
  const slots = useLayoutStore((s) => s.layout.regions[region].slots);
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const showDropZones = useDragDropZonesReady(
    Boolean(draggingPanel && !layoutLocked),
  );

  if (segments.length === 0) return null;

  const segmentFlexGrow = normalizeFlexGrow(segments.map((s) => s.sizeRatio));

  const stripeEndInsertIndex =
    segments.length > 0
      ? slots.findIndex(
          (slot) => slot.id === segments[segments.length - 1].slotId,
        ) + 1
      : slots.length;

  const insertIndexBetweenSegments = (segmentIndex: number): number => {
    const nextSegment = segments[segmentIndex + 1];
    if (!nextSegment) return slots.length;
    const index = slots.findIndex((slot) => slot.id === nextSegment.slotId);
    return index < 0 ? slots.length : index;
  };

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
    setDragOverTarget(null);
  };

  const handleEdgeDragOver = (
    e: React.DragEvent,
    insertIndex: number,
    surface: "stripe-start" | "stripe-end" | "stripe-between",
  ) => {
    if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTarget({
      type: "new-slot",
      region,
      insertIndex,
      surface,
    });
  };

  const handleEdgeDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOverTarget(null);
  };

  const stripeEdgeHitPx = 16;
  const stripeBetweenHitPx = DND_NEW_SLOT_BETWEEN_HALF_PX * 2;

  return (
    <div
      data-stripe-root
      data-stripe-region={region}
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 overflow-hidden bg-background/40",
        orientation === "vertical"
          ? "flex-col gap-0 py-0.5"
          : "flex-row gap-0 px-0.5",
        region === "left" && "border-r border-border",
        region === "right" && "border-l border-border",
        region === "bottom" && "border-t border-border",
      )}
    >
      {showDropZones && (
        <div
          data-drop-edge="start"
          data-drop-region={region}
          data-insert-index={0}
          data-drop-surface="stripe-start"
          className="absolute z-20 opacity-0"
          style={
            orientation === "vertical"
              ? { top: 0, left: 0, right: 0, height: stripeEdgeHitPx }
              : { top: 0, bottom: 0, left: 0, width: stripeEdgeHitPx }
          }
          onDragOver={(e) => handleEdgeDragOver(e, 0, "stripe-start")}
          onDragLeave={handleEdgeDragLeave}
          onDrop={(e) => handleEdgeDrop(e, 0)}
        />
      )}

      {segments.map((segment, i) => (
        <Fragment key={segment.key}>
          <StripeGroup
            segment={segment}
            orientation={orientation}
            region={region}
            flexGrow={segmentFlexGrow[i]}
          />
          {i < segments.length - 1 && (
            <div
              className={cn(
                "relative shrink-0",
                orientation === "vertical"
                  ? "my-0.5 flex w-full justify-center"
                  : "mx-0.5 flex h-full items-center",
              )}
            >
              <div
                data-stripe-divider
                aria-hidden
                className={cn(
                  "shrink-0 rounded-full bg-muted-foreground/50",
                  orientation === "vertical" ? "h-px w-5" : "h-5 w-px",
                )}
              />
              {showDropZones && (
                <div
                  data-drop-edge="between"
                  data-drop-region={region}
                  data-insert-index={insertIndexBetweenSegments(i)}
                  data-drop-surface="stripe-between"
                  className="absolute z-20 opacity-0"
                  style={
                    orientation === "vertical"
                      ? {
                          left: 0,
                          right: 0,
                          top: "50%",
                          height: stripeBetweenHitPx,
                          transform: "translateY(-50%)",
                        }
                      : {
                          top: 0,
                          bottom: 0,
                          left: "50%",
                          width: stripeBetweenHitPx,
                          transform: "translateX(-50%)",
                        }
                  }
                  onDragOver={(e) =>
                    handleEdgeDragOver(
                      e,
                      insertIndexBetweenSegments(i),
                      "stripe-between",
                    )
                  }
                  onDragLeave={handleEdgeDragLeave}
                  onDrop={(e) =>
                    handleEdgeDrop(e, insertIndexBetweenSegments(i))
                  }
                />
              )}
            </div>
          )}
        </Fragment>
      ))}

      {showDropZones && (
        <div
          data-drop-edge="end"
          data-drop-region={region}
          data-insert-index={stripeEndInsertIndex}
          data-drop-surface="stripe-end"
          className="absolute z-20 opacity-0"
          style={
            orientation === "vertical"
              ? { bottom: 0, left: 0, right: 0, height: stripeEdgeHitPx }
              : { top: 0, bottom: 0, right: 0, width: stripeEdgeHitPx }
          }
          onDragOver={(e) =>
            handleEdgeDragOver(e, stripeEndInsertIndex, "stripe-end")
          }
          onDragLeave={handleEdgeDragLeave}
          onDrop={(e) => handleEdgeDrop(e, stripeEndInsertIndex)}
        />
      )}
    </div>
  );
}
