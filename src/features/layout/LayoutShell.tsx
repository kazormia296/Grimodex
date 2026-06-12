import { lazy, memo, Suspense, useEffect, useMemo, useRef } from "react";
import { motion } from "motion/react";
import type { PanelId } from "./panelIds";
import {
  BottomCornerToggle,
  BOTTOM_CORNER_TOGGLE_CLEARANCE_PX,
} from "./BottomCornerToggle";
import { AnimatedRegionChrome } from "./AnimatedRegionChrome";
import { CenterContent } from "./CenterContent";
import { CenterStripe } from "./CenterStripe";
import { EditorArea } from "./EditorArea";
import {
  findPanelLocation,
  getBottomCorners,
  isCenterContentVisible,
} from "./layoutStateUtils";
import { RegionDock, SideRegionStripeColumn } from "./RegionDock";
import { RegionContent } from "./RegionContent";
import { RegionResizeSplitter } from "./RegionResizeSplitter";
import { SlotView } from "./SlotView";
import {
  buildLayoutGridTemplateAreas,
  buildLayoutGridTemplateColumns,
  buildLayoutGridTemplateRows,
  buildZoomGridTemplateColumns,
  buildZoomGridTemplateRows,
  computeLayoutGridMetrics,
  type ZoomRegion,
} from "./layoutMetrics";
import { useLayoutStore } from "./layoutStore";
import { useZoomReveal } from "./useZoomReveal";
import { ZoomRestoreBar } from "./ZoomRestoreBar";
import { useCardLayout } from "./cardLayout";
import { useRegionSegments } from "./useRegionSegments";
import { LayoutPanelDragGhost } from "./LayoutPanelDragGhost";
import { StripeInsertIndicator } from "./StripeInsertIndicator";
import { useLayoutPresetCrossfade } from "./useLayoutPresetCrossfade";

// gsap(+@gsap/react)を static import する drop-zone ハイライトを遅延化。常時 mount
// だと D&D が一度も起きなくても起動時に gsap(~22KB gzip)が parse される（所見#11）。
// 非ドラッグ時は元々 null を返すだけなので、draggingPanel での条件 mount は初回
// ドラッグのチャンクロード遅延のみで挙動は不変。
const LayoutDnDHighlightOverlay = lazy(() =>
  import("./LayoutDnDHighlightOverlay").then((m) => ({
    default: m.LayoutDnDHighlightOverlay,
  })),
);

interface LayoutShellProps {
  /** Screenshot mode: hide stripes and show a single panel full-screen */
  hidden?: boolean;
  screenshotPanelId?: PanelId | null;
}

function regionIsOpen(slots: { activePanel: string | null }[]): boolean {
  return slots.some((slot) => slot.activePanel !== null);
}

/**
 * IntelliJ-style asymmetric layout shell (§3 of layout design doc).
 *
 * Center Stripe is a full-width permanent top band — it spans every column
 * and owns the top corners. Side stripes span only the main row (plus the
 * bottom row when they own a bottom corner), so their top edge is flush with
 * the content / editor top edge. The bottom region is a wide bottom band.
 */
