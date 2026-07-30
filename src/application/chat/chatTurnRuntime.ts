import {
  createTurnCoordinator,
  type ResolvedChatTurnRoute,
} from "@/features/chat/turn/resolveTurnRoute";
import type { TurnCoordinator } from "@/features/chat/turn/turnCoordinator";
import { registerQuiescenceProvider } from "@/lib/quiescenceProviders";
import {
  createPendingCompletedTurnPersistenceRegistry,
  pendingCompletedTurnPersistence as productionPendingCompletedTurnPersistence,
  type CompletedTurnPersistenceInput,
  type PendingCompletedTurnPersistenceRegistry,
  type PendingCompletedTurnPersistenceTarget,
} from "./pendingCompletedTurnPersistence";

export interface ChatTurnRuntime {
  coordinator: TurnCoordinator;
  trackTurn: <T>(turn: Promise<T>) => Promise<T>;
  persistCompletedTurn: (input: CompletedTurnPersistenceInput) => Promise<void>;
  hasPendingCompletedTurnPersistence: (
    target?: PendingCompletedTurnPersistenceTarget,
  ) => boolean;
  retryPendingCompletedTurns: (
    target?: PendingCompletedTurnPersistenceTarget,
  ) => Promise<void>;
  discardPendingCompletedTurns: (
    target?: PendingCompletedTurnPersistenceTarget,
  ) => number;
  hasPendingTurns: () => boolean;
  awaitPendingTurns: () => Promise<void>;
  scheduleInputPinnedRefresh: (refresh: () => void) => void;
  claimSendPreflight: (scopeKey: string) => string | null;
  releaseSendPreflight: (claimId: string) => void;
  isSendPreflightCurrent: (claimId: string) => boolean;
  clearSendPreflight: () => void;
  setActiveRoute: (route: ResolvedChatTurnRoute | null) => void;
  activeRoute: () => ResolvedChatTurnRoute | null;
  clearActiveRouteIf: (route: ResolvedChatTurnRoute | null) => void;
  setStreamCleanup: (cleanup: (() => void) | null) => void;
  clearStreamCleanupIf: (cleanup: () => void) => void;
  runStreamCleanup: () => void;
  setPendingDeltaFlusher: (flush: (() => void) | null) => void;
  clearPendingDeltaFlusherIf: (flush: () => void) => void;
  flushPendingDelta: () => void;
  setStoppedStreamFinalizer: (finalize: (() => void) | null) => void;
  clearStoppedStreamFinalizerIf: (finalize: () => void) => void;
  finalizeStoppedStream: () => void;
}

