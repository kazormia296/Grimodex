/**
 * Process-local linearization for one main-owned maintenance attempt.
 *
 * Native remains the owner of durable Run/Task/Attempt state.  This module
 * only owns the short-lived boundary between the scheduler, cancellation,
 * and the final native receipt.  In particular, a delivery/run creation
 * acknowledgement does not close the cancellation window; only the explicit
 * finalization transition does.
 */

export type NarrativeMaintenanceAttemptState =
  | "open"
  | "stop-requested"
  | "finalize-granted"
  | "interrupted"
  | "succeeded";

export type NarrativeMaintenanceStopReason =
  | "cancelled"
  | "timeout"
  | "closed"
  | "workspace-generation-changed"
  | "foreground-preempted";

export type NarrativeMaintenanceWorkTerminalStatus =
  | "succeeded"
  | "interrupted"
  | "not-started"
  | "failed";

export interface NarrativeMaintenanceWorkTerminal {
  readonly workKey: string;
  readonly status: NarrativeMaintenanceWorkTerminalStatus;
  readonly error?: string;
}

export interface NarrativeMaintenanceCleanupOutcome {
  readonly status: "clean" | "failed";
  readonly error?: string;
}

export interface NarrativeMaintenanceTerminalReceipt {
  readonly schemaVersion: 1;
  readonly attemptId: string;
  readonly state: "interrupted" | "succeeded";
  readonly stopReason: NarrativeMaintenanceStopReason | null;
  readonly generation: number;
  readonly workspaceBinding: NarrativeMaintenanceAttemptBinding;
  readonly publishedGeneration: number | null;
  readonly works: readonly NarrativeMaintenanceWorkTerminal[];
  readonly cleanup: NarrativeMaintenanceCleanupOutcome;
  readonly connectionReusable: boolean;
}

export interface NarrativeMaintenanceAttemptSnapshot {
  readonly attemptId: string;
  readonly state: NarrativeMaintenanceAttemptState;
  readonly authorityId: string;
  readonly generation: number;
  readonly stopReason: NarrativeMaintenanceStopReason | null;
  readonly works: readonly NarrativeMaintenanceWorkTerminal[];
}

export interface NarrativeMaintenanceAttemptBinding {
  readonly authorityId: string;
  readonly generation: number;
}

export interface NarrativeMaintenanceBeginReceipt {
  readonly status: "open";
  readonly attemptId: string;
  readonly authorityId: string;
  readonly generation: number;
}

export interface NarrativeMaintenanceAttemptController {
  begin(
    attemptId: string,
    binding: NarrativeMaintenanceAttemptBinding,
  ): NarrativeMaintenanceAttemptSnapshot;
  addWork(attemptId: string, workKey: string): void;
  markWorkStarted(attemptId: string, workKey: string): void;
  requestStop(
    attemptId: string,
    reason: NarrativeMaintenanceStopReason,
  ): Promise<NarrativeMaintenanceTerminalReceipt>;
  grantFinalize(attemptId: string): boolean;
  settle(
    attemptId: string,
    outcome: {
      readonly state: "interrupted" | "succeeded";
      readonly publishedGeneration?: number | null;
      readonly cleanup?: NarrativeMaintenanceCleanupOutcome;
      readonly connectionReusable?: boolean;
      readonly errorByWorkKey?: ReadonlyMap<string, string>;
    },
  ): NarrativeMaintenanceTerminalReceipt;
  /**
   * Bind the Native terminal receipt to this main-side attempt.  Native owns
   * cleanup/reusability facts; main must not replace them with a local
   * cancellation placeholder.
   */
  adoptTerminalReceipt(
    attemptId: string,
    receipt: NarrativeMaintenanceTerminalReceipt,
  ): NarrativeMaintenanceTerminalReceipt;
  snapshot(attemptId: string): NarrativeMaintenanceAttemptSnapshot | null;
  waitForTerminal(
    attemptId: string,
  ): Promise<NarrativeMaintenanceTerminalReceipt>;
  activeAttemptIds(): readonly string[];
}

const stopReasons = new Set<NarrativeMaintenanceStopReason>([
  "cancelled",
  "timeout",
  "closed",
  "workspace-generation-changed",
  "foreground-preempted",
]);

