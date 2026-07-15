import type { CodexEntry } from "./api";
import type { CodexSortOrder } from "./codexStore";
import type { CodexType } from "./typeApi";
import { compareInstantValues } from "@/lib/time";

/** Sort option descriptors — translate the `key` field with `t(opt.key)` in components. */
export const CODEX_SORT_OPTIONS: { value: CodexSortOrder; key: string }[] = [
  { value: "category", key: "codex.sortCategory" },
  { value: "name-asc", key: "codex.sortNameAsc" },
  { value: "name-desc", key: "codex.sortNameDesc" },
  { value: "updated", key: "codex.sortUpdated" },
  { value: "created", key: "codex.sortCreated" },
  { value: "most-referenced", key: "codex.sortMostReferenced" },
];

/**
 * Sort entries by type-group order (matching CodexManagementPanel's "category" sort).
 * Groups are ordered by CodexType.sortOrder; within each group entries are sorted by name.
 */
export function sortEntriesByCategory(
  entries: CodexEntry[],
  codexTypes: CodexType[],
): CodexEntry[] {
  const typeOrder = new Map(
    codexTypes.map((ct, i) => [ct.slug, ct.sortOrder ?? i]),
  );
  const sorted = [...entries].sort((a, b) => {
    const aOrd = typeOrder.get(a.type) ?? 9999;
    const bOrd = typeOrder.get(b.type) ?? 9999;
    if (aOrd !== bOrd) return aOrd - bOrd;
    return a.name.localeCompare(b.name, "ja");
  });
  return sorted;
}

export function sortEntries(
  entries: CodexEntry[],
  order: CodexSortOrder,
  refCountMap?: Map<string, number>,
): CodexEntry[] {
  const sorted = [...entries];
  switch (order) {
    case "name-asc":
      return sorted.sort((a, b) => a.name.localeCompare(b.name, "ja"));
    case "name-desc":
      return sorted.sort((a, b) => b.name.localeCompare(a.name, "ja"));
    case "updated":
      return sorted.sort((a, b) =>
        compareInstantValues(a.updatedAt, b.updatedAt, "descending"),
      );
    case "created":
      return sorted.sort((a, b) =>
        compareInstantValues(a.createdAt, b.createdAt, "descending"),
      );
    case "most-referenced":
      return sorted.sort((a, b) => {
        const ac = refCountMap?.get(a.id) ?? 0;
        const bc = refCountMap?.get(b.id) ?? 0;
        return bc - ac;
      });
    default:
      return sorted;
  }
}
