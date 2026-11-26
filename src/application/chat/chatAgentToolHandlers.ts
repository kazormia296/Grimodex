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
import type {
  ChatIrCapability,
  ChatIrUsedIds,
  ChatTurnToolScope,
} from "@/features/chat/agent/chatTurnToolScope";
import { CHAT_AGENT_IR_ENABLED } from "@/features/chat/agent/chatAgentIrAvailability";
import {
  MAX_UI_OPERATIONS_PER_TURN,
  UI_OPERATION_TOOL_NAMES,
} from "@/features/chat/agent/uiOperationTools";

type SendAgentMessage =
  typeof import("@/features/chat/chatApi").sendAgentMessage;
type ExecuteTool =
  typeof import("@/features/chat/agent/toolExecutors").executeTool;
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
  signal: AbortSignal;
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
  signal,
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
            signal,
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

/**
 * 1 回の agent の応答で UI 操作ツール（run_app_command／apply_layout_preset）を呼べる回数の上限。
 * 一般の tool 呼び出し上限は 1 バッチの中の呼び出しを数えず全ツール合計なので、操作の連打を別に絞る。
 * 呼び出しの試行を数える（失敗した呼び出しも 1 回）。上限を超えた呼び出しは実行せず error を返す。
 * ターンごとに作る（closure のカウンタ）。「続行」で始まる新しいターンは新しい枠になる。
 */
export function createUiOperationLimitHandler(
  maxOperations: number = MAX_UI_OPERATIONS_PER_TURN,
) {
  let attempts = 0;
  return (name: string, toolCallId: string): ToolResult | null => {
    if (!UI_OPERATION_TOOL_NAMES.includes(name)) return null;
    attempts += 1;
    if (attempts <= maxOperations) return null;
    const msg = `UI operation limit reached (${maxOperations} per response). Do not operate the UI further; tell the user what you did and that they can undo it from the tool result.`;
    return {
      toolCallId,
      name,
      content: { error: msg },
      summary: msg,
      tokensUsed: countTokens(JSON.stringify({ error: msg })),
      error: msg,
    };
  };
}

/**
 * 送信ターンの executeTool を包み、UI 操作ツールの上限を実行の前にかける。呼ぶたびに新しい
 * カウンタを作るので、ターンの中（runAgentLoop に渡す所）で呼ぶ。
 */
export function withUiOperationLimit<
  Execute extends (
    name: string,
    toolCallId: string,
    ...rest: never[]
  ) => Promise<ToolResult>,
>(execute: Execute): Execute {
  const limit = createUiOperationLimitHandler();
  return ((name: string, toolCallId: string, ...rest: never[]) => {
    const limited = limit(name, toolCallId);
    return limited
      ? Promise.resolve(limited)
      : execute(name, toolCallId, ...rest);
  }) as Execute;
}

/**
 * `runAgentLoop` が 1 件の tool_result に許す割合（`agentLoop.ts` の
 * `TOOL_RESULT_TOKEN_CAP_RATIO`）の写し。export されないので写し、実際の
 * `runAgentLoop` を小さい budget で回す試験（B-T7）で一致を固定する。
 */
const AGENT_LOOP_TOOL_RESULT_TOKEN_CAP_RATIO = 0.25;

/**
 * ターンの `executeTool`。authority を最初に確かめ、ask_user・run_research・既に
 * system prompt へ全文を入れた Codex entry の 3 つをここで横取りし、残りを注入された
 * `executeTool` へ渡す。`authorization` があれば、この turn の assistant message の id を足す。
 */
