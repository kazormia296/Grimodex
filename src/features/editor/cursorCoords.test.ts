import { describe, it, expect } from "vitest";
import {
  adjacentColumnPoint,
  caretBox,
  lineAxisContentCoord,
  toContainerRelative,
  resolveCoords,
  resolveCoordsVertical,
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
describe("adjacentColumnPoint", () => {
  // vertical-rl: 次の列 (読み進み方向) は左 = x が減る、前の列は右 = x が増える。
  // インライン位置 y は列を跨いでも保持される。
  it("next (次の列) は centerX から pitch ぶん左へ、y は据え置き", () => {
    expect(adjacentColumnPoint(100, 42, 30, "next")).toEqual({
      left: 70,
      top: 42,
    });
  });

  it("prev (前の列) は centerX から pitch ぶん右へ、y は据え置き", () => {
    expect(adjacentColumnPoint(100, 42, 30, "prev")).toEqual({
      left: 130,
      top: 42,
    });
  });

  it("next と prev は centerX を挟んで対称", () => {
    const next = adjacentColumnPoint(200, 10, 25, "next");
    const prev = adjacentColumnPoint(200, 10, 25, "prev");
    expect(next.left).toBe(175);
    expect(prev.left).toBe(225);
    expect((next.left + prev.left) / 2).toBe(200);
  });
});

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

// ---------------------------------------------------------------------------
// resolveCoordsVertical (縦書きキャレットの DOM Range 再構成)
// ---------------------------------------------------------------------------

/** charRects[i] = i 文字目の ClientRect を返す fake Text ノード */
function makeFakeText(
  charRects: Array<{
    left: number;
    right: number;
    top: number;
    bottom: number;
  }>,
) {
  let start = 0;
  const node = {
    nodeType: 3,
    data: "あ".repeat(charRects.length),
    parentElement: {
      getBoundingClientRect: () => ({
        left: 0,
        right: 24,
        top: 0,
        bottom: 400,
        width: 24,
        height: 400,
      }),
    },
    ownerDocument: {
      createRange: () => ({
        setStart: (_n: unknown, i: number) => {
          start = i;
        },
        setEnd: () => {},
        getBoundingClientRect: () => {
          const r = charRects[start];
          return {
            ...r,
            width: r.right - r.left,
            height: r.bottom - r.top,
          };
        },
      }),
    },
  };
  return node;
}

function makeVerticalView(node: unknown, offset: number): EditorView {
  return { domAtPos: () => ({ node, offset }) } as unknown as EditorView;
}

describe("resolveCoordsVertical", () => {
  // 縦書きの 1 文字 = 列幅 24px・文字送り 24px の正方形セル
  const char0 = { left: 400, right: 424, top: 100, bottom: 124 };
  const char1 = { left: 400, right: 424, top: 124, bottom: 148 };

  it("bias=1: 直後の文字の上端に列幅の平たい矩形を返す", () => {
    const view = makeVerticalView(makeFakeText([char0, char1]), 1);
    expect(resolveCoordsVertical(view, 5, 1)).toEqual({
      left: 400,
      right: 424,
      top: 124,
      bottom: 124,
    });
  });

  it("bias=-1: 直前の文字の下端に返す", () => {
    const view = makeVerticalView(makeFakeText([char0, char1]), 1);
    expect(resolveCoordsVertical(view, 5, -1)).toEqual({
      left: 400,
      right: 424,
      top: 124,
      bottom: 124,
    });
  });

  it("段落末 (直後の文字なし) は直前の文字の下端で代替する", () => {
    const view = makeVerticalView(makeFakeText([char0, char1]), 2);
    expect(resolveCoordsVertical(view, 5, 1)).toEqual({
      left: 400,
      right: 424,
      top: 148,
      bottom: 148,
    });
  });

  it("caretBox に渡すと列幅の横棒になる", () => {
    const view = makeVerticalView(makeFakeText([char0, char1]), 0);
    const coords = resolveCoordsVertical(view, 5, 1)!;
    expect(caretBox(coords, { left: 0, top: 0 }, true)).toEqual({
      left: 400,
      top: 100,
      width: 24,
      height: 2,
    });
  });

  it("domAtPos が throw したら null (呼び出し側でフォールバック)", () => {
    const view = {
      domAtPos: () => {
        throw new Error("atom");
      },
    } as unknown as EditorView;
    expect(resolveCoordsVertical(view, 5, 1)).toBeNull();
  });
});

describe("resolveCoordsVertical — 段落末 (要素 + 子インデックス)", () => {
  const char0 = { left: 400, right: 424, top: 100, bottom: 124 };
  const char1 = { left: 400, right: 424, top: 124, bottom: 148 };

  it("折り返しテキスト全体ではなく最終文字の rect を使う (段落全幅キャレットの回帰)", () => {
    // End キーで段落末に移動すると domAtPos は {要素, offset=子数} を返す。
    // 直前の子 = 複数列に折り返した text ノードの全体 rect を使うと
    // キャレットが段落全幅の横棒になる (実機報告)。端の 1 文字まで掘る。
    const text = makeFakeText([char0, char1]);
    const para = {
      nodeType: 1,
      childNodes: [text],
      getBoundingClientRect: () => ({
        left: 376,
        right: 424,
        top: 100,
        bottom: 400,
        width: 48,
        height: 300,
      }),
    };
    const view = makeVerticalView(para, 1);
    expect(resolveCoordsVertical(view, 5, -1)).toEqual({
      left: 400,
      right: 424,
      top: 148,
      bottom: 148,
    });
  });

  it("空段落は自身の列 rect の上端に出す", () => {
    const para = {
      nodeType: 1,
      childNodes: [],
      getBoundingClientRect: () => ({
        left: 400,
        right: 424,
        top: 100,
        bottom: 400,
        width: 24,
        height: 300,
      }),
    };
    const view = makeVerticalView(para, 0);
    expect(resolveCoordsVertical(view, 5, 1)).toEqual({
      left: 400,
      right: 424,
      top: 100,
      bottom: 100,
    });
  });
});

describe("resolveCoordsVertical — mark span 包み (authorship 等)", () => {
  const char0 = { left: 400, right: 424, top: 100, bottom: 124 };
  const char1 = { left: 400, right: 424, top: 124, bottom: 148 };
  const fullParaRect = {
    left: 376,
    right: 424,
    top: 100,
    bottom: 400,
    width: 48,
    height: 300,
  };

  function makeSpan(children: unknown[], rect = fullParaRect) {
    return {
      nodeType: 1,
      tagName: "SPAN",
      getAttribute: () => null,
      childNodes: children,
      getBoundingClientRect: () => rect,
    };
  }

  it("End (段落末): span の全幅 rect ではなく中の最終文字まで掘る", () => {
    // 本文は authorship mark の span に包まれている。折り返した span の
    // getBoundingClientRect は段落全幅 → そのまま使うと巨大キャレット
    // (実機報告: 最終行 End で段落全体の下部に表示)。
    const span = makeSpan([makeFakeText([char0, char1])]);
    const para = {
      nodeType: 1,
      childNodes: [span],
      getBoundingClientRect: () => fullParaRect,
    };
    const view = makeVerticalView(para, 1);
    expect(resolveCoordsVertical(view, 5, -1)).toEqual({
      left: 400,
      right: 424,
      top: 148,
      bottom: 148,
    });
  });

  it("Home (段落頭): span の中の先頭文字まで掘る", () => {
    const span = makeSpan([makeFakeText([char0, char1])]);
    const para = {
      nodeType: 1,
      childNodes: [span],
      getBoundingClientRect: () => fullParaRect,
    };
    const view = makeVerticalView(para, 0);
    expect(resolveCoordsVertical(view, 5, 1)).toEqual({
      left: 400,
      right: 424,
      top: 100,
      bottom: 100,
    });
  });

  it("ネストした span も端の文字まで再帰する", () => {
    const inner = makeSpan([makeFakeText([char0, char1])]);
    const outer = makeSpan([inner]);
    const para = {
      nodeType: 1,
      childNodes: [outer],
      getBoundingClientRect: () => fullParaRect,
    };
    const view = makeVerticalView(para, 1);
    expect(resolveCoordsVertical(view, 5, -1)!.top).toBe(148);
  });

  it("ruby は rt へ掘らず自身の 1 セル rect を使う", () => {
    const rubyRect = {
      left: 400,
      right: 424,
      top: 100,
      bottom: 148,
      width: 24,
      height: 48,
    };
    const ruby = {
      nodeType: 1,
      tagName: "RUBY",
      getAttribute: () => null,
      // rt の注釈 text (掘ってしまうと半分サイズの間違った rect になる)
      childNodes: [
        makeFakeText([{ left: 424, right: 436, top: 100, bottom: 112 }]),
      ],
      getBoundingClientRect: () => rubyRect,
    };
    const para = {
      nodeType: 1,
      childNodes: [ruby],
      getBoundingClientRect: () => fullParaRect,
    };
    const view = makeVerticalView(para, 1);
    expect(resolveCoordsVertical(view, 5, -1)).toEqual({
      left: 400,
      right: 424,
      top: 148,
      bottom: 148,
    });
  });

  it("contenteditable=false の atom (mention) も自身の rect を使う", () => {
    const cellRect = {
      left: 400,
      right: 424,
      top: 100,
      bottom: 172,
      width: 24,
      height: 72,
    };
    const mention = {
      nodeType: 1,
      tagName: "SPAN",
      getAttribute: (name: string) =>
        name === "contenteditable" ? "false" : null,
      childNodes: [makeFakeText([{ left: 0, right: 1, top: 0, bottom: 1 }])],
      getBoundingClientRect: () => cellRect,
    };
    const para = {
      nodeType: 1,
      childNodes: [mention],
      getBoundingClientRect: () => fullParaRect,
    };
    const view = makeVerticalView(para, 1);
    expect(resolveCoordsVertical(view, 5, -1)!.top).toBe(172);
  });
});
