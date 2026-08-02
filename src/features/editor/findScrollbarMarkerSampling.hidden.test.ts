// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectFindMatchRects } from "./findScrollbarMarkerSampling";

function rect(top: number): DOMRect {
  return {
    top,
    right: 80,
    bottom: top + 1,
    left: 20,
    width: 60,
    height: 1,
    x: 20,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function buildDecorations(count: number, hiddenIndex = -1) {
  const owner = document.createElement("div");
  let geometryReads = 0;
  for (let index = 0; index < count; index++) {
    const decoration = document.createElement("span");
    decoration.className = index === 0 ? "find-current" : "find-match";
    decoration.getClientRects = () => {
      geometryReads++;
      if (index === hiddenIndex) return [] as unknown as DOMRectList;
      return [rect(index * 2)] as unknown as DOMRectList;
    };
    decoration.getBoundingClientRect = () =>
      index === hiddenIndex ? rect(0) : rect(index * 2);
    if (index === hiddenIndex) {
      decoration.getBoundingClientRect = () => new DOMRect(0, 0, 0, 0);
    }
    owner.append(decoration);
  }
  return {
    decorations: owner.querySelectorAll<HTMLElement>(
      ".find-match, .find-current",
    ),
    geometryReads: () => geometryReads,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collectFindMatchRects hidden-result sampling", () => {
  it("continues exploring both sides of a hidden midpoint", () => {
    const { decorations, geometryReads } = buildDecorations(500, 249);

    const results = collectFindMatchRects({
      decorations,
      maximumGeometryReads: 51,
      getTrackPixel: (value) => Math.round(value.top / 10),
    });

    expect(geometryReads()).toBeLessThanOrEqual(51);
    expect(results.length).toBeGreaterThan(10);
    expect(results.some((value) => value.rect.top > 200)).toBe(true);
    expect(results.some((value) => value.rect.top > 700)).toBe(true);
  });

  it("does not repeatedly sort the full pending interval collection", () => {
    const { decorations } = buildDecorations(20_000);
    const sort = vi.spyOn(Array.prototype, "sort");

    collectFindMatchRects({
      decorations,
      maximumGeometryReads: 700,
      getTrackPixel: (value) => Math.round(value.top / 40),
    });

    // One final document-order sort is allowed; interval priority must use a
    // logarithmic queue instead of sorting every pending interval repeatedly.
    expect(sort).toHaveBeenCalledTimes(1);
  });
});
