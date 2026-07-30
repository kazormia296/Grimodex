import {
  acquireIpcDerivedAdmissionBarrier,
  acquireIpcReadAdmissionBarrier,
  cancelDerivedIpcCallersForLifecycle,
  cancelIpcReadCallersForLifecycle,
} from "@/lib/ipcQueue";
import {
  activateLifecycleTransition,
  beginLifecycleTransition,
  isLifecycleTraceEnabled,
  type LifecycleTransitionInput,
  type LifecycleTransitionTrace,
} from "./lifecycleTrace";

export type QuiescenceLeaseReason =
  | "project-load"
  | "workspace-open"
  | "window-close";

export type QuiescenceLeaseReleaseDisposition = "resume" | "renderer-teardown";

export interface QuiescenceLeaseStateChange {
  readonly active: boolean;
  readonly reason: QuiescenceLeaseReason;
  readonly releaseDisposition?: QuiescenceLeaseReleaseDisposition;
}

export interface QuiescenceLease {
  readonly reason: QuiescenceLeaseReason;
  /** Present only for an explicitly opted-in Project/Workspace transition. */
  readonly transition: LifecycleTransitionTrace | null;
  /**
   * Opens a controlled target-scope hydration phase after old work drained.
   * The caller must seal again immediately before publishing new authority.
   */
  openTargetReadPhase: () => void;
  /** Blocks new reads and detaches every read started during preparation. */
  sealReadsForAuthorityCommit: () => void;
  /**
   * `renderer-teardown` means native close was accepted and background work
   * must not be restarted in the short interval before the page is destroyed.
   */
  release: (options?: {
    disposition?: QuiescenceLeaseReleaseDisposition;
  }) => void;
}

const activeLeases = new Map<symbol, QuiescenceLeaseReason>();
const ipcReadBarrierReleases = new Map<symbol, () => void>();
const ipcDerivedBarrierReleases = new Map<symbol, () => void>();
const lifecycleTransitionDeactivations = new Map<symbol, () => void>();
const listeners = new Set<(change: QuiescenceLeaseStateChange) => void>();
const topologyListeners = new Set<() => void>();
let currentProjectReadAuthorityToken: symbol | null = null;
let preexistingParticipantInvocationDepth = 0;
// Successful renderer teardown is terminal for this JavaScript realm. A close
// IPC can resolve a few milliseconds before React unmounts; remember that
// terminal state so no effect continuation can restart background work in the
// gap after the final lease release.
let rendererTeardownStarted = false;

function releaseIpcReadBarrier(token: symbol): void {
  ipcReadBarrierReleases.get(token)?.();
  ipcReadBarrierReleases.delete(token);
}

function releaseIpcDerivedBarrier(token: symbol): void {
  ipcDerivedBarrierReleases.get(token)?.();
  ipcDerivedBarrierReleases.delete(token);
}

function ownsReadAuthority(
  token: symbol,
  reason: QuiescenceLeaseReason,
): boolean {
  return (
    reason !== "project-load" || currentProjectReadAuthorityToken === token
  );
}

function notifyLeaseStateChanged(change: QuiescenceLeaseStateChange): void {
  for (const listener of listeners) listener(change);
}

function notifyLeaseTopologyChanged(): void {
  for (const listener of [...topologyListeners]) listener();
}

function hasProjectOrWorkspaceLifecycle(): boolean {
  for (const reason of activeLeases.values()) {
    if (reason === "project-load" || reason === "workspace-open") return true;
  }
  return false;
}

export function isProjectWorkspaceLifecycleIdle(): boolean {
  return !hasProjectOrWorkspaceLifecycle();
}

/**
 * Acquires one holder of the shared destructive-lifecycle barrier.
 *
 * Destructive operations may overlap intentionally (for example a newer
 * Project load superseding an older one, or a same-path Workspace reopen
 * performing a nested Project load). The barrier therefore stays active until
 * every holder releases instead of treating nested acquisition as an error.
 */
