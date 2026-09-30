import { debugLog } from "@/lib/debugLog";
import {
  listenRelatedScenesInvalidations,
  listenRelatedScenesIndexReady,
  releaseRelatedScenes,
} from "./nir1RelatedScenesApi";

export type Nir1RelatedScenesStopReason =
  | "cancelled"
  | "invalidated"
  | "invalidation-overflow"
  | "listener-unavailable";

export interface Nir1RelatedScenesLease {
  readonly isActive: () => boolean;
  readonly release: () => void;
}

/** One listener/binding/ticket for one fetch, then its displayed IR/navigation. */
export function createNir1RelatedScenesSession(
  projectId: string,
  signal?: AbortSignal,
) {
  let closed = false;
  let connected = false;
  let connection: Promise<boolean> | null = null;
  let stopReason: Nir1RelatedScenesStopReason | null = null;
  const unlisteners = new Set<() => void>();
  let queryBinding: string | null = null;
  let ticket: string | null = null;
  let ownerReleased = false;
  let fetchComplete = false;
  let retained = 0;
  let readinessRevision = 0;
  const pendingInvalidations = new Set<string>();
  const releasedTickets = new Set<string>();
  const observers = new Set<(reason: Nir1RelatedScenesStopReason) => void>();
  const readyObservers = new Set<(revision: number) => void>();

  function releaseTicket(value: string): void {
    if (releasedTickets.has(value)) return;
    releasedTickets.add(value);
    void releaseRelatedScenes(value).catch(() => {
      debugLog.warn("RelatedScenes", "IR ticket release failed");
    });
  }

  function detachAbort(): void {
    signal?.removeEventListener("abort", abort);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    detachAbort();
    for (const unlisten of unlisteners) unlisten();
    unlisteners.clear();
    if (ticket) releaseTicket(ticket);
  }

  function stop(reason: Nir1RelatedScenesStopReason): void {
    if (stopReason || closed) return;
    stopReason = reason;
    close();
    for (const observer of observers) {
      // Observer failures must not retain a revoked operation or prevent the
      // remaining owners from observing canonical invalidation.
      try {
        observer(reason);
      } catch {
        // Notification is advisory; the session has already been closed.
      }
    }
  }

  function abort(): void {
    stop("cancelled");
  }

  function receiveInvalidation(binding: string): void {
    if (closed) return;
    if (queryBinding !== null) {
      if (queryBinding === binding) stop("invalidated");
      return;
    }
    if (pendingInvalidations.has(binding)) return;
    if (pendingInvalidations.size >= 64) {
      stop("invalidation-overflow");
      return;
    }
    pendingInvalidations.add(binding);
  }

  function closeWhenUnused(): void {
    if (ownerReleased && retained === 0) close();
  }

  function receiveIndexReady(readyProjectId: string): void {
    if (closed || readyProjectId !== projectId) return;
    readinessRevision++;
    for (const observer of readyObservers) observer(readinessRevision);
  }

  function registered(unlisten: () => void): void {
    if (closed) unlisten();
    else unlisteners.add(unlisten);
  }

  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();

  return {
    get stopReason() {
      return stopReason;
    },
    get readinessRevision() {
      return readinessRevision;
    },
    isActive(): boolean {
      return connected && !closed;
    },
    connect(): Promise<boolean> {
      if (closed) return Promise.resolve(false);
      connection ??= Promise.all([
        listenRelatedScenesInvalidations(receiveInvalidation).then(registered),
        listenRelatedScenesIndexReady(receiveIndexReady).then(registered),
      ])
        .then(() => {
          if (closed) return false;
          connected = true;
          return true;
        })
        .catch(() => {
          stop("listener-unavailable");
          return false;
        });
      return connection;
    },
    /** Call after begin, even after cancellation, so late tickets are released. */
    bind(binding: string, operationTicket: string | null): boolean {
      if (closed || !connected || queryBinding !== null) {
        if (operationTicket) releaseTicket(operationTicket);
        if (!closed) stop("invalidated");
        return false;
      }
      queryBinding = binding;
      ticket = operationTicket;
      if (pendingInvalidations.has(binding)) stop("invalidated");
      pendingInvalidations.clear();
      return !closed;
    },
    /** After publication, UI cleanup releases its owner; navigation may retain. */
    completeFetch(): void {
      fetchComplete = true;
      detachAbort();
    },
    retain(): Nir1RelatedScenesLease | null {
      if (closed || ownerReleased || !ticket || !fetchComplete) return null;
      retained++;
      let released = false;
      return Object.freeze({
        isActive: () => !released && !closed && ticket !== null,
        release(): void {
          if (released) return;
          released = true;
          retained--;
          closeWhenUnused();
        },
      });
    },
    release(): void {
      if (ownerReleased) return;
      ownerReleased = true;
      closeWhenUnused();
    },
    /** Cancel the operation after Raw fallback; keep the visible readiness watch. */
    releaseOperation(): void {
      if (!ticket) return;
      releaseTicket(ticket);
      ticket = null;
    },
    invalidate(): void {
      stop("invalidated");
    },
    subscribeInvalidation(
      observer: (reason: Nir1RelatedScenesStopReason) => void,
    ): () => void {
      if (stopReason) {
        observer(stopReason);
        return () => {};
      }
      observers.add(observer);
      return () => observers.delete(observer);
    },
    subscribeIndexReady(observer: (revision: number) => void): () => void {
      if (readinessRevision > 0) observer(readinessRevision);
      readyObservers.add(observer);
      return () => readyObservers.delete(observer);
    },
  };
}

export type Nir1RelatedScenesSession = ReturnType<
  typeof createNir1RelatedScenesSession
>;
