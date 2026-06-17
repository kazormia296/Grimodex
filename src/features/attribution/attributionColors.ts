/**
 * 帰属(authorship: human / ai / unknown)カラーの正本。
 *
 * ライブ UI は CSS 変数 `--attribution-{human,ai,unknown}` を参照する（index.css
 * の `:root` で定義）。用途で2系統に分かれる:
 *   - 本文オーバーレイ（.attribution-* クラス）は `color-mix(... var(--content-
 *     background))` で淡くブレンドし、各カラーテーマの紙色に追従する。
 *   - 統計内訳バー・footer 凡例スウォッチ・AI% バッジは単色トークン
 *     （`var(--attribution-*)` / `text-attribution-ai` 等の Tailwind utility）を
 *     そのまま「色キー」として使う（opacity 設定やテーマに依らず色相が読める）。
 * 将来テーマごとに色相を変えたい場合は colorThemes.ts の `THEME_CSS_VARS` に
 * 追加して各テーマで上書きすればよい（この正本はそのデフォルトになる）。
 *
 * `ATTRIBUTION_COLORS` の literal 値は CSS 変数を使えない箇所
 * （SVG 書き出し `exportReport.ts`、canvas timelapse のフォールバック）専用。
 * **index.css の `--attribution-*` トークン値と必ず一致させること
 * （attributionColors.test.ts がドリフトを検出する）。**
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
