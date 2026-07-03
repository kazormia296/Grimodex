/** Cursor coordinate types and pure helpers extracted for testability. */

import type { EditorView } from "@tiptap/pm/view";

export type Coords = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

/**
 * Convert viewport-relative coordinates to container-relative pixel offsets.
 *
 * Returns `{ left, top, height }` ready to assign to `el.style.*`.
 */
export function toContainerRelative(
  coords: Coords,
  containerRect: { left: number; top: number },
): { left: number; top: number; height: number } {
  return {
    left: coords.left - containerRect.left,
    top: coords.top - containerRect.top,
    height: coords.bottom - coords.top,
  };
}

/**
 * coordsAtPos のキャレット矩形 → overlay div の box。
 * 横書き: 縦棒 (width=thickness, height=行高)。
 * 縦書き (vertical-rl): coordsAtPos は文字幅ぶんの水平な矩形を返すので
 * 横棒 (width=文字幅, height=thickness)。
 */
export function caretBox(
  coords: Coords,
  containerRect: { left: number; top: number },
  vertical: boolean,
  thickness = 2,
): { left: number; top: number; width: number; height: number } {
  const left = coords.left - containerRect.left;
  const top = coords.top - containerRect.top;
  if (vertical) {
    return {
      left,
      top,
      width: Math.max(coords.right - coords.left, thickness),
      height: thickness,
    };
  }
  return {
    left,
    top,
    width: thickness,
    height: Math.max(coords.bottom - coords.top, thickness),
  };
}

/**
 * 行スタック軸の content 座標 (読み進み方向が正になるよう正規化)。
 * 横書き: 行は下に積まれる → y (top 基準 + scrollTop 補正)。
 * 縦書き (vertical-rl): 行は左に積まれる → x を負号で反転
 * (scrollLeft は Chromium の 0 起点・負方向規約: content 座標 =
 * viewportX - rect.left + scrollLeft、を反転して前方=増加に揃える)。
 * resolveVerticalBias の "down=前方" 規約にそのまま流せる。
 */
export function lineAxisContentCoord(
  coords: { left: number; top: number },
  containerRect: { left: number; top: number },
  scroll: { scrollLeft: number; scrollTop: number },
  vertical: boolean,
): number {
  return vertical
    ? -(coords.left - containerRect.left + scroll.scrollLeft)
    : coords.top - containerRect.top + scroll.scrollTop;
}

/**
 * Resolve bias at a soft-wrap boundary after ArrowUp/Down by comparing
 * the two candidate Y positions against the previous cursor Y.
 *
 * Returns -1 (line-end side) or 1 (line-start side), or null if the
 * position is not at a wrap boundary (callers should keep current bias).
 */
export function resolveVerticalBias(
  endTop: number,
  startTop: number,
  prevTop: number,
  direction: "up" | "down",
): -1 | 1 | null {
  if (Math.abs(endTop - startTop) <= 2) return null; // not a wrap boundary

  if (direction === "up") {
    const endAbove = endTop < prevTop - 1;
    const startAbove = startTop < prevTop - 1;
    if (endAbove && startAbove) {
      return endTop > startTop ? -1 : 1; // closer to prevTop
    }
    if (endAbove) return -1;
    if (startAbove) return 1;
    // Neither candidate moved above prevTop — preserve current visual position.
    return 1;
  }

  // direction === "down"
  const endBelow = endTop > prevTop + 1;
  const startBelow = startTop > prevTop + 1;
  if (endBelow && startBelow) {
    return endTop < startTop ? -1 : 1; // closer to prevTop
  }
  if (endBelow) return -1;
  if (startBelow) return 1;
  // Neither candidate moved below prevTop — preserve current visual position.
  return -1;
}

/**
 * Resolve cursor coordinates for the given ProseMirror position.
 *
 * `bias` controls which visual side of a soft-wrap boundary to use:
 *   -1 = line-end side  (End key, Backspace)
 *    1 = line-start side (Home, ArrowLeft, ArrowRight, typing)
 *
 * At non-wrap positions both sides produce identical coordinates, so
 * the bias value has no visible effect there.
 */
export function resolveCoords(
  view: EditorView,
  from: number,
  bias: -1 | 1,
): Coords | null {
  try {
    return view.coordsAtPos(from, bias);
  } catch {
    return null;
  }
}

/**
 * 縦書き (vertical-rl) の列移動 (ArrowLeft/ArrowRight) 用の目標点。
 *
 * `centerX` = 現在キャレットが属する列の中心 x、`y` = インライン位置
 * (列を跨いでも保持する)、`pitch` = 列ピッチ (= computed line-height の px、
 * = 隣接列の中心間距離)。`dir` は読み進み基準:
 *   "next" = 次の列 (vertical-rl では左)、"prev" = 前の列 (右)。
 * 返り値を `view.posAtCoords` に渡すと隣接列の同じインライン位置の pos が取れる。
 */
