import { describe, it, expect } from "vitest";
import { getCharClass, isValidBoundary } from "./charClassBoundary";

describe("getCharClass", () => {
  it("classifies hiragana", () => {
    expect(getCharClass("あ")).toBe("hiragana");
    expect(getCharClass("は")).toBe("hiragana");
    expect(getCharClass("ん")).toBe("hiragana");
  });

  it("classifies katakana", () => {
    expect(getCharClass("ア")).toBe("katakana");
    expect(getCharClass("ラ")).toBe("katakana");
    expect(getCharClass("ン")).toBe("katakana");
  });

  it("classifies kanji", () => {
    expect(getCharClass("太")).toBe("kanji");
    expect(getCharClass("郎")).toBe("kanji");
    expect(getCharClass("森")).toBe("kanji");
  });

  it("classifies latin", () => {
    expect(getCharClass("A")).toBe("latin");
    expect(getCharClass("z")).toBe("latin");
    expect(getCharClass("e")).toBe("latin");
  });

  it("classifies digits", () => {
    expect(getCharClass("0")).toBe("digit");
    expect(getCharClass("9")).toBe("digit");
  });

  it("classifies other (punctuation, space, etc.)", () => {
    expect(getCharClass("。")).toBe("other");
    expect(getCharClass(" ")).toBe("other");
    expect(getCharClass("、")).toBe("other");
    expect(getCharClass(".")).toBe("other");
  });
});

describe("isValidBoundary", () => {
  it("returns true at start of text", () => {
    // start=0: no char before
    expect(isValidBoundary("太郎は走った", 0, 2)).toBe(true);
  });

  it("returns true at end of text", () => {
    // 「走った」末尾: no char after
    expect(isValidBoundary("彼は太郎", 2, 4)).toBe(true);
  });

  it("returns true for katakana→hiragana boundary (エララ + が)", () => {
    // "エララが" — エ(katakana) → が(hiragana): valid
    expect(isValidBoundary("エララが", 0, 3)).toBe(true);
  });

  it("returns false for katakana→katakana boundary (エララン)", () => {
    // "エララン" — ン(katakana) after エ(katakana): invalid
    expect(isValidBoundary("エララン", 0, 3)).toBe(false);
  });

  it("returns true for kanji→hiragana boundary", () => {
    // "太郎は" — 郎(kanji) → は(hiragana): valid
    expect(isValidBoundary("太郎は", 0, 2)).toBe(true);
  });

  it("returns true for 2+ kanji pattern with kanji left boundary (山田太郎)", () => {
    // "太郎" (2 chars) — 田(kanji) before 太: 2+ char exception → valid
    expect(isValidBoundary("山田太郎", 2, 4)).toBe(true);
  });

  it("returns false for 1-char kanji pattern with kanji left boundary", () => {
    // "太" (1 char) — 田(kanji) before 太: strict → invalid
    expect(isValidBoundary("山田太郎", 2, 3)).toBe(false);
  });

  it("returns true for 2+ kanji pattern with kanji right boundary (佐藤上等兵)", () => {
    // "佐藤" (2 chars) — 藤(kanji) followed by 上(kanji): 2+ char exception → valid
    expect(isValidBoundary("佐藤上等兵", 0, 2)).toBe(true);
  });

  it("returns false for 1-char kanji pattern with kanji right boundary", () => {
    // "藤" (1 char) — 藤(kanji) followed by 上(kanji): strict → invalid
    expect(isValidBoundary("佐藤上等兵", 1, 2)).toBe(false);
  });

  it("returns true for 2+ kanji pattern with kanji on both sides (女王様)", () => {
    // "王様" (2 chars) in "女王様" — 女(kanji) before 王, no char after → valid
    expect(isValidBoundary("女王様", 1, 3)).toBe(true);
  });

  it("returns true for latin word boundary (word space)", () => {
    // "Alice went" — space before A, space after e
    expect(isValidBoundary("Alice went", 0, 5)).toBe(true);
  });

  it("returns false for latin inside another word (Malice)", () => {
    // "Malice" — 'M'(latin) before 'A': invalid for "Alice" starting at pos 1
    expect(isValidBoundary("Malice", 1, 6)).toBe(false);
  });

  it("returns true for CJK surrounded by punctuation", () => {
    // "「太郎」は" — 「(other) before 太(kanji): valid
    expect(isValidBoundary("「太郎」は", 1, 3)).toBe(true);
  });

  it("returns true for hiragana-ending name followed by hiragana particle", () => {
    // "見習いが走った" — "い"(hiragana) + "が"(hiragana) → skip right check → valid
    expect(isValidBoundary("見習いが走った", 0, 3)).toBe(true);
  });

  it("returns true for hiragana-only name followed by hiragana particle", () => {
    // "まどかが来た" — starts at text boundary, ends hiragana before particle
    expect(isValidBoundary("まどかが来た", 0, 3)).toBe(true);
  });
});
