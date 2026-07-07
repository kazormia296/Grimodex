import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type { AuthorshipSource, EditorRenderTheme } from "./editorRenderer";

/**
 * 執筆タイムラプス — inline text layer (P8 忠実化).
 *
 * Enriches the flat "authorship-only" run model with the inline formatting the
 * live editor shows but the video previously dropped: bold / italic / underline
 * / strikethrough marks, emphasis dots (圏点 = `emphasisDots` mark), and ruby
 * (振り仮名 = the atomic `ruby` node carrying `base` + `annotation`). Horizontal
 * writing only — vertical (縦書き) is a separate phase.
 */

export type { AuthorshipSource } from "./editorRenderer";

export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  "fillStyle" | "font" | "fillRect" | "fillText" | "measureText"
>;

/** A ctx wrapper that keeps font/measure but swallows paints — for measuring. */
export function makeNoPaintCtx(ctx: Ctx2D): Ctx2D {
  return {
    set fillStyle(value: string | CanvasGradient | CanvasPattern) {
      ctx.fillStyle = value;
    },
    get fillStyle() {
      return ctx.fillStyle;
    },
    set font(value: string) {
      ctx.font = value;
    },
    get font() {
      return ctx.font;
    },
    fillRect() {},
    fillText() {},
    measureText(text: string) {
      return ctx.measureText(text);
    },
  };
}

export interface InlineStyle {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  /** 圏点 (emphasisDots mark). */
  emphasis: boolean;
  /** 明示縦中横 (tcy mark) — policy 非依存で combine する。 */
  tcy: boolean;
}

const EMPTY_STYLE: InlineStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  emphasis: false,
  tcy: false,
};

interface TextItem {
  kind: "text";
  text: string;
  source: AuthorshipSource;
  style: InlineStyle;
}
interface RubyItem {
  kind: "ruby";
  base: string;
  annotation: string;
  source: AuthorshipSource;
}
export type InlineItem = TextItem | RubyItem;

/** Block-level text style inherited from the block (heading bold, quote italic). */
export interface BlockTextStyle {
  fontSizePx: number;
  lineHeightPx: number;
  color: string;
  bold: boolean;
  italic: boolean;
}

function hasMark(
  marks: readonly { type: { name: string } }[],
  ...names: string[]
): boolean {
  return marks.some((m) => names.includes(m.type.name));
}

function readStyle(marks: readonly { type: { name: string } }[]): InlineStyle {
  return {
    bold: hasMark(marks, "bold", "strong"),
    italic: hasMark(marks, "italic", "em"),
    underline: hasMark(marks, "underline"),
    strike: hasMark(marks, "strike", "strikethrough", "s"),
    emphasis: hasMark(marks, "emphasisDots"),
    tcy: hasMark(marks, "tcy"),
  };
}

function readSource(
  marks: readonly { type: { name: string }; attrs: Record<string, unknown> }[],
): AuthorshipSource {
  const mark = marks.find((m) => m.type.name === "authorship");
  return (mark?.attrs.source as AuthorshipSource | undefined) ?? null;
}

/** Flatten a block's inline children into text/ruby items with their marks. */
export function collectInline(block: ProseMirrorNode): InlineItem[] {
  const items: InlineItem[] = [];
  block.forEach((child) => {
    if (child.isText && child.text) {
      items.push({
        kind: "text",
        text: child.text,
        source: readSource(child.marks),
        style: readStyle(child.marks),
      });
      return;
    }
    if (child.type.name === "ruby") {
      items.push({
        kind: "ruby",
        base: String(child.attrs.base ?? ""),
        annotation: String(child.attrs.annotation ?? ""),
        source: readSource(child.marks),
      });
    }
  });
  return items;
}

export function fontStr(
  fontSizePx: number,
  bold: boolean,
  italic: boolean,
  family: string,
): string {
  return `${italic ? "italic " : ""}${bold ? "bold " : ""}${fontSizePx}px ${family}`;
}

function attributionTint(
  source: AuthorshipSource,
  theme: EditorRenderTheme,
): string | null {
  if (!theme.showAttribution) return null;
  if (source === "ai") return theme.attributionAi;
  if (source === "unknown") return theme.attributionUnknown;
  return null;
}

interface Token {
  kind: "text" | "space" | "ruby";
  text: string; // text/space token, or ruby base
  annotation?: string;
  source: AuthorshipSource;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  emphasis: boolean;
}

function tokenize(items: InlineItem[], block: BlockTextStyle): Token[] {
  const tokens: Token[] = [];
  for (const item of items) {
    if (item.kind === "ruby") {
      tokens.push({
        kind: "ruby",
        text: item.base,
        annotation: item.annotation,
        source: item.source,
        bold: block.bold,
        italic: block.italic,
        underline: false,
        strike: false,
        emphasis: false,
      });
      continue;
    }
    const st = item.style ?? EMPTY_STYLE;
    for (const raw of item.text.split(/(\s+)/)) {
      if (raw.length === 0) continue;
      tokens.push({
        kind: /^\s+$/.test(raw) ? "space" : "text",
        text: raw,
        source: item.source,
        bold: block.bold || st.bold,
        italic: block.italic || st.italic,
        underline: st.underline,
        strike: st.strike,
        emphasis: st.emphasis,
      });
    }
  }
  return tokens;
}

