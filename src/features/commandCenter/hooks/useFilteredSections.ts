import { useMemo } from "react";
import { useCommandCenterStore } from "../store/commandCenterStore";
import {
  useResultsPanelStore,
  type SearchTypeKind,
  type SourceKind,
} from "../store/resultsPanelStore";
import type { CommandCenterSection, ItemKind } from "../providers/types";

/**
 * 専用ビュー (パネル) でフィルタ適用済みの sections を返す。
 *
 * 設計: **exclude 方式 (multi-select)**。指定された kind を「非表示」にする。
 *
 * - `excludedTypes` に "lexical" / "semantic" が含まれれば該当 section ごと除外
 * - `excludedSources` (Scene/Codex/Snippet) に従って:
 *   - "scene"   → lexical-scene を除外 + semantic section 全体を除外 (scene 由来のため)
 *   - "codex"   → lexical-codex を除外
 *   - "snippet" → lexical-snippet を除外
 *
 * 結果が 0 件になった section は丸ごと隠す (panel UI のノイズ削減)。
 */
const SOURCE_KIND_TO_ITEM_KIND: Record<SourceKind, ItemKind> = {
  scene: "lexical-scene",
  codex: "lexical-codex",
  snippet: "lexical-snippet",
};

export function filterSections(
  sections: readonly CommandCenterSection[],
  excludedSources: readonly SourceKind[],
  excludedTypes: readonly SearchTypeKind[],
): CommandCenterSection[] {
  const excludedItemKinds = new Set<ItemKind>(
    excludedSources.map((s) => SOURCE_KIND_TO_ITEM_KIND[s]),
  );
  const excludeSemanticBySource = excludedSources.includes("scene");

  return sections.flatMap((section) => {
    const isSemantic = section.id === "semantic";
    const isLexical = section.id === "lexical";

    // type 除外
    if (excludedTypes.includes("lexical") && isLexical) return [];
    if (excludedTypes.includes("semantic") && isSemantic) return [];

    // source 除外 (semantic は scene 由来として扱う)
    if (isSemantic && excludeSemanticBySource) return [];

    if (isLexical && excludedItemKinds.size > 0) {
      const filteredItems = section.items.filter(
        (i) => !excludedItemKinds.has(i.kind),
      );
      if (filteredItems.length === 0) return [];
      return [{ ...section, items: filteredItems }];
    }
    return [section];
  });
}

export function useFilteredSections(): CommandCenterSection[] {
  const sections = useCommandCenterStore((s) => s.sections);
  const excludedSources = useResultsPanelStore((s) => s.excludedSources);
  const excludedTypes = useResultsPanelStore((s) => s.excludedTypes);
  return useMemo(
    () => filterSections(sections, excludedSources, excludedTypes),
    [sections, excludedSources, excludedTypes],
  );
}
