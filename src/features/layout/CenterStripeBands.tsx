import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { EditorToggleIcon } from "./EditorToggleIcon";
import { ToolWindowIcon } from "./ToolWindowIcon";
import { CenterStripeDropOverlay } from "./CenterStripeDropOverlay";
import { useShallow } from "zustand/react/shallow";
import { useLayoutStore } from "./layoutStore";
import { useDragDropZonesReady } from "./useDragDropZonesReady";
import type { CenterStripeSegment } from "./useCenterSegments";

interface CenterStripeBandProps {
  segment: CenterStripeSegment;
  flexGrow: number;
}

function CenterStripeBand({ segment, flexGrow }: CenterStripeBandProps) {
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const isTool = segment.kind === "tool";

  return (
    <div
      data-center-stripe-band
      data-band-open={segment.open ? "true" : "false"}
      data-center-stripe-band-kind={segment.kind}
      data-center-stripe-slot-id={segment.slotId}
      {...(isTool
        ? {
            "data-drop-segment": segment.key,
            "data-drop-slot-id": segment.slotId,
            "data-drop-region": "center",
          }
        : {})}
      style={{
        flexGrow,
        flexBasis: segment.open ? 0 : "auto",
        flexShrink: 0,
      }}
      className={cn(
        "relative flex h-full min-h-0 min-w-0 flex-row items-center justify-start gap-0.5 overflow-x-auto overflow-y-hidden px-0.5",
        segment.kind === "editor" && segment.open && "min-w-0 flex-1",
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
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);

  return (
    <div
      data-stripe-collapsed-cluster
      className="relative h-full"
      style={{ flexGrow: 0, flexBasis: 0, flexShrink: 0 }}
    >
      <div
        className={cn(
          "absolute bottom-0 top-0 flex flex-row items-center gap-0.5",
          anchor === "start" ? "left-0" : "right-0",
          draggingPanel && !layoutLocked
            ? "pointer-events-auto"
            : "pointer-events-none",
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

  const dropSegments = segments.map((segment) => ({
    kind: segment.kind,
    slotId: segment.slotId,
    open: segment.open,
    sizeRatio: segment.sizeRatio,
  }));

  return (
    <div
      data-stripe-root
      data-stripe-region="center"
      className={cn(
        "relative flex h-full min-h-0 overflow-hidden",
        hasOpenBands || showDropZones
          ? "w-full min-w-0"
          : "w-max min-w-max shrink-0",
      )}
    >
      {showDropZones && (
        <CenterStripeDropOverlay
          segments={dropSegments}
          slotIds={slotIds}
          stripeEndInsertIndex={stripeEndInsertIndex}
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
            <CenterStripeBand
              segment={segment}
              flexGrow={openRatioSum > 0 ? segment.sizeRatio / openRatioSum : 1}
            />
          </Fragment>
        );
      })}
    </div>
  );
}
