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

export interface NarrativeMaintenanceWorkspaceBinding {
  authorityId: string;
  generation: number;
}

interface PendingNarrativeMaintenanceWork extends NarrativeMaintenanceWork {
  /** Queue-only metadata; never serialized into a Rust work item. */
  workspaceBinding?: NarrativeMaintenanceWorkspaceBinding;
}

/**
 * Request delivered to the future main-only NAPI cycle method. Empty `work`
 * is valid only when `wakeProjectIds` names the durable native backlog scope;
 * this keeps an empty wake meaningful across scheduler/backend boundaries.
 */
export interface NarrativeMaintenanceCycleRequest {
  work: readonly NarrativeMaintenanceWork[];
  wakeProjectIds: readonly string[];
  workspaceBinding?: NarrativeMaintenanceWorkspaceBinding;
}

/**
 * A cycle is only drained after the backend explicitly accepts it.  In
 * particular, workspace-unavailable is not an empty/successful cycle: the
 * scheduler must put the claimed work back on its queue so a later wake can
 * deliver the original trigger.
 */
export type NarrativeMaintenanceCycleResult =
  | { status: "accepted"; hasMore: boolean }
  | { status: "workspace-unavailable"; reason?: string }
  | { status: "coalesced" }
  /** Valid work whose adapter is intentionally not enabled in this lane. */
  | { status: "deferred"; hasMore: boolean };

export interface NarrativeMaintenanceBackendLike {
  /** Synchronous main-only enqueue snapshot; absent in legacy test doubles. */
  getNarrativeMaintenanceWorkspaceBinding?():
    | string
    | NarrativeMaintenanceWorkspaceBinding
    | null;
  /**
   * The backend must acknowledge ownership of the request explicitly.  The
   * scheduler retains/requeues work until it receives `accepted` or
   * `coalesced`.
   */
  runNarrativeMaintenanceCycle?(
    request: NarrativeMaintenanceCycleRequest,
  ): Promise<unknown>;
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
export const NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE = 32;

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

function normalizeWorkspaceBinding(
  raw: unknown,
): NarrativeMaintenanceWorkspaceBinding | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("native maintenance workspace binding returned malformed JSON");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("native maintenance workspace binding returned invalid status");
  }
  const binding = value as Record<string, unknown>;
  if (
    typeof binding.authorityId !== "string" ||
    binding.authorityId.trim().length === 0 ||
    !Number.isSafeInteger(binding.generation) ||
    (binding.generation as number) < 0
  ) {
    throw new Error("native maintenance workspace binding returned invalid status");
  }
  return {
    authorityId: binding.authorityId,
    generation: binding.generation as number,
  };
}

