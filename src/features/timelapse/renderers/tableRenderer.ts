import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { EditorRenderTheme } from "./editorRenderer";
import {
  collectInline,
  makeNoPaintCtx,
  paintInline,
  type BlockTextStyle,
  type Ctx2D,
} from "./inlineRuns";

/**
 * 執筆タイムラプス — table renderer (P8 忠実化).
 *
 * Draws `table` / `tableRow` / `tableCell` / `tableHeader` as an equal-column
 * grid with cell borders and wrapped cell text. Table cells are configured
 * non-resizable and colspan/rowspan are unused in this project, so a simple
 * fixed-column layout is faithful. Header cells render bold. Horizontal only.
 */

const CELL_PAD = 5;

function cellParagraphs(cell: ProseMirrorNode): ProseMirrorNode[] {
  const out: ProseMirrorNode[] = [];
  cell.forEach((child) => out.push(child));
  return out;
}

function cellStyle(theme: EditorRenderTheme, header: boolean): BlockTextStyle {
  return {
    fontSizePx: theme.fontSizePx,
    lineHeightPx: theme.lineHeightPx,
    color: theme.text,
    bold: header,
    italic: false,
  };
}

/** Measure how many stacked lines a cell's paragraphs need at `innerWidth`. */
function measureCellLines(
  ctx: Ctx2D,
  cell: ProseMirrorNode,
  theme: EditorRenderTheme,
  header: boolean,
  innerWidth: number,
): number {
  const measureCtx = makeNoPaintCtx(ctx);
  const style = cellStyle(theme, header);
  let lines = 0;
  for (const para of cellParagraphs(cell)) {
    const items = collectInline(para);
    lines += items.length
      ? paintInline(measureCtx, items, 0, 0, innerWidth, style, theme)
      : 1;
  }
  return Math.max(1, lines);
}

/**
 * Render a table node. Returns the y just below the table.
 */
export function renderTable(
  ctx: Ctx2D,
  table: ProseMirrorNode,
  theme: EditorRenderTheme,
  x: number,
  maxX: number,
  y: number,
): number {
  const rows: ProseMirrorNode[] = [];
  table.forEach((row) => rows.push(row));
  if (rows.length === 0) return y + theme.lineHeightPx + theme.paragraphGapPx;

  let numCols = 0;
  for (const row of rows) numCols = Math.max(numCols, row.childCount);
  if (numCols === 0) return y + theme.lineHeightPx + theme.paragraphGapPx;

  const gridW = maxX - x;
  const colW = gridW / numCols;
  const innerW = colW - CELL_PAD * 2;
  const rule = Math.max(1, Math.round(theme.fontSizePx * 0.06));

  let rowTop = y - theme.fontSizePx * 0.85; // top edge above the first baseline

  for (const row of rows) {
    // Row height = tallest cell.
    let maxLines = 1;
    const cells: ProseMirrorNode[] = [];
    row.forEach((cell) => cells.push(cell));
    cells.forEach((cell) => {
      const header = cell.type.name === "tableHeader";
      maxLines = Math.max(
        maxLines,
        measureCellLines(ctx, cell, theme, header, innerW),
      );
    });
    const rowH = maxLines * theme.lineHeightPx + CELL_PAD * 2;

    // Grid lines are drawn per column INDEX (0..numCols), independent of how
    // many cells this row actually has, so a ragged row (fewer cells than
    // numCols) still gets a complete grid. The rightmost vertical uses maxX to
    // avoid float drift from `numCols * colW`.
    ctx.fillStyle = theme.border;
    ctx.fillRect(x, rowTop, gridW, rule); // top edge (full width)
    for (let c = 0; c < numCols; c += 1) {
      ctx.fillRect(x + c * colW, rowTop, rule, rowH); // column left edges
    }
    ctx.fillRect(maxX - rule, rowTop, rule, rowH); // right outer edge

    // Cell text (existing cells only; missing columns stay empty but ruled).
    cells.forEach((cell, ci) => {
      const cellX = x + ci * colW;
      const header = cell.type.name === "tableHeader";
      const style = cellStyle(theme, header);
      let baseline = rowTop + CELL_PAD + theme.fontSizePx * 0.85;
      for (const para of cellParagraphs(cell)) {
        const items = collectInline(para);
        if (items.length) {
          const lines = paintInline(
            ctx,
            items,
            cellX + CELL_PAD,
            baseline,
            cellX + colW - CELL_PAD,
            style,
            theme,
          );
          baseline += lines * theme.lineHeightPx;
        } else {
          baseline += theme.lineHeightPx;
        }
      }
    });

    rowTop += rowH;
  }

  // Bottom outer edge.
  ctx.fillStyle = theme.border;
  ctx.fillRect(x, rowTop, gridW, rule);

  return rowTop + theme.fontSizePx * 0.85 + theme.paragraphGapPx;
}
