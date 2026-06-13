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
import {
  blockIfUnlicensed,
  LICENSE_WRITE_RESTRICTED_ERROR,
} from "@/features/license/gate";

interface CreateProjectInput {
  title: string;
  genre?: string;
  language?: string;
  pov?: string;
  tense?: string;
  /** Record a writing timelapse for this project (default ON). */
  timelapseEnabled?: boolean;
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

let loadProjectGeneration = 0;

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
    const generation = ++loadProjectGeneration;
    const previousId = get().currentProjectId;
    if (
      typeof window !== "undefined" &&
      !(
        typeof import.meta !== "undefined" &&
        (import.meta as { vitest?: boolean }).vitest
      ) &&
      !(typeof process !== "undefined" && process.env?.VITEST)
    ) {
      const { stopExternalWriteFeed } =
        await import("@/features/concurrency/externalWriteFeed");
      stopExternalWriteFeed();
    }
    // reloadProjectData 内の各ストアは getCurrentProjectId() を読むため、
    // 再ロード前に currentProjectId を確定させておく必要がある。
    set({ currentProjectId: projectId });
    try {
      const p = await getProject(projectId);
      if (p?.language && typeof document !== "undefined") {
        document.documentElement.lang = p.language;
      }
      if (p?.language) {
        // Re-point settings defaults at the project's language (en gets
        // Literata / 1.6 line-height / smart quotes etc. for *unset* keys).
        // Dynamic import keeps projectStore free of a settings-store cycle.
        const { useSettingsStore } =
          await import("@/features/settings/settingsStore");
        useSettingsStore.getState().applyProjectLanguage(p.language);
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
          const { isTimelapseEnabled, ensureGenesisBaselines } =
            await import("@/features/timelapse/toggle");
          const { flushNow, setRecorderEnabled, initRecorderForProject } =
            await import("@/features/timelapse/recorder");
          // Drain the previous project's pending queue BEFORE calling
          // setRecorderEnabled so the flush still runs with the old project's
          // enabled=true state (flushNow is a no-op when the queue is empty).
          await flushNow().catch(() => {});
          // setRecorderEnabled must precede init: when disabled, init only
          // binds projectId and skips the chain-tail read (recorder.ts).
          const enabled = await isTimelapseEnabled(projectId);
          setRecorderEnabled(enabled);
          await initRecorderForProject(projectId);
          // §17 P0.4: 毎セッション開始時に現在のレイアウトを seed snapshot として
          // 焼き、replay の初期 UI 状態を確定させる (forward layout イベントの起点)。
          if (enabled) {
            // default-ON 経路では明示トグルが無く scene baseline が焼かれない
            // ため、genesis (記録履歴が空) のとき一度だけ焼く。これが無いと
            // 記録 ON 前から本文のあるシーンが動画 export で replay 不能になる。
            await ensureGenesisBaselines(projectId);
            const { seedWorkspaceSnapshot } =
              await import("@/features/timelapse/seedSession");
            await seedWorkspaceSnapshot(projectId);
          }
        })().catch((err) =>
          console.warn("[timelapse] recorder init failed", err),
        );
      }
      if (
        typeof window !== "undefined" &&
        !(
          typeof import.meta !== "undefined" &&
          (import.meta as { vitest?: boolean }).vitest
        ) &&
        !(typeof process !== "undefined" && process.env?.VITEST)
      ) {
        if (generation === loadProjectGeneration) {
          void import("@/features/concurrency/externalWriteFeed").then(
            ({ startExternalWriteFeed }) => {
              if (generation !== loadProjectGeneration) return;
              void startExternalWriteFeed(projectId)
                .then(() => import("@/features/agent-writes/autoAcceptFeed"))
                .then(
                  ({ setupAutoAcceptProseConsumer, drainProposedProse }) => {
                    if (generation !== loadProjectGeneration) return;
                    // Register the live auto-apply handler (idempotent) and sweep
                    // the proposed-prose backlog accumulated while closed.
                    setupAutoAcceptProseConsumer();
                    void drainProposedProse(projectId);
                  },
                )
                .catch((err) =>
                  console.warn("[externalWriteFeed] start failed", err),
                );
            },
          );
        }
      }
    } catch (e) {
      // 切替失敗 — パネルがロードされていない Project を指したままにしない。
      set({ currentProjectId: previousId });
      throw e;
    }
  },

  createNewProject: async (input) => {
    if (blockIfUnlicensed()) throw new Error(LICENSE_WRITE_RESTRICTED_ERROR);
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
      // 執筆タイムラプスの記録可否を明示保存。seedProjectSettingsFromDefaults は
      // global default からのシードでフォーム入力を拾わないため、作成フォームの
      // 値はここで直接書く (canonical key: timelapse.enabled, 既定 ON)。
      const { setProjectSetting } = await import("@/features/settings/api");
      await setProjectSetting(
        created.id,
        "timelapse.enabled",
        String(input.timelapseEnabled ?? true),
      );
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

/**
 * Current Project language for non-React modules (post-effect run callbacks
 * read this imperatively alongside model/projectId). Falls back to "ja" so
 * existing projects without an explicit language keep Japanese prompts.
 */
export function getCurrentProjectLanguage(): string {
  const id = useProjectStore.getState().currentProjectId;
  return (
    useProjectStore.getState().projects.find((p) => p.id === id)?.language ??
    "ja"
  );
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