/** Parse the Native JSON receipt before it can affect main-side state. */
export function parseNarrativeMaintenanceTerminalReceipt(
  raw: unknown,
): NarrativeMaintenanceTerminalReceipt {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new Error("native maintenance terminal receipt is not JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native maintenance terminal receipt is invalid");
  }
  const record = value as Record<string, unknown>;
  const state = record.state;
  const stopReason = record.stopReason;
  const generation = record.generation;
  const works = record.works;
  const cleanup = record.cleanup;
  if (
    record.schemaVersion !== 1 ||
    typeof record.attemptId !== "string" ||
    (state !== "interrupted" && state !== "succeeded") ||
    (stopReason !== null &&
      (typeof stopReason !== "string" || !stopReasons.has(stopReason as NarrativeMaintenanceStopReason))) ||
    !Number.isSafeInteger(generation) ||
    (generation as number) <= 0 ||
    !record.workspaceBinding ||
    typeof record.workspaceBinding !== "object" ||
    typeof (record.workspaceBinding as Record<string, unknown>).authorityId !== "string" ||
    !Number.isSafeInteger(
      (record.workspaceBinding as Record<string, unknown>).generation,
    ) ||
    ((record.workspaceBinding as Record<string, unknown>).generation as number) <= 0 ||
    (record.publishedGeneration !== null &&
      (!Number.isSafeInteger(record.publishedGeneration) ||
        (record.publishedGeneration as number) <= 0)) ||
    !Array.isArray(works) ||
    !cleanup ||
    typeof cleanup !== "object" ||
    ((cleanup as Record<string, unknown>).status !== "clean" &&
      (cleanup as Record<string, unknown>).status !== "failed") ||
    typeof record.connectionReusable !== "boolean"
  ) {
    throw new Error("native maintenance terminal receipt is invalid");
  }
  const parsedWorks = works.map((rawWork) => {
    if (!rawWork || typeof rawWork !== "object" || Array.isArray(rawWork)) {
      throw new Error("native maintenance terminal work is invalid");
    }
    const work = rawWork as Record<string, unknown>;
    if (
      typeof work.workKey !== "string" ||
      (work.status !== "succeeded" &&
        work.status !== "interrupted" &&
        work.status !== "not-started" &&
        work.status !== "failed") ||
      (work.error !== undefined && typeof work.error !== "string")
    ) {
      throw new Error("native maintenance terminal work is invalid");
    }
    return {
      workKey: work.workKey,
      status: work.status,
      ...(work.error !== undefined ? { error: work.error } : {}),
    } as NarrativeMaintenanceWorkTerminal;
  });
  const cleanupRecord = cleanup as Record<string, unknown>;
  return {
    schemaVersion: 1,
    attemptId: record.attemptId as string,
    state,
    stopReason: (stopReason ?? null) as NarrativeMaintenanceStopReason | null,
    generation: generation as number,
    workspaceBinding: {
      authorityId: (record.workspaceBinding as Record<string, unknown>)
        .authorityId as string,
      generation: (record.workspaceBinding as Record<string, unknown>)
        .generation as number,
    },
    publishedGeneration: (record.publishedGeneration ?? null) as number | null,
    works: parsedWorks,
    cleanup: {
      status: cleanupRecord.status as "clean" | "failed",
      ...(typeof cleanupRecord.error === "string"
        ? { error: cleanupRecord.error }
        : {}),
    },
    connectionReusable: record.connectionReusable as boolean,
  };
}

/**
 * Parse the Native begin acknowledgement.  A function existing on a test
 * double or legacy backend is not proof that Native owns the attempt; only
 * this exact binding acknowledgement establishes that ownership.
 */
export function parseNarrativeMaintenanceBeginReceipt(
  raw: unknown,
): NarrativeMaintenanceBeginReceipt {
  let value: unknown = raw;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value) as unknown;
    } catch {
      throw new Error("native maintenance begin receipt is not JSON");
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("native maintenance begin receipt is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.status !== "open" ||
    typeof record.attemptId !== "string" ||
    record.attemptId.trim().length === 0 ||
    typeof record.authorityId !== "string" ||
    record.authorityId.trim().length === 0 ||
    !Number.isSafeInteger(record.generation) ||
    (record.generation as number) <= 0
  ) {
    throw new Error("native maintenance begin receipt is invalid");
  }
  return {
    status: "open",
    attemptId: record.attemptId,
    authorityId: record.authorityId,
    generation: record.generation as number,
  };
}

interface MutableWorkTerminal {
  workKey: string;
  status: NarrativeMaintenanceWorkTerminalStatus;
  started: boolean;
  error?: string;
}

