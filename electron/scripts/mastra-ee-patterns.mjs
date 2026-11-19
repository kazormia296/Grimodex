/**
 * Mastra の ee 由来のものを見分ける識別子（Mastra 移行 MP-1、脅威モデル D8／T8）。
 * bundle の検査（mastra-ee-check.mjs）と、配布物の asar の検査（packaged-smoke/package-check.mjs）が共有する。
 * 依存を持たない（esbuild などを読み込まない）。
 */

/**
 * ee 由来の input（metafile の相対 path、または asar の entry）。
 * `@mastra/<package>` 配下で、`ee-<hash>.*` の chunk と、`ee/` ディレクトリ以下の file（深さを問わない）。
 * 拡張子は問わない（.js／.cjs／.map／.d.ts）。
 */
export const EE_INPUT =
  /[\\/]@mastra[\\/][^\\/]+[\\/](?:.*[\\/])?(?:ee-[^\\/]+|ee[\\/].+)$/;

/**
 * ee の実装にだけ現れる文字列。素の bundle の出力に在り、stub を当てた出力には無いことを見る。
 * 実物の `auth/ee`（権限の定義と telemetry bridge）にだけあり、ee の外の Apache-2.0 の部分
 * （`src/telemetry/posthog.ts` が持つ `captureEEEvent`、`ee_feature_used`、`ee_license_check`）には無い文字列を選ぶ。
 * 外の部分は bundle の `.map` の sourcesContent に入りうるので、ここに入れると誤って不合格になる。
 * （`license.mastra.ai` も ee の外の LicenseClient に残るので使わない。）
 */
export const EE_CONTENT_MARKERS = Object.freeze([
  "mastra.eeTelemetryBridge",
  "stored-mcp-clients:publish",
  "stored-prompt-blocks:publish",
  "agent-builder:execute",
]);
