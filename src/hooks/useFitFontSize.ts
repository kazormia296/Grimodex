import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";

/**
 * Width-based font auto-fit hook.
 *
 * Mirrors {@link import("./useFitsInline").useFitsInline} (hidden `max-content`
 * measure element + ResizeObserver) but returns a *font-size in px* instead of a
 * boolean. The measure element renders the same text at the **base** font-size;
 * the visible element should apply the returned (possibly smaller) size.
 *
 * Behaviour:
 * - Text fits at base size → returns `base` (no shrink — wide-panel case).
 * - Text overflows → scales down linearly (`base * avail / measureWidth`).
 * - Below `min` → clamps to `min`; the visible element is then expected to wrap.
 *
 * Linear scaling is exact: glyph advance and letter-spacing both scale linearly
 * with font-size, so a single measurement at `base` derives every size.
 */

export function computeFitFontSize(
  measureWidth: number,
  availWidth: number,
  { base, min }: { base: number; min: number },
): number {
  // 計測前 (clientWidth=0) や空文字 (measureWidth=0) は縮小しない。
  if (measureWidth <= 0 || availWidth <= 0) return base;
  if (measureWidth <= availWidth) return base;
  const scaled = Math.floor((base * availWidth) / measureWidth);
  return Math.max(min, scaled);
}

interface UseFitFontSizeOptions {
  /** Font-size (px) used when the text fits — the measure element's size. */
  baseSizePx: number;
  /** Lower bound (px); below this the visible element should wrap instead. */
  minSizePx: number;
  /** Horizontal padding (px, both sides) subtracted from the container width. */
  horizontalPaddingPx?: number;
}

export function useFitFontSize({
  baseSizePx,
  minSizePx,
  horizontalPaddingPx = 0,
}: UseFitFontSizeOptions): {
  containerRef: RefObject<HTMLDivElement | null>;
  measureRef: RefObject<HTMLSpanElement | null>;
  fontSize: number;
} {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [fontSize, setFontSize] = useState(baseSizePx);

  const check = useCallback(() => {
    const c = containerRef.current;
    const m = measureRef.current;
    if (!c || !m) return;
    const containerWidth = c.clientWidth;
    if (containerWidth === 0) return;
    const avail = containerWidth - horizontalPaddingPx;
    const next = computeFitFontSize(m.offsetWidth, avail, {
      base: baseSizePx,
      min: minSizePx,
    });
    setFontSize((prev) => (prev === next ? prev : next));
  }, [baseSizePx, minSizePx, horizontalPaddingPx]);

  // 初回のみペイント前に同期計測してフラッシュを防ぐ。
  useLayoutEffect(() => {
    check();
  }, [check]);

  // 以降は ResizeObserver で追従。container と measure の両方を監視することで、
  // パネルのリサイズ・名前の増減・font-display:swap によるフォント遅延ロード
  // (測定幅の変化) のすべてに反応する。measure は常に base サイズで描画され
  // 動的サイズと独立しているため、フィードバックループは発生しない。
  useEffect(() => {
    const c = containerRef.current;
    const m = measureRef.current;
    if (!c) return;
    const ro = new ResizeObserver(check);
    ro.observe(c);
    if (m) ro.observe(m);
    return () => ro.disconnect();
  }, [check]);

  return { containerRef, measureRef, fontSize };
}
