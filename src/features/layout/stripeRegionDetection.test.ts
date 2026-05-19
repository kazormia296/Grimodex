import { describe, it, expect } from "vitest";
import { detectRegionFromRects } from "./stripeRegionDetection";

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
  };
}

describe("detectRegionFromRects", () => {
  const editor = rect(300, 0, 700, 800); // editor は (300,0) - (1000,800)

  it("returns 'left' when panel is entirely to the left of editor", () => {
    expect(detectRegionFromRects(rect(0, 0, 250, 800), editor)).toBe("left");
  });

  it("returns 'right' when panel is entirely to the right of editor", () => {
    expect(detectRegionFromRects(rect(1000, 0, 200, 800), editor)).toBe(
      "right",
    );
  });

  it("returns 'bottom' when panel is entirely below editor", () => {
    expect(detectRegionFromRects(rect(300, 800, 700, 200), editor)).toBe(
      "bottom",
    );
  });

  it("returns null when panel overlaps editor (same group case)", () => {
    expect(detectRegionFromRects(rect(300, 0, 700, 800), editor)).toBe(null);
  });

  it("returns null when panel is above editor (top region unsupported)", () => {
    expect(detectRegionFromRects(rect(300, -200, 700, 200), editor)).toBe(null);
  });

  it("tolerates sub-pixel alignment (4px tolerance)", () => {
    // panel.right = 297 (= editor.left - 3) → within tol(4)
    expect(detectRegionFromRects(rect(0, 0, 297, 800), editor)).toBe("left");
  });

  it("returns null when editor rect has zero size (init transient)", () => {
    expect(detectRegionFromRects(rect(0, 0, 100, 100), rect(0, 0, 0, 0))).toBe(
      null,
    );
  });

  it("requires horizontal overlap for 'bottom' classification", () => {
    // editor が縮んだ (例: chat を editor 列の下に drag) と仮定:
    //   editor = (300, 0, 700, 400)  — top half only
    //   panel  = col 1 下半分 (0, 400, 300, 800)
    // panel.top (400) >= editor.bottom (400) は満たすが、水平方向で editor と重ならないので "left" のまま
    const shortEditor = rect(300, 0, 700, 400);
    const leftColumnLowerHalf = rect(0, 400, 300, 400);
    expect(detectRegionFromRects(leftColumnLowerHalf, shortEditor)).toBe(
      "left",
    );
  });

  it("classifies a bottom panel as 'bottom' when below AND horizontally overlapping", () => {
    // editor = col 2 上半分
    //   editor = (300, 0, 700, 400)
    //   chat   = col 2 下半分 (300, 400, 700, 400)  — editor と水平に重なる
    const shortEditor = rect(300, 0, 700, 400);
    const belowEditor = rect(300, 400, 700, 400);
    expect(detectRegionFromRects(belowEditor, shortEditor)).toBe("bottom");
  });

  it("classifies a full-width bottom row panel as 'bottom'", () => {
    // chat が root-bottom に drop された場合 (全幅、editor の下)
    const fullWidthBottom = rect(0, 800, 1000, 200);
    expect(detectRegionFromRects(fullWidthBottom, editor)).toBe("bottom");
  });

  it("classifies bottom-left corner panel (no overlap) as 'left'", () => {
    // 完全に editor の左 (右端 ≤ editor.left) でかつ下にも伸びている → 左
    const cornerLeft = rect(0, 600, 290, 400);
    expect(detectRegionFromRects(cornerLeft, editor)).toBe("left");
  });
});
