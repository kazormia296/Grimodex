import { create } from "zustand";
import { toast } from "sonner";
import i18next from "@/lib/i18n";
import { blockIfPolicyOff } from "@/features/ai-policy/policyGuard";
import { blockIfUnlicensed } from "@/features/license/gate";
import { getCurrentImeWorkspaceIdentity } from "@/features/ime/workspaceScope";
import * as chatApi from "./chatApi";
import { resolveRolePathConfig } from "./modelRouting";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  captureAgentPreflightAuthority,
  getChatApiVariant,
  getCrossProviderChatOverride,
  isSameAgentPreflightAuthority,
  resolveAgentPreflightTarget,
  resolveConversationPreflightTarget,
  resolveCurrentChatDisplayRoute,
  resolveCurrentChatTurnPolicy,
  resolveCurrentPreflightRoute,
  resolveRawAgentPreflightTarget,
  canUseCurrentChatPublicRag,
} from "@/application/chat/chatTurnRouting";
export { canUseCurrentChatPublicRag, resolveCurrentChatDisplayRoute };
import type { ChatState } from "@/application/chat/chatStoreTypes";
export type {
  ChatPromptPreviewResult,
  PendingUserQuestion,
} from "@/application/chat/chatStoreTypes";
import {
  contextPromptKey,
  createChatComposerAuthority,
  createChatContextStoreActions,
  createChatContinuationStoreActions,
  createChatPersistenceStoreActions,
  createChatSessionStoreActions,
  createConfiguredChatTurnStoreActions,
  createChatTurnPreflight,
  createChatTurnRuntime,
  createChatUserQuestionRuntime,
  createChatUserQuestionStoreActions,
  type ChatComposerAuthority,
} from "@/application/chat/chatStoreActions";
export { contextPromptKey };
import {
  clearedSessionScopeState,
  getSessionMutationTail,
  hasPendingSessionMutations,
  invalidateSessionScopeAuthority,
  isCapturedWorkspaceCurrent,
  sessionScopeChanged,
} from "@/application/chat/chatSessionAuthority";
import {
  createSessionForCurrentRuntime,
  parseMentionedSceneIdsFromMetadata,
} from "@/application/chat/chatStoreSupport";

import { snapshotAgentTools } from "./agent/toolDefinitions";
import { useAiSettingsStore, refreshDynamicCapsForProvider } from "./store";
import { resolvedChatTurnRouteAuthorityKey } from "./turn/resolveTurnRoute";
import {
  createRecallPromoteTracker,
  dismissRecallPromote,
  resetRecallPromote,
} from "./chatRecallPromote";
import * as codexAppApi from "./codexAppApi";

import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { readRuntimeSetting } from "@/features/settings/runtimeSettings";
import { markStart, markEnd } from "@/lib/perfLog";
import { setSnippetDeletedHandler } from "@/features/snippets/anchorNotify";

const turnRuntime = createChatTurnRuntime();
const userQuestionRuntime = createChatUserQuestionRuntime();
let configuredChatTurnPreflight: ReturnType<
  typeof createChatTurnPreflight
> | null = null;

