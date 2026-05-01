import type { CodexMatchTarget } from "@/features/codex/codexMatcher";

export type ShowMode =
  | "codex-all"
  | "codex-characters"
  | "codex-locations"
  | "codex-items"
  | "codex-lore";

const TYPE_ORDER = ["character", "location", "item", "lore"] as const;

export interface MatrixColumn {
  /** Unique key for the column (entry id, or section header key) */
  key: string;
  entry: CodexMatchTarget & { tagsCache?: string | null };
  isSectionHeader: false;
  sectionType?: never;
}

export interface MatrixSectionHeader {
  key: string;
  entry?: never;
  isSectionHeader: true;
  sectionType: string;
}

export type MatrixColumnOrHeader = MatrixColumn | MatrixSectionHeader;

const MODE_TYPE_MAP: Record<ShowMode, string | null> = {
  "codex-all": null,
  "codex-characters": "character",
  "codex-locations": "location",
  "codex-items": "item",
  "codex-lore": "lore",
};

function parseTags(tagsCache: string | null | undefined): string[] {
  if (!tagsCache) return [];
  try {
    return JSON.parse(tagsCache) as string[];
  } catch {
    return [];
  }
}

/**
 * Derive the ordered list of columns (and optional section-header rows) from
 * the full Codex entry list, filtered by showMode and tagFilter.
 */
export function deriveColumns(
  allEntries: (CodexMatchTarget & { tagsCache?: string | null })[],
  showMode: ShowMode,
  tagFilter: string[],
  groupByType: boolean,
): MatrixColumnOrHeader[] {
  const typeFilter = MODE_TYPE_MAP[showMode];

  let filtered = typeFilter
    ? allEntries.filter((e) => e.type === typeFilter)
    : [...allEntries];

  if (tagFilter.length > 0) {
    filtered = filtered.filter((e) => {
      const tags = parseTags(e.tagsCache);
      return tagFilter.every((t) => tags.includes(t));
    });
  }

  if (!groupByType) {
    return filtered.map((e) => ({
      key: e.id,
      entry: e,
      isSectionHeader: false as const,
    }));
  }

  // Group by type in canonical order
  const byType = new Map<string, typeof filtered>();
  for (const type of TYPE_ORDER) byType.set(type, []);
  // Collect any types not in TYPE_ORDER
  for (const e of filtered) {
    const bucket = byType.get(e.type) ?? [];
    if (!byType.has(e.type)) byType.set(e.type, bucket);
    byType.get(e.type)!.push(e);
  }

  const result: MatrixColumnOrHeader[] = [];
  for (const type of TYPE_ORDER) {
    const entries = byType.get(type);
    if (!entries || entries.length === 0) continue;
    result.push({
      key: `section::${type}`,
      isSectionHeader: true,
      sectionType: type,
    });
    for (const e of entries) {
      result.push({ key: e.id, entry: e, isSectionHeader: false });
    }
  }
  return result;
}