export function acquireQuiescenceLease(
  reason: QuiescenceLeaseReason,
  options?: {
    transition?: LifecycleTransitionInput;
  },
): QuiescenceLease {
  const transition =
    options?.transition && isLifecycleTraceEnabled()
      ? beginLifecycleTransition(options.transition)
      : null;
  const token = Symbol(reason);
  const wasActive = activeLeases.size > 0;
  activeLeases.set(token, reason);
  ipcDerivedBarrierReleases.set(token, acquireIpcDerivedAdmissionBarrier());
  cancelDerivedIpcCallersForLifecycle();
  if (reason === "project-load") {
    // Project requests intentionally overlap so the last request wins. Once a
    // newer request exists, an older Project barrier must not keep the newer
    // target-read phase closed, nor may the older lease re-seal that phase.
    // The old lease remains active for mutation scheduling until its own
    // finally block releases it.
    if (currentProjectReadAuthorityToken) {
      releaseIpcReadBarrier(currentProjectReadAuthorityToken);
    }
    currentProjectReadAuthorityToken = token;
  }
  // Window close must first let an already-running Project/Workspace
  // transition and strict persistence finish. It still blocks new mutation
  // scheduling through activeLeases, then its controller explicitly seals
  // reads in the synchronous authority-commit step immediately before close.
  if (reason !== "window-close") {
    ipcReadBarrierReleases.set(token, acquireIpcReadAdmissionBarrier());
  }
  if (transition) {
    // Admission and IPC barriers are closed before the milestone is observable.
    // Bind the trace for the full lease interval so a stream that settles
    // before flushStrictQuiescence still records its real milestones.
    transition.advance("quiescence-started");
    lifecycleTransitionDeactivations.set(
      token,
      activateLifecycleTransition(transition),
    );
  }
  if (!wasActive) {
    notifyLeaseStateChanged({
      active: true,
      reason,
    });
  }
  notifyLeaseTopologyChanged();

  let released = false;
  return {
    reason,
    transition,
    openTargetReadPhase() {
      if (released || !ownsReadAuthority(token, reason)) return;
      releaseIpcReadBarrier(token);
    },
    sealReadsForAuthorityCommit() {
      if (released || !ownsReadAuthority(token, reason)) return;
      if (!ipcReadBarrierReleases.has(token)) {
        ipcReadBarrierReleases.set(token, acquireIpcReadAdmissionBarrier());
      }
      cancelIpcReadCallersForLifecycle();
    },
    release(options) {
      if (released) return;
      released = true;
      if (options?.disposition === "renderer-teardown") {
        rendererTeardownStarted = true;
      }
      const wasLastLease = activeLeases.size === 1;
      activeLeases.delete(token);
      lifecycleTransitionDeactivations.get(token)?.();
      lifecycleTransitionDeactivations.delete(token);
      releaseIpcReadBarrier(token);
      releaseIpcDerivedBarrier(token);
      if (currentProjectReadAuthorityToken === token) {
        currentProjectReadAuthorityToken = null;
      }
      if (wasLastLease) {
        notifyLeaseStateChanged({
          active: false,
          reason,
          releaseDisposition: options?.disposition ?? "resume",
        });
      }
      notifyLeaseTopologyChanged();
    },
  };
}

export function isQuiescenceLeaseActive(): boolean {
  return activeLeases.size > 0;
}

export function isRendererTeardownStarted(): boolean {
  return rendererTeardownStarted;
}

/**
 * Synchronous scheduling gate for user edits and other new mutations.
 * Persistence work that was already pending before lease acquisition remains
 * allowed so strict quiescence can drain it.
 */
export function canScheduleQuiescenceMutation(options?: {
  /** A draft registered before the active lifecycle lease was acquired. */
  preexistingDraft?: boolean;
}): boolean {
  return (
    !rendererTeardownStarted &&
    (!isQuiescenceLeaseActive() ||
      preexistingParticipantInvocationDepth > 0 ||
      options?.preexistingDraft === true)
  );
}

/**
 * Admits only the synchronous scheduling step of a draft that was already
 * registered before strict lifecycle quiescence began.
 *
 * The scope intentionally ends as soon as `schedule` returns, even when it
 * returns a Promise. This lets a participant attach its persistence task to
 * the lifecycle lease without reopening admission to unrelated browser events
 * while that task is in flight.
 */
export function schedulePreexistingParticipantMutation<T>(
  schedule: () => T,
): T {
  preexistingParticipantInvocationDepth += 1;
  try {
    return schedule();
  } finally {
    preexistingParticipantInvocationDepth -= 1;
  }
}

export function subscribeQuiescenceLease(
  listener: (change: QuiescenceLeaseStateChange) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Waits until every Project/Workspace lifecycle that can replace the active
 * database binding has completed.
 *
 * Window-close leases are deliberately ignored. The caller owns one itself,
 * and separate renderer windows may also close concurrently; waiting on those
 * holders would make two close controllers deadlock each other. An AbortSignal
 * lets a cancelled close attempt detach its waiter without releasing or
 * disturbing the lifecycle operation it was waiting for.
 */
export function waitForProjectWorkspaceLifecycleIdle(
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted || isProjectWorkspaceLifecycleIdle()) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      topologyListeners.delete(check);
      signal?.removeEventListener("abort", check);
      resolve();
    };
    const check = (): void => {
      if (signal?.aborted || isProjectWorkspaceLifecycleIdle()) finish();
    };

    topologyListeners.add(check);
    signal?.addEventListener("abort", check, { once: true });
    // Re-check after subscribing so a lifecycle cannot release between the
    // initial fast-path and waiter registration.
    check();
  });
}

export function _resetQuiescenceLeasesForTests(): void {
  const wasActive = activeLeases.size > 0;
  const activeReason: QuiescenceLeaseReason =
    activeLeases.values().next().value ?? "window-close";
  for (const release of ipcReadBarrierReleases.values()) release();
  for (const release of ipcDerivedBarrierReleases.values()) release();
  for (const deactivate of lifecycleTransitionDeactivations.values()) {
    deactivate();
  }
  ipcReadBarrierReleases.clear();
  ipcDerivedBarrierReleases.clear();
  lifecycleTransitionDeactivations.clear();
  activeLeases.clear();
  currentProjectReadAuthorityToken = null;
  preexistingParticipantInvocationDepth = 0;
  rendererTeardownStarted = false;
  if (wasActive) {
    notifyLeaseStateChanged({
      active: false,
      reason: activeReason,
      releaseDisposition: "resume",
    });
  }
  notifyLeaseTopologyChanged();
}
