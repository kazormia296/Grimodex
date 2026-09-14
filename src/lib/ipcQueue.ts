import {
  createQuiescenceProviderId,
  registerQuiescenceProvider,
} from "./quiescenceProviders";

type QueueItem<T> = {
  cmd: string;
  run: () => Promise<T>;
  timeoutMs: number | null;
  category: IpcQueueCategory;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  cancelCaller: ((error: Error) => void) | null;
};

export type IpcQueueCategory = "mutation" | "read" | "derived";

const MAX_CONCURRENT = 4;
// Reads and rebuildable derived-index work may keep running when the native
// transport cannot cancel them. Together they may consume at most three slots,
// leaving one global slot for manuscript mutations/lifecycle commands.
const MAX_CONCURRENT_BACKGROUND = MAX_CONCURRENT - 1;
const MAX_CONCURRENT_DERIVED = 1;

let queue: QueueItem<unknown>[] = [];
let activeCount = 0;
let activeReadCount = 0;
let activeDerivedCount = 0;
let activeMutationCount = 0;
let readAdmissionBarrierCount = 0;
let derivedAdmissionBarrierCount = 0;
let mutationAdmissionBarrierCount = 0;
let auditExportSafeReadAllowanceCount = 0;
let auditExportActualTaskTrackingCount = 0;
const auditExportActualTaskFailures = new Set<unknown>();
const mutationActualTasks = new Map<Promise<unknown>, string>();
const allActualTasks = new Map<
  Promise<unknown>,
  { readonly cmd: string; readonly category: IpcQueueCategory }
>();
const activeReadItems = new Set<QueueItem<unknown>>();
const activeDerivedItems = new Set<QueueItem<unknown>>();

function readCancellationError(cmd: string): Error {
  return new Error(
    `IPC_READ_CANCELLED: read cancelled before lifecycle transition completed: ${cmd}`,
  );
}

function derivedCancellationError(cmd: string): Error {
  return new Error(
    `IPC_DERIVED_CANCELLED: rebuildable background work cancelled for lifecycle transition: ${cmd}`,
  );
}

function mutationCancellationError(cmd: string): Error {
  return new Error(
    `IPC_MUTATION_CANCELLED: mutation blocked during frozen AI audit export: ${cmd}`,
  );
}

const D2A_EGRESS_DENIED_MARKER = "D2A_EGRESS_DENIED:";

/**
 * Restricted-profile denials are expected only while strict quiescence is
 * draining optional projection work. Keep this local to the pending-task
 * classifier so required mutation callers still observe the rejection.
 */
