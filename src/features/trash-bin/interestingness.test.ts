import { describe, it, expect } from "vitest";
import { isInterestingTextFragment } from "./interestingness";
import type { TrashSpan } from "./types";

const humanSpan = (text: string): TrashSpan => ({
  text,
  source: "human",
  model: null,
  chatMessageId: null,
  timestamp: null,
});

const aiSpan = (text: string): TrashSpan => ({
  text,
  source: "ai",
  model: "test-model",
  chatMessageId: null,
  timestamp: null,
});

describe("isInterestingTextFragment", () => {
  it("AI span が含まれていれば短くても true", () => {
    expect(isInterestingTextFragment("a", [aiSpan("a")])).toBe(true);
  });

  it("5 文字以上なら true", () => {
    expect(isInterestingTextFragment("hello", [humanSpan("hello")])).toBe(true);
  });

  it("4 文字未満かつ AI なし・記号なしなら false", () => {
    expect(isInterestingTextFragment("abc", [humanSpan("abc")])).toBe(false);
  });

  it("文学的記号を含めば短くても true", () => {
    expect(isInterestingTextFragment("ああ——", [humanSpan("ああ——")])).toBe(
      true,
    );
    expect(isInterestingTextFragment("、…", [humanSpan("、…")])).toBe(true);
    expect(isInterestingTextFragment("「」", [humanSpan("「」")])).toBe(true);
  });

  it("Unicode コードポイント数で判定 (サロゲートペア)", () => {
    // 「𠮷野家」= 4 コードポイント (𠮷 はサロゲートペア)
    expect(isInterestingTextFragment("𠮷野家", [humanSpan("𠮷野家")])).toBe(
      false,
    );
    expect(isInterestingTextFragment("𠮷野家家", [humanSpan("𠮷野家家")])).toBe(
      false,
    );
    expect(
      isInterestingTextFragment("𠮷野家家家", [humanSpan("𠮷野家家家")]),
    ).toBe(true);
  });

  it("空文字はキャプチャ条件にすらヒットしないが false を返す", () => {
    expect(isInterestingTextFragment("", [])).toBe(false);
  });
});
