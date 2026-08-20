/**
 * Electron main 専用の Narrative Maintenance scheduler (C2-5A).
 *
 * Native code remains the authority for Run ledger, live workspace pinning,
 * and adapter execution.  main owns only the wakeup queue: requests for the
 * same project/Run Kind/work key coalesce, while different automatic Run
 * Kinds for one project are delivered through one in-flight cycle.  There is
 * no renderer or preload surface, and Repair is not part of this vocabulary.
 */

export type NarrativeMaintenanceRunKind =
  | "backfill"
  | "dependency-verify"
  | "semantic-index-rebuild";

export interface NarrativeMaintenanceRequest {
  projectId: string;
  runKind: NarrativeMaintenanceRunKind;
  workKey: string;
  reason: string;
  semanticEpochId?: string | null;
}

/** DTO delivered to the future main-only NAPI cycle method. */
export interface NarrativeMaintenanceWork {
  projectId: string;
  runKind: NarrativeMaintenanceRunKind;
  workKey: string;
  semanticEpochId: string | null;
  reasons: readonly string[];
}

/**
 * Request delivered to the future main-only NAPI cycle method. Empty `work`
 * is valid only when `wakeProjectIds` names the durable native backlog scope;
 * this keeps an empty wake meaningful across scheduler/backend boundaries.
 */
export interface NarrativeMaintenanceCycleRequest {
  work: readonly NarrativeMaintenanceWork[];
  wakeProjectIds: readonly string[];
}

/**
 * A cycle is only drained after the backend explicitly accepts it.  In
 * particular, workspace-unavailable is not an empty/successful cycle: the
 * scheduler must put the claimed work back on its queue so a later wake can
 * deliver the original trigger.
 */
export type NarrativeMaintenanceCycleResult =
  | { status: "accepted"; hasMore: boolean }
  | { status: "workspace-unavailable" }
  | { status: "coalesced" };

export interface NarrativeMaintenanceBackendLike {
  /**
   * The backend must acknowledge ownership of the request explicitly.  The
   * scheduler retains/requeues work until it receives `accepted` or
   * `coalesced`.
   */
  runNarrativeMaintenanceCycle?(
    request: NarrativeMaintenanceCycleRequest,
  ): Promise<NarrativeMaintenanceCycleResult>;
}

export interface NarrativeMaintenanceScheduler {
  start(): void;
  request(work: NarrativeMaintenanceRequest): void;
  /** Alias for callers that model the queue as an enqueue operation. */
  enqueue(work: NarrativeMaintenanceRequest): void;
  dispose(): void;
}

export interface NarrativeMaintenanceSchedulerOptions {
  warn?: (...args: unknown[]) => void;
}

export const NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS = 250;
/** Kept for callers that used the pre-C2-5A polling constant; idle polling is disabled. */
export const NARRATIVE_MAINTENANCE_IDLE_POLL_INTERVAL_MS = 1_000;
export const NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS = 10;
export const NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS = 1_000;
export const NARRATIVE_MAINTENANCE_MAX_RETRIES = 3;

const AUTOMATIC_RUN_KINDS = new Set<NarrativeMaintenanceRunKind>([
  "backfill",
  "dependency-verify",
  "semantic-index-rebuild",
]);

function requireWorkComponent(value: string, name: string): string {
  if (typeof value !== "string") {
    throw new Error(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`${name} is required`);
  }
  if (normalized.includes("/") || normalized.includes("\\")) {
    throw new Error(`${name} must not contain path separators`);
  }
  return normalized;
}

function optionalWorkComponent(
  value: string | null | undefined,
): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error("semanticEpochId must be a string");
  }
  return requireWorkComponent(value, "semanticEpochId");
}

