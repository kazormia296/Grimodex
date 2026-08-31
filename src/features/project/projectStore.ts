import { create } from "zustand";
import { PROJECT_ID as FALLBACK_PROJECT_ID } from "./constants";
import {
  listProjects,
  getProject,
  createProject as createProjectRow,
  deleteProject as deleteProjectRow,
  type Project,
} from "./api";
import { ensureBuiltinTypes } from "@/features/codex/typeApi";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import {
  blockIfUnlicensed,
  LICENSE_WRITE_RESTRICTED_ERROR,
} from "@/features/license/gate";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { flushStrictQuiescence } from "@/application/lifecycle/quiescenceCoordinator";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { debugLog } from "@/lib/debugLog";
import { withProjectLoad, type ProjectLoadContext } from "./projectLoadGate";
import { acquireQuiescenceLeaseAfterTimelapseGenesis } from "@/features/timelapse/genesisQuiescence";
import { acquireQuiescenceLease } from "@/application/lifecycle/quiescenceLease";
import { clearRetainedEditorRecoveryDraftsForScopeChange } from "@/features/editor/editorSaveRegistry";
import {
  getCurrentWorkspaceIdentity,
  subscribeCurrentWorkspaceIdentity,
  type WorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import { setCurrentRuntimeProjectId } from "@/runtime/projectIdentity";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
import { runProjectLoadWithFailureToast } from "./projectLoadFailure";
import {
  applyProjectMetadata,
  getFallbackProjectLanguage,
  initializeProjectTimelapse,
  prepareExternalWriteFeedStop,
  startProjectExternalWriteFeed,
} from "@/application/project/projectRuntime";
import {
  getCurrentProjectId,
  publishCurrentProjectId,
} from "@/application/project/currentProjectAuthority";
import type { LifecycleTransitionTrace } from "@/application/lifecycle/lifecycleTrace";
import {
  beginTimelapseGenesisBarrier,
  hasFailedTimelapseGenesisBarrier,
  registerTimelapseGenesisRetry,
  _resetTimelapseGenesisBarriersForTests,
  type TimelapseGenesisBarrierLease,
} from "@/features/timelapse/genesisBarrier";

export { getCurrentProjectId } from "@/application/project/currentProjectAuthority";

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

interface ProjectLoadLifecycleOptions {
  /** Workspace-owned reload skips a post-swap flush of old-scope editors. */
  // The old UI was already drained before the native binding changed.
  skipStrictQuiescence?: boolean;
  /** Generation that the prepared critical snapshots will belong to. */
  workspaceOpenRevision?: number;
  /** Native Workspace path available before renderer identity publication. */
  expectedWorkspacePath?: string;
  lifecycleTiming?: import("@/application/project/ProjectLifecycleRegistry").ProjectLifecycleTimingObserver;
}

interface ProjectState {
  /** The Project currently open in the editor. `null` until initCurrentProject resolves. */
  currentProjectId: string | null;
  /** Cached project list for switcher UI. */
  projects: Project[];
  projectLoadStatus: "idle" | "loading" | "ready" | "degraded" | "recovering";
  degradedParticipants: string[];
  /** Resolve which Project is current from the DB. Called once on workspace open. */
  initCurrentProject: () => Promise<void>;
  /** Refresh cached project list from DB. */
  refreshProjects: () => Promise<void>;
  /** Make a Project active: set it as current, apply metadata, reload panels. */
  loadProject: (projectId: string) => Promise<void>;
  /** Internal re-entrant phase used by create/delete while they own the gate. */
  loadProjectWithinLifecycle: (
    projectId: string,
    context: ProjectLoadContext,
    options?: ProjectLoadLifecycleOptions,
  ) => Promise<void>;
  /** Create a new Project and switch to it. */
  createNewProject: (input: CreateProjectInput) => Promise<Project>;
  /** Delete a Project. Switches away if deleting the current one. */
  deleteProjectById: (projectId: string) => Promise<void>;
}

let loadProjectGeneration = 0;
let projectStrictQuiescenceTail: Promise<void> = Promise.resolve();
let projectLoadCommitTail: Promise<void> = Promise.resolve();
let timelapseInitTail: Promise<void> = Promise.resolve();
let externalWriteFeedStartTail: Promise<void> = Promise.resolve();
let refreshProjectsGeneration = 0;
let lastNonLoadingProjectPresentation: {
  projectLoadStatus: Exclude<ProjectState["projectLoadStatus"], "loading">;
  degradedParticipants: string[];
} | null = null;
const pendingProjectBackgroundMutations = new Set<Promise<void>>();
const projectBackgroundMutationFailures: unknown[] = [];
const timelapseGenesisFailures = new Map<string, unknown>();
const deletedProjectIds = new Set<string>();
let deferredProjectBackgroundActivation: {
  projectId: string;
  generation: number;
  genesisBarrier: TimelapseGenesisBarrierLease;
} | null = null;
let deferredExternalWriteFeedStart: {
  projectId: string;
  generation: number;
  timelapseReady: Promise<void>;
  expectedWorkspacePath: string;
  expectedWorkspaceOpenRevision: number | undefined;
} | null = null;

function isCurrentProjectLoad(generation: number): boolean {
  return generation === loadProjectGeneration;
}

/**
 * Overlapping loads may supersede an earlier request after it published the
 * transient `loading` state. Preserve the last non-loading presentation so a
 * newer request that fails before commit restores a usable old Project status
 * instead of treating the superseded request's spinner as stable state.
 */
function capturePreviousProjectState(state: ProjectState): {
  currentProjectId: string | null;
  projectLoadStatus: ProjectState["projectLoadStatus"];
  degradedParticipants: string[];
} {
  if (state.projectLoadStatus !== "loading") {
    lastNonLoadingProjectPresentation = {
      projectLoadStatus: state.projectLoadStatus,
      degradedParticipants: [...state.degradedParticipants],
    };
  }
  const presentation = lastNonLoadingProjectPresentation ?? {
    projectLoadStatus: "idle" as const,
    degradedParticipants: [],
  };
  return {
    currentProjectId: state.currentProjectId,
    projectLoadStatus:
      state.projectLoadStatus === "loading"
        ? presentation.projectLoadStatus
        : state.projectLoadStatus,
    degradedParticipants:
      state.projectLoadStatus === "loading"
        ? [...presentation.degradedParticipants]
        : [...state.degradedParticipants],
  };
}

interface ProjectBackgroundAuthority {
  generation: number;
  mutation: MutationAuthority;
}

function captureProjectBackgroundAuthority(
  projectId: string,
  _generation: number,
): ProjectBackgroundAuthority {
  return {
    generation: _generation,
    mutation: captureMutationAuthority(projectId, getCurrentProjectId),
  };
}

function canStartProjectBackgroundMutation(
  authority: ProjectBackgroundAuthority,
): boolean {
  return (
    isCurrentProjectLoad(authority.generation) &&
    isCurrentMutationAuthority(authority.mutation)
  );
}

function trackProjectBackgroundMutation(
  task: Promise<void>,
  recordFailure: boolean = true,
): void {
  pendingProjectBackgroundMutations.add(task);
  void task.then(
    () => pendingProjectBackgroundMutations.delete(task),
    (error: unknown) => {
      pendingProjectBackgroundMutations.delete(task);
      if (recordFailure) projectBackgroundMutationFailures.push(error);
    },
  );
}

async function awaitPendingProjectBackgroundMutations(): Promise<void> {
  while (pendingProjectBackgroundMutations.size > 0) {
    await Promise.allSettled([...pendingProjectBackgroundMutations]);
  }
  // Report each completed failure once. Stateful writers retain their own
  // retry material (notably recorder.queue), and later quiescence stages retry
  // it; permanently replaying this historical error would make retry/close
  // impossible even after that retry succeeds.
  const failures = projectBackgroundMutationFailures.splice(0);
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      failures.length === 1 && failures[0] instanceof Error
        ? failures[0].message
        : "One or more Project background mutations failed",
    );
  }
}

