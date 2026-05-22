import {
  computeFillerRegion,
  regionSplitterPx,
  STRIPE_SIZE,
  STRIPE_GAP_PX,
} from "./layoutConstants";
import type { RegionId } from "./layoutTypes";

export interface LayoutGridMetrics {
  leftStripePx: number;
  rightStripePx: number;
  leftContentPx: number;
  rightContentPx: number;
  leftSplitterPx: number;
  rightSplitterPx: number;
  /** stripe ↔ content 間の D案ギャップ列幅。stripe が無ければ 0。 */
  gapLeftPx: number;
  gapRightPx: number;
  /** center stripe ↔ main 間のギャップ行高さ。もちもち OFF 時は 0。 */
  gapRowPx: number;
  centerColumnPx: string;
  centerBandVisible: boolean;
  /**
   * center band 非表示時に、余白を吸収して伸縮する open side region。
   * その region の content 列は `1fr` になり、専用 splitter は消える
   * （固定境界を持たないため）。center band 表示時や埋める region が
   * 無いときは null。
   */
  fillerRegion: "left" | "right" | null;
  bottomCellPx: number;
  bottomRowInset: number;
  leftDockPx: number;
  rightDockPx: number;
  bottomDockPx: number;
}

export interface LayoutGridMetricsInput {
  hasLeft: boolean;
  hasRight: boolean;
  hasBottom: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  bottomOpen: boolean;
  centerBandVisible: boolean;
  leftSize: number;
  rightSize: number;
  bottomSize: number;
  /** もちもちレイアウト ON/OFF。未指定時は ON 扱い。 */
  mochi?: boolean;
}

export function regionContentPx(open: boolean, storedSize: number): number {
  return open ? storedSize : 0;
}

export function sideDockPx(
  hasRegion: boolean,
  open: boolean,
  storedSize: number,
): number {
  if (!hasRegion) return 0;
  return STRIPE_SIZE + regionContentPx(open, storedSize);
}

export function bottomDockPx(
  hasRegion: boolean,
  open: boolean,
  storedSize: number,
): number {
  if (!hasRegion) return 0;
  return STRIPE_SIZE + regionContentPx(open, storedSize);
}

export function computeLayoutGridMetrics(
  input: LayoutGridMetricsInput,
): LayoutGridMetrics {
  const mochi = input.mochi ?? true;
  const splitterPx = regionSplitterPx(mochi);
  const gapPx = mochi ? STRIPE_GAP_PX : 0;
  const leftStripePx = input.hasLeft ? STRIPE_SIZE : 0;
  const rightStripePx = input.hasRight ? STRIPE_SIZE : 0;
  const leftContentPx = input.hasLeft && input.leftOpen ? input.leftSize : 0;
  const rightContentPx =
    input.hasRight && input.rightOpen ? input.rightSize : 0;

  // center band 非表示時は、開いている side region の 1 つを `1fr` filler に
  // してグリッド全体を埋める。filler が無いと固定 px 列だけになり、ウィンドウ
  // 幅に追従できず右側に余白が生じる。
  const leftIsOpen = input.hasLeft && input.leftOpen;
  const rightIsOpen = input.hasRight && input.rightOpen;
  const fillerRegion = computeFillerRegion({
    centerBandVisible: input.centerBandVisible,
    leftOpen: leftIsOpen,
    rightOpen: rightIsOpen,
  });

  // filler region は固定境界を持たないため専用 splitter を消す。
  const leftSplitterPx =
    input.leftOpen && fillerRegion !== "left" ? splitterPx : 0;
  const rightSplitterPx =
    input.rightOpen && fillerRegion !== "right" ? splitterPx : 0;

  // filler が無い（埋める region が無い）ときは center 列を `1fr` にして
  // グリッド幅を埋める。filler があるときは center は 0px。
  const centerColumnPx =
    input.centerBandVisible || fillerRegion === null ? "minmax(0, 1fr)" : "0px";

  const leftDockPx = sideDockPx(input.hasLeft, input.leftOpen, input.leftSize);
  const rightDockPx = sideDockPx(
    input.hasRight,
    input.rightOpen,
    input.rightSize,
  );
  const bottomDock = bottomDockPx(
    input.hasBottom,
    input.bottomOpen,
    input.bottomSize,
  );

  return {
    leftStripePx,
    rightStripePx,
    leftContentPx,
    rightContentPx,
    leftSplitterPx,
    rightSplitterPx,
    gapLeftPx: leftStripePx > 0 ? gapPx : 0,
    gapRightPx: rightStripePx > 0 ? gapPx : 0,
    gapRowPx: gapPx,
    centerBandVisible: input.centerBandVisible,
    centerColumnPx,
    fillerRegion,
    leftDockPx,
    rightDockPx,
    bottomDockPx: bottomDock,
    bottomRowInset: bottomDock,
    bottomCellPx: bottomDock + (input.bottomOpen ? splitterPx : 0),
  };
}