function isExpectedD2aEgressDenial(error: unknown): boolean {
  const seen = new Set<object>();
  let current: unknown = error;
  while (current !== null && current !== undefined) {
    if (typeof current === "string") {
      return current.includes(D2A_EGRESS_DENIED_MARKER);
    }
    if (typeof current !== "object") return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if (
      "message" in current &&
      String(
        (current as { readonly message?: unknown }).message ?? "",
      ).includes(D2A_EGRESS_DENIED_MARKER)
    ) {
      return true;
    }
    current =
      "cause" in current
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return false;
}

const AUDIT_EXPORT_SAFE_READ_COMMANDS = new Set([
  "db_execute",
  "ai_audit_read_snapshot",
  "ai_audit_verify",
]);

function runQueuedItem<T>(item: QueueItem<T>): Promise<void> {
  return new Promise<void>((done) => {
    let callerSettled = false;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    const rejectCaller = (error: Error) => {
      if (callerSettled) return;
      callerSettled = true;
      if (timerId !== null) clearTimeout(timerId);
      item.reject(error);
    };
    if (item.timeoutMs !== null) {
      timerId = setTimeout(() => {
        rejectCaller(
          new Error(`IPC timeout after ${item.timeoutMs}ms: ${item.cmd}`),
        );
      }, item.timeoutMs);
    }
    item.cancelCaller = rejectCaller;

    // A timeout settles only the renderer-facing promise. The native task
    // cannot be cancelled generically and therefore retains its concurrency
    // lease until it actually settles. Releasing the slot at timeout would
    // allow an unbounded number of still-running native operations to sit
    // behind the advertised MAX_CONCURRENT limit.
    const actualTask = Promise.resolve().then(item.run);
    allActualTasks.set(actualTask, { cmd: item.cmd, category: item.category });
    void actualTask.then(
      () => allActualTasks.delete(actualTask),
      (error) => {
        allActualTasks.delete(actualTask);
        if (auditExportActualTaskTrackingCount > 0) {
          auditExportActualTaskFailures.add(error);
        }
      },
    );
    if (item.category === "mutation") {
      mutationActualTasks.set(actualTask, item.cmd);
      void actualTask.then(
        () => mutationActualTasks.delete(actualTask),
        () => mutationActualTasks.delete(actualTask),
      );
    }
    void actualTask.then(
      (value) => {
        if (timerId !== null) clearTimeout(timerId);
        item.cancelCaller = null;
        if (!callerSettled) {
          callerSettled = true;
          item.resolve(value);
        }
        done();
      },
      (error) => {
        if (timerId !== null) clearTimeout(timerId);
        item.cancelCaller = null;
        if (!callerSettled) {
          callerSettled = true;
          item.reject(error);
        }
        done();
      },
    );
  });
}

function pumpQueue(): void {
  while (activeCount < MAX_CONCURRENT && queue.length > 0) {
    const activeBackgroundCount = activeReadCount + activeDerivedCount;
    const nextIndex = queue.findIndex((item) => {
      if (item.category === "mutation") return true;
      if (activeBackgroundCount >= MAX_CONCURRENT_BACKGROUND) return false;
      return (
        item.category === "read" || activeDerivedCount < MAX_CONCURRENT_DERIVED
      );
    });
    if (nextIndex < 0) break;
    const [item] = queue.splice(nextIndex, 1);
    if (!item) break;
    activeCount++;
    if (item.category === "read") {
      activeReadCount++;
      activeReadItems.add(item);
    } else if (item.category === "derived") {
      activeDerivedCount++;
      activeDerivedItems.add(item);
    } else {
      activeMutationCount++;
    }
    void runQueuedItem(item).finally(() => {
      activeCount--;
      if (item.category === "read") {
        activeReadCount--;
        activeReadItems.delete(item);
      } else if (item.category === "derived") {
        activeDerivedCount--;
        activeDerivedItems.delete(item);
      } else {
        activeMutationCount--;
      }
      pumpQueue();
    });
  }
}

/** Serialize burst IPC so timeouts measure execution time, not queue wait. */
export function enqueueIpc<T>(
  cmd: string,
  run: () => Promise<T>,
  timeoutMs: number | null,
  category: IpcQueueCategory = "mutation",
): Promise<T> {
  if (category === "mutation" && mutationAdmissionBarrierCount > 0) {
    return Promise.reject(mutationCancellationError(cmd));
  }
  if (
    category === "read" &&
    readAdmissionBarrierCount > 0 &&
    !(
      auditExportSafeReadAllowanceCount > 0 &&
      AUDIT_EXPORT_SAFE_READ_COMMANDS.has(cmd)
    )
  ) {
    return Promise.reject(readCancellationError(cmd));
  }
  if (category === "derived" && derivedAdmissionBarrierCount > 0) {
    return Promise.reject(derivedCancellationError(cmd));
  }
  return new Promise<T>((resolve, reject) => {
    queue.push({
      cmd,
      run,
      timeoutMs,
      category,
      resolve: resolve as (value: unknown) => void,
      reject,
      cancelCaller: null,
    });
    pumpQueue();
  });
}

/**
 * Blocks new read IPC for the lifetime of a destructive lifecycle authority
 * lease. Existing reads are detached by the final IPC quiescence stage; the
 * admission barrier closes the race from that stage through authority
 * publication or rollback.
 */
export function acquireIpcReadAdmissionBarrier(): () => void {
  readAdmissionBarrierCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    readAdmissionBarrierCount = Math.max(0, readAdmissionBarrierCount - 1);
  };
}

/** Prevent new rebuildable background work during a destructive lifecycle. */
export function acquireIpcDerivedAdmissionBarrier(): () => void {
  derivedAdmissionBarrierCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    derivedAdmissionBarrierCount = Math.max(
      0,
      derivedAdmissionBarrierCount - 1,
    );
  };
}

/** Close low-level mutation admission before a frozen audit read phase. */
export function acquireIpcMutationAdmissionBarrier(): () => void {
  mutationAdmissionBarrierCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mutationAdmissionBarrierCount = Math.max(
      0,
      mutationAdmissionBarrierCount - 1,
    );
  };
}

/**
 * Permit only deterministic audit-export database queries while the global
 * read barrier remains closed. Model/semantic reads are deliberately absent.
 */
export function acquireAuditExportSafeReadAllowance(): () => void {
  auditExportSafeReadAllowanceCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    auditExportSafeReadAllowanceCount = Math.max(
      0,
      auditExportSafeReadAllowanceCount - 1,
    );
  };
}

/**
 * Retain failures from tasks that race between audit-export drain stages.
 * Acquisition happens synchronously with the lease, so even a pre-existing
 * task that settles before the first drain remains observable fail-closed.
 */
export function acquireAuditExportActualTaskFailureTracking(): () => void {
  if (auditExportActualTaskTrackingCount === 0) {
    auditExportActualTaskFailures.clear();
  }
  auditExportActualTaskTrackingCount++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    auditExportActualTaskTrackingCount = Math.max(
      0,
      auditExportActualTaskTrackingCount - 1,
    );
    if (auditExportActualTaskTrackingCount === 0) {
      auditExportActualTaskFailures.clear();
    }
  };
}

