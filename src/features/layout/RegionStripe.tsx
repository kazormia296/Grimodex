import { Fragment } from "react";
import { cn } from "@/lib/utils";
import { ToolWindowIcon } from "./ToolWindowIcon";
import { StripeBandContextMenu } from "./StripeBandContextMenu";
import {
  acceptsToolWindowReassignDrag,
  TOOL_WINDOW_REASSIGN_TYPE,
} from "./layoutDnD";
import { useShallow } from "zustand/react/shallow";
import { useLayoutStore } from "./layoutStore";
import {
  DND_NEW_SLOT_BETWEEN_HALF_PX,
  slotSplitterPx,
} from "./layoutConstants";
import { useCardLayout } from "./cardLayout";
import { useDragDropZonesReady } from "./useDragDropZonesReady";
import type { LayoutRegionId, RegionId } from "./layoutTypes";
import type { RegionSegment } from "./useRegionSegments";

interface StripeGroupProps {
  segment: RegionSegment;
  orientation: "vertical" | "horizontal";
  region: LayoutRegionId;
  /** open slot は正規化済み比率（open 間で合計 1）、collapsed slot は 0 */
  flexGrow: number;
  /**
   * 先頭 CollapsedCluster overlay と重なる位置にこの open slot が置かれる
   * とき、内部アイコンを overlay 幅ぶんずらして occlusion を防ぐ (vertical は
   * top、horizontal は left)。
   *
   * 注: バンドの outer に padding を入れると flex-shrink:0 と相俟って outer が
   * 膨らみ、後続バンドが下方向へ押し出されて content slot 境界とズレる。
   * よってアイコンは absolute で逃がし、バンドの flex 寸法は据え置く。
   */
  leadingPaddingPx?: number;
}

