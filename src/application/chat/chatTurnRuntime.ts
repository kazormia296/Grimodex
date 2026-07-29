import {
  createTurnCoordinator,
  type ResolvedChatTurnRoute,
} from "@/features/chat/turn/resolveTurnRoute";
import type { TurnCoordinator } from "@/features/chat/turn/turnCoordinator";

export interface ChatTurnRuntime {
  coordinator: TurnCoordinator;
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

export function createChatTurnRuntime(): ChatTurnRuntime {
  let inputPinnedRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let sendPreflightClaimId: string | null = null;
  let sendPreflightClaimScopeKey: string | null = null;
  let activeTurnRoute: ResolvedChatTurnRoute | null = null;
  let streamCleanup: (() => void) | null = null;
  let flushPendingDelta: (() => void) | null = null;
  let finalizeStoppedStream: (() => void) | null = null;

  return {
    coordinator: createTurnCoordinator(),

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
}
