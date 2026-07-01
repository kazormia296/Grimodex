import {
  runLengthAllowed,
  type TateChuYokoPolicy,
} from "@/features/editor/tateChuYokoPolicy";
import type { AuthorshipSource, EditorRenderTheme } from "./editorRenderer";
import {
  fontStr,
  type BlockTextStyle,
  type Ctx2D,
  type InlineItem,
} from "./inlineRuns";

/**
 * 執筆タイムラプス — 縦書き (vertical-rl) inline layer.
 *
 * Mirrors `inlineRuns.paintInline` but rotates the coordinate system 90°: glyphs
 * advance **down** a column, columns advance **leftward** (right-to-left), ruby
 * (振り仮名) and emphasis dots (圏点) sit to the **right** of the glyph column
 * (CSS `text-emphasis-position: over right` / vertical ruby), underline/strike
 * become vertical rules, and half-width digit runs collapse into a horizontal
 * 縦中横 (tate-chu-yoko) cluster occupying a single vertical cell
 * (`text-combine-upright: all`). Horizontal geometry lives in `inlineRuns.ts`;
 * this file is only reached when `theme.vertical` is set.
 *
 * A column's horizontal pitch is `block.lineHeightPx` (the inline leading of the
 * horizontal path becomes column width here); each glyph advances one em
 * (`block.fontSizePx`) down, the standard full-width cell of Japanese vertical
 * setting.
 */

const DIGIT_RUN = /([0-9]+)/;

/** Wrap a bare string as a single unstyled inline item (labels / list markers). */
export function verticalTextItems(text: string): InlineItem[] {
  return [
    {
      kind: "text",
      text,
      source: null,
      style: {
        bold: false,
        italic: false,
        underline: false,
        strike: false,
        emphasis: false,
      },
    } as InlineItem,
  ];
}

interface VCell {
  kind: "char" | "tcy" | "ruby" | "break";
  /** char glyph / tcy digit run / ruby base. */
  text: string;
  annotation?: string;
  source: AuthorshipSource;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  emphasis: boolean;
  /** How many vertical cells this unit occupies (ruby base length, else 1). */
  span: number;
}

/** Flatten inline items into vertical cells, collapsing 縦中横 digit runs. */
function toCells(
  items: InlineItem[],
  block: BlockTextStyle,
  policy: TateChuYokoPolicy,
): VCell[] {
  const cells: VCell[] = [];
  for (const item of items) {
    if (item.kind === "ruby") {
      const base = item.base || "";
      cells.push({
        kind: "ruby",
        text: base,
        annotation: item.annotation,
        source: item.source,
        bold: block.bold,
        italic: block.italic,
        underline: false,
        strike: false,
        emphasis: false,
        span: Math.max(1, [...base].length),
      });
      continue;
    }
    const st = item.style;
    const common = {
      source: item.source,
      bold: block.bold || st.bold,
      italic: block.italic || st.italic,
      underline: st.underline,
      strike: st.strike,
      emphasis: st.emphasis,
    };
    // Split into alternating non-digit / digit segments so a qualifying digit
    // run becomes one 縦中横 cell (within a single mark span — cross-mark runs
    // are left as stacked digits, matching what collectInline can see here).
    for (const seg of item.text.split(DIGIT_RUN)) {
      if (seg.length === 0) continue;
      const isDigits = /^[0-9]+$/.test(seg);
      if (
        isDigits &&
        policy !== "off" &&
        runLengthAllowed(seg.length, policy)
      ) {
        cells.push({ kind: "tcy", text: seg, span: 1, ...common });
        continue;
      }
      for (const ch of seg) {
        if (ch === "\n") {
          cells.push({ ...EMPTY_BREAK });
          continue;
        }
        cells.push({ kind: "char", text: ch, span: 1, ...common });
      }
    }
  }
  return cells;
}

const EMPTY_BREAK: VCell = {
  kind: "break",
  text: "",
  source: null,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  emphasis: false,
  span: 1,
};

function tintFor(
  source: AuthorshipSource,
  theme: EditorRenderTheme,
): string | null {
  if (!theme.showAttribution) return null;
  if (source === "ai") return theme.attributionAi;
  if (source === "unknown") return theme.attributionUnknown;
  return null;
}

export interface VerticalInlineResult {
  /** Number of columns the block consumed (≥1). */
  columns: number;
}

/**
 * Paint inline items as vertical-rl columns. `xRight` is the right edge of the
 * first column; columns extend leftward. Returns the column count so the block
 * layout can advance the next block further left.
 */
