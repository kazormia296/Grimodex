// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import {
  DEFAULT_THEME,
  renderDocToCanvas,
  type EditorRenderTheme,
} from "./editorRenderer";

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

function render(
  html: string,
  opts: {
    theme?: EditorRenderTheme;
    extra?: unknown[];
    width?: number;
    height?: number;
    focusPos?: number | null;
  } = {},
) {
  const editor = new Editor({
    extensions: [StarterKit, ...((opts.extra ?? []) as never[])],
    content: html,
  });
  const { ctx, ops } = makeMockCtx();
  renderDocToCanvas(
    ctx as unknown as CanvasRenderingContext2D,
    editor.state.doc,
    opts.width ?? 600,
    opts.height ?? 400,
    opts.theme,
    opts.focusPos,
  );
  editor.destroy();
  return ops;
}

function editorFor(html: string) {
  return new Editor({
    extensions: [StarterKit],
    content: html,
  });
}

const textOf = (ops: PaintOp[]) =>
  ops
    .filter((o) => o.type === "fillText")
    .map((o) => o.args[0])
    .join("|");

function aiEditor() {
  const editor = new Editor({
    extensions: [StarterKit, AuthorshipMark],
    content: "<p>Generated human added</p>",
  });
  const markType = editor.schema.marks["authorship"];
  editor.commands.command(({ tr }) => {
    tr.addMark(1, 10, markType.create({ source: "ai" }));
    return true;
  });
  return editor;
}

describe("renderDocToCanvas", () => {
  it("paints the background and the document text", () => {
    const ops = render("<p>Hello world</p>");
    expect(
      ops.find(
        (o) =>
          o.type === "fillRect" && o.fillStyle === DEFAULT_THEME.background,
      ),
    ).toBeTruthy();
    expect(textOf(ops)).toContain("Hello");
    expect(textOf(ops)).toContain("world");
  });

  it("tints AI runs with a background band when showAttribution is on, glyphs stay text colour", () => {
    const theme: EditorRenderTheme = {
      ...DEFAULT_THEME,
      showAttribution: true,
    };
    const editor = aiEditor();
    const { ctx, ops } = makeMockCtx();
    renderDocToCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      editor.state.doc,
      600,
      200,
      theme,
    );
    expect(
      ops.find(
        (o) => o.type === "fillRect" && o.fillStyle === theme.attributionAi,
      ),
    ).toBeTruthy();
    const textOps = ops.filter((o) => o.type === "fillText");
    expect(textOps.length).toBeGreaterThan(0);
    for (const o of textOps) expect(o.fillStyle).toBe(theme.text);
    editor.destroy();
  });

  it("does not tint when showAttribution is off (default theme)", () => {
    const editor = aiEditor();
    const { ctx, ops } = makeMockCtx();
    renderDocToCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      editor.state.doc,
      600,
      200,
    );
    expect(
      ops.find(
        (o) =>
          o.type === "fillRect" && o.fillStyle === DEFAULT_THEME.attributionAi,
      ),
    ).toBeUndefined();
    editor.destroy();
  });

  it("renders headings larger and bold", () => {
    const ops = render("<h1>Title</h1><p>body</p>");
    const title = ops.find(
      (o) => o.type === "fillText" && o.args[0] === "Title",
    );
    expect(title).toBeTruthy();
    expect(title?.font).toContain("bold");
    // h1 = 2em of the 16px base → 32px.
    expect(title?.font).toContain("32px");
    const body = ops.find((o) => o.type === "fillText" && o.args[0] === "body");
    expect(body?.font).toContain("16px");
    expect(body?.font).not.toContain("bold");
  });

  it("renders blockquote with a left rule and muted italic text", () => {
    const ops = render("<blockquote><p>Quote</p></blockquote>");
    expect(
      ops.find(
        (o) => o.type === "fillRect" && o.fillStyle === DEFAULT_THEME.border,
      ),
    ).toBeTruthy();
    const quote = ops.find(
      (o) => o.type === "fillText" && o.args[0] === "Quote",
    );
    expect(quote?.fillStyle).toBe(DEFAULT_THEME.textMuted);
    expect(quote?.font).toContain("italic");
  });

  it("renders bullet and ordered list markers", () => {
    const bullet = render("<ul><li><p>Item</p></li></ul>");
    expect(textOf(bullet)).toContain("•");
    expect(textOf(bullet)).toContain("Item");

    const ordered = render("<ol><li><p>First</p></li></ol>");
    expect(textOf(ordered)).toContain("1.");
    expect(textOf(ordered)).toContain("First");
  });

  it("wraps long CJK runs at the right margin", () => {
    // charWidth=8, canvas width=600, paddingPx=32 (DEFAULT_THEME)
    // → lineWidth = (600-32) - 32 = 536px → 67 chars fit per line.
    // A 100-char run must produce two distinct y-coordinates.
    const ops = render("<p>" + "あ".repeat(100) + "</p>");
    const textOps = ops.filter((o) => o.type === "fillText");
    const ys = new Set(textOps.map((o) => o.args[2] as number));
    expect(ys.size).toBeGreaterThan(1);
  });

  it("scrolls a long document so the focused block is visible", () => {
    const html = Array.from(
      { length: 30 },
      (_, i) => `<p>Paragraph${String(i + 1).padStart(2, "0")}</p>`,
    ).join("");
    const editor = editorFor(html);
    const { ctx, ops } = makeMockCtx();

    renderDocToCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      editor.state.doc,
      600,
      120,
      DEFAULT_THEME,
      editor.state.doc.content.size,
    );

    const textOps = ops.filter((o) => o.type === "fillText");
    expect(textOps.some((o) => o.args[0] === "Paragraph01")).toBe(false);
    const last = textOps.find((o) => o.args[0] === "Paragraph30");
    expect(last).toBeTruthy();
    expect(last?.args[2]).toBeGreaterThanOrEqual(0);
    expect(last?.args[2]).toBeLessThanOrEqual(120);
    editor.destroy();
  });

  it("keeps long documents top-aligned when focus is not provided", () => {
    const html = Array.from(
      { length: 30 },
      (_, i) => `<p>Paragraph${String(i + 1).padStart(2, "0")}</p>`,
    ).join("");
    const ops = render(html, { height: 120 });
    const first = ops.find(
      (o) => o.type === "fillText" && o.args[0] === "Paragraph01",
    );
    const last = ops.find(
      (o) => o.type === "fillText" && o.args[0] === "Paragraph30",
    );

    expect(first?.args[2]).toBe(
      DEFAULT_THEME.paddingPx + DEFAULT_THEME.fontSizePx,
    );
    expect(last).toBeUndefined();
  });

  it("does not scroll short documents even with a focus position", () => {
    const editor = editorFor("<p>Short</p>");
    const { ctx, ops } = makeMockCtx();

    renderDocToCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      editor.state.doc,
      600,
      400,
      DEFAULT_THEME,
      editor.state.doc.content.size,
    );

    const short = ops.find(
      (o) => o.type === "fillText" && o.args[0] === "Short",
    );
    expect(short?.args[2]).toBe(
      DEFAULT_THEME.paddingPx + DEFAULT_THEME.fontSizePx,
    );
    editor.destroy();
  });
});
