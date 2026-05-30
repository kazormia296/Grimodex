import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

/**
 * 執筆タイムラプス Editor canvas renderer (P7 + P1 + P2).
 *
 * Paints a ProseMirror doc onto a 2D canvas. Glyphs use a single `text` colour
 * (matching the live editor, which doesn't recolour text by authorship);
 * AuthorshipMark provenance shows as a **background tint behind AI / unknown
 * runs**, gated by `showAttribution`, human left untinted (AttributionPlugin /
 * index.css `.attribution-*`).
 *
 * P2 adds structural fidelity for the common novel blocks: headings (em scale +
 * bold), bullet/ordered lists (marker + indent, nested via recursion), and
 * blockquote (left border + indent + italic + muted). Tables / ruby / sceneBeat
 * / emphasis dots stay out of scope (canvas-hand-paint ROI). Theme colours and
 * the editor font come from `resolveEditorTheme` so the video matches the live
 * theme rather than a hard-coded white/sans default.
 */

export type AuthorshipSource = "ai" | "human" | "unknown" | null;

export interface EditorRenderTheme {
  background: string;
  /** Uniform glyph colour. */
  text: string;
  /** Muted glyph colour (blockquote body). */
  textMuted: string;
  /** Border colour (blockquote rule). */
  border: string;
  /** Mirrors the live editor's showAttribution toggle. */
  showAttribution: boolean;
  attributionAi: string;
  attributionUnknown: string;
  fontFamily: string;
  fontSizePx: number;
  lineHeightPx: number;
  paddingPx: number;
  paragraphGapPx: number;
}

export const DEFAULT_THEME: EditorRenderTheme = {
  background: "#ffffff",
  text: "#222222",
  textMuted: "#666666",
  border: "#dddddd",
  showAttribution: false,
  attributionAi: "rgba(34, 197, 94, 0.18)",
  attributionUnknown: "rgba(217, 119, 6, 0.16)",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSizePx: 16,
  lineHeightPx: 24,
  paddingPx: 32,
  paragraphGapPx: 12,
};

interface Run {
  text: string;
  source: AuthorshipSource;
}

interface RunStyle {
  fontSizePx: number;
  lineHeightPx: number;
  color: string;
  bold: boolean;
  italic: boolean;
}

/** Text styling inherited down the block tree (blockquote sets muted+italic). */
interface Inherited {
  color: string;
  italic: boolean;
}

type Ctx2D = Pick<
  CanvasRenderingContext2D,
  "fillStyle" | "font" | "fillRect" | "fillText" | "measureText"
>;

const HEADING_SCALE: Record<number, number> = { 1: 2, 2: 1.5, 3: 1.17 };

function attributionTint(
  source: AuthorshipSource,
  theme: EditorRenderTheme,
): string | null {
  if (!theme.showAttribution) return null;
  if (source === "ai") return theme.attributionAi;
  if (source === "unknown") return theme.attributionUnknown;
  return null;
}

function fontStr(style: RunStyle, family: string): string {
  const italic = style.italic ? "italic " : "";
  const bold = style.bold ? "bold " : "";
  return `${italic}${bold}${style.fontSizePx}px ${family}`;
}

function collectRuns(block: ProseMirrorNode): Run[] {
  const runs: Run[] = [];
  block.forEach((child) => {
    if (!child.isText || !child.text) return;
    const mark = child.marks.find((m) => m.type.name === "authorship");
    const source = (mark?.attrs.source as AuthorshipSource | undefined) ?? null;
    runs.push({ text: child.text, source });
  });
  return runs;
}

export function renderDocToCanvas(
  ctx: Ctx2D,
  doc: ProseMirrorNode,
  width: number,
  height: number,
  theme: EditorRenderTheme = DEFAULT_THEME,
): void {
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const x = theme.paddingPx;
  const maxX = width - theme.paddingPx;
  let y = theme.paddingPx + theme.fontSizePx;
  const base: Inherited = { color: theme.text, italic: false };

  for (let bi = 0; bi < doc.childCount; bi += 1) {
    y = renderBlock(ctx, doc.child(bi), theme, x, maxX, y, base);
    if (y > height + theme.lineHeightPx) {
      // Past the canvas bottom — later content is clipped anyway.
      break;
    }
  }
}

/**
 * Render one block at left edge `x` (right boundary `maxX`), top baseline `y`.
 * Returns the next block's starting baseline. Recurses for list items and
 * blockquote children.
 */