function StripeGroup({
  segment,
  orientation,
  region,
  flexGrow,
  leadingPaddingPx = 0,
}: StripeGroupProps) {
  const isVertical = orientation === "vertical";
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
    <StripeBandContextMenu
      region={region}
      slotId={segment.slotId}
      bandKind="tool"
    >
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
          "pointer-events-auto relative flex min-h-0 min-w-0",
          isVertical
            ? "w-full flex-col items-center justify-start gap-0.5 overflow-y-auto overflow-x-hidden"
            : "h-full flex-row items-center justify-start gap-0.5 overflow-x-auto overflow-y-hidden",
          draggingPanel && !layoutLocked && "ring-1 ring-primary/20",
        )}
      >
        {leadingPaddingPx > 0 ? (
          // バンドの outer に padding を入れると flex-shrink:0 と相俟って outer
          // が膨らみ、後続バンドが下方向へ押し出されて content の slot 境界と
          // ずれる。padding 相当の offset は absolute で吸収し、バンドの flex
          // 寸法 (= 後続バンドの起点) は据え置く。
          <div
            data-stripe-leading-shift
            className={cn(
              "absolute flex items-center gap-0.5",
              isVertical
                ? "left-0 right-0 flex-col"
                : "top-0 bottom-0 flex-row",
            )}
            style={
              isVertical
                ? { top: leadingPaddingPx }
                : { left: leadingPaddingPx }
            }
          >
            {segment.panels.map((panel) => (
              <ToolWindowIcon
                key={panel.id}
                panelId={panel.id}
                region={region}
                slotId={segment.slotId}
                active={panel.active}
                slotOpen={segment.open}
              />
            ))}
          </div>
        ) : (
          segment.panels.map((panel) => (
            <ToolWindowIcon
              key={panel.id}
              panelId={panel.id}
              region={region}
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
  segments: RegionSegment[];
  orientation: "vertical" | "horizontal";
  region: LayoutRegionId;
  /** "start" = ストライプ先頭側へ寄せる / "end" = 末尾側へ寄せる */
  anchor: "start" | "end";
}

/**
 * 先頭の折りたたみ slot 群。in-flow にすると open バンドが押し出され、
 * 後続 open バンドの開始位置が content の slot 0 と一致しなくなる。
 * 0 サイズの absolute オーバーレイで描画し、後続 open バンドは stripe の
 * 先頭から比率配分で割り振られるようにする。
 */
function LeadingCollapsedCluster({
  segments,
  orientation,
  region,
}: Omit<CollapsedClusterProps, "anchor">) {
  return (
    <CollapsedCluster
      segments={segments}
      orientation={orientation}
      region={region}
      anchor="start"
    />
  );
}

/**
 * 開いたバンドの間／末尾に挟まる折りたたみ slot 群。
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
          "absolute z-40 flex items-center gap-0.5",
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
  region: LayoutRegionId;
  orientation: "vertical" | "horizontal";
  segments: ReadonlyArray<RegionSegment>;
  /**
   * stripe 端に確保するコーナートグル用の余白(px)。bottom stripe が
   * 角を取るときだけ使う（icon が toggle と重ならないように）。
   * vertical では top/bottom、horizontal では left/right に対応。
   * 注: alignment 維持の都合上、content 側に同じ余白は付けない。
   */
  reserveStartPx?: number;
  reserveEndPx?: number;
}

type StripeItem =
  | { kind: "open"; segment: RegionSegment }
  | { kind: "collapsed"; segments: RegionSegment[] };

export function RegionStripe({
  region,
  orientation,
  segments,
  reserveStartPx = 0,
  reserveEndPx = 0,
}: RegionStripeProps) {
  const slotIds = useLayoutStore(
    useShallow((s) =>
      region === "center"
        ? s.layout.center.segments
            .filter((seg) => seg.kind === "tool")
            .map((seg) => seg.id)
        : s.layout.regions[region as RegionId].slots.map((slot) => slot.id),
    ),
  );
  const movePanelToNewSlot = useLayoutStore((s) => s.movePanelToNewSlot);
  const setDraggingPanel = useLayoutStore((s) => s.setDraggingPanel);
  const setDragOverTarget = useLayoutStore((s) => s.setDragOverTarget);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const layoutLocked = useLayoutStore((s) => s.layoutLocked);
  const showDropZones = useDragDropZonesReady(
    Boolean(draggingPanel && !layoutLocked),
  );

  // segments が空でも null にせず描画する（center stripe を空のままドロップ先
  // にするため）。side/bottom region は全 panel 事前登録なので空にはならない。

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

  // 先頭 CollapsedCluster は 0 サイズ overlay として stripe-root の start に積まれる。
  // 後続の最初の open slot も flex 開始 0 から justify-start でアイコンを並べるため、
  // open 側 (z-30) が overlay のアイコンを覆い隠す。最初の open slot にだけ
  // cluster の icon span ぶんの padding を入れて overlay の外へ逃がす。
  const leadingCluster =
    items.length > 0 && items[0].kind === "collapsed" ? items[0] : null;
  const hasOpenBands = items.some((item) => item.kind === "open");
  const leadingClusterIconCount =
    leadingCluster && hasOpenBands
      ? leadingCluster.segments.reduce((sum, seg) => sum + seg.panels.length, 0)
      : 0;
  // h-7 w-7 = 28px / gap-0.5 = 2px / 末尾に小さい呼吸を確保。
  const leadingPaddingPx =
    leadingClusterIconCount > 0
      ? leadingClusterIconCount * 28 + (leadingClusterIconCount - 1) * 2 + 4
      : 0;

  const slotIndexOf = (slotId: string): number => {
    const i = slotIds.indexOf(slotId);
    return i < 0 ? slotIds.length : i;
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

  // open slot 間のアイコングループ仕切り幅。content 側の Splitter 帯
  // （slotSplitterPx）と一致させることで、ストライプの分割位置と
  // content の Splitter 位置を揃える。
  const cardLayout = useCardLayout();
  const dividerGapPx = slotSplitterPx(cardLayout);

  return (
    <div
      data-stripe-root
      data-stripe-region={region}
      style={
        orientation === "vertical"
          ? {
              paddingTop: reserveStartPx || undefined,
              paddingBottom: reserveEndPx || undefined,
            }
          : {
              paddingLeft: reserveStartPx || undefined,
              paddingRight: reserveEndPx || undefined,
            }
      }
      className={cn(
        "relative flex h-full min-h-0 w-full min-w-0 overflow-hidden",
        // D案: stripe/rail も他パネルと同じ「カード」。境界線は引かず、
        // ギャップで分離する。center は CenterStripe 側がカードを持つため除外。
        region !== "center" && "gx-panel",
        orientation === "vertical" ? "flex-col gap-0" : "flex-row gap-0",
      )}
    >
      {showDropZones && segments.length > 0 && (
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

      {(() => {
        let renderedOpenBands = 0;

        return items.map((item, itemIdx) => {
          if (item.kind === "collapsed") {
            if (itemIdx === 0) {
              return (
                <LeadingCollapsedCluster
                  key={`collapsed-${item.segments[0].key}`}
                  segments={item.segments}
                  orientation={orientation}
                  region={region}
                />
              );
            }
            return (
              <CollapsedCluster
                key={`collapsed-${item.segments[0].key}`}
                segments={item.segments}
                orientation={orientation}
                region={region}
                anchor="end"
              />
            );
          }

          const seg = item.segment;
          const betweenInsertIndex = slotIndexOf(seg.slotId);
          // collapsed cluster は 0 サイズ overlay。dividerは open バンド同士の
          // 境界にのみ挟む（content の Splitter と 1:1 対応させる）。
          const showDivider = renderedOpenBands > 0;
          const isFirstOpenBand = renderedOpenBands === 0;
          renderedOpenBands += 1;
          return (
            <Fragment key={seg.key}>
              {showDivider && (
                <div
                  className={cn(
                    "relative flex shrink-0 items-center justify-center",
                    orientation === "vertical" ? "w-full" : "h-full",
                  )}
                  style={
                    orientation === "vertical"
                      ? { height: dividerGapPx }
                      : { width: dividerGapPx }
                  }
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
                leadingPaddingPx={isFirstOpenBand ? leadingPaddingPx : 0}
              />
            </Fragment>
          );
        });
      })()}

      {showDropZones && (
        <div
          data-drop-edge="end"
          data-drop-region={region}
          data-insert-index={stripeEndInsertIndex}
          data-drop-surface="stripe-end"
          className="absolute z-20 opacity-0"
          style={
            // 空ストライプはストライプ全体をドロップ先にする。
            segments.length === 0
              ? { top: 0, bottom: 0, left: 0, right: 0 }
              : orientation === "vertical"
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
