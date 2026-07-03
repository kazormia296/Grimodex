// @vitest-environment happy-dom
//
// caretSlideStyle の純関数テスト。gate しているのは
//   - snappiness=50 (既定) が従来カーブ cubic-bezier(0.22, 1, 0.36, 1) と
//     一致すること（設定を触らないユーザーの体感を変えない）
//   - 0/100 で単調にカーブが変わり、100 側は y1>1 のオーバーシュートになること
//   - 範囲外入力のクランプ
//   - applyCaretSlideVars が CSS 変数 2 つを root に書くこと
import { describe, it, expect } from "vitest";
import {
  CARET_SLIDE_DURATION_DEFAULT,
  CARET_SLIDE_SNAPPINESS_DEFAULT,
  caretSlideEasing,
  applyCaretSlideVars,
} from "./caretSlideStyle";

describe("caretSlideEasing", () => {
  it("既定値 (50) は従来カーブと一致する", () => {
    expect(CARET_SLIDE_SNAPPINESS_DEFAULT).toBe(50);
    expect(caretSlideEasing(50)).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
  });

  it("0 は穏やかな ease-out、100 はオーバーシュート (y1 > 1)", () => {
    const parse = (s: string) =>
      s
        .replace("cubic-bezier(", "")
        .replace(")", "")
        .split(",")
        .map((v) => parseFloat(v));
    const [x1lo, y1lo] = parse(caretSlideEasing(0));
    const [x1hi, y1hi] = parse(caretSlideEasing(100));
    expect(y1lo).toBeLessThan(1);
    expect(y1hi).toBeGreaterThan(1);
    expect(x1hi).toBeLessThan(x1lo); // 大きいほど立ち上がりが速い
  });

  it("範囲外はクランプされる", () => {
    expect(caretSlideEasing(-20)).toBe(caretSlideEasing(0));
    expect(caretSlideEasing(999)).toBe(caretSlideEasing(100));
  });
});

describe("applyCaretSlideVars", () => {
  it("CSS 変数 --caret-slide-duration / --caret-slide-easing を書く", () => {
    const root = document.createElement("div");
    applyCaretSlideVars(120, 50, root);
    expect(root.style.getPropertyValue("--caret-slide-duration")).toBe("120ms");
    expect(root.style.getPropertyValue("--caret-slide-easing")).toBe(
      "cubic-bezier(0.22, 1, 0.36, 1)",
    );
  });

  it("duration は 40–200ms にクランプされる (負値で transition が silent 無効化されるのを防ぐ)", () => {
    const root = document.createElement("div");
    applyCaretSlideVars(-50, 50, root);
    expect(root.style.getPropertyValue("--caret-slide-duration")).toBe("40ms");
    applyCaretSlideVars(9999, 50, root);
    expect(root.style.getPropertyValue("--caret-slide-duration")).toBe("200ms");
  });

  it("root 省略時は documentElement に書く", () => {
    applyCaretSlideVars(CARET_SLIDE_DURATION_DEFAULT, 80);
    expect(
      document.documentElement.style.getPropertyValue("--caret-slide-duration"),
    ).toBe("80ms");
    document.documentElement.style.removeProperty("--caret-slide-duration");
    document.documentElement.style.removeProperty("--caret-slide-easing");
  });
});
