import { describe, expect, it } from "vitest";
import {
  selectContextItems,
  type BudgetSelectableContextItem,
} from "./budgetSelector";
import type { ContextItem } from "./types";

interface Payload {
  text: string;
}

function item(
  key: string,
  text: string,
  priority: number,
  stability: ContextItem["stability"] = "turn-volatile",
  authority: ContextItem["authority"] = "canonical",
): BudgetSelectableContextItem<Payload, "fixture"> {
  return {
    key,
    kind: "fixture",
    authority,
    priority,
    stability,
    trim: { mode: "atomic", minTokens: 0, maxTokens: text.length },
    provenance: { sourceType: "fixture", sourceId: key },
    payload: { text },
  };
}

const measureSelectionTokens = (items: readonly ContextItem<Payload>[]) =>
  items.reduce((sum, candidate) => sum + candidate.payload.text.length, 0);
const measureItemTokens = (candidate: ContextItem<Payload>) =>
  candidate.payload.text.length;

describe("selectContextItems", () => {
  it("keeps item order and records selected decisions when the budget fits", () => {
    const items = [item("one", "aaa", 1), item("two", "bb", 2)];
    const result = selectContextItems({
      items,
      budgetTokens: 5,
      measureSelectionTokens,
      measureItemTokens,
    });

    expect(result.selectedItems.map((candidate) => candidate.key)).toEqual([
      "one",
      "two",
    ]);
    expect(result.decisions).toEqual([
      {
        key: "one",
        status: "selected",
        reason: "within-budget",
        tokensBefore: 3,
        tokensAfter: 3,
      },
      {
        key: "two",
        status: "selected",
        reason: "within-budget",
        tokensBefore: 2,
        tokensAfter: 2,
      },
    ]);
    expect(result.usage).toEqual({
      candidateTokens: 5,
      selectedTokens: 5,
      trimmedTokens: 0,
      budgetTokens: 5,
    });
  });

  it("trims lower priority first even when that item is session-stable", () => {
    const items = [
      item("stable-low", "aaaa", 0, "session-stable"),
      item("volatile-high", "bbbb", 4, "turn-volatile"),
    ];
    const result = selectContextItems({
      items,
      budgetTokens: 4,
      measureSelectionTokens,
      measureItemTokens,
    });

    expect(result.selectedItems.map((candidate) => candidate.key)).toEqual([
      "volatile-high",
    ]);
    expect(result.decisions).toContainEqual({
      key: "stable-low",
      status: "trimmed",
      reason: "budget-priority",
      tokensBefore: 4,
      tokensAfter: 0,
    });
  });

  it("uses original order as the deterministic tie-break", () => {
    const items = [item("first", "aaa", 2), item("second", "bbb", 2)];
    const result = selectContextItems({
      items,
      budgetTokens: 3,
      measureSelectionTokens,
      measureItemTokens,
    });

    expect(result.selectedItems.map((candidate) => candidate.key)).toEqual([
      "second",
    ]);
    expect(result.decisions[0]).toMatchObject({
      key: "first",
      status: "trimmed",
      reason: "budget-priority",
    });
  });

  it("preserves higher authority before comparing source-local priority", () => {
    const items = [
      item("canonical-high", "aaaa", 99, "turn-volatile", "canonical"),
      item("explicit", "bbbb", 0, "turn-volatile", "author_instruction"),
    ];
    const result = selectContextItems({
      items,
      budgetTokens: 4,
      measureSelectionTokens,
      measureItemTokens,
    });

    expect(result.selectedItems.map((candidate) => candidate.key)).toEqual([
      "explicit",
    ]);
    expect(result.decisions).toContainEqual(
      expect.objectContaining({
        key: "canonical-high",
        status: "trimmed",
        reason: "budget-priority",
      }),
    );
  });

  it("drops every atomic item at a zero budget", () => {
    const result = selectContextItems({
      items: [item("one", "aaa", 4)],
      budgetTokens: 0,
      measureSelectionTokens,
      measureItemTokens,
    });

    expect(result.selectedItems).toEqual([]);
    expect(result.usage.selectedTokens).toBe(0);
    expect(result.decisions[0]).toMatchObject({
      status: "trimmed",
      reason: "budget-priority",
    });
  });
});
