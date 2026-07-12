import { create } from "zustand";
import { useSettingsStore } from "@/features/settings/settingsStore";
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
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import {
  blockIfUnlicensed,
  LICENSE_WRITE_RESTRICTED_ERROR,
} from "@/features/license/gate";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";

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
let projectLoadCommitTail: Promise<void> = Promise.resolve();
let timelapseInitTail: Promise<void> = Promise.resolve();
let externalWriteFeedStartTail: Promise<void> = Promise.resolve();

function isCurrentProjectLoad(generation: number): boolean {
  return generation === loadProjectGeneration;
}

/**
 * Project store reloads mutate a shared set of singleton stores.  Once one has
 * started it cannot be cancelled halfway through, so serialize the commit
 * section and re-check authority before and after every awaited mutation.  A
 * newer load therefore always runs last, even if the older reload was already
 * in flight when it was superseded.
 */
async function commitProjectLoad<T>(operation: () => Promise<T>): Promise<T> {
  const run = projectLoadCommitTail.then(operation);
  projectLoadCommitTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Workspace-scoped app_settings key for the last active project. */
export const LAST_ACTIVE_PROJECT_KEY = "workspace.lastActiveProjectId";

async function readLastActiveProjectId(): Promise<string | null> {
  const { getSetting } = await import("@/features/settings/api");
  return getSetting(LAST_ACTIVE_PROJECT_KEY);
}

function resolveInitialProjectId(
  projectRows: Project[],
  savedId: string | null,
): string {
  if (projectRows.length === 0) return FALLBACK_PROJECT_ID;
  if (savedId && projectRows.some((p) => p.id === savedId)) return savedId;
  return projectRows[0]!.id;
}

/**
 * timelapse recorder / externalWriteFeed を触ってよい実行環境か。
 * VITEST では mocked db harness にチェーン tail SELECT を要求しない・タイマー
 * や promise をテストファイル間にリークさせないため、SSR (window なし) では
 * そもそも記録対象が無いためスキップする。
 */
function isRealBrowserRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    !(
      typeof import.meta !== "undefined" &&
      (import.meta as { vitest?: boolean }).vitest
    ) &&
    !(typeof process !== "undefined" && process.env?.VITEST)
  );
}

function scheduleTimelapseInitialization(
  projectId: string,
  generation: number,
): void {
  const run = timelapseInitTail.then(async () => {
    if (!isCurrentProjectLoad(generation)) return;

    const [toggle, recorder] = await Promise.all([
      import("@/features/timelapse/toggle"),
      import("@/features/timelapse/recorder"),
    ]);
    if (!isCurrentProjectLoad(generation)) return;

    // Drain the previous project's pending queue BEFORE calling
    // setRecorderEnabled so the flush still runs with the old project's
    // enabled=true state (flushNow is a no-op when the queue is empty).
    // workspace 切替後 (束縛無効中) はこの drain 自体が no-op — 旧
    // キューは beginWorkspaceSwitch で破棄済みで、ここで流すと旧
    // イベントが新 workspace の chain に混入する (M3 review C1)。
    await recorder.flushNow().catch(() => {});
    if (!isCurrentProjectLoad(generation)) return;

    const enabled = await toggle.isTimelapseEnabled(projectId);
    if (!isCurrentProjectLoad(generation)) return;

    // setRecorderEnabled must precede init: when disabled, init only binds
    // projectId and skips the chain-tail read (recorder.ts).
    recorder.setRecorderEnabled(enabled);
    const bound = await recorder.initRecorderForProject(projectId);
    if (!isCurrentProjectLoad(generation)) return;

    if (enabled && bound) {
      // default-ON 経路では明示トグルが無く scene baseline が焼かれない
      // ため、genesis (記録履歴が空) のとき一度だけ焼く。
      await toggle.ensureGenesisBaselines(projectId);
      if (!isCurrentProjectLoad(generation)) return;

      const { seedWorkspaceSnapshot } =
        await import("@/features/timelapse/seedSession");
      if (!isCurrentProjectLoad(generation)) return;
      await seedWorkspaceSnapshot(projectId);
    }
  });

  // Rebinds are serialized so an already-started stale init must finish before
  // the latest project binds.  This keeps the latest project authoritative.
  timelapseInitTail = run.catch((err) => {
    console.warn("[timelapse] recorder init failed", err);
  });
}

