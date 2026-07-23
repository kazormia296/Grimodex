import { describe, expect, it } from "vitest";
import {
  calculateZenContrastGuardLayout,
  contrastTargetRatio,
} from "./zenContrastGuard";

const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

describe("Zen dynamic contrast guard", () => {
  it("maps the visible paper column into bottom-left WebGL coordinates", () => {
    const layout = calculateZenContrastGuardLayout(
      rect(100, 50, 1_000, 800),
      rect(300, 100, 600, 800),
      48,
    );

    expect(layout.rect).toEqual([0.2, 0, 0.8, 0.9375]);
    expect(layout.feather[0]).toBeCloseTo(0.048);
    expect(layout.feather[1]).toBe(0);
    expect(layout.feather[2]).toBeCloseTo(0.048);
    expect(layout.feather[3]).toBeCloseTo(0.06);
  });

  it("disables the mask when the paper does not intersect the shader surface", () => {
    expect(
      calculateZenContrastGuardLayout(
        rect(0, 0, 1_000, 800),
        rect(1_100, 0, 600, 800),
      ),
    ).toEqual({
      rect: [0, 0, 0, 0],
      feather: [0, 0, 0, 0],
    });
  });

  it("keeps full protection inside the column and fits each outer fade into the surrounding space", () => {
    const layout = calculateZenContrastGuardLayout(
      rect(0, 0, 1_000, 800),
      rect(10, 10, 980, 780),
      48,
    );

    expect(layout.rect[0]).toBeCloseTo(0.01);
    expect(layout.rect[1]).toBeCloseTo(0.0125);
    expect(layout.rect[2]).toBeCloseTo(0.99);
    expect(layout.rect[3]).toBeCloseTo(0.9875);
    expect(layout.feather[0]).toBeCloseTo(0.01);
    expect(layout.feather[1]).toBeCloseTo(0.0125);
    expect(layout.feather[2]).toBeCloseTo(0.01);
    expect(layout.feather[3]).toBeCloseTo(0.0125);
  });

  it("maps protection strength from WCAG AA to an enhanced 7:1 target", () => {
    expect(contrastTargetRatio(-1)).toBe(4.5);
    expect(contrastTargetRatio(0)).toBe(4.5);
    expect(contrastTargetRatio(0.5)).toBe(5.75);
    expect(contrastTargetRatio(1)).toBe(7);
    expect(contrastTargetRatio(3)).toBe(7);
  });
});
