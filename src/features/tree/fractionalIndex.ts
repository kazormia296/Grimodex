import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

export { generateKeyBetween, generateNKeysBetween };

/** generateKeyBetween(null, null) の結果。新規ツリーの最初の要素で使う。 */
export const INITIAL_KEY = generateKeyBetween(null, null);

/**
 * fractional-indexing キーの辞書順比較関数。
 * base62 の ASCII 文字のみで構成されるため素の比較で安全。
 * `Array.prototype.sort` のコンパレータとして使える。
 */
export function cmpKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
