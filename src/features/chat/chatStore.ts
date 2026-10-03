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
  createChatScopeStoreActions,
  createChatSessionStoreActions,
  createConfiguredChatTurnStoreActions,
  createChatTurnPreflight,
  createChatTurnRuntime,
  createChatUserQuestionRuntime,
  createChatUserQuestionStoreActions,
  installChatNavigationBlockers,
  type ChatComposerAuthority,
} from "@/application/chat/chatStoreActions";
export { contextPromptKey };
import {
  getSessionMutationTail,
  hasPendingSessionMutations,
  isCapturedWorkspaceCurrent,
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
import { archiveCodexSessionThread } from "./lazyRuntimeApi";

import { getCurrentProjectId } from "@/application/project/currentProjectAuthority";
import { readRuntimeSetting } from "@/features/settings/runtimeSettings";
import { setSnippetDeletedHandler } from "@/features/snippets/anchorNotify";

const turnRuntime = createChatTurnRuntime({ registerQuiescence: true });
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

export function __discardPendingCompletedChatTurnsForTests(): void {
  turnRuntime.discardPendingCompletedTurns();
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

  ...createChatScopeStoreActions({
    set,
    get,
    runtime: {
      hasPendingCompletedTurnPersistence: () =>
        turnRuntime.hasPendingCompletedTurnPersistence(),
      isActiveAnchoredChatStream: () => {
        const turn = turnRuntime.coordinator.current();
        const current = get();
        return Boolean(
          turn?.surface === "chat" &&
          turn.phase === "streaming" &&
          turn.transportStarted &&
          turn.transport === "http" &&
          (turn.request.scope === "folder" ||
            turn.request.scope === "codex" ||
            turn.request.scope === "snippet") &&
          turn.request.scope === current.chatScope &&
          turn.request.scopeAnchorId === current.scopeAnchorId,
        );
      },
      notifyPendingCompletedTurnPersistence: () =>
        toast.error(i18next.t("chat.pendingCompletedTurnPersistence")),

      resetRecallPromote: () => resetRecallPromote(recallPromoteTracker),
    },
  }),

  invalidateContextCache: (reason) => {
    set({ cacheInvalidatedReason: reason });
  },

  dismissCacheInvalidated: () => {
    set({ cacheInvalidatedReason: null });
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
      archiveSessionThread: (input) => archiveCodexSessionThread(input),
      clearProjectChatHistory: (projectId) =>
        chatApi.clearProjectChatHistory(projectId),
    },
    runtime: {
      snapshotAgentTools,
      resetRecallPromote: () => resetRecallPromote(recallPromoteTracker),
      hasPendingCompletedTurnPersistence: () =>
        turnRuntime.hasPendingCompletedTurnPersistence(),
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
      hasPendingCompletedTurnPersistence: () =>
        turnRuntime.hasPendingCompletedTurnPersistence(),
      hasPendingCompletedTurnPersistenceForMessage: (messageId) =>
        turnRuntime.hasPendingCompletedTurnPersistence({
          kind: "message-id",
          messageId,
        }),
      notifyPendingCompletedTurnPersistence: () =>
        toast.error(i18next.t("chat.pendingCompletedTurnPersistence")),
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

  clearError: () => set({ error: null }),
  dismissChatRecallPromote: (messageId: string) => {
    dismissRecallPromote(recallPromoteTracker, messageId);
    if (get().chatRecallPromoteSuggestion?.messageId === messageId) {
      set({ chatRecallPromoteSuggestion: null });
    }
  },
}));

installChatNavigationBlockers({
  getState: useChatStore.getState,
  hasPendingPersistence: turnRuntime.hasPendingCompletedTurnPersistence,
  activeTurnSurface: () => turnRuntime.coordinator.current()?.surface ?? null,
});

// Snippet 削除 → snippet スコープを scene へ戻す。snippetStore からの直接 import は
// module graph 汚染になるため leaf DI (anchorNotify) 経由で受ける。
setSnippetDeletedHandler((id) =>
  useChatStore.getState().onSnippetAnchorDeleted(id),
);
