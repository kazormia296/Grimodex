/**
 * RRF の定数 k。順位 r のスコア寄与は 1/(k+r)。情報検索の慣例値 60。
 * `semanticRecall.ts` から切り出した（MP-4b PR-3b-2）。codexHybridSearch が定数のためだけに
 * semanticRecall（embedding・DB を引く）を import していたのを断つ。`semanticRecall.ts` は再エクスポートする。
 */
export const RRF_K = 60;