function requireAutomaticRunKind(value: unknown): NarrativeMaintenanceRunKind {
  if (
    typeof value !== "string" ||
    !AUTOMATIC_RUN_KINDS.has(value as NarrativeMaintenanceRunKind)
  ) {
    throw new Error(
      `runKind must be one of the automatic kinds; Repair and unknown kinds are not allowed`,
    );
  }
  return value as NarrativeMaintenanceRunKind;
}

function validateRequest(
  request: NarrativeMaintenanceRequest,
): NarrativeMaintenanceRequest {
  return {
    projectId: requireWorkComponent(request.projectId, "projectId"),
    runKind: requireAutomaticRunKind(request.runKind),
    workKey: requireWorkComponent(request.workKey, "workKey"),
    reason: requireWorkComponent(request.reason, "reason"),
    semanticEpochId: optionalWorkComponent(request.semanticEpochId),
  };
}

export function canonicalNarrativeMaintenanceWorkKey(
  work: Pick<
    NarrativeMaintenanceRequest,
    "projectId" | "runKind" | "workKey" | "semanticEpochId"
  >,
): string {
  const runKind = requireAutomaticRunKind(work.runKind);
  const projectId = requireWorkComponent(work.projectId, "projectId");
  const workKey = requireWorkComponent(work.workKey, "workKey");
  const semanticEpochId = optionalWorkComponent(work.semanticEpochId);
  const base = `narrative-maintenance:v1/${runKind}/${projectId}/${workKey}`;
  return semanticEpochId === null ? base : `${base}/epoch/${semanticEpochId}`;
}

/**
 * Coalesce same-key requests while preserving first-seen order and unique
 * reasons.  Run Kind is part of the key, so equal workKey text across kinds
 * remains distinct.
 */
export function coalesceNarrativeMaintenanceWork(
  requests: readonly NarrativeMaintenanceRequest[],
): NarrativeMaintenanceWork[] {
  const result: NarrativeMaintenanceWork[] = [];
  const positions = new Map<string, number>();
  for (const rawRequest of requests) {
    const request = validateRequest(rawRequest);
    const key = canonicalNarrativeMaintenanceWorkKey(request);
    const existingPosition = positions.get(key);
    if (existingPosition !== undefined) {
      const existing = result[existingPosition];
      if (existing && !existing.reasons.includes(request.reason)) {
        result[existingPosition] = {
          ...existing,
          reasons: [...existing.reasons, request.reason],
        };
      }
      continue;
    }
    positions.set(key, result.length);
    result.push({
      projectId: request.projectId,
      runKind: request.runKind,
      workKey: request.workKey,
      semanticEpochId: request.semanticEpochId ?? null,
      reasons: [request.reason],
    });
  }
  return result;
}

function normalizeCycleResult(raw: unknown): NarrativeMaintenanceCycleResult {
  // Keep the old JSON wire form readable while the main-only boundary moves
  // to the explicit status contract.  A raw null is specifically an
  // unavailable workspace, never a successful drain.
  if (raw === null) return { status: "workspace-unavailable" };
  if (typeof raw === "string") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("native maintenance cycle returned malformed JSON");
    }
    return normalizeCycleResult(parsed);
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("native maintenance cycle returned invalid status");
  }

  const value = raw as Record<string, unknown>;
  if (typeof value.status === "string") {
    if (value.status === "accepted" && typeof value.hasMore === "boolean") {
      return { status: "accepted", hasMore: value.hasMore };
    }
    if (value.status === "workspace-unavailable") {
      return { status: "workspace-unavailable" };
    }
    if (value.status === "coalesced") {
      return { status: "coalesced" };
    }
    throw new Error("native maintenance cycle returned invalid status");
  }

  // Backward-compatible JSON summary from the pre-status native adapter.
  if (typeof value.hasMore === "boolean") {
    return { status: "accepted", hasMore: value.hasMore };
  }
  throw new Error("native maintenance cycle returned invalid status");
}

interface SharedProjectCoordinator {
  claimAvailable(projectIds: readonly string[]): string[];
  release(projectIds: readonly string[]): void;
  /** Wake contenders only when one of the projects they need is released. */
  waitForRelease(
    projectIds: readonly string[],
    listener: () => void,
  ): () => void;
}

