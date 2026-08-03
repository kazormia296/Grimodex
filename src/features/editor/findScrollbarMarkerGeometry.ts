import {
  getBlockStartOffset,
  getLogicalScrollOffset,
  type RectLike,
  type ScrollOffsets,
} from "@/features/editor/editorLayout";

export interface FindMatchRect {
  rect: RectLike;
  current: boolean;
}

interface ScrollMetrics extends ScrollOffsets {
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

interface BuildFindScrollbarMarkersOptions {
  matchRects: ReadonlyArray<FindMatchRect>;
  containerRect: RectLike;
  scrollMetrics: ScrollMetrics;
  verticalMode: boolean;
  geometryScale?: number;
}

interface FindScrollbarTrackPixelOptions {
  rect: RectLike;
  containerRect: RectLike;
  scrollMetrics: ScrollMetrics;
  verticalMode: boolean;
  geometryScale: number;
}

export interface FindScrollbarMarker {
  positionPercent: number;
  current: boolean;
}

function rectWidth(rect: RectLike): number {
  return rect.right - rect.left;
}

function rectHeight(rect: RectLike): number {
  return rect.bottom - rect.top;
}

function isVisibleRect(rect: RectLike): boolean {
  return (
    [rect.top, rect.right, rect.bottom, rect.left].every(Number.isFinite) &&
    rectWidth(rect) > 0 &&
    rectHeight(rect) > 0
  );
}

/** Return the logical first rendered fragment, excluding display:none hits. */
export function getFindDecorationRect(
  decoration: HTMLElement,
): RectLike | null {
  for (const fragment of decoration.getClientRects()) {
    if (isVisibleRect(fragment)) return fragment;
  }

  const fallback = decoration.getBoundingClientRect();
  return isVisibleRect(fallback) ? fallback : null;
}

/**
 * DOM rectangles include CSS zoom while scroll offsets and extents do not.
 * offsetWidth/offsetHeight share the rectangle's border-box boundary and let
 * the projection normalize both coordinate systems without reading settings.
 */
export function getFindGeometryScale(
  scrollContainer: HTMLElement,
  containerRect: RectLike,
  verticalMode: boolean,
): number {
  const visualExtent = verticalMode
    ? rectWidth(containerRect)
    : rectHeight(containerRect);
  const layoutExtent = verticalMode
    ? scrollContainer.offsetWidth
    : scrollContainer.offsetHeight;
  const scale = visualExtent / layoutExtent;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function getFindScrollbarTrackPixel({
  rect,
  containerRect,
  scrollMetrics,
  verticalMode,
  geometryScale,
}: FindScrollbarTrackPixelOptions): number | null {
  const scrollExtent = verticalMode
    ? scrollMetrics.scrollWidth
    : scrollMetrics.scrollHeight;
  const clientExtent = verticalMode
    ? scrollMetrics.clientWidth
    : scrollMetrics.clientHeight;
  if (
    !isVisibleRect(rect) ||
    !Number.isFinite(scrollExtent) ||
    !Number.isFinite(clientExtent) ||
    scrollExtent <= clientExtent ||
    clientExtent <= 1 ||
    !Number.isFinite(geometryScale) ||
    geometryScale <= 0
  ) {
    return null;
  }

  const blockSize = verticalMode ? rectWidth(rect) : rectHeight(rect);
  const contentMidpoint =
    getLogicalScrollOffset(scrollMetrics, verticalMode) * geometryScale +
    getBlockStartOffset(containerRect, rect, verticalMode) +
    blockSize / 2;
  if (!Number.isFinite(contentMidpoint)) return null;

  const ratio = Math.min(
    Math.max(contentMidpoint / (scrollExtent * geometryScale), 0),
    1,
  );
  return Math.round(ratio * Math.max(Math.round(clientExtent) - 1, 1));
}

/** Project rendered find decorations onto the logical block-axis track. */
export function buildFindScrollbarMarkers({
  matchRects,
  containerRect,
  scrollMetrics,
  verticalMode,
  geometryScale = 1,
}: BuildFindScrollbarMarkersOptions): FindScrollbarMarker[] {
  const scrollExtent = verticalMode
    ? scrollMetrics.scrollWidth
    : scrollMetrics.scrollHeight;
  const clientExtent = verticalMode
    ? scrollMetrics.clientWidth
    : scrollMetrics.clientHeight;

  if (
    !Number.isFinite(scrollExtent) ||
    !Number.isFinite(clientExtent) ||
    scrollExtent <= clientExtent ||
    clientExtent <= 1 ||
    !Number.isFinite(geometryScale) ||
    geometryScale <= 0
  ) {
    return [];
  }

  const lastTrackPixel = Math.max(Math.round(clientExtent) - 1, 1);
  const markersByPixel = new Map<
    number,
    { positionPercent: number; current: boolean }
  >();

  for (const match of matchRects) {
    const trackPixel = getFindScrollbarTrackPixel({
      rect: match.rect,
      containerRect,
      scrollMetrics,
      verticalMode,
      geometryScale,
    });
    if (trackPixel === null) continue;
    const existing = markersByPixel.get(trackPixel);
    if (existing && (existing.current || !match.current)) continue;

    markersByPixel.set(trackPixel, {
      positionPercent: (trackPixel / lastTrackPixel) * 100,
      current: match.current,
    });
  }

  return [...markersByPixel.entries()]
    .sort(([leftPixel], [rightPixel]) => leftPixel - rightPixel)
    .map(([, marker]) => marker);
}
