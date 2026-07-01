import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorRenderTheme } from "./editorRenderer";
import {
  collectInline,
  makeNoPaintCtx,
  type BlockTextStyle,
  type Ctx2D,
} from "./inlineRuns";
import { paintInlineVertical, verticalTextItems } from "./inlineRunsVertical";
import { renderTable } from "./tableRenderer";

/**
 * 執筆タイムラプス — 縦書き (vertical-rl) block layout.
 *
 * The horizontal renderer (`editorRenderer`) stacks blocks top-to-bottom and
 * flows each block's inline text left-to-right. This module rotates that: blocks
 * advance **leftward** (a column group per block), inline text flows down each
 * column via `paintInlineVertical`. Scrolling follows `focusPos` on the
 * horizontal axis (columns shift rightward so the latest edit stays on screen),
 * mirroring the horizontal path's vertical scroll. Tables reset to a horizontal
 * island (matching the live editor's `.editor-vertical` island reset); every
 * other block participates in the vertical flow.
 *
 * Coordinate note: work happens in "leftward distance" `d = xRightStart - x` so
 * the scroll maths is a 1:1 analogue of the horizontal path's y-offset.
 */

interface Inherited {
  color: string;
  italic: boolean;
}

interface VBlockMeasurement {
  posStart: number;
  posEnd: number;
  /** Distance (from the right start) of this block's right edge / left edge. */
  dTop: number;
  dBottom: number;
}

