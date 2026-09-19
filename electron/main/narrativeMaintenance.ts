import { randomUUID } from "node:crypto";

import {
  createNarrativeMaintenanceAttemptController,
  parseNarrativeMaintenanceBeginReceipt,
  parseNarrativeMaintenanceTerminalReceipt,
  type NarrativeMaintenanceTerminalReceipt,
  type NarrativeMaintenanceStopReason,
} from "./narrativeMaintenanceAttempt.js";

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

/** DTO delivered to the main-only NAPI maintenance cycle method. */
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

/**
 * Main-owned lease for a workspace switch quiescence transition. Admission
 * remains closed until every overlapping switch releases its own lease,
 * regardless of completion order. Releasing the same lease is idempotent.
 */
export interface NarrativeMaintenanceQuiesceLease {
  /**
   * Resume admission after the workspace command has completed. A failed
   * Native cleanup receipt is terminal evidence, but it only blocks normal
   * maintenance until an explicit workspace swap has successfully discarded
   * the old connection. Callers that did not complete the swap must pass
   * `false` (or omit the argument for the historical successful path).
   */
  resume(workspaceSwitchSucceeded?: boolean): void;
}

interface PendingNarrativeMaintenanceWork extends NarrativeMaintenanceWork {
  /**
   * Queue-only metadata; never serialized into a Rust work item. The `null`
   * sentinel (binding getter present but workspace unavailable) is stored
   * as-is: `scopedWorkKey` must recompute the exact Map key the item was
   * enqueued under, so a `null` captured at enqueue time cannot degrade to
   * the `undefined`/"unbound" identity on delete/retry/deferred paths.
   */
  workspaceBinding?: NarrativeMaintenanceWorkspaceBinding | null;
}

/**
 * Request delivered to the main-only NAPI maintenance cycle method. Empty `work`
 * is valid only when `wakeProjectIds` names the durable native backlog scope;
 * this keeps an empty wake meaningful across scheduler/backend boundaries.
 */
export interface NarrativeMaintenanceCycleRequest {
  work: readonly NarrativeMaintenanceWork[];
  wakeProjectIds: readonly string[];
  workspaceBinding?: NarrativeMaintenanceWorkspaceBinding;
  /** Process-local lifecycle identity; Native does not persist this field. */
  attemptId?: string;
}

export interface NarrativeMaintenanceDeliveryFailure {
  schemaVersion: 1;
  scope: "work" | "wake";
  projectId: string;
  runKind?: NarrativeMaintenanceRunKind;
  workKey?: string;
  semanticEpochId?: string | null;
  workspaceBinding?: NarrativeMaintenanceWorkspaceBinding | null;
  retryCount: number;
  error: string;
}

/**
 * A cycle is only drained after the backend explicitly accepts it.  In
 * particular, workspace-unavailable is not an empty/successful cycle: the
 * scheduler must put the claimed work back on its queue so a later wake can
 * deliver the original trigger.
 */
export type NarrativeMaintenanceCycleResult =
  | { status: "accepted"; hasMore: boolean; preempted?: boolean }
  | { status: "workspace-unavailable"; reason?: string }
  /**
   * All items coalesced onto an already running/pending Run. This is a
   * no-double-dispatch ACK, not a work-chain-complete ACK: `hasMore` still
   * signals a durable backlog that needs a follow-up wake.
   */
  | { status: "coalesced"; hasMore: boolean }
  /** Valid work whose adapter is intentionally not enabled in this lane. */
  | { status: "deferred"; hasMore: boolean }
  | NarrativeMaintenanceCiTerminalFaultAck
  | NarrativeMaintenanceCiProcessInterruptionAck;

export interface NarrativeMaintenanceCiProcessInterruptionAck {
  status: "ci-process-interruption-pending";
  fault: "process-interruption";
  runId: string;
  authorityId: string;
  generation: number;
}

export interface NarrativeMaintenanceCiTerminalFaultAck {
  status: "ci-terminal-fault-handled";
  fault: "contract-violation";
  runId: string;
  authorityId: string;
  generation: number;
}

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
  /** Main-only attempt lifecycle. These are intentionally absent from IPC. */
  beginNarrativeMaintenanceAttempt?(
    attemptId: string,
    workspaceBinding: NarrativeMaintenanceWorkspaceBinding,
  ): Promise<unknown> | unknown;
  cancelNarrativeMaintenanceAttempt?(
    attemptId: string,
    reason: NarrativeMaintenanceStopReason,
  ): Promise<unknown> | unknown;
  /**
   * Persist a terminal delivery failure before the scheduler drops its
   * process-local claim. Native returns an explicit accepted receipt.
   */
  recordNarrativeMaintenanceDeliveryFailure?(
    failure: NarrativeMaintenanceDeliveryFailure,
  ): Promise<unknown> | unknown;
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
  /** Main-only synchronous state recheck for the CI quiescence writer. */
  getQuiescenceState?(): {
    mutationRevision: number;
    workspaceBinding: NarrativeMaintenanceWorkspaceBinding | null;
    queueIdle: boolean;
    inFlight: boolean;
    hasMore: boolean;
    timerScheduled: boolean;
  };
  /** Stop scheduling, cancel the active attempt, and await its terminal receipt. */
  quiesceForWorkspaceSwitch?(): Promise<
    NarrativeMaintenanceQuiesceLease | undefined | void
  >;
  beginNarrativeMaintenanceAttempt?(
    attemptId: string,
    workspaceBinding: NarrativeMaintenanceWorkspaceBinding,
  ): Promise<unknown>;
  cancelNarrativeMaintenanceAttempt?(
    attemptId: string,
    reason: NarrativeMaintenanceStopReason,
  ): Promise<unknown>;
  dispose(): void | Promise<void>;
}

export interface NarrativeMaintenanceSchedulerOptions {
  warn?: (...args: unknown[]) => void;
  /** Ask the main-only discovery owner to re-read the current authority. */
  onWorkspaceBindingMismatch?: () => void | Promise<void>;
  /** Let the main-only discovery owner advance Rust-owned durable phases. */
  onCycleAccepted?: () => void | Promise<void>;
  /**
   * Publish one completed main scheduler observation to the CI-only
   * quiescence receipt owner. This never crosses the renderer boundary.
   */
  onCycleSettled?: (observation: {
    cycleGeneration: number;
    observedAtMs: number;
    workspaceBinding: NarrativeMaintenanceWorkspaceBinding | null;
    cycleAccepted: boolean;
    queueIdle: boolean;
    inFlight: boolean;
    hasMore: boolean;
    timerScheduled: boolean;
  }) => void | Promise<void>;
  /** Schedule the authorized main-only CI interruption after the running
   * lifecycle has been returned to the product journey for observation. */
  onCiProcessInterruption?: (
    ack: NarrativeMaintenanceCiProcessInterruptionAck,
    expectedBinding: NarrativeMaintenanceWorkspaceBinding,
  ) => boolean | Promise<boolean>;
}

export const NARRATIVE_MAINTENANCE_INITIAL_DELAY_MS = 250;
/** Kept for callers that used the pre-C2-5A polling constant; idle polling is disabled. */
export const NARRATIVE_MAINTENANCE_IDLE_POLL_INTERVAL_MS = 1_000;
export const NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS = 10;
export const NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS = 1_000;
export const NARRATIVE_MAINTENANCE_MAX_RETRIES = 3;
export const NARRATIVE_MAINTENANCE_MAX_WORK_ITEMS_PER_CYCLE = 32;
export const NARRATIVE_MAINTENANCE_PROCESS_EXIT_DELAY_MS = 250;

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
    expectedRunId: string,
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

