import { describe, expect, it } from "vitest";
import {
  detectReorder,
  flipOffsets,
  flipOffsetsContinuous,
} from "./chronicleLaneAnim";

const tops = (entries: [string, number][]) => new Map(entries);

describe("detectReorder", () => {
  const prevTops = tops([
    ["a", 0],
    ["b", 50],
    ["c", 100],
  ]);

  it("同一集合で順序が変われば true（並べ替え）", () => {
    expect(detectReorder(["a", "b", "c"], ["b", "a", "c"], prevTops)).toBe(
      true,
    );
  });

  it("順序不変（高さだけ変化）は false", () => {
    expect(detectReorder(["a", "b", "c"], ["a", "b", "c"], prevTops)).toBe(
      false,
    );
  });

  it("集合が変わる（レーン増減）は false", () => {
    expect(detectReorder(["a", "b", "c"], ["a", "b"], prevTops)).toBe(false);
    expect(detectReorder(["a", "b"], ["a", "b", "d"], prevTops)).toBe(false);
  });

  it("初回（prev 空）は false", () => {
    expect(detectReorder([], ["a", "b"], new Map())).toBe(false);
  });
});

describe("flipOffsets", () => {
  it("旧 top − 新 top を返し、移動したキーのみ含む", () => {
    const prev = tops([
      ["a", 0],
      ["b", 50],
    ]);
    const cur = tops([
      ["a", 50],
      ["b", 0],
    ]);
    const off = flipOffsets(prev, cur);
    expect(off.get("a")).toBe(-50); // 0 - 50
    expect(off.get("b")).toBe(50); // 50 - 0
  });

  it("ほぼ動かないキー(<0.5px)は省く", () => {
    const prev = tops([
      ["a", 0],
      ["b", 50.2],
    ]);
    const cur = tops([
      ["a", 30],
      ["b", 50],
    ]);
    const off = flipOffsets(prev, cur);
    expect(off.has("a")).toBe(true);
    expect(off.has("b")).toBe(false);
  });

  it("新規キー（prev に無い）はオフセット無し", () => {
    const off = flipOffsets(
      tops([["a", 0]]),
      tops([
        ["a", 0],
        ["z", 80],
      ]),
    );
    expect(off.has("z")).toBe(false);
  });
});

describe("flipOffsetsContinuous", () => {
  const prev = tops([
    ["a", 0],
    ["b", 50],
  ]);
  const cur = tops([
    ["a", 50],
    ["b", 0],
  ]);

  it("active が空なら flipOffsets と同じ", () => {
    const off = flipOffsetsContinuous(prev, cur, new Map());
    expect(off.get("a")).toBe(-50);
    expect(off.get("b")).toBe(50);
  });

  it("進行中残差を足して視覚位置から連続させる", () => {
    // a は半分(残差 -25)まで進行 → 新基準 (0-50) + (-25) = -75 から開始。
    const active = tops([
      ["a", -25],
      ["b", 25],
    ]);
    const off = flipOffsetsContinuous(prev, cur, active);
    expect(off.get("a")).toBe(-75); // (0-50) + (-25)
    expect(off.get("b")).toBe(75); // (50-0) + 25
  });

  it("残差が相殺して微小ならキーを省く", () => {
    // b: (50-50)=0 + 残差 0.2 → <0.5 で省く。
    const off = flipOffsetsContinuous(
      tops([
        ["a", 0],
        ["b", 50],
      ]),
      tops([
        ["a", 40],
        ["b", 50],
      ]),
      tops([["b", 0.2]]),
    );
    expect(off.has("a")).toBe(true);
    expect(off.has("b")).toBe(false);
  });
});