export function createChatTurnRuntime(options?: {
  registerQuiescence?: boolean;
  pendingCompletedTurnPersistence?: PendingCompletedTurnPersistenceRegistry;
}): ChatTurnRuntime {
  const pendingTurns = new Set<Promise<unknown>>();
  const settledTurnFailures: unknown[] = [];
  const pendingCompletedTurnPersistence =
    options?.pendingCompletedTurnPersistence ??
    (options?.registerQuiescence
      ? productionPendingCompletedTurnPersistence
      : createPendingCompletedTurnPersistenceRegistry());
  let inputPinnedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let sendPreflightClaimId: string | null = null;
  let sendPreflightClaimScopeKey: string | null = null;
  let activeTurnRoute: ResolvedChatTurnRoute | null = null;
  let streamCleanup: (() => void) | null = null;
  let flushPendingDelta: (() => void) | null = null;
  let finalizeStoppedStream: (() => void) | null = null;

  const runtime: ChatTurnRuntime = {
    coordinator: createTurnCoordinator(),

    trackTurn(turn) {
      pendingTurns.add(turn);
      void turn.then(
        () => pendingTurns.delete(turn),
        (error) => {
          pendingTurns.delete(turn);
          // A lifecycle-bound persistence failure can settle after the lease
          // closes admission but before the provider stage starts. Latch it
          // until strict quiescence consumes and reports it.
          settledTurnFailures.push(error);
        },
      );
      return turn;
    },

    persistCompletedTurn(input) {
      return pendingCompletedTurnPersistence.persist(input);
    },

    hasPendingCompletedTurnPersistence(target) {
      return pendingCompletedTurnPersistence.has(target);
    },

    retryPendingCompletedTurns(target) {
      return pendingCompletedTurnPersistence.retry(target);
    },

    discardPendingCompletedTurns(target) {
      const discarded = pendingCompletedTurnPersistence.discard(target);
      if (target === undefined || target.kind === "all") {
        settledTurnFailures.length = 0;
      }
      return discarded;
    },

    hasPendingTurns() {
      return (
        pendingTurns.size > 0 ||
        settledTurnFailures.length > 0 ||
        pendingCompletedTurnPersistence.has()
      );
    },

    async awaitPendingTurns() {
      const failures: unknown[] = settledTurnFailures.splice(
        0,
        settledTurnFailures.length,
      );
      while (pendingTurns.size > 0) {
        const snapshot = [...pendingTurns];
        await Promise.allSettled(snapshot);
        failures.push(
          ...settledTurnFailures.splice(0, settledTurnFailures.length),
        );
      }
      failures.push(
        ...settledTurnFailures.splice(0, settledTurnFailures.length),
      );
      // A rejection observed from the tracked send is reported first without
      // immediately repeating the same failed write in the same lifecycle.
      // Later lifecycle attempts retry every unresolved completed turn.
      if (failures.length === 0 && pendingCompletedTurnPersistence.has()) {
        try {
          await pendingCompletedTurnPersistence.retry();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length > 0) {
        const message =
          failures.length === 1 && failures[0] instanceof Error
            ? failures[0].message
            : "One or more chat turns failed while reaching quiescence";
        throw new AggregateError(failures, message);
      }
    },

    scheduleInputPinnedRefresh(refresh) {
      if (inputPinnedRefreshTimer !== null) {
        clearTimeout(inputPinnedRefreshTimer);
      }
      inputPinnedRefreshTimer = setTimeout(() => {
        inputPinnedRefreshTimer = null;
        refresh();
      }, 500);
    },

    claimSendPreflight(scopeKey) {
      if (
        sendPreflightClaimId !== null &&
        sendPreflightClaimScopeKey === scopeKey
      ) {
        return null;
      }
      const claimId = crypto.randomUUID();
      sendPreflightClaimId = claimId;
      sendPreflightClaimScopeKey = scopeKey;
      return claimId;
    },

    releaseSendPreflight(claimId) {
      if (sendPreflightClaimId === claimId) {
        sendPreflightClaimId = null;
        sendPreflightClaimScopeKey = null;
      }
    },

    isSendPreflightCurrent(claimId) {
      return sendPreflightClaimId === claimId;
    },

    clearSendPreflight() {
      sendPreflightClaimId = null;
      sendPreflightClaimScopeKey = null;
    },

    setActiveRoute(route) {
      activeTurnRoute = route;
    },

    activeRoute() {
      return activeTurnRoute;
    },

    clearActiveRouteIf(route) {
      if (activeTurnRoute === route) activeTurnRoute = null;
    },

    setStreamCleanup(cleanup) {
      streamCleanup = cleanup;
    },

    clearStreamCleanupIf(cleanup) {
      if (streamCleanup === cleanup) streamCleanup = null;
    },

    runStreamCleanup() {
      streamCleanup?.();
      streamCleanup = null;
    },

    setPendingDeltaFlusher(flush) {
      flushPendingDelta = flush;
    },

    clearPendingDeltaFlusherIf(flush) {
      if (flushPendingDelta === flush) flushPendingDelta = null;
    },

    flushPendingDelta() {
      flushPendingDelta?.();
      flushPendingDelta = null;
    },

    setStoppedStreamFinalizer(finalize) {
      finalizeStoppedStream = finalize;
    },

    clearStoppedStreamFinalizerIf(finalize) {
      if (finalizeStoppedStream === finalize) finalizeStoppedStream = null;
    },

    finalizeStoppedStream() {
      finalizeStoppedStream?.();
    },
  };
  if (options?.registerQuiescence) {
    registerQuiescenceProvider({
      id: "chat-turn-runtime",
      stage: "scoped-mutations",
      flush: async () => {
        if (!runtime.hasPendingTurns()) return;
        // Invalidate only an asynchronous preflight. An active stream drains
        // naturally, including callback finalization and old-scope persistence.
        runtime.clearSendPreflight();
        await runtime.awaitPendingTurns();
      },
      discard: () => {
        runtime.discardPendingCompletedTurns();
      },
      recovery: () => pendingCompletedTurnPersistence.recovery(),
    });
  }
  return runtime;
}
