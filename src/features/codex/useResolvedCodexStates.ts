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
  const projectEpoch = usePhaseStore((s) => s.projectEpoch);
  const phasesByEntry = usePhaseStore((s) => s.phasesByEntry);
  const detailOverrides = usePhaseStore((s) => s.detailOverrides);
  const sceneTimeIndex = usePhaseStore((s) => s.sceneTimeIndex);
  const resolutionMode = usePhaseStore((s) => s.resolutionMode);
  const activeSceneId = useTreeStore((s) => s.activeSceneId);

  // フェーズは Project epoch ごとに「初回ロード」のみ one-shot
  // （その epoch で未ロードの id だけ取得）。
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
  }, [idsKey, projectEpoch]);

  return useMemo(() => {
    const idSet = new Set(idsKey ? idsKey.split("|") : []);
    const selected = entries.filter((e) => idSet.has(e.id));
    return resolveCodexStatesFor(
      selected,
      phasesByEntry,
      detailOverrides,
      sceneTimeIndex,
      resolutionMode,
      activeSceneId
        ? { kind: "scene", sceneId: activeSceneId }
        : { kind: "base" },
    );
  }, [
    idsKey,
    entries,
    phasesByEntry,
    detailOverrides,
    sceneTimeIndex,
    resolutionMode,
    activeSceneId,
  ]);
}
