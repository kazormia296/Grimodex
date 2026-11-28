import type { ChatContextItem } from "./types";
import { planContextCache } from "@/features/ai-context/cachePlanner";

export function rankApprovedMentionedCodexItems(
  items: readonly ChatContextItem[],
  approvedCodexEntryIds: ReadonlySet<string> | undefined,
): ChatContextItem[] {
  if (!approvedCodexEntryIds?.size) return [...items];

  const ranked = [...items];
  const prefixEnd = planContextCache(items).stableItems.length;
  const cacheRanges = [
    [0, prefixEnd],
    [prefixEnd, items.length],
  ];
  for (const [start, end] of cacheRanges) {
    const indices: number[] = [];
    for (let index = start; index < end; index += 1) {
      const item = items[index];
      if (
        item.kind === "codex" &&
        item.provenance.sourceType === "codex-mentioned"
      ) {
        indices.push(index);
      }
    }
    const slots = indices.map((index) => items[index]);
    const approved = slots.filter((item) =>
      approvedCodexEntryIds.has(item.provenance.sourceId),
    );
    const other = slots.filter(
      (item) => !approvedCodexEntryIds.has(item.provenance.sourceId),
    );
    [...approved, ...other].forEach((item, slot) => {
      ranked[indices[slot]] = item;
    });
  }
  return ranked;
}

export function rankAndMaterializeApprovedMentionedCodexItems<
  TMaterialized extends { systemTokens: number },
>(
  items: ChatContextItem[],
  approvedCodexEntryIds: ReadonlySet<string> | undefined,
  materialized: TMaterialized,
  materialize: (
    items: readonly ChatContextItem[],
    cachePrefixEnd?: number,
  ) => TMaterialized,
  exactSystemBudget?: number,
): { items: ChatContextItem[]; materialized: TMaterialized } {
  const ranked = rankApprovedMentionedCodexItems(items, approvedCodexEntryIds);
  if (ranked.every((item, index) => item === items[index])) {
    return { items, materialized };
  }
  const cachePrefixEnd = planContextCache(items).stableItems.length;
  const rankedMaterialized = materialize(ranked, cachePrefixEnd);
  if (
    exactSystemBudget !== undefined &&
    rankedMaterialized.systemTokens > exactSystemBudget
  ) {
    return { items, materialized };
  }
  return { items: ranked, materialized: rankedMaterialized };
}

/** builder に注入する並べ替え。builder は旗も承認済みの集合も持たない。 */
export type ApprovedCodexRanker = <
  TMaterialized extends { systemTokens: number },
>(
  items: ChatContextItem[],
  materialized: TMaterialized,
  materialize: (
    items: readonly ChatContextItem[],
    cachePrefixEnd?: number,
  ) => TMaterialized,
  exactSystemBudget?: number,
) => { items: ChatContextItem[]; materialized: TMaterialized };

export function createApprovedCodexRanker(
  approvedCodexEntryIds: ReadonlySet<string>,
): ApprovedCodexRanker {
  return (items, materialized, materialize, exactSystemBudget) =>
    rankAndMaterializeApprovedMentionedCodexItems(
      items,
      approvedCodexEntryIds,
      materialized,
      materialize,
      exactSystemBudget,
    );
}
