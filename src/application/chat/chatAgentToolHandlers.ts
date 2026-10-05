import { runAgentLoop } from "@/features/chat/agent/agentLoop";
import {
  getResearchSubagentTools,
  RESEARCH_SUBAGENT_TOOL,
} from "@/features/chat/agent/toolDefinitions";
import type {
  AgentMessagePayload,
  ToolResult,
} from "@/features/chat/agent/agentTypes";
import type { ThinkingParams } from "@/features/chat/agent/modelLimits";
import { countTokens } from "@/features/chat/contextBuilder";
import {
  accumulateInputTokenDrift,
  buildInputTokenDriftMetadata,
  createInputTokenDriftTotals,
  type InputTokenEstimatorFamily,
  type InputTokenRouteSnapshot,
} from "@/features/ai-usage/inputTokenDrift";
import type { ResolvedChatTurnRoute } from "@/features/chat/turn/resolveTurnRoute";
import type { ChatStoreSet } from "./chatStoreActionPorts";
import type { ChatUserQuestionRuntime } from "./chatUserQuestionRuntime";
import {
  invalidAskUserResult,
  normalizeAskUserSpec,
} from "@/features/chat/agent/askUser";
import { finalizeChatTurnPayload } from "./chatTurnPayload";

type SendAgentMessage =
  typeof import("@/features/chat/chatApi").sendAgentMessage;
type ExecuteReadOnlyTool =
  typeof import("@/features/chat/agent/toolExecutors").executeReadOnlyTool;
type RecordAiUsage =
  typeof import("@/features/ai-usage/recordAiUsage").recordAiUsage;

type ResearchTransportOverride = {
  model?: string | null;
  provider?: string | null;
  endpointId?: string | null;
};

interface ChatResearchSubagentOptions {
  set: ChatStoreSet;
  sendAgentMessage: SendAgentMessage;
  executeReadOnlyTool: ExecuteReadOnlyTool;
  recordAiUsage: RecordAiUsage;
  assertTurnAuthority: () => void;
  isCurrentTurn: () => boolean;
  shouldAbortTurn: () => boolean;
  getParentAuditExecutionId: () => string | null;
  resolveTransportOverride: () => ResearchTransportOverride;
  turnRoute: ResolvedChatTurnRoute | null;
  turnProjectId: string;
  operationId: string;
  assistantMessageId: string;
  projectLanguage: string;
  model: string;
  provider: string;
  usageRoute: InputTokenRouteSnapshot | null;
  tokenEstimatorFamily: InputTokenEstimatorFamily;
  apiVariant: string | null | undefined;
  thinkingParams: ThinkingParams;
  tokenBudget: number;
  parentMaxToolCalls: number;
  systemPrompt: string;
  limitMessage: string;
}

