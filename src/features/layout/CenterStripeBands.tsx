import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { EditorToggleIcon } from "./EditorToggleIcon";
import { ToolWindowIcon } from "./ToolWindowIcon";
import {
  acceptsToolWindowReassignDrag,
  TOOL_WINDOW_REASSIGN_TYPE,
} from "./layoutDnD";
import { useShallow } from "zustand/react/shallow";
import { useLayoutStore } from "./layoutStore";
import { DND_NEW_SLOT_BETWEEN_HALF_PX } from "./layoutConstants";
import { useDragDropZonesReady } from "./useDragDropZonesReady";
import type { CenterStripeSegment } from "./useCenterSegments";

interface CenterStripeBandProps {
  segment: CenterStripeSegment;
  flexGrow: number;
}

function CenterStripeBand({ segment, flexGrow }: CenterStripeBandProps) {
  const movePanelToSlot = useLayoutStore((s) => s.movePanelToSlot);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

  const handleDragOver = (e: React.DragEvent) => {
    if (segment.kind !== "tool") return;
    if (!acceptsToolWindowReassignDrag(e, layoutLocked, draggingPanel)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDragOverTarget({
      type: "slot",
      region: "center",
      slotId: segment.slotId,
    });
  };

  const handleDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setDragOverTarget(null);
  };

  const handleDrop = (e: React.DragEvent) => {
    if (segment.kind !== "tool") return;
    e.preventDefault();
    if (layoutLocked) return;
    const panelId =
      draggingPanel ??
      (e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE) as
        | import("./layoutTypes").ToolWindowPanelId
        | "");
    if (!panelId) return;
    movePanelToSlot(panelId, "center", segment.slotId);
    setDraggingPanel(null);
    setDragOverTarget(null);
  };

  return (
    <div
      data-center-stripe-band
      data-band-open={segment.open ? "true" : "false"}
      data-center-stripe-band-kind={segment.kind}
      data-drop-segment={segment.key}
      data-drop-slot-id={segment.slotId}
      data-drop-region="center"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        flexGrow,
        flexBasis: segment.open ? 0 : "auto",
        flexShrink: 0,
      }}
      className={cn(
        "pointer-events-auto flex h-full min-h-0 min-w-0 flex-row items-center justify-start gap-0.5 overflow-x-auto overflow-y-hidden px-0.5",
        draggingPanel &&
          !layoutLocked &&
          segment.kind === "tool" &&
          "ring-1 ring-primary/20",
      )}
    >
      {segment.kind === "editor" ? (
        <EditorToggleIcon />
      ) : (
        segment.panels.map((panel) => (
          <ToolWindowIcon
            key={panel.id}
            panelId={panel.id}
            region="center"
            active={panel.active}
            slotOpen={segment.open}
          />
        ))
      )}
    </div>
  );
}

interface CollapsedClusterProps {
  segments: CenterStripeSegment[];
  anchor: "start" | "end";
}

function CollapsedCluster({ segments, anchor }: CollapsedClusterProps) {
  return (
    <div
      data-stripe-collapsed-cluster
      className="relative h-full"
      style={{ flexGrow: 0, flexBasis: 0, flexShrink: 0 }}
    >
      <div
        className={cn(
          "pointer-events-none absolute bottom-0 top-0 flex flex-row items-center gap-0.5",
          anchor === "start" ? "left-0" : "right-0",
        )}
      >
        {segments.map((segment) => (
          <CenterStripeBand key={segment.key} segment={segment} flexGrow={0} />
        ))}
      </div>
    </div>
  );
}

type StripeItem =
  | { kind: "open"; segment: CenterStripeSegment }
  /** editor 閉じ時も常設表示（CollapsedCluster に入れると幅 0 で消える） */
  | { kind: "pinned"; segment: CenterStripeSegment }
  | { kind: "collapsed"; segments: CenterStripeSegment[] };

interface CenterStripeBandsProps {
  segments: ReadonlyArray<CenterStripeSegment>;
}