function renderBlock(
  ctx: Ctx2D,
  block: ProseMirrorNode,
  theme: EditorRenderTheme,
  x: number,
  maxX: number,
  y: number,
  inherited: Inherited,
): number {
  const ratio = theme.lineHeightPx / theme.fontSizePx;
  const name = block.type.name;

  if (name === "heading") {
    const level = (block.attrs.level as number) ?? 1;
    const size = theme.fontSizePx * (HEADING_SCALE[level] ?? HEADING_SCALE[3]);
    const style: RunStyle = {
      fontSizePx: size,
      lineHeightPx: size * ratio,
      color: theme.text,
      bold: true,
      italic: false,
    };
    const runs = collectRuns(block);
    const lines = runs.length
      ? paintRuns(ctx, runs, x, y, maxX, style, theme)
      : 1;
    return y + lines * style.lineHeightPx + theme.paragraphGapPx;
  }

  if (name === "blockquote") {
    const indent = theme.fontSizePx;
    const childInherited: Inherited = { color: theme.textMuted, italic: true };
    const startTop = y - theme.fontSizePx * 0.85;
    let yy = y;
    block.forEach((child) => {
      yy = renderBlock(ctx, child, theme, x + indent, maxX, yy, childInherited);
    });
    // Left rule spanning the quote body.
    const ruleW = Math.max(2, Math.round(theme.fontSizePx * 0.18));
    const bottom = yy - theme.paragraphGapPx;
    ctx.fillStyle = theme.border;
    ctx.fillRect(x, startTop, ruleW, Math.max(0, bottom - startTop));
    return yy;
  }

  if (name === "bulletList" || name === "orderedList") {
    const ordered = name === "orderedList";
    const indent = Math.round(theme.fontSizePx * 1.5);
    const markerStyle: RunStyle = {
      fontSizePx: theme.fontSizePx,
      lineHeightPx: theme.lineHeightPx,
      color: inherited.color,
      bold: false,
      italic: inherited.italic,
    };
    let idx = 1;
    let yy = y;
    block.forEach((listItem) => {
      const marker = ordered ? `${idx}.` : "•";
      idx += 1;
      ctx.font = fontStr(markerStyle, theme.fontFamily);
      ctx.fillStyle = inherited.color;
      ctx.fillText(marker, x, yy);
      let itemY = yy;
      listItem.forEach((child) => {
        itemY = renderBlock(
          ctx,
          child,
          theme,
          x + indent,
          maxX,
          itemY,
          inherited,
        );
      });
      // Guard against an empty list item not advancing y.
      yy = itemY > yy ? itemY : yy + theme.lineHeightPx + theme.paragraphGapPx;
    });
    return yy;
  }

  // paragraph (and any other block: best-effort render of its inline text).
  const style: RunStyle = {
    fontSizePx: theme.fontSizePx,
    lineHeightPx: theme.lineHeightPx,
    color: inherited.color,
    bold: false,
    italic: inherited.italic,
  };
  const runs = collectRuns(block);
  if (runs.length === 0) {
    return y + style.lineHeightPx + theme.paragraphGapPx;
  }
  const lines = paintRuns(ctx, runs, x, y, maxX, style, theme);
  return y + lines * style.lineHeightPx + theme.paragraphGapPx;
}

/**
 * Paint wrapped text runs at `[startX, maxX]` from baseline `startY`. Authorship
 * tints draw as a background band behind AI/unknown runs (gated). Returns the
 * number of visual lines painted.
 */
function paintRuns(
  ctx: Ctx2D,
  runs: Run[],
  startX: number,
  startY: number,
  maxX: number,
  style: RunStyle,
  theme: EditorRenderTheme,
): number {
  ctx.font = fontStr(style, theme.fontFamily);
  const lineHeight = style.lineHeightPx;
  const fontSize = style.fontSizePx;
  let x = startX;
  let y = startY;
  let lines = 1;
  let firstOnLine = true;
  // Full available line width, used to detect oversized tokens that need
  // character-level wrapping (e.g. CJK runs, very long words with no spaces).
  const lineWidth = maxX - startX;

  for (const run of runs) {
    const tint = attributionTint(run.source, theme);
    const tokens = run.text.split(/(\s+)/).filter((t) => t.length > 0);
    for (const token of tokens) {
      const isSpace = /^\s+$/.test(token);
      const w = ctx.measureText(token).width;

      // Wrap before a non-space token that doesn't fit on the current line.
      if (!isSpace && !firstOnLine && x + w > maxX) {
        y += lineHeight;
        x = startX;
        lines += 1;
        firstOnLine = true;
      }
      // Skip leading whitespace at the start of a line.
      if (firstOnLine && isSpace) continue;

      // If the token is wider than a full line (e.g. a long CJK run with no
      // spaces, or a very long word), paint it character by character so it
      // wraps at the right margin instead of overflowing.
      if (!isSpace && w > lineWidth) {
        for (const ch of token) {
          const cw = ctx.measureText(ch).width;
          if (!firstOnLine && x + cw > maxX) {
            y += lineHeight;
            x = startX;
            lines += 1;
            firstOnLine = true;
          }
          if (tint) {
            ctx.fillStyle = tint;
            ctx.fillRect(x, y - fontSize * 0.85, cw, fontSize * 1.15);
          }
          ctx.fillStyle = style.color;
          ctx.fillText(ch, x, y);
          x += cw;
          firstOnLine = false;
        }
        continue;
      }

      if (tint) {
        ctx.fillStyle = tint;
        ctx.fillRect(x, y - fontSize * 0.85, w, fontSize * 1.15);
      }
      ctx.fillStyle = style.color;
      ctx.fillText(token, x, y);
      x += w;
      firstOnLine = false;
    }
  }
  return lines;
}

export { paintRuns as _paintRunsForTest };
