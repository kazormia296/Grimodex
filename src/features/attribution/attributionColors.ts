/**
 * 帰属(authorship: human / ai / unknown)カラーの正本。
 *
 * ライブ UI は CSS 変数 `--attribution-{human,ai,unknown}` を参照する。用途で2系統:
 *   - 本文オーバーレイ（.attribution-* クラス）は `color-mix(... var(--content-
 *     background))` で淡くブレンドし、各カラーテーマの紙色に追従する。
 *   - 統計内訳バー・footer 凡例スウォッチ・AI% バッジは単色トークン
 *     （`var(--attribution-*)` / `text-attribution-ai` 等の Tailwind utility）を
 *     そのまま「色キー」として使う（opacity 設定やテーマに依らず色相が読める）。
 * トークン値は **色相を固定（human=220° / ai=165° / unknown=30°）したまま**、
 * カラーテーマ×light/dark ごとに明度・彩度を調整して上書きされる
 * （colorThemes.ts の `THEME_CSS_VARS` + 各テーマ palette、`applyTheme()` 適用）。
 * dark テーマでは暗い紙色に対し 20% 混色でも埋もれないよう明るめ・高彩度にする。
 * index.css の `:root`(light) / `.dark`(dark) は初回描画・unknown テーマ時の fallback。
 *
 * `ATTRIBUTION_COLORS` の literal 値は CSS 変数を使えない箇所
 * （SVG 書き出し `exportReport.ts`、canvas timelapse のフォールバック）専用で、
 * 既定テーマ(simple light)の色＝index.css `:root` と一致させる
 * （attributionColors.test.ts がドリフトを検出する）。
 */
export const ATTRIBUTION_COLORS = {
  human: "oklch(0.65 0.1 220)",
  ai: "oklch(0.72 0.2 165)",
  unknown: "oklch(0.72 0.14 30)",
} as const;

/** ライブ UI 用。inline style / CSS から参照するテーマ追従トークン。 */
export const ATTRIBUTION_COLOR_VARS = {
  human: "var(--attribution-human)",
  ai: "var(--attribution-ai)",
  unknown: "var(--attribution-unknown)",
} as const;

export type AttributionSource = keyof typeof ATTRIBUTION_COLORS;
