import {
  computeFillerRegion,
  STRIPE_SIZE,
  SPLITTER_GUTTER_PX,
} from "./layoutConstants";
import type { RegionId } from "./layoutTypes";

export interface LayoutGridMetrics {
  leftStripePx: number;
  rightStripePx: number;
  leftContentPx: number;
  rightContentPx: number;
  leftSplitterPx: number;
  rightSplitterPx: number;
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
    input.leftOpen && fillerRegion !== "left" ? SPLITTER_GUTTER_PX : 0;
  const rightSplitterPx =
    input.rightOpen && fillerRegion !== "right" ? SPLITTER_GUTTER_PX : 0;

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
    centerBandVisible: input.centerBandVisible,
    centerColumnPx,
    fillerRegion,
    leftDockPx,
    rightDockPx,
    bottomDockPx: bottomDock,
    bottomRowInset: bottomDock,
    bottomCellPx: bottomDock + (input.bottomOpen ? SPLITTER_GUTTER_PX : 0),
  };
}

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
    leftContentColumn,
    `${metrics.leftSplitterPx}px`,
    metrics.centerColumnPx,
    `${metrics.rightSplitterPx}px`,
    rightContentColumn,
    `${metrics.rightStripePx}px`,
  ].join(" ");
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
  >,
): number {
  return (
    metrics.leftStripePx +
    metrics.rightStripePx +
    metrics.leftContentPx +
    metrics.rightContentPx +
    metrics.leftSplitterPx +
    metrics.rightSplitterPx
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
