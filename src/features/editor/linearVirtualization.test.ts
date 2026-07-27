import { describe, expect, it } from "vitest";
import {
  buildLinearPinnedIndexes,
  extractLinearVirtualIndexes,
} from "./linearVirtualization";

describe("linear virtualization", () => {
  it("renders only the visible range plus overscan during normal scrolling", () => {
    expect(
      extractLinearVirtualIndexes(
        { startIndex: 40, endIndex: 44, overscan: 3, count: 100 },
        new Set(),
      ),
    ).toEqual([37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47]);
  });

  it("pins active neighbours and offscreen dirty/conflicted drafts", () => {
    const ids = Array.from({ length: 100 }, (_, index) => `scene-${index}`);
    const pinned = buildLinearPinnedIndexes(
      ids,
      "scene-42",
      new Set(["scene-2"]),
      new Set(["scene-97"]),
    );
    expect([...pinned].sort((a, b) => a - b)).toEqual([
      2, 40, 41, 42, 43, 44, 97,
    ]);

    const rendered = extractLinearVirtualIndexes(
      { startIndex: 40, endIndex: 44, overscan: 1, count: ids.length },
      pinned,
    );
    expect(rendered).toEqual([2, 39, 40, 41, 42, 43, 44, 45, 97]);
  });
});
