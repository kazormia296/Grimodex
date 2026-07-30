import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import i18next from "i18next";
import { toast } from "sonner";
import type { CodexEntry } from "@/features/codex/api";
import { debugLog, errorDetail } from "@/lib/debugLog";
import { isIpcLifecycleCancellation } from "@/lib/tauri";
import {
  awaitChatComposerAuthority,
  captureChatComposerAuthority,
  useChatStore,
} from "./chatStore";
import * as chatApi from "./chatApi";
import type {
  PinnedSnippetEntryWithData,
  PinnedStickyEntryWithData,
  PinnedCodexEntryWithData,
} from "./chatApi";

const manualCodexPins = (
  entries: PinnedCodexEntryWithData[],
): PinnedCodexEntryWithData[] =>
  entries.filter((entry) => entry.pinSource !== "chat_mention");

const pinSessionIsCurrent = (sessionId: string): boolean =>
  useChatStore.getState().activeSessionId === sessionId;

const pinSessionIsWritable = (sessionId: string): boolean => {
  const state = useChatStore.getState();
  return (
    state.activeSessionId === sessionId &&
    !state.isLoadingSessions &&
    !state.isLoadingMessages &&
    !state.isStreaming
  );
};

interface SessionPinsSnapshot {
  sessionId: string | null;
  codex: PinnedCodexEntryWithData[];
  snippets: PinnedSnippetEntryWithData[];
  stickies: PinnedStickyEntryWithData[];
}

const EMPTY_CODEX_PINS: PinnedCodexEntryWithData[] = [];
const EMPTY_SNIPPET_PINS: PinnedSnippetEntryWithData[] = [];
const EMPTY_STICKY_PINS: PinnedStickyEntryWithData[] = [];

async function loadSessionPinsSnapshot(
  sessionId: string,
): Promise<SessionPinsSnapshot> {
  const [codex, snippets, stickies] = await Promise.all([
    chatApi.listPinnedCodexEntries(sessionId),
    chatApi.listPinnedSnippetEntries(sessionId),
    chatApi.listPinnedStickyEntries(sessionId),
  ]);
  return {
    sessionId,
    codex: manualCodexPins(codex),
    snippets,
    stickies,
  };
}

export interface ChatPinsControllerOptions {
  isActive: boolean;
  activeSessionId: string | null;
  pinsVersion: number;
  /** Prevents new mutations and passive reads while chat authority is moving. */
  mutationsDisabled?: boolean;
  allCodexEntries: readonly CodexEntry[];
  ensureSession(): Promise<string | null>;
  removeEntryFromAuto(entryId: string): void;
  /** Returns true only when this call created a new exclusion. */
  excludeEntryFromAuto(
    entryId: string,
    options?: { refreshContext?: boolean },
  ): boolean;
  clearAutoExclusion(entryId: string): void;
  refreshContextLayers(): Promise<unknown>;
}

export interface ChatPinsControllerResult {
  pinnedEntries: PinnedCodexEntryWithData[];
  pinnedSnippets: PinnedSnippetEntryWithData[];
  pinnedStickies: PinnedStickyEntryWithData[];
  pinnedIds: Set<string>;
  pinnedSnippetIds: Set<string>;
  inputPinnedEntries: Array<
    CodexEntry & {
      withChildren: boolean;
      pinnedType: "codex";
      pinSource: "chat_mention";
    }
  >;
  inputPinnedIds: Set<string>;
  dismissedViaChildIds: Set<string>;
  handleDetectedEntries(ids: string[]): void;
  resetInputDismissed(): void;
  handlePin(entryId: string, type?: "codex" | "snippet"): Promise<void>;
  handlePinBatch(entryIds: readonly string[]): Promise<boolean>;
  handleUnpin(entryId: string): Promise<boolean>;
  handleUnpinSticky(stickyId: string): Promise<boolean>;
  handleReturnToAuto(entryId: string): Promise<void>;
  handleRemoveAuto(entryId: string): void;
  handleRemoveEntry(entryId: string): Promise<void>;
  handleDismissViaChild(childId: string): void;
  handleTogglePinChildren(
    entryId: string,
    withChildren: boolean,
  ): Promise<void>;
}