function scheduleExternalWriteFeedStart(
  projectId: string,
  generation: number,
): void {
  const run = externalWriteFeedStartTail.then(async () => {
    if (!isCurrentProjectLoad(generation)) return;

    const feed = await import("@/features/concurrency/externalWriteFeed");
    if (!isCurrentProjectLoad(generation)) return;

    await feed.startExternalWriteFeed(projectId);
    if (!isCurrentProjectLoad(generation)) {
      // A newer load has already stopped the previous feed. start may have
      // resumed after that stop while reading its cursor, so close it again;
      // the serialized latest start runs immediately after this task.
      feed.stopExternalWriteFeed();
      return;
    }

    const { setupAutoAcceptProseConsumer, drainProposedProse } =
      await import("@/features/agent-writes/autoAcceptFeed");
    if (!isCurrentProjectLoad(generation)) {
      feed.stopExternalWriteFeed();
      return;
    }

    setupAutoAcceptProseConsumer();
    await drainProposedProse(projectId);
    if (!isCurrentProjectLoad(generation)) {
      feed.stopExternalWriteFeed();
    }
  });

  // startExternalWriteFeed reads its initial cursor asynchronously. Serialize
  // starts so a late cursor read from A can never finish after B's start.
  externalWriteFeedStartTail = run.catch((err) => {
    console.warn("[externalWriteFeed] start failed", err);
  });
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  currentProjectId: null,
  projects: [],

  initCurrentProject: async () => {
    try {
      const projectRows = await listProjects();
      const savedId = await readLastActiveProjectId();
      const projectId = resolveInitialProjectId(projectRows, savedId);
      set({
        projects: projectRows,
        currentProjectId: projectId,
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
    // プロジェクト切替は reloadProjectData で tab/chat/map 等の in-memory 状態を
    // 破棄し owner エディタを作り替えるため、pending 中は止める (唯一の入口)。
    if (guardInlineAiPending()) {
      // 早期 return = project はロードされない = recorder の有効な束縛が
      // 存在しない。この場合「記録しない (warn 付き破棄)」が正しい挙動 —
      // ここで旧束縛のまま記録を再開すると、workspace 切替直後なら旧
      // イベントが新 workspace の hash chain へ混入する (r5 で命令的
      // resume を廃止した理由)。記録は次の正規 rebind
      // (initRecorderForProject) 完了で自動的に再開する。
      return;
    }
    const generation = ++loadProjectGeneration;
    const previousId = get().currentProjectId;
    const realBrowserRuntime = isRealBrowserRuntime();
    if (realBrowserRuntime) {
      const { stopExternalWriteFeed } =
        await import("@/features/concurrency/externalWriteFeed");
      if (!isCurrentProjectLoad(generation)) return;
      stopExternalWriteFeed();
    }
    try {
      const p = await getProject(projectId);
      if (!isCurrentProjectLoad(generation)) return;

      const [{ reloadProjectData }, { setSetting }] = await Promise.all([
        import("./reloadProjectData"),
        import("@/features/settings/api"),
      ]);
      if (!isCurrentProjectLoad(generation)) return;

      await commitProjectLoad(async () => {
        if (!isCurrentProjectLoad(generation)) return;

        useGlobalHistoryStore.getState().clear();
        // reloadProjectData 内の各ストアは getCurrentProjectId() を読むため、
        // serialized commit の直前に currentProjectId を確定させる。
        set({ currentProjectId: projectId });

        if (p?.language && typeof document !== "undefined") {
          document.documentElement.lang = p.language;
        }
        if (p?.language) {
          // Re-point settings defaults at the project's language (en gets
          // Literata / 1.6 line-height / smart quotes etc. for *unset* keys).
          useSettingsStore.getState().applyProjectLanguage(p.language);
        }
        if (p?.phaseResolutionMode) {
          usePhaseStore.getState().setResolutionMode(p.phaseResolutionMode);
        }

        await reloadProjectData(projectId);
        if (!isCurrentProjectLoad(generation)) return;

        await setSetting(LAST_ACTIVE_PROJECT_KEY, projectId);
        if (!isCurrentProjectLoad(generation)) return;

        // Both background integrations have their own serialized tails and
        // repeat this generation check after every await. A late A task cannot
        // finish after (or overwrite) B's authoritative binding.
        if (realBrowserRuntime) {
          scheduleTimelapseInitialization(projectId, generation);
          scheduleExternalWriteFeedStart(projectId, generation);
        }
      });
    } catch (e) {
      // A superseded load is cancellation, not a failure. In particular it
      // must not roll currentProjectId back after the newer load has committed.
      if (!isCurrentProjectLoad(generation)) return;
      // 切替失敗 — パネルがロードされていない Project を指したままにしない。
      set({ currentProjectId: previousId });
      // recorder はここで触らない (r5): project がロードされていない =
      // 有効な束縛が存在しないので「記録しない (warn 付き破棄)」が正しい。
      // 記録は次の正規 rebind (initRecorderForProject) 完了で自動再開する。
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
      // 組み込み Codex タイプを project 言語でシード (en=英語ラベル)。
      await ensureBuiltinTypes(created.id, created.language);
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
  const fromList = useProjectStore
    .getState()
    .projects.find((p) => p.id === id)?.language;
  if (fromList) return fromList;
  // loadProject は settingsStore.projectLanguage を更新するが、projects 一覧が
  // 空/古いとき getCurrentProjectLanguage が "ja" に落ちて英語文が分割されない
  // （Alt+Shift 色帯・swap が無反応になる）のを防ぐ。
  const fromSettings = useSettingsStore.getState().projectLanguage;
  if (fromSettings) return fromSettings;
  return "ja";
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