function parseForegroundBarrierClaim(
  raw: unknown,
): ForegroundBarrierClaimStatus {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(
        "native foreground barrier claim returned malformed JSON",
      );
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
        Object.keys(record).some(
          (key) => key !== "status" && key !== "runId",
        ) ||
        !isNonEmptyTrimmedString(record.runId)
      ) {
        throw new Error(
          "native foreground barrier claim returned invalid claimed status",
        );
      }
      return { status: "claimed", runId: record.runId };
    case "not-held":
    case "ignored":
      if (Object.keys(record).some((key) => key !== "status")) {
        throw new Error(
          "native foreground barrier claim returned invalid status",
        );
      }
      return { status: record.status };
    case "workspace-unavailable":
      if (
        Object.keys(record).some(
          (key) => key !== "status" && key !== "reason",
        ) ||
        (record.reason !== undefined && typeof record.reason !== "string")
      ) {
        throw new Error(
          "native foreground barrier claim returned invalid status",
        );
      }
      return {
        status: "workspace-unavailable",
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      };
    default:
      throw new Error(
        "native foreground barrier claim returned unknown status",
      );
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
): Promise<string | null> {
  if (!isNonEmptyTrimmedString(projectId)) return null;
  const claim = (backend as NarrativeMaintenanceForegroundReleaseBackend | null)
    ?.claimNarrativeMaintenanceForegroundBarrier;
  if (typeof claim !== "function") return null;
  try {
    const result = parseForegroundBarrierClaim(
      await claim.call(backend, projectId),
    );
    return result.status === "claimed" ? result.runId : null;
  } catch (error) {
    console.warn("[grim:invoke] foreground barrier claim failed", error);
    return null;
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
  expectedRunId: string,
  schedule: ForegroundBarrierReleaseScheduler = (callback) => {
    setTimeout(callback, NARRATIVE_MAINTENANCE_FOREGROUND_RELEASE_DELAY_MS);
  },
): void {
  if (
    !isNonEmptyTrimmedString(projectId) ||
    !isNonEmptyTrimmedString(expectedRunId)
  ) {
    return;
  }
  const release = (
    backend as NarrativeMaintenanceForegroundReleaseBackend | null
  )?.releaseNarrativeMaintenanceForegroundBarrier;
  if (typeof release !== "function") return;
  schedule(() => {
    void Promise.resolve()
      .then(() => release.call(backend, projectId, expectedRunId))
      .catch((error: unknown) => {
        console.warn("[grim:invoke] foreground barrier release failed", error);
      });
  });
}

type CiProcessInterruptionExitScheduler = (callback: () => void) => unknown;
type CiProcessExit = (code: number) => never | void;

/**
 * Main-only owner for the typed interruption ACK.  Native has already
 * committed the exact running lifecycle before returning the ACK; this
 * callback deliberately gives the product journey a bounded observation
 * window, then revalidates authorization and the live authority binding
 * before exiting.  Keep the owning scheduler cycle in flight through that
 * window so a concurrent enqueue cannot mistake this process's live Run for
 * startup recovery. Tests inject both the timer and exit function.
 */
export async function scheduleNarrativeMaintenanceProcessInterruption(
  backend: NarrativeMaintenanceBackendLike | null,
  ack: NarrativeMaintenanceCiProcessInterruptionAck,
  expectedBinding: NarrativeMaintenanceWorkspaceBinding,
  isAuthorized: () => boolean,
  schedule: CiProcessInterruptionExitScheduler = (callback) => {
    setTimeout(callback, NARRATIVE_MAINTENANCE_PROCESS_EXIT_DELAY_MS);
  },
  exit: CiProcessExit = (code) => process.exit(code),
): Promise<boolean> {
  if (
    ack.status !== "ci-process-interruption-pending" ||
    ack.fault !== "process-interruption" ||
    !isNonEmptyTrimmedString(ack.runId) ||
    !isNonEmptyTrimmedString(ack.authorityId) ||
    ack.runId.includes("\u0000") ||
    ack.authorityId.includes("\u0000") ||
    !Number.isSafeInteger(ack.generation) ||
    ack.generation <= 0 ||
    !isNonEmptyTrimmedString(expectedBinding.authorityId) ||
    expectedBinding.authorityId.includes("\u0000") ||
    !Number.isSafeInteger(expectedBinding.generation) ||
    expectedBinding.generation <= 0 ||
    ack.authorityId !== expectedBinding.authorityId ||
    ack.generation !== expectedBinding.generation
  ) {
    return false;
  }

  const currentBinding = (): NarrativeMaintenanceWorkspaceBinding | null => {
    try {
      const raw = backend?.getNarrativeMaintenanceWorkspaceBinding?.();
      const normalized = normalizeWorkspaceBinding(raw);
      return normalized;
    } catch {
      return null;
    }
  };
  const sameBinding = (
    left: NarrativeMaintenanceWorkspaceBinding | null,
    right: NarrativeMaintenanceWorkspaceBinding,
  ): boolean =>
    left?.authorityId === right.authorityId &&
    left?.generation === right.generation;

  if (!isAuthorized() || !sameBinding(currentBinding(), expectedBinding)) {
    return false;
  }
  return new Promise<boolean>((resolve, reject) => {
    const scheduled = schedule(() => {
      try {
        if (
          !isAuthorized() ||
          !sameBinding(currentBinding(), expectedBinding)
        ) {
          resolve(false);
          return;
        }
        exit(86);
        resolve(true);
      } catch (error) {
        reject(error);
      }
    });
    if (scheduled === false) resolve(false);
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

export function normalizeWorkspaceBinding(
  raw: unknown,
): NarrativeMaintenanceWorkspaceBinding | null {
  if (raw === null || raw === undefined) return null;
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(
        "native maintenance workspace binding returned malformed JSON",
      );
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "native maintenance workspace binding returned invalid status",
    );
  }
  const binding = value as Record<string, unknown>;
  if (
    typeof binding.authorityId !== "string" ||
    binding.authorityId.trim().length === 0 ||
    !Number.isSafeInteger(binding.generation) ||
    (binding.generation as number) <= 0 ||
    binding.authorityId !== binding.authorityId.trim() ||
    binding.authorityId.includes("\u0000")
  ) {
    throw new Error(
      "native maintenance workspace binding returned invalid status",
    );
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

const NARRATIVE_MAINTENANCE_INTERRUPTED_REQUEUE_REASON =
  "native-maintenance-interrupted";

/**
 * Parse the canonical identity emitted by Native's terminal receipt.  The
 * receipt contains effective identities, while the request delivered by main
 * may still contain an epoch-less or stale wire identity.  Reconstructing a
 * validated request and round-tripping it through the canonical builder keeps
 * this bridge structural instead of depending on substring matching.
 */
function parseCanonicalMaintenanceWorkKey(
  value: unknown,
): NarrativeMaintenanceRequest | null {
  if (typeof value !== "string") return null;
  const segments = value.split("/");
  if (segments.length !== 4 && segments.length !== 6) return null;
  if (segments[0] !== "narrative-maintenance:v1") return null;
  if (segments.length === 6 && segments[4] !== "epoch") return null;

  let runKind: NarrativeMaintenanceRunKind;
  try {
    runKind = requireAutomaticRunKind(segments[1]);
  } catch {
    return null;
  }
  const semanticEpochId = segments.length === 6 ? (segments[5] ?? null) : null;
  const candidate: NarrativeMaintenanceRequest = {
    projectId: segments[2] ?? "",
    runKind,
    workKey: segments[3] ?? "",
    semanticEpochId,
    reason: NARRATIVE_MAINTENANCE_INTERRUPTED_REQUEUE_REASON,
  };
  try {
    const validated = validateRequest(candidate);
    return canonicalNarrativeMaintenanceWorkKey(validated) === value
      ? validated
      : null;
  } catch {
    return null;
  }
}

function sameMaintenanceWorkShape(
  left: Pick<NarrativeMaintenanceRequest, "projectId" | "runKind" | "workKey">,
  right: Pick<NarrativeMaintenanceRequest, "projectId" | "runKind" | "workKey">,
): boolean {
  return (
    left.projectId === right.projectId &&
    left.runKind === right.runKind &&
    left.workKey === right.workKey
  );
}

/**
 * Selectively retain the work that Native says was interrupted.  `null`
 * means the receipt cannot prove coverage of the wire batch; callers must
 * preserve the scheduler's older all-batch retry behavior in that case.
 *
 * Native registers normalized/effective keys, including follow-ups discovered
 * during the cycle.  Initial wire items are matched by exact canonical key,
 * then by their structured identity with the epoch omitted so stale and
 * epoch-less Backfill/Verify requests can be rebound.  Any additional,
 * structurally valid receipt item is a dynamic follow-up and is reconstructed
 * as a normal pending request.
 */
function interruptedMaintenanceWorkToRequeue(
  backendBatch: readonly PendingNarrativeMaintenanceWork[],
  receipt: NarrativeMaintenanceTerminalReceipt | null,
  workspaceBinding: NarrativeMaintenanceWorkspaceBinding | null | undefined,
): readonly PendingNarrativeMaintenanceWork[] | null {
  if (receipt === null || receipt.state !== "interrupted") return null;

  const remaining = [...backendBatch];
  const requeue: PendingNarrativeMaintenanceWork[] = [];
  for (const terminalWork of receipt.works) {
    const effective = parseCanonicalMaintenanceWorkKey(terminalWork.workKey);
    if (effective === null) return null;

    const exactIndex = remaining.findIndex(
      (candidate) =>
        canonicalNarrativeMaintenanceWorkKey(candidate) ===
        terminalWork.workKey,
    );
    let shapeIndex = exactIndex;
    if (shapeIndex < 0) {
      const shapeMatches = remaining.reduce<number[]>(
        (matches, candidate, index) => {
          if (sameMaintenanceWorkShape(candidate, effective)) {
            matches.push(index);
          }
          return matches;
        },
        [],
      );
      // Two epoch variants with the same project/run/work shape cannot be
      // rebound safely when Native has normalized both to an identity that
      // is absent from the wire batch. Preserve the historical full retry
      // path instead of dropping one by arbitrary array order.
      if (shapeMatches.length > 1) return null;
      shapeIndex = shapeMatches[0] ?? -1;
    }
    const matched =
      shapeIndex >= 0 ? remaining.splice(shapeIndex, 1)[0] : undefined;
    const pendingWork: PendingNarrativeMaintenanceWork = matched ?? {
      projectId: effective.projectId,
      runKind: effective.runKind,
      workKey: effective.workKey,
      semanticEpochId: effective.semanticEpochId ?? null,
      reasons: [effective.reason],
      ...(workspaceBinding !== undefined ? { workspaceBinding } : {}),
    };

    if (
      terminalWork.status === "interrupted" ||
      terminalWork.status === "not-started"
    ) {
      requeue.push(pendingWork);
    }
  }

  // A valid receipt must account for every wire item.  If Native omitted an
  // item, retaining the complete batch is safer and preserves the pre-receipt
  // retry policy instead of silently dropping work.
  return remaining.length === 0 ? requeue : null;
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
      return {
        status: "accepted",
        hasMore: value.hasMore,
        ...(value.preempted === true ? { preempted: true } : {}),
      };
    }
    if (value.status === "workspace-unavailable") {
      return {
        status: "workspace-unavailable",
        ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
      };
    }
    if (value.status === "coalesced") {
      // Native always reports hasMore on coalesced. A double that omits it
      // is treated as backlog (fail closed): a coalesced ACK must never
      // silently end the work chain the coalesced Run still owes.
      return {
        status: "coalesced",
        hasMore: typeof value.hasMore === "boolean" ? value.hasMore : true,
      };
    }
    if (value.status === "deferred" && typeof value.hasMore === "boolean") {
      return { status: "deferred", hasMore: value.hasMore };
    }
    if (value.status === "ci-process-interruption-pending") {
      return parseCiProcessInterruptionAck(value);
    }
    if (value.status === "ci-terminal-fault-handled") {
      return parseCiTerminalFaultAck(value);
    }
    throw new Error("native maintenance cycle returned invalid status");
  }
  throw new Error("native maintenance cycle returned invalid status");
}

function deliveryFailureReceiptAccepted(raw: unknown): boolean {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new Error(
        "native maintenance delivery failure receipt returned malformed JSON",
      );
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(
      "native maintenance delivery failure receipt returned invalid status",
    );
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "accepted" &&
    isNonEmptyTrimmedString(record.receiptId) &&
    Object.keys(record).every((key) => ["status", "receiptId"].includes(key))
  ) {
    return true;
  }
  // A receipt against a replaced/unavailable workspace is deliberately a
  // typed non-ACK.  Keep the exact in-memory trigger so it cannot be
  // attributed to a new authority or silently dropped while the native
  // durable receipt/outbox pair was not written.
  if (
    (record.status === "workspace-binding-mismatch" ||
      record.status === "workspace-unavailable") &&
    Object.keys(record).every((key) => key === "status")
  ) {
    return false;
  }
  throw new Error(
    "native maintenance delivery failure receipt was not accepted",
  );
}

const NARRATIVE_MAINTENANCE_TRANSIENT_FAILURE_CODE =
  "NEX_MAINTENANCE_TRANSIENT";
const NARRATIVE_VERIFY_GRAPH_STATE_CHANGED_FAILURE_CODE =
  "NEX_VERIFY_GRAPH_STATE_CHANGED";
const NARRATIVE_MAINTENANCE_ATTEMPT_CANCELLED_CODE =
  "NEX_MAINTENANCE_ATTEMPT_CANCELLED";
const NARRATIVE_MAINTENANCE_CONNECTION_PREEMPTED_CODE =
  "NEX_MAINTENANCE_CONNECTION_PREEMPTED";

function errorMessage(error: unknown): string | null {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : null;
}

function hasExactFailureCode(message: string | null, code: string): boolean {
  return message === code || message?.startsWith(`${code}:`) === true;
}

function isCanonicalTransientFailure(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    hasExactFailureCode(message, NARRATIVE_MAINTENANCE_TRANSIENT_FAILURE_CODE) ||
    hasExactFailureCode(message, NARRATIVE_VERIFY_GRAPH_STATE_CHANGED_FAILURE_CODE)
  );
}

