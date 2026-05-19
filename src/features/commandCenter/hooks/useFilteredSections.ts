import { useMemo } from "react";
import { useCommandCenterStore } from "../store/commandCenterStore";
import {
  useResultsPanelStore,
  type SearchTypeFilter,
  type SourceFilter,
} from "../store/resultsPanelStore";
import type { CommandCenterSection, ItemKind } from "../providers/types";

/**
 * Panel 側でフィルタを適用した sections を返す純粋関数 hook。
 *
 * - searchTypeFilter:
 *   - "lexical"  → semantic section を除外
 *   - "semantic" → lexical section を除外
 *   - "all"      → 何もしない
 * - sourceFilter:
 *   - "scene"    → lexical-scene のみ残す + semantic は全件保持 (scene 由来)
 *   - "codex"    → lexical-codex のみ残す + semantic は除外
 *   - "snippet"  → lexical-snippet のみ残す + semantic は除外
 *   - "all"      → 何もしない
 */
const SOURCE_KIND_MAP: Record<SourceFilter, ItemKind | null> = {
  all: null,
  scene: "lexical-scene",
  codex: "lexical-codex",
  snippet: "lexical-snippet",
};

export function filterSections(
  sections: readonly CommandCenterSection[],
  sourceFilter: SourceFilter,
  searchTypeFilter: SearchTypeFilter,
): CommandCenterSection[] {
  return sections.flatMap((section) => {
    const isSemantic = section.id === "semantic";
    const isLexical = section.id === "lexical";

    // searchTypeFilter
    if (searchTypeFilter === "lexical" && isSemantic) return [];
    if (searchTypeFilter === "semantic" && isLexical) return [];

    // sourceFilter
    if (sourceFilter !== "all") {
      if (isSemantic && sourceFilter !== "scene") return [];
      if (isLexical) {
        const wantedKind = SOURCE_KIND_MAP[sourceFilter];
        if (wantedKind) {
          const filteredItems = section.items.filter(
            (i) => i.kind === wantedKind,
          );
          // 結果が 0 件なら section ごと隠す (panel UI のノイズ削減)
          if (filteredItems.length === 0) return [];
          return [{ ...section, items: filteredItems }];
        }
      }
    }
    return [section];
  });
}

export function useFilteredSections(): CommandCenterSection[] {
  const sections = useCommandCenterStore((s) => s.sections);
  const sourceFilter = useResultsPanelStore((s) => s.sourceFilter);
  const searchTypeFilter = useResultsPanelStore((s) => s.searchTypeFilter);
  return useMemo(
    () => filterSections(sections, sourceFilter, searchTypeFilter),
    [sections, sourceFilter, searchTypeFilter],
  );
}
