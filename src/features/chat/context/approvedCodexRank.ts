import type { ChatContextItem } from "./types";

export function rankApprovedMentionedCodexItems(
  items: readonly ChatContextItem[],
  approvedCodexEntryIds: ReadonlySet<string> | undefined,
): ChatContextItem[] {
  if (!approvedCodexEntryIds?.size) return [...items];

  const ranked = [...items];
  const stabilityGroups = new Map<ChatContextItem["stability"], number[]>();
  items.forEach((item, index) => {
    if (
      item.kind === "codex" &&
      item.provenance.sourceType === "codex-mentioned"
    ) {
      stabilityGroups.set(item.stability, [
        ...(stabilityGroups.get(item.stability) ?? []),
        index,
      ]);
    }
  });

  for (const indices of stabilityGroups.values()) {
    const slots = indices.map((index) => ranked[index]);
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
