/**
 * Codex 詳細パネルの名称欄 (CodexEntryHeader) の表示用フォントスタイル。
 *
 * 日本語プロジェクトは駅名標スタイルの "Toaru Eki Sign" を通常ウェイト・広めの
 * 字間で、英語プロジェクトは Helvetica 系の "TeX Gyre Heros" を Bold・やや詰めた
 * 字間で表示する。どちらも @font-face で同梱している (src/index.css)。駅名標
 * フォントは Latin グリフが目的の雰囲気に合わないため、英語時は同系統 (公共サインで
 * 定番の Helvetica クローン) の Heros に差し替える。
 *
 * 判定軸は UI 言語ではなくプロジェクト言語 (名前は作品の内容であり、editor-en-
 * typography と同じ流儀)。Heros は CJK グリフを持たないので、UI 言語で切り替えると
 * 日本語名がフォールバックして駅名標の雰囲気が壊れる。
 *
 * 重要: 名称欄は計測用 hidden span と可視 textarea の 2 surface で構成され、
 * useFitFontSize が前者の幅で採寸して後者のサイズを決める。fontFamily だけでなく
 * fontWeight と letterSpacing も字幅に効くため、両 surface で必ず同じ値を使うこと
 * (ずれると採寸とレンダリングが食い違いサイズが狂う)。そのためスタイル解決をこの
 * ヘルパに一元化し、まとめて返す。letterSpacing は font-size に比例追従させるため
 * px ではなく em で持つ (computeFitFontSize の線形スケール前提)。
 *
 * @param language プロジェクト言語 (`useCurrentProject()?.language`)。
 */
export interface CodexNameFontStyle {
  fontFamily: string;
  fontWeight: number;
  letterSpacing: string;
}

export function codexNameFontStyle(
  language: string | undefined,
): CodexNameFontStyle {
  if (language?.startsWith("en")) {
    return {
      fontFamily: '"TeX Gyre Heros", ui-sans-serif, system-ui, sans-serif',
      fontWeight: 700,
      letterSpacing: "-0.04em",
    };
  }
  return {
    fontFamily: '"Toaru Eki Sign", ui-sans-serif, system-ui, sans-serif',
    fontWeight: 400,
    letterSpacing: "0.05em",
  };
}
