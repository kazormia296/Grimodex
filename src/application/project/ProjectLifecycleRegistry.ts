import { schedulePreexistingParticipantMutation } from "@/application/lifecycle/quiescenceLease";

export interface ProjectLifecycleContext {
  projectId: string;
  /**
   * Target Workspace generation for a pre-publication replacement hydrate.
   * Ordinary Project switches omit this and use the currently published
   * runtime identity.
   */
  workspaceOpenRevision?: number;
}

export interface ProjectLifecycleParticipant {
  id: string;
  /**
   * Load critical data without mutating singleton stores. The returned commit
   * is executed synchronously only after every preparation succeeds.
   */
  prepareCritical?: (
    context: ProjectLifecycleContext,
  ) => void | (() => void) | Promise<void | (() => void)>;
  reset?: (context: ProjectLifecycleContext) => void;
  commitCritical?: (context: ProjectLifecycleContext) => void;
  /** Legacy critical hook. Prefer prepareCritical for stateful hydration. */
  hydrateCritical?: (context: ProjectLifecycleContext) => void | Promise<void>;
  hydrateOptional?: (context: ProjectLifecycleContext) => void | Promise<void>;
  activate?: (context: ProjectLifecycleContext) => void | Promise<void>;
}

export interface ProjectLifecycleRegistry {
  reload(
    context: ProjectLifecycleContext,
    options?: {
      /** Runs in the same synchronous commit stack, before resets/publish. */
      beforeCommit?: () => boolean | void;
      /** Runs after every synchronous critical publish, before async hydrates. */
      afterCommit?: () => void;
      /** Best-effort timing events for async participant phases. */
      lifecycleTiming?: ProjectLifecycleTimingObserver;
    },
  ): Promise<ProjectLifecycleReloadResult>;
}

export type ProjectLifecycleTimingPhase =
  | "prepareCritical"
  | "hydrateCritical"
  | "hydrateOptional"
  | "activate";

export interface ProjectLifecycleTimingEvent {
  phase: ProjectLifecycleTimingPhase;
  status: "start" | "finish" | "fail";
  participantId: string;
  at: number;
  durationMs?: number;
}

export interface ProjectLifecycleTimingObserver {
  /** Defaults to the platform monotonic clock. */
  now?: () => number;
  onEvent: (event: ProjectLifecycleTimingEvent) => void;
}

export interface ProjectLifecycleFailure {
  participantId: string;
  error: unknown;
}

export interface ProjectLifecycleReloadResult {
  cancelled: boolean;
  degraded: ProjectLifecycleFailure[];
}

export interface ProjectLifecycleRegistryOptions {
  optionalConcurrency?: number;
  /**
   * Classify an optional failure as an expected empty/degraded result. This
   * hook is intentionally limited to optional hydration; critical and
   * activation failures remain visible to the caller.
   */
  isExpectedOptionalFailure?: (
    participant: ProjectLifecycleParticipant,
    error: unknown,
  ) => boolean;
  onOptionalFailure?: (
    participant: ProjectLifecycleParticipant,
    error: unknown,
  ) => void;
}

function assertUniqueParticipantIds(
  participants: readonly ProjectLifecycleParticipant[],
): void {
  const seen = new Set<string>();
  for (const participant of participants) {
    if (seen.has(participant.id)) {
      throw new Error(
        `Duplicate project lifecycle participant: ${participant.id}`,
      );
    }
    seen.add(participant.id);
  }
}

function monotonicNow(): number {
  return globalThis.performance.now();
}

function readObserverTime(observer: ProjectLifecycleTimingObserver): number {
  try {
    return observer.now?.() ?? monotonicNow();
  } catch {
    return monotonicNow();
  }
}

function emitTimingEvent(
  observer: ProjectLifecycleTimingObserver,
  event: ProjectLifecycleTimingEvent,
): void {
  try {
    observer.onEvent(event);
  } catch {
    // Diagnostics must never change lifecycle behavior.
  }
}

function isPromiseLike<T>(value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as PromiseLike<T>).then === "function"
  );
}

function observeParticipantCall<T>(
  observer: ProjectLifecycleTimingObserver | undefined,
  phase: ProjectLifecycleTimingPhase,
  participantId: string,
  run: () => T | PromiseLike<T>,
): T | PromiseLike<T> {
  if (!observer) return run();

  const startedAt = readObserverTime(observer);
  emitTimingEvent(observer, {
    phase,
    status: "start",
    participantId,
    at: startedAt,
  });

  const emitTerminal = (status: "finish" | "fail"): void => {
    const at = readObserverTime(observer);
    emitTimingEvent(observer, {
      phase,
      status,
      participantId,
      at,
      durationMs: at - startedAt,
    });
  };

  try {
    const result = run();
    if (!isPromiseLike(result)) {
      emitTerminal("finish");
      return result;
    }
    return Promise.resolve(result).then(
      (value) => {
        emitTerminal("finish");
        return value;
      },
      (error: unknown) => {
        emitTerminal("fail");
        throw error;
      },
    );
  } catch (error) {
    emitTerminal("fail");
    throw error;
  }
}