interface MutableAttempt {
  attemptId: string;
  authorityId: string;
  generation: number;
  state: NarrativeMaintenanceAttemptState;
  stopReason: NarrativeMaintenanceStopReason | null;
  works: Map<string, MutableWorkTerminal>;
  terminal: NarrativeMaintenanceTerminalReceipt | null;
  waiters: Array<(
    receipt: NarrativeMaintenanceTerminalReceipt,
  ) => void>;
}

function assertAttemptId(value: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error("maintenance attemptId is required");
  }
}

function assertBinding(binding: NarrativeMaintenanceAttemptBinding): void {
  if (
    !binding ||
    typeof binding.authorityId !== "string" ||
    binding.authorityId.trim().length === 0 ||
    !Number.isSafeInteger(binding.generation) ||
    binding.generation <= 0
  ) {
    throw new Error("maintenance workspace binding is invalid");
  }
}

function cloneWorks(
  works: Map<string, MutableWorkTerminal>,
): readonly NarrativeMaintenanceWorkTerminal[] {
  return [...works.values()].map((work) =>
    work.error === undefined
      ? { workKey: work.workKey, status: work.status }
      : { workKey: work.workKey, status: work.status, error: work.error },
  );
}

function cloneSnapshot(
  attempt: MutableAttempt,
): NarrativeMaintenanceAttemptSnapshot {
  return {
    attemptId: attempt.attemptId,
    state: attempt.state,
    authorityId: attempt.authorityId,
    generation: attempt.generation,
    stopReason: attempt.stopReason,
    works: cloneWorks(attempt.works),
  };
}

function makeTerminalReceipt(
  attempt: MutableAttempt,
  state: "interrupted" | "succeeded",
  publishedGeneration: number | null,
  cleanup: NarrativeMaintenanceCleanupOutcome,
  connectionReusable: boolean,
  errorByWorkKey?: ReadonlyMap<string, string>,
): NarrativeMaintenanceTerminalReceipt {
  const works = [...attempt.works.values()].map((work) => {
    const error = errorByWorkKey?.get(work.workKey) ?? work.error;
    return error === undefined
      ? { workKey: work.workKey, status: work.status }
      : { workKey: work.workKey, status: work.status, error };
  });
  return {
    schemaVersion: 1,
    attemptId: attempt.attemptId,
    state,
    stopReason: attempt.stopReason,
    generation: attempt.generation,
    workspaceBinding: {
      authorityId: attempt.authorityId,
      generation: attempt.generation,
    },
    publishedGeneration,
    works,
    cleanup,
    connectionReusable,
  };
}

/**
 * Create a synchronous state owner.  Waiting is promise-based, but all state
 * transitions themselves are synchronous, which makes cancel/finalize order
 * deterministic even when callers are on different async turns.
 */