function isControlledMaintenanceInterruption(error: unknown): boolean {
  const message = errorMessage(error);
  return (
    hasExactFailureCode(message, NARRATIVE_MAINTENANCE_ATTEMPT_CANCELLED_CODE) ||
    message?.startsWith(NARRATIVE_MAINTENANCE_CONNECTION_PREEMPTED_CODE) ===
      true ||
    message?.includes("NEX_VALIDATION_TERMINATED:foreground-preempted") === true
  );
}

function isWorkspaceBindingMismatchError(error: unknown): boolean {
  const message = errorMessage(error)?.toLowerCase() ?? "";
  return (
    message.includes("nex_maintenance_attempt_binding_mismatch") ||
    message.includes("native maintenance begin receipt binding mismatch") ||
    message.includes("maintenance-workspace-binding-mismatch") ||
    message.includes("maintenance-workspace-snapshot-changed") ||
    message.includes("stale workspace") ||
    message.includes("old workspace generation") ||
    message.includes("workspace generation changed")
  );
}

function parseCiProcessInterruptionAck(
  value: Record<string, unknown>,
): NarrativeMaintenanceCiProcessInterruptionAck {
  if (
    Object.keys(value).some(
      (key) =>
        !["status", "fault", "runId", "authorityId", "generation"].includes(
          key,
        ),
    ) ||
    value.fault !== "process-interruption" ||
    !isNonEmptyTrimmedString(value.runId) ||
    !isNonEmptyTrimmedString(value.authorityId) ||
    (value.runId as string).includes("\u0000") ||
    (value.authorityId as string).includes("\u0000") ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) <= 0
  ) {
    throw new Error(
      "native maintenance cycle returned invalid process interruption ACK",
    );
  }
  return {
    status: "ci-process-interruption-pending",
    fault: "process-interruption",
    runId: value.runId,
    authorityId: value.authorityId,
    generation: value.generation as number,
  };
}

