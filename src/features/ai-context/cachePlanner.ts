import type { ContextItem } from "./types";

export interface ContextCachePlan<TPayload, TKind extends string = string> {
  selectedItems: ContextItem<TPayload, TKind>[];
  selectedKeys: string[];
  stableItems: ContextItem<TPayload, TKind>[];
  volatileItems: ContextItem<TPayload, TKind>[];
}

/**
 * Place an already-selected plan without changing semantic order. Only the
 * contiguous stable prefix is cacheable: moving a later stable item ahead of a
 * volatile item would change `[A, B, C]` into `[A, C, B]` on cached delivery.
 * From the first volatile item onward, every item stays in the volatile tail.
 * This function never selects or drops items; BudgetSelector remains the sole
 * owner of the semantic item set.
 */
export function planContextCache<TPayload, TKind extends string = string>(
  selectedItems: readonly ContextItem<TPayload, TKind>[],
): ContextCachePlan<TPayload, TKind> {
  const selected = [...selectedItems];
  const firstVolatile = selected.findIndex(
    (item) => item.stability === "turn-volatile",
  );
  const prefixEnd = firstVolatile === -1 ? selected.length : firstVolatile;
  return {
    selectedItems: selected,
    selectedKeys: selected.map((item) => item.key),
    stableItems: selected.slice(0, prefixEnd),
    volatileItems: selected.slice(prefixEnd),
  };
}
