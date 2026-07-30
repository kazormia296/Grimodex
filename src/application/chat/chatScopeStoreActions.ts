import type { ChatStoreActionPorts } from "./chatStoreActionPorts";
import type { ChatState } from "./chatStoreTypes";
import {
  clearedSessionScopeState,
  invalidateSessionScopeAuthority,
  sessionScopeChanged,
} from "./chatSessionAuthority";
import { markEnd, markStart } from "@/lib/perfLog";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import { isTreeNavigationLeaseActive } from "@/lib/chatNavigationGuard";

interface ChatScopeActionRuntime {
  hasPendingCompletedTurnPersistence: () => boolean;
  notifyPendingCompletedTurnPersistence: () => void;
  resetRecallPromote: () => void;
}

type ChatScopeActions = Pick<
  ChatState,
  | "clearMessages"
  | "resetForProject"
  | "setActiveProjectId"
  | "setActiveSceneId"
  | "setChatScope"
>;

export function isChatAuthorityMutationBlocked(input: {
  isStreaming: boolean;
  hasPendingCompletedTurnPersistence: boolean;
}): boolean {
  return (
    !canScheduleQuiescenceMutation() ||
    isTreeNavigationLeaseActive() ||
    input.isStreaming ||
    input.hasPendingCompletedTurnPersistence
  );
}

export function createChatScopeStoreActions(
  ports: ChatStoreActionPorts & {
    runtime: ChatScopeActionRuntime;
  },
): ChatScopeActions {
  const { get, set, runtime } = ports;

  const blockDestructiveMutation = (): boolean => {
    const isStreaming = get().isStreaming;
    const hasPendingCompletedTurnPersistence =
      runtime.hasPendingCompletedTurnPersistence();
    if (
      !isChatAuthorityMutationBlocked({
        isStreaming,
        hasPendingCompletedTurnPersistence,
      })
    ) {
      return false;
    }
    if (isStreaming || !hasPendingCompletedTurnPersistence) return true;
    runtime.notifyPendingCompletedTurnPersistence();
    return true;
  };

  return {
    resetForProject: (projectId) => {
      if (blockDestructiveMutation()) return;
      invalidateSessionScopeAuthority();
      set({
        activeSessionId: null,
        isLoadingSessions: false,
        isLoadingMessages: false,
        messages: [],
        streamingDraft: null,
        sessions: [],
        isStreaming: false,
        activeProjectId: projectId,
        activeSceneId: "",
        error: null,
        contextTokenCount: 0,
        contextWindowUsage: null,
        contextWindowSize: null,
        contextModel: null,
        contextProvider: null,
        contextRouteAuthorityKey: null,
        contextLayers: [],
        contextPlan: null,
        lastSystemPrompt: "",
        chatRecallPromoteSuggestion: null,
        pinsVersion: 0,
        projectOutline: undefined,
        chapterOutlines: [],
        detectedEntries: [],
        alwaysEntries: [],
        scopeAnchor: null,
        threadFocusOverride: null,
        excludedAutoEntryIds: [],
        inputPinnedEntryIds: [],
        agentMode: false,
        agentProgress: null,
        subAgentProgress: null,
        agentContinuation: null,
        pendingUserQuestion: null,
        ragEnabled: false,
        chatScope: "scene",
        scopeAnchorId: null,
        includeBodies: true,
        includeMapBoard: false,
        mapBoardId: null,
        pendingLookupText: null,
        summaryCount: 0,
        maxSummaryGeneration: 0,
        cacheInvalidatedReason: null,
        sessionStableCodexIds: [],
        sessionStableContextInitialized: false,
        sessionAgentToolsSnapshot: null,
        _lastCachedModel: null,
      });
    },

    setChatScope: (scope, anchorId) => {
      if (blockDestructiveMutation()) return;
      const current = get();
      // scope === "folder" / "codex" / "snippet" のとき anchorId 必須。
      // 空指定なら scene に fallback。includeBodies は scope ごとの
      // デフォルトに揃え、非永続の thread focus を別スコープへ漏らさない。
      let nextScope = scope;
      let nextAnchorId: string | null = null;
      let nextIncludeBodies = scope === "scene";
      if (scope === "folder" || scope === "codex" || scope === "snippet") {
        if (!anchorId) {
          nextScope = "scene";
          nextIncludeBodies = true;
        } else {
          nextAnchorId = anchorId;
          nextIncludeBodies = false;
        }
      }

      const boundaryChanged = sessionScopeChanged(current, {
        activeSceneId: current.activeSceneId,
        chatScope: nextScope,
        scopeAnchorId: nextAnchorId,
      });
      if (boundaryChanged) {
        invalidateSessionScopeAuthority();
        get()._cancelPendingUserQuestion();
        runtime.resetRecallPromote();
      }
      set({
        ...(boundaryChanged ? clearedSessionScopeState() : {}),
        ...(boundaryChanged ? { scopeAnchor: null } : {}),
        chatScope: nextScope,
        scopeAnchorId: nextAnchorId,
        includeBodies: nextIncludeBodies,
        threadFocusOverride: null,
      });
    },

    clearMessages: () => {
      if (blockDestructiveMutation()) return;
      set({ messages: [], agentContinuation: null });
    },

    setActiveSceneId: (id) => {
      markStart("chatStore.setActiveSceneId");
      try {
        const current = get();
        const activeSession = current.sessions.find(
          (session) => session.id === current.activeSessionId,
        );
        const activeSessionTargetsScene =
          !activeSession ||
          (activeSession.nodeId === id &&
            !activeSession.codexAnchorId &&
            !activeSession.snippetAnchorId);
        // scene scope では active scene が session authority そのもの。
        // それ以外の scope でも active scene は次の turn context へ影響するため、
        // active turn / unresolved persistence と並行して変更しない。
        const resetSceneScope =
          current.chatScope === "scene" &&
          (id !== current.activeSceneId || !activeSessionTargetsScene);
        if (
          (id !== current.activeSceneId || resetSceneScope) &&
          blockDestructiveMutation()
        ) {
          return;
        }
        if (resetSceneScope) {
          invalidateSessionScopeAuthority();
          get()._cancelPendingUserQuestion();
          runtime.resetRecallPromote();
          set({
            ...clearedSessionScopeState(),
            scopeAnchor: null,
            activeSceneId: id,
          });
          return;
        }
        set({ activeSceneId: id });
      } finally {
        markEnd("chatStore.setActiveSceneId");
      }
    },

    setActiveProjectId: (id) => {
      const current = get();
      if (current.activeProjectId !== id) {
        if (blockDestructiveMutation()) return;
        invalidateSessionScopeAuthority();
        get()._cancelPendingUserQuestion();
        runtime.resetRecallPromote();
        set({
          ...clearedSessionScopeState(),
          scopeAnchor: null,
          activeProjectId: id,
        });
        return;
      }
      set({ activeProjectId: id });
    },
  };
}
