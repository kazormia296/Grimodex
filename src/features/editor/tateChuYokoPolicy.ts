/**
 * tateChuYokoPolicy.ts — 縦中横（tate-chu-yoko）の「どの run を対象にするか」の
 * 純粋なポリシー判定。ProseMirror 依存を持たないので、エディタ装飾
 * （TateChuYokoPlugin）と エクスポート記法（exportEngine）の両方から共有する。
 *
 * 対象になる run は次の 4 種類:
 *  1. 半角数字の連続（従来から）。length ポリシー（off/2/all）で対象幅を変える。
 *  2. 感嘆符・疑問符クラスタ（！？ ？！ ！！ ？？ など。全角・半角混在も可）。
 *  3. Unicode ローマ数字（Ⅰ..ⅿ、U+2160..U+217F）。
 *  4. ASCII ローマ数字 I/V/X（II, III, IV, VII, XII …）。単語境界に挟まれた 2 文字以上の
 *     厳密形のみ（章番号などの実用域 1..39）。英字に隣接する run（LIVE の IV 等）や
 *     L/C/D/M を含む語（XL, CD, MIX）は誤結合を避けるため対象外。
 *
 * length ポリシー（off/2/all）は数字 run にのみ効く:
 *  - `off`  : 縦中横なし（全種類を対象外にする）。
 *  - `2`    : 2桁の数字 run のみ対象（出版物の慣習に最も近い既定）。
 *  - `all`  : 2桁以上の数字 run をすべて対象。
 * 記号クラスタ / ローマ数字は「桁数」の概念が無いため policy が `off` 以外なら常に対象。
 *
 * この契約を 1 箇所に集約することで、エディタの縦書きプレビューと
 * エクスポート時の縦中横記法が「同じ run を縦中横とみなす」ことを機械的に保つ。
 */
export type TateChuYokoPolicy = "off" | "2" | "all";

/**
 * 縦中横の候補 run（グローバルフラグ付き。`matchAll` / `replace(/g)` で使う）。
 * 交替の各分岐は互いに素な文字集合なので順序に依存しない:
 *  - `[0-9]+`            半角数字
 *  - `[！？!?]{2,}`      感嘆符・疑問符クラスタ（2文字以上）
 *  - `[Ⅰ-ⅿ]+`  Unicode ローマ数字
 *  - `(?<![A-Za-z])[IVX]{2,}(?![A-Za-z])`  ASCII ローマ数字（I/V/X のみ・前後が英字でない
 *    単語境界に限る＝ LIVE/DIVE の IV や VIP の VI を誤結合しない）
 *
 * 実際に縦中横とみなすかは {@link tateChuYokoRunAllowed} が run の内容で最終判定する
 * （候補にヒットしても対象外＝素通しになる run がある）。
 */
export const TATE_CHU_YOKO_RUN =
  /[0-9]+|[！？!?]{2,}|[Ⅰ-ⅿ]+|(?<![A-Za-z])[IVX]{2,}(?![A-Za-z])/g;

/**
 * 後方互換のための半角数字 run 単体。既存の直接 import 用に残す。
 * 現在は {@link TATE_CHU_YOKO_RUN} が上位集合。
 */
export const TATE_CHU_YOKO_DIGIT_RUN = /[0-9]+/g;

/** 厳密なローマ数字の並び（I/V/X 運用なので実質 1..39）。空文字にもマッチするので
 *  長さは別途担保する。IIII / VIV のような非正規形を弾く。 */
const STRICT_ASCII_ROMAN =
  /^M{0,4}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3})$/;

/** 1桁は縦中横の対象外（2文字以上）。policy により上限を変える（数字 run 専用）。 */
export function runLengthAllowed(
  len: number,
  policy: TateChuYokoPolicy,
): boolean {
  if (len < 2) return false;
  if (policy === "2") return len === 2;
  return true; // "all"
}

/**
 * 候補 run（{@link TATE_CHU_YOKO_RUN} のヒット）を縦中横対象にするかを内容で判定する。
 * 数字は length ポリシーに従い、記号クラスタ / ローマ数字は policy が off 以外なら対象。
 * ASCII ローマ数字は I/V/X のみ＋単語境界（regex 側で担保）＋厳密形で、英単語（LIVE の IV,
 * XL, CD, MIX 等）の誤結合を避ける。
 */
export function tateChuYokoRunAllowed(
  run: string,
  policy: TateChuYokoPolicy,
): boolean {
  if (policy === "off") return false;
  // 半角数字: 従来どおり length ポリシー。
  if (/^[0-9]+$/.test(run)) return runLengthAllowed(run.length, policy);
  // 感嘆符・疑問符クラスタ（！？ ？！ ！！ など）: 2文字以上を常に結合。
  if (/^[！？!?]+$/.test(run)) return run.length >= 2;
  // Unicode ローマ数字（U+2160..U+217F、Ⅰ..ⅿ）: 専用コードポイントなので誤検出が無く常に対象。
  if (/^[Ⅰ-ⅿ]+$/.test(run)) return true;
  // ASCII ローマ数字（I/V/X）: 厳密な形かつ 2 文字以上のみ。単語境界は regex 側で担保済み。
  if (/^[IVX]+$/.test(run))
    return run.length >= 2 && STRICT_ASCII_ROMAN.test(run);
  return false;
}
