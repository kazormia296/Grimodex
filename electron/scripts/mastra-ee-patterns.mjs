/**
 * Mastra の ee 由来のものを見分ける識別子（Mastra 移行 MP-1、脅威モデル D8／T8）。
 * bundle の検査（mastra-ee-check.mjs）と、配布物の asar の検査（packaged-smoke/package-check.mjs）が共有する。
 * 依存を持たない（esbuild などを読み込まない）。
 */

/**
 * ee 由来の input（metafile の相対 path、または asar の entry）。
 * `@mastra/<package>/dist` 配下で、`ee-<hash>.*` の chunk と `ee/` ディレクトリ以下の file。
 * 拡張子は問わない（.js／.cjs／.map／.d.ts）。
 */
export const EE_INPUT =
  /[\\/]@mastra[\\/][^\\/]+[\\/](?:dist[\\/])?(?:(?:[^\\/]+[\\/])*ee-[^\\/]+|(?:[^\\/]+[\\/])*ee[\\/][^\\/]+)$/;

/**
 * ee の実装にだけ現れる識別子。素の bundle の出力に在り、stub を当てた出力には無いことを見る。
 * （`license.mastra.ai` は ee の外の LicenseClient にも残るので使わない。）
 */
export const EE_CONTENT_MARKERS = Object.freeze([
  "captureEEEvent",
  "ee_feature_used",
  "ee_license_check",
  "eeTelemetryBridge",
]);