export function CenterStripeBands({ segments }: CenterStripeBandsProps) {
  const slotIds = useLayoutStore(
    useShallow((s) => s.layout.center.segments.map((seg) => seg.id)),
  );
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const showDropZones = useDragDropZonesReady(
    Boolean(draggingPanel && !layoutLocked),
  );

  const openRatioSum = segments.reduce(
    (sum, segment) => sum + (segment.open ? segment.sizeRatio : 0),
    0,
  );

  const items: StripeItem[] = [];
  for (const segment of segments) {
    if (segment.kind === "editor") {
      if (segment.open) {
        items.push({ kind: "open", segment });
      } else {
        items.push({ kind: "pinned", segment });
      }
      continue;
    }
    if (segment.open) {
      items.push({ kind: "open", segment });
      continue;
    }
    const last = items[items.length - 1];
    if (last && last.kind === "collapsed") {
      last.segments.push(segment);
    } else {
      items.push({ kind: "collapsed", segments: [segment] });
    }
  }

  const hasOpenBands = items.some((item) => item.kind === "open");

  const slotIndexOf = (slotId: string): number => {
    const index = slotIds.indexOf(slotId);
    return index < 0 ? slotIds.length : index;
  };
  const stripeEndInsertIndex =
    segments.length > 0
      ? slotIndexOf(segments[segments.length - 1].slotId) + 1
      : 0;

  const handleEdgeDrop = (e: React.DragEvent, insertIndex: number) => {
    e.preventDefault();
    if (layoutLocked) return;
    const panelId =
      draggingPanel ??
      (e.dataTransfer.getData(TOOL_WINDOW_REASSIGN_TYPE) as
        | import("./layoutTypes").ToolWindowPanelId
        | "");
    if (!panelId) return;
    movePanelToNewSlot(panelId, "center", insertIndex);
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
      region: "center",
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
      data-stripe-region="center"
      className={cn(
        "relative flex h-full min-h-0 overflow-hidden",
        hasOpenBands ? "w-full min-w-0" : "w-max min-w-max shrink-0",
      )}
    >
      {showDropZones && segments.length > 0 && (
        <div
          data-drop-edge="start"
          data-drop-region="center"
          data-insert-index={0}
          data-drop-surface="stripe-start"
          className="absolute z-20 opacity-0"
          style={{ top: 0, bottom: 0, left: 0, width: stripeEdgeHitPx }}
          onDragOver={(e) => handleEdgeDragOver(e, 0, "stripe-start")}
          onDragLeave={handleEdgeDragLeave}
          onDrop={(e) => handleEdgeDrop(e, 0)}
        />
      )}

      {items.map((item, itemIdx) => {
        if (item.kind === "collapsed") {
          return (
            <CollapsedCluster
              key={`collapsed-${item.segments[0].key}`}
              segments={item.segments}
              anchor={itemIdx === 0 ? "start" : "end"}
            />
          );
        }

        if (item.kind === "pinned") {
          const segment = item.segment;
          return (
            <Fragment key={segment.key}>
              {itemIdx > 0 && (
                <div className="relative mx-0.5 flex h-full shrink-0 items-center">
                  <div
                    data-stripe-divider
                    aria-hidden
                    className="h-5 w-px shrink-0 rounded-full bg-muted-foreground/50"
                  />
                </div>
              )}
              <CenterStripeBand segment={segment} flexGrow={0} />
            </Fragment>
          );
        }

        const segment = item.segment;
        const betweenInsertIndex = slotIndexOf(segment.slotId);
        return (
          <Fragment key={segment.key}>
            {itemIdx > 0 && (
              <div className="relative mx-0.5 flex h-full shrink-0 items-center">
                <div
                  data-stripe-divider
                  aria-hidden
                  className="h-5 w-px shrink-0 rounded-full bg-muted-foreground/50"
                />
                {showDropZones && (
                  <div
                    data-drop-edge="between"
                    data-drop-region="center"
                    data-insert-index={betweenInsertIndex}
                    data-drop-surface="stripe-between"
                    className="absolute z-20 opacity-0"
                    style={{
                      top: 0,
                      bottom: 0,
                      left: "50%",
                      width: stripeBetweenHitPx,
                      transform: "translateX(-50%)",
                    }}
                    onDragOver={(e) =>
                      handleEdgeDragOver(
                        e,
                        betweenInsertIndex,
                        "stripe-between",
                      )
                    }
                    onDragLeave={handleEdgeDragLeave}
                    onDrop={(e) => handleEdgeDrop(e, betweenInsertIndex)}
                  />
                )}
              </div>
            )}
            <CenterStripeBand
              segment={segment}
              flexGrow={openRatioSum > 0 ? segment.sizeRatio / openRatioSum : 1}
            />
          </Fragment>
        );
      })}

      {showDropZones && (
        <div
          data-drop-edge="end"
          data-drop-region="center"
          data-insert-index={stripeEndInsertIndex}
          data-drop-surface="stripe-end"
          className="absolute z-20 opacity-0"
          style={
            segments.length === 0
              ? { top: 0, bottom: 0, left: 0, right: 0 }
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
