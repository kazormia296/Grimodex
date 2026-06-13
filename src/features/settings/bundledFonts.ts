import type { BundledFont } from "./buildFontOptions";

/**
 * アプリに同梱しているフォント。main.tsx で fontsource 経由 (@font-face) を
 * import 済みのものだけをここに列挙する（webview で確実に解決される）。
 *
 * 本文ピッカー(editor.fontFamily)・UI ピッカー(display.uiFontFamily) の両方の
 * 「同梱フォント」グループに表示される。どちらの用途でも選択可能。
 */
export const BUNDLED_FONTS: BundledFont[] = [
  { family: "Noto Serif JP" }, // 本文デフォルト (明朝)
  { family: "M PLUS 1" }, // UI デフォルト (ゴシック)
  { family: "LINE Seed JP" }, // 追加の UI 向け選択肢 (デフォルトではない)
  { family: "Noto Sans JP" }, // 追加のゴシック選択肢 (デフォルトではない)
  { family: "Literata" }, // 英語本文デフォルト (serif, latin+italic)
];
