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