function getConfiguredChatTurnPreflight(
  set: Parameters<typeof createChatTurnPreflight>[0]["set"],
  get: Parameters<typeof createChatTurnPreflight>[0]["get"],
): ReturnType<typeof createChatTurnPreflight> {
  configuredChatTurnPreflight ??= createChatTurnPreflight({
    set,
    get,
    provider: {
      getAiState: () => useAiSettingsStore.getState(),
      getChatApiVariant: (model) => getChatApiVariant(model),
      getCrossProviderChatOverride: () => getCrossProviderChatOverride(),
      resolveRolePathConfig: (pathId, activeProvider) =>
        resolveRolePathConfig(pathId, undefined, activeProvider),
      captureAgentAuthority: () => captureAgentPreflightAuthority(),
      isSameAgentAuthority: (left, right) =>
        isSameAgentPreflightAuthority(left, right),
      resolveRawAgentTarget: () => resolveRawAgentPreflightTarget(),
      resolveAgentTarget: () => resolveAgentPreflightTarget(),
      resolveConversationTarget: () => resolveConversationPreflightTarget(),
      resolveCurrentPreflightRoute: (surface) =>
        resolveCurrentPreflightRoute(surface),
      resolveCurrentTurnPolicy: (input) => resolveCurrentChatTurnPolicy(input),
      refreshDynamicCapsForProvider: (provider, options) =>
        refreshDynamicCapsForProvider(provider, options),
    },
    runtime: {
      claimSendPreflight: (scopeKey) =>
        turnRuntime.claimSendPreflight(scopeKey),
      releaseSendPreflight: (claimId) =>
        turnRuntime.releaseSendPreflight(claimId),
      isSendPreflightCurrent: (claimId) =>
        turnRuntime.isSendPreflightCurrent(claimId),
      hasPendingSessionMutations: () => hasPendingSessionMutations(),
      getSessionMutationTail: () => getSessionMutationTail(),
      getWorkspaceIdentity: () => getCurrentImeWorkspaceIdentity(),
      isWorkspaceCurrent: (identity) => isCapturedWorkspaceCurrent(identity),
      getCurrentProjectId: () => getCurrentProjectId(),
      blockIfPolicyOff: () => blockIfPolicyOff("chat"),
      blockIfUnlicensed: () => blockIfUnlicensed(),
      snapshotAgentTools: () => snapshotAgentTools(),
      readSetting: (key, defaultValue) => readRuntimeSetting(key, defaultValue),
      translate: (key, options) => i18next.t(key, options),
      notifyError: (message) => toast.error(message),
      randomUuid: () => crypto.randomUUID(),
      nowIso: () => new Date().toISOString(),
    },
  });
  return configuredChatTurnPreflight;
}

const composerAuthority = createChatComposerAuthority({
  get: () => useChatStore.getState(),
  captureAiRoute: (state) =>
    JSON.stringify([
      state.agentMode,
      state.ragEnabled,
      captureAgentPreflightAuthority(),
      resolvedChatTurnRouteAuthorityKey(
        resolveCurrentChatTurnPolicy({
          agentMode: state.agentMode,
          ragEnabled: state.ragEnabled,
        }).route,
      ),
    ]) ?? "",
});

export type { ChatComposerAuthority };

export function captureChatComposerAuthority(): ChatComposerAuthority {
  return composerAuthority.capture();
}

export function awaitChatComposerAuthority(
  authority: ChatComposerAuthority,
): Promise<boolean> {
  return composerAuthority.awaitCurrent(authority);
}

function awaitWritableChatComposerAuthority(
  authority: ChatComposerAuthority,
): Promise<boolean> {
  return composerAuthority.awaitWritable(authority);
}
/**
 * chat episodic recall の「Codex に昇格しますか？」頻度トラッカー (per-session・
 * in-memory)。store 外の module 状態にして、毎ターンの recall カウントで store の
 * re-render を起こさない (提案が立った瞬間だけ store state を更新する)。
 */
const recallPromoteTracker = createRecallPromoteTracker();

