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
  args: unknown[];
}

function makeMockCtx(charWidth = 8) {
  const ops: PaintOp[] = [];
  let currentFill = "";
  const ctx = {
    set fillStyle(v: string) {
      currentFill = v;
    },
    get fillStyle() {
      return currentFill;
    },
    font: "",
    fillRect(x: number, y: number, w: number, h: number) {
      ops.push({
        type: "fillRect",
        fillStyle: currentFill,
        args: [x, y, w, h],
      });
    },
    fillText(t: string, x: number, y: number) {
      ops.push({ type: "fillText", fillStyle: currentFill, args: [t, x, y] });
    },
    measureText(t: string) {
      return { width: t.length * charWidth };
    },
  };
  return { ctx, ops };
}

/** Paragraph with the first word ("Generated") marked source=ai. */
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
    const editor = new Editor({
      extensions: [StarterKit],
      content: "<p>Hello world</p>",
    });
    const { ctx, ops } = makeMockCtx();
    renderDocToCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      editor.state.doc,
      400,
      200,
    );
    const bg = ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === DEFAULT_THEME.background,
    );
    expect(bg).toBeTruthy();
    const text = ops.filter((o) => o.type === "fillText").map((o) => o.args[0]);
    expect(text.join("|")).toContain("Hello");
    expect(text.join("|")).toContain("world");
    editor.destroy();
  });

  it("tints AI runs with a background band when showAttribution is on, glyphs stay in the text colour", () => {
    const editor = aiEditor();
    const theme: EditorRenderTheme = {
      ...DEFAULT_THEME,
      showAttribution: true,
    };
    const { ctx, ops } = makeMockCtx();
    renderDocToCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      editor.state.doc,
      600,
      200,
      theme,
    );
    // A background band is painted in the AI tint colour.
    const aiBand = ops.find(
      (o) => o.type === "fillRect" && o.fillStyle === theme.attributionAi,
    );
    expect(aiBand).toBeTruthy();
    // No glyph is recoloured by provenance — all text uses theme.text.
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
    const tint = ops.find(
      (o) =>
        o.type === "fillRect" && o.fillStyle === DEFAULT_THEME.attributionAi,
    );
    expect(tint).toBeUndefined();
    editor.destroy();
  });

  it("leaves human runs untinted even when showAttribution is on", () => {
    const editor = new Editor({
      extensions: [StarterKit, AuthorshipMark],
      content: "<p>only human text</p>",
    });
    const markType = editor.schema.marks["authorship"];
    editor.commands.command(({ tr }) => {
      tr.addMark(
        1,
        editor.state.doc.content.size,
        markType.create({
          source: "human",
        }),
      );
      return true;
    });
    const theme: EditorRenderTheme = {
      ...DEFAULT_THEME,
      showAttribution: true,
    };
    const { ctx, ops } = makeMockCtx();
    renderDocToCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      editor.state.doc,
      600,
      200,
      theme,
    );
    // Only the full-canvas background fillRect — no attribution band.
    const nonBackgroundRects = ops.filter(
      (o) => o.type === "fillRect" && o.fillStyle !== theme.background,
    );
    expect(nonBackgroundRects).toHaveLength(0);
    editor.destroy();
  });
});
