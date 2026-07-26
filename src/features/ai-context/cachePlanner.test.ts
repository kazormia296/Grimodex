import { describe, expect, it } from "vitest";
import { planContextCache } from "./cachePlanner";
import type { ContextItem } from "./types";

function item(
  key: string,
  stability: ContextItem["stability"],
): ContextItem<{ text: string }, "fixture"> {
  return {
    key,
    kind: "fixture",
    authority: "canonical",
    priority: 2,
    stability,
    trim: { mode: "atomic", minTokens: 0, maxTokens: 10 },
    provenance: { sourceType: "fixture", sourceId: key },
    payload: { text: key },
  };
}

describe("planContextCache", () => {
  it("caches only the stable prefix and preserves the full semantic order", () => {
    const selected = [
      item("stable-1", "session-stable"),
      item("volatile-1", "turn-volatile"),
      item("stable-2", "session-stable"),
      item("volatile-2", "turn-volatile"),
    ];
    const plan = planContextCache(selected);

    expect(plan.selectedKeys).toEqual([
      "stable-1",
      "volatile-1",
      "stable-2",
      "volatile-2",
    ]);
    expect(plan.stableItems.map((candidate) => candidate.key)).toEqual([
      "stable-1",
    ]);
    expect(plan.volatileItems.map((candidate) => candidate.key)).toEqual([
      "volatile-1",
      "stable-2",
      "volatile-2",
    ]);
    expect([
      ...plan.stableItems.map((candidate) => candidate.key),
      ...plan.volatileItems.map((candidate) => candidate.key),
    ]).toEqual(plan.selectedKeys);
  });

  it("keeps every item cacheable when the selected plan is fully stable", () => {
    const selected = [
      item("stable-1", "session-stable"),
      item("stable-2", "session-stable"),
    ];

    const plan = planContextCache(selected);

    expect(plan.stableItems.map((candidate) => candidate.key)).toEqual([
      "stable-1",
      "stable-2",
    ]);
    expect(plan.volatileItems).toEqual([]);
  });

  it("returns empty partitions for an empty selected plan", () => {
    expect(planContextCache([])).toEqual({
      selectedItems: [],
      selectedKeys: [],
      stableItems: [],
      volatileItems: [],
    });
  });
});