/** Detach every old-scope read caller and remove reads that have not started. */
export function cancelIpcReadCallersForLifecycle(): void {
  const retainedQueue: QueueItem<unknown>[] = [];
  for (const item of queue) {
    if (item.category === "read") {
      item.reject(readCancellationError(item.cmd));
    } else {
      retainedQueue.push(item);
    }
  }
  queue = retainedQueue;
  for (const item of activeReadItems) {
    item.cancelCaller?.(readCancellationError(item.cmd));
  }
  pumpQueue();
}

/**
 * Reject queued/active callers for rebuildable derived work. Active native
 * tasks retain their real queue slot until the semantic runtime observes its
 * rotated epoch and stops cooperatively.
 */
export function cancelDerivedIpcCallersForLifecycle(): void {
  const retainedQueue: QueueItem<unknown>[] = [];
  for (const item of queue) {
    if (item.category === "derived") {
      item.reject(derivedCancellationError(item.cmd));
    } else {
      retainedQueue.push(item);
    }
  }
  queue = retainedQueue;
  for (const item of activeDerivedItems) {
    item.cancelCaller?.(derivedCancellationError(item.cmd));
  }
  pumpQueue();
}

/**
 * Wait for native mutation work, including work whose renderer-facing promise
 * already timed out. Read-only work is excluded: it cannot affect persistence,
 * may be unabortable at the transport boundary, and has its own three-slot
 * lane so it cannot starve lifecycle mutations.
 */
export async function awaitPendingIpcActualTasks(): Promise<void> {
  const failures: unknown[] = [];
  const markedWaitingCommands = new Set<string>();

  // A read that has not started yet still belongs to the old renderer scope.
  // Letting a lifecycle mutation overtake it and then starting that read
  // against the newly opened Workspace would return cross-scope data. Reject
  // queued reads before they start and detach callers from already-running
  // reads; their actual native work keeps its slot until it settles.
  cancelIpcReadCallersForLifecycle();

  while (
    mutationActualTasks.size > 0 ||
    queue.some((item) => item.category === "mutation") ||
    activeMutationCount > 0
  ) {
    for (const command of mutationActualTasks.values()) {
      if (markedWaitingCommands.has(command)) continue;
      markedWaitingCommands.add(command);
      if (typeof performance !== "undefined") {
        performance.mark(
          `grimodex.quiescence.ipc-actual-tasks.waiting.${encodeURIComponent(command)}`,
        );
      }
    }
    const snapshot = [...mutationActualTasks.keys()];
    if (snapshot.length === 0) {
      await Promise.resolve();
      continue;
    }

    const results = await Promise.allSettled(snapshot);
    for (const result of results) {
      if (
        result.status === "rejected" &&
        !isExpectedD2aEgressDenial(result.reason)
      ) {
        failures.push(result.reason);
      }
    }
  }

  if (failures.length > 0) {
    const message =
      failures.length === 1 && failures[0] instanceof Error
        ? failures[0].message
        : "One or more IPC tasks failed while reaching quiescence";
    throw new AggregateError(failures, message);
  }
}

/**
 * Audit export must retain, rather than detach, pre-existing read/derived
 * callers because native inference can append its audit terminal inside those
 * tasks. The audit-export lease has already closed new background admission;
 * wait every queued/active category to its real transport settlement before
 * opening the frozen report-read phase.
 */
export async function awaitPendingIpcActualTasksForAuditExport(): Promise<void> {
  const failures = new Set<unknown>(auditExportActualTaskFailures);
  const observed = new Set<Promise<unknown>>();

  while (queue.length > 0 || activeCount > 0 || allActualTasks.size > 0) {
    const snapshot = [...allActualTasks.keys()];
    if (snapshot.length === 0) {
      await Promise.resolve();
      continue;
    }
    const results = await Promise.allSettled(snapshot);
    results.forEach((result, index) => {
      const task = snapshot[index];
      if (task && !observed.has(task) && result.status === "rejected") {
        failures.add(result.reason);
      }
      if (task) observed.add(task);
    });
  }

  for (const failure of auditExportActualTaskFailures) failures.add(failure);
  if (failures.size > 0) {
    const failureList = [...failures];
    const message =
      failureList.length === 1 && failureList[0] instanceof Error
        ? failureList[0].message
        : "One or more IPC tasks failed before AI audit export";
    throw new AggregateError(failureList, message);
  }
}

registerQuiescenceProvider({
  id: createQuiescenceProviderId("ipc-actual-tasks"),
  stage: "ipc-actual-tasks",
  flush: awaitPendingIpcActualTasks,
});

/** Test helper */
export function resetIpcQueueForTests(): void {
  queue = [];
  activeCount = 0;
  activeReadCount = 0;
  activeDerivedCount = 0;
  activeMutationCount = 0;
  readAdmissionBarrierCount = 0;
  derivedAdmissionBarrierCount = 0;
  mutationAdmissionBarrierCount = 0;
  auditExportSafeReadAllowanceCount = 0;
  auditExportActualTaskTrackingCount = 0;
  auditExportActualTaskFailures.clear();
  mutationActualTasks.clear();
  allActualTasks.clear();
  activeReadItems.clear();
  activeDerivedItems.clear();
}
