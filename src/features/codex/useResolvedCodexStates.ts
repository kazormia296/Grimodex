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

  // フェーズの「初回ロード」のみ one-shot（未ロードの id だけ取得）。
  // 以降のバッジ鮮度は usePhaseStore の購読（phasesByEntry / detailOverrides）が担保する:
  // フェーズの追加・編集がストアへ反映されれば下の useMemo が再計算されるため、
  // ここで再ロードする必要はない（再ロードすると更新ループになる）。
  // ＝ ロードは一度きり・表示はストア駆動でライブ、という契約。
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