function parseCiTerminalFaultAck(
  value: Record<string, unknown>,
): NarrativeMaintenanceCiTerminalFaultAck {
  if (
    Object.keys(value).some(
      (key) =>
        !["status", "fault", "runId", "authorityId", "generation"].includes(
          key,
        ),
    ) ||
    value.fault !== "contract-violation" ||
    !isNonEmptyTrimmedString(value.runId) ||
    !isNonEmptyTrimmedString(value.authorityId) ||
    (value.runId as string).includes("\u0000") ||
    (value.authorityId as string).includes("\u0000") ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) <= 0
  ) {
    throw new Error(
      "native maintenance cycle returned invalid terminal fault ACK",
    );
  }
  return {
    status: "ci-terminal-fault-handled",
    fault: "contract-violation",
    runId: value.runId,
    authorityId: value.authorityId,
    generation: value.generation as number,
  };
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
  let inFlightPromise: Promise<void> | null = null;
  const pendingAttemptBegins = new Map<string, Promise<void>>();
  let quiescing = false;
  const activeWorkspaceSwitchOwners = new Set<symbol>();
  let quiesceTransition: Promise<void> | null = null;
  let activeAttemptId: string | null = null;
  // The presence of Native lifecycle methods is only a capability.  An
  // attempt becomes Native-owned after the exact begin acknowledgement has
  // bound its id and workspace generation.  Local test doubles and legacy
  // backends continue through the process-local fallback without being able
  // to fabricate a Native terminal receipt.
  const nativeAttemptIds = new Set<string>();
  // `nativeAttemptIds` is cleared as soon as cancellation adopts a receipt.
  // Keep a separate marker while an in-flight cycle still needs to recover
  // that exact controller-owned receipt after the Native id has disappeared.
  const nativeTerminalReceiptAttemptIds = new Set<string>();
  const ownedAttemptIds = new Set<string>();
  const cancellationFlights = new Map<string, Promise<unknown>>();
  let terminalReceiptFailure: Error | null = null;
  const activeAttemptController = createNarrativeMaintenanceAttemptController();
  let cycleGeneration = 0;
  let mutationRevision = 0;
  let lastHasMore = false;
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

  const noteMutation = (): void => {
    mutationRevision += 1;
  };

  const clearTimer = (): void => {
    if (timer === null) return;
    noteMutation();
    clearTimeout(timer);
    timer = null;
  };

  const clearCoordinatorWait = (): void => {
    cancelCoordinatorWait?.();
    cancelCoordinatorWait = null;
  };

  const schedule = (delayMs: number): void => {
    if (disposed || quiescing) return;
    clearCoordinatorWait();
    clearTimer();
    noteMutation();
    timer = setTimeout(() => {
      noteMutation();
      timer = null;
      const cycle = runCycle();
      inFlightPromise = cycle;
      void cycle
        .finally(() => {
          if (inFlightPromise === cycle) inFlightPromise = null;
        })
        .catch((error: unknown) => {
          warn("[narrative-maintenance] cycle promise rejected:", error);
        });
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
      if (
        !disposed &&
        !inFlight &&
        activeAttemptId === null &&
        pendingAttemptBegins.size === 0 &&
        timer === null
      ) {
        schedule(NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS);
      }
    });
  };

  const requeueWork = (work: PendingNarrativeMaintenanceWork): void => {
    noteMutation();
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
  const persistDeliveryFailure = async (
    failure: NarrativeMaintenanceDeliveryFailure,
  ): Promise<boolean> => {
    const recordFailure = backend?.recordNarrativeMaintenanceDeliveryFailure;
    if (typeof recordFailure !== "function") {
      warn(
        "[narrative-maintenance] Native failure receipt API is unavailable; retaining trigger",
      );
      return false;
    }
    try {
      return deliveryFailureReceiptAccepted(
        await recordFailure.call(backend, failure),
      );
    } catch (receiptError) {
      warn(
        "[narrative-maintenance] failed to persist delivery failure receipt; retaining trigger:",
        receiptError,
      );
      return false;
    }
  };

  const registerAttempt = async (
    attemptId: string,
    binding: NarrativeMaintenanceWorkspaceBinding,
  ): Promise<void> => {
    if (
      (activeAttemptId !== null && activeAttemptId !== attemptId) ||
      [...pendingAttemptBegins.keys()].some((id) => id !== attemptId)
    ) {
      throw new Error(
        "NEX_MAINTENANCE_ATTEMPT_ACTIVE: another maintenance attempt is already active",
      );
    }
    const begin = backend?.beginNarrativeMaintenanceAttempt;
    if (typeof begin === "function") {
      activeAttemptController.markNativeRegistrationPending(attemptId);
    }
    const registration = (async () => {
      if (typeof begin === "function") {
        const rawReceipt = await begin.call(backend, attemptId, binding);
        if (rawReceipt !== undefined) {
          const receipt = parseNarrativeMaintenanceBeginReceipt(rawReceipt);
          if (
            receipt.attemptId !== attemptId ||
            receipt.authorityId !== binding.authorityId ||
            receipt.generation !== binding.generation
          ) {
            throw new Error(
              "native maintenance begin receipt binding mismatch",
            );
          }
          activeAttemptController.markNativeOwned(attemptId);
          nativeAttemptIds.add(attemptId);
        } else {
          activeAttemptController.markNativeRegistrationResolved(attemptId);
        }
      }
      // Publish the active id only after Native has accepted the binding. A
      // workspace switch/dispose waiting on this registration can then issue
      // cancellation against a known Native attempt, never an UNKNOWN id.
      activeAttemptId = attemptId;
    })();
    pendingAttemptBegins.set(attemptId, registration);
    try {
      await registration;
    } catch (error) {
      // Native did not publish a usable registration.  Settle the local
      // placeholder only for this pre-registration failure; once Native has
      // accepted the attempt, all later terminalization must come from its
      // receipt.
      activeAttemptController.markNativeRegistrationResolved(attemptId);
      activeAttemptController.settle(attemptId, { state: "interrupted" });
      nativeAttemptIds.delete(attemptId);
      throw error;
    } finally {
      if (pendingAttemptBegins.get(attemptId) === registration) {
        pendingAttemptBegins.delete(attemptId);
      }
    }
  };

  const settleAttempt = (
    attemptId: string,
    state: "interrupted" | "succeeded",
    publishedGeneration: number | null = null,
  ): void => {
    const snapshot = activeAttemptController.snapshot(attemptId);
    if (!snapshot) return;
    if (snapshot.state === "interrupted" || snapshot.state === "succeeded") {
      return;
    }
    activeAttemptController.settle(attemptId, {
      state,
      publishedGeneration,
    });
  };

  const cleanupUnregisteredAttempt = (attemptId: string): void => {
    // A conflict can be detected before registerAttempt creates its pending
    // Native registration.  The controller entry must still be closed so a
    // failed automatic admission cannot strand an open attempt or affect the
    // next manual operation.
    if (nativeAttemptIds.has(attemptId)) return;
    const snapshot = activeAttemptController.snapshot(attemptId);
    if (
      snapshot &&
      snapshot.state !== "interrupted" &&
      snapshot.state !== "succeeded"
    ) {
      try {
        activeAttemptController.markNativeRegistrationResolved(attemptId);
      } catch {
        // registerAttempt may already have resolved the local registration.
      }
      settleAttempt(attemptId, "interrupted");
    }
    if (activeAttemptId === attemptId) {
      activeAttemptId = null;
    }
    releaseAttemptOwner(attemptId);
  };

  const retainAttemptOwner = (attemptId: string): void => {
    if (ownedAttemptIds.has(attemptId)) return;
    activeAttemptController.retainOwner(attemptId);
    ownedAttemptIds.add(attemptId);
  };

  const releaseAttemptOwner = (attemptId: string): void => {
    if (!ownedAttemptIds.delete(attemptId)) return;
    activeAttemptController.releaseOwner(attemptId);
  };

  const terminalReceiptReuseError = (
    receipt: Awaited<
      ReturnType<typeof parseNarrativeMaintenanceTerminalReceipt>
    >,
  ): Error | null => {
    return receipt.cleanup.status !== "clean" || !receipt.connectionReusable
      ? new Error(
          "NEX_MAINTENANCE_CONNECTION_UNUSABLE: maintenance cleanup did not make the Native connection reusable",
        )
      : null;
  };

  const cancelAttemptById = async (
    attemptId: string,
    reason: NarrativeMaintenanceStopReason,
  ): Promise<
    Awaited<ReturnType<typeof parseNarrativeMaintenanceTerminalReceipt>>
  > => {
    const existingFlight = cancellationFlights.get(attemptId);
    if (existingFlight) {
      return (await existingFlight) as Awaited<
        ReturnType<typeof parseNarrativeMaintenanceTerminalReceipt>
      >;
    }
    const operation = (async () => {
      const localCancellation = activeAttemptController.requestStop(
        attemptId,
        reason,
      );
      // A direct cancel may race the Native begin call.  Await this exact
      // registration rather than consulting the scheduler's current active
      // id, which is deliberately unpublished until the binding ACK arrives.
      const pendingBegin = pendingAttemptBegins.get(attemptId);
      if (pendingBegin) await pendingBegin.catch(() => undefined);
      const cancel = backend?.cancelNarrativeMaintenanceAttempt;
      const nativeRawReceipt =
        nativeAttemptIds.has(attemptId) && typeof cancel === "function"
          ? await cancel.call(backend, attemptId, reason)
          : undefined;
      let nativeReceipt:
        | Awaited<ReturnType<typeof parseNarrativeMaintenanceTerminalReceipt>>
        | undefined;
      if (nativeRawReceipt !== undefined) {
        const parsedReceipt =
          parseNarrativeMaintenanceTerminalReceipt(nativeRawReceipt);
        nativeReceipt = activeAttemptController.adoptTerminalReceipt(
          attemptId,
          parsedReceipt,
        );
        nativeTerminalReceiptAttemptIds.add(attemptId);
        nativeAttemptIds.delete(attemptId);
        // A terminal receipt is still authoritative even when cleanup could
        // not prove connection reuse. Keep the receipt in the controller so
        // workspace switching can discard the old Native authority, while
        // retaining a fail-closed marker that prevents ordinary maintenance
        // from resuming on the quarantined connection.
        terminalReceiptFailure = terminalReceiptReuseError(parsedReceipt);
      }
      const localReceipt = await localCancellation;
      if (
        !inFlight &&
        activeAttemptId === attemptId &&
        !nativeAttemptIds.has(attemptId)
      ) {
        activeAttemptId = null;
      }
      if (!inFlight || activeAttemptId !== attemptId) {
        releaseAttemptOwner(attemptId);
        nativeTerminalReceiptAttemptIds.delete(attemptId);
      }
      return nativeReceipt ?? localReceipt;
    })();
    cancellationFlights.set(attemptId, operation);
    try {
      return await operation;
    } finally {
      if (cancellationFlights.get(attemptId) === operation) {
        cancellationFlights.delete(attemptId);
      }
    }
  };

  const cancelActiveAttempt = async (
    reason: NarrativeMaintenanceStopReason,
  ): Promise<
    Awaited<ReturnType<typeof parseNarrativeMaintenanceTerminalReceipt>> | undefined
  > => {
    const attemptId =
      activeAttemptId ?? pendingAttemptBegins.keys().next().value ?? null;
    if (typeof attemptId !== "string") return undefined;
    return cancelAttemptById(attemptId, reason);
  };

  const waitForAdoptedNativeTerminalReceipt = async (
    attemptId: string,
  ): Promise<
    Awaited<ReturnType<typeof parseNarrativeMaintenanceTerminalReceipt>> | null
  > => {
    if (!nativeTerminalReceiptAttemptIds.has(attemptId)) return null;
    try {
      // The controller owns the exact parsed receipt. Waiting is idempotent
      // for an already-adopted terminal and covers the small window where
      // adoption is visible before its waiter is released.
      return await activeAttemptController.waitForTerminal(attemptId);
    } catch (error) {
      // A missing controller receipt is not evidence that any work succeeded;
      // callers retain the historical fail-closed all-batch retry behavior.
      warn(
        "[narrative-maintenance] adopted Native terminal receipt unavailable:",
        error,
      );
      return null;
    }
  };

  const runCycle = async (): Promise<void> => {
    // Manual Verify/Rebuild attempts reserve the same admission slot as an
    // automatic cycle.  A timer that fires while that slot is occupied must
    // leave the queue untouched; the manual terminal path schedules the next
    // wake after releasing the reservation.
    if (
      disposed ||
      quiescing ||
      inFlight ||
      activeAttemptId !== null ||
      pendingAttemptBegins.size > 0
    ) {
      return;
    }
    const method = backend?.runNarrativeMaintenanceCycle;
    if (typeof method !== "function") return;

    if (pending.size === 0 && durableWakeProjects.size === 0) return;
    noteMutation();

    const candidates = [...pending.values()].filter(
      (work) => !deferredWorkKeys.has(scopedWorkKey(work)),
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
        (entry) =>
          workspaceBindingKey(entry.workspaceBinding) === wakeBindingKey,
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
    noteMutation();
    let nextDelayMs = NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS;
    let shouldSchedule = hasRunnablePendingWork() || hasRunnableWake();
    let workspaceUnavailable = false;
    let workspaceMismatch = false;
    let deferredCycle = false;
    let haltForProcessInterruption = false;
    let interruptedCycle = false;
    let settledCycleResult: NarrativeMaintenanceCycleResult | null = null;
    const lifecycleEnabled =
      cycleBinding !== undefined &&
      cycleBinding !== null &&
      typeof backend?.beginNarrativeMaintenanceAttempt === "function" &&
      typeof backend?.cancelNarrativeMaintenanceAttempt === "function";
    const cycleAttemptId = lifecycleEnabled ? randomUUID() : null;
    let nativeReceiptAdopted = false;
    let nativeTerminalReceipt:
      | Awaited<ReturnType<typeof parseNarrativeMaintenanceTerminalReceipt>>
      | null = null;
    try {
      if (cycleAttemptId && cycleBinding) {
        await beginAttempt(cycleAttemptId, cycleBinding, backendBatch);
        if (disposed || quiescing) {
          interruptedCycle = true;
          throw new Error("NEX_MAINTENANCE_ATTEMPT_CANCELLED");
        }
      }
      // N-API class methods must be invoked through backend to preserve self.
      const result = await method.call(backend, {
        work: wireBatch,
        wakeProjectIds: sendingWakeProjects,
        ...(cycleBinding !== undefined && cycleBinding !== null
          ? { workspaceBinding: cycleBinding }
          : {}),
        ...(cycleAttemptId ? { attemptId: cycleAttemptId } : {}),
      });
      // Validate the response before clearing retry state.  A malformed
      // native response is a failed cycle and consumes the same bounded retry
      // budget as a rejected backend call.  Workspace-unavailable is handled
      // separately below and retains the trigger until acceptance.  This is
      // intentionally after the await and before clearing the claimed work:
      // the catch path requeues the exact batch and wake scope.
      const cycleResult = normalizeCycleResult(result);
      settledCycleResult = cycleResult;
      const terminalFaultHandled =
        cycleResult.status === "ci-terminal-fault-handled";
      interruptedCycle =
        cycleResult.status === "accepted" && cycleResult.preempted === true;
      lastHasMore =
        (cycleResult.status === "accepted" ||
          cycleResult.status === "coalesced") &&
        cycleResult.hasMore === true;
      if (cycleResult.status === "ci-process-interruption-pending") {
        // The running triplet is deliberately not sent through ordinary ACK,
        // recovery, or follow-up handling.  A binding mismatch is fail-closed
        // and never schedules an exit; the durable running row remains for
        // explicit reopen recovery.
        let exitScheduled = false;
        if (
          cycleBinding &&
          cycleResult.authorityId === cycleBinding.authorityId &&
          cycleResult.generation === cycleBinding.generation
        ) {
          try {
            exitScheduled =
              (await options.onCiProcessInterruption?.(
                cycleResult,
                cycleBinding,
              )) === true;
          } catch (error) {
            warn(
              "[narrative-maintenance] process interruption owner rejected ACK:",
              error,
            );
          }
        } else {
          warn(
            "[narrative-maintenance] process interruption ACK binding mismatch; exit not scheduled",
          );
        }
        if (!exitScheduled) {
          throw new Error(
            "native process interruption ACK was not scheduled by the authorized main owner",
          );
        }
        haltForProcessInterruption = true;
      }
      if (cycleResult.status === "ci-terminal-fault-handled") {
        // The shared owner already failed the exact Run/Task/Attempt and
        // projected the stable Inbox identity.  This is a handled terminal
        // outcome, not a delivery error, so no generic retry is requeued.
        if (
          !cycleBinding ||
          cycleResult.authorityId !== cycleBinding.authorityId ||
          cycleResult.generation !== cycleBinding.generation
        ) {
          throw new Error(
            "native terminal fault ACK binding mismatch; durable run identity cannot be proven",
          );
        }
      }
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
      if (cycleAttemptId) {
        if (nativeAttemptIds.has(cycleAttemptId)) {
          // Native has already settled its attempt before returning the cycle
          // result. Fetch that authoritative receipt through the idempotent
          // cancel endpoint so local state cannot replace per-work outcomes
          // or cleanup facts with a placeholder.
          const parsedReceipt = await cancelAttemptById(
            cycleAttemptId,
            "closed",
          );
          nativeTerminalReceipt = parsedReceipt;
          nativeReceiptAdopted = true;
          if (parsedReceipt.state === "interrupted") {
            interruptedCycle =
              interruptedCycle || parsedReceipt.stopReason !== null;
            if (interruptedCycle) {
              throw new Error("NEX_MAINTENANCE_ATTEMPT_CANCELLED");
            }
            if (!terminalFaultHandled) {
              const receiptErrors = parsedReceipt.works
                .map((work) => work.error)
                .filter((error): error is string => error !== undefined);
              throw new Error(
                receiptErrors.length > 0
                  ? `native maintenance attempt returned interrupted terminal receipt: ${receiptErrors.join("; ")}`
                  : "native maintenance attempt returned interrupted terminal receipt",
              );
            }
          }
        } else if (!activeAttemptController.grantFinalize(cycleAttemptId)) {
          // A concurrent quiesce/cancel may already have adopted Native's
          // terminal receipt. Recover that exact controller-owned value before
          // the catch path decides which work to requeue; it cannot be
          // replaced by a local placeholder.
          if (nativeTerminalReceipt === null) {
            nativeTerminalReceipt =
              await waitForAdoptedNativeTerminalReceipt(cycleAttemptId);
            nativeReceiptAdopted = nativeTerminalReceipt !== null;
          }
          // Finalization may already have won before the late cancellation.
          // Preserve that terminal success and let the accepted cycle clear
          // its claimed batch; only an interrupted or unavailable receipt
          // enters the selective-requeue path below.
          if (nativeTerminalReceipt?.state !== "succeeded") {
            interruptedCycle = true;
            const attemptSnapshot =
              activeAttemptController.snapshot(cycleAttemptId);
            if (attemptSnapshot?.state === "stop-requested") {
              settleAttempt(cycleAttemptId, "interrupted");
            }
            throw new Error("NEX_MAINTENANCE_ATTEMPT_CANCELLED");
          }
        } else {
          settleAttempt(
            cycleAttemptId,
            "succeeded",
            cycleBinding?.generation ?? null,
          );
        }
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
        (cycleResult.status === "accepted" ||
          cycleResult.status === "coalesced") &&
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
        const attemptSnapshotBeforeCleanup = cycleAttemptId
          ? activeAttemptController.snapshot(cycleAttemptId)
          : null;
        const cancellationRequestedBeforeFailure =
          interruptedCycle ||
          isControlledMaintenanceInterruption(error) ||
          attemptSnapshotBeforeCleanup?.state === "stop-requested";
        workspaceMismatch =
          workspaceMismatch || isWorkspaceBindingMismatchError(error);
        if (cycleAttemptId && nativeTerminalReceipt === null) {
          const adoptedReceipt =
            await waitForAdoptedNativeTerminalReceipt(cycleAttemptId);
          if (adoptedReceipt !== null) {
            nativeTerminalReceipt = adoptedReceipt;
            nativeReceiptAdopted = true;
            // A cycle rejection can arrive after external cancellation has
            // already terminalized the controller, so its snapshot is no
            // longer `stop-requested`. The receipt is the authoritative
            // interruption signal for selective requeue in that path.
            interruptedCycle = adoptedReceipt.state === "interrupted";
          }
        }
        const nativeAttemptActive =
          nativeAttemptIds.has(cycleAttemptId ?? "") &&
          cycleAttemptId !== null &&
          activeAttemptId === cycleAttemptId;
        if (nativeAttemptActive && !nativeReceiptAdopted) {
          try {
            nativeTerminalReceipt =
              (await cancelAttemptById(cycleAttemptId, "closed")) ?? null;
            nativeReceiptAdopted = true;
            const receiptConfirmsCancellation =
              nativeTerminalReceipt?.state === "interrupted" &&
              nativeTerminalReceipt.stopReason !== null &&
              cancellationRequestedBeforeFailure;
            interruptedCycle =
              cancellationRequestedBeforeFailure || receiptConfirmsCancellation;
          } catch (receiptError) {
            // Keep the Native-backed attempt unresolved when cleanup cannot be
            // proven. A local interrupted placeholder would hide the missing
            // terminal receipt and let workspace shutdown race the owner.
            warn(
              "[narrative-maintenance] Native terminal receipt unavailable after cycle failure:",
              receiptError,
            );
            terminalReceiptFailure =
              receiptError instanceof Error
                ? receiptError
                : new Error(String(receiptError));
          }
        }
        const attemptSnapshot = cycleAttemptId
          ? activeAttemptController.snapshot(cycleAttemptId)
          : null;
        if (
          cycleAttemptId &&
          !nativeAttemptActive &&
          attemptSnapshot &&
          attemptSnapshot.state !== "interrupted" &&
          attemptSnapshot.state !== "succeeded"
        ) {
          interruptedCycle =
            interruptedCycle ||
            cancellationRequestedBeforeFailure ||
            attemptSnapshot.state === "stop-requested";
          settleAttempt(cycleAttemptId, "interrupted");
        }
        if (nativeTerminalReceipt?.state === "succeeded") {
          // Native already committed this cycle before the late cancellation
          // reached it. Do not requeue a claimed work item or wake that the
          // receipt has already completed.
          for (const entry of sendingWakeEntries) {
            durableWakeRetryCounts.delete(
              scopedWakeKey(entry.projectId, entry.workspaceBinding),
            );
          }
          for (const work of backendBatch) {
            retryCounts.delete(scopedWorkKey(work));
          }
          shouldSchedule = hasRunnablePendingWork() || hasRunnableWake();
        } else if (deferredCycle) {
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
        } else if (interruptedCycle) {
          const selectivelyRequeued = interruptedMaintenanceWorkToRequeue(
            backendBatch,
            nativeTerminalReceipt,
            cycleBinding,
          );
          // A missing or unusable Native receipt keeps the historical retry
          // behavior. Once Native has supplied a complete per-work receipt,
          // retain only interrupted/not-started executions; successful work
          // has already crossed its durable completion boundary.
          for (const work of selectivelyRequeued ?? backendBatch) {
            requeueWork(work);
          }
          for (const projectId of sendingWakeProjects) {
            const wakeKey = scopedWakeKey(projectId, cycleBinding);
            durableWakeProjects.set(wakeKey, {
              projectId,
              workspaceBinding: cycleBinding,
            });
          }
          shouldSchedule = hasRunnablePendingWork() || hasRunnableWake();
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
            void Promise.resolve(rediscovery).catch(
              (callbackError: unknown) => {
                warn(
                  "[narrative-maintenance] authority rediscovery callback failed:",
                  callbackError,
                );
              },
            );
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
          let requeuedCount = 0;
          let firstRetryCount: number | null = null;
          for (const work of backendBatch) {
            const key = scopedWorkKey(work);
            const retryCount = (retryCounts.get(key) ?? 0) + 1;
            if (retryCount <= NARRATIVE_MAINTENANCE_MAX_RETRIES) {
              retryCounts.set(key, retryCount);
              requeueWork(work);
              requeuedCount += 1;
              firstRetryCount ??= retryCount;
            } else {
              // Delivery failed before Native created any Run/Attempt/Inbox
              // evidence. Persist the native receipt/outbox pair first; only
              // then may this work leave the bounded retry queue. The native
              // outbox is the durable recovery owner across restart, rather
              // than this process-local parked Map.
              retryCounts.set(key, retryCount);
              const accepted = await persistDeliveryFailure({
                schemaVersion: 1,
                scope: "work",
                projectId: work.projectId,
                runKind: work.runKind,
                workKey: work.workKey,
                semanticEpochId: work.semanticEpochId,
                workspaceBinding: work.workspaceBinding ?? null,
                retryCount,
                error: error instanceof Error ? error.message : String(error),
              });
              if (accepted) {
                retryCounts.delete(key);
                warn(
                  `[narrative-maintenance] retry exhausted for canonical key ${key}; native failure receipt and durable recovery wake persisted for project ${work.projectId}`,
                  error,
                );
              } else {
                requeueWork(work);
                requeuedCount += 1;
                firstRetryCount ??= Math.min(
                  retryCount,
                  NARRATIVE_MAINTENANCE_MAX_RETRIES,
                );
              }
            }
          }
          if (sendingWakeProjects.length > 0) {
            for (const projectId of sendingWakeProjects) {
              const wakeKey = scopedWakeKey(projectId, cycleBinding);
              const retryCount = (durableWakeRetryCounts.get(wakeKey) ?? 0) + 1;
              if (retryCount <= NARRATIVE_MAINTENANCE_MAX_RETRIES) {
                durableWakeRetryCounts.set(wakeKey, retryCount);
                durableWakeProjects.set(wakeKey, {
                  projectId,
                  workspaceBinding: cycleBinding,
                });
                requeuedCount += 1;
                firstRetryCount ??= retryCount;
              } else {
                const accepted = await persistDeliveryFailure({
                  schemaVersion: 1,
                  scope: "wake",
                  projectId,
                  workspaceBinding: cycleBinding,
                  retryCount,
                  error: error instanceof Error ? error.message : String(error),
                });
                if (accepted) {
                  durableWakeRetryCounts.delete(wakeKey);
                  warn(
                    `[narrative-maintenance] durable backlog retry exhausted for project ${projectId}; native failure receipt and durable recovery wake persisted`,
                    error,
                  );
                } else {
                  durableWakeRetryCounts.set(wakeKey, retryCount);
                  durableWakeProjects.set(wakeKey, {
                    projectId,
                    workspaceBinding: cycleBinding,
                  });
                  requeuedCount += 1;
                  firstRetryCount ??= Math.min(
                    retryCount,
                    NARRATIVE_MAINTENANCE_MAX_RETRIES,
                  );
                }
              }
            }
          }
          if (haltForProcessInterruption) {
            // The authorized CI seam has already durably acknowledged the
            // running lifecycle and scheduled process exit. Its interrupted
            // terminal receipt is expected; emitting it as a background
            // error makes the product journey classify a controlled exit as
            // a main-process failure.
          } else if (requeuedCount > 0 && isCanonicalTransientFailure(error)) {
            warn(
              `[narrative-maintenance] ${NARRATIVE_MAINTENANCE_TRANSIENT_FAILURE_CODE} retry scheduled (${requeuedCount} queued, attempt ${firstRetryCount ?? 1}/${NARRATIVE_MAINTENANCE_MAX_RETRIES})`,
            );
          } else {
            warn("[narrative-maintenance] background cycle failed:", error);
          }
          nextDelayMs = NARRATIVE_MAINTENANCE_ERROR_RETRY_DELAY_MS;
          shouldSchedule = hasRunnablePendingWork() || hasRunnableWake();
        }
      }
    } finally {
      sharedCoordinator?.release(claimedProjects);
      inFlight = false;
      if (cycleAttemptId && !lifecycleEnabled) {
        const attemptSnapshot = activeAttemptController.snapshot(cycleAttemptId);
        if (
          attemptSnapshot &&
          attemptSnapshot.state !== "interrupted" &&
          attemptSnapshot.state !== "succeeded"
        ) {
          settleAttempt(cycleAttemptId, "interrupted");
        }
      }
      if (
        activeAttemptId === cycleAttemptId &&
        (!nativeAttemptIds.has(cycleAttemptId ?? "") || nativeReceiptAdopted)
      ) {
        activeAttemptId = null;
        if (cycleAttemptId) nativeAttemptIds.delete(cycleAttemptId);
      }
      if (
        cycleAttemptId &&
        !nativeAttemptIds.has(cycleAttemptId) &&
        activeAttemptId !== cycleAttemptId
      ) {
        releaseAttemptOwner(cycleAttemptId);
      }
      if (cycleAttemptId) {
        nativeTerminalReceiptAttemptIds.delete(cycleAttemptId);
      }
      noteMutation();
      if (
        !disposed &&
        terminalReceiptFailure === null &&
        !haltForProcessInterruption &&
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
      cycleGeneration += 1;
      noteMutation();
      let settledBinding: NarrativeMaintenanceWorkspaceBinding | null = null;
      try {
        const candidate = cycleBinding ?? captureWorkspaceBinding();
        settledBinding = candidate === undefined ? null : candidate;
      } catch (error) {
        warn(
          "[narrative-maintenance] quiescence binding observation failed:",
          error,
        );
      }
      const cycleAccepted =
        settledCycleResult?.status === "accepted" ||
        settledCycleResult?.status === "coalesced";
      const hasMore =
        cycleAccepted &&
        settledCycleResult !== null &&
        "hasMore" in settledCycleResult
          ? settledCycleResult.hasMore
          : false;
      const queueIdle =
        !disposed &&
        !inFlight &&
        timer === null &&
        pending.size === 0 &&
        durableWakeProjects.size === 0 &&
        deferredWorkKeys.size === 0 &&
        deferredWakeProjects.size === 0;
      try {
        const observation = options.onCycleSettled?.({
          cycleGeneration,
          observedAtMs: Date.now(),
          workspaceBinding: settledBinding,
          cycleAccepted,
          queueIdle,
          inFlight: false,
          hasMore,
          timerScheduled: timer !== null,
        });
        void Promise.resolve(observation).catch((callbackError: unknown) => {
          warn(
            "[narrative-maintenance] quiescence observation callback failed:",
            callbackError,
          );
        });
      } catch (callbackError) {
        warn(
          "[narrative-maintenance] quiescence observation callback failed:",
          callbackError,
        );
      }
    }
  };

  const beginAttempt = async (
    attemptId: string,
    binding: NarrativeMaintenanceWorkspaceBinding,
    workItems: readonly NarrativeMaintenanceWork[],
  ): Promise<void> => {
    activeAttemptController.begin(attemptId, binding);
    retainAttemptOwner(attemptId);
    for (const work of workItems) {
      const identity = canonicalNarrativeMaintenanceWorkKey(work);
      activeAttemptController.addWork(attemptId, identity);
    }
    try {
      await registerAttempt(attemptId, binding);
    } catch (error) {
      cleanupUnregisteredAttempt(attemptId);
      throw error;
    }
  };

  const performWorkspaceQuiesce = async (): Promise<void> => {
    quiescing = true;
    clearTimer();
    clearCoordinatorWait();
    const pendingBegins = [...pendingAttemptBegins.values()];
    if (pendingBegins.length > 0) {
      await Promise.all(
        pendingBegins.map((pending) => pending.catch(() => undefined)),
      );
    }
    await cancelActiveAttempt("workspace-generation-changed");
    const running = inFlightPromise;
    if (running) await running;
  };

  const quiesceForWorkspaceSwitch = async (): Promise<
    NarrativeMaintenanceQuiesceLease | undefined
  > => {
    if (disposed) return undefined;
    // Retain before awaiting the shared stop barrier. Completion order is
    // independent of admission order, so a latest-generation check alone
    // cannot prove that all outstanding workspace switches have finished.
    const owner = Symbol("workspace-switch");
    activeWorkspaceSwitchOwners.add(owner);
    try {
      if (quiesceTransition === null) {
        quiesceTransition = performWorkspaceQuiesce().finally(() => {
          quiesceTransition = null;
        });
      }
      await quiesceTransition;
    } catch (error) {
      activeWorkspaceSwitchOwners.delete(owner);
      // Do not reopen admission after an unproven terminal/cleanup result.
      throw error;
    }
    return {
      resume: (workspaceSwitchSucceeded = true) => {
        if (!activeWorkspaceSwitchOwners.delete(owner)) return;
        if (workspaceSwitchSucceeded && terminalReceiptFailure !== null) {
          // Native's successful workspace swap has quarantined/discarded the
          // old connection. The failed receipt remains observable in the
          // process-local controller, but it no longer blocks admission for
          // the new workspace generation.
          terminalReceiptFailure = null;
        }
        if (
          disposed ||
          (!workspaceSwitchSucceeded && terminalReceiptFailure !== null) ||
          activeWorkspaceSwitchOwners.size !== 0 ||
          !quiescing
        ) {
          return;
        }
        quiescing = false;
        if (
          started &&
          !inFlight &&
          activeAttemptId === null &&
          pendingAttemptBegins.size === 0 &&
          timer === null &&
          (hasRunnablePendingWork() || hasRunnableWake())
        ) {
          schedule(NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS);
        }
      },
    };
  };

  const enqueue = (
    rawWork: NarrativeMaintenanceRequest,
    explicitBinding?: NarrativeMaintenanceWorkspaceBinding,
  ): void => {
    if (disposed) return;
    noteMutation();
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
      queued = { ...queued, workspaceBinding: capturedBinding };
    }
    if (queued) {
      pending.set(key, queued);
    }
    // A pending timer already represents the next wakeup.  When no timer is
    // present, the current cycle is in flight and its finally block will
    // schedule the coalesced queue.
    if (
      started &&
      !inFlight &&
      activeAttemptId === null &&
      pendingAttemptBegins.size === 0 &&
      timer === null
    ) {
      schedule(NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS);
    }
  };

  return {
    start(): void {
      if (started || disposed) return;
      started = true;
      noteMutation();
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

    getQuiescenceState() {
      let workspaceBinding: NarrativeMaintenanceWorkspaceBinding | null = null;
      try {
        const candidate = captureWorkspaceBinding();
        workspaceBinding = candidate ?? null;
      } catch {
        workspaceBinding = null;
      }
      const schedulerBusy =
        inFlight ||
        activeAttemptId !== null ||
        pendingAttemptBegins.size > 0;
      return {
        mutationRevision,
        workspaceBinding,
        queueIdle:
          !disposed &&
          !schedulerBusy &&
          timer === null &&
          pending.size === 0 &&
          durableWakeProjects.size === 0 &&
          deferredWorkKeys.size === 0 &&
          deferredWakeProjects.size === 0,
        inFlight: schedulerBusy,
        hasMore: lastHasMore,
        timerScheduled: timer !== null,
      };
    },

    async beginNarrativeMaintenanceAttempt(attemptId, binding) {
      const normalizedBinding = normalizeWorkspaceBinding(binding);
      if (!normalizedBinding) {
        throw new Error("native maintenance attempt binding is unavailable");
      }
      if (disposed || quiescing) {
        throw new Error(
          "NEX_MAINTENANCE_ATTEMPT_ADMISSION_CLOSED: scheduler is quiescing or disposed",
        );
      }
      if (
        inFlight ||
        activeAttemptId !== null ||
        pendingAttemptBegins.size > 0
      ) {
        throw new Error(
          "NEX_MAINTENANCE_ATTEMPT_ACTIVE: another maintenance cycle owns scheduler admission",
        );
      }
      activeAttemptController.begin(attemptId, normalizedBinding);
      retainAttemptOwner(attemptId);
      try {
        await registerAttempt(attemptId, normalizedBinding);
      } catch (error) {
        cleanupUnregisteredAttempt(attemptId);
        throw error;
      }
      return undefined;
    },

    async cancelNarrativeMaintenanceAttempt(attemptId, reason) {
      const receipt = await cancelAttemptById(attemptId, reason);
      if (
        !disposed &&
        !quiescing &&
        !inFlight &&
        activeAttemptId === null &&
        pendingAttemptBegins.size === 0 &&
        terminalReceiptFailure === null &&
        started &&
        timer === null &&
        (hasRunnablePendingWork() || hasRunnableWake())
      ) {
        schedule(NARRATIVE_MAINTENANCE_BACKLOG_DELAY_MS);
      }
      return receipt;
    },

    async quiesceForWorkspaceSwitch(): Promise<
      NarrativeMaintenanceQuiesceLease | undefined
    > {
      return quiesceForWorkspaceSwitch();
    },

    async dispose(): Promise<void> {
      if (disposed) return;
      await quiesceForWorkspaceSwitch();
      // Shutdown has no replacement workspace that can discard a failed
      // Native connection. Keep the process fail-closed and surface the
      // unusable terminal receipt to the quit finalizer.
      if (terminalReceiptFailure !== null) {
        throw terminalReceiptFailure;
      }
      disposed = true;
      noteMutation();
      clearTimer();
      clearCoordinatorWait();
      pending.clear();
      durableWakeProjects.clear();
      durableWakeRetryCounts.clear();
      // The active attempt has returned a terminal Native receipt before the
      // scheduler is disposed.  No old workspace work is allowed to be
      // mistaken for the replacement workspace's acknowledgement.
    },
  };
}