export const useChatStore = create<ChatState>()((set, get) => ({
  sessions: [],
  activeSessionId: null,
  isLoadingSessions: false,
  isLoadingMessages: false,
  messages: [],
  streamingDraft: null,
  isStreaming: false,
  error: null,
  activeSceneId: "",
  activeProjectId: null,
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

  resetForProject: (projectId) => {
    if (get().isStreaming) get().stopGeneration();
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

  invalidateContextCache: (reason) => {
    set({ cacheInvalidatedReason: reason });
  },

  dismissCacheInvalidated: () => {
    set({ cacheInvalidatedReason: null });
  },

  syncInsertedToEditorMetadata: (messageId) => {
    set((s) => ({
      messages: s.messages.map((m) => {
        if (m.id !== messageId) return m;
        let meta: Record<string, unknown> = {};
        if (m.metadata) {
          try {
            meta = JSON.parse(m.metadata) as Record<string, unknown>;
          } catch {
            meta = {};
          }
        }
        return {
          ...m,
          metadata: JSON.stringify({ ...meta, insertedToEditor: true }),
        };
      }),
    }));
  },

  onCodexAnchorDeleted: (entryId: string) => {
    const { chatScope, scopeAnchorId } = get();
    if (chatScope === "codex" && scopeAnchorId === entryId) {
      get().setChatScope("scene");
    }
  },

  onSnippetAnchorDeleted: (snippetId: string) => {
    const { chatScope, scopeAnchorId } = get();
    if (chatScope === "snippet" && scopeAnchorId === snippetId) {
      get().setChatScope("scene");
    }
  },

  setPendingLookupText: (text) => set({ pendingLookupText: text }),

  // --- Session management ---

  ...createChatSessionStoreActions({
    set,
    get,
    repository: {
      listSessions: (projectId, nodeId, codexAnchorId, snippetAnchorId) =>
        chatApi.listSessions(projectId, nodeId, codexAnchorId, snippetAnchorId),
      getSessionForProject: (sessionId, projectId) =>
        chatApi.getSessionForProject(sessionId, projectId),
      createSession: (
        projectId,
        title,
        nodeId,
        codexAnchorId,
        snippetAnchorId,
      ) =>
        createSessionForCurrentRuntime(
          projectId,
          title,
          nodeId,
          codexAnchorId,
          snippetAnchorId,
        ),
      deleteSession: (sessionId) => chatApi.deleteSession(sessionId),
      listMessages: (sessionId) => chatApi.listMessages(sessionId),
      listSummaries: (sessionId) => chatApi.listSummaries(sessionId),
      addSystemMessage: (sessionId, content) =>
        chatApi.addMessage(sessionId, "system", content),
      archiveSessionThread: (input) =>
        codexAppApi.archiveCodexSessionThread(input),
    },
    runtime: {
      snapshotAgentTools,
      resetRecallPromote: () => resetRecallPromote(recallPromoteTracker),
      translate: (key, options) => i18next.t(key, options),
      notifyError: (message) => toast.error(message),
      reportError: (operation, error) =>
        debugLog.error("ChatStore", operation, errorDetail(error)),
      reportWarning: (operation, error) =>
        debugLog.warn("ChatStore", operation, errorDetail(error)),
    },
  }),

  ...createChatPersistenceStoreActions({
    set,
    get,
    repository: {
      addMessage: (sessionId, role, content, extra) =>
        extra === undefined
          ? chatApi.addMessage(sessionId, role, content)
          : chatApi.addMessage(sessionId, role, content, extra),
      saveMessagePrompt: (messageId, snapshot) =>
        chatApi.saveMessagePrompt(messageId, snapshot),
      deleteMessage: (messageId) => chatApi.deleteMessage(messageId),
    },
    runtime: {
      notifySaveFailure: () => toast.error(i18next.t("chat.saveMessageFailed")),
      notifyDeleteFailure: () =>
        toast.error(i18next.t("chat.deleteMessageFailed")),
      reportError: (operation, error) =>
        debugLog.error("ChatStore", operation, errorDetail(error)),
      reportWarning: (operation, error) =>
        debugLog.warn("ChatStore", operation, errorDetail(error)),
      parseMentionedSceneIds: parseMentionedSceneIdsFromMetadata,
    },
  }),

  // --- Streaming chat ---

  ...createConfiguredChatTurnStoreActions({
    set,
    get,
    prepareChatTurn: (input) => getConfiguredChatTurnPreflight(set, get)(input),
    turnRuntime,
    userQuestionRuntime,
  }),

  ...createChatContextStoreActions({
    set,
    get,
    recallPromoteTracker,
    scheduleInputPinnedRefresh: (refresh) =>
      turnRuntime.scheduleInputPinnedRefresh(refresh),
  }),

  ...createChatContinuationStoreActions({
    set,
    get,
    captureAuthority: captureChatComposerAuthority,
    awaitWritableAuthority: awaitWritableChatComposerAuthority,
  }),

  ...createChatUserQuestionStoreActions({
    set,
    get,
    runtime: userQuestionRuntime,
    abortTurn: () => {
      turnRuntime.coordinator.abort();
    },
  }),

  setChatScope: (scope, anchorId) => {
    const current = get();
    if (current.isStreaming) current.stopGeneration();
    // scope === "folder" / "codex" / "snippet" のとき anchorId 必須。空指定なら scene に fallback。
    // includeBodies は scope ごとのデフォルトに揃え直す: scene=true, それ以外=false。
    // project では本文集約しないので値自体は影響しないが false に揃える。
    // スコープ切替で非永続のスレッド focus はクリア（別スコープへ leak させない）。
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
      resetRecallPromote(recallPromoteTracker);
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
  setIncludeBodies: (on: boolean) => set({ includeBodies: on }),
  setIncludeMapBoard: (on, options) => {
    // 現状 source は telemetry / 将来拡張用。動作上は user/auto 共通で
    // includeMapBoard と mapBoardId を更新するだけ（panel/board 変更で
    // 再同期される設計のため、override セマンティクスは持たない）。
    const next: Partial<ChatState> = { includeMapBoard: on };
    if (options?.boardId !== undefined) {
      next.mapBoardId = options.boardId;
    } else if (!on) {
      // OFF 時は board 参照もクリアして stale な id を残さない
      next.mapBoardId = null;
    }
    set(next);
  },

  clearMessages: () => {
    if (get().isStreaming) return;
    set({ messages: [], agentContinuation: null });
  },
  clearError: () => set({ error: null }),
  dismissChatRecallPromote: (messageId: string) => {
    dismissRecallPromote(recallPromoteTracker, messageId);
    if (get().chatRecallPromoteSuggestion?.messageId === messageId) {
      set({ chatRecallPromoteSuggestion: null });
    }
  },
  setActiveSceneId: (id: string) => {
    markStart("chatStore.setActiveSceneId");
    try {
      const { activeSceneId, activeSessionId, chatScope, sessions } = get();
      const activeSession = sessions.find(
        (session) => session.id === activeSessionId,
      );
      const activeSessionTargetsScene =
        !activeSession ||
        (activeSession.nodeId === id &&
          !activeSession.codexAnchorId &&
          !activeSession.snippetAnchorId);
      // tree の active scene が変わったときは activeSceneId を更新。
      // scope === "scene" のときは anchor が active scene を追従するため、
      // セッション一覧を含む scene-scoped state と遅延読込をリセット。
      // scope === "folder" / "project" のときは scope axis が sticky で、
      // anchor は user 選択を維持する（=セッションも維持）。
      const resetSceneScope =
        chatScope === "scene" &&
        (id !== activeSceneId || !activeSessionTargetsScene);
      if (resetSceneScope) {
        invalidateSessionScopeAuthority();
        if (get().isStreaming) get().stopGeneration();
        get()._cancelPendingUserQuestion();
        resetRecallPromote(recallPromoteTracker);
        set({
          ...clearedSessionScopeState(),
          scopeAnchor: null,
          activeSceneId: id,
        });
      } else {
        set({ activeSceneId: id });
      }
    } finally {
      markEnd("chatStore.setActiveSceneId");
    }
  },
  setActiveProjectId: (id: string | null) => {
    const current = get();
    if (current.activeProjectId !== id) {
      if (current.isStreaming) current.stopGeneration();
      invalidateSessionScopeAuthority();
      get()._cancelPendingUserQuestion();
      resetRecallPromote(recallPromoteTracker);
      set({
        ...clearedSessionScopeState(),
        scopeAnchor: null,
        activeProjectId: id,
      });
      return;
    }
    set({ activeProjectId: id });
  },
}));

// Snippet 削除 → snippet スコープを scene へ戻す。snippetStore からの直接 import は
// module graph 汚染になるため leaf DI (anchorNotify) 経由で受ける。
setSnippetDeletedHandler((id) =>
  useChatStore.getState().onSnippetAnchorDeleted(id),
);
