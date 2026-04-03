import type {
  AgentLLMResponse,
  AgentMessagePayload,
  AgentToolDefinition,
  ToolCallRecord,
  ToolResult,
  AgentLoopProgress,
  ResponseBlock,
  ThinkingBlock,
  ToolUseBlock,
} from "./agentTypes";

const MAX_TOOL_CALLS = 10;
const MSG_CALL_LIMIT =
  "ツール呼び出し上限（10回）に達しました。現在の情報で回答してください。";
const MSG_TOKEN_LIMIT =
  "ツール結果のトークン予算に達しました。現在の情報で回答してください。";

export interface AgentLoopOptions {
  messages: AgentMessagePayload[];
  tools: AgentToolDefinition[];
  tokenBudget: number;
  sendToLLM: (
    msgs: AgentMessagePayload[],
    tools: AgentToolDefinition[],
  ) => Promise<AgentLLMResponse>;
  executeTool: (
    name: string,
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<ToolResult>;
  onProgress: (progress: AgentLoopProgress) => void;
  onToolComplete?: (record: ToolCallRecord) => void;
  onTextChunk: (text: string) => void;
}

export interface AgentLoopResult {
  finalText: string;
  toolCallRecords: ToolCallRecord[];
  /** 最終レスポンスの thinking ブロック（UI 表示・metadata 保存用） */
  finalThinkingBlocks: ThinkingBlock[];
}

function extractText(blocks: ResponseBlock[]): string {
  return blocks
    .filter((b): b is { type: "text"; content: string } => b.type === "text")
    .map((b) => b.content)
    .join("\n");
}

function extractThinkingBlocks(blocks: ResponseBlock[]): ThinkingBlock[] {
  return blocks
    .filter(
      (b): b is { type: "thinking"; content: string; signature: string } =>
        b.type === "thinking" &&
        typeof b.signature === "string" &&
        b.signature.length > 0,
    )
    .map((b) => ({ thinking: b.content, signature: b.signature }));
}

function extractToolUses(blocks: ResponseBlock[]): Array<{
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}> {
  return blocks.filter(
    (
      b,
    ): b is {
      type: "tool_use";
      id: string;
      name: string;
      input: Record<string, unknown>;
    } => b.type === "tool_use",
  );
}

export async function runAgentLoop(
  options: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const {
    tools,
    tokenBudget,
    sendToLLM,
    executeTool,
    onProgress,
    onToolComplete,
    onTextChunk,
  } = options;

  const conversation: AgentMessagePayload[] = [...options.messages];
  const toolCallRecords: ToolCallRecord[] = [];
  let totalCalls = 0;
  let totalTokens = 0;
  let limitMessageInserted = false;

  while (true) {
    const response = await sendToLLM(conversation, tools);

    // Collect any text blocks from this response
    const textContent = extractText(response.blocks);
    if (textContent) onTextChunk(textContent);

    const currentThinkingBlocks = extractThinkingBlocks(response.blocks);

    if (
      response.stopReason === "end_turn" ||
      response.stopReason === "max_tokens"
    ) {
      return {
        finalText: textContent,
        toolCallRecords,
        finalThinkingBlocks: currentThinkingBlocks,
      };
    }

    if (response.stopReason !== "tool_use") {
      return {
        finalText: textContent,
        toolCallRecords,
        finalThinkingBlocks: currentThinkingBlocks,
      };
    }

    // Process tool_use blocks
    const toolUses = extractToolUses(response.blocks);
    if (toolUses.length === 0) {
      return {
        finalText: textContent,
        toolCallRecords,
        finalThinkingBlocks: currentThinkingBlocks,
      };
    }

    // If limit was already inserted and LLM still wants tools, stop
    if (limitMessageInserted) {
      return {
        finalText: textContent,
        toolCallRecords,
        finalThinkingBlocks: currentThinkingBlocks,
      };
    }

    // Append assistant message with tool_uses (and thinking blocks) to conversation
    const assistantToolUses: ToolUseBlock[] = toolUses.map((tu) => ({
      id: tu.id,
      name: tu.name,
      input: tu.input,
    }));
    const thinkingBlocks = extractThinkingBlocks(response.blocks);
    conversation.push({
      role: "assistant",
      content: textContent,
      toolUses: assistantToolUses,
      ...(thinkingBlocks.length > 0 ? { thinkingBlocks } : {}),
    });

    // Execute each tool
    const toolResults: ToolResult[] = [];
    for (const tu of toolUses) {
      totalCalls++;

      onProgress({
        totalCalls,
        maxCalls: MAX_TOOL_CALLS,
        tokensUsed: totalTokens,
        tokenBudget,
        currentToolName: tu.name,
      });

      const result = await executeTool(tu.name, tu.id, tu.input);
      totalTokens += result.tokensUsed;

      const record: ToolCallRecord = {
        name: result.name,
        params: tu.input,
        resultSummary: result.summary,
        tokensUsed: result.tokensUsed,
      };
      toolCallRecords.push(record);
      onToolComplete?.(record);

      toolResults.push(result);
    }

    // Append tool results to conversation
    for (const tr of toolResults) {
      const content = tr.error
        ? `Error: ${tr.error}`
        : JSON.stringify(tr.content);
      conversation.push({
        role: "tool_result",
        toolUseId: tr.toolCallId,
        content,
        isError: !!tr.error,
      });
    }

    onProgress({
      totalCalls,
      maxCalls: MAX_TOOL_CALLS,
      tokensUsed: totalTokens,
      tokenBudget,
    });

    // Check limits — insert system message then let LLM respond once more
    if (totalCalls >= MAX_TOOL_CALLS || totalTokens >= tokenBudget) {
      const limitMsg =
        totalCalls >= MAX_TOOL_CALLS ? MSG_CALL_LIMIT : MSG_TOKEN_LIMIT;
      conversation.push({ role: "user", content: limitMsg });
      limitMessageInserted = true;
    }
  }
}
