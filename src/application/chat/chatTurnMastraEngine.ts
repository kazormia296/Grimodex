import {
  DEFAULT_MAX_USER_QUESTIONS,
  type AgentLoopResult,
} from "@/features/chat/agent/agentLoop";
import type {
  AgentMessagePayload,
  AgentToolDefinition,
  SettingProposal,
  ToolCallRecord,
} from "@/features/chat/agent/agentTypes";
import { M4_READ_TOOL_NAMES } from "@/../electron/shared/agentReadToolDefinitions";
import { MASTRA_UI_TOOL_NAMES } from "@/../electron/shared/mastraUiToolDefinitions";
import type {
  MastraAgentTurnProgressUsage,
  MastraAgentTurnStartRequest,
  MastraAgentTurnLoopResult,
} from "@/../electron/shared/mastraAgentTurnWire";
import type { ChatMessage } from "@/features/chat/chatTypes";
import { shouldAbortMastraTurn } from "./shouldAbortMastraTurn";
import type { ResolvedChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";
import type { ChatStoreSet } from "./chatStoreActionPorts";
import type { ChatTurnRuntime } from "./chatTurnRuntime";
import type { ChatUserQuestionRuntime } from "./chatUserQuestionRuntime";
import { errorDetail, debugLog } from "@/lib/debugLog";
import { parseMetadataRecord } from "./chatStoreSupport";
import * as mastraAgentTurn from "@/lib/mastraAgentTurn";
import * as mastraTurnResponder from "./mastraAgentTurnResponder";
import * as aiAuditExecutionRegistry from "@/features/ai-audit/executionRegistry";
import * as pendingSceneWrites from "@/features/tree/pendingSceneWrites";

interface EligibilityInput {
  provider: string | null | undefined;
  chatSessionId: string | null;
  projectId: string | null;
  tools: readonly string[];
  mainToolNames: readonly string[];
  gateClosedObserved: boolean;
  pendingStart: boolean;
  hasAttachments: boolean;
  toolProtocol: string | null | undefined;
  publicWebSearch: boolean;
}

export interface MastraTurnAdmissionInput {
  turnId: string;
  provider: string | null | undefined;
  chatSessionId: string | null;
  projectId: string | null;
  activeSceneId: string;
  tools: readonly Pick<AgentToolDefinition, "name">[];
  userMessage: ChatMessage;
  toolProtocol: string | null | undefined;
  publicWebSearch: boolean;
  cancelBeforeTransport: () => boolean;
}

export interface MastraTurnExecutionContext {
  turnId: string;
  chatSessionId: string;
  projectId: string;
  currentSceneId: string | null;
  chatMessageId: string;
  assistantMessage: ChatMessage;
  messages: readonly AgentMessagePayload[];
  route: ResolvedChatTurnRoute | null;
  systemCacheSegments:
    | MastraAgentTurnStartRequest["systemCacheSegments"]
    | null;
  systemVolatileTail: MastraAgentTurnStartRequest["systemVolatileTail"] | null;
  fullyInjectedIds: Iterable<string>;
  tokenBudget: number;
  maxToolCalls: number;
  contextWindow: number;
  language: "ja" | "en";
  callLimitMessage: string;
  tokenBudgetMessage: string;
  userQuestionLimitMessage: string;
  fallbackSystem: string;
  tools: readonly Pick<AgentToolDefinition, "name">[];
  set: ChatStoreSet;
  userQuestionRuntime: ChatUserQuestionRuntime;
  dismissNote: string;
  assertAuthority: () => void;
  isCurrentTurn: () => boolean;
  isAborted: () => boolean;
  onSendAccepted: () => void;
  onResponseText: (text: string) => void;
  updateContextUsage: (usage: MastraAgentTurnProgressUsage) => void;
  cancelBeforeTransport: () => boolean;
  onLegacyFallback: () => void;
  transitionAgentRunning: () => void;
}

export interface MastraTurnAttempt {
  preflight: Promise<boolean>;
  recoverAssistant: (
    current: ChatMessage | undefined,
    responseText: string | undefined,
    model: string | null | undefined,
    metadata: string,
  ) => ChatMessage | undefined;
  run: (context: MastraTurnExecutionContext) => Promise<MastraTurnResult>;
  release: () => void;
}

export type MastraTurnResult =
  | { kind: "completed"; result: AgentLoopResult }
  | { kind: "fallback" }
  | { kind: "cancelled" };

function shouldUse(input: EligibilityInput): boolean {
  if (
    !["anthropic", "openai", "openrouter"].includes(input.provider ?? "") ||
    !input.chatSessionId?.trim() ||
    !input.projectId ||
    input.projectId === "default-project" ||
    input.gateClosedObserved ||
    input.pendingStart ||
    input.hasAttachments ||
    input.toolProtocol === "hermes" ||
    input.publicWebSearch
  ) {
    return false;
  }
  const mainTools = new Set(input.mainToolNames);
  return input.tools.every((name) => mainTools.has(name));
}

function hasAttachments(message: ChatMessage): boolean {
  const attachments = parseMetadataRecord(message.metadata).attachments;
  return Array.isArray(attachments) && attachments.length > 0;
}

function toSettingProposal(
  value: Readonly<Record<string, unknown>> | undefined,
): SettingProposal | undefined {
  if (
    !value ||
    typeof value.id !== "string" ||
    typeof value.key !== "string" ||
    typeof value.value !== "string"
  ) {
    return undefined;
  }
  return {
    id: value.id,
    key: value.key,
    value: value.value,
    ...(typeof value.reason === "string" ? { reason: value.reason } : {}),
  };
}

function toAgentLoopResult(
  response: Readonly<Record<string, unknown>>,
  loopResult: MastraAgentTurnLoopResult | null,
): AgentLoopResult {
  const responseBlocks = Array.isArray(response.blocks) ? response.blocks : [];
  const text = responseBlocks
    .filter(
      (block): block is { type: "text"; content: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "text" &&
        "content" in block &&
        typeof block.content === "string",
    )
    .map((block) => block.content)
    .join("");
  const thinking = responseBlocks
    .filter(
      (
        block,
      ): block is { type: "thinking"; content: string; signature?: string } =>
        typeof block === "object" &&
        block !== null &&
        "type" in block &&
        block.type === "thinking" &&
        "content" in block &&
        typeof block.content === "string",
    )
    .map((block) => ({
      thinking: block.content,
      signature: block.signature ?? "",
    }));
  const loopUsage = loopResult?.usage;
  const toolCallRecords: ToolCallRecord[] = (
    loopResult?.toolCallRecords ?? []
  ).map((record) => {
    const { settingProposal, ...fields } = record;
    const proposal = toSettingProposal(settingProposal);
    return {
      ...fields,
      params: { ...record.params },
      ...(proposal ? { settingProposal: proposal } : {}),
    };
  });
  return {
    finalText: loopResult?.finalText ?? text,
    toolCallRecords,
    finalThinkingBlocks: loopResult
      ? loopResult.finalThinkingBlocks.map((block) => ({ ...block }))
      : thinking,
    citations: (loopResult?.citations ??
      (Array.isArray(response.citations)
        ? response.citations
        : [])) as AgentLoopResult["citations"],
    cost:
      loopUsage?.cost ??
      (typeof response.cost === "number" ? response.cost : null),
    tokensIn:
      loopUsage?.tokensIn ??
      (typeof response.inputTokens === "number" ? response.inputTokens : null),
    tokensOut:
      loopUsage?.tokensOut ??
      (typeof response.outputTokens === "number"
        ? response.outputTokens
        : null),
    outputTruncated: response.stopReason === "max_tokens",
    stoppedReason: loopResult?.stoppedReason ?? "completed",
  };
}

let gateClosedObserved = false;

type RuntimeAdmission = Pick<
  ChatTurnRuntime,
  | "claimMastraTurn"
  | "hasActiveMastraTurn"
  | "releaseMastraTurn"
  | "setStreamCleanup"
  | "clearStreamCleanupIf"
>;

const dependencies = {
  ...mastraAgentTurn,
  ...mastraTurnResponder,
  ...aiAuditExecutionRegistry,
  ...pendingSceneWrites,
};

export function createMastraTurnAttempt(
  input: MastraTurnAdmissionInput,
  runtime: RuntimeAdmission,
): MastraTurnAttempt | null {
  if (
    !shouldUse({
      provider: input.provider,
      chatSessionId: input.chatSessionId,
      projectId: input.projectId,
      tools: input.tools.map((tool) => tool.name),
      mainToolNames: [...M4_READ_TOOL_NAMES, ...MASTRA_UI_TOOL_NAMES],
      gateClosedObserved,
      pendingStart: runtime.hasActiveMastraTurn(),
      hasAttachments: hasAttachments(input.userMessage),
      toolProtocol: input.toolProtocol,
      publicWebSearch: input.publicWebSearch,
    }) ||
    !runtime.claimMastraTurn(input.turnId)
  ) {
    return null;
  }

  let unregisterQuestion: (() => void) | null = null;
  let unregisterProgress: (() => void) | null = null;
  let streamCleanup: (() => void) | null = null;
  let auditReservation = false;
  let startInvoked = false;
  let released = false;
  let admitted = true;
  let recoveryContext: MastraTurnExecutionContext | null = null;

  const release = (): void => {
    if (released) return;
    released = true;
    unregisterQuestion?.();
    unregisterQuestion = null;
    unregisterProgress?.();
    unregisterProgress = null;
    if (streamCleanup) runtime.clearStreamCleanupIf(streamCleanup);
    if (auditReservation) {
      if (startInvoked) {
        dependencies.completePendingAiAuditExecution(input.turnId);
      } else {
        dependencies.abandonPendingAiAuditExecution(input.turnId);
      }
    }
    auditReservation = false;
    runtime.releaseMastraTurn(input.turnId);
  };

  const preflight = (async () => {
    try {
      await dependencies.awaitPendingSceneContentWrite(input.activeSceneId);
      if (!input.cancelBeforeTransport()) return false;
      release();
      return true;
    } catch (error) {
      admitted = false;
      debugLog.warn(
        "ChatStore",
        "Mastra turn preflight failed",
        errorDetail(error),
      );
      release();
      return false;
    }
  })();
  void preflight.catch(() => undefined);

  return {
    preflight,

    recoverAssistant(current, responseText, model, metadata) {
      if (current || !admitted || !responseText || !recoveryContext) {
        return current;
      }
      return {
        ...recoveryContext.assistantMessage,
        sessionId: recoveryContext.chatSessionId,
        content: responseText,
        model: model ?? null,
        metadata,
      };
    },

    async run(context) {
      recoveryContext = context;
      if (!admitted) {
        context.onLegacyFallback();
        return context.cancelBeforeTransport()
          ? { kind: "cancelled" }
          : { kind: "fallback" };
      }
      const route = context.route;
      if (!route)
        throw new Error("Mastra agent turn prerequisites unavailable");
      try {
        const askUserContext = {
          set: context.set,
          runtime: context.userQuestionRuntime,
          getSessionId: () => context.chatSessionId,
          dismissNote: context.dismissNote,
        };
        unregisterQuestion =
          await dependencies.registerMastraAgentTurnResponder(
            input.turnId,
            context.assertAuthority,
            askUserContext,
          );
        unregisterProgress = await dependencies.listenMastraAgentTurnProgress(
          input.turnId,
          (progress) => {
            if (!context.isCurrentTurn() || context.isAborted()) return;
            const event = progress.event;
            if (event.kind === "send-accepted") {
              context.onSendAccepted();
              context.updateContextUsage(event.usage);
              if (event.cacheDowngradeReason === "budget") {
                context.set({ cacheInvalidatedReason: "budget" });
              }
            } else if (event.kind === "tool") {
              context.set({
                agentProgress: {
                  totalCalls: event.totalCalls,
                  maxCalls: event.maxCalls,
                  tokensUsed: event.tokensUsed,
                  tokenBudget: event.tokenBudget,
                  currentToolName:
                    event.phase === "started" ? event.toolName : undefined,
                },
              });
            } else if (event.kind === "context-overflow") {
              context.updateContextUsage(event.usage);
            }
          },
        );

        const requestMaxOutputTokens =
          route.outputBudget.requestMaxOutputTokens ?? route.wireOutputTokens;
        const thinking = route.thinking.thinking;
        const request: Omit<MastraAgentTurnStartRequest, "writerSessionId"> = {
          turnId: input.turnId,
          chatSessionId: context.chatSessionId,
          projectId: context.projectId,
          currentSceneId: context.currentSceneId,
          chatMessageId: context.chatMessageId,
          messages: context.messages.map((message) => {
            if (message.role === "tool_result") {
              throw new Error("Unexpected legacy tool result in history");
            }
            return message;
          }),
          route: {
            provider:
              route.provider as MastraAgentTurnStartRequest["route"]["provider"],
            model: route.model || null,
            endpointId: route.resolvedEndpointId ?? route.endpointId,
            apiVariant: route.apiVariant,
            expectedOllamaEndpoint: route.resolvedOllamaEndpoint,
            thinking: thinking
              ? {
                  type: thinking.type,
                  ...(thinking.effort ? { effort: thinking.effort } : {}),
                  ...(thinking.display ? { display: thinking.display } : {}),
                  ...(thinking.budget_tokens !== undefined
                    ? { budget_tokens: thinking.budget_tokens }
                    : {}),
                }
              : null,
            effort: route.thinking.effort ?? null,
            reasoningEnabled: route.thinking.reasoningEnabled ?? null,
            reasoningEffort: route.thinking.reasoningEffort ?? null,
            webSearch: null,
            requestMaxOutputTokens,
            resolvedToolProtocol: route.toolProtocol,
          },
          systemCacheSegments: context.systemCacheSegments,
          systemVolatileTail: context.systemVolatileTail,
          fullyInjectedIds: [...context.fullyInjectedIds],
          loop: {
            tokenBudget: context.tokenBudget,
            maxToolCalls: context.maxToolCalls,
            maxUserQuestions: DEFAULT_MAX_USER_QUESTIONS,
            contextWindow: context.contextWindow,
            requestMaxOutputTokens,
            language: context.language,
            controlMessages: {
              callLimitMessage: context.callLimitMessage,
              tokenBudgetMessage: context.tokenBudgetMessage,
              userQuestionLimitMessage: context.userQuestionLimitMessage,
            },
            fallbackSystem: context.fallbackSystem,
          },
          tools: context.tools.map(
            (tool) => tool.name as MastraAgentTurnStartRequest["tools"][number],
          ),
        };

        context.assertAuthority();
        dependencies.reservePendingAiAuditExecution(input.turnId);
        auditReservation = true;
        context.transitionAgentRunning();
        streamCleanup = () => {
          void dependencies
            .cancelMastraAgentTurn({ turnId: input.turnId })
            .catch((error) => {
              debugLog.warn(
                "ChatStore",
                "cancel Mastra agent turn",
                errorDetail(error),
              );
            });
        };
        runtime.setStreamCleanup(streamCleanup);
        startInvoked = true;

        let outcome: Awaited<
          ReturnType<typeof dependencies.startMastraAgentTurn>
        >;
        try {
          outcome = await dependencies.startMastraAgentTurn(request);
        } catch (error) {
          dependencies.completePendingAiAuditExecution(input.turnId);
          auditReservation = false;
          throw error;
        }
        if (outcome.kind === "refused") {
          admitted = false;
          dependencies.abandonPendingAiAuditExecution(input.turnId);
          auditReservation = false;
          if (outcome.reason === "gate-closed") gateClosedObserved = true;
          runtime.clearStreamCleanupIf(streamCleanup);
          streamCleanup = null;
          context.onLegacyFallback();
          release();
          return context.cancelBeforeTransport()
            ? { kind: "cancelled" }
            : { kind: "fallback" };
        }
        if (outcome.kind === "context-window-exceeded") {
          dependencies.completePendingAiAuditExecution(input.turnId);
          auditReservation = false;
          context.updateContextUsage(outcome.usage);
          throw new Error("AI_CONTEXT_WINDOW_EXCEEDED");
        }
        if (outcome.kind === "invalid-response") {
          dependencies.completePendingAiAuditExecution(input.turnId);
          auditReservation = false;
          throw new Error("Invalid Mastra agent turn response");
        }

        dependencies.completePendingAiAuditExecution(input.turnId);
        auditReservation = false;
        const result = toAgentLoopResult(outcome.response, outcome.loopResult);
        context.onResponseText(result.finalText);
        return { kind: "completed", result };
      } catch (error) {
        if (!startInvoked) {
          admitted = false;
          context.onLegacyFallback();
          return context.cancelBeforeTransport()
            ? { kind: "cancelled" }
            : { kind: "fallback" };
        }
        throw error;
      } finally {
        release();
      }
    },

    release,
  };
}

export const chatTurnMastraEngine = {
  shouldAbort: shouldAbortMastraTurn,
  shouldUse,
  hasAttachments,
  toAgentLoopResult,
  toSettingProposal,
};
