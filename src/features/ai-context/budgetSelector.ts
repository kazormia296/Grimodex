import type {
  ContextAuthority,
  ContextDecision,
  ContextItem,
  PlannedContextUsage,
} from "./types";

export type BudgetSelectableContextItem<
  TPayload = unknown,
  TKind extends string = string,
> = ContextItem<TPayload, TKind>;

export interface SelectContextItemsInput<
  TPayload,
  TKind extends string = string,
> {
  items: readonly BudgetSelectableContextItem<TPayload, TKind>[];
  budgetTokens: number;
  /** Measures the exact rendered selection, including shared headers/wrappers. */
  measureSelectionTokens: (
    items: readonly BudgetSelectableContextItem<TPayload, TKind>[],
  ) => number;
  /** Measures one item for item-level diagnostics. */
  measureItemTokens: (
    item: BudgetSelectableContextItem<TPayload, TKind>,
  ) => number;
}

export interface ContextItemSelection<TPayload, TKind extends string = string> {
  selectedItems: BudgetSelectableContextItem<TPayload, TKind>[];
  decisions: ContextDecision[];
  usage: PlannedContextUsage;
}

function requireTokenCount(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

/**
 * Lower ranks yield first. Authority is the primary budget boundary: a high
 * numeric priority may order two canonical facts, but it must never let
 * retrieved/derived context displace an explicit author instruction.
 */
const AUTHORITY_RETENTION_RANK: Record<ContextAuthority, number> = {
  episodic: 0,
  retrieved: 1,
  derived: 2,
  canonical: 3,
  author_instruction: 4,
};

/**
 * Select atomic context items under a shared budget. Stability is intentionally
 * not part of removal ordering: cache eligibility must never exempt an item from
 * the context window. Lower authority yields first, then lower source-local
 * priority, then original order.
 */
export function selectContextItems<TPayload, TKind extends string = string>(
  input: SelectContextItemsInput<TPayload, TKind>,
): ContextItemSelection<TPayload, TKind> {
  requireTokenCount(input.budgetTokens, "budgetTokens");
  const items = [...input.items];
  const itemTokens = items.map((item, index) => {
    const tokens = input.measureItemTokens(item);
    requireTokenCount(tokens, `itemTokens[${index}]`);
    return tokens;
  });
  const candidateTokens = input.measureSelectionTokens(items);
  requireTokenCount(candidateTokens, "candidateTokens");

  const removed = new Set<number>();
  if (candidateTokens > input.budgetTokens) {
    const removalOrder = items
      .map((item, index) => ({
        index,
        authorityRank: AUTHORITY_RETENTION_RANK[item.authority],
        priority: item.priority,
      }))
      .sort(
        (left, right) =>
          left.authorityRank - right.authorityRank ||
          left.priority - right.priority ||
          left.index - right.index,
      );
    for (const candidate of removalOrder) {
      const selected = items.filter((_, index) => !removed.has(index));
      const selectedTokens = input.measureSelectionTokens(selected);
      requireTokenCount(selectedTokens, "selectedTokens");
      if (selectedTokens <= input.budgetTokens) break;
      removed.add(candidate.index);
    }
  }

  const selectedItems = items.filter((_, index) => !removed.has(index));
  const selectedTokens = input.measureSelectionTokens(selectedItems);
  requireTokenCount(selectedTokens, "selectedTokens");
  const decisions: ContextDecision[] = items.map((item, index) => {
    const trimmed = removed.has(index);
    return {
      key: item.key,
      status: trimmed ? "trimmed" : "selected",
      reason: trimmed ? "budget-priority" : "within-budget",
      tokensBefore: itemTokens[index],
      tokensAfter: trimmed ? 0 : itemTokens[index],
    };
  });

  return {
    selectedItems,
    decisions,
    usage: {
      candidateTokens,
      selectedTokens,
      trimmedTokens: Math.max(0, candidateTokens - selectedTokens),
      budgetTokens: input.budgetTokens,
    },
  };
}
