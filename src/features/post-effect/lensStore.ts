import { create } from "zustand";
import { listSceneLensForProject } from "./api";
import type { SceneLensRecord } from "./types";

interface LensState {
  /** scene (targetId) ごとの最新 lens レコード */
  bySceneId: Map<string, SceneLensRecord[]>;
  /** Outline (Scenes パネル) に lens バッジを出すか (lens データがある時のみ実表示) */
  showLensOverlay: boolean;
  load: (projectId: string) => Promise<void>;
  toggleShowLensOverlay: () => void;
}

export const useLensStore = create<LensState>()((set) => ({
  bySceneId: new Map(),
  showLensOverlay: true,

  load: async (projectId) => {
    try {
      const records = await listSceneLensForProject(projectId);
      const map = new Map<string, SceneLensRecord[]>();
      for (const r of records) {
        if (!r.targetId) continue;
        const arr = map.get(r.targetId) ?? [];
        arr.push(r);
        map.set(r.targetId, arr);
      }
      set({ bySceneId: map });
    } catch (e) {
      console.error("lens load error", e);
    }
  },

  toggleShowLensOverlay: () =>
    set((s) => ({ showLensOverlay: !s.showLensOverlay })),
}));
