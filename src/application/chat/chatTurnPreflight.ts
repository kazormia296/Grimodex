import {
  captureChatContextPreparationSnapshot,
  type ChatContextPreparationSnapshot,
  type ChatContextPreparationSnapshotInput,
} from "./chatContextPreparation";
import { runChatOllamaPreflight } from "./chatOllamaPreflight";
import type { ChatStoreActionPorts } from "./chatStoreActionPorts";
import type { ChatContextTurnSeed, ChatState } from "./chatStoreTypes";
import {
  resolveChatTurnRoutePolicy,
  type AgentPreflightAuthority,
  type AgentPreflightTarget,
  type ChatTurnRoutePolicy,
} from "./chatTurnRouting";
import { TURN_PAYLOAD_SAFETY_MARGIN_TOKENS } from "./chatTurnPayload";
import { resolveAgentPrivacyPlan } from "@/features/chat/agent/agentPrivacy";
import type {
  AgentToolDefinition,
  WebSearchConfig,
} from "@/features/chat/agent/agentTypes";
import { getEffortForTask } from "@/features/chat/agent/modelLimits";
import { countTokens } from "@/features/chat/contextBuilder";
import type { RolePathModel } from "@/features/chat/modelRouting";
import { estimateMessageEnvelopeTokens } from "@/application/chat/chatTurnPayload";
import type { AiSettingsState } from "@/features/chat/store";
import type { AiProvider, AiSettings, AiModel } from "@/features/chat/types";
import type { ChatMessage, ChatSession } from "@/features/chat/chatTypes";
import {
  resolveChatTurnRoute,
  resolvedChatTurnRouteAuthorityKey,
  type ResolvedChatTurnRoute,
} from "@/features/chat/turn/resolveTurnRoute";
import { renderAgentToolPayloads } from "@/features/chat/turn/renderAgentPayload";
import {
  buildWebSearchConfig,
  parseWebSearchControls,
} from "@/features/chat/webSearchConfig";
import type { ImeWorkspaceIdentity } from "@/features/ime/workspaceScope";
import { getPromptCatalog } from "@/prompts/index";

type ChatPreflightAiState = Pick<
  AiSettingsState,
  | "settings"
  | "chatModelOverride"
  | "chatProviderOverride"
  | "chatModelVariantOverride"
  | "chatEndpointIdOverride"
>;

interface CrossProviderChatOverride {
  provider: AiProvider;
  model: string;
  variant: string | undefined;
  endpointId: string | undefined;
}

interface ChatTurnPreflightProviderPorts {
  getAiState: () => ChatPreflightAiState;
  getChatApiVariant: (model: string) => string | undefined;
  getCrossProviderChatOverride: () => CrossProviderChatOverride | null;
  resolveRolePathConfig: (
    pathId: "chat_agent_main" | "chat_stream_non_agent",
    activeProvider: AiProvider,
  ) => RolePathModel | undefined;
  captureAgentAuthority: () => AgentPreflightAuthority;
  isSameAgentAuthority: (
    left: AgentPreflightAuthority,
    right: AgentPreflightAuthority,
  ) => boolean;
  resolveRawAgentTarget: () => AgentPreflightTarget;
  resolveAgentTarget: () => AgentPreflightTarget;
  resolveConversationTarget: () => AgentPreflightTarget;
  resolveCurrentPreflightRoute: (
    surface: "chat" | "agent",
  ) => ResolvedChatTurnRoute | null;
  resolveCurrentTurnPolicy: (input: {
    agentMode: boolean;
    ragEnabled: boolean;
  }) => ChatTurnRoutePolicy;
  refreshDynamicCapsForProvider: (
    provider: "ollama",
    options: {
      force: true;
      selectedModelId: string;
      ollamaEndpoint: string;
      requireOllamaCapabilities: boolean;
    },
  ) => Promise<AiModel[] | null>;
}