/** Owns session pin reads, current-input mention pills, and context-removal commands. */
export function useChatPinsController({
  isActive,
  activeSessionId,
  pinsVersion,
  mutationsDisabled = false,
  allCodexEntries,
  ensureSession,
  removeEntryFromAuto,
  excludeEntryFromAuto,
  clearAutoExclusion,
  refreshContextLayers,
}: ChatPinsControllerOptions): ChatPinsControllerResult {
  const [pinsSnapshot, setPinsSnapshot] = useState<SessionPinsSnapshot>({
    sessionId: null,
    codex: [],
    snippets: [],
    stickies: [],
  });
  // Spotlight writes are serialized so two fast actions cannot publish their
  // readbacks in reverse order. The epoch also invalidates passive reads that
  // began before or during a mutation.
  const mutationTailRef = useRef<Promise<void>>(Promise.resolve());
  const mutationEpochRef = useRef(0);
  const pendingContextRefreshSessionRef = useRef<string | null>(null);
  const pendingContextRefreshIsRetryRef = useRef(false);
  const [pinsReloadVersion, setPinsReloadVersion] = useState(0);
  const [contextRefreshRequestVersion, setContextRefreshRequestVersion] =
    useState(0);
  const enqueueMutation = useCallback(
    <T>(operation: (epoch: number) => Promise<T>): Promise<T> => {
      const run = async () => {
        const epoch = ++mutationEpochRef.current;
        try {
          return await operation(epoch);
        } finally {
          if (mutationEpochRef.current === epoch) {
            mutationEpochRef.current += 1;
          }
          // A session switch can start the replacement session's passive read
          // while this mutation still owns the epoch. Re-read after every
          // settle so that an epoch-invalidated replacement read is not lost.
          setPinsReloadVersion((version) => version + 1);
        }
      };
      const result = mutationTailRef.current.then(run, run);
      mutationTailRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [],
  );
  const mutationOwnsCurrentSession = useCallback(
    (sessionId: string, epoch: number) =>
      mutationEpochRef.current === epoch && pinSessionIsCurrent(sessionId),
    [],
  );
  const mutationCanStart = useCallback(
    (sessionId: string, epoch: number) =>
      mutationOwnsCurrentSession(sessionId, epoch) &&
      pinSessionIsWritable(sessionId),
    [mutationOwnsCurrentSession],
  );

  const [inputDetectedIds, setInputDetectedIds] = useState<string[]>([]);
  const [inputDismissedIds, setInputDismissedIds] = useState<Set<string>>(
    new Set(),
  );
  /** Exclusions created by a current-input dismissal; cleared after its send. */
  const [inputAutoExcludedIds, setInputAutoExcludedIds] = useState<Set<string>>(
    new Set(),
  );
  const [dismissedViaChildIds, setDismissedViaChildIds] = useState<Set<string>>(
    new Set(),
  );

  const reportUnavailable = useCallback(() => {
    debugLog.warn(
      "ChatPins",
      "Spotlight update skipped because the chat authority changed",
    );
    toast.error(i18next.t("chat.context.spotlightUnavailable"));
  }, []);

  const refreshContextForSession = useCallback(
    async (sessionId: string, retry = false): Promise<void> => {
      if (!pinSessionIsCurrent(sessionId)) {
        if (pendingContextRefreshSessionRef.current === sessionId) {
          pendingContextRefreshSessionRef.current = null;
          pendingContextRefreshIsRetryRef.current = false;
        }
        return;
      }
      if (!pinSessionIsWritable(sessionId)) {
        pendingContextRefreshSessionRef.current = sessionId;
        pendingContextRefreshIsRetryRef.current = retry;
        return;
      }
      pendingContextRefreshSessionRef.current = null;
      try {
        await refreshContextLayers();
        pendingContextRefreshIsRetryRef.current = false;
      } catch (cause) {
        if (!pinSessionIsCurrent(sessionId)) return;
        pendingContextRefreshSessionRef.current = sessionId;
        pendingContextRefreshIsRetryRef.current = true;
        debugLog.error("ChatPins", "Failed to refresh Spotlight context", {
          sensitivity: "safe",
          fields: { error: errorDetail(cause) },
        });
        if (!retry) {
          // Retry exactly once while authority is still writable. Further
          // retries wait for a real busy -> writable transition so a persistent
          // failure cannot create a render loop.
          setContextRefreshRequestVersion((version) => version + 1);
          toast.error(i18next.t("chat.context.spotlightUpdateFailed"));
        }
      }
    },
    [refreshContextLayers],
  );

  const publishMutationReadback = useCallback(
    async (sessionId: string, epoch: number): Promise<boolean> => {
      try {
        const snapshot = await loadSessionPinsSnapshot(sessionId);
        if (!mutationOwnsCurrentSession(sessionId, epoch)) return false;
        setPinsSnapshot(snapshot);
        return true;
      } catch (cause) {
        if (!mutationOwnsCurrentSession(sessionId, epoch)) return false;
        setPinsReloadVersion((version) => version + 1);
        debugLog.error("ChatPins", "Failed to reload Spotlight entries", {
          sensitivity: "safe",
          fields: { error: errorDetail(cause) },
        });
        toast.error(i18next.t("chat.context.spotlightUpdateFailed"));
        return true;
      }
    },
    [mutationOwnsCurrentSession],
  );

  const resolveMutationSession = useCallback(
    async (
      authority: ReturnType<typeof captureChatComposerAuthority>,
      epoch: number,
    ): Promise<string | null> => {
      if (!(await awaitChatComposerAuthority(authority))) {
        reportUnavailable();
        return null;
      }
      const sessionId = await ensureSession();
      if (!sessionId) {
        reportUnavailable();
        return null;
      }
      // Creating the first session is the one expected authority transition.
      // Existing sessions, however, must still match the click-time owner after
      // ensureSession has awaited any queued lifecycle work.
      if (
        authority.activeSessionId !== null &&
        !(await awaitChatComposerAuthority(authority))
      ) {
        reportUnavailable();
        return null;
      }
      if (!mutationCanStart(sessionId, epoch)) {
        reportUnavailable();
        return null;
      }
      return sessionId;
    },
    [ensureSession, mutationCanStart, reportUnavailable],
  );

  useEffect(() => {
    setInputDismissedIds(new Set());
    setInputAutoExcludedIds(new Set());
  }, [isActive, activeSessionId]);

  useEffect(() => {
    if (isActive) setDismissedViaChildIds(new Set());
  }, [isActive, activeSessionId, pinsVersion]);

  useEffect(() => {
    if (!isActive) return;
    if (!activeSessionId) {
      pendingContextRefreshSessionRef.current = null;
      pendingContextRefreshIsRetryRef.current = false;
      setPinsSnapshot({
        sessionId: null,
        codex: [],
        snippets: [],
        stickies: [],
      });
      return;
    }
    if (
      pendingContextRefreshSessionRef.current !== null &&
      pendingContextRefreshSessionRef.current !== activeSessionId
    ) {
      pendingContextRefreshSessionRef.current = null;
      pendingContextRefreshIsRetryRef.current = false;
    }
    if (mutationsDisabled) return;
    let cancelled = false;
    const sessionId = activeSessionId;
    const readEpoch = mutationEpochRef.current;
    void loadSessionPinsSnapshot(sessionId)
      .then((snapshot) => {
        if (
          cancelled ||
          readEpoch !== mutationEpochRef.current ||
          !pinSessionIsCurrent(sessionId)
        ) {
          return;
        }
        setPinsSnapshot(snapshot);
      })
      .catch((cause) => {
        if (isIpcLifecycleCancellation(cause)) return;
        if (
          cancelled ||
          readEpoch !== mutationEpochRef.current ||
          !pinSessionIsCurrent(sessionId)
        ) {
          return;
        }
        debugLog.error("ChatPins", "Failed to load Spotlight entries", {
          sensitivity: "safe",
          fields: { error: errorDetail(cause) },
        });
      });
    return () => {
      cancelled = true;
    };
  }, [
    isActive,
    activeSessionId,
    mutationsDisabled,
    pinsReloadVersion,
    pinsVersion,
  ]);

  useEffect(() => {
    return useChatStore.subscribe((state, previous) => {
      const pendingSessionId = pendingContextRefreshSessionRef.current;
      if (!pendingSessionId) return;
      const becameWritable =
        state.activeSessionId === pendingSessionId &&
        !state.isLoadingSessions &&
        !state.isLoadingMessages &&
        !state.isStreaming &&
        (previous.activeSessionId !== pendingSessionId ||
          previous.isLoadingSessions ||
          previous.isLoadingMessages ||
          previous.isStreaming);
      if (becameWritable) {
        setContextRefreshRequestVersion((version) => version + 1);
      }
    });
  }, []);

  useEffect(() => {
    if (
      !isActive ||
      mutationsDisabled ||
      !activeSessionId ||
      pendingContextRefreshSessionRef.current !== activeSessionId ||
      !pinSessionIsWritable(activeSessionId)
    ) {
      return;
    }
    void refreshContextForSession(
      activeSessionId,
      pendingContextRefreshIsRetryRef.current,
    );
  }, [
    activeSessionId,
    contextRefreshRequestVersion,
    isActive,
    mutationsDisabled,
    refreshContextForSession,
  ]);

  // Pair every readback with its owner session. A session switch therefore
  // hides the previous session's pills in the very render that changes the id,
  // without waiting for the replacement IPC reads to settle.
  const pinsSnapshotIsCurrent =
    isActive &&
    activeSessionId !== null &&
    pinsSnapshot.sessionId === activeSessionId;
  const pinnedEntries = pinsSnapshotIsCurrent
    ? pinsSnapshot.codex
    : EMPTY_CODEX_PINS;
  const pinnedSnippets = pinsSnapshotIsCurrent
    ? pinsSnapshot.snippets
    : EMPTY_SNIPPET_PINS;
  const pinnedStickies = pinsSnapshotIsCurrent
    ? pinsSnapshot.stickies
    : EMPTY_STICKY_PINS;

  const pinnedIds = useMemo(
    () => new Set(pinnedEntries.map((entry) => entry.id)),
    [pinnedEntries],
  );
  const pinnedSnippetIds = useMemo(
    () => new Set(pinnedSnippets.map((snippet) => snippet.id)),
    [pinnedSnippets],
  );
  const inputPinnedEntries = useMemo(
    () =>
      inputDetectedIds
        .filter((id) => !inputDismissedIds.has(id) && !pinnedIds.has(id))
        .map((id) => allCodexEntries.find((entry) => entry.id === id))
        .filter((entry): entry is CodexEntry => entry !== undefined)
        .map((entry) => ({
          ...entry,
          // Current-input mentions are a turn trigger, not a persisted
          // Spotlight pin. Descendants must pass their own visibility policy.
          withChildren: false,
          pinnedType: "codex" as const,
          pinSource: "chat_mention" as const,
        })),
    [inputDetectedIds, inputDismissedIds, allCodexEntries, pinnedIds],
  );
  const inputPinnedIds = useMemo(
    () => new Set(inputPinnedEntries.map((entry) => entry.id)),
    [inputPinnedEntries],
  );

  useEffect(() => {
    useChatStore
      .getState()
      .setInputPinnedEntryIds(inputPinnedEntries.map((entry) => entry.id));
  }, [inputPinnedEntries]);

  const handleDetectedEntries = useCallback((ids: string[]) => {
    setInputDetectedIds(ids);
  }, []);
  const resetInputDismissed = useCallback(() => {
    setInputDismissedIds(new Set());
    for (const entryId of inputAutoExcludedIds) {
      clearAutoExclusion(entryId);
    }
    setInputAutoExcludedIds(new Set());
  }, [clearAutoExclusion, inputAutoExcludedIds]);

  const handlePin = useCallback(
    (entryId: string, type: "codex" | "snippet" = "codex") => {
      const authority = captureChatComposerAuthority();
      if (mutationsDisabled) {
        reportUnavailable();
        return Promise.resolve();
      }
      return enqueueMutation(async (epoch) => {
        try {
          const sessionId = await resolveMutationSession(authority, epoch);
          if (!sessionId) return;
          await chatApi.pinCodexEntry(
            sessionId,
            entryId,
            false,
            "manual",
            type,
          );
          if (!mutationOwnsCurrentSession(sessionId, epoch)) return;
          removeEntryFromAuto(entryId);
          clearAutoExclusion(entryId);
          if (!(await publishMutationReadback(sessionId, epoch))) return;
          await refreshContextForSession(sessionId);
        } catch (cause) {
          debugLog.error("ChatPins", "Failed to update Spotlight", {
            sensitivity: "safe",
            fields: { error: errorDetail(cause) },
          });
          toast.error(i18next.t("chat.context.spotlightUpdateFailed"));
        }
      });
    },
    [
      mutationsDisabled,
      enqueueMutation,
      reportUnavailable,
      resolveMutationSession,
      mutationOwnsCurrentSession,
      removeEntryFromAuto,
      clearAutoExclusion,
      publishMutationReadback,
      refreshContextForSession,
    ],
  );

  const handlePinBatch = useCallback(
    (entryIds: readonly string[]) => {
      const uniqueEntryIds = [...new Set(entryIds)];
      if (uniqueEntryIds.length === 0) return Promise.resolve(true);
      const authority = captureChatComposerAuthority();
      if (mutationsDisabled) {
        reportUnavailable();
        return Promise.resolve(false);
      }
      return enqueueMutation(async (epoch) => {
        let sessionId: string | null = null;
        let persistedAny = false;
        try {
          sessionId = await resolveMutationSession(authority, epoch);
          if (!sessionId) return false;
          for (const entryId of uniqueEntryIds) {
            if (!mutationOwnsCurrentSession(sessionId, epoch)) return false;
            await chatApi.pinCodexEntry(
              sessionId,
              entryId,
              false,
              "manual",
              "codex",
            );
            persistedAny = true;
            if (!mutationOwnsCurrentSession(sessionId, epoch)) return false;
            removeEntryFromAuto(entryId);
            clearAutoExclusion(entryId);
          }
          if (!(await publishMutationReadback(sessionId, epoch))) return false;
          await refreshContextForSession(sessionId);
          return mutationOwnsCurrentSession(sessionId, epoch);
        } catch (cause) {
          if (
            sessionId &&
            persistedAny &&
            mutationOwnsCurrentSession(sessionId, epoch)
          ) {
            await publishMutationReadback(sessionId, epoch);
            await refreshContextForSession(sessionId);
          }
          debugLog.error("ChatPins", "Failed to update Spotlight batch", {
            sensitivity: "safe",
            fields: { error: errorDetail(cause) },
          });
          toast.error(i18next.t("chat.context.spotlightUpdateFailed"));
          return false;
        }
      });
    },
    [
      mutationsDisabled,
      enqueueMutation,
      reportUnavailable,
      resolveMutationSession,
      mutationOwnsCurrentSession,
      removeEntryFromAuto,
      clearAutoExclusion,
      publishMutationReadback,
      refreshContextForSession,
    ],
  );

  const runUnpinMutation = useCallback(
    (
      entryId: string,
      persistUnpin: (sessionId: string, entryId: string) => Promise<void>,
      afterPersist?: () => void,
    ): Promise<boolean> => {
      const authority = captureChatComposerAuthority();
      const sessionId = authority.activeSessionId;
      if (!sessionId || mutationsDisabled) {
        if (mutationsDisabled) reportUnavailable();
        return Promise.resolve(false);
      }
      return enqueueMutation(async (epoch) => {
        if (
          !(await awaitChatComposerAuthority(authority)) ||
          !mutationCanStart(sessionId, epoch)
        ) {
          reportUnavailable();
          return false;
        }
        try {
          await persistUnpin(sessionId, entryId);
        } catch (cause) {
          debugLog.error("ChatPins", "Failed to remove Spotlight", {
            sensitivity: "safe",
            fields: { error: errorDetail(cause) },
          });
          toast.error(i18next.t("chat.context.spotlightUpdateFailed"));
          return false;
        }
        if (!mutationOwnsCurrentSession(sessionId, epoch)) return false;
        if (!(await publishMutationReadback(sessionId, epoch))) return false;
        if (!mutationOwnsCurrentSession(sessionId, epoch)) return false;
        afterPersist?.();
        await refreshContextForSession(sessionId);
        return mutationOwnsCurrentSession(sessionId, epoch);
      });
    },
    [
      mutationsDisabled,
      enqueueMutation,
      mutationCanStart,
      mutationOwnsCurrentSession,
      publishMutationReadback,
      refreshContextForSession,
      reportUnavailable,
    ],
  );

  const handleUnpin = useCallback(
    (entryId: string) => runUnpinMutation(entryId, chatApi.unpinCodexEntry),
    [runUnpinMutation],
  );
  const handleUnpinSticky = useCallback(
    (stickyId: string) => runUnpinMutation(stickyId, chatApi.unpinStickyEntry),
    [runUnpinMutation],
  );
  const handleReturnToAuto = useCallback(
    async (entryId: string) => {
      await runUnpinMutation(entryId, chatApi.unpinCodexEntry, () =>
        clearAutoExclusion(entryId),
      );
    },
    [clearAutoExclusion, runUnpinMutation],
  );
  const handleRemoveFromContext = useCallback(
    async (entryId: string) => {
      await runUnpinMutation(entryId, chatApi.unpinCodexEntry, () =>
        excludeEntryFromAuto(entryId, {
          refreshContext: false,
        }),
      );
    },
    [excludeEntryFromAuto, runUnpinMutation],
  );
  const handleRemoveAuto = useCallback(
    (entryId: string) => excludeEntryFromAuto(entryId),
    [excludeEntryFromAuto],
  );
  const handleRemoveEntry = useCallback(
    async (entryId: string) => {
      if (inputPinnedIds.has(entryId)) {
        setInputDismissedIds((previous) => new Set([...previous, entryId]));
        // The source matcher also sees the outgoing text. Exclude it from this
        // turn's authority snapshot, then reset that exclusion after send so a
        // later turn can detect the entry again.
        if (excludeEntryFromAuto(entryId)) {
          setInputAutoExcludedIds(
            (previous) => new Set([...previous, entryId]),
          );
        }
      } else {
        await handleRemoveFromContext(entryId);
      }
    },
    [inputPinnedIds, excludeEntryFromAuto, handleRemoveFromContext],
  );
  const handleDismissViaChild = useCallback((childId: string) => {
    setDismissedViaChildIds((previous) => new Set([...previous, childId]));
  }, []);
  const handleTogglePinChildren = useCallback(
    (entryId: string, withChildren: boolean) => {
      const authority = captureChatComposerAuthority();
      if (mutationsDisabled) {
        reportUnavailable();
        return Promise.resolve();
      }
      return enqueueMutation(async (epoch) => {
        try {
          const sessionId = await resolveMutationSession(authority, epoch);
          if (!sessionId) return;
          await chatApi.togglePinChildren(sessionId, entryId, withChildren);
          if (!mutationOwnsCurrentSession(sessionId, epoch)) return;
          if (!(await publishMutationReadback(sessionId, epoch))) return;
          await refreshContextForSession(sessionId);
        } catch (cause) {
          debugLog.error("ChatPins", "Failed to update Spotlight children", {
            sensitivity: "safe",
            fields: { error: errorDetail(cause) },
          });
          toast.error(i18next.t("chat.context.spotlightUpdateFailed"));
        }
      });
    },
    [
      mutationsDisabled,
      enqueueMutation,
      reportUnavailable,
      resolveMutationSession,
      mutationOwnsCurrentSession,
      publishMutationReadback,
      refreshContextForSession,
    ],
  );

  return {
    pinnedEntries,
    pinnedSnippets,
    pinnedStickies,
    pinnedIds,
    pinnedSnippetIds,
    inputPinnedEntries,
    inputPinnedIds,
    dismissedViaChildIds,
    handleDetectedEntries,
    resetInputDismissed,
    handlePin,
    handlePinBatch,
    handleUnpin,
    handleUnpinSticky,
    handleReturnToAuto,
    handleRemoveAuto,
    handleRemoveEntry,
    handleDismissViaChild,
    handleTogglePinChildren,
  };
}
