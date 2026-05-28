import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * 執筆タイムラプス Editor canvas renderer (P7 minimum-viable).
 *
 * Paints a ProseMirror doc as wrapped plain-text paragraphs on a 2D canvas,
 * with per-text-run colour tints driven by the AuthorshipMark attribute.
 * The output is intentionally schema-thin: paragraphs and text only, no
 * headings / lists / nested nodes / inline embeds. The frame producer for
 * video export is responsible for picking schemas it knows how to render.
 *
 * Reasons we stay minimal here:
 * - Faithful PM → canvas layout for arbitrary schemas is a project on its
 *   own (text shaping, line break rules, decoration plugins).
 * - The timelapse goal is "show the prose evolving", not "pixel-match the
 *   editor UI". A clean monotype layout is sufficient and stable.
 *
 * The Map domain renderer is sketched separately (mapRenderer.ts) when needed.
 */

export interface EditorRenderTheme {
  background: string;
  text: string;
  human: string;
  ai: string;
  unknown: string;
  fontFamily: string;
  fontSizePx: number;
  lineHeightPx: number;
  paddingPx: number;
  paragraphGapPx: number;
}

export const DEFAULT_THEME: EditorRenderTheme = {
  background: "#ffffff",
  text: "#222222",
  human: "#225",
  ai: "#582",
  unknown: "#666",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSizePx: 16,
  lineHeightPx: 24,
  paddingPx: 32,
  paragraphGapPx: 12,
};

interface Run {
  text: string;
  color: string;
}

type Ctx2D = Pick<
  CanvasRenderingContext2D,
  "fillStyle" | "font" | "fillRect" | "fillText" | "measureText"
>;

/**
 * Render `doc` into `ctx` at canvas size `width × height`.
 *
 * Lines are wrapped greedily using `ctx.measureText`. Text runs inside a
 * paragraph that have different AuthorshipMark sources are coloured per the
 * theme; spaces between runs are coloured by the trailing run for simplicity.
 */
export function renderDocToCanvas(
  ctx: Ctx2D,
  doc: ProseMirrorNode,
  width: number,
  height: number,
  theme: EditorRenderTheme = DEFAULT_THEME,
): void {
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);
  ctx.font = `${theme.fontSizePx}px ${theme.fontFamily}`;

  const contentWidth = width - theme.paddingPx * 2;
  let y = theme.paddingPx + theme.fontSizePx;

  doc.forEach((block) => {
    const runs: Run[] = [];
    block.forEach((child) => {
      if (!child.isText || !child.text) return;
      const mark = child.marks.find((m) => m.type.name === "authorship");
      const source = (mark?.attrs.source as string | undefined) ?? null;
      runs.push({
        text: child.text,
        color:
          source === "ai"
            ? theme.ai
            : source === "human"
              ? theme.human
              : source === "unknown"
                ? theme.unknown
                : theme.text,
      });
    });
    if (runs.length === 0) {
      y += theme.lineHeightPx + theme.paragraphGapPx;
      return;
    }
    const linesPainted = paintParagraph(
      ctx,
      runs,
      theme.paddingPx,
      y,
      contentWidth,
      theme.lineHeightPx,
    );
    y += linesPainted * theme.lineHeightPx + theme.paragraphGapPx;
    if (y > height + theme.lineHeightPx) {
      // Stop drawing once we're well past the canvas bottom; later content
      // would be clipped anyway and measureText calls add up.
      return false as unknown as void;
    }
  });
}

function paintParagraph(
  ctx: Ctx2D,
  runs: Run[],
  startX: number,
  startY: number,
  maxWidth: number,
  lineHeight: number,
): number {
  let x = startX;
  let y = startY;
  let lines = 1;
  let firstOnLine = true;

  for (const run of runs) {
    const tokens = run.text.split(/(\s+)/).filter((t) => t.length > 0);
    for (const token of tokens) {
      const w = ctx.measureText(token).width;
      if (!firstOnLine && x + w > startX + maxWidth && !/^\s+$/.test(token)) {
        // wrap before this token
        y += lineHeight;
        x = startX;
        lines += 1;
        firstOnLine = true;
      }
      if (firstOnLine && /^\s+$/.test(token)) {
        // skip leading whitespace on a fresh line
        continue;
      }
      ctx.fillStyle = run.color;
      ctx.fillText(token, x, y);
      x += w;
      firstOnLine = false;
    }
  }
  return lines;
}

export { paintParagraph as _paintParagraphForTest };
