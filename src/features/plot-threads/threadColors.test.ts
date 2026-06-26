import { describe, it, expect } from "vitest";
import { spreadThreadColors } from "./threadColors";

describe("spreadThreadColors", () => {
  it("returns exactly `count` colors", () => {
    expect(spreadThreadColors(0, 0, undefined, false)).toHaveLength(0);
    expect(spreadThreadColors(3, 0, undefined, false)).toHaveLength(3);
  });

  it("assigns a distinct palette color to each thread within a batch", () => {
    const colors = spreadThreadColors(8, 0, undefined, false);
    expect(new Set(colors).size).toBe(colors.length); // 全部バラける
  });

  it("offsets the rotation by the existing thread count", () => {
    // 既存 1 本ある状態の先頭色 = 既存 0 本の 2 番目の色（同じローテーション）。
    const fromZero = spreadThreadColors(2, 0, undefined, false);
    const fromOne = spreadThreadColors(2, 1, undefined, false);
    expect(fromOne[0]).toBe(fromZero[1]);
  });

  it("wraps around the palette when more threads than slots are imported", () => {
    // パレットは 10 色。11 本目は先頭色へ巻き戻る。
    const colors = spreadThreadColors(11, 0, undefined, false);
    expect(colors[10]).toBe(colors[0]);
  });

  it("returns hex foreground colors that the thread color picker also uses", () => {
    const [first] = spreadThreadColors(1, 0, undefined, false);
    expect(first).toMatch(/^#[0-9a-fA-F]{6}$/);
  });
});
