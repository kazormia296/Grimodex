import { describe, it, expect } from "vitest";
import { renderRubyText } from "./rubyFormats";
import type { RubyStyle } from "./types";

const BASE = "漢字";
const ANNO = "かんじ";

/** Every RubyStyle must have an expected output — catches missing switch cases. */
const RUBY_STYLE_EXPECTED: Record<RubyStyle, string> = {
  html: "<ruby>漢字<rp>(</rp><rt>かんじ</rt><rp>)</rp></ruby>",
  parentheses: "漢字(かんじ)",
  aozora: "｜漢字《かんじ》",
  "aozora-auto": "漢字《かんじ》",
  "narou-parens": "|漢字(かんじ)",
  "hash-underscore": "#漢字__かんじ__#",
  "rb-bracket": "[[rb:漢字 > かんじ]]",
  mediawiki: "{{ruby|漢字|かんじ}}",
  wikiwiki: "&ruby(かんじ){漢字};",
  denden: "{漢字|かんじ}",
  "denden-chars": "{漢字|かんじ}",
  renpy: "\\r[漢字,かんじ]",
  "game-engine": "[ruby text=かんじ]漢字",
  base: "漢字",
};

describe("renderRubyText", () => {
  it.each(Object.entries(RUBY_STYLE_EXPECTED) as [RubyStyle, string][])(
    "%s",
    (style, expected) => {
      expect(renderRubyText(BASE, ANNO, style)).toBe(expected);
    },
  );

  describe("per-character formats", () => {
    it("denden-chars with equal lengths", () => {
      expect(renderRubyText("対象", "ルビ", "denden-chars")).toBe(
        "{対象|ル|ビ}",
      );
    });

    it("denden-chars falls back when lengths differ", () => {
      expect(renderRubyText(BASE, ANNO, "denden-chars")).toBe("{漢字|かんじ}");
    });

    it("game-engine with equal lengths", () => {
      expect(renderRubyText("対象", "ルビ", "game-engine")).toBe(
        "[ruby text=ル]対[ruby text=ビ]象",
      );
    });

    it("game-engine falls back when lengths differ", () => {
      expect(renderRubyText(BASE, ANNO, "game-engine")).toBe(
        "[ruby text=かんじ]漢字",
      );
    });
  });

  describe("edge cases", () => {
    it("preserves special characters in base and annotation", () => {
      expect(renderRubyText("卍♰", "マジ", "parentheses")).toBe("卍♰(マジ)");
    });

    it("handles single-character base", () => {
      expect(renderRubyText("漢", "かん", "aozora")).toBe("｜漢《かん》");
    });
  });
});
