import { STRIPE_SIZE, SPLITTER_GUTTER_PX } from "./layoutConstants";
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
  const leftContentPx =
    input.hasLeft && input.leftOpen ? input.leftSize : 0;
  const rightContentPx =
    input.hasRight && input.rightOpen ? input.rightSize : 0;
  const leftSplitterPx = input.leftOpen ? SPLITTER_GUTTER_PX : 0;
  const rightSplitterPx = input.rightOpen ? SPLITTER_GUTTER_PX : 0;

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
    centerColumnPx: input.centerBandVisible ? "minmax(0, 1fr)" : "0px",
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
  return [
    `${metrics.leftStripePx}px`,
    `${metrics.leftContentPx}px`,
    `${metrics.leftSplitterPx}px`,
    metrics.centerColumnPx,
    `${metrics.rightSplitterPx}px`,
    `${metrics.rightContentPx}px`,
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
