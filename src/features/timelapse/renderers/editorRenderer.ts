import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { TateChuYokoPolicy } from "@/features/editor/tateChuYokoPolicy";
import {
  collectInline,
  makeNoPaintCtx,
  paintInline,
  type BlockTextStyle,
  type Ctx2D,
} from "./inlineRuns";
import { renderTable } from "./tableRenderer";
import { renderDocVertical } from "./verticalRenderer";

/**
 * 執筆タイムラプス Editor canvas renderer (P7 + P1 + P2 + P8 + 縦書き).
 *
 * Paints a ProseMirror doc onto a 2D canvas. Glyphs use a single `text` colour
 * (matching the live editor, which doesn't recolour text by authorship);
 * AuthorshipMark provenance shows as a **background tint behind AI / unknown
 * runs**, gated by `showAttribution`, human left untinted (AttributionPlugin /
 * index.css `.attribution-*`).
 *
 * P2 adds structural fidelity for the common novel blocks: headings, lists,
 * blockquote. P8 (this file + `inlineRuns` + `tableRenderer`) closes the inline
 * gap: bold / italic / underline / strikethrough marks, ruby (振り仮名) and
 * emphasis dots (圏点), plus tables and sceneBeat blocks. When `theme.vertical`
 * is set the whole doc is dispatched to `verticalRenderer` (vertical-rl columns,
 * right-side ruby/圏点, 縦中横 digit clusters); the horizontal path below is
 * untouched. Theme colours and the editor font come from `resolveEditorTheme`
 * so the video matches the live theme.
 */

export type AuthorshipSource = "ai" | "human" | "unknown" | null;

export interface EditorRenderTheme {
  background: string;
  /** Uniform glyph colour. */
  text: string;
  /** Muted glyph colour (blockquote body / sceneBeat label). */
  textMuted: string;
  /** Border colour (blockquote rule, table grid, sceneBeat rule). */
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
  /** Ruby annotation size relative to the base glyph (rt ≈ 0.5em). */
  rubyFontScale: number;
  /** vertical-rl 縦書き mode — dispatches to verticalRenderer. */
  vertical: boolean;
  /** Which half-width digit runs become 縦中横 clusters (vertical mode only). */
  tateChuYoko: TateChuYokoPolicy;
}

export const DEFAULT_THEME: EditorRenderTheme = {
  background: "#ffffff",
  text: "#222222",
  textMuted: "#666666",
  border: "#dddddd",
  showAttribution: false,
  // Canvas-paintable fallback only (used when getComputedStyle of .attribution-*
  // fails). Approximates the canonical teal/amber tints in
  // attributionColors.ts / index.css; the live path resolves the real CSS.
  attributionAi: "rgba(20, 184, 166, 0.18)",
  attributionUnknown: "rgba(217, 119, 6, 0.16)",
  fontFamily: "ui-sans-serif, system-ui, sans-serif",
  fontSizePx: 16,
  lineHeightPx: 24,
  paddingPx: 32,
  paragraphGapPx: 12,
  rubyFontScale: 0.5,
  vertical: false,
  tateChuYoko: "2",
};

/** Text styling inherited down the block tree (blockquote sets muted+italic). */
interface Inherited {
  color: string;
  italic: boolean;
}

interface BlockMeasurement {
  posStart: number;
  posEnd: number;
  yTop: number;
  yBottom: number;
}

const HEADING_SCALE: Record<number, number> = { 1: 2, 2: 1.5, 3: 1.17 };

export function renderDocToCanvas(
  ctx: Ctx2D,
  doc: ProseMirrorNode,
  width: number,
  height: number,
  theme: EditorRenderTheme = DEFAULT_THEME,
  focusPos?: number | null,
): void {
  if (theme.vertical) {
    renderDocVertical(ctx, doc, width, height, theme, focusPos);
    return;
  }

  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const x = theme.paddingPx;
  const maxX = width - theme.paddingPx;
  const startY = theme.paddingPx + theme.fontSizePx;
  const base: Inherited = { color: theme.text, italic: false };

  if (focusPos == null) {
    renderBlocksFrom(ctx, doc, theme, x, maxX, startY, base, 0, height);
    return;
  }

  const measurements = measureBlocks(ctx, doc, theme, x, maxX, startY, base);
  const offset = computeScrollOffset(measurements, focusPos, height);
  if (offset === 0) {
    renderBlocksFrom(ctx, doc, theme, x, maxX, startY, base, 0, height);
    return;
  }

  const firstVisible = measurements.blocks.findIndex(
    (block) => block.yBottom - offset > 0 && block.yTop - offset < height,
  );
  if (firstVisible === -1) return;

  renderBlocksFrom(
    ctx,
    doc,
    theme,
    x,
    maxX,
    measurements.blocks[firstVisible].yTop - offset,
    base,
    firstVisible,
    height,
  );
}

function renderBlocksFrom(
  ctx: Ctx2D,
  doc: ProseMirrorNode,
  theme: EditorRenderTheme,
  x: number,
  maxX: number,
  startY: number,
  base: Inherited,
  startIndex: number,
  height: number,
): void {
  let y = startY;
  for (let bi = startIndex; bi < doc.childCount; bi += 1) {
    y = renderBlock(ctx, doc.child(bi), theme, x, maxX, y, base);
    if (y > height + theme.lineHeightPx) {
      // Past the canvas bottom — later content is clipped anyway.
      break;
    }
  }
}

