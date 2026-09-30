import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { debugLog } from "@/lib/debugLog";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import {
  initializeProjectTimelapse,
  startProjectExternalWriteFeed,
} from "@/application/project/projectRuntime";
import {
  getCurrentWorkspaceIdentity,
  type WorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
} from "@/lib/quiescenceProviders";
import {
  beginTimelapseGenesisBarrier,
  hasFailedTimelapseGenesisBarrier,
  registerTimelapseGenesisRetry,
  _resetTimelapseGenesisBarriersForTests,
  type TimelapseGenesisBarrierLease,
} from "@/features/timelapse/genesisBarrier";

export type ProjectLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "degraded"
  | "recovering";

export interface ProjectTimelapsePresentation {
  projectLoadStatus: ProjectLoadStatus;
  degradedParticipants: string[];
}

export interface ProjectTimelapseLifecycleHost {
  getCurrentProjectId: () => string;
  getLoadGeneration: () => number;
  isCurrentProjectLoad: (generation: number) => boolean;
  retryProjectLoad: (projectId: string) => void;
  setProjectPresentation: (
    updater: (
      presentation: ProjectTimelapsePresentation,
    ) => Partial<ProjectTimelapsePresentation>,
  ) => void;
}

interface ProjectBackgroundAuthority {
  generation: number;
  mutation: MutationAuthority;
}

export interface ProjectTimelapseLifecycle {
  beginGenesisBarrier: (projectId: string) => TimelapseGenesisBarrierLease;
  hasGenesisFailure: (projectId: string) => boolean;
  awaitPendingProjectBackgroundMutations: () => Promise<void>;
  scheduleTimelapseInitialization: (
    projectId: string,
    generation: number,
    genesisBarrier: TimelapseGenesisBarrierLease,
    expectedWorkspacePath?: string,
  ) => Promise<void>;
  scheduleExternalWriteFeedStart: (
    projectId: string,
    generation: number,
    timelapseReady?: Promise<void>,
  ) => void;
  scheduleOrDeferExternalWriteFeedStart: (
    projectId: string,
    generation: number,
    timelapseReady: Promise<void>,
    expectedWorkspacePath?: string,
    expectedWorkspaceOpenRevision?: number,
  ) => void;
  activateProjectBackgroundIntegrations: (
    projectId: string,
    generation: number,
    existingGenesisBarrier?: TimelapseGenesisBarrierLease,
  ) => void;
  presentTimelapseGenesisFailure: (
    projectId: string,
    generation: number,
  ) => void;
  invalidateForWorkspaceSwitch: () => void;
  handleWorkspaceIdentityPublished: (identity: WorkspaceIdentity) => void;
  resetForTests: () => void;
  scheduleExternalWriteFeedStartForTests: (projectId: string) => void;
  scheduleTimelapseInitializationForTests: (projectId: string) => void;
  scheduleWorkspaceBackgroundIntegrationsForTests: (
    projectId: string,
    expectedWorkspacePath: string,
    expectedWorkspaceOpenRevision: number,
  ) => void;
  activateProjectBackgroundIntegrationsForTests: (projectId: string) => void;
  presentTimelapseGenesisFailureForTests: (projectId: string) => void;
}

/**
 * Timelapse integrations are only live in the browser renderer. Vitest and
 * SSR intentionally skip recorder/feed binding so their mocked database does
 * not acquire a production chain tail or leak background promises.
 */
export function isProjectTimelapseBrowserRuntime(): boolean {
  return (
    typeof window !== "undefined" &&
    !(
      typeof import.meta !== "undefined" &&
      (import.meta as { vitest?: boolean }).vitest
    ) &&
    !(typeof process !== "undefined" && process.env?.VITEST)
  );
}

/**
 * Owns Project-scoped Timelapse genesis and external-feed lifetimes. The
 * Project store supplies only authority and presentation adapters, keeping
 * Zustand/CRUD orchestration independent from background persistence tails.
 */
