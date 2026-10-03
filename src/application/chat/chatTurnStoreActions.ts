import { toast } from "sonner";
import i18next from "@/lib/i18n";
import {
  blockIfPolicyOff,
  isAiFeatureBlockedByPolicy,
} from "@/features/ai-policy/policyGuard";
import {
  blockIfUnlicensed,
  isWriteRestrictedByLicense,
} from "@/features/license/gate";
import * as chatApi from "@/features/chat/chatApi";
import {
  resolveModelForPath,
  resolveRolePathConfig,
} from "@/features/chat/modelRouting";
import { debugLog, errorDetail } from "@/lib/debugLog";
import {
  captureAgentPreflightAuthority,
  getChatApiVariant,
  isSameAgentPreflightAuthority,
  resolveCurrentChatTurnPolicy,
} from "./chatTurnRouting";
import {
  TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
  finalizeChatTurnPayload,
  flattenMessagesForCli,
  materializeSystemDeliverySnapshot,
  snapshotInputTokenRoute,
} from "./chatTurnPayload";
import { maybeRunSummarization } from "./chatSummarization";
import {
  isCapturedProjectCurrent,
  isCapturedWorkspaceCurrent,
} from "./chatSessionAuthority";
import {
  ChatTurnPersistenceError,
  MAX_RATE_LIMIT_RETRIES,
  classifyError,
  createRetryableCompletedTurnPersistence,
  createSessionForCurrentRuntime,
  fetchRequiredProjectContext,
} from "./chatStoreSupport";
import {
  countTokens,
  allocateLayerBudgets,
  ensureTokenizer,
  getTokenEstimatorFamily,
} from "@/features/chat/contextBuilder";
import type { LayerBreakdown } from "@/features/chat/contextBuilder";
import { runAgentLoop } from "@/features/chat/agent/agentLoop";
import {
  executeTool,
  executeReadOnlyTool,
} from "@/features/chat/agent/toolExecutors";
import {
  getResearchSubagentTools,
  RESEARCH_SUBAGENT_TOOL,
} from "@/features/chat/agent/toolDefinitions";
import {
  invalidAskUserResult,
  normalizeAskUserSpec,
} from "@/features/chat/agent/askUser";
import {
  getToolTokenBudgetForContext,
  getAgentToolCallBudgetForContext,
  buildThinkingParams,
  getEffortForTask,
  resolveModelCapabilities,
} from "@/features/chat/agent/modelLimits";
import { useAiSettingsStore } from "@/features/chat/store";
import { finalizeTurnPayload } from "@/features/ai-context/finalizeTurnPayload";
import {
  contextWindowUsageFromError,
  contextWindowUsageFromTurnPayloadUsage,
} from "@/features/ai-context/contextWindowUsage";
import {
  resolvedChatTurnRouteAuthorityKey,
  createTurnControl,
  createTurnRequest,
} from "@/features/chat/turn/resolveTurnRoute";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import {
  accumulateInputTokenDrift,
  buildInputTokenDriftMetadata,
  createInputTokenDriftTotals,
} from "@/features/ai-usage/inputTokenDrift";
import {
  sanitizeCitations,
  findUnbackedUrls,
} from "@/features/chat/citationVerify";
import { stripToolProtocol } from "@/features/chat/toolProtocol";
import {
  buildCodexBootstrapHistory,
  computeChatHistoryRevision,
} from "@/features/chat/historyRevision";
import { createAgentTextBatcher } from "@/features/chat/agent/agentTextBatcher";
import type {
  AgentMessagePayload,
  ToolCallRecord,
} from "@/features/chat/agent/agentTypes";
import {
  getCurrentProjectId,
  getLoadedProjectId,
} from "@/application/project/currentProjectAuthority";
import { getTreeProjectId } from "@/features/tree/treeProjection";
import type { ChatMessage } from "@/features/chat/chatTypes";
import type { StreamCallbacks } from "@/features/chat/chatApi";
import type {
  CodexAppItem,
  CodexAppStreamCallbacks,
} from "@/features/chat/codexAppApi";
import { resolveScopeSessionKey } from "@/features/chat/chatScope";
import { getPromptCatalog } from "@/prompts/index";
import type { ChatStoreActionPorts } from "./chatStoreActionPorts";
import type { ChatState } from "./chatStoreTypes";
import type {
  ChatTurnPreflightDecision,
  ChatTurnPreflightInput,
} from "./chatTurnPreflight";
import type { ChatTurnRuntime } from "./chatTurnRuntime";
import type { ChatUserQuestionRuntime } from "./chatUserQuestionRuntime";
import { advanceActiveLifecycleTransition } from "@/application/lifecycle/lifecycleTrace";
import { canScheduleQuiescenceMutation } from "@/application/lifecycle/quiescenceLease";
import { reserveChatMessageAdds } from "@/features/timelapse/captureChat";
import { cliApi, codexAppApi } from "@/features/chat/lazyRuntimeApi";
import {
  createChatTurnLifecycle,
  withChatTurnAdmission,
} from "./chatTurnLifecycle";
import type { CaptureCurrentChatInputSubmission } from "@/lib/tauri";

interface ChatTurnStoreActionCompositionPorts extends ChatStoreActionPorts {
  prepareChatTurn: (input: ChatTurnPreflightInput) => ChatTurnPreflightDecision;
  turnRuntime: ChatTurnRuntime;
  userQuestionRuntime: ChatUserQuestionRuntime;
}

interface ChatTurnStoreActionDependencies {
  chatApi: typeof chatApi;
  cliApi: typeof cliApi;
  codexAppApi: typeof codexAppApi;
  useAiSettingsStore: typeof useAiSettingsStore;
  executeTool: typeof executeTool;
  executeReadOnlyTool: typeof executeReadOnlyTool;
  recordAiUsage: typeof recordAiUsage;
  getTreeProjectId: typeof getTreeProjectId;
  getLoadedProjectId: typeof getLoadedProjectId;
  getCurrentProjectId: typeof getCurrentProjectId;
  isCapturedWorkspaceCurrent: typeof isCapturedWorkspaceCurrent;
  captureAgentPreflightAuthority: typeof captureAgentPreflightAuthority;
  isSameAgentPreflightAuthority: typeof isSameAgentPreflightAuthority;
  resolveCurrentChatTurnPolicy: typeof resolveCurrentChatTurnPolicy;
  blockIfPolicyOff: typeof blockIfPolicyOff;
  isAiFeatureBlockedByPolicy: typeof isAiFeatureBlockedByPolicy;
  blockIfUnlicensed: typeof blockIfUnlicensed;
  isWriteRestrictedByLicense: typeof isWriteRestrictedByLicense;
  createSessionForCurrentRuntime: typeof createSessionForCurrentRuntime;
  fetchRequiredProjectContext: typeof fetchRequiredProjectContext;
  resolveModelForPath: typeof resolveModelForPath;
  resolveRolePathConfig: typeof resolveRolePathConfig;
  getChatApiVariant: typeof getChatApiVariant;
  getPromptCatalog: typeof getPromptCatalog;
  debugLog: typeof debugLog;
  errorDetail: typeof errorDetail;
  toast: typeof toast;
  i18next: typeof i18next;
}