const HEADING_SCALE: Record<number, number> = { 1: 2, 2: 1.5, 3: 1.17 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function renderDocVertical(
  ctx: Ctx2D,
  doc: ProseMirrorNode,
  width: number,
  height: number,
  theme: EditorRenderTheme,
  focusPos?: number | null,
): void {
  ctx.fillStyle = theme.background;
  ctx.fillRect(0, 0, width, height);

  const yTop = theme.paddingPx;
  const yBottom = height - theme.paddingPx;
  const xRightStart = width - theme.paddingPx;
  const availableD = Math.max(1, width - theme.paddingPx * 2);
  const base: Inherited = { color: theme.text, italic: false };

  if (focusPos == null) {
    renderBlocksVerticalFrom(
      ctx,
      doc,
      theme,
      xRightStart,
      yTop,
      yBottom,
      base,
      0,
    );
    return;
  }

  const measured = measureBlocksVertical(
    ctx,
    doc,
    theme,
    xRightStart,
    yTop,
    yBottom,
    base,
  );
  const offsetD = computeScrollOffsetD(measured, focusPos, availableD);
  if (offsetD === 0) {
    renderBlocksVerticalFrom(
      ctx,
      doc,
      theme,
      xRightStart,
      yTop,
      yBottom,
      base,
      0,
    );
    return;
  }

  const firstVisible = measured.blocks.findIndex(
    (b) => b.dBottom - offsetD > 0 && b.dTop - offsetD < availableD,
  );
  if (firstVisible === -1) return;

  const startXRight =
    xRightStart - (measured.blocks[firstVisible].dTop - offsetD);
  renderBlocksVerticalFrom(
    ctx,
    doc,
    theme,
    startXRight,
    yTop,
    yBottom,
    base,
    firstVisible,
  );
}

function renderBlocksVerticalFrom(
  ctx: Ctx2D,
  doc: ProseMirrorNode,
  theme: EditorRenderTheme,
  startXRight: number,
  yTop: number,
  yBottom: number,
  base: Inherited,
  startIndex: number,
): void {
  let xRight = startXRight;
  for (let bi = startIndex; bi < doc.childCount; bi += 1) {
    xRight = renderBlockVertical(
      ctx,
      doc.child(bi),
      theme,
      xRight,
      yTop,
      yBottom,
      base,
    );
    if (xRight < -theme.lineHeightPx) break; // past the left edge — clipped
  }
}

function measureBlocksVertical(
  ctx: Ctx2D,
  doc: ProseMirrorNode,
  theme: EditorRenderTheme,
  xRightStart: number,
  yTop: number,
  yBottom: number,
  base: Inherited,
): { blocks: VBlockMeasurement[]; totalD: number } {
  const mctx = makeNoPaintCtx(ctx);
  const blocks: VBlockMeasurement[] = [];
  let xRight = xRightStart;
  let pos = 0;
  for (let bi = 0; bi < doc.childCount; bi += 1) {
    const node = doc.child(bi);
    const start = xRight;
    xRight = renderBlockVertical(
      mctx,
      node,
      theme,
      xRight,
      yTop,
      yBottom,
      base,
    );
    const posEnd = pos + node.nodeSize;
    blocks.push({
      posStart: pos,
      posEnd,
      dTop: xRightStart - start,
      dBottom: xRightStart - xRight,
    });
    pos = posEnd;
  }
  return { blocks, totalD: xRightStart - xRight };
}

function computeScrollOffsetD(
  measured: { blocks: VBlockMeasurement[]; totalD: number },
  focusPos: number,
  availableD: number,
): number {
  const maxOffset = Math.max(0, measured.totalD - availableD);
  if (maxOffset === 0 || measured.blocks.length === 0) return 0;
  const focused =
    measured.blocks.find(
      (b) => focusPos >= b.posStart && focusPos < b.posEnd,
    ) ?? measured.blocks[measured.blocks.length - 1];
  return clamp(focused.dTop - availableD / 2, 0, maxOffset);
}

function textStyle(
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
 * Render one block; returns the next block's right edge (further left).
 */
function renderBlockVertical(
  ctx: Ctx2D,
  block: ProseMirrorNode,
  theme: EditorRenderTheme,
  xRight: number,
  yTop: number,
  yBottom: number,
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
    const { columns } = paintInlineVertical(
      ctx,
      items,
      xRight,
      yTop,
      yBottom,
      style,
      theme,
    );
    return xRight - columns * style.lineHeightPx - theme.paragraphGapPx;
  }

  if (name === "blockquote") {
    const indent = theme.fontSizePx;
    const childInherited: Inherited = { color: theme.textMuted, italic: true };
    let xr = xRight;
    block.forEach((child) => {
      xr = renderBlockVertical(
        ctx,
        child,
        theme,
        xr,
        yTop + indent,
        yBottom,
        childInherited,
      );
    });
    drawTopRule(ctx, theme, xRight, xr, yTop);
    return xr;
  }

  if (name === "sceneBeat") {
    return renderSceneBeatVertical(ctx, block, theme, xRight, yTop, yBottom);
  }

  if (name === "table") {
    const bandRight = xRight;
    const bandWidth = Math.min(
      8 * theme.lineHeightPx,
      Math.max(theme.lineHeightPx, bandRight - theme.paddingPx),
    );
    const bandLeft = bandRight - bandWidth;
    renderTable(
      ctx,
      block,
      theme,
      bandLeft,
      bandRight,
      yTop + theme.fontSizePx,
    );
    return bandLeft - theme.paragraphGapPx;
  }

  if (name === "bulletList" || name === "orderedList") {
    return renderListVertical(
      ctx,
      block,
      theme,
      xRight,
      yTop,
      yBottom,
      inherited,
      name === "orderedList",
    );
  }

  // paragraph / any other textblock.
  const style = textStyle(theme, inherited);
  const items = collectInline(block);
  const { columns } = paintInlineVertical(
    ctx,
    items,
    xRight,
    yTop,
    yBottom,
    style,
    theme,
  );
  return xRight - columns * style.lineHeightPx - theme.paragraphGapPx;
}

/** A horizontal rule along the inline-start (top) edge of a block's x-span. */
function drawTopRule(
  ctx: Ctx2D,
  theme: EditorRenderTheme,
  xRight: number,
  xLeft: number,
  yTop: number,
): void {
  const ruleH = Math.max(2, Math.round(theme.fontSizePx * 0.18));
  const left = Math.max(0, xLeft + theme.paragraphGapPx);
  const width = Math.max(0, xRight - left);
  ctx.fillStyle = theme.border;
  ctx.fillRect(left, yTop, width, ruleH);
}

function renderSceneBeatVertical(
  ctx: Ctx2D,
  block: ProseMirrorNode,
  theme: EditorRenderTheme,
  xRight: number,
  yTop: number,
  yBottom: number,
): number {
  const indent = theme.fontSizePx;
  const childTop = yTop + indent;
  const labelStyle: BlockTextStyle = {
    fontSizePx: theme.fontSizePx * 0.85,
    lineHeightPx: theme.lineHeightPx,
    color: theme.textMuted,
    bold: true,
    italic: false,
  };
  const beatType = String(block.attrs.beatType ?? "beat");
  const label = paintInlineVertical(
    ctx,
    verticalTextItems(`◈ ${beatType}`),
    xRight,
    childTop,
    yBottom,
    labelStyle,
    theme,
  );
  let xr = xRight - label.columns * labelStyle.lineHeightPx;
  const childInherited: Inherited = { color: theme.textMuted, italic: false };
  if (block.isTextblock) {
    const items = collectInline(block);
    const { columns } = paintInlineVertical(
      ctx,
      items,
      xr,
      childTop,
      yBottom,
      textStyle(theme, childInherited),
      theme,
    );
    xr = xr - columns * theme.lineHeightPx - theme.paragraphGapPx;
  } else {
    block.forEach((child) => {
      xr = renderBlockVertical(
        ctx,
        child,
        theme,
        xr,
        childTop,
        yBottom,
        childInherited,
      );
    });
  }
  drawTopRule(ctx, theme, xRight, xr, yTop);
  return xr;
}

function renderListVertical(
  ctx: Ctx2D,
  block: ProseMirrorNode,
  theme: EditorRenderTheme,
  xRight: number,
  yTop: number,
  yBottom: number,
  inherited: Inherited,
  ordered: boolean,
): number {
  const indent = Math.round(theme.fontSizePx * 1.5);
  let idx = 1;
  let xr = xRight;
  block.forEach((listItem) => {
    const marker = ordered ? `${idx}.` : "•";
    idx += 1;
    const markerStyle = textStyle(theme, inherited);
    // Marker sits at the top (inline-start) of the item's first column.
    paintInlineVertical(
      ctx,
      verticalTextItems(marker),
      xr,
      yTop,
      yBottom,
      markerStyle,
      theme,
    );
    let itemXr = xr;
    listItem.forEach((child) => {
      itemXr = renderBlockVertical(
        ctx,
        child,
        theme,
        itemXr,
        yTop + indent,
        yBottom,
        inherited,
      );
    });
    // Advance past the wider of marker column / content columns.
    xr = itemXr < xr ? itemXr : xr - theme.lineHeightPx - theme.paragraphGapPx;
  });
  return xr;
}
