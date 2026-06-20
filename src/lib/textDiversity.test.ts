import { describe, it, expect } from "vitest";
import {
  charBigrams,
  jaccard,
  meanPairwiseDistinctness,
} from "./textDiversity";

describe("charBigrams", () => {
  it("空白を無視して連続2文字の集合を作る", () => {
    expect(charBigrams("ab c")).toEqual(new Set(["ab", "bc"]));
  });
  it("1文字以下は空集合", () => {
    expect(charBigrams("a").size).toBe(0);
    expect(charBigrams("").size).toBe(0);
  });
});

describe("jaccard", () => {
  it("同一集合は1、互いに素は0", () => {
    expect(jaccard(new Set(["ab"]), new Set(["ab"]))).toBe(1);
    expect(jaccard(new Set(["ab"]), new Set(["cd"]))).toBe(0);
  });
  it("両方空は1(同一とみなす)", () => {
    expect(jaccard(new Set(), new Set())).toBe(1);
  });
});

describe("meanPairwiseDistinctness", () => {
  it("全て同一テキストなら 0", () => {
    expect(meanPairwiseDistinctness(["猫の話", "猫の話", "猫の話"])).toBe(0);
  });
  it("語彙が完全に重ならなければ 1 に近い", () => {
    const d = meanPairwiseDistinctness(["abcd", "wxyz"]);
    expect(d).toBe(1);
  });
  it("要素1個以下は 0", () => {
    expect(meanPairwiseDistinctness(["x"])).toBe(0);
    expect(meanPairwiseDistinctness([])).toBe(0);
  });
  it("多様な集合は似た集合より高い相違度になる", () => {
    const similar = meanPairwiseDistinctness([
      "少年が剣を取り魔王を倒す旅に出る",
      "少年が剣を取り魔王を倒す冒険に出る",
      "少年が剣を取り魔王を討つ旅に出る",
    ]);
    const diverse = meanPairwiseDistinctness([
      "錆びた灯台守が潮の記憶を売買する",
      "官僚機構が夢の課税を始めた都市",
      "双子の片割れだけが老いていく村",
    ]);
    expect(diverse).toBeGreaterThan(similar);
  });
});