function createChatTurnStoreActions(
  ports: ChatTurnStoreActionCompositionPorts & ChatTurnStoreActionDependencies,
): Pick<ChatState, "sendMessage" | "stopGeneration"> {
  const {
    set,
    get,
    prepareChatTurn,
    turnRuntime,
    userQuestionRuntime,
    chatApi,
    cliApi,
    codexAppApi,
    useAiSettingsStore,
    executeTool,
    executeReadOnlyTool,
    recordAiUsage,
    getCurrentProjectId,
    isCapturedWorkspaceCurrent,
    captureAgentPreflightAuthority,
    isSameAgentPreflightAuthority,
    resolveCurrentChatTurnPolicy,
    blockIfPolicyOff,
    isAiFeatureBlockedByPolicy,
    blockIfUnlicensed,
    isWriteRestrictedByLicense,
    createSessionForCurrentRuntime,
    fetchRequiredProjectContext,
    resolveModelForPath,
    resolveRolePathConfig,
    getChatApiVariant,
    getPromptCatalog,
    debugLog,
    errorDetail,
    toast,
    i18next,
  } = ports;
  const turnLifecycle = createChatTurnLifecycle({
    set,
    get,
    turnRuntime,
    isCapturedWorkspaceCurrent,
    getCurrentProjectId,
    codexAppApi,
    debugLog,
    errorDetail,
  });

  return {
    sendMessage: async (
      content: string,
      commandInstruction?: string,
      options?: {
        overrideAgentMode?: boolean;
        mentionedSceneIds?: string[];
        mentionedCodexIds?: string[];
        /** Regeneration-only: hide this answer from turn history, then delete it
         * only after the replacement assistant has been persisted. */
        _replaceAssistantMessageId?: string;
        /** 429 リトライの内部カウンタ（外部呼び出しでは指定しない）。 */
        _rateLimitRetry?: number;
        /** Internal UI handshake fired after owned placeholders are published. */
        _onAccepted?: () => void;
      },
    ) => {
      if (!content.trim()) return;
      const sendStopGeneration = turnLifecycle.stopGenerationVersion();
      const turnCoordinator = turnRuntime.coordinator;
      const pendingCaptureWork = turnLifecycle.beforeSend(sendStopGeneration);
      if (
        pendingCaptureWork instanceof Promise
          ? !(await pendingCaptureWork)
          : !pendingCaptureWork
      ) {
        return;
      }
      const preflightDecision = prepareChatTurn({
        content,
        commandInstruction,
        options,
      });
      const preflight =
        preflightDecision instanceof Promise
          ? await preflightDecision
          : preflightDecision;
      if (
        !turnLifecycle.isStopGenerationCurrent(sendStopGeneration) ||
        !preflight
      )
        return;
      const {
        turnWorkspaceIdentity,
        activeSceneId,
        activeSessionId,
        chatScope,
        scopeAnchorId,
        threadFocusOverride,
        capturedRagEnabled,
        capturedMessages,
        initialMessages,
        replacementAssistantMessageId,
        preflightAuthority,
        agentModeForThisSend,
        turnAgentToolsSnapshot,
        effectiveSceneId,
        turnRoute,
        ragActive,
        useAgentPath,
        publicWebSearchPath,
        turnRouteAuthorityKey,
        webSearchConfigAtTurnStart,
        contextInputOverheadTokens,
        turnProjectId,
        preparationSeed,
        preparationSnapshot,
        sessionId,
        userMsg,
        assistantMsg,
        aiSettingsEarly,
        chatModelEarly,
        xprov,
      } = preflight;
      const finalizeStreamingDraft =
        turnLifecycle.createStreamingDraftFinalizer(assistantMsg.id);
      const turnRequest = createTurnRequest({
        requestId: crypto.randomUUID(),
        workspace: turnWorkspaceIdentity,
        projectId: turnProjectId,
        sceneId: effectiveSceneId,
        sessionId: activeSessionId,
        scope: chatScope,
        scopeAnchorId,
        routeAuthorityKey: turnRouteAuthorityKey,
      });
      const sendTurnId = turnRequest.requestId;
      const persistCompletedTurn = async (input: {
        retry: () => Promise<void>;
        sessionId: string;
        userMetadata?: string;
        assistantMessage?: ChatMessage;
      }): Promise<void> => {
        await turnRuntime.persistCompletedTurn({
          turnId: sendTurnId,
          workspaceIdentity: turnWorkspaceIdentity,
          projectId: turnProjectId,
          sessionId: input.sessionId,
          userMessage: {
            ...userMsg,
            sessionId: input.sessionId,
            content,
            ...(input.userMetadata ? { metadata: input.userMetadata } : {}),
          },
          ...(input.assistantMessage
            ? {
                assistantMessage: {
                  ...input.assistantMessage,
                  sessionId: input.sessionId,
                },
              }
            : {}),
          onRegister: () => {
            const reservation = reserveChatMessageAdds([
              {
                projectId: turnProjectId,
                sessionId: input.sessionId,
                messageId: userMsg.id,
                role: "user",
                text: content,
                createdAt: userMsg.createdAt,
              },
              ...(input.assistantMessage
                ? [
                    {
                      projectId: turnProjectId,
                      sessionId: input.sessionId,
                      messageId: input.assistantMessage.id,
                      role: input.assistantMessage.role,
                      text: input.assistantMessage.content,
                      model: input.assistantMessage.model,
                      createdAt: input.assistantMessage.createdAt,
                    },
                  ]
                : []),
            ]);
            return {
              onPersisted: reservation.commit,
              onDiscarded: reservation.discard,
            };
          },
          retry: async () => {
            // A completed turn can predate a later retrying lifecycle. Emit
            // both durability boundaries in whichever transition drains the
            // retained old-scope payload.
            advanceActiveLifecycleTransition("old-stream-completed");
            try {
              await input.retry();
            } catch (error) {
              throw error instanceof ChatTurnPersistenceError
                ? error
                : new ChatTurnPersistenceError(error);
            }
            advanceActiveLifecycleTransition("old-scope-persisted");
          },
        });
      };
      const sendControl = createTurnControl({
        request: turnRequest,
        surface: useAgentPath ? "agent" : "chat",
        userMessageId: userMsg.id,
        assistantMessageId: assistantMsg.id,
        transport:
          turnRoute?.transport ??
          (turnRoute?.provider === "cli" ? "cli-exec" : "http"),
      });
      if (!turnCoordinator.claim(sendControl)) return;
      // A turn that starts without a persisted session is allowed to adopt the
      // session it creates below. Any other session transition invalidates it.
      let turnSessionId = activeSessionId;
      let transportStarted = false;
      const captureTurn = turnLifecycle.createTurn(sendControl, turnRoute);
      turnRuntime.setStoppedStreamFinalizer(null);
      const isCurrentTurn = (): boolean =>
        turnCoordinator.isCurrent(sendControl);
      // A stale async result can retain one project ID after another source
      // has switched; compare all injected project projections each time.
      const capturedProjectIsCurrent = (): boolean =>
        isCapturedProjectCurrent(turnProjectId, ports);
      const capturedWorkspaceIsCurrent = (): boolean =>
        isCapturedWorkspaceCurrent(turnWorkspaceIdentity);
      const capturedChatAuthorityIsCurrent = (): boolean => {
        const current = get();
        const currentProjectId =
          current.activeProjectId ?? getCurrentProjectId();
        const sameThreadFocus =
          current.threadFocusOverride?.threadId ===
          threadFocusOverride?.threadId;
        const sameTemporalAnchor =
          effectiveSceneId !== null
            ? turnSessionId !== null || current.activeSceneId === activeSceneId
            : current.activeSceneId === activeSceneId;
        return (
          currentProjectId === turnProjectId &&
          current.activeSessionId === turnSessionId &&
          current.chatScope === chatScope &&
          current.scopeAnchorId === scopeAnchorId &&
          sameThreadFocus &&
          sameTemporalAnchor &&
          isSameAgentPreflightAuthority(
            preflightAuthority,
            captureAgentPreflightAuthority(),
          ) &&
          resolvedChatTurnRouteAuthorityKey(
            resolveCurrentChatTurnPolicy({
              agentMode: agentModeForThisSend,
              ragEnabled: capturedRagEnabled,
            }).route,
          ) === turnRouteAuthorityKey
        );
      };
      const capturedTurnAuthorityIsCurrent = (): boolean => {
        return (
          capturedWorkspaceIsCurrent() &&
          capturedProjectIsCurrent() &&
          capturedChatAuthorityIsCurrent()
        );
      };
      let replacementCommitted = false;
      const commitAssistantReplacement = async (): Promise<void> => {
        if (
          !replacementAssistantMessageId ||
          replacementCommitted ||
          !capturedTurnAuthorityIsCurrent()
        ) {
          return;
        }
        try {
          await chatApi.deleteMessage(replacementAssistantMessageId);
          replacementCommitted = true;
          if (capturedTurnAuthorityIsCurrent()) {
            set((state) => ({
              messages: state.messages.filter(
                (message) => message.id !== replacementAssistantMessageId,
              ),
            }));
          }
        } catch (error) {
          debugLog.error(
            "ChatStore",
            "regenerate replacement cleanup",
            errorDetail(error),
          );
          if (capturedTurnAuthorityIsCurrent()) {
            toast.error(i18next.t("chat.deleteMessageFailed"));
          }
        }
      };
      const shouldAbortTurn = (): boolean =>
        sendControl.aborted ||
        !isCurrentTurn() ||
        (!transportStarted && !canScheduleQuiescenceMutation()) ||
        !capturedWorkspaceIsCurrent() ||
        !capturedProjectIsCurrent() ||
        !capturedChatAuthorityIsCurrent() ||
        isAiFeatureBlockedByPolicy("chat") ||
        isWriteRestrictedByLicense();
      const assertTurnAuthority = (): void => {
        if (shouldAbortTurn()) {
          // Emit the specific user-facing reason once at the transport boundary.
          blockIfPolicyOff("chat");
          blockIfUnlicensed();
          sendControl.aborted = true;
          throw new Error("chat turn authority changed");
        }
      };
      const removeOwnedTurnMessages = (): void => {
        const currentState = get();
        const keepCapturedHuman =
          captureTurn.committed &&
          capturedWorkspaceIsCurrent() &&
          capturedProjectIsCurrent() &&
          currentState.activeSessionId ===
            captureTurn.submission?.chatSessionId &&
          currentState.chatScope === chatScope &&
          currentState.scopeAnchorId === scopeAnchorId &&
          currentState.activeSceneId === activeSceneId;
        set((state) => {
          const messages = state.messages.filter(
            (message) =>
              message.id !== assistantMsg.id &&
              (keepCapturedHuman || message.id !== userMsg.id),
          );
          if (
            keepCapturedHuman &&
            !messages.some((message) => message.id === userMsg.id)
          ) {
            messages.push(userMsg);
          }
          return {
            messages,
            streamingDraft:
              state.streamingDraft?.messageId === assistantMsg.id
                ? null
                : state.streamingDraft,
          };
        });
      };
      const cancelBeforeTransport = (): boolean => {
        if (!shouldAbortTurn()) return false;
        const ownedInvalidTurn = isCurrentTurn();
        if (ownedInvalidTurn) {
          turnCoordinator.abort(sendControl);
          if (!sendControl.preTransportAdmissionPending) {
            turnCoordinator.release(sendControl);
          }
        }
        removeOwnedTurnMessages();
        if (ownedInvalidTurn) set({ isStreaming: false });
        turnRuntime.clearActiveRouteIf(turnRoute);
        return true;
      };
      const failBeforeTransport = (error: unknown): void => {
        if (shouldAbortTurn()) {
          cancelBeforeTransport();
          return;
        }
        sendControl.aborted = true;
        removeOwnedTurnMessages();
        set({
          isStreaming: false,
          error: error instanceof Error ? error.message : String(error),
        });
        turnRuntime.clearActiveRouteIf(turnRoute);
        turnCoordinator.release(sendControl, "failed");
      };
      const preserveFailedCaptureCancellation = (error: unknown): void =>
        captureTurn.preserveFailedCancellation(error, removeOwnedTurnMessages);
      const prevMessages = initialMessages;
      const visiblePrevMessages = capturedMessages;
      // Guard concurrent sends before tokenizer initialization yields control.
      set({
        messages: [...visiblePrevMessages, userMsg, assistantMsg],
        streamingDraft: useAgentPath
          ? null
          : { messageId: assistantMsg.id, content: "" },
        isStreaming: true,
        error: null,
      });
      // Route + every mutable context input are fixed before this first await.
      try {
        await ensureTokenizer();
      } catch (error) {
        if (isCurrentTurn()) {
          set({
            messages: visiblePrevMessages,
            streamingDraft: null,
            isStreaming: false,
            error: error instanceof Error ? error.message : String(error),
          });
          turnCoordinator.release(sendControl, "failed");
        } else {
          cancelBeforeTransport();
        }
        return;
      }
      if (cancelBeforeTransport()) return;
      turnRuntime.setActiveRoute(turnRoute);

      // Capture an owned scene Human before any protected-session read.
      const captureRouteEligible = turnLifecycle.captureRouteIsEligible({
        turnRoute,
        aiSettingsEarly,
        chatScope,
        effectiveSceneId,
        activeSceneId,
        scopeAnchorId,
        threadFocusOverride,
        useAgentPath,
        capturedRagEnabled,
        ragActive,
        publicWebSearchPath,
        commandInstruction,
        options,
      });
      const captureEligible = captureRouteEligible && Boolean(activeSessionId);
      if (captureEligible) {
        const submission: CaptureCurrentChatInputSubmission = {
          submissionId: sendTurnId,
          messageId: userMsg.id,
          chatSessionId: activeSessionId!,
          sceneId: effectiveSceneId!,
          content: userMsg.content,
          createdAt: userMsg.createdAt,
        };
        const mayContinue = await captureTurn.capture(
          submission,
          turnProjectId,
          {
            cancelBeforeTransport,
            failBeforeTransport,
            preserveFailedCaptureCancellation,
            onAccepted: options?._onAccepted,
          },
        );
        if (!mayContinue) return;
      }

      // Validate persisted ownership before reading session-scoped pins or summaries.
      if (turnSessionId) {
        try {
          const persistedSession = await chatApi.getSessionForProject(
            turnSessionId,
            turnProjectId,
          );
          if (!persistedSession) {
            throw new Error("chat session project mismatch");
          }
        } catch (error) {
          failBeforeTransport(error);
          return;
        }
        if (cancelBeforeTransport()) return;
      }

      // -----------------------------------------------------------------------
      // セッションが未作成の場合は自動作成 (P0-2)
      // -----------------------------------------------------------------------
      let sessionIdForPersist = activeSessionId;
      if (!sessionIdForPersist) {
        const { nodeId, codexAnchorId, snippetAnchorId } =
          resolveScopeSessionKey(chatScope, effectiveSceneId, scopeAnchorId);
        try {
          const session = await createSessionForCurrentRuntime(
            turnProjectId,
            "New session",
            nodeId === null ? undefined : nodeId,
            codexAnchorId,
            snippetAnchorId,
          );
          if (cancelBeforeTransport()) return;
          if (session.projectId !== turnProjectId) {
            throw new Error("chat session project mismatch");
          }
          sessionIdForPersist = session.id;
          turnSessionId = session.id;
          sendControl.sessionId = session.id;
          set((state) => ({
            sessions: [session, ...state.sessions],
            activeSessionId: session.id,
            messages: state.messages.map((m) => ({
              ...m,
              sessionId: session.id,
            })),
          }));
        } catch (e) {
          debugLog.error("ChatStore", "auto-create session", errorDetail(e));
          failBeforeTransport(e);
          return;
        }
      }
      if (cancelBeforeTransport()) return;
      // -----------------------------------------------------------------------
      // Agent mode path — tool-use loop
      //
      // 通常モードと同じ application preparation port 経由で
      // L1〜L4（自動検出 Codex の summary + Spotlight された Codex/Snippet の content）
      // を注入する。Agent はその上で必要に応じて search_codex / get_codex_entry を
      // 叩いて未注入エントリの探索や詳細深掘りを行う、という階層的アクセス前提。
      // -----------------------------------------------------------------------
      if (useAgentPath) {
        let systemPromptForAgent = "";
        let sentSystemPromptForAgent = "";
        let sentAgentContextLayers: LayerBreakdown[] = [];
        let sentAgentContextTokenCount: number | null = null;
        let currentAgentModel = "";
        const canFinalizeStoppedAgentTurn = (): boolean =>
          sendControl.aborted && isCurrentTurn() && transportStarted;
        const finalizeStoppedAgentTurnAfterTransport =
          async (): Promise<boolean> => {
            if (!canFinalizeStoppedAgentTurn()) return false;

            const assistant = get().messages.find(
              (message) => message.id === assistantMsg.id,
            );
            let metadata: Record<string, unknown> = {};
            if (assistant?.metadata) {
              try {
                const parsed = JSON.parse(assistant.metadata);
                if (
                  parsed &&
                  typeof parsed === "object" &&
                  !Array.isArray(parsed)
                ) {
                  metadata = parsed as Record<string, unknown>;
                }
              } catch {
                metadata = {};
              }
            }
            const stoppedMetadata = JSON.stringify({
              ...metadata,
              stopped: true,
            });
            set((s) => ({
              messages: s.messages.map((message) =>
                message.id === assistantMsg.id
                  ? { ...message, metadata: stoppedMetadata }
                  : message,
              ),
            }));

            const userMetadata =
              options?.mentionedSceneIds && options.mentionedSceneIds.length > 0
                ? JSON.stringify({
                    mentioned_scene_ids: options.mentionedSceneIds,
                  })
                : undefined;
            const promptSnapshot =
              sentSystemPromptForAgent || systemPromptForAgent;
            const latestAssistant = get().messages.find(
              (message) => message.id === assistantMsg.id,
            );
            const recoverableStoppedAssistant =
              latestAssistant?.role === "assistant" &&
              latestAssistant.content &&
              sessionIdForPersist
                ? {
                    ...latestAssistant,
                    sessionId: sessionIdForPersist,
                    model: currentAgentModel || null,
                    metadata: stoppedMetadata,
                  }
                : undefined;
            turnCoordinator.transition(sendControl, "persisting");
            const persistStoppedAgentTurn =
              createRetryableCompletedTurnPersistence({
                persistUser: async () => {
                  if (!sessionIdForPersist) return;
                  await chatApi.addMessage(
                    sessionIdForPersist,
                    "user",
                    content,
                    {
                      id: userMsg.id,
                      createdAt: userMsg.createdAt,
                      recordTimelapse: false,
                      ...(userMetadata ? { metadata: userMetadata } : {}),
                    },
                  );
                  if (promptSnapshot) {
                    void chatApi
                      .saveMessagePrompt(userMsg.id, {
                        systemPrompt: promptSnapshot,
                        layers: sentAgentContextLayers,
                        totalTokens: sentAgentContextTokenCount,
                        model: currentAgentModel || null,
                        provider: turnRoute?.provider ?? null,
                        contextWindow: turnRoute?.contextWindow ?? null,
                      })
                      .catch((error) =>
                        debugLog.warn(
                          "ChatStore",
                          "saveMessagePrompt",
                          errorDetail(error),
                        ),
                      );
                  }
                },
                ...(sessionIdForPersist &&
                latestAssistant?.role === "assistant" &&
                latestAssistant.content
                  ? {
                      persistAssistant: async () => {
                        await chatApi.addMessage(
                          sessionIdForPersist,
                          "assistant",
                          latestAssistant.content,
                          {
                            id: assistantMsg.id,
                            model: currentAgentModel || undefined,
                            metadata: stoppedMetadata,
                            createdAt: assistantMsg.createdAt,
                            recordTimelapse: false,
                          },
                        );
                        await commitAssistantReplacement();
                      },
                    }
                  : {}),
              });
            try {
              await persistCompletedTurn({
                retry: persistStoppedAgentTurn,
                sessionId: sessionIdForPersist,
                ...(userMetadata ? { userMetadata } : {}),
                ...(recoverableStoppedAssistant
                  ? { assistantMessage: recoverableStoppedAssistant }
                  : {}),
              });
            } catch (error) {
              debugLog.warn(
                "ChatStore",
                "persist stopped agent turn",
                errorDetail(error),
              );
              throw error;
            }
            return true;
          };
        try {
          const projectCtx = await fetchRequiredProjectContext(turnProjectId);
          if (cancelBeforeTransport()) return;

          const projectCtxLang = projectCtx?.language ?? "ja";
          let agentMessages = publicWebSearchPath ? [] : prevMessages;
          if (sessionIdForPersist && !publicWebSearchPath) {
            const agentApiVariant = turnRoute
              ? turnRoute.apiVariant
              : xprov
                ? xprov.variant
                : getChatApiVariant(chatModelEarly);
            const fallbackCaps = resolveModelCapabilities(
              chatModelEarly,
              aiSettingsEarly,
              agentApiVariant,
            );
            const contextWindow =
              turnRoute?.contextWindow ?? fallbackCaps.contextWindow;
            const maxOutputTokens =
              turnRoute?.capabilities.maxOutputTokens ??
              fallbackCaps.maxOutputTokens;
            const budgets = allocateLayerBudgets(contextWindow, {
              maxOutputTokens,
              responseReservationTokens:
                turnRoute?.outputBudget.responseReservationTokens,
            });
            agentMessages = await maybeRunSummarization(
              sessionIdForPersist,
              turnProjectId,
              sendTurnId,
              prevMessages,
              budgets.l5,
              projectCtxLang,
              set,
              () => !shouldAbortTurn(),
            );
            if (cancelBeforeTransport()) return;
          }
          const summarizedAgentHistory = agentMessages.filter(
            (message) =>
              message.id !== userMsg.id &&
              message.id !== assistantMsg.id &&
              !message.isSummarized,
          );

          const agentMsgs: AgentMessagePayload[] = [];
          let fullyInjectedIds: Set<string> = new Set();
          const prepared = await get().refreshContextLayers({
            purpose: "send",
            conversationMessages: [...summarizedAgentHistory, userMsg],
            outgoingUserMessage: content,
            commandInstruction,
            mentionedSceneIds: options?.mentionedSceneIds,
            mentionedCodexIds: options?.mentionedCodexIds,
            agentModeOverride: useAgentPath,
            turnRoute: turnRoute ?? undefined,
            privacy: publicWebSearchPath ? "public-web" : "private",
            ragActiveOverride: ragActive,
            inputOverheadTokens: contextInputOverheadTokens,
            preparationSeed,
            preparationSnapshot,
            trackRecallPromote: true,
            isAuthorized: () => !shouldAbortTurn(),
            strict: true,
          });
          if (cancelBeforeTransport()) return;
          systemPromptForAgent = prepared?.prompt ?? "";
          const systemCacheSegmentsForAgent = prepared?.cacheSegments;
          const systemVolatileTailForAgent = prepared?.volatileTail;
          sentAgentContextLayers = (prepared?.layers ?? []).map((layer) => ({
            ...layer,
          }));
          sentAgentContextTokenCount = prepared?.totalTokens ?? null;
          fullyInjectedIds = new Set(prepared?.fullyInjectedIds ?? []);

          if (systemPromptForAgent) {
            agentMsgs.push({ role: "system", content: systemPromptForAgent });
          }

          // Convert conversation history
          for (const msg of summarizedAgentHistory) {
            if (msg.role === "system") continue;
            if (msg.role === "user") {
              agentMsgs.push({ role: "user", content: msg.content });
            } else if (msg.role === "assistant") {
              // 過去ターンの assistant 本文に擬似ツール記法が混入していると、
              // モデルがそれを few-shot として模倣し続ける。履歴を戻す前に除去。
              agentMsgs.push({
                role: "assistant",
                content: stripToolProtocol(msg.content),
              });
            }
          }
          agentMsgs.push({ role: "user", content });

          // Token budget + thinking params
          const aiSettings = useAiSettingsStore.getState().settings;
          // チャットパネルで一時選択したモデル(あれば)。role 未設定時に既定より優先する。
          const chatModelOverride =
            useAiSettingsStore.getState().chatModelOverride;
          // agent ロールの override を実モデルとして解決し、API variant / トークン予算 /
          // thinking パラメータ / usage 記録を全て実モデルから導出する。これにより
          // send_agent_message に渡す override（resolveModelForPath / 一時モデル）と
          // thinking 等が一致する（未設定なら既定モデル = byte-identical）。
          // agent ロールの横断割り当て（別プロバイダ/別エンドポイント）。chat_agent_main /
          // agent_research_subagent は同一 "agent" ロールなので、ここで解決した
          // provider/endpoint/variant をサブエージェント送信にも流用する。
          const agentRole = resolveRolePathConfig(
            "chat_agent_main",
            undefined,
            aiSettings?.provider,
          );
          const currentModel =
            turnRoute?.model ??
            (xprov
              ? xprov.model
              : (agentRole?.model ??
                chatModelOverride ??
                aiSettings?.model ??
                ""));
          currentAgentModel = currentModel;
          const currentProvider =
            turnRoute?.provider ??
            xprov?.provider ??
            agentRole?.provider ??
            aiSettings?.provider ??
            "unknown";
          const agentUsageRoute = turnRoute
            ? snapshotInputTokenRoute(turnRoute)
            : null;
          const tokenEstimatorFamily = getTokenEstimatorFamily();
          // The prepared context is the immutable payload for this turn. The
          // live store publication may be suppressed when authority changes
          // while preparation is awaiting I/O, so telemetry must never read
          // the mutable UI projection here.
          const agentContextPlanDigest = prepared?.contextPlan?.digest ?? null;
          const agentApiVariant = turnRoute
            ? turnRoute.apiVariant
            : xprov
              ? xprov.variant
              : agentRole?.provider
                ? agentRole.variant
                : getChatApiVariant(currentModel);
          const effectiveContextWindow =
            turnRoute?.contextWindow ??
            resolveModelCapabilities(currentModel, aiSettings, agentApiVariant)
              .contextWindow;
          const tokenBudget = getToolTokenBudgetForContext(
            effectiveContextWindow,
          );
          // model-aware なツール呼び出し上限。大窓モデルほど多段探索を許す。
          const parentMaxToolCalls = getAgentToolCallBudgetForContext(
            effectiveContextWindow,
          );
          // run_research（サブエージェント）の 1 ターンあたり呼び出し上限。
          // 各サブエージェントは独立したループ（高コスト）なので、親予算とは別枠で
          // 厳しめに絞る。各呼び出しは parentMaxToolCalls も 1 消費する。
          const MAX_SUBAGENT_CALLS = 4;
          let subAgentCallCount = 0;
          let parentAuditExecutionId: string | null = null;
          const agentThinkingParams =
            turnRoute?.thinking ??
            buildThinkingParams(
              currentModel,
              getEffortForTask("agent"),
              "summarized",
              aiSettings?.thinkingEnabled ?? true,
              aiSettings,
              agentApiVariant,
              aiSettings?.reasoningEffortOverride ?? undefined,
            );
          // Accumulate tool calls for live metadata update
          const accToolCalls: ToolCallRecord[] = [];
          // 短絡: get_codex_entry が「事前に full body + custom details +
          // aliases が注入されているエントリ」に対して呼ばれた場合は、
          // executor (DB アクセス) を呼ばずスタブを返す。LLM はプロンプト
          // 指示に従わず再 fetch しがちなため、ランタイム側で受け止める。
          const agentControl = getPromptCatalog(
            projectCtx?.language ?? "ja",
          ).agentControl;
          const guardedExecuteTool: typeof executeTool = async (
            name,
            toolCallId,
            params,
            authorization,
          ) => {
            assertTurnAuthority();
            // ask_user: 遅延 Promise を返し、UI の回答で resolve されるまでループを
            // 待機させる。resolve クロージャは module-local に退避し、renderable な
            // 仕様のみ state に置く。
            if (name === "ask_user") {
              const spec = normalizeAskUserSpec(params);
              if (!spec) {
                return invalidAskUserResult(
                  toolCallId,
                  "ask_user requires a non-empty questions[] array.",
                );
              }
              const sessionId = sessionIdForPersist ?? activeSessionId;
              const dismissNote = agentControl.userDismissMessage;
              return await new Promise<Awaited<ReturnType<typeof executeTool>>>(
                (resolve) => {
                  userQuestionRuntime.register(resolve);
                  set({
                    pendingUserQuestion: {
                      sessionId,
                      toolCallId,
                      spec,
                      dismissNote,
                    },
                  });
                },
              );
            }
            // run_research: 読み取り専用のサブエージェントを別ループで起動し、
            // 要約だけを tool_result として親に返す。親のツール予算を温存しつつ
            // 大規模な調査を1呼び出しに圧縮する。子は read-only ツールのみ宣言され、
            // executeReadOnlyTool で dispatch されるため、書き込み・質問・再帰
            // （run_research 自身）は構造的に不可（depth=1）。
            if (name === RESEARCH_SUBAGENT_TOOL) {
              const task = String(params?.["task"] ?? "").trim();
              if (!task) {
                const msg = "run_research requires a non-empty 'task'.";
                return {
                  toolCallId,
                  name,
                  content: null,
                  summary: msg,
                  tokensUsed: 0,
                  error: msg,
                };
              }
              if (subAgentCallCount >= MAX_SUBAGENT_CALLS) {
                const msg = `Research sub-agent limit reached (${MAX_SUBAGENT_CALLS} per turn). Summarize with the information you already have.`;
                return {
                  toolCallId,
                  name,
                  content: null,
                  summary: msg,
                  tokensUsed: 0,
                  error: msg,
                };
              }
              subAgentCallCount++;
              // 予算分割: 子は親の半分（トークン / 呼び出し）。子の重い文脈は
              // 親予算を消費せず、返す要約のみが親に積まれる。
              const childTokenBudget = Math.max(
                2_000,
                Math.floor(tokenBudget * 0.5),
              );
              const childMaxCalls = Math.max(
                3,
                Math.floor(parentMaxToolCalls / 2),
              );
              const childMessages: AgentMessagePayload[] = [
                {
                  role: "system",
                  content: agentControl.researchSubagentSystem,
                },
                { role: "user", content: task },
              ];
              let researchInputTokenDrift = createInputTokenDriftTotals();
              let researchAuditExecutionId = parentAuditExecutionId;
              let childResult;
              try {
                childResult = await runAgentLoop({
                  messages: childMessages,
                  tools: getResearchSubagentTools(),
                  tokenBudget: childTokenBudget,
                  maxToolCalls: childMaxCalls,
                  // 親 Stop / セッション切替を子にも伝播させる。
                  shouldAbort: shouldAbortTurn,
                  // 子内部の上限メッセージは「続行」ボタン案内を含まない専用文言。
                  // 子に Continue ボタンは無く、その案内を要約へ取り込んで親へ
                  // 漏らさないようにする。
                  callLimitMessage: agentControl.researchLimitMessage,
                  tokenBudgetMessage: agentControl.researchLimitMessage,
                  sendToLLM: async (msgs, tools) => {
                    assertTurnAuthority();
                    const finalized = turnRoute
                      ? finalizeChatTurnPayload({
                          route: turnRoute,
                          fallbackSystemPrompt: msgs
                            .filter((message) => message.role === "system")
                            .map((message) => message.content)
                            .join("\n"),
                          messages: msgs,
                          tools,
                        })
                      : null;
                    const executionId = crypto.randomUUID();
                    const response = await chatApi.sendAgentMessage(
                      msgs,
                      tools,
                      {
                        projectId: turnProjectId,
                        pathId: "agent_research_subagent",
                        operationId: sendTurnId,
                        executionId,
                        parentExecutionId: researchAuditExecutionId,
                      },
                      agentThinkingParams,
                      // 子は親の cacheSegments / volatileTail を使わず、専用の
                      // system prompt を持つ。Web 検索も無効（null）。
                      finalized?.transport.systemCacheSegments,
                      agentApiVariant,
                      null,
                      finalized?.transport.systemVolatileTail,
                      turnRoute?.model ??
                        (xprov
                          ? xprov.model
                          : (agentRole?.model ??
                            resolveModelForPath(
                              "agent_research_subagent",
                              undefined,
                              aiSettings?.provider,
                            ))),
                      turnRoute
                        ? turnRoute.providerOverride
                        : (xprov?.provider ?? agentRole?.provider ?? null),
                      turnRoute
                        ? turnRoute.endpointId
                        : (xprov?.endpointId ?? agentRole?.endpointId ?? null),
                      turnRoute?.outputBudget.requestMaxOutputTokens ?? null,
                      turnRoute?.provider ?? null,
                      turnRoute?.resolvedEndpointId ?? null,
                      turnRoute?.toolProtocol ?? null,
                      turnRoute?.resolvedOllamaEndpoint ?? null,
                    );
                    researchAuditExecutionId = executionId;
                    researchInputTokenDrift = accumulateInputTokenDrift(
                      researchInputTokenDrift,
                      currentProvider,
                      {
                        estimatedInputTokens:
                          finalized?.usage.inputTokens ?? null,
                        safetyMarginTokens:
                          finalized?.usage.safetyMarginTokens ?? null,
                        inputTokens: response.inputTokens,
                        cacheReadTokens: response.cacheReadTokens,
                        cacheWriteTokens: response.cacheWriteTokens,
                      },
                    );
                    return response;
                  },
                  executeTool: async (name, toolCallId, params) => {
                    assertTurnAuthority();
                    return executeReadOnlyTool(name, toolCallId, params);
                  },
                  onProgress: (p) => {
                    if (isCurrentTurn()) set({ subAgentProgress: p });
                  },
                  onTextChunk: () => {},
                });
              } catch (e) {
                // 子の LLM / ネットワーク失敗で親ターン全体を破棄しない。
                // error ToolResult として返し、親 LLM が回復・継続できるようにする
                // （他ツールと同じ「失敗は tool_result 化」契約に揃える）。
                const msg = e instanceof Error ? e.message : String(e);
                return {
                  toolCallId,
                  name,
                  content: null,
                  summary: `Research sub-agent failed: ${msg}`,
                  tokensUsed: 0,
                  error: msg,
                };
              } finally {
                if (isCurrentTurn()) set({ subAgentProgress: null });
              }
              // 子の LLM usage（input/output/コスト）は親メッセージと同じ traceId で
              // 台帳に記録する（同一論理ターンにロールアップ）。
              void recordAiUsage({
                surface: "agent",
                model: currentModel,
                provider: currentProvider,
                projectId: turnProjectId,
                tokensIn: childResult.tokensIn,
                tokensOut: childResult.tokensOut,
                cacheReadTokens: researchInputTokenDrift.cacheReadTokens,
                cacheWriteTokens: researchInputTokenDrift.cacheWriteTokens,
                costUsd: childResult.cost,
                traceId: assistantMsg.id,
                refId: assistantMsg.id,
                metadata: agentUsageRoute
                  ? buildInputTokenDriftMetadata({
                      scope: "agent-research",
                      projectId: turnProjectId,
                      route: agentUsageRoute,
                      estimatorFamily: tokenEstimatorFamily,
                      language: projectCtxLang,
                      contextPlanDigest: null,
                      totals: researchInputTokenDrift,
                    })
                  : null,
              });

              const findings = childResult.finalText.trim() || "(no findings)";
              const content = {
                findings,
                toolCalls: childResult.toolCallRecords.length,
              };
              return {
                toolCallId,
                name,
                content,
                summary: `Research sub-agent completed (${childResult.toolCallRecords.length} read calls)`,
                tokensUsed: countTokens(JSON.stringify(content)),
              };
            }
            if (name === "get_codex_entry") {
              const id = String(params?.["id"] ?? "");
              if (id && fullyInjectedIds.has(id)) {
                const note =
                  "This entry is already fully injected in the system prompt — refer to the 登場キャラクター・設定情報 section above (id, aliases, summary, custom details, full body are all there). Do not call get_codex_entry on this id again.";
                const content = { id, note };
                const json = JSON.stringify(content);
                return {
                  toolCallId,
                  name,
                  content,
                  summary: "Already injected (short-circuited)",
                  tokensUsed: countTokens(json),
                };
              }
            }
            return authorization
              ? executeTool(name, toolCallId, params, {
                  ...authorization,
                  chatMessageId: assistantMsg.id,
                })
              : executeTool(name, toolCallId, params);
          };
          // クライアントツールは private Agent のときだけ渡す。Public RAG は
          // tools=[] とし、Web検索だけを使う分離済み経路にする。
          const agentTools = agentModeForThisSend ? turnAgentToolsSnapshot : [];
          // Web検索設定はpublic RAGにだけ渡す。private Agentでは常にnull。
          // Phase 2: 永続設定 (settingsStore の ai.webSearch.*) のドメイン制御 /
          // content cap を載せる。
          const webSearchConfig = webSearchConfigAtTurnStart;
          let parentInputTokenDrift = createInputTokenDriftTotals();
          const agentTextBatcher = createAgentTextBatcher((text) => {
            if (!isCurrentTurn() || sendControl.aborted) return;
            set((s) => {
              const msgs = [...s.messages];
              const index = msgs.findIndex(
                (message) => message.id === assistantMsg.id,
              );
              const assistant = index >= 0 ? msgs[index] : undefined;
              if (assistant?.role === "assistant") {
                msgs[index] = {
                  ...assistant,
                  content: assistant.content + text,
                };
              }
              return { messages: msgs };
            });
          });
          let agentLoopResult!: Awaited<ReturnType<typeof runAgentLoop>>;
          try {
            agentLoopResult = await runAgentLoop({
              messages: agentMsgs,
              tools: agentTools,
              tokenBudget,
              maxToolCalls: parentMaxToolCalls,
              shouldAbort: shouldAbortTurn,
              callLimitMessage: agentControl.callLimitMessage,
              tokenBudgetMessage: agentControl.tokenBudgetMessage,
              userQuestionLimitMessage: agentControl.userQuestionLimitMessage,
              sendToLLM: async (msgs, tools) => {
                assertTurnAuthority();
                await captureTurn.retirePriorCapture(sessionIdForPersist);
                if (cancelBeforeTransport()) {
                  throw new Error("CHAT_TURN_CANCELLED_BEFORE_TRANSPORT");
                }
                const finalized = turnRoute
                  ? finalizeChatTurnPayload({
                      route: turnRoute,
                      fallbackSystemPrompt: systemPromptForAgent,
                      cacheSegments: systemCacheSegmentsForAgent,
                      volatileTail: systemVolatileTailForAgent,
                      messages: msgs,
                      tools,
                      webSearch: webSearchConfig,
                    })
                  : null;
                if (finalized) {
                  sentSystemPromptForAgent =
                    materializeSystemDeliverySnapshot(finalized);
                  sentAgentContextTokenCount = finalized.usage.inputTokens;
                  set({
                    contextTokenCount: finalized.usage.inputTokens,
                    contextWindowUsage: contextWindowUsageFromTurnPayloadUsage(
                      finalized.usage,
                    ),
                    contextWindowSize: finalized.route.contextWindow,
                    contextModel: finalized.route.model,
                    contextProvider: finalized.route.provider,
                    contextRouteAuthorityKey:
                      resolvedChatTurnRouteAuthorityKey(turnRoute),
                    ...(finalized.cacheDowngradeReason === "budget"
                      ? { cacheInvalidatedReason: "budget" as const }
                      : {}),
                  });
                }
                captureTurn.notifyAccepted(options?._onAccepted);
                assertTurnAuthority();
                turnCoordinator.transition(sendControl, "agent-running");
                transportStarted = true;
                sendControl.transportStarted = true;
                const executionId = crypto.randomUUID();
                const response = await chatApi.sendAgentMessage(
                  msgs,
                  tools,
                  {
                    projectId: turnProjectId,
                    pathId: "chat_agent_main",
                    operationId: sendTurnId,
                    executionId,
                    parentExecutionId: parentAuditExecutionId,
                    chatMessageId: assistantMsg.id,
                  },
                  agentThinkingParams,
                  finalized
                    ? finalized.transport.systemCacheSegments
                    : systemCacheSegmentsForAgent,
                  agentApiVariant,
                  webSearchConfig,
                  finalized
                    ? finalized.transport.systemVolatileTail
                    : systemVolatileTailForAgent,
                  turnRoute?.model ??
                    (xprov
                      ? xprov.model
                      : (agentRole?.model ?? chatModelOverride ?? null)),
                  turnRoute
                    ? turnRoute.providerOverride
                    : (xprov?.provider ?? agentRole?.provider ?? null),
                  turnRoute
                    ? turnRoute.endpointId
                    : (xprov?.endpointId ?? agentRole?.endpointId ?? null),
                  turnRoute?.outputBudget.requestMaxOutputTokens ?? null,
                  turnRoute?.provider ?? null,
                  turnRoute?.resolvedEndpointId ?? null,
                  turnRoute?.toolProtocol ?? null,
                  turnRoute?.resolvedOllamaEndpoint ?? null,
                );
                parentAuditExecutionId = executionId;
                parentInputTokenDrift = accumulateInputTokenDrift(
                  parentInputTokenDrift,
                  currentProvider,
                  {
                    estimatedInputTokens: finalized?.usage.inputTokens ?? null,
                    safetyMarginTokens:
                      finalized?.usage.safetyMarginTokens ?? null,
                    inputTokens: response.inputTokens,
                    cacheReadTokens: response.cacheReadTokens,
                    cacheWriteTokens: response.cacheWriteTokens,
                  },
                );
                return response;
              },
              executeTool: guardedExecuteTool,
              onProgress: (progress) => {
                if (isCurrentTurn() && !sendControl.aborted) {
                  set({ agentProgress: progress });
                }
              },
              onToolComplete: (record) => {
                if (!isCurrentTurn() || sendControl.aborted) return;
                accToolCalls.push(record);
                set((s) => {
                  const msgs = [...s.messages];
                  const index = msgs.findIndex(
                    (message) => message.id === assistantMsg.id,
                  );
                  const assistant = index >= 0 ? msgs[index] : undefined;
                  if (assistant?.role === "assistant") {
                    msgs[index] = {
                      ...assistant,
                      metadata: JSON.stringify({ tool_calls: accToolCalls }),
                    };
                  }
                  return { messages: msgs };
                });
              },
              onTextChunk: (text) => {
                if (!isCurrentTurn() || sendControl.aborted) return;
                agentTextBatcher.push(text);
              },
            });
          } finally {
            agentTextBatcher.flush();
            agentTextBatcher.dispose();
          }
          const {
            toolCallRecords,
            finalThinkingBlocks,
            citations,
            cost,
            tokensIn: agentTokensIn,
            tokensOut: agentTokensOut,
            stoppedReason: agentStoppedReason,
          } = agentLoopResult;

          const stoppedAgentTurnCanFinalize = canFinalizeStoppedAgentTurn();
          if (shouldAbortTurn() && !stoppedAgentTurnCanFinalize) {
            debugLog.warn(
              "ChatStore",
              `Agent completion lost turn authority: aborted=${sendControl.aborted} current=${isCurrentTurn()} transport=${transportStarted} workspace=${capturedWorkspaceIsCurrent()} project=${capturedProjectIsCurrent()} chat=${capturedChatAuthorityIsCurrent()}`,
            );
            return;
          }

          // 上限で打ち切られたターンには「続行」ボタンを出す。質問上限(ask_user)は
          // 続行対象外（ユーザー回答待ちで止まる性質なので新予算で再開しても無意味）。
          if (
            agentStoppedReason === "limit_calls" ||
            agentStoppedReason === "limit_tokens"
          ) {
            set({ agentContinuation: { sessionId: sessionIdForPersist } });
          }

          // 引用の事後検証: 不正 URL を排除 + 本文中の裏付けなし URL を検出。
          const safeCitations = sanitizeCitations(citations);
          const answerForCheck =
            get().messages.find((message) => message.id === assistantMsg.id)
              ?.content ?? "";
          const unbackedUrls = findUnbackedUrls(answerForCheck, safeCitations);
          if (unbackedUrls.length > 0) {
            debugLog.warn(
              "ChatStore",
              "RAG: 引用に裏付けのない URL を検出",
              unbackedUrls.join(", "),
            );
          }

          // tool_calls / thinking / 引用 / コストをまとめた最終 metadata。
          // in-memory メッセージ (UI 即時表示) と DB 永続化で共有する。
          const finalAgentMetadata = JSON.stringify({
            tool_calls: toolCallRecords,
            ...(stoppedAgentTurnCanFinalize ? { stopped: true } : {}),
            ...(finalThinkingBlocks.length > 0
              ? { thinking_blocks: finalThinkingBlocks }
              : {}),
            ...(safeCitations.length > 0 ? { citations: safeCitations } : {}),
            ...(cost != null ? { cost } : {}),
          });
          set((s) => {
            const msgs = [...s.messages];
            const index = msgs.findIndex(
              (message) => message.id === assistantMsg.id,
            );
            const assistant = index >= 0 ? msgs[index] : undefined;
            if (assistant?.role === "assistant") {
              msgs[index] = { ...assistant, metadata: finalAgentMetadata };
            }
            return { messages: msgs };
          });

          // Persist
          turnCoordinator.transition(sendControl, "persisting");
          const userMetadata =
            options?.mentionedSceneIds && options.mentionedSceneIds.length > 0
              ? JSON.stringify({
                  mentioned_scene_ids: options.mentionedSceneIds,
                })
              : undefined;
          const promptSnapshot =
            sentSystemPromptForAgent || systemPromptForAgent;
          const lastMsg = get().messages.find(
            (message) => message.id === assistantMsg.id,
          );
          // 実際に使用したモデル（xprov / agent ロール / chat 一時 override）を
          // 完了payloadへ固定し、retryでも同じID・同じ値を使用する。
          const agentModel = currentModel || undefined;
          const recoverableAgentAssistant =
            lastMsg?.role === "assistant" &&
            lastMsg.content &&
            sessionIdForPersist
              ? {
                  ...lastMsg,
                  sessionId: sessionIdForPersist,
                  model: agentModel ?? null,
                  tokensIn: agentTokensIn ?? null,
                  tokensOut: agentTokensOut ?? null,
                  metadata: finalAgentMetadata,
                }
              : undefined;
          const persistAgentTurn = createRetryableCompletedTurnPersistence({
            persistUser: async () => {
              if (!sessionIdForPersist) return;
              await chatApi.addMessage(sessionIdForPersist, "user", content, {
                id: userMsg.id,
                createdAt: userMsg.createdAt,
                recordTimelapse: false,
                ...(userMetadata ? { metadata: userMetadata } : {}),
              });
              // Cache/plain のうち最後の Agent iteration が実際に送った
              // system representation を、user行の確定後に保存する。
              if (promptSnapshot) {
                void chatApi
                  .saveMessagePrompt(userMsg.id, {
                    systemPrompt: promptSnapshot,
                    layers: sentAgentContextLayers,
                    totalTokens: sentAgentContextTokenCount,
                    model: currentModel || null,
                    provider: turnRoute?.provider ?? null,
                    contextWindow: turnRoute?.contextWindow ?? null,
                  })
                  .catch((e) =>
                    debugLog.warn(
                      "ChatStore",
                      "saveMessagePrompt",
                      errorDetail(e),
                    ),
                  );
              }
            },
            ...(sessionIdForPersist &&
            lastMsg?.role === "assistant" &&
            lastMsg.content
              ? {
                  persistAssistant: async () => {
                    await chatApi.addMessage(
                      sessionIdForPersist,
                      "assistant",
                      lastMsg.content,
                      {
                        id: assistantMsg.id,
                        model: agentModel,
                        tokensIn: agentTokensIn ?? undefined,
                        tokensOut: agentTokensOut ?? undefined,
                        metadata: finalAgentMetadata,
                        createdAt: assistantMsg.createdAt,
                        recordTimelapse: false,
                      },
                    );
                    await commitAssistantReplacement();
                  },
                }
              : {}),
            finalize: async () => {
              if (
                !sessionIdForPersist ||
                lastMsg?.role !== "assistant" ||
                !lastMsg.content
              ) {
                return;
              }
              // N4: エージェントターンの usage を台帳にも記録
              // (cost は OpenRouter 実値)。
              void recordAiUsage({
                surface: "agent",
                model: agentModel,
                provider: currentProvider,
                projectId: turnProjectId,
                tokensIn: agentTokensIn,
                tokensOut: agentTokensOut,
                cacheReadTokens: parentInputTokenDrift.cacheReadTokens,
                cacheWriteTokens: parentInputTokenDrift.cacheWriteTokens,
                costUsd: cost,
                traceId: assistantMsg.id,
                refId: assistantMsg.id,
                metadata: agentUsageRoute
                  ? buildInputTokenDriftMetadata({
                      scope: "agent-parent",
                      projectId: turnProjectId,
                      route: agentUsageRoute,
                      estimatorFamily: tokenEstimatorFamily,
                      language: projectCtxLang,
                      contextPlanDigest: agentContextPlanDigest,
                      totals: parentInputTokenDrift,
                    })
                  : null,
              });

              const isFirstAgentResponse =
                prevMessages.filter((m) => m.role === "assistant").length === 0;
              const currentSession = get().sessions.find(
                (s) => s.id === sessionIdForPersist,
              );
              if (isFirstAgentResponse && currentSession?.titleManual === 0) {
                const titleModel =
                  useAiSettingsStore.getState().settings?.model ?? "";
                const titleGeneration = chatApi
                  .generateSessionTitle(
                    content,
                    lastMsg.content,
                    titleModel,
                    projectCtx?.language ?? "ja",
                    turnProjectId,
                  )
                  .then(async (title) => {
                    if (!title) {
                      title = content.slice(0, 30);
                    }
                    await chatApi.updateSessionTitle(
                      sessionIdForPersist,
                      title,
                    );
                    set((state) => ({
                      sessions: state.sessions.map((s) =>
                        s.id === sessionIdForPersist ? { ...s, title } : s,
                      ),
                    }));
                  })
                  .catch((e) => {
                    debugLog.error(
                      "ChatStore",
                      "agent title generation",
                      errorDetail(e),
                    );
                  });
                void turnRuntime.trackTurn(titleGeneration);
              }
            },
          });
          await persistCompletedTurn({
            retry: persistAgentTurn,
            sessionId: sessionIdForPersist,
            ...(userMetadata ? { userMetadata } : {}),
            ...(recoverableAgentAssistant
              ? { assistantMessage: recoverableAgentAssistant }
              : {}),
          });
        } catch (caught) {
          let e: unknown = caught;
          if (
            e instanceof ChatTurnPersistenceError &&
            !canScheduleQuiescenceMutation()
          ) {
            throw e;
          }
          if (shouldAbortTurn()) {
            try {
              if (await finalizeStoppedAgentTurnAfterTransport()) {
                return;
              }
            } catch (error) {
              e = error;
              if (
                e instanceof ChatTurnPersistenceError &&
                !canScheduleQuiescenceMutation()
              ) {
                throw e;
              }
            }
            if (!(e instanceof ChatTurnPersistenceError)) {
              cancelBeforeTransport();
              return;
            }
          }
          const kind = classifyError(e);
          const msg = e instanceof Error ? e.message : String(e);
          if (!transportStarted) removeOwnedTurnMessages();
          if (kind === "auth") {
            toast.error(i18next.t("chat.invalidApiKey"));
          } else if (kind === "network") {
            toast.error(i18next.t("chat.networkError"));
          } else {
            toast.error(i18next.t("chat.agentFailed", { message: msg }));
          }
          const failedContextWindowUsage = contextWindowUsageFromError(e);
          set({
            error: msg,
            ...(failedContextWindowUsage
              ? {
                  contextTokenCount: failedContextWindowUsage.inputTokens,
                  contextWindowUsage: failedContextWindowUsage,
                  contextWindowSize: failedContextWindowUsage.contextWindow,
                  contextModel: turnRoute?.model ?? null,
                  contextProvider: turnRoute?.provider ?? null,
                  contextRouteAuthorityKey:
                    resolvedChatTurnRouteAuthorityKey(turnRoute),
                }
              : {}),
          });
        } finally {
          // 例外で抜けた場合も含め、回答待ちの ask_user を確実に解決して
          // awaiting 中のループ Promise をリークさせない。中断フラグもリセット。
          if (isCurrentTurn()) {
            get()._cancelPendingUserQuestion();
            turnRuntime.clearActiveRouteIf(turnRoute);
            turnCoordinator.release(sendControl);
            set({
              isStreaming: false,
              agentProgress: null,
              subAgentProgress: null,
            });
          } else {
            turnCoordinator.release(sendControl);
          }
        }
        return;
      }

      // -----------------------------------------------------------------------
      // Normal mode path (existing)
      // -----------------------------------------------------------------------
      try {
        const projectCtx = await fetchRequiredProjectContext(turnProjectId);
        if (cancelBeforeTransport()) return;

        const aiSettings = useAiSettingsStore.getState().settings;
        // チャットパネルで一時選択したモデル(あれば)。role 未設定時に既定より優先する。
        const chatModelOverride =
          useAiSettingsStore.getState().chatModelOverride;
        // conversation ロールの override を実モデルとして解決し、API variant / コンテキスト
        // 予算 / thinking パラメータ / 記録を実モデルから導出する（transport に渡す
        // override と一致。未設定なら既定モデル = byte-identical）。
        // conversation ロールの横断割り当て（別プロバイダ/別エンドポイント）。provider
        // 未設定なら従来どおり model のみ（active provider）。composer の一時 override
        // (xprov) が最優先。
        const convRole = resolveRolePathConfig(
          "chat_stream_non_agent",
          undefined,
          aiSettings?.provider,
        );
        const chatModel =
          turnRoute?.model ??
          (xprov
            ? xprov.model
            : (convRole?.model ??
              chatModelOverride ??
              aiSettings?.model ??
              ""));
        const chatProvider =
          turnRoute?.provider ??
          xprov?.provider ??
          convRole?.provider ??
          aiSettings?.provider ??
          "unknown";
        const chatUsageRoute = turnRoute
          ? snapshotInputTokenRoute(turnRoute)
          : null;
        const tokenEstimatorFamily = getTokenEstimatorFamily();
        const chatApiVariant = turnRoute
          ? turnRoute.apiVariant
          : xprov
            ? xprov.variant
            : convRole?.provider
              ? convRole.variant
              : getChatApiVariant(chatModel);
        const fallbackCaps = resolveModelCapabilities(
          chatModel,
          aiSettings,
          chatApiVariant,
        );
        const contextWindow =
          turnRoute?.contextWindow ?? fallbackCaps.contextWindow;
        const maxOutputTokens =
          turnRoute?.capabilities.maxOutputTokens ??
          fallbackCaps.maxOutputTokens;
        const budgets = allocateLayerBudgets(contextWindow, {
          maxOutputTokens,
          responseReservationTokens:
            turnRoute?.outputBudget.responseReservationTokens,
        });

        let currentMessages = prevMessages;
        if (sessionIdForPersist) {
          currentMessages = await maybeRunSummarization(
            sessionIdForPersist,
            turnProjectId,
            sendTurnId,
            prevMessages,
            budgets.l5,
            projectCtx?.language ?? "ja",
            set,
            () => !shouldAbortTurn(),
          );
          if (cancelBeforeTransport()) return;
        }
        // Summarization publishes its result through the live store, which also
        // contains this turn's optimistic user/assistant pair. Keep a single
        // explicit pre-turn projection for App Server bootstrap and revision
        // hashing so the current user message is never imported and sent twice.
        const priorHistoryMessages = currentMessages.filter(
          (message) =>
            message.id !== userMsg.id && message.id !== assistantMsg.id,
        );

        // APIペイロードを構築（要約済みメッセージを除外）
        const messagesForApi: ChatMessage[] = [
          ...priorHistoryMessages.filter((message) => !message.isSummarized),
          userMsg,
        ];

        let systemCacheSegments: string[] | undefined;
        let systemVolatileTail: string | undefined;
        // 過去メッセージのプロンプト確認用: このターンで実際に送った system
        // プロンプトを退避し、persist 時に userMsg.id へひも付けて保存する。
        // 空 = この経路では system メッセージを送らなかった (スナップショット不要)。
        let sentSystemPrompt = "";
        let sentContextLayers: LayerBreakdown[] = [];
        let sentContextTokenCount: number | null = null;

        if (cancelBeforeTransport()) return;
        const prepared = await get().refreshContextLayers({
          purpose: "send",
          conversationMessages: messagesForApi,
          outgoingUserMessage: content,
          commandInstruction,
          mentionedSceneIds: options?.mentionedSceneIds,
          mentionedCodexIds: options?.mentionedCodexIds,
          agentModeOverride: useAgentPath,
          turnRoute: turnRoute ?? undefined,
          privacy: "private",
          ragActiveOverride: ragActive,
          inputOverheadTokens: contextInputOverheadTokens,
          preparationSeed,
          preparationSnapshot,
          trackRecallPromote: true,
          isAuthorized: () => !shouldAbortTurn(),
          strict: true,
        });
        if (cancelBeforeTransport()) return;

        const systemPrompt = prepared?.prompt ?? "";
        systemCacheSegments = prepared?.cacheSegments;
        systemVolatileTail = prepared?.volatileTail;
        sentContextLayers = (prepared?.layers ?? []).map((layer) => ({
          ...layer,
        }));
        sentContextTokenCount = prepared?.totalTokens ?? null;
        if (systemPrompt) {
          messagesForApi.unshift({
            id: "system",
            sessionId,
            role: "system",
            content: systemPrompt,
            createdAt: new Date().toISOString(),
          });
          sentSystemPrompt = systemPrompt;
        }
        const chatThinkingParams =
          turnRoute?.thinking ??
          buildThinkingParams(
            chatModel,
            getEffortForTask("chat"),
            "summarized",
            aiSettings?.thinkingEnabled ?? true,
            aiSettings,
            chatApiVariant,
            aiSettings?.reasoningEffortOverride ?? undefined,
          );
        const apiPayload = messagesForApi.map((m) => ({
          role: m.role,
          // assistant 履歴の擬似ツール記法を除去してからモデルへ戻す（模倣抑止）。
          content:
            m.role === "assistant" ? stripToolProtocol(m.content) : m.content,
        }));
        // `prepared` is the context that is actually finalized and sent. The
        // live `contextPlan` is only a UI projection and can intentionally be
        // stale when authority changed during preparation.
        const chatContextPlanDigest = prepared?.contextPlan?.digest ?? null;
        const turnTransport =
          turnRoute?.transport ??
          (turnRoute?.provider === "cli" ? "cli-exec" : "http");
        const isCodexAppServer = turnTransport === "codex-app-server";
        const codexExpectedWorkspacePath = isCodexAppServer
          ? turnWorkspaceIdentity?.path
          : undefined;
        if (isCodexAppServer && !codexExpectedWorkspacePath) {
          throw new Error(
            "Active workspace is unavailable for Codex App Server",
          );
        }
        let estimatedChatInputTokens: number | null = null;
        let chatSafetyMarginTokens: number | null = null;
        if (turnRoute) {
          const finalized =
            turnTransport === "cli-exec"
              ? finalizeTurnPayload(
                  {
                    route: turnRoute,
                    system: { fallback: "" },
                    messages: [],
                    renderedToolPayloads: [flattenMessagesForCli(apiPayload)],
                    envelopeTokens: 0,
                    safetyMarginTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
                  },
                  countTokens,
                )
              : finalizeChatTurnPayload({
                  route: turnRoute,
                  fallbackSystemPrompt:
                    sentSystemPrompt ||
                    apiPayload
                      .filter((message) => message.role === "system")
                      .map((message) => message.content)
                      .join("\n"),
                  cacheSegments: systemCacheSegments,
                  volatileTail: systemVolatileTail,
                  messages: apiPayload,
                });
          systemCacheSegments = finalized.transport.systemCacheSegments;
          systemVolatileTail = finalized.transport.systemVolatileTail;
          estimatedChatInputTokens = finalized.usage.inputTokens;
          chatSafetyMarginTokens = finalized.usage.safetyMarginTokens;
          sentContextTokenCount = finalized.usage.inputTokens;
          if (turnTransport !== "cli-exec") {
            sentSystemPrompt = materializeSystemDeliverySnapshot(finalized);
          }
          set({
            contextTokenCount: finalized.usage.inputTokens,
            contextWindowUsage: contextWindowUsageFromTurnPayloadUsage(
              finalized.usage,
            ),
            contextWindowSize: finalized.route.contextWindow,
            contextModel: finalized.route.model,
            contextProvider: finalized.route.provider,
            contextRouteAuthorityKey:
              resolvedChatTurnRouteAuthorityKey(turnRoute),
            ...(finalized.cacheDowngradeReason === "budget"
              ? { cacheInvalidatedReason: "budget" as const }
              : {}),
          });
        }
        if (cancelBeforeTransport()) return;
        const chatStartTime = performance.now();

        // Accumulate thinking text locally during streaming
        let thinkingAccumulator = "";
        const isFirstResponse =
          prevMessages.filter((m) => m.role === "assistant").length === 0;

        // CLI プロバイダ選択時は subprocess 経由のストリームに切り替える。
        // CLI は単一プロンプトしか受け付けないので、会話履歴は role タグ付きで
        // 平坦化する。
        // 別プロバイダ override 中は HTTP 経路(別プロバイダは cli 非対象)に流すため、
        // active provider が cli でも cli subprocess 経路には落とさない。
        const isCliExec = turnRoute
          ? turnTransport === "cli-exec"
          : !xprov && aiSettings?.provider === "cli";
        const cliConfig = turnRoute?.effectiveSettings.cli ??
          aiSettings?.cli ?? {
            kind: "claude" as const,
            binaryPath: "",
            model: "",
          };
        const codexTransport = cliConfig.codexTransport ?? "exec";
        const codexHistoryRevision = isCodexAppServer
          ? await computeChatHistoryRevision(priorHistoryMessages)
          : null;
        const codexBootstrapHistory = isCodexAppServer
          ? buildCodexBootstrapHistory(priorHistoryMessages)
          : undefined;
        // Web Crypto yields while hashing the imported history. Stop/session
        // changes during that await must be observed before start_turn is issued.
        if (cancelBeforeTransport()) return;
        let codexThreadId: string | undefined;
        let codexTurnId: string | undefined;
        const codexItems = new Map<string, CodexAppItem>();
        const codexWarnings: string[] = [];

        // Revoke prior same-session authority only after the route and turn
        // have otherwise reached the existing pre-transport admission point.
        if (!captureRouteEligible) {
          await captureTurn.retirePriorCapture(sessionIdForPersist);
          if (cancelBeforeTransport()) return;
          assertTurnAuthority();
        }

        // Start streaming — returns a Promise<cleanup_fn>
        await new Promise<void>((resolve, reject) => {
          // delta coalesce: provider が 1:1 で emit する SSE delta(秒間 20〜40)を
          // requestAnimationFrame でまとめ、Markdown publish は最大約 30Hz に抑える。
          // messages 本体は触らず末尾 draft だけを更新するため static chrome / 過去行 /
          // virtualizer の配列 identity は生成完了まで安定する。
          // onDone/onError/stop では必ず同期 flush して末尾を取りこぼさない。
          let pendingDelta = "";
          let flushHandle: number | null = null;
          let lastDraftPublishAt = Number.NEGATIVE_INFINITY;
          let callbacksSettled = false;
          let turnStreamCleanup: (() => void) | null = null;
          const flushDelta = (frameTime?: number) => {
            if (flushHandle !== null) {
              if (typeof cancelAnimationFrame === "function") {
                cancelAnimationFrame(flushHandle);
              }
              flushHandle = null;
            }
            if (
              frameTime !== undefined &&
              frameTime - lastDraftPublishAt < 30
            ) {
              flushHandle = requestAnimationFrame(flushDelta);
              return;
            }
            if (!isCurrentTurn()) {
              pendingDelta = "";
              return;
            }
            if (!pendingDelta) return;
            const chunk = pendingDelta;
            pendingDelta = "";
            lastDraftPublishAt = frameTime ?? performance.now();
            set((s) => {
              if (s.streamingDraft?.messageId !== assistantMsg.id) return {};
              return {
                streamingDraft: {
                  messageId: assistantMsg.id,
                  content: s.streamingDraft.content + chunk,
                },
              };
            });
          };
          const scheduleFlush = () => {
            if (flushHandle !== null) return;
            if (typeof requestAnimationFrame !== "function") {
              // 非ブラウザ環境(テスト等)は即時 flush にフォールバック（従来挙動）。
              flushDelta();
              return;
            }
            flushHandle = requestAnimationFrame(flushDelta);
          };
          turnRuntime.setPendingDeltaFlusher(flushDelta);

          const callbacks: StreamCallbacks = {
            onTextDelta: (delta: string) => {
              if (!isCurrentTurn()) return;
              pendingDelta += delta;
              scheduleFlush();
            },
            onThinkingDelta: (delta: string) => {
              if (!isCurrentTurn()) return;
              thinkingAccumulator += delta;
            },
            onDone: (info: {
              stopReason: string;
              inputTokens?: number;
              outputTokens?: number;
              cost?: number;
              cacheReadTokens?: number;
              cacheWriteTokens?: number;
            }) => {
              if (callbacksSettled) return;
              callbacksSettled = true;
              turnRuntime.clearStoppedStreamFinalizerIf(finalizeStoppedStream);
              if (!isCurrentTurn()) {
                pendingDelta = "";
                if (flushHandle !== null) {
                  if (typeof cancelAnimationFrame === "function") {
                    cancelAnimationFrame(flushHandle);
                  }
                  flushHandle = null;
                }
                turnStreamCleanup?.();
                resolve();
                return;
              }
              // 末尾の buffered delta を確定前に同期反映。
              flushDelta();
              turnRuntime.clearPendingDeltaFlusherIf(flushDelta);
              const chatDurationMs = Math.round(
                performance.now() - chatStartTime,
              );
              const chatInputTokenDrift = accumulateInputTokenDrift(
                createInputTokenDriftTotals(),
                chatProvider,
                {
                  estimatedInputTokens: estimatedChatInputTokens,
                  safetyMarginTokens: chatSafetyMarginTokens,
                  inputTokens: info.inputTokens,
                  cacheReadTokens: info.cacheReadTokens,
                  cacheWriteTokens: info.cacheWriteTokens,
                },
              );

              // N4: 通常チャットの usage を台帳に記録 (chat_messages.tokens_* とは
              // 別に、集計用の単一台帳に集約する。cost は OpenRouter streaming 実値)。
              void recordAiUsage({
                surface: "chat",
                model: chatModel || undefined,
                provider: chatProvider,
                projectId: turnProjectId,
                tokensIn: info.inputTokens,
                tokensOut: info.outputTokens,
                costUsd: info.cost ?? null,
                cacheReadTokens: info.cacheReadTokens,
                cacheWriteTokens: info.cacheWriteTokens,
                durationMs: chatDurationMs,
                traceId: assistantMsg.id,
                refId: assistantMsg.id,
                metadata: chatUsageRoute
                  ? buildInputTokenDriftMetadata({
                      scope: "chat",
                      projectId: turnProjectId,
                      route: chatUsageRoute,
                      estimatorFamily: tokenEstimatorFamily,
                      language: projectCtx?.language ?? null,
                      contextPlanDigest: chatContextPlanDigest,
                      totals: chatInputTokenDrift,
                    })
                  : null,
              });

              // Build metadata: thinking blocks + stopped flag
              const metadataObj: Record<string, unknown> = {};
              if (thinkingAccumulator) {
                metadataObj.thinking_blocks = [
                  { thinking: thinkingAccumulator },
                ];
              }
              if (sendControl.transport === "codex-app-server") {
                metadataObj.runtime = "codex-app-server";
                metadataObj.usage_source = "app-server";
                metadataObj.stop_reason = info.stopReason;
                if (codexThreadId) metadataObj.codex_thread_id = codexThreadId;
                if (codexTurnId) metadataObj.codex_turn_id = codexTurnId;
                if (codexItems.size > 0) {
                  metadataObj.codex_item_ids = [...codexItems.keys()];
                  metadataObj.codex_items = [...codexItems.values()].map(
                    (item) => {
                      const safeItem = { ...item };
                      delete safeItem.raw;
                      return safeItem;
                    },
                  );
                }
                if (codexWarnings.length > 0) {
                  metadataObj.codex_warnings = codexWarnings;
                }
              }
              if (info.stopReason === "stopped") {
                metadataObj.stopped = true;
              }
              const chatMetadata =
                Object.keys(metadataObj).length > 0
                  ? JSON.stringify(metadataObj)
                  : undefined;

              // draft を一度だけ確定 messages へ移し、以後は通常 message として扱う。
              finalizeStreamingDraft(chatMetadata);

              // A binding stores the history that existed before this turn. Once
              // both messages are durable, advance it to the exact active-history
              // projection that the next turn will hash. Synthetic local Stop and
              // exec fallback deliberately leave the old revision in place, which
              // forces a safe new thread on the next send.
              const completedCodexBinding =
                sendControl.transport === "codex-app-server" &&
                info.stopReason !== "stopped" &&
                codexHistoryRevision !== null &&
                codexThreadId &&
                codexTurnId &&
                get().messages.some(
                  (message) =>
                    message.id === assistantMsg.id &&
                    message.role === "assistant" &&
                    message.content.length > 0,
                )
                  ? {
                      threadId: codexThreadId,
                      turnId: codexTurnId,
                      expectedHistoryRevision: codexHistoryRevision,
                      // Hash the exact pre-turn projection plus only the two
                      // messages owned by this turn. A live-store mutation must
                      // not become the revision of an already-running thread.
                      nextHistoryRevision: computeChatHistoryRevision([
                        ...priorHistoryMessages.map((message) => ({
                          ...message,
                        })),
                        { ...userMsg },
                        {
                          ...assistantMsg,
                          content:
                            get().messages.find(
                              (message) => message.id === assistantMsg.id,
                            )?.content ?? "",
                        },
                      ]),
                    }
                  : null;

              // Persist to DB
              const lastMsg = get().messages.find(
                (message) => message.id === assistantMsg.id,
              );
              const userMetadata =
                options?.mentionedSceneIds &&
                options.mentionedSceneIds.length > 0
                  ? JSON.stringify({
                      mentioned_scene_ids: options.mentionedSceneIds,
                    })
                  : undefined;
              turnCoordinator.transition(sendControl, "persisting");
              const recoverableAssistant =
                lastMsg?.role === "assistant" &&
                lastMsg.content &&
                sessionIdForPersist
                  ? {
                      ...lastMsg,
                      sessionId: sessionIdForPersist,
                      model: chatModel || null,
                      tokensIn: info.inputTokens,
                      tokensOut: info.outputTokens,
                      durationMs: chatDurationMs,
                      ...(chatMetadata ? { metadata: chatMetadata } : {}),
                    }
                  : undefined;
              const persistToDb = createRetryableCompletedTurnPersistence({
                persistUser: async () => {
                  if (!sessionIdForPersist) return;
                  await chatApi.addMessage(
                    sessionIdForPersist,
                    "user",
                    content,
                    {
                      id: userMsg.id,
                      createdAt: userMsg.createdAt,
                      recordTimelapse: false,
                      ...(userMetadata ? { metadata: userMetadata } : {}),
                    },
                  );
                  // 過去メッセージのプロンプト確認用スナップショット
                  // (fire-and-forget)。user 行が存在してから FK 付きで保存する。
                  if (sentSystemPrompt) {
                    void chatApi
                      .saveMessagePrompt(userMsg.id, {
                        systemPrompt: sentSystemPrompt,
                        layers: sentContextLayers,
                        totalTokens: sentContextTokenCount,
                        model: chatModel || null,
                        provider: turnRoute?.provider ?? null,
                        contextWindow: turnRoute?.contextWindow ?? null,
                      })
                      .catch((e) =>
                        debugLog.warn(
                          "ChatStore",
                          "saveMessagePrompt",
                          errorDetail(e),
                        ),
                      );
                  }
                },
                ...(sessionIdForPersist &&
                lastMsg?.role === "assistant" &&
                lastMsg.content
                  ? {
                      persistAssistant: async () => {
                        await chatApi.addMessage(
                          sessionIdForPersist,
                          "assistant",
                          lastMsg.content,
                          {
                            id: assistantMsg.id,
                            model: chatModel || undefined,
                            tokensIn: info.inputTokens,
                            tokensOut: info.outputTokens,
                            durationMs: chatDurationMs,
                            ...(chatMetadata ? { metadata: chatMetadata } : {}),
                            createdAt: assistantMsg.createdAt,
                            recordTimelapse: false,
                          },
                        );
                        await commitAssistantReplacement();
                      },
                    }
                  : {}),
                finalize: async () => {
                  if (!sessionIdForPersist) return;
                  if (completedCodexBinding) {
                    try {
                      const nextHistoryRevision =
                        await completedCodexBinding.nextHistoryRevision;
                      const liveHistoryRevision =
                        await computeChatHistoryRevision(
                          get().messages.map((message) => ({ ...message })),
                        );
                      if (liveHistoryRevision !== nextHistoryRevision) {
                        debugLog.warn(
                          "ChatStore",
                          "skip Codex history revision after concurrent history mutation",
                        );
                      } else {
                        await codexAppApi.advanceCodexHistoryRevision({
                          projectId: turnProjectId,
                          sessionId: sessionIdForPersist,
                          grimodexTurnId: sendTurnId,
                          codexThreadId: completedCodexBinding.threadId,
                          codexTurnId: completedCodexBinding.turnId,
                          expectedHistoryRevision:
                            completedCodexBinding.expectedHistoryRevision,
                          nextHistoryRevision,
                        });
                      }
                    } catch (error: unknown) {
                      // Persistence already succeeded. Keeping the old revision is
                      // the fail-safe: the next send archives instead of resuming a
                      // thread whose local history could be stale.
                      debugLog.warn(
                        "ChatStore",
                        "advance Codex history revision",
                        errorDetail(error),
                      );
                    }
                  }

                  const currentSession = get().sessions.find(
                    (s) => s.id === sessionIdForPersist,
                  );
                  if (
                    isFirstResponse &&
                    currentSession &&
                    currentSession.titleManual === 0 &&
                    lastMsg?.role === "assistant" &&
                    lastMsg.content
                  ) {
                    const titleGeneration = chatApi
                      .generateSessionTitle(
                        content,
                        lastMsg.content,
                        chatModel,
                        projectCtx?.language ?? "ja",
                        turnProjectId,
                      )
                      .then(async (title) => {
                        if (!title) {
                          title = content.slice(0, 30);
                        }
                        if (sessionIdForPersist) {
                          await chatApi.updateSessionTitle(
                            sessionIdForPersist,
                            title,
                          );
                          if (isCodexAppServer && turnWorkspaceIdentity) {
                            void codexAppApi
                              .setCodexSessionThreadName({
                                projectId: turnProjectId,
                                sessionId: sessionIdForPersist,
                                expectedWorkspacePath:
                                  turnWorkspaceIdentity.path,
                                name: title,
                              })
                              .catch((error: unknown) =>
                                debugLog.warn(
                                  "ChatStore",
                                  "sync Codex thread title",
                                  errorDetail(error),
                                ),
                              );
                          }
                          set((state) => ({
                            sessions: state.sessions.map((s) =>
                              s.id === sessionIdForPersist
                                ? { ...s, title }
                                : s,
                            ),
                          }));
                        }
                      })
                      .catch((e) => {
                        debugLog.error(
                          "ChatStore",
                          "title generation",
                          errorDetail(e),
                        );
                      });
                    void turnRuntime.trackTurn(titleGeneration);
                  }
                },
              });

              void persistCompletedTurn({
                retry: persistToDb,
                sessionId: sessionIdForPersist,
                ...(userMetadata ? { userMetadata } : {}),
                ...(recoverableAssistant
                  ? { assistantMessage: recoverableAssistant }
                  : {}),
              })
                .then(
                  async () => {
                    if (info.stopReason === "stopped" || sendControl.aborted) {
                      await captureTurn.cancel();
                    } else {
                      captureTurn.keepCurrent();
                      sendControl.preTransportAdmissionPending = false;
                      captureTurn.clearCancellationRetry();
                    }
                  },
                  (error: unknown) => {
                    throw error instanceof ChatTurnPersistenceError
                      ? error
                      : new ChatTurnPersistenceError(error);
                  },
                )
                .finally(() => {
                  turnStreamCleanup?.();
                  if (turnStreamCleanup) {
                    turnRuntime.clearStreamCleanupIf(turnStreamCleanup);
                  }
                  if (isCurrentTurn()) set({ isStreaming: false });
                })
                .then(resolve, async (error: unknown) => {
                  try {
                    await captureTurn.cancel();
                  } catch (cleanupError) {
                    error = cleanupError;
                  }
                  debugLog.error(
                    "ChatStore",
                    "persist after stream",
                    errorDetail(error),
                  );
                  reject(
                    error instanceof ChatTurnPersistenceError
                      ? error
                      : new ChatTurnPersistenceError(error),
                  );
                });
            },
            onError: (message: string) => {
              if (callbacksSettled) return;
              callbacksSettled = true;
              turnRuntime.clearStoppedStreamFinalizerIf(finalizeStoppedStream);
              if (!isCurrentTurn()) {
                pendingDelta = "";
                turnStreamCleanup?.();
                resolve();
                return;
              }
              // エラー時も partial content を保持するため同期 flush。
              flushDelta();
              finalizeStreamingDraft();
              turnRuntime.clearPendingDeltaFlusherIf(flushDelta);
              turnStreamCleanup?.();
              if (turnStreamCleanup) {
                turnRuntime.clearStreamCleanupIf(turnStreamCleanup);
              }
              if (sendControl.transport === "codex-app-server") {
                const runtimeMetadata = {
                  runtime: "codex-app-server",
                  runtime_error: message,
                  ...(codexThreadId ? { codex_thread_id: codexThreadId } : {}),
                  ...(codexTurnId ? { codex_turn_id: codexTurnId } : {}),
                };
                set((s) => ({
                  messages: s.messages.map((messageItem) =>
                    messageItem.id === assistantMsg.id
                      ? {
                          ...messageItem,
                          metadata: JSON.stringify(runtimeMetadata),
                        }
                      : messageItem,
                  ),
                }));
              }
              reject(new Error(message));
            },
          };

          const codexCallbacks: CodexAppStreamCallbacks = {
            ...callbacks,
            onTurnStarted: ({ threadId, turnId }) => {
              if (threadId) codexThreadId = threadId;
              if (turnId) codexTurnId = turnId;
            },
            onItemStarted: (item) => {
              codexItems.set(item.id, item);
            },
            onItemCompleted: (item) => {
              codexItems.set(item.id, item);
            },
            onWarning: (message) => {
              if (codexWarnings.length < 32) codexWarnings.push(message);
            },
            onFallback: () => {
              sendControl.transport = "cli-exec";
            },
          };

          const finalizeStoppedStream = () => {
            callbacks.onDone({ stopReason: "stopped" });
          };
          turnRuntime.setStoppedStreamFinalizer(finalizeStoppedStream);

          assertTurnAuthority();
          captureTurn.notifyAccepted(options?._onAccepted);
          assertTurnAuthority();
          turnCoordinator.transition(sendControl, "streaming");
          transportStarted = true;
          sendControl.transportStarted = true;
          const streamPromise = isCodexAppServer
            ? codexAppApi.sendCodexAppTurn(
                {
                  projectId: turnProjectId,
                  sessionId: sessionIdForPersist,
                  expectedWorkspacePath: codexExpectedWorkspacePath!,
                  grimodexTurnId: sendTurnId,
                  clientUserMessageId: userMsg.id,
                  model: turnRoute?.model || cliConfig.model || undefined,
                  effort: turnRoute?.thinking.effort ?? undefined,
                  contextPacket:
                    sentSystemPrompt ||
                    systemCacheSegments?.join("\n\n") ||
                    "No additional Grimodex context is available.",
                  bootstrapHistory: codexBootstrapHistory,
                  historyRevision: codexHistoryRevision ?? "empty",
                  userMessage: content,
                  transport: codexTransport === "auto" ? "auto" : "app-server",
                  ...(codexTransport === "auto"
                    ? {
                        fallbackCli: {
                          cli: cliConfig.kind,
                          binaryPath: cliConfig.binaryPath || undefined,
                          model:
                            turnRoute?.model || cliConfig.model || undefined,
                          prompt: flattenMessagesForCli(apiPayload),
                        },
                      }
                    : {}),
                },
                codexCallbacks,
              )
            : isCliExec
              ? cliApi.sendCliChatStream(
                  {
                    cli: cliConfig.kind,
                    binaryPath: cliConfig.binaryPath || undefined,
                    model:
                      (turnRoute?.provider === "cli"
                        ? turnRoute.model
                        : cliConfig.model) || undefined,
                    prompt: flattenMessagesForCli(apiPayload),
                  },
                  {
                    projectId: turnProjectId,
                    pathId: "cli_chat_stream",
                    operationId: sendTurnId,
                  },
                  callbacks,
                )
              : chatApi.sendChatMessageStream(
                  apiPayload,
                  chatThinkingParams,
                  callbacks,
                  {
                    projectId: turnProjectId,
                    pathId: "chat_stream_non_agent",
                    operationId: sendTurnId,
                  },
                  systemCacheSegments,
                  chatApiVariant,
                  systemVolatileTail,
                  // role 未設定なら一時モデル(あれば)を送る。両方無ければ null=既定で
                  // byte-identical(キャッシュ温存)。agent 経路と同契約。別プロバイダ override 最優先。
                  turnRoute?.model ??
                    (xprov
                      ? xprov.model
                      : (convRole?.model ?? chatModelOverride ?? null)),
                  // 別プロバイダ override 時のみ provider を渡す(同一プロバイダは null=既定)。
                  // role に横断割り当てがあればそれを送る。
                  turnRoute
                    ? turnRoute.providerOverride
                    : (xprov?.provider ?? convRole?.provider ?? null),
                  // OpenAI 互換の別エンドポイント override（同一 provider でも送信先を切替）。
                  turnRoute
                    ? turnRoute.endpointId
                    : (xprov?.endpointId ?? convRole?.endpointId ?? null),
                  turnRoute?.outputBudget.requestMaxOutputTokens ?? null,
                  turnRoute?.provider ?? null,
                  turnRoute?.resolvedEndpointId ?? null,
                  turnRoute?.resolvedOllamaEndpoint ?? null,
                );

          streamPromise
            .then((cleanup) => {
              turnStreamCleanup = cleanup;
              if (callbacksSettled || !isCurrentTurn()) {
                cleanup();
              } else {
                turnRuntime.setStreamCleanup(cleanup);
              }
            })
            .catch((error) => {
              if (isCurrentTurn()) reject(error);
              else resolve();
            });
        });
      } catch (caught) {
        let e = caught;
        let captureCleanupFailed = false;
        try {
          await captureTurn.cancel();
        } catch (cleanupError) {
          captureCleanupFailed = true;
          debugLog.error(
            "ChatStore",
            "cancel current chat capture",
            errorDetail(cleanupError),
          );
          if (!(e instanceof ChatTurnPersistenceError)) e = cleanupError;
        }
        if (
          e instanceof ChatTurnPersistenceError &&
          !canScheduleQuiescenceMutation()
        ) {
          // A destructive lifecycle must remain on the old authority when the
          // completed turn could not become durable in that old scope.
          throw e;
        }
        if (
          shouldAbortTurn() &&
          !(e instanceof ChatTurnPersistenceError) &&
          !captureCleanupFailed
        ) {
          cancelBeforeTransport();
          return;
        }
        const kind = classifyError(e);
        const msg = e instanceof Error ? e.message : String(e);
        if (transportStarted) finalizeStreamingDraft();
        if (!transportStarted) removeOwnedTurnMessages();

        if (kind === "auth") {
          toast.error(i18next.t("chat.invalidApiKey"), {
            action: {
              label: i18next.t("chat.openSettings"),
              onClick: () => {
                // Signal to open settings dialog via a custom event
                window.dispatchEvent(
                  new CustomEvent("open-settings", {
                    detail: { category: "ai" },
                  }),
                );
              },
            },
            duration: 8000,
          });
        } else if (kind === "rate_limit") {
          toast.warning(i18next.t("chat.rateLimited"));
          // 失敗した placeholder（user + 空 assistant）を除去し、再送時の重複
          // バブル（同じ user メッセージが 2 通 + 宙に浮いた空 assistant）を防ぐ。
          set((s) => ({
            messages: s.messages.filter(
              (m) => m.id !== userMsg.id && m.id !== assistantMsg.id,
            ),
            streamingDraft:
              s.streamingDraft?.messageId === assistantMsg.id
                ? null
                : s.streamingDraft,
            isStreaming: false,
          }));
          // 永続 429 での無限リトライ（10 秒ごとに API を叩き続け、messages が
          // 2 通/回で無限増殖）を防ぐため上限を設ける。新規送信は
          // _rateLimitRetry=undefined から始まるのでカウンタは自然にリセットされる。
          const attempt = (options?._rateLimitRetry ?? 0) + 1;
          if (attempt > MAX_RATE_LIMIT_RETRIES || captureCleanupFailed) {
            set({ error: msg });
            return;
          }
          // 送信先セッションを pin。待機中にユーザーがセッション/シーンを切り替えて
          // いたら再送を中止する（別会話への誤送信防止）。
          const retrySessionId = get().activeSessionId;
          setTimeout(() => {
            if (get().activeSessionId !== retrySessionId) return;
            void get().sendMessage(content, commandInstruction, {
              ...options,
              _rateLimitRetry: attempt,
            });
          }, 10_000);
          return;
        } else if (kind === "network") {
          toast.error(i18next.t("chat.networkError"));
        } else {
          toast.error(i18next.t("chat.sendFailed", { message: msg }));
        }

        const failedContextWindowUsage = contextWindowUsageFromError(e);
        set({
          error: msg,
          ...(failedContextWindowUsage
            ? {
                contextTokenCount: failedContextWindowUsage.inputTokens,
                contextWindowUsage: failedContextWindowUsage,
                contextWindowSize: failedContextWindowUsage.contextWindow,
                contextModel: turnRoute?.model ?? null,
                contextProvider: turnRoute?.provider ?? null,
                contextRouteAuthorityKey:
                  resolvedChatTurnRouteAuthorityKey(turnRoute),
              }
            : {}),
        });
      } finally {
        const unresolvedCurrentCapture = captureTurn.resolveFinally(
          capturedWorkspaceIsCurrent(),
        );
        if (isCurrentTurn()) {
          if (!captureTurn.isCaptureOnly()) {
            // isStreaming is set to false inside onDone/onError callbacks
            // but guard here in case of early exit.
            if (get().isStreaming) set({ isStreaming: false });
            turnRuntime.clearActiveRouteIf(turnRoute);
          }
          if (!unresolvedCurrentCapture) turnCoordinator.release(sendControl);
        } else if (!unresolvedCurrentCapture) {
          turnCoordinator.release(sendControl);
        }
      }
    },

    stopGeneration: turnLifecycle.stopGeneration,
  };
}

export function createConfiguredChatTurnStoreActions(
  ports: ChatTurnStoreActionCompositionPorts,
): Pick<ChatState, "sendMessage" | "stopGeneration"> {
  const actions = createChatTurnStoreActions({
    ...ports,
    chatApi,
    cliApi,
    codexAppApi,
    useAiSettingsStore,
    executeTool,
    executeReadOnlyTool,
    recordAiUsage,
    getTreeProjectId,
    getLoadedProjectId,
    getCurrentProjectId,
    isCapturedWorkspaceCurrent,
    captureAgentPreflightAuthority,
    isSameAgentPreflightAuthority,
    resolveCurrentChatTurnPolicy,
    blockIfPolicyOff,
    isAiFeatureBlockedByPolicy,
    blockIfUnlicensed,
    isWriteRestrictedByLicense,
    createSessionForCurrentRuntime,
    fetchRequiredProjectContext,
    resolveModelForPath,
    resolveRolePathConfig,
    getChatApiVariant,
    getPromptCatalog,
    debugLog,
    errorDetail,
    toast,
    i18next,
  });
  return {
    ...actions,
    sendMessage: withChatTurnAdmission(actions.sendMessage, ports.turnRuntime),
  };
}
