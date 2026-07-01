// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { RubyNode } from "@/features/editor/RubyNode";
import { EmphasisDotsMark } from "@/features/editor/EmphasisDotsMark";
import { SceneBeatNode } from "@/features/editor/SceneBeatNode";
import {
  DEFAULT_THEME,
  renderDocToCanvas,
  type EditorRenderTheme,
} from "./editorRenderer";

/**
 * 縦書き (vertical-rl) 幾何 invariant を mock ctx で gate する。happy-dom は canvas
 * 実寸を測れないので measureText を charWidth 固定にして「下→左に進む・ruby/圏点は
 * 右・縦中横は横 1 セル」という座標関係だけを検証する。実寸は browser test 側。
 */

interface PaintOp {
  type: "fillRect" | "fillText";
  fillStyle: string;
  font: string;
  args: unknown[];
}

function makeMockCtx(charWidth = 8) {
  const ops: PaintOp[] = [];
  let currentFill = "";
  let currentFont = "";
  const ctx = {
    set fillStyle(v: string) {
      currentFill = v;
    },
    get fillStyle() {
      return currentFill;
    },
    set font(v: string) {
      currentFont = v;
    },
    get font() {
      return currentFont;
    },
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push({
        type: "fillRect",
        fillStyle: currentFill,
        font: currentFont,
        args: [x, y, w, h],
      });
    },
    fillText(t: string, x: number, y: number) {
      ops.push({
        type: "fillText",
        fillStyle: currentFill,
        font: currentFont,
        args: [t, x, y],
      });
    },
    measureText(t: string) {
      return { width: t.length * charWidth };
    },
  };
  return { ctx, ops };
}

const richSchema = getSchema([
  StarterKit,
  AuthorshipMark,
  RubyNode,
  EmphasisDotsMark,
  SceneBeatNode,
]);

const VERTICAL: EditorRenderTheme = {
  ...DEFAULT_THEME,
  vertical: true,
  tateChuYoko: "2",
};

function renderJson(
  content: unknown[],
  opts: {
    theme?: EditorRenderTheme;
    width?: number;
    height?: number;
    focusPos?: number | null;
  } = {},
): PaintOp[] {
  const doc = richSchema.nodeFromJSON({ type: "doc", content });
  const { ctx, ops } = makeMockCtx();
  renderDocToCanvas(
    ctx as unknown as CanvasRenderingContext2D,
    doc,
    opts.width ?? 600,
    opts.height ?? 400,
    opts.theme ?? VERTICAL,
    opts.focusPos,
  );
  return ops;
}

const para = (content: unknown[]) => ({ type: "paragraph", content });
const txt = (text: string, marks?: { type: string }[]) => ({
  type: "text",
  text,
  ...(marks ? { marks } : {}),
});
const texts = (ops: PaintOp[]) => ops.filter((o) => o.type === "fillText");
const glyph = (ops: PaintOp[], t: string) =>
  texts(ops).find((o) => o.args[0] === t);

describe("verticalRenderer — text flow", () => {
  it("advances glyphs downward within a column (increasing y, constant x)", () => {
    const ops = texts(renderJson([para([txt("あいう")])])).filter((o) =>
      ["あ", "い", "う"].includes(o.args[0] as string),
    );
    expect(ops.length).toBe(3);
    const ys = ops.map((o) => o.args[2] as number);
    expect(ys[0]).toBeLessThan(ys[1]);
    expect(ys[1]).toBeLessThan(ys[2]);
    const xs = ops.map((o) => o.args[1] as number);
    expect(xs[0]).toBeCloseTo(xs[1], 5);
    expect(xs[1]).toBeCloseTo(xs[2], 5);
  });

  it("starts the first column on the right half of the canvas", () => {
    const first = glyph(renderJson([para([txt("あ")])]), "あ")!;
    expect(first.args[1] as number).toBeGreaterThan(300);
  });

  it("lays later paragraphs to the LEFT of earlier ones (right-to-left)", () => {
    const ops = renderJson([para([txt("あ")]), para([txt("い")])]);
    const a = glyph(ops, "あ")!;
    const b = glyph(ops, "い")!;
    expect(b.args[1] as number).toBeLessThan(a.args[1] as number);
  });

  it("wraps a long column to a NEW column further left when it fills", () => {
    // height 120 → padding 32*2 leaves ~56px; fontSize 16 → ~3 cells per column.
    const long = "あいうえおかきくけこ";
    const ops = texts(renderJson([para([txt(long)])], { height: 120 }));
    const first = ops[0].args[1] as number;
    const last = ops[ops.length - 1].args[1] as number;
    expect(last).toBeLessThan(first); // wrapped leftward
  });
});