function workspaceBindingKey(
  binding: NarrativeMaintenanceWorkspaceBinding | null | undefined,
): string {
  return binding === undefined
    ? "unbound"
    : binding === null
      ? "unavailable"
      : `${binding.authorityId}\u0000${binding.generation}`;
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
      return {
        status: "workspace-unavailable",
        ...(typeof value.reason === "string"
          ? { reason: value.reason }
          : {}),
      };
    }
    if (value.status === "coalesced") {
      return { status: "coalesced" };
    }
    if (value.status === "deferred" && typeof value.hasMore === "boolean") {
      return { status: "deferred", hasMore: value.hasMore };
    }
    throw new Error("native maintenance cycle returned invalid status");
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
  const pending = new Map<string, PendingNarrativeMaintenanceWork>();
  const retryCounts = new Map<string, number>();
  const sharedCoordinator = backend ? processCoordinator : null;
  // hasMore is a durable native backlog signal, so retain the project that
  // owns the signal.  An unscoped boolean would allow another scheduler to
  // issue the empty wake while this scheduler's project claim is held.
  const durableWakeProjects = new Set<string>();
  const durableWakeBindings = new Map<
    string,
    NarrativeMaintenanceWorkspaceBinding | null | undefined
  >();
  const durableWakeRetryCounts = new Map<string, number>();
  // A deferred adapter must remain durable without creating an idle retry
  // loop.  Keep the canonical work identity parked, rather than the whole
  // project: an enabled Backfill for the same project must still proceed.
  const deferredWorkKeys = new Set<string>();
  const deferredWakeProjects = new Set<string>();
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

  const requeueWork = (work: PendingNarrativeMaintenanceWork): void => {
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

  const hasRunnablePendingWork = (
    blockedProjects: ReadonlySet<string> = new Set(),
  ): boolean =>
    [...pending.values()].some(
      (work) =>
        !deferredWorkKeys.has(canonicalNarrativeMaintenanceWorkKey(work)) &&
        !blockedProjects.has(work.projectId),
    );

  const hasRunnableWake = (
    blockedProjects: ReadonlySet<string> = new Set(),
  ): boolean =>
    [...durableWakeProjects].some(
      (projectId) =>
        !deferredWakeProjects.has(projectId) && !blockedProjects.has(projectId),
    );

  const captureWorkspaceBinding = ():
    | NarrativeMaintenanceWorkspaceBinding
    | null
    | undefined => {
    const getter = backend?.getNarrativeMaintenanceWorkspaceBinding;
    if (typeof getter !== "function") return undefined;
    return normalizeWorkspaceBinding(getter.call(backend));
  };

  const runCycle = async (): Promise<void> => {
    if (disposed || inFlight) return;
    const method = backend?.runNarrativeMaintenanceCycle;
    if (typeof method !== "function") return;

    if (pending.size === 0 && durableWakeProjects.size === 0) return;

    const candidates = [...pending.values()].filter(
      (work) =>
        !deferredWorkKeys.has(canonicalNarrativeMaintenanceWorkKey(work)),
    );
    // Select one authority snapshot before claiming projects. This keeps
    // replacement-workspace identities out of one native cycle and bounds a
    // burst to the same 32-item limit enforced by shared Rust.
    const candidateBindingKey = workspaceBindingKey(
      candidates[0]?.workspaceBinding,
    );
    const chunkCandidates = candidates
      .filter(
        (work) =>
          workspaceBindingKey(work.workspaceBinding) === candidateBindingKey,
      )
      .slice(0, NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE);
    const wakeCandidates = [...durableWakeProjects].filter(
      (projectId) => !deferredWakeProjects.has(projectId),
    );
    const wakeBindingKey = workspaceBindingKey(
      wakeCandidates.length > 0
        ? durableWakeBindings.get(wakeCandidates[0]!)
        : undefined,
    );
    const selectedWakeProjects = wakeCandidates
      .filter(
        (projectId) =>
          workspaceBindingKey(durableWakeBindings.get(projectId)) ===
          wakeBindingKey,
      )
      .slice(0, NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE);
    // Process ordinary work first. A wake-only cycle is represented by an
    // empty batch, but only after its durable project has been claimed.
    const projectIds = [
      ...new Set([
        ...chunkCandidates.map((work) => work.projectId),
        ...(chunkCandidates.length === 0 ? selectedWakeProjects : []),
      ]),
    ];
    const claimedProjects = sharedCoordinator
      ? sharedCoordinator.claimAvailable(projectIds)
      : projectIds;
    const claimedProjectSet = new Set(claimedProjects);
    const blockedProjectIds = projectIds.filter(
      (projectId) => !claimedProjectSet.has(projectId),
    );
    const batch = chunkCandidates.filter((work) =>
      claimedProjectSet.has(work.projectId),
    );
    const deferredBatch = batch.filter((work) => work.runKind !== "backfill");
    const enabledBatch = batch.filter((work) => work.runKind === "backfill");
    // If the whole batch is deferred, send it through the native typed
    // deferred seam.  When enabled work is present, hold only the deferred
    // identities back so another project (or same-project Backfill) can run.
    const backendBatch = enabledBatch.length > 0 ? enabledBatch : batch;
    // Ordinary work and a durable empty wake have separate ACK scopes. Keep
    // the wake pending when a work batch is available and issue it later.
    const sendingWakeProjects =
      backendBatch.length === 0
        ? claimedProjects.filter((projectId) => durableWakeProjects.has(projectId))
        : [];
    const cycleBinding =
      backendBatch[0]?.workspaceBinding ??
      (sendingWakeProjects.length > 0
        ? durableWakeBindings.get(sendingWakeProjects[0]!)
        : undefined);
    const wireBatch: NarrativeMaintenanceWork[] = backendBatch.map((work) => ({
      projectId: work.projectId,
      runKind: work.runKind,
      workKey: work.workKey,
      semanticEpochId: work.semanticEpochId,
      reasons: work.reasons,
    }));
    if (batch.length === 0 && sendingWakeProjects.length === 0) {
      // A competing scheduler owns every project we need. Release-driven
      // wakeup removes the old 10ms busy-poll and cannot starve a project.
      waitForProjectRelease(projectIds);
      return;
    }
    clearCoordinatorWait();
    for (const projectId of sendingWakeProjects) {
      durableWakeProjects.delete(projectId);
      durableWakeBindings.delete(projectId);
    }
    for (const work of backendBatch) {
      pending.delete(canonicalNarrativeMaintenanceWorkKey(work));
    }
    if (enabledBatch.length > 0) {
      for (const work of deferredBatch) {
        deferredWorkKeys.add(canonicalNarrativeMaintenanceWorkKey(work));
      }
    }
    inFlight = true;
    let nextDelayMs = NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS;
    let shouldSchedule = hasRunnablePendingWork() || hasRunnableWake();
    let workspaceUnavailable = false;
    let workspaceMismatch = false;
    let deferredCycle = false;
    try {
      // N-API class methods must be invoked through backend to preserve self.
      const result = await method.call(backend, {
        work: wireBatch,
        wakeProjectIds: sendingWakeProjects,
        ...(cycleBinding !== undefined && cycleBinding !== null
          ? { workspaceBinding: cycleBinding }
          : {}),
      });
      // Validate the response before clearing retry state.  A malformed
      // native response is a failed cycle and consumes the same bounded retry
      // budget as a rejected backend call.  Workspace-unavailable is handled
      // separately below and retains the trigger until acceptance.  This is
      // intentionally after the await and before clearing the claimed work:
      // the catch path requeues the exact batch and wake scope.
      const cycleResult = normalizeCycleResult(result);
      if (cycleResult.status === "workspace-unavailable") {
        if (
          cycleResult.reason === "maintenance-workspace-binding-mismatch" ||
          cycleResult.reason === "maintenance-workspace-binding-missing" ||
          cycleResult.reason === "maintenance-workspace-snapshot-changed"
        ) {
          workspaceMismatch = true;
        } else {
          workspaceUnavailable = true;
        }
        throw new Error(
          "native maintenance cycle could not acquire an active workspace",
        );
      }
      if (cycleResult.status === "deferred") {
        deferredCycle = true;
        throw new Error(
          "native maintenance cycle deferred an unenabled adapter",
        );
      }
      if (
        deferredBatch.length > 0 &&
        deferredBatch.length === backendBatch.length
      ) {
        // A future/native implementation must not be able to accidentally
        // ACK a batch whose every item is still deferred. Keep this guard in
        // main as well as the shared Rust contract so a stale binding cannot
        // drop Verify/Rebuild identities.
        deferredCycle = true;
        throw new Error(
          "native maintenance cycle acknowledged an unenabled adapter",
        );
      }
      for (const projectId of [
        ...new Set([
          ...sendingWakeProjects,
          ...backendBatch.map((work) => work.projectId),
        ]),
      ]) {
        durableWakeRetryCounts.delete(projectId);
      }
      for (const work of backendBatch) {
        retryCounts.delete(canonicalNarrativeMaintenanceWorkKey(work));
      }
      shouldSchedule = hasRunnablePendingWork() || hasRunnableWake();
      if (
        !disposed &&
        cycleResult.status === "accepted" &&
        cycleResult.hasMore
      ) {
        const wakeProjects = [
          ...new Set([
            ...sendingWakeProjects,
            ...backendBatch.map((work) => work.projectId),
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
          for (const projectId of wakeProjects) {
            durableWakeBindings.set(projectId, cycleBinding);
          }
          shouldSchedule = true;
        }
      }
    } catch (error) {
      if (!disposed) {
        if (deferredCycle) {
          for (const work of backendBatch) {
            requeueWork(work);
            deferredWorkKeys.add(canonicalNarrativeMaintenanceWorkKey(work));
          }
          for (const projectId of sendingWakeProjects) {
            durableWakeProjects.add(projectId);
            durableWakeBindings.set(projectId, cycleBinding);
            deferredWakeProjects.add(projectId);
          }
          warn(
            "[narrative-maintenance] adapter is not enabled; retaining deferred trigger",
          );
          // Do not schedule this project again until a new explicit request
          // clears its park.  This is a typed non-ACK, not a retry failure.
          shouldSchedule = false;
        } else if (workspaceMismatch) {
          for (const work of backendBatch) {
            requeueWork(work);
            deferredWorkKeys.add(canonicalNarrativeMaintenanceWorkKey(work));
          }
          for (const projectId of sendingWakeProjects) {
            durableWakeProjects.add(projectId);
            durableWakeBindings.set(projectId, cycleBinding);
            deferredWakeProjects.add(projectId);
          }
          warn(
            "[narrative-maintenance] workspace binding changed; parking trigger until the replacement workspace re-enqueues it",
          );
          // A stale authority must not hot-loop while open/restore is in
          // progress. A replacement-workspace enqueue clears the park.
          shouldSchedule = false;
        } else if (workspaceUnavailable) {
          // This is an expected, recoverable state while a workspace is
          // closed or switching.  It is not a failed delivery and must not
          // consume the bounded error retry budget: dropping this batch would
          // lose the only trigger until another event happens to arrive.
          for (const work of backendBatch) requeueWork(work);
          for (const projectId of sendingWakeProjects) {
            durableWakeProjects.add(projectId);
            durableWakeBindings.set(projectId, cycleBinding);
          }
          warn(
            "[narrative-maintenance] active workspace unavailable; retaining maintenance trigger",
          );
          nextDelayMs = NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS;
          shouldSchedule = hasRunnablePendingWork() || hasRunnableWake();
        } else {
          for (const work of backendBatch) {
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
                durableWakeBindings.set(projectId, cycleBinding);
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
          shouldSchedule = hasRunnablePendingWork() || hasRunnableWake();
        }
      }
    } finally {
      sharedCoordinator?.release(claimedProjects);
      inFlight = false;
      if (
        !disposed &&
        (shouldSchedule || hasRunnablePendingWork() || hasRunnableWake())
      ) {
        const blockedProjects = new Set(blockedProjectIds);
        const hasNewUnblockedPendingWork =
          hasRunnablePendingWork(blockedProjects);
        const hasNewUnblockedWake = hasRunnableWake(blockedProjects);
        if (
          blockedProjectIds.length > 0 &&
          !hasNewUnblockedPendingWork &&
          !hasNewUnblockedWake
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
    const capturedBinding = captureWorkspaceBinding();
    const key = canonicalNarrativeMaintenanceWorkKey(work);
    deferredWorkKeys.delete(key);
    deferredWakeProjects.delete(work.projectId);
    const existing = pending.get(key);
    let queued: PendingNarrativeMaintenanceWork | undefined = existing;
    if (existing && !existing.reasons.includes(work.reason)) {
      queued = {
        ...existing,
        reasons: [...existing.reasons, work.reason],
      };
    } else if (!existing) {
      queued = {
        projectId: work.projectId,
        runKind: work.runKind,
        workKey: work.workKey,
        semanticEpochId: work.semanticEpochId ?? null,
        reasons: [work.reason],
      };
    }
    if (queued && capturedBinding !== undefined) {
      if (capturedBinding === null) {
        delete queued.workspaceBinding;
      } else {
        queued = { ...queued, workspaceBinding: capturedBinding };
      }
    }
    if (queued) {
      pending.set(key, queued);
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
      durableWakeBindings.clear();
      durableWakeRetryCounts.clear();
      // An in-flight native call is not forcibly cancelled.  The disposed
      // guard suppresses its warning/re-schedule after completion.
    },
  };
}
