/**
 * tateChuYokoPolicy.ts — 縦中横（tate-chu-yoko）の「どの数字 run を対象にするか」の
 * 純粋なポリシー判定。ProseMirror 依存を持たないので、エディタ装飾
 * （TateChuYokoPlugin）と エクスポート記法（exportEngine）の両方から共有する。
 *
 * - `off`  : 縦中横なし。
 * - `2`    : 2桁の数字 run のみ対象（出版物の慣習に最も近い既定）。
 * - `all`  : 2桁以上の数字 run をすべて対象（3〜4桁は流儀に幅があるため任意）。
 *
 * この length ポリシーを 1 箇所に集約することで、エディタの縦書きプレビューと
 * エクスポート時の縦中横記法が「同じ run を縦中横とみなす」契約を機械的に保つ。
 */
export type TateChuYokoPolicy = "off" | "2" | "all";

/** 半角数字の連続 run。`g` フラグ付きなので `matchAll` / `replace(/g)` で使う。 */
export const TATE_CHU_YOKO_DIGIT_RUN = /[0-9]+/g;

/** 1桁は縦中横の対象外（2文字以上）。policy により上限を変える。 */
export function runLengthAllowed(
  len: number,
  policy: TateChuYokoPolicy,
): boolean {
  if (len < 2) return false;
  if (policy === "2") return len === 2;
  return true; // "all"
}
