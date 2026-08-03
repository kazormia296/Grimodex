import { describe, it, expect } from "vitest";
import { VIVLIOSTYLE_THEMES, VIVLIOSTYLE_THEME_IDS } from "./themes";

// ────────────────────────────────────────────────────────────────────
// 同梱組版テーマ CSS。値の細部は Vivliostyle 側の解釈に委ねるが、
// 各テーマが最低限持つべき組版宣言（@page / writing-mode / 記法 class）を
// 構造レベルで固定する。
// ────────────────────────────────────────────────────────────────────

describe("VIVLIOSTYLE_THEMES — レジストリ構造", () => {
  it("3 テーマ（文庫縦/新書縦/A4横）を宣言順で持つ", () => {
    expect(VIVLIOSTYLE_THEME_IDS).toEqual([
      "bunko-vertical",
      "shinsho-vertical",
      "a4-horizontal",
    ]);
  });

  it("各テーマは labelKey と非空の css を持つ", () => {
    for (const id of VIVLIOSTYLE_THEME_IDS) {
      const theme = VIVLIOSTYLE_THEMES[id];
      expect(theme.labelKey).toMatch(/^vivliostyle\.theme\./);
      expect(theme.css.length).toBeGreaterThan(0);
    }
  });
});

describe("VIVLIOSTYLE_THEMES — 組版宣言", () => {
  it.each(VIVLIOSTYLE_THEME_IDS)(
    "%s: @page size と margin を宣言する",
    (id) => {
      const css = VIVLIOSTYLE_THEMES[id].css;
      expect(css).toMatch(/@page\s*\{[^}]*size:/s);
      expect(css).toMatch(/@page\s*\{[^}]*margin/s);
    },
  );

  it("縦書きテーマは vertical-rl、横書きテーマは宣言なし（既定 horizontal）", () => {
    expect(VIVLIOSTYLE_THEMES["bunko-vertical"].css).toContain("vertical-rl");
    expect(VIVLIOSTYLE_THEMES["shinsho-vertical"].css).toContain("vertical-rl");
    expect(VIVLIOSTYLE_THEMES["a4-horizontal"].css).not.toContain(
      "vertical-rl",
    );
  });

  it.each(VIVLIOSTYLE_THEME_IDS)(
    "%s: 記法 class（.tcy / .emphasis-dots / .scene-break / p.blank / rt）を備える",
    (id) => {
      const css = VIVLIOSTYLE_THEMES[id].css;
      expect(css).toMatch(/\.tcy\s*\{[^}]*text-combine-upright:\s*all/s);
      expect(css).toMatch(/\.emphasis-dots\s*\{[^}]*text-emphasis/s);
      expect(css).toContain(".scene-break");
      expect(css).toContain("p.blank");
      expect(css).toMatch(/rt\s*\{/);
    },
  );

  it.each(VIVLIOSTYLE_THEME_IDS)(
    "%s: 見出しで改ページする（break-before: page）",
    (id) => {
      const css = VIVLIOSTYLE_THEMES[id].css;
      expect(css).toMatch(/break-before:\s*page/);
    },
  );

  it.each(["bunko-vertical", "shinsho-vertical"] as const)(
    "%s: 柱の作品タイトルは本文の縦書きから独立して横書きにする",
    (id) => {
      const css = VIVLIOSTYLE_THEMES[id].css;
      expect(css).toMatch(
        /@top-center\s*\{[^}]*writing-mode:\s*horizontal-tb;[^}]*text-orientation:\s*mixed;[^}]*white-space:\s*nowrap;/s,
      );
    },
  );

  it.each(VIVLIOSTYLE_THEME_IDS)(
    "%s: フォントは明朝系フォールバック（同梱フォントに依存しない）",
    (id) => {
      const css = VIVLIOSTYLE_THEMES[id].css;
      expect(css).toContain("serif");
      expect(css).not.toContain("@font-face");
    },
  );
});
