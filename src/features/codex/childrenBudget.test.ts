import { describe, it, expect, vi } from "vitest";
import {
  getChildrenFromArray,
  getDescendantsBFS,
  buildChildrenContext,
  computeChildrenTokenBudget,
  BUDGET_RATIOS,
} from "./childrenBudget";
import type { CodexEntry } from "./api";

vi.mock("@/features/chat/contextBuilder", () => ({
  countTokens: (s: string) => s.length,
}));

function makeEntry(
  id: string,
  parentId: string | null,
  name: string,
  summary?: string,
): CodexEntry {
  return {
    id,
    projectId: "proj-1",
    parentId,
    type: "character",
    name,
    aliases: null,
    excludedAliases: null,
    summary: summary ?? null,
    content: "{}",
    icon: null,
    tagsCache: null,
    contextMode: "mentioned",
    childrenBudget: "compact",
    sourceChatMessageId: null,
    notes: null,
    createdAt: "2025-01-01T00:00:00Z",
    updatedAt: "2025-01-01T00:00:00Z",
  };
}

const ROOT = makeEntry("root", null, "Root", "Root summary");
const CHILD_A = makeEntry("childA", "root", "ChildA", "Child A summary");
const CHILD_B = makeEntry("childB", "root", "ChildB", "Child B summary");
const GRANDCHILD = makeEntry(
  "grand",
  "childA",
  "Grandchild",
  "Grandchild summary",
);
const UNRELATED = makeEntry(
  "unrelated",
  null,
  "Unrelated",
  "Unrelated summary",
);

describe("getChildrenFromArray", () => {
  it("returns only direct children of the given parent", () => {
    const entries = [ROOT, CHILD_A, CHILD_B, GRANDCHILD, UNRELATED];
    const children = getChildrenFromArray("root", entries);
    expect(children).toHaveLength(2);
    expect(children.map((e) => e.id)).toContain("childA");
    expect(children.map((e) => e.id)).toContain("childB");
  });

  it("does not include grandchildren", () => {
    const entries = [ROOT, CHILD_A, CHILD_B, GRANDCHILD];
    const children = getChildrenFromArray("root", entries);
    expect(children.map((e) => e.id)).not.toContain("grand");
  });

  it("returns empty array when entry has no children", () => {
    const entries = [ROOT, CHILD_A, CHILD_B, GRANDCHILD];
    const children = getChildrenFromArray("grand", entries);
    expect(children).toHaveLength(0);
  });

  it("returns empty array for unknown parent", () => {
    const entries = [ROOT, CHILD_A];
    const children = getChildrenFromArray("nonexistent", entries);
    expect(children).toHaveLength(0);
  });
});

describe("getDescendantsBFS", () => {
  it("returns descendants in BFS order", () => {
    const entries = [ROOT, CHILD_A, CHILD_B, GRANDCHILD];
    const descendants = getDescendantsBFS("root", entries);
    // BFS: childA and childB first, then grandchild
    expect(descendants).toHaveLength(3);
    const ids = descendants.map((e) => e.id);
    // childA and childB must appear before grandchild
    expect(ids.indexOf("childA")).toBeLessThan(ids.indexOf("grand"));
    expect(ids.indexOf("childB")).toBeLessThan(ids.indexOf("grand"));
  });

  it("returns empty array for leaf nodes", () => {
    const entries = [ROOT, CHILD_A, CHILD_B, GRANDCHILD];
    const descendants = getDescendantsBFS("grand", entries);
    expect(descendants).toHaveLength(0);
  });

  it("returns empty array when no entries provided", () => {
    const descendants = getDescendantsBFS("root", []);
    expect(descendants).toHaveLength(0);
  });

  it("handles potential cycles by tracking visited nodes", () => {
    // Create a situation where the same child would be processed twice
    // (simulating possible duplicate data, not a real DB cycle)
    const entryA = makeEntry("a", "root", "A");
    const entryB = makeEntry("b", "a", "B");
    const duplicate = makeEntry("a", "b", "ADuplicate"); // duplicate id
    const entries = [ROOT, entryA, entryB, duplicate];
    // Should not infinite loop
    const descendants = getDescendantsBFS("root", entries);
    // 'a' should only appear once
    const ids = descendants.map((e) => e.id);
    const aCount = ids.filter((id) => id === "a").length;
    expect(aCount).toBe(1);
  });

  it("does not include the root entry itself", () => {
    const entries = [ROOT, CHILD_A];
    const descendants = getDescendantsBFS("root", entries);
    expect(descendants.map((e) => e.id)).not.toContain("root");
  });
});

describe("buildChildrenContext", () => {
  it("returns empty string when budgetTokens is 0", () => {
    const result = buildChildrenContext([CHILD_A, CHILD_B], 0);
    expect(result).toBe("");
  });

  it("returns empty string when descendants array is empty", () => {
    const result = buildChildrenContext([], 1000);
    expect(result).toBe("");
  });

  it("includes entries within budget", () => {
    // Using mock countTokens = s.length
    // "  - ChildA: Child A summary" = 27 chars
    const result = buildChildrenContext([CHILD_A], 1000);
    expect(result).toContain("ChildA");
    expect(result).toContain("Child A summary");
  });

  it("stops adding entries when budget is exhausted", () => {
    // "  - ChildA: Child A summary" = 27 chars (with mock countTokens = s.length)
    // Budget of 30 should fit ChildA but maybe not ChildB as well
    const result = buildChildrenContext([CHILD_A, CHILD_B], 27);
    expect(result).toContain("ChildA");
    expect(result).not.toContain("ChildB");
  });

  it("skips entries without summaries", () => {
    const noSummary = makeEntry("ns", "root", "NoSummary");
    const result = buildChildrenContext([noSummary, CHILD_A], 1000);
    expect(result).not.toContain("NoSummary");
    expect(result).toContain("ChildA");
  });

  it("formats lines with indentation prefix", () => {
    const result = buildChildrenContext([CHILD_A], 1000);
    expect(result).toMatch(/^ {2}- ChildA:/);
  });

  it("joins multiple lines with newline", () => {
    const result = buildChildrenContext([CHILD_A, CHILD_B], 1000);
    expect(result).toContain("\n");
    const lines = result.split("\n");
    expect(lines.length).toBe(2);
  });
});

describe("computeChildrenTokenBudget", () => {
  it("returns correct budget for 'none' preset", () => {
    expect(computeChildrenTokenBudget("none", 10000)).toBe(0);
  });

  it("returns correct budget for 'compact' preset (15%)", () => {
    expect(computeChildrenTokenBudget("compact", 10000)).toBe(
      Math.floor(10000 * BUDGET_RATIOS.compact),
    );
  });

  it("returns correct budget for 'standard' preset (30%)", () => {
    expect(computeChildrenTokenBudget("standard", 10000)).toBe(
      Math.floor(10000 * BUDGET_RATIOS.standard),
    );
  });

  it("returns correct budget for 'generous' preset (50%)", () => {
    expect(computeChildrenTokenBudget("generous", 10000)).toBe(
      Math.floor(10000 * BUDGET_RATIOS.generous),
    );
  });

  it("floors the result (no fractional tokens)", () => {
    // 10001 * 0.15 = 1500.15 → floor → 1500
    const result = computeChildrenTokenBudget("compact", 10001);
    expect(Number.isInteger(result)).toBe(true);
  });

  it("falls back to compact ratio for unknown preset", () => {
    // Unknown presets default to 0.15 (compact)
    expect(computeChildrenTokenBudget("unknown_preset", 10000)).toBe(
      Math.floor(10000 * 0.15),
    );
  });
});
