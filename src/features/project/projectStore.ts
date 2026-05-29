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
    try {
      const projectRows = await listProjects();
      set({ projects: projectRows });
    } catch {
      // 一覧の一時的な取得失敗で切替 UI を空にしない。前回の一覧を保持する。
    }
  },

  loadProject: async (projectId) => {
    const previousId = get().currentProjectId;
    // reloadProjectData 内の各ストアは getCurrentProjectId() を読むため、
    // 再ロード前に currentProjectId を確定させておく必要がある。
    set({ currentProjectId: projectId });
    try {
      const p = await getProject(projectId);
      if (p?.language && typeof document !== "undefined") {
        document.documentElement.lang = p.language;
      }
      if (p?.phaseResolutionMode) {
        usePhaseStore.getState().setResolutionMode(p.phaseResolutionMode);
      }
      const { reloadProjectData } = await import("./reloadProjectData");
      await reloadProjectData(projectId);
      // 執筆タイムラプス recorder を本 project に bind。失敗しても本流は止めない
      // (chain init は best-effort、次の event で再試行される)。記録の ON/OFF は
      // per-project 設定 (timelapse.enabled, 既定 ON) で決まる (§15.5)。
      // 執筆タイムラプス recorder: real browser only. Skip in tests and SSR
      // — VITEST env signals vitest; tauri-host process has neither flag.
      if (
        typeof window !== "undefined" &&
        !(
          typeof import.meta !== "undefined" &&
          (import.meta as { vitest?: boolean }).vitest
        ) &&
        !(typeof process !== "undefined" && process.env?.VITEST)
      ) {
        void (async () => {
          const { isTimelapseEnabled } =
            await import("@/features/timelapse/toggle");
          const { setRecorderEnabled, initRecorderForProject } =
            await import("@/features/timelapse/recorder");
          // setRecorderEnabled must precede init: when disabled, init only
          // binds projectId and skips the chain-tail read (recorder.ts).
          setRecorderEnabled(await isTimelapseEnabled(projectId));
          await initRecorderForProject(projectId);
        })().catch((err) =>
          console.warn("[timelapse] recorder init failed", err),
        );
      }
    } catch (e) {
      // 切替失敗 — パネルがロードされていない Project を指したままにしない。
      set({ currentProjectId: previousId });
      throw e;
    }
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
    try {
      await ensureBuiltinTypes(created.id);
      const { seedProjectSettingsFromDefaults } =
        await import("@/features/settings/migration");
      await seedProjectSettingsFromDefaults(created.id);
      if (input.seedFromProjectId && input.seedTypeSlugs?.length) {
        const { seedCodexTypesFromProject } = await import("./seedCodexTypes");
        await seedCodexTypesFromProject(
          input.seedFromProjectId,
          created.id,
          input.seedTypeSlugs,
        );
      }
    } catch (e) {
      // 初期化途中で失敗したら projects 行ごと巻き戻し、半端な Project を
      // 残さない。FK ON DELETE CASCADE が部分コピーされた codex 行も除去する。
      await deleteProjectRow(created.id).catch(() => {});
      throw e;
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
