// ────────────────────────────────────────────────────────────────────
// Vivliostyle 同梱組版テーマ。
//
// buildVivliostyleHtml が出す HTML（実 <p> / .tcy / .emphasis-dots /
// .scene-break / p.blank / <ruby>）を前提に、@page とテーマ別の
// writing-mode・判型を宣言する。フォントは同梱せずユーザー環境の
// 明朝系フォールバックに委ねる（ライセンス・サイズの責務を持たない）。
//
// 罠: 論理プロパティ（block-size / margin-block）を使うこと。縦書き
// （vertical-rl）では height/margin-top が視覚軸とずれるため、物理
// プロパティだと横書きテーマと挙動が割れる。
// ────────────────────────────────────────────────────────────────────

export type VivliostyleThemeId =
  | "bunko-vertical"
  | "shinsho-vertical"
  | "a4-horizontal";

export interface VivliostyleTheme {
  /** i18n キー（vivliostyle.theme.*） */
  labelKey: string;
  /** theme.css の中身（完全な CSS 文字列） */
  css: string;
}

/**
 * 全テーマ共通の本文組版。
 *
 * - `p { margin: 0 } / p.paragraph-indent { text-indent: 1em }` — 明示された小説段落だけ字下げ
 * - `p.blank` — 連続空行由来の空段落。whitespace-only は潰れるため
 *   `block-size` で 1 行分の高さを保証する
 * - 見出し（章）は改ページ。ただし先頭見出しは空白ページを作らないよう除外
 * - `@top-center { content: env(doc-title) }` — <title> を柱に流用
 */
const COMMON_CSS = `\
html {
  font-family: "游明朝", "YuMincho", "Hiragino Mincho ProN", "Noto Serif JP", serif;
  line-height: 1.8;
}

p {
  margin: 0;
}

p.paragraph-indent {
  text-indent: 1em;
}

p.blank {
  min-block-size: 1.8em;
}

h1, h2, h3 {
  break-before: page;
  font-weight: 600;
  margin-block: 0 2em;
}

body > h1:first-child,
body > h2:first-child,
body > h3:first-child {
  break-before: auto;
}

.scene-break {
  text-align: center;
  text-indent: 0;
  margin-block: 1.8em;
}

.tcy {
  text-combine-upright: all;
}

.emphasis-dots {
  text-emphasis: filled sesame;
  -webkit-text-emphasis: filled sesame;
}

rt {
  font-size: 0.5em;
}
`;

function pageCss(size: string, margin: string): string {
  return `\
@page {
  size: ${size};
  margin: ${margin};
  @top-center {
    content: env(doc-title);
    font-size: 0.75em;
    writing-mode: horizontal-tb;
    text-orientation: mixed;
    white-space: nowrap;
  }
  @bottom-center {
    content: counter(page);
    font-size: 0.75em;
  }
}
`;
}

const VERTICAL_CSS = `\
html {
  writing-mode: vertical-rl;
  text-orientation: mixed;
}
`;

export const VIVLIOSTYLE_THEMES: Record<VivliostyleThemeId, VivliostyleTheme> =
  {
    "bunko-vertical": {
      labelKey: "vivliostyle.theme.bunkoVertical",
      css:
        pageCss("105mm 148mm", "14mm 11mm") +
        "\n" +
        VERTICAL_CSS +
        "\nhtml { font-size: 9pt; }\n\n" +
        COMMON_CSS,
    },
    "shinsho-vertical": {
      labelKey: "vivliostyle.theme.shinshoVertical",
      css:
        pageCss("106mm 173mm", "16mm 12mm") +
        "\n" +
        VERTICAL_CSS +
        "\nhtml { font-size: 9.5pt; }\n\n" +
        COMMON_CSS,
    },
    "a4-horizontal": {
      labelKey: "vivliostyle.theme.a4Horizontal",
      css:
        pageCss("A4", "25mm 22mm") +
        "\nhtml { font-size: 10.5pt; }\n\n" +
        COMMON_CSS,
    },
  };

/** 宣言順のテーマ ID（UI の表示順）。 */
export const VIVLIOSTYLE_THEME_IDS = Object.keys(
  VIVLIOSTYLE_THEMES,
) as VivliostyleThemeId[];
