import type {
  CommandCenterItem,
  CommandCenterSection,
} from "../providers/types";

/**
 * クエリの `-word` で指定された除外語を section.items に適用する。
 * item の title + subtitle に対して **case-insensitive substring match**。
 * いずれかの除外語にマッチした item は除外される (OR 結合)。
 *
 * excludes が空なら入力 section をそのまま返す。
 */
export function filterByExcludes(
  section: CommandCenterSection,
  excludes: readonly string[],
): CommandCenterSection {
  if (excludes.length === 0) return section;
  const lowered = excludes
    .map((e) => e.toLowerCase())
    .filter((e) => e.length > 0);
  if (lowered.length === 0) return section;
  const items = section.items.filter((item) => !matchesExclude(item, lowered));
  return { ...section, items };
}

function matchesExclude(item: CommandCenterItem, lowered: string[]): boolean {
  const haystack = `${item.title} ${item.subtitle ?? ""}`.toLowerCase();
  return lowered.some((ex) => haystack.includes(ex));
}
