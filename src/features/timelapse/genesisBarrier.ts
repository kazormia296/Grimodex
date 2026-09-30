import {
  getCurrentProjectId,
  getLoadedProjectId,
} from "@/application/project/currentProjectAuthority";
import {
  captureMutationAuthority,
  isCurrentMutationAuthority,
  runAuthoritativeMutation,
} from "@/features/concurrency/mutationAuthority";

/**
 * Project-scoped activation barrier for the default-ON timelapse genesis pass.
 *
 * The UI may become interactive while genesis work continues in the background,
 * so body steps are still captured immediately. Their durable append and every
 * canonical body mutation wait here until Native has committed the matching
 * anchor=0 baselines. A failed or superseded activation stays closed: callers
 * must retry the Project activation instead of writing an unrecorded body.
 */

export class TimelapseGenesisBarrierError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TimelapseGenesisBarrierError";
  }
}

type BarrierStatus = "pending" | "failed";

interface BarrierState {
  projectId: string;
  token: symbol;
  status: BarrierStatus;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: TimelapseGenesisBarrierError) => void;
  error: TimelapseGenesisBarrierError | null;
}

export interface TimelapseGenesisBarrierLease {
  readonly projectId: string;
  readonly token: symbol;
  /** A failed activation is retried without flushing its captured step queue. */
  readonly preservesCapturedEvents: boolean;
  complete(): void;
  fail(error: unknown): void;
  abort(reason: string): void;
}

const barriers = new Map<string, BarrierState>();
let captureTargetProjectId: string | null = null;
let retryFailedGenesis: ((projectId: string) => Promise<void>) | null = null;

function barrierError(
  projectId: string,
  message: string,
  cause?: unknown,
): TimelapseGenesisBarrierError {
  return new TimelapseGenesisBarrierError(
    `Timelapse genesis barrier for Project ${projectId}: ${message}`,
    cause === undefined ? undefined : { cause },
  );
}

function failState(
  state: BarrierState,
  message: string,
  cause?: unknown,
): void {
  if (state.status !== "pending") return;
  const error = barrierError(state.projectId, message, cause);
  state.status = "failed";
  state.error = error;
  state.reject(error);
}

export function beginTimelapseGenesisBarrier(
  projectId: string,
): TimelapseGenesisBarrierLease {
  for (const [otherProjectId, state] of barriers) {
    if (otherProjectId !== projectId && state.status === "pending") {
      failState(state, "superseded by another Project activation");
    }
  }
  const previous = barriers.get(projectId);
  const preservesCapturedEvents = previous?.status === "failed";
  if (previous?.status === "pending") {
    failState(previous, "superseded by a newer activation");
  }

  let resolve!: () => void;
  let reject!: (error: TimelapseGenesisBarrierError) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  // The barrier is commonly observed only by future writers. Terminate the
  // rejection here as well so an activation failure without a waiter cannot
  // become a global unhandled rejection.
  void promise.catch(() => {});

  const state: BarrierState = {
    projectId,
    token: Symbol(`timelapse-genesis:${projectId}`),
    status: "pending",
    promise,
    resolve,
    reject,
    error: null,
  };
  barriers.set(projectId, state);
  captureTargetProjectId = projectId;

  const isOwner = (): boolean => barriers.get(projectId)?.token === state.token;
  return {
    projectId,
    token: state.token,
    preservesCapturedEvents,
    complete() {
      if (!isOwner() || state.status !== "pending") return;
      barriers.delete(projectId);
      if (captureTargetProjectId === projectId) {
        captureTargetProjectId = null;
      }
      state.resolve();
    },
    fail(error) {
      if (!isOwner()) return;
      failState(state, "initialization failed", error);
    },
    abort(reason) {
      if (!isOwner()) return;
      failState(state, reason);
      if (captureTargetProjectId === projectId) {
        captureTargetProjectId = null;
      }
    },
  };
}

/**
 * Synchronous capture authority published at activation start. A failed
 * initialization deliberately retains it so the same Project can retry
 * without losing edits already represented by queued steps.
 */
export function getTimelapseGenesisCaptureTargetProjectId(): string | null {
  return captureTargetProjectId;
}

export function hasFailedTimelapseGenesisBarrier(projectId: string): boolean {
  return (
    captureTargetProjectId === projectId &&
    barriers.get(projectId)?.status === "failed"
  );
}

