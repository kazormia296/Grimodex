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
  theme?: EditorRenderTheme,
  extra: unknown[] = [],
) {
  const editor = new Editor({
    extensions: [StarterKit, ...(extra as never[])],
    content: html,
  });
  const { ctx, ops } = makeMockCtx();
  renderDocToCanvas(
    ctx as unknown as CanvasRenderingContext2D,
    editor.state.doc,
    600,
    400,
    theme,
  );
  editor.destroy();
  return ops;
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
});