function createSharedCoordinator(): SharedProjectCoordinator {
  const activeProjects = new Set<string>();
  const waiters = new Map<() => void, Set<string>>();
  return {
    claimAvailable(projectIds): string[] {
      const claimed: string[] = [];
      for (const projectId of projectIds) {
        if (activeProjects.has(projectId)) continue;
        activeProjects.add(projectId);
        claimed.push(projectId);
      }
      return claimed;
    },
    release(projectIds): void {
      for (const projectId of projectIds) activeProjects.delete(projectId);
      if (projectIds.length === 0) return;
      const releasedProjects = new Set(projectIds);
      for (const [waiter, neededProjects] of waiters) {
        if (
          ![...neededProjects].some((projectId) =>
            releasedProjects.has(projectId),
          )
        ) {
          continue;
        }
        waiters.delete(waiter);
        waiter();
      }
    },
    waitForRelease(projectIds, listener): () => void {
      const neededProjects = new Set(projectIds);
      // Registration happens after a scheduler's partial claim has finished.
      // Another scheduler may have released one of these projects in the
      // meantime.  Recheck while still in this synchronous coordinator call;
      // otherwise the waiter would be installed after the release and the
      // pending work could sleep forever.
      if (
        [...neededProjects].some((projectId) => !activeProjects.has(projectId))
      ) {
        queueMicrotask(listener);
        return () => undefined;
      }
      waiters.set(listener, neededProjects);
      return () => {
        waiters.delete(listener);
      };
    },
  };
}

// This guard is deliberately process-wide rather than scheduler-local. Main
// can have more than one scheduler instance during workspace handoff, and a
// backend wrapper object is not a stable identity for the live workspace.
const processCoordinator = createSharedCoordinator();