export function paintInlineVertical(
  ctx: Ctx2D,
  items: InlineItem[],
  xRight: number,
  yTop: number,
  yBottom: number,
  block: BlockTextStyle,
  theme: EditorRenderTheme,
): VerticalInlineResult {
  const cells = toCells(items, block, theme.tateChuYoko);
  const cw = block.lineHeightPx; // column pitch (horizontal)
  const cellH = block.fontSizePx; // per-glyph advance (down)
  const colHeight = Math.max(1, yBottom - yTop);
  const maxCellsPerCol = Math.max(1, Math.floor(colHeight / cellH));

  let col = 0;
  let row = 0; // cell index within the current column

  const colCenter = (c: number) => xRight - (c + 1) * cw + cw / 2;

  const advance = (span: number) => {
    row += span;
    if (row >= maxCellsPerCol) {
      col += 1;
      row = 0;
    }
  };

  for (const cell of cells) {
    if (cell.kind === "break") {
      col += 1;
      row = 0;
      continue;
    }
    // Atomic ruby that doesn't fit the remainder of the column wraps first.
    if (cell.span > 1 && row + cell.span > maxCellsPerCol && row > 0) {
      col += 1;
      row = 0;
    }
    const cx = colCenter(col);
    const cellTop = yTop + row * cellH;
    const tint = tintFor(cell.source, theme);
    if (tint) {
      ctx.fillStyle = tint;
      ctx.fillRect(cx - cellH / 2, cellTop, cellH, cellH * cell.span);
    }

    if (cell.kind === "tcy") {
      paintTcy(ctx, cell, cx, cellTop, block, theme);
      advance(1);
      continue;
    }
    if (cell.kind === "ruby") {
      paintRubyVertical(ctx, cell, cx, cellTop, cellH, block, theme);
      advance(cell.span);
      continue;
    }
    // Plain glyph.
    ctx.font = fontStr(cellH, cell.bold, cell.italic, theme.fontFamily);
    const w = ctx.measureText(cell.text).width;
    ctx.fillStyle = block.color;
    ctx.fillText(cell.text, cx - w / 2, cellTop + cellH * 0.82);
    paintVerticalDecorations(ctx, cell, cx, cellTop, cellH, block.color);
    advance(1);
  }

  return { columns: Math.max(1, col + (row > 0 ? 1 : 0)) };
}

/** underline → left vertical rule; strike → centre rule; 圏点 → right dot. */
function paintVerticalDecorations(
  ctx: Ctx2D,
  cell: VCell,
  cx: number,
  cellTop: number,
  cellH: number,
  color: string,
): void {
  const rule = Math.max(1, Math.round(cellH * 0.06));
  if (cell.underline) {
    ctx.fillStyle = color;
    ctx.fillRect(cx - cellH * 0.5, cellTop, rule, cellH);
  }
  if (cell.strike) {
    ctx.fillStyle = color;
    ctx.fillRect(cx - rule / 2, cellTop, rule, cellH);
  }
  if (cell.emphasis) {
    const r = Math.max(1.5, cellH * 0.08);
    ctx.fillStyle = color;
    ctx.fillRect(cx + cellH * 0.5, cellTop + cellH / 2 - r, r * 2, r * 2);
  }
}

/** Horizontal digit cluster compressed into one vertical cell (縦中横). */
function paintTcy(
  ctx: Ctx2D,
  cell: VCell,
  cx: number,
  cellTop: number,
  block: BlockTextStyle,
  theme: EditorRenderTheme,
): void {
  const cellH = block.fontSizePx;
  ctx.font = fontStr(cellH, cell.bold, false, theme.fontFamily);
  const fullW = ctx.measureText(cell.text).width;
  // Compress to ~1em so the whole run occupies one cell horizontally.
  const scale = fullW > cellH ? cellH / fullW : 1;
  const size = cellH * scale;
  ctx.font = fontStr(size, cell.bold, false, theme.fontFamily);
  const w = ctx.measureText(cell.text).width;
  ctx.fillStyle = block.color;
  ctx.fillText(cell.text, cx - w / 2, cellTop + cellH * 0.72);
}

/** Base glyphs stacked in the column; annotation stacked to their right. */
function paintRubyVertical(
  ctx: Ctx2D,
  cell: VCell,
  cx: number,
  cellTop: number,
  cellH: number,
  block: BlockTextStyle,
  theme: EditorRenderTheme,
): void {
  const baseChars = [...cell.text];
  ctx.font = fontStr(cellH, cell.bold, cell.italic, theme.fontFamily);
  ctx.fillStyle = block.color;
  baseChars.forEach((ch, i) => {
    const w = ctx.measureText(ch).width;
    ctx.fillText(ch, cx - w / 2, cellTop + i * cellH + cellH * 0.82);
  });
  const annotation = cell.annotation ?? "";
  if (!annotation) return;
  const annSize = cellH * (theme.rubyFontScale ?? 0.5);
  ctx.font = fontStr(annSize, cell.bold, false, theme.fontFamily);
  const annChars = [...annotation];
  // Distribute annotation glyphs down the base's cell span, on the right side.
  const span = Math.max(1, baseChars.length);
  const annX = cx + cellH * 0.5;
  annChars.forEach((ch, i) => {
    const y =
      cellTop + ((i + 0.5) * (span * cellH)) / annChars.length + annSize * 0.3;
    ctx.fillStyle = block.color;
    ctx.fillText(ch, annX, y);
  });
}
