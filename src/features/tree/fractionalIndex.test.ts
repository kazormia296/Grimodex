import { describe, it, expect } from "vitest";
import { cmpKeys, generateKeyBetween, INITIAL_KEY } from "./fractionalIndex";

// 並び順の基盤となる fractional-index キー比較。grid/tree のソートで使われる割に未テストだった。
describe("cmpKeys", () => {
  it("辞書順で -1 / 1 / 0 を返す", () => {
    expect(cmpKeys("a0", "a1")).toBe(-1);
    expect(cmpKeys("a1", "a0")).toBe(1);
    expect(cmpKeys("a0", "a0")).toBe(0);
  });

  it("sort コンパレータとして fractional key を昇順に並べる", () => {
    const k1 = INITIAL_KEY;
    const k3 = generateKeyBetween(k1, null);
    const k2 = generateKeyBetween(k1, k3); // k1 < k2 < k3
    expect([k3, k1, k2].sort(cmpKeys)).toEqual([k1, k2, k3]);
  });
});