interface ChatTurnPreflightRuntimePorts {
  claimSendPreflight: (scopeKey: string) => string | null;
  releaseSendPreflight: (claimId: string) => void;
  isSendPreflightCurrent: (claimId: string) => boolean;
  hasPendingSessionMutations: () => boolean;
  getSessionMutationTail: () => Promise<void>;
  getWorkspaceIdentity: () => ImeWorkspaceIdentity | null;
  isWorkspaceCurrent: (identity: ImeWorkspaceIdentity | null) => boolean;
  getCurrentProjectId: () => string;
  blockIfPolicyOff: () => boolean;
  blockIfUnlicensed: () => boolean;
  snapshotAgentTools: () => AgentToolDefinition[];
  readSetting: (key: string, defaultValue: string) => string;
  translate: (key: string, options?: Record<string, unknown>) => string;
  notifyError: (message: string) => void;
  randomUuid: () => string;
  nowIso: () => string;
}

export interface ChatTurnPreflightOptions {
  overrideAgentMode?: boolean;
  _replaceAssistantMessageId?: string;
}

export interface ChatTurnPreflightInput {
  content: string;
  commandInstruction?: string;
  options?: ChatTurnPreflightOptions;
}

export interface ChatTurnPreflightResult {
  readonly turnWorkspaceIdentity: ImeWorkspaceIdentity | null;
  readonly activeSceneId: string;
  readonly activeSessionId: string | null;
  readonly chatScope: ChatState["chatScope"];
  readonly scopeAnchorId: string | null;
  readonly threadFocusOverride: ChatState["threadFocusOverride"];
  readonly capturedRagEnabled: boolean;
  readonly capturedMessages: ChatMessage[];
  readonly initialMessages: ChatMessage[];
  readonly replacementAssistantMessageId: string | null;
  readonly preflightAuthority: AgentPreflightAuthority;
  readonly agentModeForThisSend: boolean;
  readonly turnAgentToolsSnapshot: AgentToolDefinition[];
  readonly effectiveSceneId: string | null;
  readonly turnRoute: ResolvedChatTurnRoute | null;
  readonly ragActive: boolean;
  readonly useAgentPath: boolean;
  readonly publicWebSearchPath: boolean;
  readonly turnRouteAuthorityKey: string | null;
  readonly webSearchConfigAtTurnStart: WebSearchConfig | null;
  readonly contextInputOverheadTokens: number;
  readonly turnProjectId: string;
  readonly preparationSeed: ChatContextTurnSeed;
  readonly preparationSnapshot: ChatContextPreparationSnapshot | undefined;
  readonly sessionId: string;
  readonly userMsg: ChatMessage;
  readonly assistantMsg: ChatMessage;
  readonly aiSettingsEarly: AiSettings | null;
  readonly chatModelEarly: string;
  readonly xprov: CrossProviderChatOverride | null;
}

export type ChatTurnPreflightDecision =
  | ChatTurnPreflightResult
  | null
  | Promise<ChatTurnPreflightResult | null>;

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return value instanceof Promise;
}

