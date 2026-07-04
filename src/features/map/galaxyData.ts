import { buildCrossReferenceReportForProject } from "@/features/codex/crossReference";
import { listCodexRelations } from "@/features/codex/codexRelationApi";
import {
  listEvents,
  listSceneEventsForProject,
  listEventParticipantsForProject,
} from "@/features/chronicle/api";
import {
  listPlotThreads,
  listPlotThreadLinks,
} from "@/features/plot-threads/api";
import { useTreeStore } from "@/features/tree/treeStore";
import type { GalaxyGraphInput } from "./galaxyGraph";

/**
 * ギャラクシーグラフの入力データを既存 API から一括取得する。
 * crossReference（Rust matcher で全シーン本文を走査）が支配的コスト。
 */
export async function loadGalaxyGraphInput(
  projectId: string,
): Promise<GalaxyGraphInput> {
  let treeNodes = useTreeStore.getState().nodes;
  if (treeNodes.length === 0) {
    await useTreeStore.getState().loadTree(projectId);
    treeNodes = useTreeStore.getState().nodes;
  }
  const [
    crossReference,
    relations,
    events,
    sceneEvents,
    participants,
    threads,
    threadLinks,
  ] = await Promise.all([
    buildCrossReferenceReportForProject(projectId),
    listCodexRelations(projectId),
    listEvents(projectId),
    listSceneEventsForProject(projectId),
    listEventParticipantsForProject(projectId),
    listPlotThreads(projectId),
    listPlotThreadLinks(projectId),
  ]);
  return {
    treeNodes,
    crossReference,
    relations,
    events,
    sceneEvents,
    participants,
    threads,
    threadLinks,
  };
}
