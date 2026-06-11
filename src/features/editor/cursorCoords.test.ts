import { describe, it, expect } from "vitest";
import {
  caretBox,
  lineAxisContentCoord,
  toContainerRelative,
  resolveCoords,
  resolveVerticalBias,
  type Coords,
} from "./cursorCoords";
import type { EditorView } from "@tiptap/pm/view";

// ---------------------------------------------------------------------------
// toContainerRelative
// ---------------------------------------------------------------------------
describe("toContainerRelative", () => {
  it("converts viewport coords to container-relative offsets", () => {
    const coords: Coords = { left: 150, right: 152, top: 300, bottom: 320 };
    const containerRect = { left: 50, top: 100 };
    expect(toContainerRelative(coords, containerRect)).toEqual({
      left: 100,
      top: 200,
      height: 20,
    });
  });

  it("handles zero container offset", () => {
    const coords: Coords = { left: 80, right: 82, top: 40, bottom: 60 };
    expect(toContainerRelative(coords, { left: 0, top: 0 })).toEqual({
      left: 80,
      top: 40,
      height: 20,
    });
  });

  it("produces negative offsets when coords are above/left of container", () => {
    const coords: Coords = { left: 10, right: 12, top: 20, bottom: 40 };
    expect(toContainerRelative(coords, { left: 50, top: 100 })).toEqual({
      left: -40,
      top: -80,
      height: 20,
    });
  });
});

