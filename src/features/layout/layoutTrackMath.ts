import { slotSplitterPx } from "./layoutConstants";

/**
 * 主軸方向の比率を持つリサイズ可能なレイアウト要素。
 * サイド region の slot と center band の segment はどちらもこの形を満たし、
 * 比率計算ロジックを共有する。open / closed の判定は呼び出し側が
 * `isOpen` 述語として渡す（slot=activePanel、segment=editorOpen 込み）。
 */
export interface RatioItem {
  id: string;
  sizeRatio: number;
}

/** sizeRatio だけ差し替えた要素を返す。RatioItem 制約により T の形は保たれる。 */
function withSizeRatio<T extends RatioItem>(item: T, sizeRatio: number): T {
  return { ...item, sizeRatio } as T;
}

/**
 * open 要素が占有できる実効サイズ(px)。要素間の splitter / gap を差し引く。
 * gutterPx 既定は同一 region 内カード間の幅。
 */
export function getSlotLayoutBudget(
  openItemCount: number,
  layoutBudgetPx: number,
  gutterPx: number = slotSplitterPx(),
): number {
  if (openItemCount <= 0) return 0;
  const gutterTotal = Math.max(0, openItemCount - 1) * gutterPx;
  return Math.max(0, layoutBudgetPx - gutterTotal);
}

/** open 要素の sizeRatio を合計 1 に正規化する。closed 要素は不変。 */
export function normalizeOpenItemRatios<T extends RatioItem>(
  items: T[],
  isOpen: (item: T) => boolean,
): T[] {
  const open = items.filter(isOpen);
  if (open.length === 0) return items;

  const sum = open.reduce((acc, it) => acc + it.sizeRatio, 0);
  if (sum <= 0) return items;

  return items.map((item) =>
    isOpen(item) ? withSizeRatio(item, item.sizeRatio / sum) : item,
  );
}

/**
 * 開いていた要素を1つ取り除いた後、その比率を残りの open 要素へ按分する。
 * 取り除いた要素が closed だった場合や残りに open がない場合は何もしない。
 */
export function redistributeRatiosAfterRemoval<T extends RatioItem>(
  remaining: T[],
  removed: T,
  isOpen: (item: T) => boolean,
): T[] {
  if (!isOpen(removed)) return remaining;

  const openRemaining = remaining.filter(isOpen);
  if (openRemaining.length === 0) return remaining;

  const removedRatio = removed.sizeRatio;
  const openSum = openRemaining.reduce((sum, it) => sum + it.sizeRatio, 0);

  const updated =
    openSum <= 0
      ? remaining.map((it) => (isOpen(it) ? withSizeRatio(it, 1) : it))
      : remaining.map((it) =>
          isOpen(it)
            ? withSizeRatio(
                it,
                it.sizeRatio + removedRatio * (it.sizeRatio / openSum),
              )
            : it,
        );

  return normalizeOpenItemRatios(updated, isOpen);
}

/** open 要素の sizeRatio を layoutBudget 内の px に変換する。closed 要素は含めない。 */
export function getOpenItemPixelSizes<T extends RatioItem>(
  items: T[],
  isOpen: (item: T) => boolean,
  layoutBudgetPx: number,
): Map<string, number> {
  const open = items.filter(isOpen);
  const budget = getSlotLayoutBudget(open.length, layoutBudgetPx);
  const ratioSum = open.reduce((sum, it) => sum + it.sizeRatio, 0);

  const sizes = new Map<string, number>();
  for (const item of open) {
    sizes.set(item.id, ratioSum > 0 ? budget * (item.sizeRatio / ratioSum) : 0);
  }
  return sizes;
}

/**
 * 隣接2要素を pxA / pxB に固定し、残りの open 要素を現比率で按分し直して
 * sizeRatio(px) を書き戻す。最後に open 要素の比率を正規化する。
 */
export function applyAdjacentItemPixelSizes<T extends RatioItem>(
  items: T[],
  isOpen: (item: T) => boolean,
  idA: string,
  idB: string,
  pxA: number,
  pxB: number,
  layoutBudgetPx: number,
): T[] {
  const open = items.filter(isOpen);
  const budget = getSlotLayoutBudget(open.length, layoutBudgetPx);
  const others = open.filter((it) => it.id !== idA && it.id !== idB);
  const remainingBudget = Math.max(0, budget - pxA - pxB);
  const otherRatioSum = others.reduce((sum, it) => sum + it.sizeRatio, 0);

  const pixelSizes = new Map<string, number>();
  pixelSizes.set(idA, pxA);
  pixelSizes.set(idB, pxB);
  for (const item of others) {
    pixelSizes.set(
      item.id,
      otherRatioSum > 0
        ? remainingBudget * (item.sizeRatio / otherRatioSum)
        : 0,
    );
  }

  return normalizeOpenItemRatios(
    items.map((item) => {
      if (!isOpen(item)) return item;
      const px = pixelSizes.get(item.id);
      return px != null ? withSizeRatio(item, px) : item;
    }),
    isOpen,
  );
}