export function adjacentColumnPoint(
  centerX: number,
  y: number,
  pitch: number,
  dir: "next" | "prev",
): { left: number; top: number } {
  return { left: dir === "next" ? centerX - pitch : centerX + pitch, top: y };
}

/**
 * 縦書き (vertical-rl) 用のキャレット座標リゾルバ。
 *
 * prosemirror-view の coordsAtPos は flattenV (横書き前提) で矩形を
 * 「left=right のゼロ幅縦線」に潰すため、縦書きでは列幅もインライン位置も
 * 失われる (そのまま描くと 2×2 の点になる)。ここでは DOM Range から隣接
 * 文字の素の ClientRect を取り、
 *   - x 範囲 = 文字列 (列) の幅 = キャレット横棒の長さ
 *   - y      = 挿入点 (bias=1 は直後文字の上端、-1 は直前文字の下端)
 * の平たい矩形 (top=bottom=y) を再構成する。caretBox(vertical) にそのまま
 * 渡せる形。失敗時は null (呼び出し側で flatten 版へフォールバック)。
 */
export function resolveCoordsVertical(
  view: EditorView,
  pos: number,
  bias: -1 | 1,
): Coords | null {
  try {
    const { node, offset } = view.domAtPos(pos);

    const flat = (
      r: { left: number; right: number; top: number; bottom: number },
      edge: "top" | "bottom",
    ): Coords => {
      const y = edge === "top" ? r.top : r.bottom;
      return { left: r.left, right: r.right, top: y, bottom: y };
    };
    const usable = (r: { width: number; height: number }) =>
      r.width > 0 || r.height > 0;

    const charRectOf = (text: Text, i: number): DOMRect | null => {
      if (i < 0 || i >= text.data.length) return null;
      const range = text.ownerDocument!.createRange();
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const r = range.getBoundingClientRect();
      return usable(r) ? r : null;
    };

    if (node.nodeType === 3) {
      const text = node as Text;
      // bias=1 (行頭側) = 直後の文字の inline-start (top)。
      // bias=-1 (行末側) = 直前の文字の inline-end (bottom)。
      // 端 (段落頭/末) は反対側の文字で代替する。
      const after = () => {
        const r = charRectOf(text, offset);
        return r ? flat(r, "top") : null;
      };
      const before = () => {
        const r = charRectOf(text, offset - 1);
        return r ? flat(r, "bottom") : null;
      };
      const c = bias >= 0 ? (after() ?? before()) : (before() ?? after());
      if (c) return c;
      const parent = text.parentElement;
      return parent ? flat(parent.getBoundingClientRect(), "top") : null;
    }

    if (node.nodeType === 1) {
      const el = node as Element;
      // 子ノードの「端の 1 文字ぶん」の rect。複数列に折り返した inline
      // (text そのもの・mark/decoration の span 等) の全体 rect は段落全幅に
      // 広がるため、そのまま使うとキャレットが段落全体に伸びる (段落端で
      // domAtPos が要素 + 子インデックスを返すケース = Home/End で実害)。
      // 本文 text は authorship/コメント等の mark span に包まれているのが
      // 常態なので、span は端の子へ再帰して 1 文字まで掘る。
      // ruby (rt へ掘ると注釈側の rect になる) と contenteditable=false の
      // atom (mention NodeView 等) は 1 セルなので自身の rect を使う。
      const boundaryRect = (n: Node, side: "start" | "end"): DOMRect | null => {
        if (n.nodeType === 3) {
          const t = n as Text;
          if (t.data.length === 0) return null;
          return charRectOf(t, side === "start" ? 0 : t.data.length - 1);
        }
        if (n.nodeType === 1) {
          const el = n as Element;
          const isAtomCell =
            el.tagName === "RUBY" ||
            el.getAttribute?.("contenteditable") === "false";
          if (!isAtomCell) {
            const kids = el.childNodes;
            for (let i = 0; i < kids.length; i++) {
              const k = side === "start" ? kids[i] : kids[kids.length - 1 - i];
              const r = boundaryRect(k, side);
              if (r) return r;
            }
          }
          const r = el.getBoundingClientRect();
          return usable(r) ? r : null;
        }
        return null;
      };
      const beforeNode = offset > 0 ? el.childNodes[offset - 1] : null;
      const afterNode =
        offset < el.childNodes.length ? el.childNodes[offset] : null;
      const after = () => {
        const r = afterNode ? boundaryRect(afterNode, "start") : null;
        return r ? flat(r, "top") : null;
      };
      const before = () => {
        const r = beforeNode ? boundaryRect(beforeNode, "end") : null;
        return r ? flat(r, "bottom") : null;
      };
      const c = bias >= 0 ? (after() ?? before()) : (before() ?? after());
      if (c) return c;
      // 子が無い (空段落) / 子の rect が取れない (<br> 等): 自身の列 rect
      return flat(el.getBoundingClientRect(), "top");
    }

    return null;
  } catch {
    return null;
  }
}
