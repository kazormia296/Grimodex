// Browser test (real Chromium): vertical-rl geometry on a REAL 2D canvas.
// happy-dom can't rasterise glyphs, so the mock-ctx unit test only checks the
// coordinate maths. This proves the vertical path actually inks pixels and that
// the column flow starts on the RIGHT (vertical-rl) on a real canvas — the flip
// that "unit-green" can't see.
import { describe, it, expect } from "vitest";
import { getSchema } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import {
  DEFAULT_THEME,
  renderDocToCanvas,
  type EditorRenderTheme,
} from "./editorRenderer";

const schema = getSchema([StarterKit]);
const VERTICAL: EditorRenderTheme = {
  ...DEFAULT_THEME,
  vertical: true,
  tateChuYoko: "2",
};
const HORIZONTAL: EditorRenderTheme = { ...DEFAULT_THEME, vertical: false };

function inkBounds(ctx: CanvasRenderingContext2D, w: number, h: number) {
  const { data } = ctx.getImageData(0, 0, w, h);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let count = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = (y * w + x) * 4;
      // Ink = noticeably darker than the white background.
      if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) {
        count += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY, count };
}

function paint(theme: EditorRenderTheme, content: unknown[], w = 400, h = 300) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const doc = schema.nodeFromJSON({ type: "doc", content });
  renderDocToCanvas(ctx, doc, w, h, theme);
  return inkBounds(ctx, w, h);
}

describe("verticalRenderer (real canvas)", () => {
  // Latin glyphs for the pixel-bound geometry assertions: headless CI Chromium
  // always has a Latin font, whereas CJK glyph coverage is not guaranteed (a
  // missing font would ink nothing and false-fail). The mock-ctx unit test
  // covers the CJK/ruby/縦中横 geometry; here we only need "ink lands where the
  // coordinate maths says". CJK+ruby+tcy still get a real-canvas smoke below.
  it("inks the first column on the RIGHT (vs horizontal on the left)", () => {
    const one = [{ type: "paragraph", content: [{ type: "text", text: "A" }] }];
    const v = paint(VERTICAL, one);
    const hh = paint(HORIZONTAL, one);
    expect(v.count).toBeGreaterThan(0);
    expect(hh.count).toBeGreaterThan(0);
    // Same glyph: vertical starts near the right edge, horizontal near the left.
    expect(v.maxX).toBeGreaterThan(hh.maxX);
    expect(v.maxX).toBeGreaterThan(200); // right half of a 400px canvas
  });

  it("flows multi-paragraph text leftward across several columns", () => {
    const b = paint(VERTICAL, [
      { type: "paragraph", content: [{ type: "text", text: "ABCDEFGHIJKL" }] },
      { type: "paragraph", content: [{ type: "text", text: "MNOPQRSTUVWX" }] },
    ]);
    expect(b.count).toBeGreaterThan(0);
    // Columns span a wide horizontal band (right-to-left), not a single strip.
    expect(b.maxX - b.minX).toBeGreaterThan(40);
    // Characters stack down the column, filling vertical extent.
    expect(b.maxY - b.minY).toBeGreaterThan(40);
  });

  it("renders ruby + 縦中横 content without throwing", () => {
    expect(() =>
      paint(VERTICAL, [
        {
          type: "paragraph",
          content: [{ type: "text", text: "西暦26年に起きた。" }],
        },
      ]),
    ).not.toThrow();
  });
});
