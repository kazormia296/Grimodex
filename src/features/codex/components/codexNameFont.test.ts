import { describe, it, expect } from "vitest";
import { codexNameFontStyle } from "./codexNameFont";

describe("codexNameFontStyle", () => {
  it("英語プロジェクトは Heros を Bold・字間詰めで返す", () => {
    expect(codexNameFontStyle("en")).toEqual({
      fontFamily: '"TeX Gyre Heros", ui-sans-serif, system-ui, sans-serif',
      fontWeight: 700,
      letterSpacing: "-0.04em",
    });
  });

  it("地域サフィックス付き (en-US) でも英語スタイル (Bold)", () => {
    const s = codexNameFontStyle("en-US");
    expect(s.fontFamily).toContain('"TeX Gyre Heros"');
    expect(s.fontWeight).toBe(700);
  });

  it("日本語プロジェクトは駅名標フォントを通常ウェイト・広め字間で返す", () => {
    expect(codexNameFontStyle("ja")).toEqual({
      fontFamily: '"Toaru Eki Sign", ui-sans-serif, system-ui, sans-serif',
      fontWeight: 400,
      letterSpacing: "0.05em",
    });
  });

  it("未定義 (プロジェクト未選択) ・非英語はデフォルト (駅名標フォント)", () => {
    expect(codexNameFontStyle(undefined).fontFamily).toContain(
      '"Toaru Eki Sign"',
    );
    expect(codexNameFontStyle("fr").fontWeight).toBe(400);
  });

  it("計測 span と textarea の整合のため weight/letterSpacing も同時に返す", () => {
    const s = codexNameFontStyle("en");
    expect(s).toHaveProperty("fontWeight");
    expect(s).toHaveProperty("letterSpacing");
  });

  it("override 指定時は fontFamily を差し替え、weight/字間は言語別を維持する", () => {
    const s = codexNameFontStyle("ja", '"Noto Serif JP"');
    expect(s.fontFamily.startsWith('"Noto Serif JP"')).toBe(true);
    expect(s.fontFamily).toContain("sans-serif"); // フォールバックは必ず付く
    expect(s.fontWeight).toBe(400); // ja の weight はフォントと独立に据え置き
    expect(s.letterSpacing).toBe("0.05em");
  });

  it("en override でも weight/字間は英語の値 (Bold・詰め) を維持する", () => {
    const s = codexNameFontStyle("en", '"Noto Serif JP"');
    expect(s.fontFamily.startsWith('"Noto Serif JP"')).toBe(true);
    expect(s.fontWeight).toBe(700);
    expect(s.letterSpacing).toBe("-0.04em");
  });

  it("override が空文字/空白なら言語別デフォルトにフォールバックする", () => {
    expect(codexNameFontStyle("en", "").fontFamily).toContain(
      '"TeX Gyre Heros"',
    );
    expect(codexNameFontStyle("ja", "   ").fontFamily).toContain(
      '"Toaru Eki Sign"',
    );
  });
});
