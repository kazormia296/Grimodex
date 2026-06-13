import { describe, it, expect } from "vitest";
import {
  countUnitLabelKey,
  countWords,
  manuscriptPages,
  primaryCountUnit,
  readingMinutes,
} from "./charCountStats";

describe("primaryCountUnit", () => {
  it("uses words for English-family project languages", () => {
    expect(primaryCountUnit("en")).toBe("word");
    expect(primaryCountUnit("en-US")).toBe("word");
  });

  it("uses chars for ja / other / legacy (undefined)", () => {
    expect(primaryCountUnit("ja")).toBe("char");
    expect(primaryCountUnit("zh")).toBe("char");
    expect(primaryCountUnit("ko")).toBe("char");
    expect(primaryCountUnit(undefined)).toBe("char");
    expect(primaryCountUnit(null)).toBe("char");
  });
});

describe("countUnitLabelKey", () => {
  it("maps unit to the shared i18n unit-noun key", () => {
    expect(countUnitLabelKey("word")).toBe("common.unitWords");
    expect(countUnitLabelKey("char")).toBe("common.unitChars");
  });
});

describe("manuscriptPages", () => {
  it("ja/default: 400-char genkō yōshi", () => {
    expect(manuscriptPages(800)).toBe(2);
    expect(manuscriptPages(800, "ja")).toBe(2);
  });

  it("en: ~250-word standard manuscript page", () => {
    expect(manuscriptPages(500, "en")).toBe(2);
    expect(manuscriptPages(250, "en-US")).toBe(1);
  });
});

describe("readingMinutes", () => {
  it("ja/default: ~500 cpm", () => {
    expect(readingMinutes(1000)).toBe(2);
    expect(readingMinutes(1000, "ja")).toBe(2);
  });

  it("en: ~225 wpm", () => {
    expect(readingMinutes(450, "en")).toBe(2);
  });

  it("returns 0 for empty and rounds up to at least 1 for any content", () => {
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(0, "en")).toBe(0);
    expect(readingMinutes(10, "en")).toBe(1);
    expect(readingMinutes(10, "ja")).toBe(1);
  });
});

describe("countWords", () => {
  it("en: whitespace split, does not break on decimals/abbreviations", () => {
    expect(countWords("hello   world  foo", "en")).toBe(3);
    expect(countWords("Mr. Smith went home", "en")).toBe(4);
    expect(countWords("pi is 3.14 today", "en")).toBe(4);
    expect(countWords("a well-funded plan", "en")).toBe(3);
  });

  it("ja/default: legacy clause-like split on whitespace + CJK punctuation", () => {
    expect(countWords("今日は。明日も。")).toBe(2);
    // lang undefined on Latin text falls back to the legacy splitter
    // (splits on commas/periods too) — preserves prior behavior.
    expect(countWords("3.14")).toBe(2);
  });

  it("empty / whitespace-only is 0 in any language", () => {
    expect(countWords("", "en")).toBe(0);
    expect(countWords("   ", "en")).toBe(0);
    expect(countWords("", "ja")).toBe(0);
  });
});
