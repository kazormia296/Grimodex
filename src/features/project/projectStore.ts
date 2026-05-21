import { create } from "zustand";
import { PROJECT_ID as FALLBACK_PROJECT_ID } from "./constants";
import {
  listProjects,
  getProject,
  createProject as createProjectRow,
  deleteProject as deleteProjectRow,
  type Project,
} from "./api";
import { usePhaseStore } from "@/features/codex/phaseStore";
import { ensureBuiltinTypes } from "@/features/codex/typeApi";

interface CreateProjectInput {
  title: string;
  genre?: string;
  language?: string;
  pov?: string;
  tense?: string;
  seedFromProjectId?: string;
  seedTypeSlugs?: string[];
}

interface ProjectState {
  /** The Project currently open in the editor. `null` until initCurrentProject resolves. */
  currentProjectId: string | null;
  /** Cached project list for switcher UI. */
  projects: Project[];
  /** Resolve which Project is current from the DB. Called once on workspace open. */
  initCurrentProject: () => Promise<void>;
  /** Refresh cached project list from DB. */
  refreshProjects: () => Promise<void>;
  /** Make a Project active: set it as current, apply metadata, reload panels. */
  loadProject: (projectId: string) => Promise<void>;
  /** Create a new Project and switch to it. */
  createNewProject: (input: CreateProjectInput) => Promise<Project>;
  /** Delete a Project. Switches away if deleting the current one. */
  deleteProjectById: (projectId: string) => Promise<void>;
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  currentProjectId: null,
  projects: [],

  initCurrentProject: async () => {
    try {
      const projectRows = await listProjects();
      set({
        projects: projectRows,
        currentProjectId: projectRows[0]?.id ?? FALLBACK_PROJECT_ID,
      });
    } catch {
      // A failed lookup must not block workspace open — fall back so the
      // editor still has a Project id to work with.
      set({ currentProjectId: FALLBACK_PROJECT_ID, projects: [] });
    }
  },

  refreshProjects: async () => {
    const projectRows = await listProjects();
    set({ projects: projectRows });
  },

  loadProject: async (projectId) => {
    set({ currentProjectId: projectId });
    const p = await getProject(projectId);
    if (p?.language && typeof document !== "undefined") {
      document.documentElement.lang = p.language;
    }
    if (p?.phaseResolutionMode) {
      usePhaseStore.getState().setResolutionMode(p.phaseResolutionMode);
    }
    const { reloadProjectData } = await import("./reloadProjectData");
    await reloadProjectData(projectId);
  },

  createNewProject: async (input) => {
    const created = await createProjectRow({
      id: crypto.randomUUID(),
      title: input.title.trim(),
      genre: input.genre || undefined,
      language: input.language || undefined,
      pov: input.pov || undefined,
      tense: input.tense || undefined,
    });
    await ensureBuiltinTypes(created.id);
    if (input.seedFromProjectId && input.seedTypeSlugs?.length) {
      const { seedCodexTypesFromProject } = await import("./seedCodexTypes");
      await seedCodexTypesFromProject(
        input.seedFromProjectId,
        created.id,
        input.seedTypeSlugs,
      );
    }
    await get().refreshProjects();
    await get().loadProject(created.id);
    return created;
  },

  deleteProjectById: async (projectId) => {
    const { projects, currentProjectId } = get();
    if (projects.length <= 1) {
      throw new Error("Cannot delete the last project in the workspace");
    }

    const deletingCurrent = currentProjectId === projectId;
    await deleteProjectRow(projectId);
    await get().refreshProjects();

    if (deletingCurrent) {
      const nextId = get().projects[0]?.id ?? FALLBACK_PROJECT_ID;
      await get().loadProject(nextId);
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

/** Current Project row hook for React components. */
export function useCurrentProject(): Project | undefined {
  const currentProjectId = useCurrentProjectId();
  return useProjectStore((s) =>
    s.projects.find((p) => p.id === currentProjectId),
  );
}
