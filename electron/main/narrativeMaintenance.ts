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
  /**
   * Queue work discovered from one pinned native authority. The binding is
   * deliberately supplied by the discovery response so enqueue does not
   * reacquire a possibly different workspace generation.
   */
  requestWithBinding(
    work: NarrativeMaintenanceRequest,
    binding: NarrativeMaintenanceWorkspaceBinding,
  ): void;
  /** Atomically validate and queue a complete discovery result. */
  requestManyWithBinding(
    work: readonly NarrativeMaintenanceRequest[],
    binding: NarrativeMaintenanceWorkspaceBinding,
  ): void;
  dispose(): void;
}

export interface NarrativeMaintenanceSchedulerOptions {
  warn?: (...args: unknown[]) => void;
  /** Ask the main-only discovery owner to re-read the current authority. */
  onWorkspaceBindingMismatch?: () => void | Promise<void>;
  /** Let the main-only discovery owner advance Rust-owned durable phases. */
  onCycleAccepted?: () => void | Promise<void>;
}

export const NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS = 250;
/** Kept for callers that used the pre-C2-5A polling constant; idle polling is disabled. */
export const NARRATIVE_MAINTENANCE_IDLE_POLL_INTERVAL_MS = 1_000;
export const NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS = 10;
export const NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS = 1_000;
export const NARRATIVE_MAINTENANCE_MAX_RETRIES = 3;
export const NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE = 32;

/**
 * Main-only post-response owner for the C2-5B foreground maintenance barrier.
 *
 * Native owns the durable Run and the exact authority binding. Main owns only
 * the deterministic response boundary: the release is scheduled after a
 * successful ordinary tree-node patch has returned to the renderer. This
 * helper is intentionally kept in this canonical main-only maintenance module
 * and is never exposed through preload or the renderer IPC contract.
 */
interface NarrativeMaintenanceForegroundReleaseBackend {
  claimNarrativeMaintenanceForegroundBarrier?(
    projectId: string,
  ): Promise<unknown> | unknown;
  releaseNarrativeMaintenanceForegroundBarrier?(
    projectId: string,
  ): Promise<unknown> | unknown;
}

type ForegroundBarrierReleaseScheduler = (callback: () => void) => unknown;

/**
 * Gives the renderer/product runner one deterministic ledger observation
 * after the successful patch response before the native terminal transition.
 * This is only used by the authorized CI product-journey seam.
 */
export const NARRATIVE_MAINTENANCE_FOREGROUND_RELEASE_DELAY_MS = 100;

const isNonEmptyTrimmedString = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value === value.trim();

type ForegroundBarrierClaimStatus =
  | { status: "claimed"; runId: string }
  | { status: "not-held" }
  | { status: "ignored" }
  | { status: "workspace-unavailable"; reason?: string };

function parseForegroundBarrierClaim(raw: unknown): ForegroundBarrierClaimStatus {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error("native foreground barrier claim returned malformed JSON");
    }
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    typeof (value as Record<string, unknown>).status !== "string"
  ) {
    throw new Error("native foreground barrier claim returned invalid status");
  }
  const record = value as Record<string, unknown>;
  switch (record.status) {
    case "claimed":
      if (
        Object.keys(record).some((key) => key !== "status" && key !== "runId") ||
        !isNonEmptyTrimmedString(record.runId)
      ) {
        throw new Error("native foreground barrier claim returned invalid claimed status");
      }
      return { status: "claimed", runId: record.runId };
    case "not-held":
    case "ignored":
      if (Object.keys(record).some((key) => key !== "status")) {
        throw new Error("native foreground barrier claim returned invalid status");
      }
      return { status: record.status };
    case "workspace-unavailable":
      if (
        Object.keys(record).some((key) => key !== "status" && key !== "reason") ||
        (record.reason !== undefined && typeof record.reason !== "string")
      ) {
        throw new Error("native foreground barrier claim returned invalid status");
      }
      return {
        status: "workspace-unavailable",
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      };
    default:
      throw new Error("native foreground barrier claim returned unknown status");
  }
}

/**
 * Main-only exact claim gate. The native response is parsed strictly before
 * the caller is allowed to arm the delayed release timer; false, malformed,
 * unavailable, and rejected claims all fail closed.
 */
export async function claimNarrativeMaintenanceForegroundRelease(
  backend: unknown,
  projectId: string,
): Promise<boolean> {
  if (!isNonEmptyTrimmedString(projectId)) return false;
  const claim = (
    backend as NarrativeMaintenanceForegroundReleaseBackend | null
  )?.claimNarrativeMaintenanceForegroundBarrier;
  if (typeof claim !== "function") return false;
  try {
    const result = parseForegroundBarrierClaim(
      await claim.call(backend, projectId),
    );
    return result.status === "claimed";
  } catch (error) {
    console.warn("[grim:invoke] foreground barrier claim failed", error);
    return false;
  }
}

