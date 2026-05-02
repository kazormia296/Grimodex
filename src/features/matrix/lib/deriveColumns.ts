import type { CodexMatchTarget } from "@/features/codex/codexMatcher";

export type ShowMode =
  | "codex-all"
  | "codex-characters"
  | "codex-locations"
  | "codex-items"
  | "codex-lore"
  | "pov"
  | "location"
  | "subplot"
  | "custom";

const TYPE_ORDER = ["character", "location", "item", "lore"] as const;

export interface MatrixColumn {
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

/** Type filter for Codex-family modes */
const MODE_TYPE_MAP: Partial<Record<ShowMode, string>> = {
  "codex-characters": "character",
  "codex-locations": "location",
  "codex-items": "item",
  "codex-lore": "lore",
  pov: "character",
  location: "location",
};

/** Show modes where groupByType should never add section headers */
const NO_GROUP_MODES = new Set<ShowMode>([
  "pov",
  "location",
  "subplot",
  "custom",
]);

export interface DeriveColumnsOpts {
  /** Tag name used as the Subplot label (default: "subplot") */
  subplotTagName?: string;
  /** Entry IDs in the active Custom set */
  customEntryIds?: string[];
  /** Entry IDs to place first (pinned columns) */
  pinnedColumnIds?: string[];
  /** Entry IDs to hide entirely */
  hiddenColumnIds?: string[];
  /** Type slugs whose entries are hidden (section header kept) */
  collapsedTypeSections?: string[];
}

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
  opts: DeriveColumnsOpts = {},
): MatrixColumnOrHeader[] {
  const {
    subplotTagName = "subplot",
    customEntryIds,
    pinnedColumnIds,
    hiddenColumnIds,
    collapsedTypeSections,
  } = opts;
  const hiddenSet = new Set(hiddenColumnIds ?? []);
  const pinnedSet = new Set(pinnedColumnIds ?? []);
  const collapsedSections = new Set(collapsedTypeSections ?? []);

  let filtered: typeof allEntries;

  if (showMode === "custom") {
    // Custom mode: explicit entry list, tag filter not applied
    const ids = new Set(customEntryIds ?? []);
    filtered = ids.size > 0 ? allEntries.filter((e) => ids.has(e.id)) : [];
  } else if (showMode === "subplot") {
    // subplot mode: lore type + matching subplot tag
    filtered = allEntries.filter((e) => {
      if (e.type !== "lore") return false;
      return parseTags(e.tagsCache).includes(subplotTagName);
    });
  } else {
    const typeFilter = MODE_TYPE_MAP[showMode] ?? null;
    filtered = typeFilter
      ? allEntries.filter((e) => e.type === typeFilter)
      : [...allEntries];
  }

  // Apply tag filter (AND logic) — not for custom or pov/location/subplot
  if (
    tagFilter.length > 0 &&
    showMode !== "custom" &&
    !NO_GROUP_MODES.has(showMode)
  ) {
    filtered = filtered.filter((e) => {
      const tags = parseTags(e.tagsCache);
      return tagFilter.every((t) => tags.includes(t));
    });
  }

  // Remove hidden entries
  if (hiddenSet.size > 0) {
    filtered = filtered.filter((e) => !hiddenSet.has(e.id));
  }

  // Never group-by-type for single-type or custom modes
  const shouldGroup = groupByType && !NO_GROUP_MODES.has(showMode);

  if (!shouldGroup) {
    const cols: MatrixColumnOrHeader[] = filtered.map((e) => ({
      key: e.id,
      entry: e,
      isSectionHeader: false as const,
    }));
    return applyPinOrder(cols, pinnedSet);
  }

  // Group by type in canonical order
  const byType = new Map<string, typeof filtered>();
  for (const type of TYPE_ORDER) byType.set(type, []);
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
    // If the type section is collapsed, skip its entries (but keep the header)
    if (collapsedSections.has(type)) continue;
    for (const e of entries) {
      result.push({ key: e.id, entry: e, isSectionHeader: false });
    }
  }
  return applyPinOrder(result, pinnedSet);
}

/**
 * Move pinned entry columns to the front while preserving relative order
 * of both pinned and unpinned groups. Section headers stay with their entries.
 */
function applyPinOrder(
  cols: MatrixColumnOrHeader[],
  pinnedSet: Set<string>,
): MatrixColumnOrHeader[] {
  if (pinnedSet.size === 0) return cols;
  const pinned: MatrixColumnOrHeader[] = [];
  const rest: MatrixColumnOrHeader[] = [];
  for (const col of cols) {
    const id = col.isSectionHeader ? null : col.entry.id;
    if (id && pinnedSet.has(id)) {
      pinned.push(col);
    } else {
      rest.push(col);
    }
  }
  return [...pinned, ...rest];
}
