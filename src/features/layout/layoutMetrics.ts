import {
  computeFillerRegion,
  HORIZONTAL_STRIPE_SIZE,
  regionSplitterPx,
  STRIPE_SIZE,
  STRIPE_GAP_PX,
} from "./layoutConstants";
import type { BottomCornerOwnership, RegionId } from "./layoutTypes";

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
  /** center stripe ↔ main 間のギャップ行高さ。 */
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
  // bottom region は content と icon stripe を 1 セル内で縦積みするため、
  // 両者の間の stripe-gap をドック高さに含める。
  const stripeGap = open ? STRIPE_GAP_PX : 0;
  return HORIZONTAL_STRIPE_SIZE + regionContentPx(open, storedSize) + stripeGap;
}

export function computeLayoutGridMetrics(
  input: LayoutGridMetricsInput,
): LayoutGridMetrics {
  const splitterPx = regionSplitterPx();
  const gapPx = STRIPE_GAP_PX;
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
    // bottom row ↔ main 間のギャップ。閉じた bottom stripe のときも確保する。
    bottomCellPx: bottomDock + splitterPx,
  };
}

/**
 * center stripe 内側の 9 列テンプレート。center stripe は最上段を全幅で
 * 占有するため、メイングリッド（buildLayoutGridTemplateColumns）と同じ
 * 9 列構成にして bands を下の editor 列と揃える。center band 非表示時のみ
 * 中央列を `auto` にしてツールアイコンを自然幅で残す。
 */
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
    `${metrics.leftStripePx}px`,
    `${metrics.gapLeftPx}px`,
    leftContentColumn,
    `${metrics.leftSplitterPx}px`,
    centerStripeColumn,
    `${metrics.rightSplitterPx}px`,
    rightContentColumn,
    `${metrics.gapRightPx}px`,
    `${metrics.rightStripePx}px`,
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
  const rows = [`${HORIZONTAL_STRIPE_SIZE}px`, `${metrics.gapRowPx}px`, "1fr"];
  if (hasBottom) rows.push(`${metrics.bottomCellPx}px`);
  return rows.join(" ");
}

/**
 * 9 列グリッドの grid-template-areas。
 *  - center stripe は最上段を全幅で占有し、上の両角も持つ。
 *  - side stripe は main 行（＋角所有時は bottom 行）にのみ広がり、上端は
 *    content / editor の上端と一致する（gap 行ぶん center stripe の下）。
 * bottom 行の構成は角オーナーシップで切り替える:
 *  - side 所有: その側の side region（stripe / gap / content / splitter）が
 *    bottom 行まで縦に伸び、bottom region はその分インセットされる。
 *  - bottom 所有: その角まで bottom region が広がる。
 * editor 列（中央）は常に bottom region。lcontent/lspl/rcontent/rspl は
 * side 所有時に main+bottom の 2 行にまたがる矩形になる。
 */
export function buildLayoutGridTemplateAreas(
  hasBottom: boolean,
  bottomCorners: BottomCornerOwnership,
): string {
  const cstripe =
    '"cstripe cstripe cstripe cstripe cstripe cstripe cstripe cstripe cstripe"';
  const gapRow = '". . . . . . . . ."';
  const main = '"lstripe . lcontent lspl editor rspl rcontent . rstripe"';
  if (!hasBottom) return `${cstripe} ${gapRow} ${main}`;

  // bottom 行の左 4 列 / 右 4 列。side 所有なら side region 各列が降りてくる。
  const left = bottomCorners.left
    ? "bottom bottom bottom bottom"
    : "lstripe . lcontent lspl";
  const right = bottomCorners.right
    ? "bottom bottom bottom bottom"
    : "rspl rcontent . rstripe";
  const bottom = `"${left} bottom ${right}"`;
  return `${cstripe} ${gapRow} ${main} ${bottom}`;
}

/** 視覚 zoom（パネル最大化）対象の grid 領域。 */
export type ZoomRegion = RegionId | "center";

/**
 * zoom 中の 9 列テンプレート。対象 region の content 列だけを 1fr にし、他は
 * すべて 0px に潰す。cell は unmount しない — LayoutShell 側で
 * visibility:hidden + inert を併用して paint / hit を止める。
 * center / bottom は中央列を使う（bottom zoom の行全幅化は
 * grid-template-areas 側で bottomCorners を両 true にして行う）。
 */
export function buildZoomGridTemplateColumns(zoom: ZoomRegion): string {
  const columns = Array.from({ length: 9 }, () => "0px");
  const targetIndex = zoom === "left" ? 2 : zoom === "right" ? 6 : 4;
  columns[targetIndex] = "minmax(0, 1fr)";
  return columns.join(" ");
}

/**
 * zoom 中の行テンプレート。center stripe 行は ZoomRestoreBar（復帰バー）用に
 * 通常時と同じ高さで残し、gap 行も維持する（カードレイアウトの呼吸を保つ）。
 * bottom zoom は bottom 行のみ、それ以外は main 行のみを 1fr にする。
 */
export function buildZoomGridTemplateRows(
  zoom: ZoomRegion,
  hasBottom: boolean,
  gapRowPx: number,
): string {
  const rows = [`${HORIZONTAL_STRIPE_SIZE}px`, `${gapRowPx}px`];
  if (zoom === "bottom") {
    return [...rows, "0px", "minmax(0, 1fr)"].join(" ");
  }
  rows.push("minmax(0, 1fr)");
  if (hasBottom) rows.push("0px");
  return rows.join(" ");
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
