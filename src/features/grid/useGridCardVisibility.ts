import { useMemo } from "react";
import { useCodexStore } from "@/features/codex/codexStore";
import { useLabelStore } from "@/features/labels/labelStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { parseBeatPreview } from "./parseBeatPreview";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { GridFilterSettings } from "./gridStore";

interface CardVisibility {
  matchesSearch: boolean;
  passesFilter: boolean;
}

// Module-level constants to avoid new-reference-in-selector issue
const EMPTY_CODEX_ENTRIES: ReturnType<
  typeof useCodexStore.getState
>["entries"] = [];
const EMPTY_NODE_LABELS: Record<string, string[]> = {};
const EMPTY_CHAR_COUNTS: Record<string, number> = {};

interface UseGridCardVisibilityArgs {
  scenes: TreeNodeData[];
  searchQuery: string;
  filter: GridFilterSettings;
  pinsByScene: Record<string, string[]>;
}

export function useGridCardVisibility({
  scenes,
  searchQuery,
  filter,
  pinsByScene,
}: UseGridCardVisibilityArgs): Map<string, CardVisibility> {
  // Only subscribe to charCounts when the emptyOnly filter actually needs it.
  // Otherwise return a stable empty constant so keystroke-driven charCounts
  // updates do not cause a re-render here.
  const charCounts = useTreeStore((s) =>
    filter.emptyOnly ? s.charCounts : EMPTY_CHAR_COUNTS,
  );
  const codexEntries = useCodexStore((s) =>
    s.entries.length > 0 ? s.entries : EMPTY_CODEX_ENTRIES,
  );
  const nodeLabels = useLabelStore((s) =>
    Object.keys(s.nodeLabels).length > 0 ? s.nodeLabels : EMPTY_NODE_LABELS,
  );

  return useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const result = new Map<string, CardVisibility>();

    // Build a name lookup map for codex entries once
    const codexNameById = new Map<string, string>();
    for (const entry of codexEntries) {
      codexNameById.set(entry.id, entry.name.toLowerCase());
    }

    for (const scene of scenes) {
      // --- search match ---
      let matchesSearch = true;
      if (q) {
        const titleMatch = scene.title.toLowerCase().includes(q);
        const synopsisMatch = (scene.synopsis ?? "").toLowerCase().includes(q);
        const beatLines = [
          ...(parseBeatPreview(scene.placedBeatPreview) ?? []),
          ...(parseBeatPreview(scene.unplacedBeatPreview) ?? []),
        ];
        const beatMatch = beatLines.some((line) =>
          line.toLowerCase().includes(q),
        );
        const codexIds = pinsByScene[scene.id] ?? [];
        const codexMatch = codexIds.some((eid) =>
          (codexNameById.get(eid) ?? "").includes(q),
        );
        matchesSearch = titleMatch || synopsisMatch || beatMatch || codexMatch;
      }

      // --- filter pass ---
      let passesFilter = true;
      if (filter.emptyOnly) {
        const count = charCounts[scene.id] ?? scene.charCount ?? 0;
        passesFilter = count === 0;
      }
      if (passesFilter && filter.hideCompleted) {
        passesFilter = scene.status !== "complete" && scene.status !== "final";
      }
      if (passesFilter && filter.codexFilter !== null) {
        const codexIds = pinsByScene[scene.id] ?? [];
        passesFilter = codexIds.includes(filter.codexFilter);
      }
      if (passesFilter && filter.labelFilter.length > 0) {
        const sceneLabels = nodeLabels[scene.id] ?? [];
        passesFilter = filter.labelFilter.some((id) =>
          sceneLabels.includes(id),
        );
      }

      result.set(scene.id, { matchesSearch, passesFilter });
    }

    return result;
  }, [
    scenes,
    searchQuery,
    filter,
    charCounts,
    pinsByScene,
    codexEntries,
    nodeLabels,
  ]);
}