export function createNarrativeMaintenanceScheduler(
  backend: NarrativeMaintenanceBackendLike | null,
  options: NarrativeMaintenanceSchedulerOptions = {},
): NarrativeMaintenanceScheduler {
  const warn = options.warn ?? console.warn;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let disposed = false;
  let inFlight = false;
  const pending = new Map<string, NarrativeMaintenanceWork>();
  const retryCounts = new Map<string, number>();
  const sharedCoordinator = backend ? processCoordinator : null;
  // hasMore is a durable native backlog signal, so retain the project that
  // owns the signal.  An unscoped boolean would allow another scheduler to
  // issue the empty wake while this scheduler's project claim is held.
  const durableWakeProjects = new Set<string>();
  const durableWakeRetryCounts = new Map<string, number>();
  let cancelCoordinatorWait: (() => void) | null = null;

  const clearTimer = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  };

  const clearCoordinatorWait = (): void => {
    cancelCoordinatorWait?.();
    cancelCoordinatorWait = null;
  };

  const schedule = (delayMs: number): void => {
    if (disposed) return;
    clearCoordinatorWait();
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      void runCycle();
    }, delayMs);
  };

  const waitForProjectRelease = (projectIds: readonly string[]): void => {
    if (!sharedCoordinator) {
      schedule(NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS);
      return;
    }
    clearCoordinatorWait();
    cancelCoordinatorWait = sharedCoordinator.waitForRelease(projectIds, () => {
      cancelCoordinatorWait = null;
      if (!disposed && !inFlight && timer === null) {
        schedule(NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS);
      }
    });
  };

  const requeueWork = (work: NarrativeMaintenanceWork): void => {
    const key = canonicalNarrativeMaintenanceWorkKey(work);
    const existing = pending.get(key);
    if (existing) {
      const reasons = [
        ...existing.reasons,
        ...work.reasons.filter((reason) => !existing.reasons.includes(reason)),
      ];
      pending.set(key, { ...existing, reasons });
      return;
    }
    pending.set(key, work);
  };

  const runCycle = async (): Promise<void> => {
    if (disposed || inFlight) return;
    const method = backend?.runNarrativeMaintenanceCycle;
    if (typeof method !== "function") return;

    if (pending.size === 0 && durableWakeProjects.size === 0) return;

    const candidates = [...pending.values()];
    // Process ordinary work first. A wake-only cycle is represented by an
    // empty batch, but only after its durable project has been claimed.
    const projectIds = [
      ...new Set([
        ...candidates.map((work) => work.projectId),
        ...durableWakeProjects,
      ]),
    ];
    const claimedProjects = sharedCoordinator
      ? sharedCoordinator.claimAvailable(projectIds)
      : projectIds;
    const claimedProjectSet = new Set(claimedProjects);
    const blockedProjectIds = projectIds.filter(
      (projectId) => !claimedProjectSet.has(projectId),
    );
    const batch = candidates.filter((work) =>
      claimedProjectSet.has(work.projectId),
    );
    const sendingWakeProjects = claimedProjects.filter((projectId) =>
      durableWakeProjects.has(projectId),
    );
    if (batch.length === 0 && sendingWakeProjects.length === 0) {
      // A competing scheduler owns every project we need. Release-driven
      // wakeup removes the old 10ms busy-poll and cannot starve a project.
      waitForProjectRelease(projectIds);
      return;
    }
    clearCoordinatorWait();
    for (const projectId of sendingWakeProjects) {
      durableWakeProjects.delete(projectId);
    }
    for (const work of batch) {
      pending.delete(canonicalNarrativeMaintenanceWorkKey(work));
    }
    inFlight = true;
    let nextDelayMs = NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS;
    let shouldSchedule = pending.size > 0 || durableWakeProjects.size > 0;
    let workspaceUnavailable = false;
    try {
      // N-API class methods must be invoked through backend to preserve self.
      const result = await method.call(backend, {
        work: batch,
        wakeProjectIds: sendingWakeProjects,
      });
      // Validate the response before clearing retry state.  A malformed
      // native response is a failed cycle and consumes the same bounded retry
      // budget as a rejected backend call.  Workspace-unavailable is handled
      // separately below and retains the trigger until acceptance.  This is
      // intentionally after the await and before clearing the claimed work:
      // the catch path requeues the exact batch and wake scope.
      const cycleResult = normalizeCycleResult(result);
      if (cycleResult.status === "workspace-unavailable") {
        workspaceUnavailable = true;
        throw new Error(
          "native maintenance cycle could not acquire an active workspace",
        );
      }
      for (const projectId of [
        ...new Set([
          ...sendingWakeProjects,
          ...batch.map((work) => work.projectId),
        ]),
      ]) {
        durableWakeRetryCounts.delete(projectId);
      }
      for (const work of batch) {
        retryCounts.delete(canonicalNarrativeMaintenanceWorkKey(work));
      }
      shouldSchedule = pending.size > 0 || durableWakeProjects.size > 0;
      if (
        !disposed &&
        cycleResult.status === "accepted" &&
        cycleResult.hasMore
      ) {
        const wakeProjects = [
          ...new Set([
            ...sendingWakeProjects,
            ...batch.map((work) => work.projectId),
          ]),
        ];
        if (wakeProjects.length === 0) {
          warn(
            "[narrative-maintenance] hasMore response has no project scope; stopping",
          );
          shouldSchedule = pending.size > 0 || durableWakeProjects.size > 0;
        } else {
          for (const projectId of wakeProjects)
            durableWakeProjects.add(projectId);
          shouldSchedule = true;
        }
      }
    } catch (error) {
      if (!disposed) {
        if (workspaceUnavailable) {
          // This is an expected, recoverable state while a workspace is
          // closed or switching.  It is not a failed delivery and must not
          // consume the bounded error retry budget: dropping this batch would
          // lose the only trigger until another event happens to arrive.
          for (const work of batch) requeueWork(work);
          for (const projectId of sendingWakeProjects) {
            durableWakeProjects.add(projectId);
          }
          warn(
            "[narrative-maintenance] active workspace unavailable; retaining maintenance trigger",
          );
          nextDelayMs = NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS;
          shouldSchedule = pending.size > 0 || durableWakeProjects.size > 0;
        } else {
          for (const work of batch) {
            const key = canonicalNarrativeMaintenanceWorkKey(work);
            const retryCount = (retryCounts.get(key) ?? 0) + 1;
            if (retryCount <= NARRATIVE_MAINTENANCE_MAX_RETRIES) {
              retryCounts.set(key, retryCount);
              requeueWork(work);
            } else {
              retryCounts.delete(key);
              warn(
                `[narrative-maintenance] retry exhausted for canonical key ${key}; stopping`,
                error,
              );
            }
          }
          if (sendingWakeProjects.length > 0) {
            for (const projectId of sendingWakeProjects) {
              const retryCount =
                (durableWakeRetryCounts.get(projectId) ?? 0) + 1;
              if (retryCount <= NARRATIVE_MAINTENANCE_MAX_RETRIES) {
                durableWakeRetryCounts.set(projectId, retryCount);
                durableWakeProjects.add(projectId);
              } else {
                durableWakeRetryCounts.delete(projectId);
                durableWakeProjects.delete(projectId);
                warn(
                  `[narrative-maintenance] durable backlog retry exhausted for project ${projectId}; stopping`,
                  error,
                );
              }
            }
          }
          warn("[narrative-maintenance] background cycle failed:", error);
          nextDelayMs = NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS;
          shouldSchedule = pending.size > 0 || durableWakeProjects.size > 0;
        }
      }
    } finally {
      sharedCoordinator?.release(claimedProjects);
      inFlight = false;
      if (!disposed && shouldSchedule) {
        const blockedProjects = new Set(blockedProjectIds);
        const hasNewUnblockedPendingWork = [...pending.values()].some(
          (work) => !blockedProjects.has(work.projectId),
        );
        if (
          blockedProjectIds.length > 0 &&
          !hasNewUnblockedPendingWork &&
          durableWakeProjects.size === 0
        ) {
          waitForProjectRelease(blockedProjectIds);
        } else {
          schedule(nextDelayMs);
        }
      }
    }
  };

  const enqueue = (rawWork: NarrativeMaintenanceRequest): void => {
    if (disposed) return;
    const work = validateRequest(rawWork);
    const key = canonicalNarrativeMaintenanceWorkKey(work);
    const existing = pending.get(key);
    if (existing && !existing.reasons.includes(work.reason)) {
      pending.set(key, {
        ...existing,
        reasons: [...existing.reasons, work.reason],
      });
    } else if (!existing) {
      pending.set(key, {
        projectId: work.projectId,
        runKind: work.runKind,
        workKey: work.workKey,
        semanticEpochId: work.semanticEpochId ?? null,
        reasons: [work.reason],
      });
    }
    // A pending timer already represents the next wakeup.  When no timer is
    // present, the current cycle is in flight and its finally block will
    // schedule the coalesced queue.
    if (started && !inFlight && timer === null) {
      schedule(NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS);
    }
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      if (typeof backend?.runNarrativeMaintenanceCycle !== "function") {
        warn(
          "[narrative-maintenance] background runtime disabled: native method unavailable",
        );
        return;
      }
      if (pending.size > 0) {
        schedule(NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS);
      }
    },

    request: enqueue,
    enqueue,

    dispose(): void {
      if (disposed) return;
      disposed = true;
      clearTimer();
      clearCoordinatorWait();
      pending.clear();
      durableWakeProjects.clear();
      durableWakeRetryCounts.clear();
      // An in-flight native call is not forcibly cancelled.  The disposed
      // guard suppresses its warning/re-schedule after completion.
    },
  };
}