export function buildCenterStripeGridTemplateColumns(
  metrics: LayoutGridMetrics,
): string {
  const leftContentColumn =
    metrics.fillerRegion === "left"
      ? "minmax(0, 1fr)"
      : `${metrics.leftContentPx}px`;
  const rightContentColumn =
    metrics.fillerRegion === "right"
      ? "minmax(0, 1fr)"
      : `${metrics.rightContentPx}px`;
  const centerStripeColumn =
    metrics.centerColumnPx === "0px" ? "auto" : metrics.centerColumnPx;

  return [
    leftContentColumn,
    `${metrics.leftSplitterPx}px`,
    centerStripeColumn,
    `${metrics.rightSplitterPx}px`,
    rightContentColumn,
  ].join(" ");
}

/**
 * 9 列構成（D案）: stripe / gap / content / splitter / center /
 * splitter / content / gap / stripe。gap 列と splitter 帯がパネル間の
 * 余白を作る — 線は引かない。grid-template-areas の `.` セルと対応。
 */
export function buildLayoutGridTemplateColumns(
  metrics: LayoutGridMetrics,
): string {
  const leftContentColumn =
    metrics.fillerRegion === "left"
      ? "minmax(0, 1fr)"
      : `${metrics.leftContentPx}px`;
  const rightContentColumn =
    metrics.fillerRegion === "right"
      ? "minmax(0, 1fr)"
      : `${metrics.rightContentPx}px`;
  return [
    `${metrics.leftStripePx}px`,
    `${metrics.gapLeftPx}px`,
    leftContentColumn,
    `${metrics.leftSplitterPx}px`,
    metrics.centerColumnPx,
    `${metrics.rightSplitterPx}px`,
    rightContentColumn,
    `${metrics.gapRightPx}px`,
    `${metrics.rightStripePx}px`,
  ].join(" ");
}

/**
 * 行構成（D案）: center stripe / gap 行 / main / (任意) bottom。
 * gap 行が center stripe と main の間に呼吸を作る。bottom 境界は
 * bottomCellPx 先頭の splitter 帯がギャップを兼ねる。
 */
export function buildLayoutGridTemplateRows(
  metrics: LayoutGridMetrics,
  hasBottom: boolean,
): string {
  const rows = [`${STRIPE_SIZE}px`, `${metrics.gapRowPx}px`, "1fr"];
  if (hasBottom) rows.push(`${metrics.bottomCellPx}px`);
  return rows.join(" ");
}

export function sideContentZoneHeight(bottomRowInset: number): string {
  return bottomRowInset > 0 ? `calc(100% - ${bottomRowInset}px)` : "100%";
}

export function sideLayoutChromePx(
  metrics: Pick<
    LayoutGridMetrics,
    | "leftStripePx"
    | "rightStripePx"
    | "leftContentPx"
    | "rightContentPx"
    | "leftSplitterPx"
    | "rightSplitterPx"
    | "gapLeftPx"
    | "gapRightPx"
  >,
): number {
  return (
    metrics.leftStripePx +
    metrics.rightStripePx +
    metrics.leftContentPx +
    metrics.rightContentPx +
    metrics.leftSplitterPx +
    metrics.rightSplitterPx +
    metrics.gapLeftPx +
    metrics.gapRightPx
  );
}

export function regionAxisSize(
  region: RegionId,
  metrics: LayoutGridMetrics,
): number {
  switch (region) {
    case "left":
      return metrics.leftDockPx;
    case "right":
      return metrics.rightDockPx;
    case "bottom":
      return metrics.bottomDockPx;
  }
}
