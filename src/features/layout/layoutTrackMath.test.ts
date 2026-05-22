import { describe, it, expect } from "vitest";
import {
  type RatioItem,
  getSlotLayoutBudget,
  normalizeOpenItemRatios,
  redistributeRatiosAfterRemoval,
  getOpenItemPixelSizes,
  applyAdjacentItemPixelSizes,
} from "./layoutTrackMath";

interface TrackItem extends RatioItem {
  open: boolean;
}

const isOpen = (item: TrackItem): boolean => item.open;

function track(id: string, sizeRatio: number, open: boolean): TrackItem {
  return { id, sizeRatio, open };
}

function openSum(items: TrackItem[]): number {
  return items.filter(isOpen).reduce((sum, it) => sum + it.sizeRatio, 0);
}

describe("getSlotLayoutBudget", () => {
  it("subtracts inter-item gutters from the budget", () => {
    expect(getSlotLayoutBudget(3, 1000, 10)).toBe(1000 - 2 * 10);
  });

  it("uses no gutter for a single item", () => {
    expect(getSlotLayoutBudget(1, 500, 10)).toBe(500);
  });

  it("returns 0 when there are no open items", () => {
    expect(getSlotLayoutBudget(0, 1000, 10)).toBe(0);
  });

  it("never returns a negative budget", () => {
    expect(getSlotLayoutBudget(5, 10, 100)).toBe(0);
  });
});

describe("normalizeOpenItemRatios", () => {
  it("normalizes open item ratios to sum to 1", () => {
    const items = [
      track("a", 2, true),
      track("b", 1, true),
      track("c", 1, true),
    ];
    const result = normalizeOpenItemRatios(items, isOpen);
    expect(openSum(result)).toBeCloseTo(1);
    expect(result[0].sizeRatio).toBeCloseTo(0.5);
  });

  it("leaves closed items untouched", () => {
    const items = [track("a", 3, true), track("b", 99, false)];
    const result = normalizeOpenItemRatios(items, isOpen);
    expect(result[1].sizeRatio).toBe(99);
    expect(result[0].sizeRatio).toBeCloseTo(1);
  });

  it("returns input unchanged when no item is open", () => {
    const items = [track("a", 5, false), track("b", 7, false)];
    expect(normalizeOpenItemRatios(items, isOpen)).toEqual(items);
  });

  it("returns input unchanged when open ratios sum to a non-positive value", () => {
    const items = [track("a", 0, true), track("b", 0, true)];
    expect(normalizeOpenItemRatios(items, isOpen)).toEqual(items);
  });
});

describe("redistributeRatiosAfterRemoval", () => {
  it("distributes a removed open item's ratio across remaining open items", () => {
    const removed = track("x", 0.4, true);
    const remaining = [
      track("a", 0.36, true),
      track("b", 0.24, true),
      track("c", 5, false),
    ];
    const result = redistributeRatiosAfterRemoval(remaining, removed, isOpen);
    expect(result.find((it) => it.id === "a")?.sizeRatio).toBeCloseTo(0.6);
    expect(result.find((it) => it.id === "b")?.sizeRatio).toBeCloseTo(0.4);
    expect(result.find((it) => it.id === "c")?.sizeRatio).toBe(5);
  });

  it("leaves items unchanged when the removed item was closed", () => {
    const removed = track("x", 0.4, false);
    const remaining = [track("a", 0.6, true)];
    expect(redistributeRatiosAfterRemoval(remaining, removed, isOpen)).toEqual(
      remaining,
    );
  });

  it("leaves items unchanged when no remaining item is open", () => {
    const removed = track("x", 0.4, true);
    const remaining = [track("a", 0.6, false)];
    expect(redistributeRatiosAfterRemoval(remaining, removed, isOpen)).toEqual(
      remaining,
    );
  });

  it("falls back to an equal split when remaining open ratios sum to zero", () => {
    const removed = track("x", 0.5, true);
    const remaining = [track("a", 0, true), track("b", 0, true)];
    const result = redistributeRatiosAfterRemoval(remaining, removed, isOpen);
    expect(result[0].sizeRatio).toBeCloseTo(0.5);
    expect(result[1].sizeRatio).toBeCloseTo(0.5);
  });
});

describe("getOpenItemPixelSizes", () => {
  it("maps open item ratios to pixels proportionally", () => {
    const items = [track("a", 3, true), track("b", 1, true)];
    const sizes = getOpenItemPixelSizes(items, isOpen, 800);
    const budget = getSlotLayoutBudget(2, 800);
    expect(sizes.get("a")).toBeCloseTo(budget * 0.75);
    expect(sizes.get("b")).toBeCloseTo(budget * 0.25);
  });

  it("excludes closed items from the result", () => {
    const items = [track("a", 1, true), track("b", 1, false)];
    const sizes = getOpenItemPixelSizes(items, isOpen, 800);
    expect(sizes.has("b")).toBe(false);
  });

  it("assigns zero pixels when open ratios sum to zero", () => {
    const items = [track("a", 0, true), track("b", 0, true)];
    const sizes = getOpenItemPixelSizes(items, isOpen, 800);
    expect(sizes.get("a")).toBe(0);
    expect(sizes.get("b")).toBe(0);
  });
});

describe("applyAdjacentItemPixelSizes", () => {
  it("sets two adjacent items to the given pixel sizes and preserves others", () => {
    const items = [
      track("a", 1, true),
      track("b", 1, true),
      track("c", 1, true),
    ];
    const before = getOpenItemPixelSizes(items, isOpen, 900);
    const aBefore = before.get("a") ?? 0;
    const bBefore = before.get("b") ?? 0;
    const cBefore = before.get("c") ?? 0;

    const result = applyAdjacentItemPixelSizes(
      items,
      isOpen,
      "a",
      "b",
      aBefore + 50,
      bBefore - 50,
      900,
    );
    const after = getOpenItemPixelSizes(result, isOpen, 900);
    expect(after.get("a")).toBeCloseTo(aBefore + 50, 5);
    expect(after.get("b")).toBeCloseTo(bBefore - 50, 5);
    expect(after.get("c")).toBeCloseTo(cBefore, 5);
  });

  it("returns open ratios normalized to sum to 1", () => {
    const items = [
      track("a", 1, true),
      track("b", 1, true),
      track("c", 1, false),
    ];
    const result = applyAdjacentItemPixelSizes(
      items,
      isOpen,
      "a",
      "b",
      300,
      200,
      600,
    );
    expect(openSum(result)).toBeCloseTo(1);
  });

  it("leaves closed items untouched", () => {
    const items = [
      track("a", 1, true),
      track("b", 1, true),
      track("c", 42, false),
    ];
    const result = applyAdjacentItemPixelSizes(
      items,
      isOpen,
      "a",
      "b",
      300,
      200,
      600,
    );
    expect(result.find((it) => it.id === "c")?.sizeRatio).toBe(42);
  });
});
