import { registerQuiescenceProvider } from "./quiescenceProviders";

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
const mutationActualTasks = new Map<Promise<unknown>, string>();
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
  if (category === "read" && readAdmissionBarrierCount > 0) {
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
      if (result.status === "rejected") failures.push(result.reason);
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

registerQuiescenceProvider({
  id: "ipc-actual-tasks",
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
  mutationActualTasks.clear();
  activeReadItems.clear();
  activeDerivedItems.clear();
}
