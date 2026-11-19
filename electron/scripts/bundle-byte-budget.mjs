/**
 * main.cjs と preload.cjs の大きさの ratchet（Mastra 移行 MP-3a、DR-MP3-21）。
 *
 * 目的：`@mastra/*`（core だけで約 13 MB）が main.cjs に混ざると、閉じた旗でも起動時の読込・parse の費用が出る
 * （計画書の第 4.3 節）。Mastra は 3 つ目の bundle（mastra-agent.cjs）にだけ入れる。その境界の回帰を、
 * 大きさでも捕まえる。`mastra-ee-check.mjs --dist` が、build の後に照合する。
 *
 * 値は「現在値＋小さな余裕」。増える方向の変更は、この数値を意図して上げる commit にする（黙って緩めない）。
 * 通常の main の変更（数 KB）は余裕に収まり、Mastra の混入（MB 単位）は必ず超える。
 * perf:budget（renderer の bundle）とは別の予算で、閾値を緩めるものではない。
 *
 * 基準の実測（MP-3a の変更後、esbuild 0.28.1、`node electron/scripts/build.mjs`）：
 *   main.cjs 3,070,561 bytes（MP-3a の前は 3,066,375）、preload.cjs 20,934 bytes。
 * mastra-agent.cjs は予算を持たず、記録だけにする（13,739,712 bytes。load 時間は MP-3c の観測）。
 */

/** 上限（bytes）。 */
export const BUNDLE_BYTE_BUDGET = Object.freeze({
  "main.cjs": 3_100_000,
  "preload.cjs": 22_000,
});

/**
 * `bytes` は `{ "main.cjs": number | null, ... }`。上限を超える、または file が無い（null）ものを失敗として返す。
 * 予算に無い file（mastra-agent.cjs）は見ない。
 */
export function bundleByteFailures(bytes, budget = BUNDLE_BYTE_BUDGET) {
  const failures = [];
  for (const [name, limit] of Object.entries(budget)) {
    const size = bytes[name];
    if (typeof size !== "number") {
      failures.push(`${name} の大きさを測れない（byte の予算を照合できない）`);
    } else if (size > limit) {
      failures.push(
        `${name} が byte の予算を超えた: ${size} > ${limit}（@mastra が混ざっていないか確認する。増える変更なら予算を意図して上げる）`,
      );
    }
  }
  return failures;
}
