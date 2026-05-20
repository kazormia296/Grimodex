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
import type { RegionId } from "./layoutTypes";
import type { RegionSegment } from "./useRegionSegments";

interface StripeGroupProps {
  segment: RegionSegment;
  orientation: "vertical" | "horizontal";
  region: RegionId;
  /** open slot は正規化済み比率（open 間で合計 1）、collapsed slot は 0 */
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
      style={{
        flexGrow,
        // collapsed slot はアイコン実寸（basis auto）。0 にすると潰れて見えなくなる。
        flexBasis: segment.open ? 0 : "auto",
        flexShrink: 0,
      }}
      className={cn(
        "pointer-events-auto flex min-h-0 min-w-0",
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
          slotOpen={segment.open}
        />
      ))}
    </div>
  );
}

interface CollapsedClusterProps {
  segments: RegionSegment[];
  orientation: "vertical" | "horizontal";
  region: RegionId;
  /** "start" = ストライプ先頭側へ寄せる / "end" = 末尾側へ寄せる */
  anchor: "start" | "end";
}

/**
 * 折りたたみ slot のアイコン群（案A）。
 *
 * flex フローでは 0 サイズで、open バンドの比率配分に影響を与えない
 * （＝ open バンドが content の slot サイズと一致する）。アイコンは
 * absolute オーバーレイで境界に表示し、連続する collapsed slot は
 * この cluster 内で実寸スタックする。
 */
function CollapsedCluster({
  segments,
  orientation,
  region,
  anchor,
}: CollapsedClusterProps) {
  const isVertical = orientation === "vertical";
  return (
    <div
      data-stripe-collapsed-cluster
      className={cn("relative", isVertical ? "w-full" : "h-full")}
      style={{ flexGrow: 0, flexBasis: 0, flexShrink: 0 }}
    >
      <div
        className={cn(
          "pointer-events-none absolute flex items-center gap-0.5",
          isVertical ? "left-0 right-0 flex-col" : "top-0 bottom-0 flex-row",
        )}
        style={
          isVertical
            ? anchor === "start"
              ? { top: 0 }
              : { bottom: 0 }
            : anchor === "start"
              ? { left: 0 }
              : { right: 0 }
        }
      >
        {segments.map((seg) => (
          <StripeGroup
            key={seg.key}
            segment={seg}
            orientation={orientation}
            region={region}
            flexGrow={0}
          />
        ))}
      </div>
    </div>
  );
}

interface RegionStripeProps {
  region: RegionId;
  orientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
}

type StripeItem =
  | { kind: "open"; segment: RegionSegment }
  | { kind: "collapsed"; segments: RegionSegment[] };

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

  // open slot の sizeRatio を open 間で正規化し、ストライプ全体を比率配分で
  // 埋める（content の slot サイズと一致）。collapsed slot は flex フロー外
  // （CollapsedCluster）に出すので配分に影響しない。
  const openRatioSum = segments.reduce(
    (sum, s) => sum + (s.open ? s.sizeRatio : 0),
    0,
  );

  // 連続する collapsed segment を 1 cluster にまとめる（cluster 内で実寸スタック）
  const items: StripeItem[] = [];
  for (const seg of segments) {
    if (seg.open) {
      items.push({ kind: "open", segment: seg });
      continue;
    }
    const last = items[items.length - 1];
    if (last && last.kind === "collapsed") {
      last.segments.push(seg);
    } else {
      items.push({ kind: "collapsed", segments: [seg] });
    }
  }

  const slotIndexOf = (slotId: string): number => {
    const i = slots.findIndex((slot) => slot.id === slotId);
    return i < 0 ? slots.length : i;
  };
  const stripeEndInsertIndex =
    slotIndexOf(segments[segments.length - 1].slotId) + 1;

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

      {items.map((item, itemIdx) => {
        if (item.kind === "collapsed") {
          return (
            <CollapsedCluster
              key={`collapsed-${item.segments[0].key}`}
              segments={item.segments}
              orientation={orientation}
              region={region}
              anchor={itemIdx === 0 ? "start" : "end"}
            />
          );
        }

        const seg = item.segment;
        const betweenInsertIndex = slotIndexOf(seg.slotId);
        return (
          <Fragment key={seg.key}>
            {itemIdx > 0 && (
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
                    data-insert-index={betweenInsertIndex}
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
            <StripeGroup
              segment={seg}
              orientation={orientation}
              region={region}
              flexGrow={openRatioSum > 0 ? seg.sizeRatio / openRatioSum : 1}
            />
          </Fragment>
        );
      })}

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