/** Create the depth-one, read-only child handler owned by one captured chat turn. */
export function createChatResearchSubagentHandler({
  set,
  sendAgentMessage,
  executeReadOnlyTool,
  recordAiUsage,
  assertTurnAuthority,
  isCurrentTurn,
  shouldAbortTurn,
  getParentAuditExecutionId,
  resolveTransportOverride,
  turnRoute,
  turnProjectId,
  operationId,
  assistantMessageId,
  projectLanguage,
  model,
  provider,
  usageRoute,
  tokenEstimatorFamily,
  apiVariant,
  thinkingParams,
  tokenBudget,
  parentMaxToolCalls,
  systemPrompt,
  limitMessage,
}: ChatResearchSubagentOptions) {
  let callCount = 0;
  const maxCalls = 4;

  const run = async (
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> => {
    const task = String(params?.["task"] ?? "").trim();
    if (!task) {
      const msg = "run_research requires a non-empty 'task'.";
      return {
        toolCallId,
        name: RESEARCH_SUBAGENT_TOOL,
        content: null,
        summary: msg,
        tokensUsed: 0,
        error: msg,
      };
    }
    if (callCount >= maxCalls) {
      const msg = `Research sub-agent limit reached (${maxCalls} per turn). Summarize with the information you already have.`;
      return {
        toolCallId,
        name: RESEARCH_SUBAGENT_TOOL,
        content: null,
        summary: msg,
        tokensUsed: 0,
        error: msg,
      };
    }
    callCount++;
    const childTokenBudget = Math.max(2_000, Math.floor(tokenBudget * 0.5));
    const childMaxCalls = Math.max(3, Math.floor(parentMaxToolCalls / 2));
    const childMessages: AgentMessagePayload[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: task },
    ];
    let researchInputTokenDrift = createInputTokenDriftTotals();
    let researchAuditExecutionId = getParentAuditExecutionId();
    let childResult: Awaited<ReturnType<typeof runAgentLoop>>;
    try {
      childResult = await runAgentLoop({
        messages: childMessages,
        tools: getResearchSubagentTools(),
        tokenBudget: childTokenBudget,
        maxToolCalls: childMaxCalls,
        shouldAbort: shouldAbortTurn,
        callLimitMessage: limitMessage,
        tokenBudgetMessage: limitMessage,
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
          const overrides = resolveTransportOverride();
          const response = await sendAgentMessage(
            msgs,
            tools,
            {
              projectId: turnProjectId,
              pathId: "agent_research_subagent",
              operationId,
              executionId,
              parentExecutionId: researchAuditExecutionId,
            },
            thinkingParams,
            finalized?.transport.systemCacheSegments,
            apiVariant,
            null,
            finalized?.transport.systemVolatileTail,
            overrides.model,
            overrides.provider,
            overrides.endpointId,
            turnRoute?.outputBudget.requestMaxOutputTokens ?? null,
            turnRoute?.provider ?? null,
            turnRoute?.resolvedEndpointId ?? null,
            turnRoute?.toolProtocol ?? null,
            turnRoute?.resolvedOllamaEndpoint ?? null,
          );
          researchAuditExecutionId = executionId;
          researchInputTokenDrift = accumulateInputTokenDrift(
            researchInputTokenDrift,
            provider,
            {
              estimatedInputTokens: finalized?.usage.inputTokens ?? null,
              safetyMarginTokens: finalized?.usage.safetyMarginTokens ?? null,
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
        onProgress: (progress) => {
          if (isCurrentTurn()) set({ subAgentProgress: progress });
        },
        onTextChunk: () => {},
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        toolCallId,
        name: RESEARCH_SUBAGENT_TOOL,
        content: null,
        summary: `Research sub-agent failed: ${msg}`,
        tokensUsed: 0,
        error: msg,
      };
    } finally {
      if (isCurrentTurn()) set({ subAgentProgress: null });
    }

    void recordAiUsage({
      surface: "agent",
      model,
      provider,
      projectId: turnProjectId,
      tokensIn: childResult.tokensIn,
      tokensOut: childResult.tokensOut,
      cacheReadTokens: researchInputTokenDrift.cacheReadTokens,
      cacheWriteTokens: researchInputTokenDrift.cacheWriteTokens,
      costUsd: childResult.cost,
      traceId: assistantMessageId,
      refId: assistantMessageId,
      metadata: usageRoute
        ? buildInputTokenDriftMetadata({
            scope: "agent-research",
            projectId: turnProjectId,
            route: usageRoute,
            estimatorFamily: tokenEstimatorFamily,
            language: projectLanguage,
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
      name: RESEARCH_SUBAGENT_TOOL,
      content,
      summary: `Research sub-agent completed (${childResult.toolCallRecords.length} read calls)`,
      tokensUsed: countTokens(JSON.stringify(content)),
    };
  };
  return (
    name: string,
    toolCallId: string,
    params: Record<string, unknown>,
  ): Promise<ToolResult> | null =>
    name === RESEARCH_SUBAGENT_TOOL ? run(toolCallId, params) : null;
}

export function createAskUserToolHandler(input: {
  set: ChatStoreSet;
  runtime: ChatUserQuestionRuntime;
  getSessionId: () => string | null;
  dismissNote: string;
}) {
  return (
    name: string,
    toolCallId: string,
    params: Record<string, unknown>,
  ): ToolResult | Promise<ToolResult> | null => {
    if (name !== "ask_user") return null;
    const spec = normalizeAskUserSpec(params);
    if (!spec) {
      return invalidAskUserResult(
        toolCallId,
        "ask_user requires a non-empty questions[] array.",
      );
    }
    return new Promise<ToolResult>((resolve) => {
      input.runtime.register(resolve);
      input.set({
        pendingUserQuestion: {
          sessionId: input.getSessionId(),
          toolCallId,
          spec,
          dismissNote: input.dismissNote,
        },
      });
    });
  };
}

export function alreadyInjectedCodexEntryResult(
  name: string,
  toolCallId: string,
  params: Record<string, unknown>,
  fullyInjectedIds: ReadonlySet<string>,
): ToolResult | null {
  if (name !== "get_codex_entry") return null;
  const id = String(params?.["id"] ?? "");
  if (!id || !fullyInjectedIds.has(id)) return null;
  const note =
    "This entry is already fully injected in the system prompt — refer to the 登場キャラクター・設定情報 section above (id, aliases, summary, custom details, full body are all there). Do not call get_codex_entry on this id again.";
  const content = { id, note };
  return {
    toolCallId,
    name,
    content,
    summary: "Already injected (short-circuited)",
    tokensUsed: countTokens(JSON.stringify(content)),
  };
}
