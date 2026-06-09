import { describe, expect, it } from "vitest";
import { computeFitFontSize } from "./useFitFontSize";

const OPTS = { base: 50, min: 24 };

describe("computeFitFontSize", () => {
  it("要件1: 収まるなら base のまま縮小しない (広いパネル)", () => {
    expect(computeFitFontSize(200, 400, OPTS)).toBe(50);
  });

  it("ちょうど収まる境界も base", () => {
    expect(computeFitFontSize(400, 400, OPTS)).toBe(50);
  });

  it("要件2: はみ出すが下限以上 → 線形に縮小 (単一行 tier)", () => {
    // base 50 を 400/500 倍 → 40px。min(24) < 40 < base(50)。
    expect(computeFitFontSize(500, 400, OPTS)).toBe(40);
  });

  it("整数 px に丸める (サブピクセルの揺れ防止)", () => {
    // 50 * 300 / 450 = 33.33... → floor 33
    expect(computeFitFontSize(450, 300, OPTS)).toBe(33);
  });

  it("要件3: 大幅超過 → 下限でクランプ (ここで折り返しに入る)", () => {
    // 50 * 100 / 1000 = 5 → max(24, 5) = 24
    expect(computeFitFontSize(1000, 100, OPTS)).toBe(24);
  });

  it("計測前 (avail=0) は base を返す", () => {
    expect(computeFitFontSize(500, 0, OPTS)).toBe(50);
  });

  it("空文字 (measureWidth=0) は base を返す", () => {
    expect(computeFitFontSize(0, 400, OPTS)).toBe(50);
  });
});