// ---------------------------------------------------------------------------
// resolveVerticalBias
// ---------------------------------------------------------------------------
describe("resolveVerticalBias", () => {
  it("returns null when not at a wrap boundary", () => {
    expect(resolveVerticalBias(100, 101, 160, "up")).toBeNull();
    expect(resolveVerticalBias(100, 100, 160, "down")).toBeNull();
  });

  // Reported bug: ArrowLeft (bias=-1) then ArrowUp lands at wrap boundary.
  // prevTop=160 (line 2), endTop=100 (line 0), startTop=130 (line 1).
  // Should pick startTop=130 (bias=1, line 1) — the closest line above.
  it("ArrowUp: picks line-start side when both above and start is closer", () => {
    expect(resolveVerticalBias(100, 130, 160, "up")).toBe(1);
  });

  // Triple-wrap: cursor at line 1 end (prevTop=130), ArrowUp lands at
  // wrap boundary between line 0 (endTop=100) and line 1 (startTop=130).
  // startTop=130 is NOT < 129, so only endTop qualifies → bias=-1.
  it("ArrowUp: picks line-end side when only it is above prevTop", () => {
    expect(resolveVerticalBias(100, 130, 130, "up")).toBe(-1);
  });

  it("ArrowUp: picks line-start side when only it is above prevTop", () => {
    expect(resolveVerticalBias(160, 130, 160, "up")).toBe(1);
  });

  it("ArrowUp: falls back to line-start when neither is above", () => {
    expect(resolveVerticalBias(170, 180, 160, "up")).toBe(1);
  });

  it("ArrowDown: picks line-end side when both below and end is closer", () => {
    // prevTop=100, endTop=130 (line 1 end), startTop=160 (line 2 start)
    expect(resolveVerticalBias(130, 160, 100, "down")).toBe(-1);
  });

  it("ArrowDown: picks line-end side when only it is below prevTop", () => {
    expect(resolveVerticalBias(130, 100, 100, "down")).toBe(-1);
  });

  it("ArrowDown: picks line-start side when only it is below prevTop", () => {
    expect(resolveVerticalBias(100, 130, 100, "down")).toBe(1);
  });

  it("ArrowDown: falls back to line-end when neither is below", () => {
    expect(resolveVerticalBias(80, 90, 160, "down")).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// resolveCoords
// ---------------------------------------------------------------------------

const lineEnd: Coords = { left: 200, right: 202, top: 100, bottom: 120 };
const lineStart: Coords = { left: 10, right: 12, top: 124, bottom: 144 };

function makeView(
  coordsAtPos: (_pos: number, side?: number) => Coords,
): EditorView {
  return { coordsAtPos } as unknown as EditorView;
}

describe("resolveCoords", () => {
  it("returns coordsAtPos(from, -1) when bias is -1 (line-end side)", () => {
    const view = makeView((_pos, side) => (side === -1 ? lineEnd : lineStart));
    expect(resolveCoords(view, 5, -1)).toEqual(lineEnd);
  });

  it("returns coordsAtPos(from, 1) when bias is 1 (line-start side)", () => {
    const view = makeView((_pos, side) => (side === -1 ? lineEnd : lineStart));
    expect(resolveCoords(view, 5, 1)).toEqual(lineStart);
  });

  it("returns null when coordsAtPos throws", () => {
    const view = makeView(() => {
      throw new Error("atom node");
    });
    expect(resolveCoords(view, 5, 1)).toBeNull();
    expect(resolveCoords(view, 5, -1)).toBeNull();
  });

  it("passes the position through to coordsAtPos", () => {
    const positions: number[] = [];
    const view = makeView((pos) => {
      positions.push(pos);
      return lineStart;
    });
    resolveCoords(view, 42, 1);
    expect(positions[0]).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// caretBox (縦書きスムースキャレットの幾何)
// ---------------------------------------------------------------------------
describe("caretBox", () => {
  const rect = { left: 50, top: 100 };

  it("横書き: 縦棒 (width=thickness, height=行高)", () => {
    const coords: Coords = { left: 150, right: 152, top: 300, bottom: 324 };
    expect(caretBox(coords, rect, false)).toEqual({
      left: 100,
      top: 200,
      width: 2,
      height: 24,
    });
  });

  it("縦書き: 横棒 (width=文字幅, height=thickness)", () => {
    // vertical-rl の coordsAtPos は top≈bottom・left..right=文字幅 の
    // 平たい矩形を返す
    const coords: Coords = { left: 400, right: 424, top: 300, bottom: 302 };
    expect(caretBox(coords, rect, true)).toEqual({
      left: 350,
      top: 200,
      width: 24,
      height: 2,
    });
  });

  it("幅/高さゼロの矩形でも thickness を下限に保つ", () => {
    const flat: Coords = { left: 400, right: 400, top: 300, bottom: 300 };
    expect(caretBox(flat, rect, true).width).toBe(2);
    expect(caretBox(flat, rect, false).height).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// lineAxisContentCoord (行スタック軸の content 座標・前方=増加)
// ---------------------------------------------------------------------------
describe("lineAxisContentCoord", () => {
  const rect = { left: 50, top: 100 };

  it("横書き: y 軸 + scrollTop 補正で前方(下)=増加", () => {
    const scroll = { scrollLeft: 0, scrollTop: 30 };
    expect(
      lineAxisContentCoord({ left: 0, top: 300 }, rect, scroll, false),
    ).toBe(230);
    // 次の行 (より下) は大きい値
    expect(
      lineAxisContentCoord({ left: 0, top: 330 }, rect, scroll, false),
    ).toBeGreaterThan(
      lineAxisContentCoord({ left: 0, top: 300 }, rect, scroll, false),
    );
  });

  it("縦書き: x 軸を反転して前方(左)=増加", () => {
    const scroll = { scrollLeft: 0, scrollTop: 0 };
    const line0 = lineAxisContentCoord(
      { left: 500, top: 0 },
      rect,
      scroll,
      true,
    );
    const line1 = lineAxisContentCoord(
      { left: 460, top: 0 },
      rect,
      scroll,
      true,
    );
    // 次の行 (より左) が大きい値 = resolveVerticalBias の "down" 規約に一致
    expect(line1).toBeGreaterThan(line0);
  });

  it("縦書き: Chromium の負方向 scrollLeft を跨いで安定", () => {
    // 前方へ d スクロールすると scrollLeft は -d、glyph の viewport x は +d。
    // content 座標は変わらない。
    const before = lineAxisContentCoord(
      { left: 500, top: 0 },
      rect,
      { scrollLeft: 0, scrollTop: 0 },
      true,
    );
    const after = lineAxisContentCoord(
      { left: 540, top: 0 },
      rect,
      { scrollLeft: -40, scrollTop: 0 },
      true,
    );
    expect(after).toBe(before);
  });
});
