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
import { ensureTokenizer } from "../contextBuilder";

const MAX_TOOL_CALLS = 10;
/**
 * ask_user（ユーザーへの質問）の 1 ターンあたり上限。データ取得ツールの
 * MAX_TOOL_CALLS とは別カウント。適応的な多段質問を許しつつ、質問の連打／
 * 無限ループを抑止する。
 */
const MAX_USER_QUESTIONS = 8;

/** ユーザーへの質問ツール名（totalCalls から除外し別カウントする）。 */
const ASK_USER_TOOL = "ask_user";

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
  /**
   * 中断要求。ツール実行直後とループ先頭で参照し、true なら tool_result を
   * 送らずに即 return する。Stop / セッション切替で立てる。stop が agent path
   * (非ストリーミング invoke) を止められない問題への正攻法。
   */
  shouldAbort?: () => boolean;
  /** 言語別制御メッセージ（getPromptCatalog(lang).agentControl から渡す） */
  callLimitMessage: string;
  tokenBudgetMessage: string;
  /**
   * ユーザーへの質問回数上限に達したときの制御メッセージ。ask_user を公開しない
   * 呼び出し元（Context Creator 等）では省略可。未指定時は callLimitMessage に倒す。
   */
  userQuestionLimitMessage?: string;
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

  await ensureTokenizer();

  const conversation: AgentMessagePayload[] = [...options.messages];
  const toolCallRecords: ToolCallRecord[] = [];
  let totalCalls = 0;
  let userQuestionCalls = 0;
  let totalTokens = 0;
  let limitMessageInserted = false;

  while (true) {
    // 次の LLM 呼び出し前に中断確認（Stop 後に新ターンを発火させない）。
    if (options.shouldAbort?.()) {
      return { finalText: "", toolCallRecords, finalThinkingBlocks: [] };
    }

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
      // ask_user はデータ取得予算 (MAX_TOOL_CALLS) を消費せず別枠でカウント。
      // 適応的な多段質問が data fetch 予算を食い潰さないようにするため。
      if (tu.name === ASK_USER_TOOL) {
        userQuestionCalls++;
      } else {
        totalCalls++;
      }

      onProgress({
        totalCalls,
        maxCalls: MAX_TOOL_CALLS,
        tokensUsed: totalTokens,
        tokenBudget,
        currentToolName: tu.name,
      });

      const result = await executeTool(tu.name, tu.id, tu.input);

      // ツール実行中に Stop / セッション切替が入った場合は、tool_result を
      // 積まずに即終了する（積むと次ターンの sendToLLM が再発火し暴走する）。
      if (options.shouldAbort?.()) {
        return {
          finalText: textContent,
          toolCallRecords,
          finalThinkingBlocks: currentThinkingBlocks,
        };
      }

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
    if (
      totalCalls >= MAX_TOOL_CALLS ||
      totalTokens >= tokenBudget ||
      userQuestionCalls >= MAX_USER_QUESTIONS
    ) {
      const limitMsg =
        userQuestionCalls >= MAX_USER_QUESTIONS
          ? (options.userQuestionLimitMessage ?? options.callLimitMessage)
          : totalCalls >= MAX_TOOL_CALLS
            ? options.callLimitMessage
            : options.tokenBudgetMessage;
      conversation.push({ role: "user", content: limitMsg });
      limitMessageInserted = true;
    }
  }
}
