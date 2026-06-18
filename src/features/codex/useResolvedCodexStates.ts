import { useEffect, useMemo } from "react";
import { useCodexStore } from "./codexStore";
import { usePhaseStore } from "./phaseStore";
import { useTreeStore } from "@/features/tree/treeStore";
import {
  resolveCodexStatesFor,
  type ResolvedCodexBadge,
} from "./resolveCodexStatesFor";

export function useResolvedCodexStates(
  entryIds: string[],
): Map<string, ResolvedCodexBadge> {
  const idsKey = entryIds.join("|");
  const entries = useCodexStore((s) => s.entries);
  const phasesByEntry = usePhaseStore((s) => s.phasesByEntry);
  const detailOverrides = usePhaseStore((s) => s.detailOverrides);
  const globalSceneOrder = usePhaseStore((s) => s.globalSceneOrder);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  useEffect(() => {
    const { phasesByEntry: loaded, loadPhasesForEntry } =
      usePhaseStore.getState();
    for (const id of idsKey ? idsKey.split("|") : []) {
      if (!loaded[id]) void loadPhasesForEntry(id);
    }
  }, [idsKey]);

  return useMemo(() => {
    const idSet = new Set(idsKey ? idsKey.split("|") : []);
    const selected = entries.filter((e) => idSet.has(e.id));
    return resolveCodexStatesFor(
      selected,
      phasesByEntry,
      detailOverrides,
      globalSceneOrder,
      activeSceneId || null,
    );
  }, [
    idsKey,
    entries,
    phasesByEntry,
    detailOverrides,
    globalSceneOrder,
    activeSceneId,
  ]);
}
