import { advanceActiveLifecycleTransition } from "@/application/lifecycle/lifecycleTrace";
import type { ImeWorkspaceIdentity } from "@/features/ime/workspaceScope";
import type { ChatMessage } from "@/features/chat/chatTypes";
import { reserveChatMessageAdds } from "@/features/timelapse/captureChat";
import type { ChatStoreActionPorts } from "./chatStoreActionPorts";
import type { ChatTurnRuntime } from "./chatTurnRuntime";
import type { ChatState } from "./chatStoreTypes";
import {
  parseMetadataRecord,
  type AssistantRowReservation,
} from "./chatAssistantRowReservation";
import type { ResolvedChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";
import type { LayerBreakdown } from "@/features/chat/contextBuilder";
import type { TurnControl } from "@/features/chat/turn/turnCoordinator";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import { buildInputTokenDriftMetadata } from "@/features/ai-usage/inputTokenDrift";
import type {
  InputTokenDriftTotals,
  InputTokenEstimatorFamily,
  InputTokenRouteSnapshot,
} from "@/features/ai-usage/inputTokenDrift";
import { useAiSettingsStore } from "@/features/chat/store";
import {
  ChatTurnPersistenceError,
  createRetryableCompletedTurnPersistence,
} from "./chatTurnPersistence";

type ChatApi = typeof import("@/features/chat/chatApi");

export function createTurnRecovery(input: {
  runtime: ChatTurnRuntime;
  turnId: string;
  workspaceIdentity: ImeWorkspaceIdentity | null;
  projectId: string;
  userMessage: ChatMessage;
  content: string;
  chatApi: Pick<
    ChatApi,
    | "addMessage"
    | "generateSessionTitle"
    | "getSessionForProject"
    | "saveMessagePrompt"
    | "updateSessionTitleIfAutomatic"
  >;
  get: ChatStoreActionPorts["get"];
  set: ChatStoreActionPorts["set"];
  isCapturedWorkspaceCurrent: () => boolean;
  isCapturedProjectCurrent: () => boolean;
  isCurrentTurn: () => boolean;
  isAborted: () => boolean;
  transportStarted: () => boolean;
  isAgentPath: boolean;
  transport: string | null;
  getSessionId: () => string | null;
  chatScope: ChatState["chatScope"];
  scopeAnchorId: string | null;
  options?: { mentionedSceneIds?: string[] };
  assistantMessage: ChatMessage;
  getObservedResponseText: () => string;
  model: string | null | undefined;
  routeModel: string | undefined;
  isAiFeatureBlockedByPolicy: (feature: "chat") => boolean;
  isWriteRestrictedByLicense: () => boolean;
  classifyError: (
    error: unknown,
  ) => "auth" | "rate_limit" | "network" | "context_length" | "unknown";
  aiFailureToastText: (key: string, message: string) => string;
  toast: {
    error: (message: string) => void;
    warning: (message: string) => void;
  };
  i18next: { t: (key: string) => string };
  debugLog: {
    error: (scope: string, operation: string, detail: string) => void;
    warn: (scope: string, operation: string, detail: string) => void;
  };
  errorDetail: (error: unknown) => string;
}): {
  createAgentTurnPersistence: (input: {
    sessionId: string | null;
    userMetadata?: string;
    promptSnapshot: string;
    layers: LayerBreakdown[];
    totalTokens: number | null;
    model: string | null;
    route: ResolvedChatTurnRoute | null;
    assistantRow: AssistantRowReservation;
    lastMessage: ChatMessage | undefined;
    agentModel: string | undefined;
    agentTokensIn: number | null;
    agentTokensOut: number | null;
    metadata: string;
    outputTruncated: boolean;
    commitAssistantReplacement: () => Promise<void>;
    finalize: () => Promise<void>;
  }) => ReturnType<typeof createRetryableCompletedTurnPersistence>;
  finalizeAgentTurn: (input: {
    sessionId: string | null;
    lastMessage: ChatMessage | undefined;
    previousMessages: readonly ChatMessage[];
    content: string;
    model: string | undefined;
    provider: string | null | undefined;
    tokensIn: number | null;
    tokensOut: number | null;
    cacheTotals: InputTokenDriftTotals;
    cost: number | null;
    messageId: string;
    usageRoute: InputTokenRouteSnapshot | null;
    estimatorFamily: InputTokenEstimatorFamily;
    language: string;
    contextPlanDigest: string | null;
    titleLanguage: string;
  }) => void;
  persistCompletedTurn: (input: {
    retry: () => Promise<void>;
    sessionId: string;
    userMetadata?: string;
    assistantMessage?: ChatMessage;
  }) => Promise<void>;
  preserveFailedAnchoredTurn: (error: unknown) => Promise<boolean>;
  hasManualSessionTitleInStore: (sessionId: string) => boolean;
  hasManualSessionTitle: (
    sessionId: string,
    projectId: string,
  ) => Promise<boolean>;
  finalizeStoppedAgentTurnAfterTransport: (input: {
    canFinalize: () => boolean;
    get: ChatStoreActionPorts["get"];
    set: ChatStoreActionPorts["set"];
    assistantMessageId: string;
    getSessionId: () => string | null;
    options?: { mentionedSceneIds?: string[] };
    userMessage: ChatMessage;
    content: string;
    getPromptSnapshot: () => string;
    getSystemPrompt: () => string;
    getLayers: () => LayerBreakdown[];
    getTokenCount: () => number | null;
    getModel: () => string;
    route: ResolvedChatTurnRoute | null;
    chatApi: Pick<ChatApi, "addMessage" | "saveMessagePrompt">;
    assistantRow: AssistantRowReservation;
    persistCompletedTurn: (input: {
      retry: () => Promise<void>;
      sessionId: string;
      userMetadata?: string;
      assistantMessage?: ChatMessage;
    }) => Promise<void>;
    commitAssistantReplacement: () => Promise<void>;
    turnCoordinator: {
      transition: (control: TurnControl, state: "persisting") => boolean;
    };
    sendControl: TurnControl;
    debugLog: {
      warn: (scope: string, operation: string, detail: string) => void;
    };
    errorDetail: (error: unknown) => string;
  }) => Promise<boolean>;
} {
  const {
    runtime,
    turnId,
    workspaceIdentity,
    projectId,
    userMessage,
    content,
    chatApi,
    get,
  } = input;
  const persistCompletedTurn = async (turn: {
    retry: () => Promise<void>;
    sessionId: string;
    userMetadata?: string;
    assistantMessage?: ChatMessage;
  }): Promise<void> => {
    await runtime.persistCompletedTurn({
      turnId,
      workspaceIdentity,
      projectId,
      sessionId: turn.sessionId,
      userMessage: {
        ...userMessage,
        sessionId: turn.sessionId,
        content,
        ...(turn.userMetadata ? { metadata: turn.userMetadata } : {}),
      },
      ...(turn.assistantMessage
        ? {
            assistantMessage: {
              ...turn.assistantMessage,
              sessionId: turn.sessionId,
            },
          }
        : {}),
      onRegister: () => {
        const reservation = reserveChatMessageAdds([
          {
            projectId,
            sessionId: turn.sessionId,
            messageId: userMessage.id,
            role: "user",
            text: content,
            createdAt: userMessage.createdAt,
          },
          ...(turn.assistantMessage
            ? [
                {
                  projectId,
                  sessionId: turn.sessionId,
                  messageId: turn.assistantMessage.id,
                  role: turn.assistantMessage.role,
                  text: turn.assistantMessage.content,
                  model: turn.assistantMessage.model,
                  createdAt: turn.assistantMessage.createdAt,
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
        // A completed turn can predate a later retrying lifecycle. Emit both
        // durability boundaries in whichever transition drains the retained payload.
        advanceActiveLifecycleTransition("old-stream-completed");
        try {
          await turn.retry();
        } catch (error) {
          throw error instanceof ChatTurnPersistenceError
            ? error
            : new ChatTurnPersistenceError(error);
        }
        advanceActiveLifecycleTransition("old-scope-persisted");
      },
    });
  };

  const hasManualSessionTitleInStore = (sessionId: string): boolean => {
    const session = get().sessions.find(
      (candidate) => candidate.id === sessionId,
    );
    return Boolean(session && session.titleManual !== 0);
  };
  const hasManualSessionTitle = async (
    sessionId: string,
    sessionProjectId: string,
  ): Promise<boolean> => {
    if (hasManualSessionTitleInStore(sessionId)) return true;
    const session = await chatApi.getSessionForProject(
      sessionId,
      sessionProjectId,
    );
    return (
      hasManualSessionTitleInStore(sessionId) ||
      Boolean(session && session.titleManual !== 0)
    );
  };

  const preserveFailedAnchoredTurn = async (
    error: unknown,
  ): Promise<boolean> => {
    const current = get();
    const anchoredScope =
      input.chatScope === "folder" ||
      input.chatScope === "codex" ||
      input.chatScope === "snippet";
    if (
      !input.transportStarted() ||
      input.isAborted() ||
      !input.isCurrentTurn() ||
      input.isAgentPath ||
      input.transport !== "http" ||
      !input.getSessionId() ||
      !anchoredScope ||
      !input.scopeAnchorId ||
      current.chatScope !== input.chatScope ||
      current.scopeAnchorId === null ||
      current.scopeAnchorId === input.scopeAnchorId ||
      current.activeProjectId !== projectId ||
      !input.isCapturedWorkspaceCurrent() ||
      !input.isCapturedProjectCurrent() ||
      input.isAiFeatureBlockedByPolicy("chat") ||
      input.isWriteRestrictedByLicense()
    ) {
      return false;
    }

    if (error instanceof ChatTurnPersistenceError) {
      input.toast.error(
        input.i18next.t("chat.pendingCompletedTurnPersistence"),
      );
      return true;
    }

    const failureMessage =
      error instanceof Error ? error.message : String(error);
    const userMetadata =
      input.options?.mentionedSceneIds &&
      input.options.mentionedSceneIds.length > 0
        ? JSON.stringify({
            mentioned_scene_ids: input.options.mentionedSceneIds,
          })
        : undefined;
    const failedAssistant = input.getObservedResponseText()
      ? {
          ...input.assistantMessage,
          sessionId: input.getSessionId()!,
          content: input.getObservedResponseText(),
          model: input.routeModel ?? input.model ?? null,
          metadata: JSON.stringify({ runtime_error: failureMessage }),
        }
      : undefined;
    const retry = createRetryableCompletedTurnPersistence({
      persistUser: async () => {
        await chatApi.addMessage(input.getSessionId()!, "user", content, {
          id: userMessage.id,
          createdAt: userMessage.createdAt,
          recordTimelapse: false,
          ...(userMetadata ? { metadata: userMetadata } : {}),
        });
      },
      ...(failedAssistant
        ? {
            persistAssistant: async () => {
              await chatApi.addMessage(
                input.getSessionId()!,
                "assistant",
                failedAssistant.content,
                {
                  id: failedAssistant.id,
                  model: failedAssistant.model ?? undefined,
                  metadata: failedAssistant.metadata ?? undefined,
                  createdAt: failedAssistant.createdAt,
                  recordTimelapse: false,
                },
              );
            },
          }
        : {}),
    });
    try {
      await persistCompletedTurn({
        retry,
        sessionId: input.getSessionId()!,
        ...(userMetadata ? { userMetadata } : {}),
        ...(failedAssistant ? { assistantMessage: failedAssistant } : {}),
      });
    } catch (persistenceError) {
      input.debugLog.error(
        "ChatStore",
        "preserve failed anchored turn",
        input.errorDetail(persistenceError),
      );
      input.toast.error(
        input.i18next.t("chat.pendingCompletedTurnPersistence"),
      );
    }

    const kind = input.classifyError(error);
    if (kind === "auth") {
      input.toast.error(input.i18next.t("chat.invalidApiKey"));
    } else if (kind === "rate_limit") {
      input.toast.warning(input.i18next.t("chat.rateLimited"));
    } else if (kind === "network") {
      input.toast.error(input.i18next.t("chat.networkError"));
    } else {
      input.toast.error(
        input.aiFailureToastText("chat.sendFailed", failureMessage),
      );
    }
    return true;
  };

  const finalizeStoppedAgentTurnAfterTransport = async (args: {
    canFinalize: () => boolean;
    get: ChatStoreActionPorts["get"];
    set: ChatStoreActionPorts["set"];
    assistantMessageId: string;
    getSessionId: () => string | null;
    options?: { mentionedSceneIds?: string[] };
    userMessage: ChatMessage;
    content: string;
    getPromptSnapshot: () => string;
    getSystemPrompt: () => string;
    getLayers: () => LayerBreakdown[];
    getTokenCount: () => number | null;
    getModel: () => string;
    route: ResolvedChatTurnRoute | null;
    chatApi: Pick<ChatApi, "addMessage" | "saveMessagePrompt">;
    assistantRow: AssistantRowReservation;
    persistCompletedTurn: (input: {
      retry: () => Promise<void>;
      sessionId: string;
      userMetadata?: string;
      assistantMessage?: ChatMessage;
    }) => Promise<void>;
    commitAssistantReplacement: () => Promise<void>;
    turnCoordinator: {
      transition: (control: TurnControl, state: "persisting") => boolean;
    };
    sendControl: TurnControl;
    debugLog: {
      warn: (scope: string, operation: string, detail: string) => void;
    };
    errorDetail: (error: unknown) => string;
  }): Promise<boolean> => {
    if (!args.canFinalize()) return false;
    const sessionId = args.getSessionId();
    const assistant = args
      .get()
      .messages.find((message) => message.id === args.assistantMessageId);
    const stoppedMetadata = JSON.stringify({
      ...parseMetadataRecord(assistant?.metadata),
      stopped: true,
    });
    args.set((state) => ({
      messages: state.messages.map((message) =>
        message.id === args.assistantMessageId
          ? { ...message, metadata: stoppedMetadata }
          : message,
      ),
    }));

    const userMetadata =
      args.options?.mentionedSceneIds &&
      args.options.mentionedSceneIds.length > 0
        ? JSON.stringify({
            mentioned_scene_ids: args.options.mentionedSceneIds,
          })
        : undefined;
    const promptSnapshot = args.getPromptSnapshot() || args.getSystemPrompt();
    const latestAssistant = args
      .get()
      .messages.find((message) => message.id === args.assistantMessageId);
    const recoverableStoppedAssistant =
      latestAssistant?.role === "assistant" &&
      latestAssistant.content &&
      sessionId
        ? {
            ...latestAssistant,
            sessionId,
            model: args.getModel() || null,
            metadata: stoppedMetadata,
          }
        : undefined;
    args.turnCoordinator.transition(args.sendControl, "persisting");
    const retry = createRetryableCompletedTurnPersistence({
      persistUser: async () => {
        if (!sessionId) return;
        await args.chatApi.addMessage(sessionId, "user", args.content, {
          id: args.userMessage.id,
          createdAt: args.userMessage.createdAt,
          recordTimelapse: false,
          ...(userMetadata ? { metadata: userMetadata } : {}),
        });
        if (promptSnapshot) {
          void args.chatApi
            .saveMessagePrompt(args.userMessage.id, {
              systemPrompt: promptSnapshot,
              layers: args.getLayers(),
              totalTokens: args.getTokenCount(),
              model: args.getModel() || null,
              provider: args.route?.provider ?? null,
              contextWindow: args.route?.contextWindow ?? null,
            })
            .catch((error) =>
              args.debugLog.warn(
                "ChatStore",
                "saveMessagePrompt",
                args.errorDetail(error),
              ),
            );
        }
      },
      ...(sessionId && (latestAssistant?.content || args.assistantRow.reserved)
        ? {
            persistAssistant: async () => {
              await args.assistantRow.persist(
                sessionId,
                latestAssistant?.content ?? "",
                {
                  model: args.getModel() || undefined,
                  metadata: stoppedMetadata,
                },
              );
              await args.commitAssistantReplacement();
            },
          }
        : {}),
    });
    try {
      await args.persistCompletedTurn({
        retry,
        sessionId: sessionId!,
        ...(userMetadata ? { userMetadata } : {}),
        ...(recoverableStoppedAssistant
          ? { assistantMessage: recoverableStoppedAssistant }
          : {}),
      });
    } catch (error) {
      args.debugLog.warn(
        "ChatStore",
        "persist stopped agent turn",
        args.errorDetail(error),
      );
      throw error;
    }
    return true;
  };

  return {
    createAgentTurnPersistence(turn) {
      return createRetryableCompletedTurnPersistence({
        persistUser: async () => {
          if (!turn.sessionId) return;
          await chatApi.addMessage(turn.sessionId, "user", content, {
            id: userMessage.id,
            createdAt: userMessage.createdAt,
            recordTimelapse: false,
            ...(turn.userMetadata ? { metadata: turn.userMetadata } : {}),
          });
          if (turn.promptSnapshot) {
            // Cache/plain のうち最後の Agent iteration が実際に送った
            // system representation を、user行の確定後に保存する。
            void chatApi
              .saveMessagePrompt(userMessage.id, {
                systemPrompt: turn.promptSnapshot,
                layers: turn.layers,
                totalTokens: turn.totalTokens,
                model: turn.model || null,
                provider: turn.route?.provider ?? null,
                contextWindow: turn.route?.contextWindow ?? null,
              })
              .catch((error) =>
                input.debugLog.warn(
                  "ChatStore",
                  "saveMessagePrompt",
                  input.errorDetail(error),
                ),
              );
          }
        },
        ...(turn.sessionId &&
        turn.lastMessage?.role === "assistant" &&
        (turn.lastMessage.content ||
          turn.assistantRow.reserved ||
          turn.outputTruncated)
          ? {
              persistAssistant: async () => {
                await turn.assistantRow.persist(
                  turn.sessionId!,
                  turn.lastMessage?.content ?? "",
                  {
                    model: turn.agentModel,
                    tokensIn: turn.agentTokensIn ?? undefined,
                    tokensOut: turn.agentTokensOut ?? undefined,
                    metadata: turn.metadata,
                  },
                );
                await turn.commitAssistantReplacement();
              },
            }
          : {}),
        finalize: turn.finalize,
      });
    },

    finalizeAgentTurn(turn) {
      if (
        !turn.sessionId ||
        turn.lastMessage?.role !== "assistant" ||
        !turn.lastMessage.content
      ) {
        return;
      }
      // N4: エージェントターンの usage を台帳にも記録
      // (cost は OpenRouter 実値)。
      void recordAiUsage({
        surface: "agent",
        model: turn.model,
        provider: turn.provider,
        projectId,
        tokensIn: turn.tokensIn,
        tokensOut: turn.tokensOut,
        cacheReadTokens: turn.cacheTotals.cacheReadTokens,
        cacheWriteTokens: turn.cacheTotals.cacheWriteTokens,
        costUsd: turn.cost,
        traceId: turn.messageId,
        refId: turn.messageId,
        metadata: turn.usageRoute
          ? buildInputTokenDriftMetadata({
              scope: "agent-parent",
              projectId,
              route: turn.usageRoute,
              estimatorFamily: turn.estimatorFamily,
              language: turn.language,
              contextPlanDigest: turn.contextPlanDigest,
              totals: turn.cacheTotals,
            })
          : null,
      });

      const firstAgentResponse =
        turn.previousMessages.filter((message) => message.role === "assistant")
          .length === 0;
      const currentSession = get().sessions.find(
        (session) => session.id === turn.sessionId,
      );
      if (!firstAgentResponse || currentSession?.titleManual !== 0) return;
      const titleModel = useAiSettingsStore.getState().settings?.model ?? "";
      const titleGeneration = chatApi
        .generateSessionTitle(
          content,
          turn.lastMessage.content,
          titleModel,
          turn.titleLanguage,
          projectId,
        )
        .then(async (title) => {
          if (!title) title = content.slice(0, 30);
          const updated = await chatApi.updateSessionTitleIfAutomatic(
            turn.sessionId!,
            title,
          );
          if (!updated) return;
          if (
            (await hasManualSessionTitle(turn.sessionId!, projectId)) ||
            hasManualSessionTitleInStore(turn.sessionId!)
          ) {
            return;
          }
          input.set((state) => ({
            sessions: state.sessions.map((session) =>
              session.id === turn.sessionId ? { ...session, title } : session,
            ),
          }));
        })
        .catch((error) => {
          const detail = input.errorDetail(error);
          const log = /IPC_\w+_CANCELLED/.test(detail)
            ? input.debugLog.warn // a lifecycle switch cancelled it
            : input.debugLog.error;
          log("ChatStore", "agent title generation", detail);
        });
      void runtime.trackTurn(titleGeneration);
    },

    persistCompletedTurn,
    preserveFailedAnchoredTurn,
    hasManualSessionTitleInStore,
    hasManualSessionTitle,
    finalizeStoppedAgentTurnAfterTransport,
  };
}
