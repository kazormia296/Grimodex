/** Shared physical sizing rules for sticky paper surfaces. */
export interface StickyMetrics {
  width: number;
  minHeight: number;
  maxHeight: number;
  paddingInline: number;
  paddingBlock: number;
}

const MIN_WIDTH_PX = 160;
const MIN_HEIGHT_PX = 52;
const MAX_HEIGHT_PX = 480;

/**
 * Editor stickies follow the manuscript font size but retain usable minimums.
 * Position remains in logical document pixels; changing the font only changes
 * the rendered card dimensions.
 */
export function getStickyMetrics(fontSize: number): StickyMetrics {
  const safeFontSize =
    Number.isFinite(fontSize) && fontSize > 0 ? fontSize : 18;
  return {
    width: Math.max(safeFontSize * 12.5, MIN_WIDTH_PX),
    minHeight: Math.max(safeFontSize * 3.25, MIN_HEIGHT_PX),
    maxHeight: Math.max(safeFontSize * 30, MAX_HEIGHT_PX),
    paddingInline: safeFontSize * 0.75,
    paddingBlock: safeFontSize * 0.75,
  };
}

/** Body area left after the drag handle and paper padding. */
export function getStickyBodyMaxHeight(metrics: StickyMetrics): number {
  return Math.max(
    metrics.minHeight - metrics.paddingBlock,
    metrics.maxHeight - metrics.paddingBlock * 2.5,
  );
}
