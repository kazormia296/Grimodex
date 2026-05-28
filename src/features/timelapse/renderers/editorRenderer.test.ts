// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { AuthorshipMark } from "@/features/attribution/AuthorshipMark";
import { DEFAULT_THEME, renderDocToCanvas } from "./editorRenderer";

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

  it("colours AuthorshipMark runs using the theme palette", () => {
    const editor = new Editor({
      extensions: [StarterKit, AuthorshipMark],
      content: "<p>Generated human added</p>",
    });
    const markType = editor.schema.marks["authorship"];
    editor.commands.command(({ tr }) => {
      tr.addMark(1, 10, markType.create({ source: "ai" }));
      return true;
    });
    const { ctx, ops } = makeMockCtx();
    renderDocToCanvas(
      ctx as unknown as CanvasRenderingContext2D,
      editor.state.doc,
      600,
      200,
    );
    const aiPaint = ops.find(
      (o) =>
        o.type === "fillText" &&
        typeof o.args[0] === "string" &&
        (o.args[0] as string).includes("Generated"),
    );
    expect(aiPaint?.fillStyle).toBe(DEFAULT_THEME.ai);
    const humanPaint = ops.find(
      (o) =>
        o.type === "fillText" &&
        typeof o.args[0] === "string" &&
        (o.args[0] as string).includes("added"),
    );
    expect(humanPaint?.fillStyle).toBe(DEFAULT_THEME.text);
    editor.destroy();
  });
});
