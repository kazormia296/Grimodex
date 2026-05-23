import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { EditorToggleIcon } from "./EditorToggleIcon";
import { StripeBandContextMenu } from "./StripeBandContextMenu";
import { ToolWindowIcon } from "./ToolWindowIcon";
import {
  MIN_EDITOR_SIZE,
  MIN_SLOT_SIZE,
  slotSplitterPx,
} from "./layoutConstants";
import { StripeSlotDivider } from "./StripeSlotDivider";
import { useCardLayout } from "./cardLayout";
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
  const bandKind = segment.kind === "editor" ? "editor" : "tool";

  return (
    <StripeBandContextMenu
      region="center"
      slotId={segment.slotId}
      bandKind={bandKind}
    >
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
          // open バンドは CenterContent の各列と同じ min-width でクランプする。
          // これが無いと editor が最低幅を割り込んだ際に帯と列の幅がずれる。
          minWidth: segment.open
            ? segment.kind === "editor"
              ? MIN_EDITOR_SIZE
              : MIN_SLOT_SIZE
            : undefined,
        }}
        className={cn(
          "relative flex h-full min-h-0 min-w-0 flex-row items-center justify-start gap-0.5 overflow-x-auto overflow-y-hidden",
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
              slotId={segment.slotId}
              active={panel.active}
              slotOpen={segment.open}
            />
          ))
        )}
      </div>
    </StripeBandContextMenu>
  );
}

interface CollapsedClusterProps {
  segments: CenterStripeSegment[];
  anchor: "start" | "end";
}

/** 先頭の折りたたみ tool 群。in-flow にすると open バンドが押し出され content とずれる。 */
function LeadingCollapsedCluster({ segments }: CollapsedClusterProps) {
  return <CollapsedCluster segments={segments} anchor="start" />;
}

/**
 * 開いたバンドの間／末尾に挟まる折りたたみ tool 群。flex フローでは 0 幅で
 * open バンドの比率配分に影響を与えず、アイコンは absolute オーバーレイで
 * 右境界へ寄せ、直前バンドの空き領域（アイコンは左寄せ）に重ねて表示する。
 */
function CollapsedCluster({ segments, anchor }: CollapsedClusterProps) {
  return (
    <div
      data-stripe-collapsed-cluster
      className="relative h-full"
      style={{ flexGrow: 0, flexBasis: 0, flexShrink: 0 }}
    >
      <div
        className={cn(
          "absolute z-50 flex flex-row items-center gap-0.5",
          anchor === "start"
            ? "bottom-0 left-0 top-0"
            : "bottom-0 right-0 top-0",
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
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const cardLayout = useCardLayout();
  const dividerGapPx = slotSplitterPx(cardLayout);
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
      {(() => {
        let renderedOpenBands = 0;

        return items.map((item, itemIdx) => {
          if (item.kind === "collapsed") {
            if (itemIdx === 0) {
              return (
                <LeadingCollapsedCluster
                  key={`collapsed-${item.segments[0].key}`}
                  segments={item.segments}
                  anchor="start"
                />
              );
            }
            return (
              <CollapsedCluster
                key={`collapsed-${item.segments[0].key}`}
                segments={item.segments}
                anchor="end"
              />
            );
          }

          if (item.kind === "pinned") {
            const segment = item.segment;
            const showDivider = renderedOpenBands > 0;
            return (
              <Fragment key={segment.key}>
                {showDivider && (
                  <StripeSlotDivider
                    orientation="horizontal"
                    thicknessPx={dividerGapPx}
                  />
                )}
                <CenterStripeBand segment={segment} flexGrow={0} />
              </Fragment>
            );
          }

          const segment = item.segment;
          const showDivider = renderedOpenBands > 0;
          renderedOpenBands += 1;

          return (
            <Fragment key={segment.key}>
              {showDivider && (
                <StripeSlotDivider
                  orientation="horizontal"
                  thicknessPx={dividerGapPx}
                />
              )}
              <CenterStripeBand
                segment={segment}
                flexGrow={
                  openRatioSum > 0 ? segment.sizeRatio / openRatioSum : 1
                }
              />
            </Fragment>
          );
        });
      })()}
    </div>
  );
}