/**
 * Schedule the native foreground barrier only after a successful ordinary
 * tree_node_patch has returned its response to the renderer. A failed native
 * release is deliberately swallowed at this boundary: Native retains the
 * durable marker and exact pending Run for retry/recovery.
 */
export function scheduleNarrativeMaintenanceForegroundRelease(
  backend: unknown,
  projectId: string,
  schedule: ForegroundBarrierReleaseScheduler = (callback) => {
    setTimeout(
      callback,
      NARRATIVE_MAINTENANCE_FOREGROUND_RELEASE_DELAY_MS,
    );
  },
): void {
  if (!isNonEmptyTrimmedString(projectId)) return;
  const release = (
    backend as NarrativeMaintenanceForegroundReleaseBackend | null
  )?.releaseNarrativeMaintenanceForegroundBarrier;
  if (typeof release !== "function") return;
  schedule(() => {
    void Promise.resolve()
      .then(() => release.call(backend, projectId))
      .catch((error: unknown) => {
        console.warn(
          "[grim:invoke] foreground barrier release failed",
          error,
        );
      });
  });
}

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

function scopedWorkKey(work: PendingNarrativeMaintenanceWork): string {
  return `${workspaceBindingKey(work.workspaceBinding)}\u0000${canonicalNarrativeMaintenanceWorkKey(work)}`;
}

