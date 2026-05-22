import { create } from "zustand";
import { listAllBeatPovForProject } from "./beatPovCacheApi";

interface SceneBeatPovState {
  povIdsByScene: Record<string, string[]>;
  bulkLoadedProjectId: string | null;
  loadAllForProject: (projectId: string) => Promise<void>;
}

function groupBeatPovByScene(
  rows: Array<{ sceneId: string; povCharacterId: string }>,
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const row of rows) {
    grouped[row.sceneId] ??= [];
    grouped[row.sceneId].push(row.povCharacterId);
  }
  return grouped;
}

export const useSceneBeatPovStore = create<SceneBeatPovState>()((set) => ({
  povIdsByScene: {},
  bulkLoadedProjectId: null,

  loadAllForProject: async (projectId) => {
    const rows = await listAllBeatPovForProject(projectId);
    set({
      povIdsByScene: groupBeatPovByScene(rows),
      bulkLoadedProjectId: projectId,
    });
  },
}));