registerQuiescenceProvider({
  id: createQuiescenceProviderId("project-background-mutations"),
  stage: "scoped-mutations",
  flush: awaitPendingProjectBackgroundMutations,
});

/** Invalidates every async Project load/list refresh before a Workspace swap. */
export function invalidateProjectLoadsForWorkspaceSwitch(): void {
  loadProjectGeneration++;
  refreshProjectsGeneration++;
  deletedProjectIds.clear();
  deferredProjectBackgroundActivation = null;
}

function isCurrentWorkspaceRefresh(
  generation: number,
  identity: WorkspaceIdentity | null,
): boolean {
  if (generation !== refreshProjectsGeneration) return false;
  const current = getCurrentWorkspaceIdentity();
  if (identity === null || current === null) return identity === current;
  return (
    identity.path === current.path &&
    identity.openRevision === current.openRevision
  );
}

class ProjectLifecycleAuthorityChangedError extends Error {
  constructor() {
    super("Project lifecycle authority changed");
    this.name = "ProjectLifecycleAuthorityChangedError";
  }
}

function assertProjectLifecycleAuthority(
  generation: number,
  authority: MutationAuthority,
): void {
  if (
    !isCurrentProjectLoad(generation) ||
    !isCurrentMutationAuthority(authority)
  ) {
    throw new ProjectLifecycleAuthorityChangedError();
  }
}

