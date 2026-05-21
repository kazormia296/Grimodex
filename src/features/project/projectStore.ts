import { create } from "zustand";
import { PROJECT_ID as FALLBACK_PROJECT_ID } from "./constants";
import { listProjects, getProject } from "./api";
import { usePhaseStore } from "@/features/codex/phaseStore";

interface ProjectState {
  /** The Project currently open in the editor. `null` until initCurrentProject resolves. */
  currentProjectId: string | null;
  /** Resolve which Project is current from the DB. Called once on workspace open. */
  initCurrentProject: () => Promise<void>;
  /** Make a Project active: set it as current and apply its metadata to runtime. */
  loadProject: (projectId: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>()((set) => ({
  currentProjectId: null,

  initCurrentProject: async () => {
    try {
      const projects = await listProjects();
      set({ currentProjectId: projects[0]?.id ?? FALLBACK_PROJECT_ID });
    } catch {
      // A failed lookup must not block workspace open — fall back so the
      // editor still has a Project id to work with.
      set({ currentProjectId: FALLBACK_PROJECT_ID });
    }
  },

  loadProject: async (projectId) => {
    set({ currentProjectId: projectId });
    const p = await getProject(projectId);
    if (p?.language) document.documentElement.lang = p.language;
    if (p?.phaseResolutionMode) {
      usePhaseStore.getState().setResolutionMode(p.phaseResolutionMode);
    }
  },
}));

/**
 * Current Project id for non-React modules. Falls back to the bootstrap
 * Project id in the window before initCurrentProject has resolved.
 */
export function getCurrentProjectId(): string {
  return useProjectStore.getState().currentProjectId ?? FALLBACK_PROJECT_ID;
}

/** Current Project id hook for React components. */
export function useCurrentProjectId(): string {
  return useProjectStore((s) => s.currentProjectId) ?? FALLBACK_PROJECT_ID;
}
