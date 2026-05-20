import { STRIPE_SIZE, SPLITTER_GUTTER_PX } from "./layoutConstants";
import type { RegionId } from "./layoutTypes";

export interface LayoutGridMetrics {
  leftStripePx: number;
  rightStripePx: number;
  leftContentPx: number;
  rightContentPx: number;
  leftSplitterPx: number;
  rightSplitterPx: number;
  bottomCellPx: number;
  /** Bottom row height (stripe + optional content). Side stripe columns only. */
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
  leftSize: number;
  rightSize: number;
  bottomSize: number;
}

/** Region content size: open → stored size, closed → 0. */
export function regionContentPx(open: boolean, storedSize: number): number {
  return open ? storedSize : 0;
}

/** Side dock width = stripe + content. */
export function sideDockPx(
  hasRegion: boolean,
  open: boolean,
  storedSize: number,
): number {
  if (!hasRegion) return 0;
  return STRIPE_SIZE + regionContentPx(open, storedSize);
}

/** Bottom dock height = stripe + content. */
export function bottomDockPx(
  hasRegion: boolean,
  open: boolean,
  storedSize: number,
): number {
  if (!hasRegion) return 0;
  return STRIPE_SIZE + regionContentPx(open, storedSize);
}

/** Grid cell sizes: stripe / content / splitter columns are separate so bottom spans center. */
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
    leftDockPx,
    rightDockPx,
    bottomDockPx: bottomDock,
    bottomRowInset: bottomDock,
    bottomCellPx: bottomDock + (input.bottomOpen ? SPLITTER_GUTTER_PX : 0),
  };
}

/** 7-column grid: lstripe | lcontent | lspl | editor | rspl | rcontent | rstripe */
export function buildLayoutGridTemplateColumns(
  metrics: LayoutGridMetrics,
): string {
  return [
    `${metrics.leftStripePx}px`,
    `${metrics.leftContentPx}px`,
    `${metrics.leftSplitterPx}px`,
    "1fr",
    `${metrics.rightSplitterPx}px`,
    `${metrics.rightContentPx}px`,
    `${metrics.rightStripePx}px`,
  ].join(" ");
}

/** CSS calc for side-region stripe segment zone height. */
export function sideContentZoneHeight(bottomRowInset: number): string {
  return bottomRowInset > 0 ? `calc(100% - ${bottomRowInset}px)` : "100%";
}

/** Fixed horizontal chrome consumed before the flexible editor column. */
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

export function regionAxisSize(region: RegionId, metrics: LayoutGridMetrics): number {
  switch (region) {
    case "left":
      return metrics.leftDockPx;
    case "right":
      return metrics.rightDockPx;
    case "bottom":
      return metrics.bottomDockPx;
  }
}