function isCurrentLifecycleWorkspace(authority: MutationAuthority): boolean {
  const workspace = getCurrentWorkspaceIdentity();
  return (
    (workspace?.path ?? null) === authority.workspacePath &&
    (workspace?.openRevision ?? null) === authority.workspaceOpenRevision
  );
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

/**
 * Serialize the destructive preflush phase across overlapping Project
 * requests. A newer request receives its generation before joining this tail,
 * so it still supersedes the older request immediately. It opens target reads
 * only after every older flush — including its read-cancelling final IPC stage
 * — has settled.
 */
async function flushProjectStrictQuiescence(
  transition?: LifecycleTransitionTrace | null,
): Promise<void> {
  const run = projectStrictQuiescenceTail.then(() =>
    flushStrictQuiescence(undefined, { transition }),
  );
  projectStrictQuiescenceTail = run.then(
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
  _generation: number,
  genesisBarrier: TimelapseGenesisBarrierLease,
  expectedWorkspacePath?: string,
): Promise<void> {
  const mutationAuthority = captureMutationAuthority(
    projectId,
    getCurrentProjectId,
  );
  const canMutate = () => isCurrentMutationAuthority(mutationAuthority);
  const run = timelapseInitTail.then(async () => {
    if (!canMutate()) {
      genesisBarrier.abort("Project mutation authority changed before start");
      return;
    }
    try {
      await initializeProjectTimelapse({
        projectId,
        expectedWorkspacePath,
        canStart: canMutate,
        isMutationCurrent: canMutate,
      });
      if (!canMutate()) {
        genesisBarrier.abort(
          "Project mutation authority changed during initialization",
        );
        return;
      }
      genesisBarrier.complete();
      timelapseGenesisFailures.delete(projectId);
    } catch (error) {
      genesisBarrier.fail(error);
      timelapseGenesisFailures.set(projectId, error);
      throw error;
    }
  });
  // Genesis failure remains represented by its closed barrier and retry map;
  // do not also accumulate historical generic failures that would veto a
  // later successful same-Project recovery.
  trackProjectBackgroundMutation(run, false);

  // Rebinds are serialized so an already-started stale init must finish before
  // the latest project binds.  This keeps the latest project authoritative.
  timelapseInitTail = run.catch((_error) => {
    debugLog.warn("timelapse", "recorder init failed", {
      sensitivity: "safe",
      fields: {
        operation: "initializeRecorder",
        outcome: "failed",
      },
    });
  });
  return run;
}

async function retryFailedTimelapseGenesisForCurrentProject(
  projectId: string,
): Promise<void> {
  if (
    getCurrentProjectId() !== projectId ||
    !hasFailedTimelapseGenesisBarrier(projectId)
  ) {
    return;
  }
  await scheduleTimelapseInitialization(
    projectId,
    loadProjectGeneration,
    beginTimelapseGenesisBarrier(projectId),
  );
}

registerTimelapseGenesisRetry(retryFailedTimelapseGenesisForCurrentProject);

function scheduleExternalWriteFeedStart(
  projectId: string,
  generation: number,
  timelapseReady: Promise<void> = Promise.resolve(),
): void {
  const authority = captureProjectBackgroundAuthority(projectId, generation);
  const run = externalWriteFeedStartTail.then(async () => {
    try {
      await timelapseReady;
    } catch {
      // Genesis remains fail-closed and owns the reported background failure.
      // Do not consume a prose backlog whose body writer would be rejected by
      // the same barrier.
      return;
    }
    await startProjectExternalWriteFeed({
      projectId,
      canStart: () => canStartProjectBackgroundMutation(authority),
      isMutationCurrent: () => isCurrentMutationAuthority(authority.mutation),
    });
  });
  trackProjectBackgroundMutation(run);

  // startExternalWriteFeed reads its initial cursor asynchronously. Serialize
  // starts so a late cursor read from A can never finish after B's start.
  externalWriteFeedStartTail = run.catch((_error) => {
    debugLog.warn("externalWriteFeed", "start failed", {
      sensitivity: "safe",
      fields: {
        operation: "start",
        outcome: "failed",
      },
    });
  });
}

function scheduleOrDeferExternalWriteFeedStart(
  projectId: string,
  generation: number,
  timelapseReady: Promise<void>,
  expectedWorkspacePath?: string,
  expectedWorkspaceOpenRevision?: number,
): void {
  if (expectedWorkspacePath) {
    const identity = getCurrentWorkspaceIdentity();
    if (
      identity?.path !== expectedWorkspacePath ||
      (expectedWorkspaceOpenRevision !== undefined &&
        identity.openRevision !== expectedWorkspaceOpenRevision)
    ) {
      deferredExternalWriteFeedStart = {
        projectId,
        generation,
        timelapseReady,
        expectedWorkspacePath,
        expectedWorkspaceOpenRevision,
      };
      return;
    }
  }
  deferredExternalWriteFeedStart = null;
  scheduleExternalWriteFeedStart(projectId, generation, timelapseReady);
}

function presentTimelapseGenesisFailure(
  projectId: string,
  generation: number,
): void {
  if (
    !isCurrentProjectLoad(generation) ||
    getCurrentProjectId() !== projectId
  ) {
    return;
  }
  let newlyDegraded = false;
  useProjectStore.setState((state) => {
    if (state.degradedParticipants.includes("timelapse-genesis")) return state;
    newlyDegraded = true;
    return {
      projectLoadStatus: "degraded",
      degradedParticipants: [
        ...state.degradedParticipants,
        "timelapse-genesis",
      ],
    };
  });
  if (!newlyDegraded) return;
  toast.warning(i18next.t("project.loadDegraded"), {
    action: {
      label: i18next.t("common.retry"),
      onClick: () =>
        void runProjectLoadWithFailureToast(() =>
          useProjectStore.getState().loadProject(projectId),
        ),
    },
  });
}

function activateProjectBackgroundIntegrations(
  projectId: string,
  generation: number,
  existingGenesisBarrier?: TimelapseGenesisBarrierLease,
): void {
  const genesisBarrier =
    existingGenesisBarrier ?? beginTimelapseGenesisBarrier(projectId);
  if (
    !isCurrentProjectLoad(generation) ||
    getCurrentProjectId() !== projectId
  ) {
    genesisBarrier.abort("Project activation became stale");
    return;
  }
  // A same-path Workspace reopen performs its explicit Project hydrate before
  // publishing the new openRevision. Capturing null here would make both tails
  // stale immediately after publication, so defer activation to the identity
  // publication boundary.
  if (getCurrentWorkspaceIdentity() === null) {
    deferredProjectBackgroundActivation?.genesisBarrier.abort(
      "superseded deferred Project activation",
    );
    deferredProjectBackgroundActivation = {
      projectId,
      generation,
      genesisBarrier,
    };
    return;
  }
  deferredProjectBackgroundActivation = null;
  deferredExternalWriteFeedStart = null;
  const timelapseReady = scheduleTimelapseInitialization(
    projectId,
    generation,
    genesisBarrier,
  );
  scheduleExternalWriteFeedStart(projectId, generation, timelapseReady);
}

/** Test hooks for the browser-only background integration path. */
export function _scheduleExternalWriteFeedStartForTests(
  projectId: string,
): void {
  scheduleExternalWriteFeedStart(projectId, loadProjectGeneration);
}

export function _scheduleTimelapseInitializationForTests(
  projectId: string,
): void {
  scheduleTimelapseInitialization(
    projectId,
    loadProjectGeneration,
    beginTimelapseGenesisBarrier(projectId),
  );
}

export function _scheduleWorkspaceBackgroundIntegrationsForTests(
  projectId: string,
  expectedWorkspacePath: string,
  expectedWorkspaceOpenRevision: number,
): void {
  const timelapseReady = scheduleTimelapseInitialization(
    projectId,
    loadProjectGeneration,
    beginTimelapseGenesisBarrier(projectId),
    expectedWorkspacePath,
  );
  scheduleOrDeferExternalWriteFeedStart(
    projectId,
    loadProjectGeneration,
    timelapseReady,
    expectedWorkspacePath,
    expectedWorkspaceOpenRevision,
  );
}

export function _activateProjectBackgroundIntegrationsForTests(
  projectId: string,
): void {
  activateProjectBackgroundIntegrations(projectId, loadProjectGeneration);
}

export function _presentTimelapseGenesisFailureForTests(
  projectId: string,
): void {
  presentTimelapseGenesisFailure(projectId, loadProjectGeneration);
}

export function _resetProjectBackgroundMutationsForTests(): void {
  _resetTimelapseGenesisBarriersForTests();
  pendingProjectBackgroundMutations.clear();
  projectBackgroundMutationFailures.length = 0;
  timelapseGenesisFailures.clear();
  deferredProjectBackgroundActivation = null;
  deferredExternalWriteFeedStart = null;
  timelapseInitTail = Promise.resolve();
  externalWriteFeedStartTail = Promise.resolve();
  projectStrictQuiescenceTail = Promise.resolve();
  projectLoadCommitTail = Promise.resolve();
  lastNonLoadingProjectPresentation = null;
}

export const useProjectStore = create<ProjectState>()((set, get) => ({
  currentProjectId: null,
  projects: [],
  projectLoadStatus: "idle",
  degradedParticipants: [],

  initCurrentProject: async () => {
    // A Workspace rebind is authoritative over every Project lookup or
    // hydration started against the previous database.
    invalidateProjectLoadsForWorkspaceSwitch();
    const projectRows = await listProjects();
    const savedId = await readLastActiveProjectId();
    const projectId = resolveInitialProjectId(projectRows, savedId);
    set({
      projects: projectRows,
      currentProjectId: projectId,
    });
  },

  refreshProjects: async () => {
    const generation = ++refreshProjectsGeneration;
    const workspaceIdentity = getCurrentWorkspaceIdentity();
    try {
      const projectRows = await listProjects();
      if (!isCurrentWorkspaceRefresh(generation, workspaceIdentity)) return;
      set({ projects: projectRows });
    } catch {
      // 一覧の一時的な取得失敗で切替 UI を空にしない。前回の一覧を保持する。
    }
  },

  loadProject: async (projectId) => {
    return withProjectLoad((context) =>
      get().loadProjectWithinLifecycle(projectId, context),
    );
  },

  loadProjectWithinLifecycle: async (projectId, context, options) => {
    return withProjectLoad(async () => {
      if (options?.skipStrictQuiescence && context.owner !== "workspace") {
        throw new Error(
          "Only a Workspace-owned Project load may skip strict quiescence",
        );
      }
      // A failed genesis owns no durable body mutation and can be retried
      // before acquiring the Project quiescence lease. Retrying after lease
      // acquisition would self-deadlock on its own Native reads/writes.
      const workspaceIdentity = getCurrentWorkspaceIdentity();
      const quiescenceLease =
        context.owner === "project"
          ? await acquireQuiescenceLeaseAfterTimelapseGenesis("project-load", {
              transition: {
                kind: "project",
                from: {
                  workspacePath: workspaceIdentity?.path ?? null,
                  workspaceOpenRevision:
                    workspaceIdentity?.openRevision ?? null,
                  projectId: get().currentProjectId,
                },
                to: {
                  workspacePath: workspaceIdentity?.path ?? null,
                  workspaceOpenRevision:
                    workspaceIdentity?.openRevision ?? null,
                  projectId,
                },
              },
            })
          : acquireQuiescenceLease("project-load");
      try {
        // プロジェクト切替は reloadProjectData で tab/chat/map 等の in-memory 状態を
        // 破棄し owner エディタを作り替えるため、pending 中は止める (唯一の入口)。
        if (guardInlineAiPending()) {
          if (context.owner === "workspace") {
            throw new Error(
              "Inline AI became pending during Workspace Project hydration",
            );
          }
          // 早期 return = project はロードされない = recorder の有効な束縛が
          // 存在しない。この場合「記録しない (warn 付き破棄)」が正しい挙動 —
          // ここで旧束縛のまま記録を再開すると、workspace 切替直後なら旧
          // イベントが新 workspace の hash chain へ混入する (r5 で命令的
          // resume を廃止した理由)。記録は次の正規 rebind
          // (initRecorderForProject) 完了で自動的に再開する。
          return;
        }
        // Project reload destroys every project-scoped editor/store. Treat it like
        // Workspace replacement: a failed persistence surface vetoes the switch
        // while the old Project is still fully authoritative.
        if (!options?.skipStrictQuiescence) {
          await flushProjectStrictQuiescence(quiescenceLease.transition);
          clearRetainedEditorRecoveryDraftsForScopeChange();
        }
        const generation = ++loadProjectGeneration;
        quiescenceLease.openTargetReadPhase();
        if (!isCurrentProjectLoad(generation)) return;
        const previousState = capturePreviousProjectState(get());
        const previousId = previousState.currentProjectId;
        const realBrowserRuntime = isRealBrowserRuntime();
        set({ projectLoadStatus: "loading", degradedParticipants: [] });
        let committed = false;
        let genesisBarrier: TimelapseGenesisBarrierLease | null = null;
        let genesisActivationScheduled = false;
        let timelapseReady: Promise<void> | null = null;
        try {
          const p = await getProject(projectId);
          if (!isCurrentProjectLoad(generation)) return;
          if (!p) throw new Error(`Project not found: ${projectId}`);

          const [{ reloadProjectData }, { setSetting }, stopExternalWriteFeed] =
            await Promise.all([
              import("./reloadProjectData"),
              import("@/features/settings/api"),
              realBrowserRuntime
                ? prepareExternalWriteFeedStop()
                : Promise.resolve(null),
            ]);
          if (!isCurrentProjectLoad(generation)) return;

          await commitProjectLoad(async () => {
            if (!isCurrentProjectLoad(generation)) return;
            if (deletedProjectIds.has(projectId)) {
              throw new Error(`Project not found: ${projectId}`);
            }

            const commitPreparedProject = () => {
              if (!isCurrentProjectLoad(generation)) return false;
              if (realBrowserRuntime) {
                genesisBarrier = beginTimelapseGenesisBarrier(projectId);
              }
              quiescenceLease.sealReadsForAuthorityCommit();
              committed = true;
              stopExternalWriteFeed?.();
              useGlobalHistoryStore.getState().clear();
              set({ currentProjectId: projectId });
              applyProjectMetadata(p);
              quiescenceLease.transition?.advance("authority-commit");
              return true;
            };
            const result = await reloadProjectData(
              projectId,
              commitPreparedProject,
              options?.workspaceOpenRevision,
              () => {
                quiescenceLease.openTargetReadPhase();
                if (!realBrowserRuntime || !genesisBarrier) return;
                const expectedWorkspacePath =
                  options?.expectedWorkspacePath ??
                  getCurrentWorkspaceIdentity()?.path;
                if (!expectedWorkspacePath) {
                  throw new Error(
                    "Timelapse genesis requires a target Workspace path",
                  );
                }
                timelapseReady = scheduleTimelapseInitialization(
                  projectId,
                  generation,
                  genesisBarrier,
                  expectedWorkspacePath,
                );
                genesisActivationScheduled = true;
              },
              ...(options?.lifecycleTiming
                ? ([options.lifecycleTiming] as const)
                : []),
            );
            if (result?.cancelled) return;
            if (!isCurrentProjectLoad(generation)) return;
            if (options?.expectedWorkspacePath && timelapseReady) {
              // Workspace identity publication happens after this load returns.
              // Keep the provisional null identity stable through the complete
              // genesis pass, including projects with no mount writer to await.
              await timelapseReady;
            }

            const degraded = [...(result?.degraded ?? [])].map(
              ({ participantId }) => participantId,
            );
            if (
              timelapseGenesisFailures.has(projectId) &&
              !degraded.includes("timelapse-genesis")
            ) {
              degraded.push("timelapse-genesis");
            }
            try {
              await setSetting(LAST_ACTIVE_PROJECT_KEY, projectId);
            } catch {
              degraded.push("last-active-project");
            }
            if (!isCurrentProjectLoad(generation)) return;
            set({
              projectLoadStatus: degraded.length > 0 ? "degraded" : "ready",
              degradedParticipants: degraded,
            });
            quiescenceLease.transition?.advance("new-scope-hydrated");
            if (degraded.length > 0) {
              toast.warning(i18next.t("project.loadDegraded"), {
                action: {
                  label: i18next.t("common.retry"),
                  onClick: () =>
                    void runProjectLoadWithFailureToast(() =>
                      get().loadProject(projectId),
                    ),
                },
              });
            }

            if (!options?.expectedWorkspacePath && timelapseReady) {
              // Ordinary Project switching keeps genesis asynchronous. Attach
              // only after publishing the initial presentation: an already
              // rejected promise then degrades this state in the next
              // microtask instead of racing a later ready write that could
              // hide the failure.
              void timelapseReady.catch(() => {
                presentTimelapseGenesisFailure(projectId, generation);
              });
            }

            // Both integrations have serialized, quiescence-tracked tails.
            // Stale queued starts use the load generation; an already-started
            // task revalidates Workspace + Project authority at write boundaries.
            if (realBrowserRuntime) {
              if (!genesisActivationScheduled || !timelapseReady) {
                throw new Error(
                  "Timelapse genesis was not started after commit",
                );
              }
              scheduleOrDeferExternalWriteFeedStart(
                projectId,
                generation,
                timelapseReady,
                options?.expectedWorkspacePath,
                options?.workspaceOpenRevision,
              );
            }
          });
        } catch (e) {
          (genesisBarrier as TimelapseGenesisBarrierLease | null)?.abort(
            "Project load failed before activation completed",
          );
          genesisBarrier = null;
          genesisActivationScheduled = false;
          timelapseReady = null;
          quiescenceLease.openTargetReadPhase();
          // A superseded load is cancellation, not a failure. In particular it
          // must not roll currentProjectId back after the newer load has committed.
          if (!isCurrentProjectLoad(generation)) return;
          if (!committed) {
            // Critical preparation failed before the commit boundary. Every old
            // Project store and feed is still authoritative; no rollback needed.
            set({
              projectLoadStatus: previousState.projectLoadStatus,
              degradedParticipants: previousState.degradedParticipants,
            });
            throw e;
          }

          // An unexpected synchronous commit/legacy critical failure happened
          // after publication. Roll back by fully preparing and hydrating the old
          // Project; restoring only its id would create mixed singleton state.
          set({ projectLoadStatus: "recovering" });
          if (previousId) {
            try {
              const previousProject = await getProject(previousId);
              if (!previousProject) {
                throw new Error(`Previous Project not found: ${previousId}`, {
                  cause: e,
                });
              }
              const { reloadProjectData } = await import("./reloadProjectData");
              const commitPreviousProject = () => {
                if (!isCurrentProjectLoad(generation)) return false;
                if (realBrowserRuntime) {
                  genesisBarrier = beginTimelapseGenesisBarrier(previousId);
                }
                quiescenceLease.sealReadsForAuthorityCommit();
                set({ currentProjectId: previousId });
                applyProjectMetadata(previousProject);
                return true;
              };
              const rollbackResult = await reloadProjectData(
                previousId,
                commitPreviousProject,
                options?.workspaceOpenRevision,
                () => {
                  quiescenceLease.openTargetReadPhase();
                  if (!realBrowserRuntime || !genesisBarrier) return;
                  const expectedWorkspacePath =
                    options?.expectedWorkspacePath ??
                    getCurrentWorkspaceIdentity()?.path;
                  if (!expectedWorkspacePath) {
                    throw new Error(
                      "Rollback timelapse genesis requires a Workspace path",
                    );
                  }
                  timelapseReady = scheduleTimelapseInitialization(
                    previousId,
                    generation,
                    genesisBarrier,
                    expectedWorkspacePath,
                  );
                  genesisActivationScheduled = true;
                },
              );
              if (rollbackResult?.cancelled) {
                // Workspace acquisition or a newer Project load superseded this
                // recovery. The newer authority owns the next complete hydration.
                if (!isCurrentProjectLoad(generation)) return;
                throw new Error("Project rollback was cancelled", { cause: e });
              }
              if (!isCurrentProjectLoad(generation)) return;
              const rollbackDegraded = [
                ...(rollbackResult?.degraded ?? []),
              ].map(({ participantId }) => participantId);
              set({
                projectLoadStatus:
                  rollbackDegraded.length > 0 ? "degraded" : "ready",
                degradedParticipants: rollbackDegraded,
              });
              if (rollbackDegraded.length > 0) {
                toast.warning(i18next.t("project.loadDegraded"), {
                  action: {
                    label: i18next.t("common.retry"),
                    onClick: () =>
                      void runProjectLoadWithFailureToast(() =>
                        get().loadProject(previousId),
                      ),
                  },
                });
              }
              if (realBrowserRuntime) {
                if (!genesisActivationScheduled || !timelapseReady) {
                  throw new Error(
                    "Rollback timelapse genesis was not started after commit",
                    { cause: e },
                  );
                }
                scheduleExternalWriteFeedStart(
                  previousId,
                  generation,
                  timelapseReady,
                );
              }
            } catch (rollbackError) {
              set({
                projectLoadStatus: "recovering",
                degradedParticipants: ["project-rollback"],
              });
              throw new AggregateError(
                [e, rollbackError],
                "Project switch and rollback both failed",
                { cause: rollbackError },
              );
            }
          }
          throw e;
        } finally {
          if (!genesisActivationScheduled) {
            (genesisBarrier as TimelapseGenesisBarrierLease | null)?.abort(
              "Project activation ended before timelapse initialization was scheduled",
            );
          }
        }
      } finally {
        quiescenceLease.release();
      }
    }, context);
  },

  createNewProject: async (input) => {
    if (blockIfUnlicensed()) throw new Error(LICENSE_WRITE_RESTRICTED_ERROR);
    return withProjectLoad(async (context) => {
      const quiescenceLease =
        await acquireQuiescenceLeaseAfterTimelapseGenesis("project-load");
      const authority = captureMutationAuthority(
        getCurrentProjectId(),
        getCurrentProjectId,
      );
      const generation = ++loadProjectGeneration;
      try {
        await flushProjectStrictQuiescence();
        quiescenceLease.openTargetReadPhase();
        assertProjectLifecycleAuthority(generation, authority);

        const created = await commitProjectLoad(async () => {
          // Project publication is serialized by the same commit tail used by
          // loadProject. Once this check passes, a newer load may queue, but it
          // cannot replace currentProjectId until this initialization either
          // completes or rolls back.
          assertProjectLifecycleAuthority(generation, authority);
          const createdRow = await createProjectRow({
            id: crypto.randomUUID(),
            title: input.title.trim(),
            genre: input.genre || undefined,
            language: input.language || undefined,
            pov: input.pov || undefined,
            tense: input.tense || undefined,
          });
          deletedProjectIds.delete(createdRow.id);
          try {
            if (!isCurrentMutationAuthority(authority)) {
              throw new ProjectLifecycleAuthorityChangedError();
            }
            // 組み込み Codex タイプを project 言語でシード (en=英語ラベル)。
            await ensureBuiltinTypes(createdRow.id, createdRow.language);
            if (!isCurrentMutationAuthority(authority)) {
              throw new ProjectLifecycleAuthorityChangedError();
            }
            const { seedProjectSettingsFromDefaults } =
              await import("@/features/settings/migration");
            if (!isCurrentMutationAuthority(authority)) {
              throw new ProjectLifecycleAuthorityChangedError();
            }
            await seedProjectSettingsFromDefaults(createdRow.id);
            // 執筆タイムラプスの記録可否を明示保存。seedProjectSettingsFromDefaults は
            // global default からのシードでフォーム入力を拾わないため、作成フォームの
            // 値はここで直接書く (canonical key: timelapse.enabled, 既定 ON)。
            const { setProjectSetting } =
              await import("@/features/settings/api");
            if (!isCurrentMutationAuthority(authority)) {
              throw new ProjectLifecycleAuthorityChangedError();
            }
            await setProjectSetting(
              createdRow.id,
              "timelapse.enabled",
              String(input.timelapseEnabled ?? true),
            );
            if (input.seedFromProjectId && input.seedTypeSlugs?.length) {
              const { seedCodexTypesFromProject } =
                await import("./seedCodexTypes");
              if (!isCurrentMutationAuthority(authority)) {
                throw new ProjectLifecycleAuthorityChangedError();
              }
              await seedCodexTypesFromProject(
                input.seedFromProjectId,
                createdRow.id,
                input.seedTypeSlugs,
              );
            }
          } catch (error) {
            // 初期化途中で失敗したら projects 行ごと巻き戻し、半端な Project を
            // 残さない。FK ON DELETE CASCADE が部分コピーされた codex 行も除去する。
            // Authority が既に別 Workspace を指す異常経路では、同じ id の行を
            // replacement DB から消し得るため rollback 書込み自体を行わない。
            if (isCurrentMutationAuthority(authority)) {
              await deleteProjectRow(createdRow.id).catch(() => {});
            }
            throw error;
          }
          return createdRow;
        });

        await get().refreshProjects();
        // A later explicit Project selection wins over the create-and-switch
        // convenience. The new row remains valid and visible in the switcher.
        if (
          isCurrentProjectLoad(generation) &&
          isCurrentMutationAuthority(authority)
        ) {
          await get().loadProjectWithinLifecycle(created.id, context);
        }
        return created;
      } finally {
        quiescenceLease.release();
      }
    });
  },

  deleteProjectById: async (projectId) => {
    return withProjectLoad(async (context) => {
      const quiescenceLease =
        await acquireQuiescenceLeaseAfterTimelapseGenesis("project-load");
      const authority = captureMutationAuthority(
        getCurrentProjectId(),
        getCurrentProjectId,
      );
      const generation = ++loadProjectGeneration;
      try {
        await flushProjectStrictQuiescence();
        quiescenceLease.openTargetReadPhase();
        assertProjectLifecycleAuthority(generation, authority);

        const plan = await commitProjectLoad(async () => {
          assertProjectLifecycleAuthority(generation, authority);
          const projectRows = await listProjects();
          if (!isCurrentMutationAuthority(authority)) {
            throw new ProjectLifecycleAuthorityChangedError();
          }
          if (projectRows.length <= 1) {
            throw new Error("Cannot delete the last project in the workspace");
          }
          if (!projectRows.some((project) => project.id === projectId)) {
            throw new Error(`Project not found: ${projectId}`);
          }

          const deletingCurrent = get().currentProjectId === projectId;
          if (deletingCurrent) {
            const nextId =
              projectRows.find((project) => project.id !== projectId)?.id ??
              FALLBACK_PROJECT_ID;
            return { kind: "switch-before-delete" as const, nextId };
          }
          if (!isCurrentMutationAuthority(authority)) {
            throw new ProjectLifecycleAuthorityChangedError();
          }
          await deleteProjectRow(projectId);
          deletedProjectIds.add(projectId);
          return { kind: "deleted" as const };
        });

        if (plan.kind === "switch-before-delete") {
          // Two-phase delete: fully hydrate and publish a surviving Project
          // while the old row still exists. If preparation, commit, or rollback
          // fails, loadProject throws and this destructive phase is never run.
          await get().loadProjectWithinLifecycle(plan.nextId, context);
          // loadProject publishes the critical Project state before scheduling
          // recorder/feed tails. Those tails can still touch the old Project
          // (recorder drain), so they are part of phase one for deletion.
          await awaitPendingProjectBackgroundMutations();
          if (
            !isCurrentLifecycleWorkspace(authority) ||
            get().currentProjectId === projectId ||
            get().projectLoadStatus === "loading" ||
            get().projectLoadStatus === "recovering"
          ) {
            throw new ProjectLifecycleAuthorityChangedError();
          }
          const replacementAuthority = captureMutationAuthority(
            getCurrentProjectId(),
            getCurrentProjectId,
          );

          await commitProjectLoad(async () => {
            if (
              !isCurrentLifecycleWorkspace(authority) ||
              get().currentProjectId === projectId ||
              !isCurrentMutationAuthority(replacementAuthority)
            ) {
              throw new ProjectLifecycleAuthorityChangedError();
            }
            await deleteProjectRow(projectId);
            deletedProjectIds.add(projectId);
          });
        }
        await get().refreshProjects();
      } finally {
        quiescenceLease.release();
      }
    });
  },
}));

setCurrentRuntimeProjectId(FALLBACK_PROJECT_ID);
useProjectStore.subscribe((state, previous) => {
  if (state.currentProjectId === previous.currentProjectId) return;
  setCurrentRuntimeProjectId(state.currentProjectId ?? FALLBACK_PROJECT_ID);
});

subscribeCurrentWorkspaceIdentity((identity) => {
  if (!identity) return;
  if (deferredProjectBackgroundActivation) {
    const activation = deferredProjectBackgroundActivation;
    deferredProjectBackgroundActivation = null;
    activateProjectBackgroundIntegrations(
      activation.projectId,
      activation.generation,
      activation.genesisBarrier,
    );
  }
  const feed = deferredExternalWriteFeedStart;
  if (
    !feed ||
    identity.path !== feed.expectedWorkspacePath ||
    (feed.expectedWorkspaceOpenRevision !== undefined &&
      identity.openRevision !== feed.expectedWorkspaceOpenRevision)
  ) {
    return;
  }
  deferredExternalWriteFeedStart = null;
  scheduleExternalWriteFeedStart(
    feed.projectId,
    feed.generation,
    feed.timelapseReady,
  );
});

publishCurrentProjectId(useProjectStore.getState().currentProjectId);
useProjectStore.subscribe((state, previous) => {
  if (state.currentProjectId !== previous.currentProjectId) {
    publishCurrentProjectId(state.currentProjectId);
  }
});

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
  const fromSettings = getFallbackProjectLanguage();
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