function measureBlocks(
  ctx: Ctx2D,
  doc: ProseMirrorNode,
  theme: EditorRenderTheme,
  x: number,
  maxX: number,
  startY: number,
  base: Inherited,
): { blocks: BlockMeasurement[]; totalHeight: number } {
  const measureCtx = makeNoPaintCtx(ctx);
  const blocks: BlockMeasurement[] = [];
  let y = startY;
  let pos = 0;

  for (let bi = 0; bi < doc.childCount; bi += 1) {
    const node = doc.child(bi);
    const yTop = y;
    y = renderBlock(measureCtx, node, theme, x, maxX, y, base);
    const posEnd = pos + node.nodeSize;
    blocks.push({ posStart: pos, posEnd, yTop, yBottom: y });
    pos = posEnd;
  }

  return { blocks, totalHeight: y };
}

function computeScrollOffset(
  measured: { blocks: BlockMeasurement[]; totalHeight: number },
  focusPos: number,
  height: number,
): number {
  const maxOffset = Math.max(0, measured.totalHeight - height);
  if (maxOffset === 0 || measured.blocks.length === 0) return 0;

  const focused =
    measured.blocks.find(
      (block) => focusPos >= block.posStart && focusPos < block.posEnd,
    ) ?? measured.blocks[measured.blocks.length - 1];
  return clamp(focused.yTop - height / 2, 0, maxOffset);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function paragraphStyle(
  theme: EditorRenderTheme,
  inherited: Inherited,
): BlockTextStyle {
  return {
    fontSizePx: theme.fontSizePx,
    lineHeightPx: theme.lineHeightPx,
    color: inherited.color,
    bold: false,
    italic: inherited.italic,
  };
}

/**
 * Render one block at left edge `x` (right boundary `maxX`), top baseline `y`.
 * Returns the next block's starting baseline. Recurses for list items,
 * blockquote and sceneBeat children.
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
    const style: BlockTextStyle = {
      fontSizePx: size,
      lineHeightPx: size * ratio,
      color: theme.text,
      bold: true,
      italic: false,
    };
    const items = collectInline(block);
    const lines = items.length
      ? paintInline(ctx, items, x, y, maxX, style, theme)
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
    const ruleW = Math.max(2, Math.round(theme.fontSizePx * 0.18));
    const bottom = yy - theme.paragraphGapPx;
    ctx.fillStyle = theme.border;
    ctx.fillRect(x, startTop, ruleW, Math.max(0, bottom - startTop));
    return yy;
  }

  if (name === "sceneBeat") {
    // Authoring scaffold: a muted left rule + a "◈ beatType" label, then the
    // beat's inline text. (Export strips sceneBeat, but the live editor shows
    // it while writing, so the timelapse mirrors that.)
    const indent = theme.fontSizePx;
    const startTop = y - theme.fontSizePx * 0.85;
    const labelStyle: BlockTextStyle = {
      fontSizePx: theme.fontSizePx * 0.85,
      lineHeightPx: theme.lineHeightPx,
      color: theme.textMuted,
      bold: true,
      italic: false,
    };
    const beatType = String(block.attrs.beatType ?? "beat");
    ctx.font = `bold ${labelStyle.fontSizePx}px ${theme.fontFamily}`;
    ctx.fillStyle = theme.textMuted;
    ctx.fillText(`◈ ${beatType}`, x + indent, y);
    let yy = y + theme.lineHeightPx;
    const childInherited: Inherited = { color: theme.textMuted, italic: false };
    // sceneBeat content may be `inline*` (a textblock) or wrapped paragraphs.
    if (block.isTextblock) {
      yy = paintTextBlock(
        ctx,
        block,
        theme,
        x + indent,
        maxX,
        yy,
        childInherited,
      );
    } else {
      block.forEach((child) => {
        yy = renderBlock(
          ctx,
          child,
          theme,
          x + indent,
          maxX,
          yy,
          childInherited,
        );
      });
    }
    const ruleW = Math.max(2, Math.round(theme.fontSizePx * 0.18));
    const bottom = yy - theme.paragraphGapPx;
    ctx.fillStyle = theme.border;
    ctx.fillRect(x, startTop, ruleW, Math.max(0, bottom - startTop));
    return yy;
  }

  if (name === "table") {
    return renderTable(ctx, block, theme, x, maxX, y);
  }

  if (name === "bulletList" || name === "orderedList") {
    const ordered = name === "orderedList";
    const indent = Math.round(theme.fontSizePx * 1.5);
    let idx = 1;
    let yy = y;
    block.forEach((listItem) => {
      const marker = ordered ? `${idx}.` : "•";
      idx += 1;
      ctx.font = `${theme.fontSizePx}px ${theme.fontFamily}`;
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
      yy = itemY > yy ? itemY : yy + theme.lineHeightPx + theme.paragraphGapPx;
    });
    return yy;
  }

  // paragraph (and any other textblock): best-effort render of its inline text.
  return paintTextBlock(ctx, block, theme, x, maxX, y, inherited);
}

function paintTextBlock(
  ctx: Ctx2D,
  block: ProseMirrorNode,
  theme: EditorRenderTheme,
  x: number,
  maxX: number,
  y: number,
  inherited: Inherited,
): number {
  const style = paragraphStyle(theme, inherited);
  const items = collectInline(block);
  if (items.length === 0) {
    return y + style.lineHeightPx + theme.paragraphGapPx;
  }
  const lines = paintInline(ctx, items, x, y, maxX, style, theme);
  return y + lines * style.lineHeightPx + theme.paragraphGapPx;
}