export function createGuardedExecuteTool(input: {
  executeTool: ExecuteTool;
  assertTurnAuthority: () => void;
  handleAskUserTool: ReturnType<typeof createAskUserToolHandler>;
  runResearchSubagent: ReturnType<typeof createChatResearchSubagentHandler>;
  /**
   * 実行の直前の段（出典に使う書き込み tool の assistant 行を確保する。#940）。
   * 結果を返したら、その結果で tool を終える（実行しない）。
   */
  beforeExecute: (
    name: string,
    toolCallId: string,
    authorized: boolean,
  ) => Promise<ToolResult | null>;
  fullyInjectedIds: ReadonlySet<string>;
  chatMessageId: string;
}): ExecuteTool {
  const {
    executeTool,
    assertTurnAuthority,
    handleAskUserTool,
    runResearchSubagent,
    beforeExecute,
    fullyInjectedIds,
    chatMessageId,
  } = input;
  return async (name, toolCallId, params, authorization) => {
    assertTurnAuthority();
    const askUserResult = handleAskUserTool(name, toolCallId, params);
    if (askUserResult) return askUserResult;
    const research = runResearchSubagent(name, toolCallId, params);
    if (research) return research;
    const injectedEntryResult = alreadyInjectedCodexEntryResult(
      name,
      toolCallId,
      params,
      fullyInjectedIds,
    );
    if (injectedEntryResult) return injectedEntryResult;
    const failed = await beforeExecute(name, toolCallId, !!authorization);
    if (failed) return failed;
    return authorization
      ? executeTool(name, toolCallId, params, {
          ...authorization,
          chatMessageId,
        })
      : executeTool(name, toolCallId, params);
  };
}

/** A tool call's record, as far as `attachUsedIds` writes it. */
interface UsedIdsRecord {
  readonly params: Record<string, unknown>;
  usedIds?: ChatIrUsedIds;
}

/**
 * ターンの開始時に 1 回作る、tool に渡す文脈（S1-B PR-B2）。
 *
 * `currentSceneId` は IR の gate と独立して turn の開始時に固定する。
 * IR が無効、または private Agent でない送信では scene だけを束ねる。
 *
 * IR が有効なとき：main には `{ currentSceneId, scope, ir }`、sub-agent には
 * `{ currentSceneId, scope }` を渡す（IR は sub-agent に構造で渡さない）。
 * `scope.currentSceneId` は turn 開始時の値で、tool の中では store を読み直さない。
 * `usedIds` は tool call の `params` object を鍵にして持ち、`onToolComplete` の先頭で
 * `attachUsedIds(record)` が record へ写す。
 */
export function createChatTurnToolContext(input: {
  executeTool: ExecuteTool;
  executeReadOnlyTool: ExecuteReadOnlyTool;
  enabled: boolean;
  projectId: string;
  workspacePath: string | null;
  currentSceneId: string;
  tokenBudget: number;
  assertTurnAuthority: () => void;
}): {
  executeTool: ExecuteTool;
  executeReadOnlyTool: ExecuteReadOnlyTool;
  attachUsedIds: (record: UsedIdsRecord) => void;
} {
  const currentSceneId = input.currentSceneId || null;
  if (!CHAT_AGENT_IR_ENABLED || !input.enabled) {
    return {
      executeTool: (name, toolCallId, params, authorization) =>
        input.executeTool(name, toolCallId, params, authorization, {
          currentSceneId,
        }),
      executeReadOnlyTool: (name, toolCallId, params) =>
        input.executeReadOnlyTool(name, toolCallId, params, { currentSceneId }),
      attachUsedIds: () => {},
    };
  }
  const scope: ChatTurnToolScope = {
    projectId: input.projectId,
    currentSceneId,
  };
  const used = new WeakMap<object, ChatIrUsedIds>();
  const ir: ChatIrCapability = {
    workspacePath: input.workspacePath,
    tokenCap: Math.max(
      1,
      Math.floor(input.tokenBudget * AGENT_LOOP_TOOL_RESULT_TOKEN_CAP_RATIO),
    ),
    counter: { chars: 0, calls: 0 },
    assertCurrent: input.assertTurnAuthority,
    noteUsedIds: (key, revisionIds, eventIds) => {
      used.set(key, {
        revisionIds: [...revisionIds],
        eventIds: [...eventIds],
        generation: null,
      });
    },
  };
  const { executeTool, executeReadOnlyTool } = input;
  return {
    executeTool: (name, toolCallId, params, authorization) =>
      executeTool(name, toolCallId, params, authorization, {
        currentSceneId,
        scope,
        ir,
      }),
    executeReadOnlyTool: (name, toolCallId, params) =>
      executeReadOnlyTool(name, toolCallId, params, { currentSceneId, scope }),
    attachUsedIds: (record) => {
      const note = used.get(record.params);
      if (note) record.usedIds = note;
    },
  };
}