export function createNarrativeMaintenanceAttemptController(): NarrativeMaintenanceAttemptController {
  const attempts = new Map<string, MutableAttempt>();

  const requireAttempt = (attemptId: string): MutableAttempt => {
    assertAttemptId(attemptId);
    const attempt = attempts.get(attemptId);
    if (!attempt) {
      throw new Error(`unknown maintenance attempt: ${attemptId}`);
    }
    return attempt;
  };

  const settle = (
    attempt: MutableAttempt,
    outcome: {
      readonly state: "interrupted" | "succeeded";
      readonly publishedGeneration?: number | null;
      readonly cleanup?: NarrativeMaintenanceCleanupOutcome;
      readonly connectionReusable?: boolean;
      readonly errorByWorkKey?: ReadonlyMap<string, string>;
    },
  ): NarrativeMaintenanceTerminalReceipt => {
    if (attempt.terminal) return attempt.terminal;
    if (outcome.state === "succeeded" && attempt.state === "stop-requested") {
      // A stop request linearized before finalization wins.  The caller must
      // rollback/clean up and report interruption instead of publishing.
      outcome = { ...outcome, state: "interrupted" };
    }
    attempt.state = outcome.state;
    if (outcome.state === "interrupted") {
      for (const work of attempt.works.values()) {
        if (work.status === "succeeded" || work.status === "failed") continue;
        work.status = work.started ? "interrupted" : "not-started";
      }
    } else {
      for (const work of attempt.works.values()) {
        if (work.status === "not-started") work.status = "succeeded";
      }
    }
    const receipt = makeTerminalReceipt(
      attempt,
      outcome.state,
      outcome.publishedGeneration ?? null,
      outcome.cleanup ?? { status: "clean" },
      outcome.connectionReusable ?? true,
      outcome.errorByWorkKey,
    );
    attempt.terminal = receipt;
    for (const waiter of attempt.waiters.splice(0)) waiter(receipt);
    return receipt;
  };

  return {
    begin(attemptId, binding) {
      assertAttemptId(attemptId);
      assertBinding(binding);
      const existing = attempts.get(attemptId);
      if (existing) {
        if (
          existing.authorityId !== binding.authorityId ||
          existing.generation !== binding.generation
        ) {
          throw new Error("maintenance attempt binding conflict");
        }
        return cloneSnapshot(existing);
      }
      const attempt: MutableAttempt = {
        attemptId,
        authorityId: binding.authorityId,
        generation: binding.generation,
        state: "open",
        stopReason: null,
        works: new Map(),
        terminal: null,
        waiters: [],
      };
      attempts.set(attemptId, attempt);
      return cloneSnapshot(attempt);
    },

    addWork(attemptId, workKey) {
      if (typeof workKey !== "string" || workKey.trim().length === 0) {
        throw new Error("maintenance workKey is required");
      }
      const attempt = requireAttempt(attemptId);
      if (attempt.terminal) return;
      if (!attempt.works.has(workKey)) {
        attempt.works.set(workKey, {
          workKey,
          status: "not-started",
          started: false,
        });
      }
    },

    markWorkStarted(attemptId, workKey) {
      const attempt = requireAttempt(attemptId);
      if (attempt.terminal || attempt.state === "stop-requested") return;
      const work = attempt.works.get(workKey);
      if (!work) throw new Error(`unknown maintenance work: ${workKey}`);
      work.started = true;
    },

    async requestStop(attemptId, reason) {
      const attempt = requireAttempt(attemptId);
      if (attempt.terminal) return attempt.terminal;
      if (attempt.state === "finalize-granted") {
        return new Promise((resolve) => attempt.waiters.push(resolve));
      }
      if (attempt.state === "open") {
        attempt.state = "stop-requested";
        attempt.stopReason = reason;
        // A begin/cancel race with no work has no native operation to wait on.
        if (attempt.works.size === 0) {
          return settle(attempt, { state: "interrupted" });
        }
      }
      return this.waitForTerminal(attemptId);
    },

    grantFinalize(attemptId) {
      const attempt = requireAttempt(attemptId);
      if (attempt.terminal) return false;
      if (attempt.state === "stop-requested") return false;
      if (attempt.state !== "open") return attempt.state === "finalize-granted";
      attempt.state = "finalize-granted";
      return true;
    },

    settle(attemptId, outcome) {
      return settle(requireAttempt(attemptId), outcome);
    },

    adoptTerminalReceipt(attemptId, receipt) {
      const attempt = requireAttempt(attemptId);
      if (receipt.attemptId !== attemptId) {
        throw new Error("maintenance terminal receipt attemptId mismatch");
      }
      if (receipt.generation !== attempt.generation) {
        throw new Error("maintenance terminal receipt generation mismatch");
      }
      if (
        receipt.workspaceBinding.authorityId !== attempt.authorityId ||
        receipt.workspaceBinding.generation !== attempt.generation
      ) {
        throw new Error("maintenance terminal receipt binding mismatch");
      }
      if (attempt.terminal) return attempt.terminal;
      attempt.state = receipt.state;
      attempt.stopReason = receipt.stopReason;
      for (const terminalWork of receipt.works) {
        const work = attempt.works.get(terminalWork.workKey);
        if (work) {
          work.status = terminalWork.status;
          if (terminalWork.error !== undefined) work.error = terminalWork.error;
          continue;
        }
        attempt.works.set(terminalWork.workKey, {
          workKey: terminalWork.workKey,
          status: terminalWork.status,
          started: terminalWork.status !== "not-started",
          ...(terminalWork.error !== undefined
            ? { error: terminalWork.error }
            : {}),
        });
      }
      attempt.terminal = receipt;
      for (const waiter of attempt.waiters.splice(0)) waiter(receipt);
      return receipt;
    },

    snapshot(attemptId) {
      const attempt = attempts.get(attemptId);
      return attempt ? cloneSnapshot(attempt) : null;
    },

    waitForTerminal(attemptId) {
      const attempt = requireAttempt(attemptId);
      if (attempt.terminal) return Promise.resolve(attempt.terminal);
      return new Promise((resolve) => attempt.waiters.push(resolve));
    },

    activeAttemptIds() {
      return [...attempts.values()]
        .filter((attempt) => attempt.terminal === null)
        .map((attempt) => attempt.attemptId);
    },
  };
}