export const LayoutShell = memo(function LayoutShell({
  hidden = false,
  screenshotPanelId = null,
}: LayoutShellProps) {
  const segments = useRegionSegments();
  const layout = useLayoutStore((s) => s.layout);
  const draggingPanel = useLayoutStore((s) => s.draggingPanel);
  const { crossfadeControls } = useLayoutPresetCrossfade();
  const shellRef = useRef<HTMLDivElement>(null);

  const leftOpen = regionIsOpen(layout.regions.left.slots);
  const rightOpen = regionIsOpen(layout.regions.right.slots);
  const bottomOpen = regionIsOpen(layout.regions.bottom.slots);

  const hasLeft = segments.left.some((s) => s.panels.length > 0);
  const hasRight = segments.right.some((s) => s.panels.length > 0);
  const hasBottom = segments.bottom.some((s) => s.panels.length > 0);

  const centerBandVisible = isCenterContentVisible(layout);
  const cardLayout = useCardLayout();
  const maximizedPanelId = useLayoutStore((s) => s.maximizedPanelId);
  const clearMaximize = useLayoutStore((s) => s.clearMaximize);

  // 視覚 zoom の対象 grid 領域を解決する。対象パネルが表示中でなければ
  // zoom 無効として通常描画にフォールバック（防御。store 側のガードと
  // 自動解除 subscribe があるため通常は到達しない）。
  const zoomRegion = useMemo<ZoomRegion | null>(() => {
    if (maximizedPanelId === null) return null;
    if (maximizedPanelId === "editor") {
      return centerBandVisible ? "center" : null;
    }
    const location = findPanelLocation(layout, maximizedPanelId);
    if (location?.slot.activePanel !== maximizedPanelId) return null;
    return location.region;
  }, [maximizedPanelId, layout, centerBandVisible]);

  // 最大化突入時の clip-path reveal（ズームっぽい展開演出）。
  useZoomReveal(zoomRegion, layout, shellRef);

  // Esc で zoom 解除。階層的 Esc として一番外側に置く:
  // - isComposing: IME 変換キャンセルの Escape を奪わない（CodexEntryHeader
  //   と同じ作法）。
  // - defaultPrevented: Radix ダイアログ等の Esc close、および Timeline/Grid
  //   などパネル固有の Esc（選択解除等）が先に消費した場合は解除しない
  //   （その場合 Esc 2 度押しで zoom を抜ける — 意図した階層挙動）。
  useEffect(() => {
    if (zoomRegion === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
      clearMaximize();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [zoomRegion, clearMaximize]);

  // カードレイアウト ON/OFF 切替で chrome 量が変わるため、切替時に保存済みの
  // region サイズを即座に再クランプする（初回マウントでは何もしない）。
  const cardLayoutRef = useRef(cardLayout);
  useEffect(() => {
    if (cardLayoutRef.current === cardLayout) return;
    cardLayoutRef.current = cardLayout;
    useLayoutStore.getState().reclampForViewport();
  }, [cardLayout]);

  const metrics = useMemo(
    () =>
      computeLayoutGridMetrics({
        hasLeft,
        hasRight,
        hasBottom,
        leftOpen,
        rightOpen,
        bottomOpen,
        centerBandVisible,
        leftSize: layout.regions.left.size,
        rightSize: layout.regions.right.size,
        bottomSize: layout.regions.bottom.size,
        cardLayout,
      }),
    [
      bottomOpen,
      centerBandVisible,
      hasBottom,
      hasLeft,
      hasRight,
      layout.regions.bottom.size,
      layout.regions.left.size,
      layout.regions.right.size,
      leftOpen,
      rightOpen,
      cardLayout,
    ],
  );

  const gridTemplateColumns = useMemo(
    () =>
      zoomRegion !== null
        ? buildZoomGridTemplateColumns(zoomRegion)
        : buildLayoutGridTemplateColumns(metrics),
    [metrics, zoomRegion],
  );

  const gridTemplateRows = useMemo(
    () =>
      zoomRegion !== null
        ? buildZoomGridTemplateRows(zoomRegion, hasBottom, metrics.gapRowPx)
        : buildLayoutGridTemplateRows(metrics, hasBottom),
    [metrics, hasBottom, zoomRegion],
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

  // 9 列 (stripe/gap/content/splitter/center/splitter/content/gap/stripe) ×
  // 行 (center stripe / gap 行 / main / 任意 bottom)。bottom 行の両端は
  // 角オーナーシップで side stripe ↔ bottom region を切り替える。
  // bottom zoom 時のみ角を両方 bottom 所有にして bottom 行を全幅化する
  // （area 名は main 行に全て残るため他 cell が auto-placement に落ちない）。
  const bottomCorners = getBottomCorners(layout);
  const gridTemplateAreas = buildLayoutGridTemplateAreas(
    hasBottom,
    zoomRegion === "bottom" ? { left: true, right: true } : bottomCorners,
  );

  // zoom 中、対象 cell 以外を不可視化する。unmount はしない（DOM identity
  // 維持 = 配下エディタ/パネルの state 破棄回避）。visibility:hidden で
  // paint を止め、inert でフォーカス/ヒットを遮断する。0px に潰した cell
  // の中身は track からはみ出して描画されうるため visibility が必須。
  const cellHidden = (cell: ZoomRegion | "chrome") =>
    zoomRegion !== null && zoomRegion !== cell;
  const hiddenCellProps = (hidden: boolean) =>
    hidden ? ({ "aria-hidden": true, inert: true } as const) : {};
  const cellStyle = (
    base: React.CSSProperties,
    hidden: boolean,
  ): React.CSSProperties => (hidden ? { ...base, visibility: "hidden" } : base);

  return (
    <>
      {draggingPanel && (
        <Suspense fallback={null}>
          <LayoutDnDHighlightOverlay />
        </Suspense>
      )}
      <StripeInsertIndicator />
      <LayoutPanelDragGhost />
      {/* key={crossfadeKey} による remount 方式は禁止 — 配下の全エディタ/パネルが
          破棄・再生成されフリーズする。フェードは controls の opacity 再トリガーで
          実現する（useLayoutPresetCrossfade 参照）。 */}
      <motion.div
        ref={shellRef}
        data-layout-shell
        className="relative grid h-full w-full overflow-hidden"
        initial={false}
        animate={crossfadeControls}
        style={{
          gridTemplateColumns,
          gridTemplateRows,
          gridTemplateAreas,
          padding: cardLayout ? "var(--gx-outer-pad)" : undefined,
        }}
      >
        <div
          style={cellStyle({ gridArea: "cstripe" }, cellHidden("chrome"))}
          {...hiddenCellProps(cellHidden("chrome"))}
          className="min-h-0 min-w-0"
        >
          <CenterStripe />
        </div>

        {/* zoom 中の復帰バー。CenterStripe と同じ grid area に重ねる
            （CenterStripe 側は visibility:hidden + inert で休眠中）。 */}
        {zoomRegion !== null && maximizedPanelId !== null && (
          <div style={{ gridArea: "cstripe" }} className="min-h-0 min-w-0">
            <ZoomRestoreBar panelId={maximizedPanelId} />
          </div>
        )}

        {hasLeft && (
          <div
            style={cellStyle({ gridArea: "lstripe" }, cellHidden("chrome"))}
            {...hiddenCellProps(cellHidden("chrome"))}
            className="min-h-0"
          >
            <SideRegionStripeColumn
              region="left"
              stripeOrientation="vertical"
              segments={segments.left}
              reserveEndPx={
                hasBottom && !bottomCorners.left
                  ? BOTTOM_CORNER_TOGGLE_CLEARANCE_PX
                  : 0
              }
            />
          </div>
        )}

        {hasLeft && (
          <div
            data-zoom-cell="left"
            style={cellStyle({ gridArea: "lcontent" }, cellHidden("left"))}
            {...hiddenCellProps(cellHidden("left"))}
            className="min-h-0 min-w-0"
          >
            <AnimatedRegionChrome
              region="left"
              open={leftOpen}
              className="h-full w-full min-h-0 min-w-0"
            >
              <RegionContent region="left" orientation="vertical" />
            </AnimatedRegionChrome>
          </div>
        )}

        {/* region 境界 splitter は zoom 中 unmount する（ステートレスな
            chrome なので安全。0 サイズで残すと dev のヒット領域 assertion
            に引っかかる）。 */}
        {metrics.leftSplitterPx > 0 && zoomRegion === null && (
          <div
            style={{ gridArea: "lspl" }}
            className="flex h-full min-h-0 overflow-hidden"
          >
            <RegionResizeSplitter region="left" />
          </div>
        )}

        {centerBandVisible && (
          <div
            data-zoom-cell="center"
            style={cellStyle({ gridArea: "editor" }, cellHidden("center"))}
            {...hiddenCellProps(cellHidden("center"))}
            className="min-h-0 min-w-0"
          >
            <CenterContent />
          </div>
        )}

        {metrics.rightSplitterPx > 0 && zoomRegion === null && (
          <div
            style={{ gridArea: "rspl" }}
            className="flex h-full min-h-0 overflow-hidden"
          >
            <RegionResizeSplitter region="right" />
          </div>
        )}

        {hasRight && (
          <div
            data-zoom-cell="right"
            style={cellStyle({ gridArea: "rcontent" }, cellHidden("right"))}
            {...hiddenCellProps(cellHidden("right"))}
            className="min-h-0 min-w-0"
          >
            <AnimatedRegionChrome
              region="right"
              open={rightOpen}
              className="h-full w-full min-h-0 min-w-0"
            >
              <RegionContent region="right" orientation="vertical" />
            </AnimatedRegionChrome>
          </div>
        )}

        {hasRight && (
          <div
            style={cellStyle({ gridArea: "rstripe" }, cellHidden("chrome"))}
            {...hiddenCellProps(cellHidden("chrome"))}
            className="min-h-0"
          >
            <SideRegionStripeColumn
              region="right"
              stripeOrientation="vertical"
              segments={segments.right}
              reserveEndPx={
                hasBottom && !bottomCorners.right
                  ? BOTTOM_CORNER_TOGGLE_CLEARANCE_PX
                  : 0
              }
            />
          </div>
        )}

        {hasBottom && (
          <div
            data-zoom-cell="bottom"
            style={cellStyle({ gridArea: "bottom" }, cellHidden("bottom"))}
            {...hiddenCellProps(cellHidden("bottom"))}
            className="flex min-h-0 min-w-0 flex-col"
          >
            {zoomRegion !== null ? null : bottomOpen ? (
              <RegionResizeSplitter region="bottom" />
            ) : cardLayout ? (
              // content を閉じていても bottom stripe を浮かせるギャップ。
              <div
                aria-hidden
                className="shrink-0"
                style={{ height: "var(--gx-stripe-gap)" }}
              />
            ) : null}
            <RegionDock
              region="bottom"
              stripeOrientation="horizontal"
              contentOrientation="horizontal"
              segments={segments.bottom}
              stripeReserveStartPx={
                hasLeft && bottomCorners.left
                  ? BOTTOM_CORNER_TOGGLE_CLEARANCE_PX
                  : 0
              }
              stripeReserveEndPx={
                hasRight && bottomCorners.right
                  ? BOTTOM_CORNER_TOGGLE_CLEARANCE_PX
                  : 0
              }
            />
          </div>
        )}

        {/* 角オーナーシップ切替。side region と bottom region の両方が
            あるときだけ、その角の取り合いが意味を持つ。zoom 中は純装飾の
            chrome なので unmount で消す。 */}
        {zoomRegion === null && hasBottom && hasLeft && (
          <BottomCornerToggle side="left" />
        )}
        {zoomRegion === null && hasBottom && hasRight && (
          <BottomCornerToggle side="right" />
        )}
      </motion.div>
    </>
  );
});
