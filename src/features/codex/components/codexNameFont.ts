/**
 * Codex 詳細パネルの名称欄 (CodexEntryHeader) の表示用フォントスタック。
 *
 * 日本語プロジェクトは駅名標スタイルの "Toaru Eki Sign"、英語プロジェクトは
 * Helvetica 系の "TeX Gyre Heros" を使う。どちらも @font-face で同梱している
 * (src/index.css)。駅名標フォントは Latin グリフが目的の雰囲気に合わないため、
 * 英語時は同系統 (公共サインで定番の Helvetica クローン) の Heros に差し替える。
 *
 * 判定軸は UI 言語ではなくプロジェクト言語 (名前は作品の内容であり、editor-en-
 * typography と同じ流儀)。Heros は CJK グリフを持たないので、UI 言語で切り替えると
 * 日本語名がフォールバックして駅名標の雰囲気が壊れる。
 *
 * 重要: 名称欄は計測用 hidden span と可視 textarea の 2 surface で構成され、
 * useFitFontSize が前者のフォントで採寸して後者のサイズを決める。両 surface で
 * 必ず同じ値を使うこと (ずれると採寸とレンダリングのフォントが食い違いサイズが
 * 狂う)。そのため font 解決をこのヘルパに一元化している。
 *
 * @param language プロジェクト言語 (`useCurrentProject()?.language`)。
 */
export function codexNameFontFamily(language: string | undefined): string {
  return language?.startsWith("en")
    ? '"TeX Gyre Heros", ui-sans-serif, system-ui, sans-serif'
    : '"Toaru Eki Sign", ui-sans-serif, system-ui, sans-serif';
}
