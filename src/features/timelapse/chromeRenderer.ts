/**
 * 執筆タイムラプス動画 — 下部キャプション帯の canvas 描画。
 */

import type { EditorRenderTheme } from "./renderers/editorRenderer";
import type { CaptionSegment, FormattedCaption } from "./formatEventCaption";

const BAND_HEIGHT_RATIO = 0.24;
const PADDING_X = 16;
const PADDING_Y = 10;
const LINE_HEIGHT_RATIO = 1.35;
const MAX_LINES = 3;

function segmentColor(
  kind: CaptionSegment["kind"],
  theme: EditorRenderTheme,
): string {
  switch (kind) {
    case "add":
      return "#16a34a";
    case "del":
      return "#dc2626";
    case "eq":
      return theme.textMuted;
    default:
      return theme.text;
  }
}

/**
 * Paint formatted captions in a semi-transparent band at the bottom of the frame.
 */
export function renderChromeOverlay(
  ctx: CanvasRenderingContext2D,
  captions: readonly FormattedCaption[],
  width: number,
  height: number,
  theme: EditorRenderTheme,
): void {
  if (captions.length === 0) return;

  const bandH = Math.round(height * BAND_HEIGHT_RATIO);
  const bandTop = height - bandH;
  const fontSize = Math.max(11, Math.round(theme.fontSizePx * 0.72));
  const lineHeight = Math.round(fontSize * LINE_HEIGHT_RATIO);
  const maxWidth = width - PADDING_X * 2;

  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  ctx.fillRect(0, bandTop, width, bandH);

  ctx.font = `${fontSize}px ${theme.fontFamily}`;
  let y = bandTop + PADDING_Y + fontSize;
  let linesUsed = 0;

  outer: for (const caption of captions) {
    let lineSegments: CaptionSegment[] = [];
    let lineWidth = 0;

    const flushLine = () => {
      if (lineSegments.length === 0) return;
      if (linesUsed >= MAX_LINES) return;
      let x = PADDING_X;
      for (const seg of lineSegments) {
        ctx.fillStyle = segmentColor(seg.kind, theme);
        ctx.fillText(seg.text, x, y);
        x += ctx.measureText(seg.text).width;
      }
      y += lineHeight;
      linesUsed += 1;
      lineSegments = [];
      lineWidth = 0;
    };

    for (const seg of caption.segments) {
      const w = ctx.measureText(seg.text).width;
      if (lineWidth + w > maxWidth && lineSegments.length > 0) {
        flushLine();
        if (linesUsed >= MAX_LINES) break outer;
      }
      lineSegments.push(seg);
      lineWidth += w;
    }
    flushLine();
    if (linesUsed >= MAX_LINES) break;
  }

  ctx.restore();
}

/**
 * Fill the canvas with the theme background only (no document).
 */
export function renderEmptyFrame(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: EditorRenderTheme,
): void {
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
}
