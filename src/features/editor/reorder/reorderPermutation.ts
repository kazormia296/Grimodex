import type { ReorderUnit } from "./types";

/**
 * ドラッグ中の unit 並べ替えを JS 側で追跡する純粋モデル。
 *
 * ドラッグ開始時に units0（スナップショット）を取り、以降は `order`
 * （slot → 元 index の写像）だけを動かす。実 doc へは 1 隣接 swap ずつ
 * dispatch するが、対象 unit の範囲は毎回「元 unit の長さを order 順に累積」
 * して再構成する（currentUnitsFromOrder）。これにより文節ドラッグ中に
 * 段落テキストが変わって bunsetsu cache が stale になっても、単位境界が
 * 途中で文粒度へ化けず安定する。
 */

/** 恒等 order [0..n)。 */
export function identityOrder(n: number): number[] {
  return Array.from({ length: n }, (_, i) => i);
}

/**
 * order（slot→元index）から、現在の flat text 上での unit 範囲を再構成する。
 * 現在の flat text は units0 の surface を order 順に連結したものと一致する
 * 前提（units は flat text を隙間なく分割する契約）。
 */
export function currentUnitsFromOrder(
  units0: ReorderUnit[],
  order: number[],
): ReorderUnit[] {
  let cursor = 0;
  const out: ReorderUnit[] = [];
  for (const idx of order) {
    const u = units0[idx]!;
    const len = u.to - u.from;
    out.push({ from: cursor, to: cursor + len, surface: u.surface });
    cursor += len;
  }
  return out;
}

/** flat offset が属する slot（現在配列上の index）。 */
export function slotAtFlatOffset(
  currentUnits: ReorderUnit[],
  flatOffset: number,
): number {
  for (let i = 0; i < currentUnits.length; i++) {
    const u = currentUnits[i]!;
    if (flatOffset >= u.from && flatOffset < u.to) return i;
  }
  return Math.max(0, currentUnits.length - 1);
}

/** order の隣接 2 slot を入れ替えた新しい order を返す（非破壊）。 */
export function swapSlots(order: number[], a: number, b: number): number[] {
  const next = order.slice();
  const tmp = next[a]!;
  next[a] = next[b]!;
  next[b] = tmp;
  return next;
}

/** 元 index が現在いる slot。 */
export function slotOfOriginal(order: number[], original: number): number {
  return order.indexOf(original);
}