describe("verticalRenderer — ruby / emphasis on the right", () => {
  it("draws the ruby annotation to the RIGHT of the base column", () => {
    const ops = renderJson([
      para([{ type: "ruby", attrs: { base: "漢", annotation: "かん" } }]),
    ]);
    const base = glyph(ops, "漢")!;
    // Vertical ruby stacks the annotation glyph-by-glyph alongside the base.
    const ann = glyph(ops, "か")!;
    expect(base).toBeDefined();
    expect(ann).toBeDefined();
    expect(ann.args[1] as number).toBeGreaterThan(base.args[1] as number);
    expect(ann.font).toContain("8px"); // rubyFontScale 0.5 × 16
  });

  it("places 圏点 dots to the RIGHT of the emphasised glyph", () => {
    const ops = renderJson([para([txt("強", [{ type: "emphasisDots" }])])]);
    const g = glyph(ops, "強")!;
    const dot = ops.find(
      (o) =>
        o.type === "fillRect" &&
        o.fillStyle === DEFAULT_THEME.text &&
        o.args[2] === o.args[3], // square
    );
    expect(g).toBeDefined();
    expect(dot).toBeDefined();
    expect(dot!.args[0] as number).toBeGreaterThan(g.args[1] as number);
  });
});

describe("verticalRenderer — 縦中横 (tate-chu-yoko)", () => {
  it("collapses a 2-digit run into one horizontal cell (single fillText of the run)", () => {
    const ops = renderJson([para([txt("西暦26年")])]);
    expect(glyph(ops, "26")).toBeDefined();
    expect(glyph(ops, "2")).toBeUndefined();
    expect(glyph(ops, "6")).toBeUndefined();
  });

  it("policy 'off' stacks digits as normal glyphs (no combined run)", () => {
    const ops = renderJson([para([txt("西暦26年")])], {
      theme: { ...VERTICAL, tateChuYoko: "off" },
    });
    expect(glyph(ops, "26")).toBeUndefined();
    expect(glyph(ops, "2")).toBeDefined();
    expect(glyph(ops, "6")).toBeDefined();
  });

  it("policy '2' does NOT combine a 3-digit run", () => {
    const ops = renderJson([para([txt("西暦123年")])]);
    expect(glyph(ops, "123")).toBeUndefined();
    expect(glyph(ops, "1")).toBeDefined();
  });
});

describe("verticalRenderer — structure + attribution", () => {
  it("tints an AI run cell background when showAttribution is on", () => {
    const ops = renderJson(
      [
        para([
          txt("生成", [
            { type: "authorship", attrs: { source: "ai" } } as unknown as {
              type: string;
            },
          ]),
        ]),
      ],
      {
        theme: { ...VERTICAL, showAttribution: true },
      },
    );
    const tint = ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === VERTICAL.attributionAi,
    );
    expect(tint).toBeDefined();
  });

  it("renders a heading with a larger glyph font", () => {
    const ops = renderJson([
      { type: "heading", attrs: { level: 1 }, content: [txt("章")] },
    ]);
    const h = glyph(ops, "章")!;
    expect(h.font).toMatch(/32px/); // 16 × HEADING_SCALE[1]=2
  });
});

describe("verticalRenderer — vertical:false is unaffected", () => {
  it("horizontal theme keeps left-to-right flow", () => {
    const ops = texts(
      renderJson([para([txt("あい")])], {
        theme: { ...DEFAULT_THEME, vertical: false },
      }),
    );
    // Horizontal path draws the whole run in one fillText; assert it's not the
    // vertical per-glyph split (no separate 'あ' / 'い' cells).
    expect(ops.find((o) => o.args[0] === "あい")).toBeDefined();
  });
});
