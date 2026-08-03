export interface ChronicleVerticalRenderWindow {
  top: number;
  bottom: number;
}

export interface ChronicleHorizontalRenderWindow {
  left: number;
  right: number;
}

/**
 * Keep one viewport of overscan above and below the visible Chronicle rows.
 * A null result means the host has not reported a usable height yet, so callers
 * can preserve the non-browser/test fallback without guessing at geometry.
 */
export function buildChronicleVerticalRenderWindow(args: {
  scrollTop: number;
  viewportHeight: number;
  contentHeight: number;
}): ChronicleVerticalRenderWindow | null {
  const { viewportHeight } = args;
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) return null;

  const contentHeight = Math.max(0, args.contentHeight);
  const scrollTop = Math.max(0, args.scrollTop);
  return {
    top: Math.max(0, scrollTop - viewportHeight),
    bottom: Math.min(contentHeight, scrollTop + viewportHeight * 2),
  };
}

/**
 * Convert the visible track and one viewport of horizontal overscan on each
 * side into the untransformed Chronicle world coordinate system.
 *
 * Horizontal culling is essential for long, densely packed timelines: many
 * markers can share the same vertical row while being thousands of days away
 * from the current view. The one-viewport overscan also lets compositor-only
 * pan/zoom previews move a full screen before React has to project a new
 * window.
 */
export function buildChronicleHorizontalRenderWindow(args: {
  worldOffsetX: number;
  viewportWidth: number;
}): ChronicleHorizontalRenderWindow | null {
  if (
    !Number.isFinite(args.worldOffsetX) ||
    !Number.isFinite(args.viewportWidth) ||
    args.viewportWidth <= 0
  ) {
    return null;
  }
  return {
    left: -args.worldOffsetX - args.viewportWidth,
    right: -args.worldOffsetX + args.viewportWidth * 2,
  };
}

export function chronicleMarkerIntersectsRenderWindow(args: {
  markerTop: number;
  markerHeight: number;
  /** Current FLIP/reorder offset; retain both the source and destination row. */
  markerOffsetY?: number;
  window: ChronicleVerticalRenderWindow;
}): boolean {
  const intersectsAt = (top: number) =>
    top + args.markerHeight >= args.window.top && top <= args.window.bottom;
  return (
    intersectsAt(args.markerTop) ||
    ((args.markerOffsetY ?? 0) !== 0 &&
      intersectsAt(args.markerTop + (args.markerOffsetY ?? 0)))
  );
}

export function chronicleMarkerIntersectsHorizontalRenderWindow(args: {
  markerLeft: number;
  markerWidth: number;
  window: ChronicleHorizontalRenderWindow;
}): boolean {
  return (
    args.markerLeft + Math.max(0, args.markerWidth) >= args.window.left &&
    args.markerLeft <= args.window.right
  );
}

export function chronicleEdgeIntersectsRenderWindow(args: {
  causeY: number;
  effectY: number;
  window: ChronicleVerticalRenderWindow;
}): boolean {
  const edgeTop = Math.min(args.causeY, args.effectY);
  const edgeBottom = Math.max(args.causeY, args.effectY);
  return edgeBottom >= args.window.top && edgeTop <= args.window.bottom;
}

export function chronicleEdgeIntersectsHorizontalRenderWindow(args: {
  causeX: number;
  effectX: number;
  window: ChronicleHorizontalRenderWindow;
}): boolean {
  const edgeLeft = Math.min(args.causeX, args.effectX);
  const edgeRight = Math.max(args.causeX, args.effectX);
  return edgeRight >= args.window.left && edgeLeft <= args.window.right;
}
