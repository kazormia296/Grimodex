import { describe, it, expect } from "vitest";
import { codexNameFontFamily } from "./codexNameFont";

describe("codexNameFontFamily", () => {
  it("英語プロジェクトは Helvetica 系の TeX Gyre Heros を先頭に置く", () => {
    expect(codexNameFontFamily("en")).toBe(
      '"TeX Gyre Heros", ui-sans-serif, system-ui, sans-serif',
    );
  });

  it("地域サフィックス付き (en-US) でも TeX Gyre Heros にフォールバックしない", () => {
    expect(codexNameFontFamily("en-US")).toContain('"TeX Gyre Heros"');
  });

  it("日本語プロジェクトは駅名標スタイルの Toaru Eki Sign を先頭に置く", () => {
    expect(codexNameFontFamily("ja")).toBe(
      '"Toaru Eki Sign", ui-sans-serif, system-ui, sans-serif',
    );
  });

  it("未定義 (プロジェクト未選択) ・非英語はデフォルト (Toaru Eki Sign)", () => {
    expect(codexNameFontFamily(undefined)).toContain('"Toaru Eki Sign"');
    expect(codexNameFontFamily("fr")).toContain('"Toaru Eki Sign"');
  });
});