export function createChatTurnPreflight(
  ports: ChatStoreActionPorts & {
    provider: ChatTurnPreflightProviderPorts;
    runtime: ChatTurnPreflightRuntimePorts;
  },
): (input: ChatTurnPreflightInput) => ChatTurnPreflightDecision {
  const { get, set, provider, runtime } = ports;

  return ({ content, commandInstruction, options }) => {
    const captureSendPreflightScopeKey = (): string => {
      const state = get();
      return JSON.stringify([
        runtime.getWorkspaceIdentity(),
        state.activeProjectId,
        state.activeSessionId,
        state.activeSceneId,
        state.chatScope,
        state.scopeAnchorId,
        state.threadFocusOverride?.threadId ?? null,
        state.agentMode,
        state.ragEnabled,
        state.messages,
        provider.captureAgentAuthority(),
      ]);
    };
    const captureSendInvocationAiAuthority = (): string => {
      const state = get();
      return (
        JSON.stringify([
          state.agentMode,
          state.ragEnabled,
          provider.captureAgentAuthority(),
          resolvedChatTurnRouteAuthorityKey(
            provider.resolveCurrentTurnPolicy({
              agentMode: state.agentMode,
              ragEnabled: state.ragEnabled,
            }).route,
          ),
        ]) ?? ""
      );
    };

    const sendPreflightScopeKey = captureSendPreflightScopeKey();
    const sendInvocationAiAuthority = captureSendInvocationAiAuthority();
    const sendPreflightClaimId = runtime.claimSendPreflight(
      sendPreflightScopeKey,
    );
    if (sendPreflightClaimId === null) return null;
    const releaseSendPreflightClaim = (): void => {
      runtime.releaseSendPreflight(sendPreflightClaimId);
    };

    const prepareAfterSessionMutations = (): ChatTurnPreflightDecision => {
      const turnWorkspaceIdentity = runtime.getWorkspaceIdentity();
      const {
        isStreaming,
        isLoadingSessions,
        isLoadingMessages,
        activeSceneId,
        activeProjectId,
        activeSessionId,
        chatScope,
        scopeAnchorId,
        threadFocusOverride,
        ragEnabled: capturedRagEnabled,
        messages: capturedMessages,
        sessions: initialSessions,
      } = get();
      if (isStreaming || isLoadingSessions || isLoadingMessages) {
        releaseSendPreflightClaim();
        return null;
      }

      const replacementAssistantMessageId =
        options?._replaceAssistantMessageId ?? null;
      const replacementAssistantMessage = replacementAssistantMessageId
        ? capturedMessages.find(
            (message) => message.id === replacementAssistantMessageId,
          )
        : undefined;
      if (
        replacementAssistantMessageId &&
        (replacementAssistantMessage?.role !== "assistant" ||
          replacementAssistantMessage.sessionId !== activeSessionId)
      ) {
        releaseSendPreflightClaim();
        return null;
      }
      const initialMessages = replacementAssistantMessageId
        ? capturedMessages.filter(
            (message) => message.id !== replacementAssistantMessageId,
          )
        : capturedMessages;

      // A new send invalidates the previous turn's continuation.
      if (get().agentContinuation) set({ agentContinuation: null });
      if (runtime.blockIfPolicyOff()) {
        releaseSendPreflightClaim();
        return null;
      }
      if (runtime.blockIfUnlicensed()) {
        releaseSendPreflightClaim();
        return null;
      }

      const agentModeForPreflight =
        options?.overrideAgentMode ?? get().agentMode;
      const preflightAuthority = provider.captureAgentAuthority();
      const isOllamaAuthorityCurrent = (): boolean => {
        const current = get();
        const sameAiAuthority = provider.isSameAgentAuthority(
          preflightAuthority,
          provider.captureAgentAuthority(),
        );
        const sameThreadFocus =
          current.threadFocusOverride?.threadId ===
          threadFocusOverride?.threadId;
        const sameRequestedAgentMode =
          options?.overrideAgentMode !== undefined ||
          current.agentMode === agentModeForPreflight;
        return (
          !current.isStreaming &&
          !current.isLoadingSessions &&
          !current.isLoadingMessages &&
          current.activeSceneId === activeSceneId &&
          current.activeProjectId === activeProjectId &&
          current.activeSessionId === activeSessionId &&
          current.chatScope === chatScope &&
          current.scopeAnchorId === scopeAnchorId &&
          current.ragEnabled === capturedRagEnabled &&
          current.messages === capturedMessages &&
          sameAiAuthority &&
          sameThreadFocus &&
          sameRequestedAgentMode &&
          runtime.isSendPreflightCurrent(sendPreflightClaimId) &&
          runtime.isWorkspaceCurrent(turnWorkspaceIdentity)
        );
      };

      const ollamaDecision = (() => {
        try {
          return runChatOllamaPreflight(
            { agentMode: agentModeForPreflight },
            {
              resolveRawAgentTarget: provider.resolveRawAgentTarget,
              resolveAgentTarget: provider.resolveAgentTarget,
              resolveConversationTarget: provider.resolveConversationTarget,
              resolveCurrentRoute: provider.resolveCurrentPreflightRoute,
              refreshSelectedModel: (target, requireCapabilities) =>
                provider.refreshDynamicCapsForProvider("ollama", {
                  force: true,
                  selectedModelId: target.model,
                  ollamaEndpoint: target.ollamaEndpoint,
                  requireOllamaCapabilities: requireCapabilities,
                }),
              awaitPendingSessionMutations: () =>
                runtime.hasPendingSessionMutations()
                  ? runtime.getSessionMutationTail()
                  : undefined,
              isAuthorityCurrent: isOllamaAuthorityCurrent,
              blockIfPolicyOff: runtime.blockIfPolicyOff,
              blockIfUnlicensed: runtime.blockIfUnlicensed,
              translate: runtime.translate,
              setError: (message) => set({ error: message }),
              notifyError: runtime.notifyError,
            },
          );
        } catch (error) {
          releaseSendPreflightClaim();
          throw error;
        }
      })();

      const finishAfterOllama = (
        preflightRouteAuthorityKey: string | null,
      ): ChatTurnPreflightResult | null => {
        const aiSettingsEarly = provider.getAiState().settings;
        const chatModelEarly =
          provider.getAiState().chatModelOverride ??
          aiSettingsEarly?.model ??
          "";
        if (
          get()._lastCachedModel &&
          chatModelEarly &&
          get()._lastCachedModel !== chatModelEarly
        ) {
          set({ cacheInvalidatedReason: "model" });
        } else {
          set({ cacheInvalidatedReason: null });
        }
        const existingAgentToolsSnapshot = get().sessionAgentToolsSnapshot;
        const turnAgentToolsSnapshot = existingAgentToolsSnapshot
          ? structuredClone(existingAgentToolsSnapshot)
          : runtime.snapshotAgentTools();
        if (!existingAgentToolsSnapshot) {
          set({ sessionAgentToolsSnapshot: turnAgentToolsSnapshot });
        }
        set({ _lastCachedModel: chatModelEarly });

        const effectiveSceneId =
          chatScope === "scene" && !threadFocusOverride ? activeSceneId : null;
        const agentModeForThisSend =
          options?.overrideAgentMode ?? get().agentMode;
        const aiSendState = provider.getAiState();
        const xprov = provider.getCrossProviderChatOverride();
        const composerModel = aiSendState.chatModelOverride;
        const resolveRouteForSurface = (
          surface: "chat" | "agent",
        ): ResolvedChatTurnRoute | null => {
          if (!aiSendState.settings) return null;
          const role = provider.resolveRolePathConfig(
            surface === "agent" ? "chat_agent_main" : "chat_stream_non_agent",
            aiSendState.settings.provider,
          );
          return resolveChatTurnRoute({
            surface,
            activeSettings: aiSendState.settings,
            activeApiVariant: provider.getChatApiVariant(
              aiSendState.settings.model,
            ),
            composer: composerModel
              ? {
                  model: composerModel,
                  provider: xprov?.provider ?? null,
                  apiVariant: xprov
                    ? (xprov.variant ?? null)
                    : (provider.getChatApiVariant(composerModel) ?? null),
                  endpointId: xprov?.endpointId ?? null,
                }
              : null,
            role: role
              ? {
                  model: role.model,
                  provider: role.provider,
                  apiVariant: role.provider
                    ? role.variant
                    : provider.getChatApiVariant(role.model),
                  endpointId: role.endpointId,
                }
              : null,
            taskEffort: getEffortForTask(surface),
            thinkingDisplay: "summarized",
            thinkingEnabled: aiSendState.settings.thinkingEnabled,
            reasoningEffortOverride:
              aiSendState.settings.reasoningEffortOverride ?? undefined,
          });
        };

        const turnPolicy = resolveChatTurnRoutePolicy({
          agentMode: agentModeForThisSend,
          ragEnabled: capturedRagEnabled,
          resolveRouteForSurface,
        });
        const {
          route: turnRoute,
          ragActive,
          useAgentPath,
          publicWebSearchPath,
        } = turnPolicy;
        if (
          resolvedChatTurnRouteAuthorityKey(turnRoute) !==
          preflightRouteAuthorityKey
        ) {
          return null;
        }
        const turnRouteAuthorityKey =
          resolvedChatTurnRouteAuthorityKey(turnRoute);
        const webSearchControlsAtTurnStart = parseWebSearchControls({
          domainMode: runtime.readSetting("ai.webSearch.domainMode", "off"),
          domainsJson: runtime.readSetting("ai.webSearch.domains", "[]"),
          maxContentTokensRaw: runtime.readSetting(
            "ai.webSearch.maxContentTokens",
            "",
          ),
        });
        const configuredWebSearchConfigAtTurnStart: WebSearchConfig | null =
          buildWebSearchConfig(
            ragActive,
            agentModeForThisSend,
            webSearchControlsAtTurnStart,
          );
        const agentPrivacyPlan = resolveAgentPrivacyPlan({
          agentMode: agentModeForThisSend,
          ragActive,
          webSearchConfig: configuredWebSearchConfigAtTurnStart,
        });
        const webSearchConfigAtTurnStart = agentPrivacyPlan.webSearchConfig;
        const privacyPlanUsesPublicWeb =
          agentPrivacyPlan.contextMode === "public-web";
        if (privacyPlanUsesPublicWeb !== publicWebSearchPath) {
          throw new Error("chat route privacy policy mismatch");
        }
        const useHermesRagInstruction =
          publicWebSearchPath && turnRoute?.toolProtocol === "hermes";
        const ragInstructionTokenReserve = publicWebSearchPath
          ? Math.max(
              ...(["ja", "en"] as const).map((language) => {
                const control = getPromptCatalog(language).agentControl;
                const instruction = useHermesRagInstruction
                  ? control.webSearchInstructionHermes
                  : control.webSearchInstruction;
                return countTokens(`\n\n${instruction}`);
              }),
            )
          : 0;
        const publicCommandInstructionTokenReserve =
          publicWebSearchPath && commandInstruction
            ? countTokens(commandInstruction)
            : 0;
        const contextInputOverheadTokens =
          TURN_PAYLOAD_SAFETY_MARGIN_TOKENS +
          ragInstructionTokenReserve +
          publicCommandInstructionTokenReserve +
          (useAgentPath && turnRoute
            ? renderAgentToolPayloads(
                turnRoute,
                agentModeForThisSend ? turnAgentToolsSnapshot : [],
                webSearchConfigAtTurnStart,
              ).reduce((sum, payload) => sum + countTokens(payload), 0)
            : estimateMessageEnvelopeTokens([
                { role: "system", content: "" },
                ...initialMessages
                  .filter((message) => !message.isSummarized)
                  .map((message) => ({
                    role: message.role,
                    content: message.content,
                  })),
                { role: "user", content },
              ]));
        const turnProjectId = activeProjectId ?? runtime.getCurrentProjectId();
        const activeSessionAtTurnStart = activeSessionId
          ? initialSessions.find(
              (session: ChatSession) => session.id === activeSessionId,
            )
          : undefined;
        if (
          activeSessionAtTurnStart &&
          activeSessionAtTurnStart.projectId !== turnProjectId
        ) {
          set({ error: "chat session project mismatch" });
          return null;
        }
        const contextStateAtTurnStart = get();
        const preparationSeed: ChatContextTurnSeed = {
          projectId: turnProjectId,
          ...(turnWorkspaceIdentity
            ? {
                workspaceIdentity: {
                  workspaceKey: turnWorkspaceIdentity.path,
                  workspaceOpenRevision: turnWorkspaceIdentity.openRevision,
                },
              }
            : {}),
          effectiveSceneId: publicWebSearchPath ? null : effectiveSceneId,
          activeSceneId,
          activeProjectId,
          chatScope,
          scopeAnchorId,
          threadFocus: threadFocusOverride
            ? {
                threadId: threadFocusOverride.threadId,
                title: threadFocusOverride.title,
              }
            : null,
          inputPinnedEntryIds: [...contextStateAtTurnStart.inputPinnedEntryIds],
          excludedAutoEntryIds: [
            ...contextStateAtTurnStart.excludedAutoEntryIds,
          ],
          sessionStableCodexIds: [
            ...contextStateAtTurnStart.sessionStableCodexIds,
          ],
          sessionStableContextInitialized:
            contextStateAtTurnStart.sessionStableContextInitialized,
          includeBodies: contextStateAtTurnStart.includeBodies,
          includeMapBoard: contextStateAtTurnStart.includeMapBoard,
          mapBoardId: contextStateAtTurnStart.mapBoardId,
        };
        const snapshotInput: ChatContextPreparationSnapshotInput = {
          privacy: publicWebSearchPath ? "public-web" : "private",
          projectId: preparationSeed.projectId,
          effectiveSceneId: preparationSeed.effectiveSceneId,
          activeSceneId: preparationSeed.activeSceneId,
          activeProjectId: preparationSeed.activeProjectId,
          chatScope: preparationSeed.chatScope,
          scopeAnchorId: preparationSeed.scopeAnchorId,
          threadFocus: preparationSeed.threadFocus,
          includeMapBoard: preparationSeed.includeMapBoard,
          mapBoardId: preparationSeed.mapBoardId,
        };
        const preparationSnapshot =
          captureChatContextPreparationSnapshot(snapshotInput);
        const sessionId = activeSessionId ?? "";
        const userMsg: ChatMessage = {
          id: runtime.randomUuid(),
          sessionId,
          role: "user",
          content,
          createdAt: runtime.nowIso(),
        };
        const assistantMsg: ChatMessage = {
          id: runtime.randomUuid(),
          sessionId,
          role: "assistant",
          content: "",
          createdAt: runtime.nowIso(),
        };

        return Object.freeze({
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
        });
      };

      const captureRouteAuthorityKey = (
        ollamaReady: boolean,
      ): { routeAuthorityKey: string | null } | null => {
        if (!ollamaReady) return null;
        return {
          routeAuthorityKey: resolvedChatTurnRouteAuthorityKey(
            provider.resolveCurrentTurnPolicy({
              agentMode: agentModeForPreflight,
              ragEnabled: capturedRagEnabled,
            }).route,
          ),
        };
      };

      if (isPromise(ollamaDecision)) {
        return ollamaDecision.then(
          (ollamaReady) => {
            let outcome: {
              routeAuthorityKey: string | null;
            } | null;
            try {
              outcome = captureRouteAuthorityKey(ollamaReady);
            } finally {
              releaseSendPreflightClaim();
            }
            return outcome
              ? finishAfterOllama(outcome.routeAuthorityKey)
              : null;
          },
          (error: unknown) => {
            releaseSendPreflightClaim();
            throw error;
          },
        );
      }

      let outcome: { routeAuthorityKey: string | null } | null;
      try {
        outcome = captureRouteAuthorityKey(ollamaDecision);
      } finally {
        releaseSendPreflightClaim();
      }
      return outcome ? finishAfterOllama(outcome.routeAuthorityKey) : null;
    };

    // Preserve Send's synchronous authority snapshot on the normal fast path.
    // Only a queued session mutation or an Ollama selected-model probe yields.
    if (runtime.hasPendingSessionMutations()) {
      return runtime.getSessionMutationTail().then(
        () => {
          if (
            captureSendInvocationAiAuthority() !== sendInvocationAiAuthority
          ) {
            releaseSendPreflightClaim();
            return null;
          }
          return prepareAfterSessionMutations();
        },
        (error: unknown) => {
          releaseSendPreflightClaim();
          throw error;
        },
      );
    }
    return prepareAfterSessionMutations();
  };
}