/** Draw underline / strikethrough rules and 圏点 dots for a painted token. */
/**
 * Draw underline / strike rules and 圏点 dots for the span `text` painted at
 * `[x, x+width]`. `text` is the exact span just painted — the whole token for a
 * normal draw, or a single character in the oversized char-wrap path — so
 * per-char dots are never duplicated.
 */
function paintDecorations(
  ctx: Ctx2D,
  token: Token,
  text: string,
  x: number,
  y: number,
  width: number,
  fontSizePx: number,
  color: string,
): void {
  const rule = Math.max(1, Math.round(fontSizePx * 0.06));
  if (token.underline) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y + fontSizePx * 0.16, width, rule);
  }
  if (token.strike) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y - fontSizePx * 0.3, width, rule);
  }
  if (token.emphasis) {
    const r = Math.max(1.5, fontSizePx * 0.08);
    const dotY = y - fontSizePx * 0.98 - r;
    let cx = x;
    ctx.fillStyle = color;
    for (const ch of text) {
      const cw = ctx.measureText(ch).width;
      ctx.fillRect(cx + cw / 2 - r, dotY, r * 2, r * 2);
      cx += cw;
    }
  }
}

/**
 * Paint enriched inline items with wrapping. Mirrors the old paintRuns geometry
 * (token wrapping, oversized-token char wrapping, authorship background tint)
 * and adds per-token bold/italic fonts, underline/strike rules, 圏点 dots, and
 * ruby annotations drawn above the base. Returns the number of visual lines.
 */
export function paintInline(
  ctx: Ctx2D,
  items: InlineItem[],
  startX: number,
  startY: number,
  maxX: number,
  block: BlockTextStyle,
  theme: EditorRenderTheme,
): number {
  const tokens = tokenize(items, block);
  const lineHeight = block.lineHeightPx;
  const fontSize = block.fontSizePx;
  const lineWidth = maxX - startX;
  let x = startX;
  let y = startY;
  let lines = 1;
  let firstOnLine = true;

  const setFont = (t: Token, size = fontSize) => {
    ctx.font = fontStr(size, t.bold, t.italic, theme.fontFamily);
  };

  for (const token of tokens) {
    const tint = attributionTint(token.source, theme);
    setFont(token);

    if (token.kind === "ruby") {
      const baseW = ctx.measureText(token.text).width;
      const annSize = fontSize * (theme.rubyFontScale ?? 0.5);
      ctx.font = fontStr(annSize, token.bold, false, theme.fontFamily);
      const annW = ctx.measureText(token.annotation ?? "").width;
      const w = Math.max(baseW, annW);
      // Wrap to a fresh line when the ruby doesn't fit. A ruby is atomic
      // (base + annotation can't be split), so a single ruby wider than the
      // whole line still overflows the right margin — same as an unbreakable
      // long word. Pathological for furigana (1–4 base chars); not force-split.
      if (!firstOnLine && x + w > maxX) {
        y += lineHeight;
        x = startX;
        lines += 1;
      }
      if (tint) {
        ctx.fillStyle = tint;
        ctx.fillRect(x, y - fontSize * 0.85, w, fontSize * 1.15);
      }
      // Base glyphs.
      setFont(token);
      ctx.fillStyle = block.color;
      ctx.fillText(token.text, x + (w - baseW) / 2, y);
      // Ruby annotation, centred above the base.
      if (token.annotation) {
        ctx.font = fontStr(annSize, token.bold, false, theme.fontFamily);
        ctx.fillStyle = block.color;
        ctx.fillText(
          token.annotation,
          x + (w - annW) / 2,
          y - fontSize * 0.9 - annSize * 0.25,
        );
      }
      x += w;
      firstOnLine = false;
      continue;
    }

    const isSpace = token.kind === "space";
    const w = ctx.measureText(token.text).width;

    if (!isSpace && !firstOnLine && x + w > maxX) {
      y += lineHeight;
      x = startX;
      lines += 1;
      firstOnLine = true;
    }
    if (firstOnLine && isSpace) continue;

    // Oversized token (long CJK run / long word): wrap character by character.
    if (!isSpace && w > lineWidth) {
      for (const ch of token.text) {
        const cw = ctx.measureText(ch).width;
        if (!firstOnLine && x + cw > maxX) {
          y += lineHeight;
          x = startX;
          lines += 1;
        }
        if (tint) {
          ctx.fillStyle = tint;
          ctx.fillRect(x, y - fontSize * 0.85, cw, fontSize * 1.15);
        }
        ctx.fillStyle = block.color;
        ctx.fillText(ch, x, y);
        paintDecorations(ctx, token, ch, x, y, cw, fontSize, block.color);
        x += cw;
        firstOnLine = false;
      }
      continue;
    }

    if (tint) {
      ctx.fillStyle = tint;
      ctx.fillRect(x, y - fontSize * 0.85, w, fontSize * 1.15);
    }
    ctx.fillStyle = block.color;
    ctx.fillText(token.text, x, y);
    if (!isSpace) {
      paintDecorations(ctx, token, token.text, x, y, w, fontSize, block.color);
    }
    x += w;
    firstOnLine = false;
  }
  return lines;
}