export function createProjectTimelapseLifecycle(
  host: ProjectTimelapseLifecycleHost,
): ProjectTimelapseLifecycle {
  let timelapseInitTail: Promise<void> = Promise.resolve();
  let externalWriteFeedStartTail: Promise<void> = Promise.resolve();
  const pendingProjectBackgroundMutations = new Set<Promise<void>>();
  const projectBackgroundMutationFailures: unknown[] = [];
  const timelapseGenesisFailures = new Map<string, unknown>();
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

  function captureProjectBackgroundAuthority(
    projectId: string,
    generation: number,
  ): ProjectBackgroundAuthority {
    return {
      generation,
      mutation: captureMutationAuthority(projectId, host.getCurrentProjectId),
    };
  }

  function canStartProjectBackgroundMutation(
    authority: ProjectBackgroundAuthority,
  ): boolean {
    return (
      host.isCurrentProjectLoad(authority.generation) &&
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

  function scheduleTimelapseInitialization(
    projectId: string,
    _generation: number,
    genesisBarrier: TimelapseGenesisBarrierLease,
    expectedWorkspacePath?: string,
  ): Promise<void> {
    const mutationAuthority = captureMutationAuthority(
      projectId,
      host.getCurrentProjectId,
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
    // the latest project binds. This keeps the latest project authoritative.
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
      host.getCurrentProjectId() !== projectId ||
      !hasFailedTimelapseGenesisBarrier(projectId)
    ) {
      return;
    }
    await scheduleTimelapseInitialization(
      projectId,
      host.getLoadGeneration(),
      beginTimelapseGenesisBarrier(projectId),
    );
  }

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
      !host.isCurrentProjectLoad(generation) ||
      host.getCurrentProjectId() !== projectId
    ) {
      return;
    }
    let newlyDegraded = false;
    host.setProjectPresentation((state) => {
      if (state.degradedParticipants.includes("timelapse-genesis")) {
        return {};
      }
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
        onClick: () => host.retryProjectLoad(projectId),
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
      !host.isCurrentProjectLoad(generation) ||
      host.getCurrentProjectId() !== projectId
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

  function handleWorkspaceIdentityPublished(identity: WorkspaceIdentity): void {
    const activation = deferredProjectBackgroundActivation;
    if (activation) {
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
  }

  function resetForTests(): void {
    _resetTimelapseGenesisBarriersForTests();
    pendingProjectBackgroundMutations.clear();
    projectBackgroundMutationFailures.length = 0;
    timelapseGenesisFailures.clear();
    deferredProjectBackgroundActivation = null;
    deferredExternalWriteFeedStart = null;
    timelapseInitTail = Promise.resolve();
    externalWriteFeedStartTail = Promise.resolve();
  }

  const lifecycle: ProjectTimelapseLifecycle = {
    beginGenesisBarrier: beginTimelapseGenesisBarrier,
    hasGenesisFailure: hasFailedTimelapseGenesisBarrier,
    awaitPendingProjectBackgroundMutations,
    scheduleTimelapseInitialization,
    scheduleExternalWriteFeedStart,
    scheduleOrDeferExternalWriteFeedStart,
    activateProjectBackgroundIntegrations,
    presentTimelapseGenesisFailure,
    invalidateForWorkspaceSwitch() {
      deferredProjectBackgroundActivation = null;
    },
    handleWorkspaceIdentityPublished,
    resetForTests,
    scheduleExternalWriteFeedStartForTests(projectId) {
      scheduleExternalWriteFeedStart(projectId, host.getLoadGeneration());
    },
    scheduleTimelapseInitializationForTests(projectId) {
      scheduleTimelapseInitialization(
        projectId,
        host.getLoadGeneration(),
        beginTimelapseGenesisBarrier(projectId),
      );
    },
    scheduleWorkspaceBackgroundIntegrationsForTests(
      projectId,
      expectedWorkspacePath,
      expectedWorkspaceOpenRevision,
    ) {
      const timelapseReady = scheduleTimelapseInitialization(
        projectId,
        host.getLoadGeneration(),
        beginTimelapseGenesisBarrier(projectId),
        expectedWorkspacePath,
      );
      scheduleOrDeferExternalWriteFeedStart(
        projectId,
        host.getLoadGeneration(),
        timelapseReady,
        expectedWorkspacePath,
        expectedWorkspaceOpenRevision,
      );
    },
    activateProjectBackgroundIntegrationsForTests(projectId) {
      activateProjectBackgroundIntegrations(
        projectId,
        host.getLoadGeneration(),
      );
    },
    presentTimelapseGenesisFailureForTests(projectId) {
      presentTimelapseGenesisFailure(projectId, host.getLoadGeneration());
    },
  };

  registerQuiescenceProvider({
    id: createQuiescenceProviderId("project-background-mutations"),
    stage: "scoped-mutations",
    flush: awaitPendingProjectBackgroundMutations,
  });
  registerTimelapseGenesisRetry(retryFailedTimelapseGenesisForCurrentProject);

  return lifecycle;
}