async function runInBatches(
  participants: readonly ProjectLifecycleParticipant[],
  context: ProjectLifecycleContext,
  concurrency: number,
  isExpectedFailure: ProjectLifecycleRegistryOptions["isExpectedOptionalFailure"],
  onFailure: ProjectLifecycleRegistryOptions["onOptionalFailure"],
  timingObserver: ProjectLifecycleTimingObserver | undefined,
): Promise<ProjectLifecycleFailure[]> {
  const failures: ProjectLifecycleFailure[] = [];
  const batchSize = Math.max(1, Math.floor(concurrency));
  for (let i = 0; i < participants.length; i += batchSize) {
    const batch = participants.slice(i, i + batchSize);
    const results = await Promise.allSettled(
      batch.map((participant) =>
        observeParticipantCall(
          timingObserver,
          "hydrateOptional",
          participant.id,
          () => participant.hydrateOptional!(context),
        ),
      ),
    );
    results.forEach((result, index) => {
      if (result.status === "rejected") {
        const participant = batch[index]!;
        let expected = false;
        try {
          expected = isExpectedFailure?.(participant, result.reason) ?? false;
        } catch {
          // A diagnostic classifier must not hide an optional failure if its
          // own inspection fails.
        }
        if (expected) return;
        failures.push({ participantId: participant.id, error: result.reason });
        onFailure?.(participant, result.reason);
      }
    });
  }
  return failures;
}

/**
 * Coordinates project-scoped state without exposing feature store shapes to
 * the project feature. Each participant is reset exactly once, critical
 * hydration completes before optional hydration starts, and optional loads
 * retain the previous best-effort failure semantics.
 */
export function createProjectLifecycleRegistry(
  participants: readonly ProjectLifecycleParticipant[],
  options: ProjectLifecycleRegistryOptions = {},
): ProjectLifecycleRegistry {
  assertUniqueParticipantIds(participants);
  const resetParticipants = participants.filter(
    (participant) => participant.reset,
  );
  const prepareParticipants = participants.filter(
    (participant) => participant.prepareCritical,
  );
  const commitParticipants = participants.filter(
    (participant) => participant.commitCritical,
  );
  const criticalParticipants = participants.filter(
    (participant) => participant.hydrateCritical,
  );
  const optionalParticipants = participants.filter(
    (participant) => participant.hydrateOptional,
  );
  const activationParticipants = participants.filter(
    (participant) => participant.activate,
  );

  return {
    async reload(context, reloadOptions) {
      const preparedCommits: Array<() => void> = [];
      // Phase A: no externally visible state is mutated. A failure leaves the
      // old Project fully operational.
      for (const participant of prepareParticipants) {
        const commit = await observeParticipantCall(
          reloadOptions?.lifecycleTiming,
          "prepareCritical",
          participant.id,
          () => participant.prepareCritical!(context),
        );
        if (commit) preparedCommits.push(commit);
      }

      if (reloadOptions?.beforeCommit?.() === false) {
        return { cancelled: true, degraded: [] };
      }

      // Phase B: no await until all critical snapshots and singleton resets
      // have been published. UI events cannot observe an old/new mixture.
      schedulePreexistingParticipantMutation(() => {
        for (const participant of resetParticipants) {
          participant.reset!(context);
        }
        for (const commit of preparedCommits) commit();
        for (const participant of commitParticipants) {
          participant.commitCritical!(context);
        }
        reloadOptions?.afterCommit?.();
      });

      for (const participant of criticalParticipants) {
        await observeParticipantCall(
          reloadOptions?.lifecycleTiming,
          "hydrateCritical",
          participant.id,
          () => participant.hydrateCritical!(context),
        );
      }

      const degraded = await runInBatches(
        optionalParticipants,
        context,
        options.optionalConcurrency ?? 3,
        options.isExpectedOptionalFailure,
        options.onOptionalFailure,
        reloadOptions?.lifecycleTiming,
      );

      const activationResults = await Promise.allSettled(
        activationParticipants.map((participant) =>
          observeParticipantCall(
            reloadOptions?.lifecycleTiming,
            "activate",
            participant.id,
            () => participant.activate!(context),
          ),
        ),
      );
      activationResults.forEach((result, index) => {
        if (result.status !== "rejected") return;
        const participant = activationParticipants[index]!;
        degraded.push({
          participantId: participant.id,
          error: result.reason,
        });
        options.onOptionalFailure?.(participant, result.reason);
      });
      return { cancelled: false, degraded };
    },
  };
}
