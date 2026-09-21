/**
 * Electron main 専用の Change Feed freshness scheduler。
 *
 * Durable reservation / replay / publish / ack とbatch上限は共有Rust runtimeが
 * 担う。mainはcycleを直列化し、backlogを示す `hasMore` だけを使って次の有界
 * cycleを早める。renderer IPC / preload surfaceは持たない。
 */

import {
  isRelatedScenesInvalidatedEvent,
  RELATED_SCENES_INVALIDATED_EVENT,
} from "../shared/relatedScenesSearchWire.js";

const INITIAL_DELAY_MS = 250;
const IDLE_POLL_INTERVAL_MS = 1_000;
const BACKLOG_DELAY_MS = 10;
const ERROR_RETRY_DELAY_MS = 1_000;

export interface NarrativeFreshnessBackendLike {
  /** JSON batch summary。feed空 / workspace unavailable / in-flight skipはnull。 */
  runNarrativeFreshnessCycle?(): Promise<string | null>;
}

export interface NarrativeFreshnessScheduler {
  start(): void;
  /** Trusted Native event-bus notification; no renderer/preload entry point. */
  handleBackendEvent(channel: string, payload: unknown): void;
  /** Quiesce the participant while a workspace binding is being replaced. */
  quiesceForWorkspaceSwitch?(): Promise<NarrativeFreshnessQuiesceLease | undefined>;
  /** Main-only synchronous state recheck for the CI quiescence writer. */
  getQuiescenceState?(): {
    mutationRevision: number;
    inFlight: boolean;
    hasMore: boolean;
    heldProjectId: string | null;
    cutoverNotReady: boolean;
    wakePending: boolean;
    timerScheduled: boolean;
    nextCycleGuardStateDigest: string | null;
    quiescenceState: unknown;
  };
  /** Stop new cycles and join the currently running Native cycle. */
  dispose(): Promise<void>;
}

export interface NarrativeFreshnessQuiesceLease {
  resume(workspaceSwitchSucceeded?: boolean): void | Promise<void>;
}

interface SchedulerOptions {
  warn?: (...args: unknown[]) => void;
  /** Notify the main-only maintenance owner of an expected C2-ZC gate miss. */
  onCutoverNotReady?: () => void | Promise<void>;
  /**
   * Publish one completed cycle observation to the main-only CI quiescence
   * owner. The callback is deliberately not part of preload or renderer IPC.
   */
  onCycleCompleted?: (observation: {
    cycleGeneration: number;
    cycleStartedAtMs: number;
    observedAtMs: number;
    inFlight: boolean;
    hasMore: boolean;
    noWrite: boolean;
    heldProjectId: string | null;
    cutoverNotReady: boolean;
    /** A Native invalidation arrived after this cycle started. */
    wakePending: boolean;
    timerScheduled: boolean;
    nextCycleGuardStateDigest: string | null;
    quiescenceState: unknown;
  }) => void | Promise<void>;
}

function batchHasMore(raw: string): boolean {
  const value = JSON.parse(raw) as unknown;
  return (
    typeof value === "object" &&
    value !== null &&
    "hasMore" in value &&
    value.hasMore === true
  );
}

function cutoverNotReady(raw: string): boolean {
  try {
    const value = JSON.parse(raw) as unknown;
    return (
      typeof value === "object" &&
      value !== null &&
      "cutoverNotReady" in value &&
      value.cutoverNotReady === true
    );
  } catch {
    return false;
  }
}

/**
 * D2 shadow diagnostics are deliberately kept out of the durable Freshness
 * authority, so main is their only observable sink: surface every diagnostic
 * the batch summary carries instead of silently discarding it at this
 * boundary.
 */
function shadowDiagnostics(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== "object" || value === null) return [];
    const shadow = (value as Record<string, unknown>).v2Shadow;
    if (typeof shadow !== "object" || shadow === null) return [];
    const diagnostics = (shadow as Record<string, unknown>).diagnostics;
    if (!Array.isArray(diagnostics)) return [];
    return diagnostics.filter(
      (entry): entry is string => typeof entry === "string",
    );
  } catch {
    return [];
  }
}