function scopedWakeKey(
  projectId: string,
  binding: NarrativeMaintenanceWorkspaceBinding | null | undefined,
): string {
  return `${workspaceBindingKey(binding)}\u0000${projectId}`;
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
  // issue the empty wake while this scheduler's project claim is held. The
  // composite key keeps a replacement authority's wake independent from an
  // old same-project wake that is still retrying.
  const durableWakeProjects = new Map<
    string,
    {
      projectId: string;
      workspaceBinding: NarrativeMaintenanceWorkspaceBinding | null | undefined;
    }
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
    const key = scopedWorkKey(work);
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
        !deferredWorkKeys.has(scopedWorkKey(work)) &&
        !blockedProjects.has(work.projectId),
    );

  const hasRunnableWake = (
    blockedProjects: ReadonlySet<string> = new Set(),
  ): boolean =>
    [...durableWakeProjects.entries()].some(
      ([wakeKey, entry]) =>
        !deferredWakeProjects.has(wakeKey) &&
        !blockedProjects.has(entry.projectId),
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
        !deferredWorkKeys.has(scopedWorkKey(work)),
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
    const wakeCandidates = [...durableWakeProjects.entries()]
      .map(([wakeKey, entry]) => ({ wakeKey, ...entry }))
      .filter(({ wakeKey }) => !deferredWakeProjects.has(wakeKey));
    const wakeBindingKey = workspaceBindingKey(
      wakeCandidates.length > 0
        ? wakeCandidates[0]!.workspaceBinding
        : undefined,
    );
    const selectedWakeEntries = wakeCandidates
      .filter(
        (entry) => workspaceBindingKey(entry.workspaceBinding) === wakeBindingKey,
      )
      .slice(0, NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE);
    // Process ordinary work first. A wake-only cycle is represented by an
    // empty batch, but only after its durable project has been claimed.
    const projectIds = [
      ...new Set([
        ...chunkCandidates.map((work) => work.projectId),
        ...(chunkCandidates.length === 0
          ? selectedWakeEntries.map((entry) => entry.projectId)
          : []),
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
    // Forward the complete validated batch. Verify and Rebuild are automatic
    // dispatch kinds, not JS-side parked work; Rust owns whether a cycle is
    // accepted/coalesced/deferred. Keeping all kinds in one bounded request
    // also prevents mixed batches from permanently parking Verify/Rebuild.
    const backendBatch = batch;
    // Ordinary work and a durable empty wake have separate ACK scopes. Keep
    // the wake pending when a work batch is available and issue it later.
    const sendingWakeEntries =
      backendBatch.length === 0
        ? selectedWakeEntries.filter((entry) =>
            claimedProjectSet.has(entry.projectId),
          )
        : [];
    const sendingWakeProjects = [
      ...new Set(sendingWakeEntries.map((entry) => entry.projectId)),
    ];
    const cycleBinding =
      backendBatch[0]?.workspaceBinding ??
      (sendingWakeProjects.length > 0
        ? sendingWakeEntries[0]!.workspaceBinding
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
    for (const entry of sendingWakeEntries) {
      durableWakeProjects.delete(entry.wakeKey);
      deferredWakeProjects.delete(entry.wakeKey);
    }
    for (const work of backendBatch) {
      pending.delete(scopedWorkKey(work));
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
      if (cycleResult.status === "accepted" && !disposed) {
        try {
          const followup = options.onCycleAccepted?.();
          void Promise.resolve(followup).catch((callbackError: unknown) => {
            warn(
              "[narrative-maintenance] accepted-cycle follow-up failed:",
              callbackError,
            );
          });
        } catch (callbackError) {
          warn(
            "[narrative-maintenance] accepted-cycle follow-up failed:",
            callbackError,
          );
        }
      }
      for (const entry of sendingWakeEntries) {
        durableWakeRetryCounts.delete(
          scopedWakeKey(entry.projectId, entry.workspaceBinding),
        );
      }
      for (const work of backendBatch) {
        retryCounts.delete(scopedWorkKey(work));
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
          for (const projectId of wakeProjects) {
            const wakeKey = scopedWakeKey(projectId, cycleBinding);
            durableWakeProjects.set(wakeKey, {
              projectId,
              workspaceBinding: cycleBinding,
            });
            deferredWakeProjects.delete(wakeKey);
          }
          shouldSchedule = true;
        }
      }
    } catch (error) {
      if (!disposed) {
        if (deferredCycle) {
          for (const work of backendBatch) {
            requeueWork(work);
            deferredWorkKeys.add(scopedWorkKey(work));
          }
          for (const projectId of sendingWakeProjects) {
            const wakeKey = scopedWakeKey(projectId, cycleBinding);
            durableWakeProjects.set(wakeKey, {
              projectId,
              workspaceBinding: cycleBinding,
            });
            deferredWakeProjects.add(wakeKey);
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
            deferredWorkKeys.add(scopedWorkKey(work));
          }
          for (const projectId of sendingWakeProjects) {
            const wakeKey = scopedWakeKey(projectId, cycleBinding);
            durableWakeProjects.set(wakeKey, {
              projectId,
              workspaceBinding: cycleBinding,
            });
            deferredWakeProjects.add(wakeKey);
          }
          warn(
            "[narrative-maintenance] workspace binding changed; parking trigger until the replacement workspace re-enqueues it",
          );
          try {
            const rediscovery = options.onWorkspaceBindingMismatch?.();
            void Promise.resolve(rediscovery).catch((callbackError: unknown) => {
              warn(
                "[narrative-maintenance] authority rediscovery callback failed:",
                callbackError,
              );
            });
          } catch (callbackError) {
            warn(
              "[narrative-maintenance] authority rediscovery callback failed:",
              callbackError,
            );
          }
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
            const wakeKey = scopedWakeKey(projectId, cycleBinding);
            durableWakeProjects.set(wakeKey, {
              projectId,
              workspaceBinding: cycleBinding,
            });
          }
          warn(
            "[narrative-maintenance] active workspace unavailable; retaining maintenance trigger",
          );
          nextDelayMs = NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS;
          shouldSchedule = hasRunnablePendingWork() || hasRunnableWake();
        } else {
          for (const work of backendBatch) {
            const key = scopedWorkKey(work);
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
              const wakeKey = scopedWakeKey(projectId, cycleBinding);
              const retryCount =
                (durableWakeRetryCounts.get(wakeKey) ?? 0) + 1;
              if (retryCount <= NARRATIVE_MAINTENANCE_MAX_RETRIES) {
                durableWakeRetryCounts.set(wakeKey, retryCount);
                durableWakeProjects.set(wakeKey, {
                  projectId,
                  workspaceBinding: cycleBinding,
                });
              } else {
                durableWakeRetryCounts.delete(wakeKey);
                durableWakeProjects.delete(wakeKey);
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

  const enqueue = (
    rawWork: NarrativeMaintenanceRequest,
    explicitBinding?: NarrativeMaintenanceWorkspaceBinding,
  ): void => {
    if (disposed) return;
    const work = validateRequest(rawWork);
    const capturedBinding =
      explicitBinding === undefined
        ? captureWorkspaceBinding()
        : normalizeWorkspaceBinding(explicitBinding);
    const key = `${workspaceBindingKey(capturedBinding)}\u0000${canonicalNarrativeMaintenanceWorkKey(work)}`;
    deferredWorkKeys.delete(key);
    deferredWakeProjects.delete(scopedWakeKey(work.projectId, capturedBinding));
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
    requestWithBinding(work, binding): void {
      const normalizedBinding = normalizeWorkspaceBinding(binding);
      if (normalizedBinding === null) {
        throw new Error(
          "native maintenance discovery returned no workspace binding",
        );
      }
      enqueue(work, normalizedBinding);
    },
    requestManyWithBinding(workItems, binding): void {
      const normalizedBinding = normalizeWorkspaceBinding(binding);
      if (normalizedBinding === null) {
        throw new Error(
          "native maintenance discovery returned no workspace binding",
        );
      }
      // Validate the complete native discovery result before the first queue
      // mutation. A malformed later page/item therefore cannot leave a
      // partial batch behind.
      const validatedWork = workItems.map(validateRequest);
      for (const work of validatedWork) {
        enqueue(work, normalizedBinding);
      }
    },

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
