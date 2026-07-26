import { useCallback, useEffect, useMemo, useState } from "react";
import type { CodexEntry } from "@/features/codex/api";
import { useChatStore } from "./chatStore";
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

export interface ChatPinsControllerOptions {
  isActive: boolean;
  activeSessionId: string | null;
  pinsVersion: number;
  allCodexEntries: readonly CodexEntry[];
  ensureSession(): Promise<string | null>;
  removeEntryFromAuto(entryId: string): void;
  /** Returns true only when this call created a new exclusion. */
  excludeEntryFromAuto(entryId: string): boolean;
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
  handleUnpin(entryId: string): Promise<void>;
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
  allCodexEntries,
  ensureSession,
  removeEntryFromAuto,
  excludeEntryFromAuto,
  clearAutoExclusion,
  refreshContextLayers,
}: ChatPinsControllerOptions): ChatPinsControllerResult {
  const [pinnedEntries, setPinnedEntries] = useState<
    PinnedCodexEntryWithData[]
  >([]);
  const [pinnedSnippets, setPinnedSnippets] = useState<
    PinnedSnippetEntryWithData[]
  >([]);
  const [pinnedStickies, setPinnedStickies] = useState<
    PinnedStickyEntryWithData[]
  >([]);

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

  useEffect(() => {
    setInputDismissedIds(new Set());
    setInputAutoExcludedIds(new Set());
  }, [isActive, activeSessionId]);

  useEffect(() => {
    if (!isActive) return;
    if (!activeSessionId) {
      setPinnedEntries([]);
      setPinnedSnippets([]);
      setPinnedStickies([]);
      return;
    }
    void chatApi
      .listPinnedCodexEntries(activeSessionId)
      .then((entries) => setPinnedEntries(manualCodexPins(entries)));
    void chatApi
      .listPinnedSnippetEntries(activeSessionId)
      .then(setPinnedSnippets);
    void chatApi
      .listPinnedStickyEntries(activeSessionId)
      .then(setPinnedStickies);
    setDismissedViaChildIds(new Set());
  }, [isActive, activeSessionId, pinsVersion]);

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
    async (entryId: string, type: "codex" | "snippet" = "codex") => {
      const sessionId = await ensureSession();
      if (!sessionId) return;
      await chatApi.pinCodexEntry(sessionId, entryId, false, "manual", type);
      removeEntryFromAuto(entryId);
      clearAutoExclusion(entryId);
      const [updatedCodex, updatedSnippets] = await Promise.all([
        chatApi.listPinnedCodexEntries(sessionId),
        chatApi.listPinnedSnippetEntries(sessionId),
      ]);
      setPinnedEntries(manualCodexPins(updatedCodex));
      setPinnedSnippets(updatedSnippets);
      await refreshContextLayers();
    },
    [
      ensureSession,
      removeEntryFromAuto,
      clearAutoExclusion,
      refreshContextLayers,
    ],
  );

  const handleUnpin = useCallback(
    async (entryId: string) => {
      if (!activeSessionId) return;
      await chatApi.unpinCodexEntry(activeSessionId, entryId);
      const [updatedCodex, updatedSnippets] = await Promise.all([
        chatApi.listPinnedCodexEntries(activeSessionId),
        chatApi.listPinnedSnippetEntries(activeSessionId),
      ]);
      setPinnedEntries(manualCodexPins(updatedCodex));
      setPinnedSnippets(updatedSnippets);
    },
    [activeSessionId],
  );

  const handleReturnToAuto = useCallback(
    async (entryId: string) => {
      clearAutoExclusion(entryId);
      await handleUnpin(entryId);
      await refreshContextLayers();
    },
    [clearAutoExclusion, handleUnpin, refreshContextLayers],
  );
  const handleRemoveFromContext = useCallback(
    async (entryId: string) => {
      await handleUnpin(entryId);
      excludeEntryFromAuto(entryId);
    },
    [handleUnpin, excludeEntryFromAuto],
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
    async (entryId: string, withChildren: boolean) => {
      const sessionId = await ensureSession();
      if (!sessionId) return;
      await chatApi.togglePinChildren(sessionId, entryId, withChildren);
      setPinnedEntries(
        manualCodexPins(await chatApi.listPinnedCodexEntries(sessionId)),
      );
    },
    [ensureSession],
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
    handleUnpin,
    handleReturnToAuto,
    handleRemoveAuto,
    handleRemoveEntry,
    handleDismissViaChild,
    handleTogglePinChildren,
  };
}