function freshnessCycleObservation(raw: string): {
  hasMore: boolean;
  noWrite: boolean;
  heldProjectId: string | null;
  cutoverNotReady: boolean;
  quiescenceState: unknown;
} {
  const value = JSON.parse(raw) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("native freshness cycle returned invalid JSON object");
  }
  const record = value as Record<string, unknown>;
  const heldProjectId = record.heldProjectId ?? null;
  const cutoverNotReady = record.cutoverNotReady ?? false;
  if (
    heldProjectId !== null &&
    (typeof heldProjectId !== "string" ||
      heldProjectId.trim() !== heldProjectId)
  ) {
    throw new Error("native freshness cycle held project is invalid");
  }
  if (
    typeof cutoverNotReady !== "boolean" ||
    (heldProjectId !== null && cutoverNotReady !== true)
  ) {
    throw new Error("native freshness cycle hold/cutover result is invalid");
  }
  return {
    hasMore: record.hasMore === true,
    noWrite: record.noWrite === true,
    heldProjectId: heldProjectId as string | null,
    cutoverNotReady,
    quiescenceState: record.quiescenceState,
  };
}

export function createNarrativeFreshnessScheduler(
  backend: NarrativeFreshnessBackendLike | null,
  options: SchedulerOptions = {},
): NarrativeFreshnessScheduler {
  const warn = options.warn ?? console.warn;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let disposed = false;
  let inFlight = false;
  let wakePending = false;
  let inFlightCompletion: Promise<void> | null = null;
  let quiescing = false;
  const activeWorkspaceSwitchOwners = new Set<symbol>();
  let quiesceTransition: Promise<void> | null = null;
  let cycleGeneration = 0;
  let mutationRevision = 0;
  let lastCompletedObservation: ReturnType<
    typeof freshnessCycleObservation
  > | null = null;
  let lastNextCycleGuardStateDigest: string | null = null;

  const noteMutation = (): void => {
    mutationRevision += 1;
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    noteMutation();
    clearTimeout(timer);
    timer = null;
  };

  const schedule = (delayMs: number): void => {
    if (disposed) return;
    // start()やcycle完了が同じtickに重なってもpending wakeupは1件に畳む。
    clearTimer();
    noteMutation();
    timer = setTimeout(() => {
      noteMutation();
      timer = null;
      if (quiescing) {
        wakePending = true;
        return;
      }
      const completion = runCycle();
      inFlightCompletion = completion;
      void completion.then(
        () => {
          if (inFlightCompletion === completion) inFlightCompletion = null;
        },
        () => {
          if (inFlightCompletion === completion) inFlightCompletion = null;
        },
      );
    }, delayMs);
  };

  const runCycle = async (): Promise<void> => {
    if (disposed || inFlight || quiescing) {
      if (quiescing) wakePending = true;
      return;
    }
    const method = backend?.runNarrativeFreshnessCycle;
    if (typeof method !== "function") return;

    inFlight = true;
    wakePending = false;
    noteMutation();
    // A previous idle result cannot certify the new cycle while this native
    // call is running or may schedule a retry. The runtime recheck therefore
    // observes no freshness state until this cycle publishes a new result.
    lastCompletedObservation = null;
    lastNextCycleGuardStateDigest = null;
    let nextDelayMs = IDLE_POLL_INTERVAL_MS;
    let completedObservation: ReturnType<
      typeof freshnessCycleObservation
    > | null = null;
    let cycleStartedAtMs = 0;
    try {
      // napi class methodはbindを失うとselfが壊れるためbackend経由で呼ぶ。
      cycleStartedAtMs = Date.now();
      const result = await method.call(backend);
      if (disposed) return;
      if (result !== null) {
        completedObservation = freshnessCycleObservation(result);
        for (const diagnostic of shadowDiagnostics(result)) {
          warn("[narrative-freshness] D2 shadow diagnostic:", diagnostic);
        }
        if (cutoverNotReady(result)) {
          try {
            const followup = options.onCutoverNotReady?.();
            void Promise.resolve(followup).catch((callbackError: unknown) => {
              warn(
                "[narrative-freshness] C2-ZC activation follow-up failed:",
                callbackError,
              );
            });
          } catch (callbackError) {
            warn(
              "[narrative-freshness] C2-ZC activation follow-up failed:",
              callbackError,
            );
          }
        }
        if (batchHasMore(result)) {
          nextDelayMs = BACKLOG_DELAY_MS;
        }
      }
    } catch (error) {
      nextDelayMs = ERROR_RETRY_DELAY_MS;
      if (!disposed) {
        warn("[narrative-freshness] background cycle failed:", error);
      }
    } finally {
      inFlight = false;
      noteMutation();
      // setIntervalを使わず、必ず前cycle完了後に次の1件だけを予約する。
      if (!disposed && !quiescing) {
        schedule(wakePending ? BACKLOG_DELAY_MS : nextDelayMs);
      }
      if (!disposed && completedObservation !== null) {
        cycleGeneration += 1;
        noteMutation();
        const timerScheduled = timer !== null;
        let stateDigest: string | null = null;
        if (
          completedObservation.quiescenceState !== null &&
          typeof completedObservation.quiescenceState === "object" &&
          !Array.isArray(completedObservation.quiescenceState)
        ) {
          const candidate = (
            completedObservation.quiescenceState as Record<string, unknown>
          ).stateDigest;
          if (typeof candidate === "string") stateDigest = candidate;
        }
        const nextCycleGuardStateDigest =
          timerScheduled &&
          !wakePending &&
          completedObservation.noWrite &&
          !completedObservation.hasMore
            ? stateDigest
            : null;
        lastCompletedObservation = wakePending ? null : completedObservation;
        lastNextCycleGuardStateDigest = nextCycleGuardStateDigest;
        try {
          const callback = options.onCycleCompleted?.({
            cycleGeneration,
            cycleStartedAtMs,
            observedAtMs: Date.now(),
            inFlight: false,
            hasMore: completedObservation.hasMore,
            noWrite: completedObservation.noWrite,
            heldProjectId: completedObservation.heldProjectId,
            cutoverNotReady: completedObservation.cutoverNotReady,
            wakePending,
            timerScheduled,
            nextCycleGuardStateDigest,
            quiescenceState: completedObservation.quiescenceState,
          });
          void Promise.resolve(callback).catch((callbackError: unknown) => {
            warn(
              "[narrative-freshness] quiescence observation callback failed:",
              callbackError,
            );
          });
        } catch (callbackError) {
          warn(
            "[narrative-freshness] quiescence observation callback failed:",
            callbackError,
          );
        }
      }
    }
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      noteMutation();
      if (typeof backend?.runNarrativeFreshnessCycle !== "function") {
        warn(
          "[narrative-freshness] background runtime disabled: native method unavailable",
        );
        return;
      }
      schedule(INITIAL_DELAY_MS);
    },

    handleBackendEvent(channel, payload): void {
      if (
        !started ||
        disposed ||
        wakePending ||
        typeof backend?.runNarrativeFreshnessCycle !== "function" ||
        channel !== RELATED_SCENES_INVALIDATED_EVENT ||
        !isRelatedScenesInvalidatedEvent(payload)
      )
        return;
      wakePending = true;
      noteMutation();
      lastCompletedObservation = null;
      lastNextCycleGuardStateDigest = null;
      // An in-flight cycle may already have captured its Feed range. Preserve
      // one follow-up after it completes; never invoke Native concurrently.
      if (quiescing) return;
      if (!inFlight) schedule(BACKLOG_DELAY_MS);
    },

    getQuiescenceState() {
      return {
        mutationRevision,
        inFlight,
        hasMore: lastCompletedObservation?.hasMore === true,
        heldProjectId: lastCompletedObservation?.heldProjectId ?? null,
        cutoverNotReady: lastCompletedObservation?.cutoverNotReady === true,
        wakePending,
        timerScheduled: timer !== null,
        nextCycleGuardStateDigest:
          timer !== null ? lastNextCycleGuardStateDigest : null,
        quiescenceState: lastCompletedObservation?.quiescenceState ?? null,
      };
    },

    async quiesceForWorkspaceSwitch(): Promise<
      NarrativeFreshnessQuiesceLease | undefined
    > {
      if (disposed) return undefined;
      const owner = Symbol("freshness-workspace-switch");
      activeWorkspaceSwitchOwners.add(owner);
      try {
        if (quiesceTransition === null) {
          quiesceTransition = (async () => {
            quiescing = true;
            clearTimer();
            noteMutation();
            await inFlightCompletion;
          })().finally(() => {
            quiesceTransition = null;
          });
        }
        await quiesceTransition;
      } catch (error) {
        activeWorkspaceSwitchOwners.delete(owner);
        throw error;
      }
      return {
        resume: () => {
          if (!activeWorkspaceSwitchOwners.delete(owner)) return;
          if (
            disposed ||
            activeWorkspaceSwitchOwners.size !== 0 ||
            !quiescing
          ) {
            return;
          }
          quiescing = false;
          if (started && timer === null) {
            schedule(wakePending ? BACKLOG_DELAY_MS : IDLE_POLL_INTERVAL_MS);
          }
        },
      };
    },

    async dispose(): Promise<void> {
      if (!disposed) {
        disposed = true;
        quiescing = false;
        activeWorkspaceSwitchOwners.clear();
        wakePending = false;
        noteMutation();
        clearTimer();
      }
      // Do not interrupt an in-flight Native cycle: it owns a lifecycle
      // participant and must publish its terminal/cleanup evidence before
      // Native shutdown can attempt to close the shared core.
      await inFlightCompletion;
    },
  };
}
