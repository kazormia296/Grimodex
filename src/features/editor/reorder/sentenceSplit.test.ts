import { describe, it, expect } from "vitest";
import {
  sentenceRangesJa,
  sentenceRangesEn,
  splitSentencesJa,
} from "./sentenceSplit";

describe("sentenceSplit JA", () => {
  it("読点でも文を分割する", () => {
    const text =
      "段落切替、段落内文、形態素解析による分節の入れ替えテストしています";
    const ranges = sentenceRangesJa(text);
    expect(ranges).toHaveLength(3);
    expect(text.slice(ranges[0]!.from, ranges[0]!.to)).toBe("段落切替、");
    expect(text.slice(ranges[1]!.from, ranges[1]!.to)).toBe("段落内文、");
    expect(text.slice(ranges[2]!.from, ranges[2]!.to)).toBe(
      "形態素解析による分節の入れ替えテストしています",
    );
  });

  it("括弧内の読点では分割しない", () => {
    const text = "「一つ、二つ、三つ」と言った。";
    const ranges = sentenceRangesJa(text);
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0]!.from, ranges[0]!.to)).toBe(text);
  });

  it("句読点で文を分割する", () => {
    const text = "彼女は立った。指先で石をなぞる。";
    const ranges = sentenceRangesJa(text);
    expect(ranges).toHaveLength(2);
    expect(text.slice(ranges[0]!.from, ranges[0]!.to)).toBe("彼女は立った。");
    expect(text.slice(ranges[1]!.from, ranges[1]!.to)).toBe(
      "指先で石をなぞる。",
    );
  });

  it("括弧内の句読点では分割しない", () => {
    const text = "「待て。まだだ。」と言った。";
    const ranges = sentenceRangesJa(text);
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0]!.from, ranges[0]!.to)).toBe(text);
  });

  it("閉じ括弧と連続終端記号を同じ文に含める", () => {
    const text = "本当か！？」";
    const ranges = sentenceRangesJa(text);
    expect(ranges).toHaveLength(1);
    expect(text.slice(ranges[0]!.from, ranges[0]!.to)).toBe("本当か！？」");
  });

  it("末尾句読点なしの trailing 文を含める", () => {
    const text = "一つ目。二つ目";
    const ranges = sentenceRangesJa(text);
    expect(ranges).toHaveLength(2);
    expect(text.slice(ranges[1]!.from, ranges[1]!.to)).toBe("二つ目");
  });

  it("空文字列は空配列", () => {
    expect(sentenceRangesJa("")).toEqual([]);
    expect(splitSentencesJa("")).toEqual([]);
  });

  it("絵文字を含んでも UTF-16 range が文字列 slice と一致する", () => {
    const text = "A🎉B。";
    const ranges = sentenceRangesJa(text);
    expect(ranges).toHaveLength(1);
    const slice = text.slice(ranges[0]!.from, ranges[0]!.to);
    expect(slice).toBe("A🎉B。");
    expect(slice.length).toBe(5); // A + surrogate pair + B + 。
  });
});

describe("sentenceSplit EN", () => {
  it("ピリオドで文を分割する", () => {
    const text = "Hello world. Next sentence.";
    const ranges = sentenceRangesEn(text);
    expect(ranges.length).toBeGreaterThanOrEqual(2);
    expect(text.slice(ranges[0]!.from, ranges[0]!.to)).toBe("Hello world.");
  });

  it("略語 Mr. では分割しない", () => {
    const text = "Mr. Smith arrived. He waved.";
    const ranges = sentenceRangesEn(text);
    expect(ranges).toHaveLength(2);
    expect(text.slice(ranges[0]!.from, ranges[0]!.to)).toBe(
      "Mr. Smith arrived.",
    );
  });
});