export type TimelapseGenesisBarrierAuthority = "mutation" | "capture";

/**
 * Project activation owns the retry implementation, while lifecycle callers
 * need a dependency-light way to settle it before closing Native read
 * admission. Registering the callback here avoids making the lifecycle layer
 * import the concrete Zustand Project store.
 */
export function registerTimelapseGenesisRetry(
  retry: (projectId: string) => Promise<void>,
): () => void {
  const previous = retryFailedGenesis;
  retryFailedGenesis = retry;
  return () => {
    if (retryFailedGenesis === retry) retryFailedGenesis = previous;
  };
}

/**
 * Settle the current Project's genesis read before a quiescence lease closes
 * the global read lane. A failed pass is retried first; a pending pass is
 * simply awaited. Bootstrap has no loaded Project and therefore no barrier to
 * settle.
 */
export async function settleCurrentTimelapseGenesisBeforeQuiescence(): Promise<void> {
  const projectId = getLoadedProjectId();
  if (!projectId) return;
  if (hasFailedTimelapseGenesisBarrier(projectId) && retryFailedGenesis) {
    await retryFailedGenesis(projectId);
  }
  await awaitTimelapseGenesisBarrier(projectId);
}

export async function awaitTimelapseGenesisBarrier(
  projectId: string,
  options: {
    /**
     * `mutation` (the default) requires the current UI workspace authority.
     * `capture` is reserved for the recorder's already-bound target queue:
     * activation can intentionally be ahead of the old UI projection.
     */
    authority?: TimelapseGenesisBarrierAuthority;
  } = {},
): Promise<void> {
  const authority =
    options.authority === "capture"
      ? null
      : captureMutationAuthority(projectId, getCurrentProjectId);
  if (authority && !isCurrentMutationAuthority(authority)) {
    throw barrierError(projectId, "mutation authority is not current");
  }
  if (
    options.authority === "capture" &&
    captureTargetProjectId !== null &&
    captureTargetProjectId !== projectId
  ) {
    throw barrierError(projectId, "capture authority is not current");
  }
  const state = barriers.get(projectId);
  if (!state) return;
  if (state.status === "failed") {
    throw state.error ?? barrierError(projectId, "initialization failed");
  }
  if (options.authority === "capture") {
    // The queue target is published synchronously by begin*. It is the
    // recorder's authority, not the UI's current Project/workspace snapshot.
    // Keep the target check strict so a queue for a superseded Project cannot
    // wait on an unrelated activation.
    await state.promise;
    return;
  }
  await state.promise;
  if (authority && !isCurrentMutationAuthority(authority)) {
    throw barrierError(projectId, "mutation authority changed while waiting");
  }
}

/**
 * Await activation for the recorder's target queue. This deliberately does
 * not grant mutation authority to a renderer writer; `runAfterTimelapseGenesis`
 * continues to use the strict mutation mode above.
 */
export async function awaitTimelapseGenesisCaptureBarrier(
  projectId: string,
): Promise<void> {
  await awaitTimelapseGenesisBarrier(projectId, { authority: "capture" });
}

/**
 * Own one complete writer interval from synchronous admission through genesis
 * settlement and the Native commit. This closes the resolved-Promise gap where
 * a same-id Workspace replacement could otherwise occur between `await` and
 * the caller's IPC creation.
 */
export async function runAfterTimelapseGenesis<T>(
  projectId: string,
  operation: () => Promise<T>,
  options?: { preexistingDraft?: boolean },
): Promise<T> {
  const authority = captureMutationAuthority(projectId, getCurrentProjectId);
  const outcome = await runAuthoritativeMutation(
    authority,
    async () => {
      await awaitTimelapseGenesisBarrier(projectId);
      if (!isCurrentMutationAuthority(authority)) {
        throw barrierError(
          projectId,
          "mutation authority changed before write",
        );
      }
      return operation();
    },
    options,
  );
  if (outcome.status === "stale") {
    throw barrierError(projectId, "mutation authority is not current");
  }
  return outcome.value;
}

export function abortTimelapseGenesisBarriers(reason: string): void {
  for (const state of barriers.values()) {
    failState(state, reason);
  }
  captureTargetProjectId = null;
}

/** @internal */
export function _resetTimelapseGenesisBarriersForTests(): void {
  abortTimelapseGenesisBarriers("test reset");
  barriers.clear();
  captureTargetProjectId = null;
}
