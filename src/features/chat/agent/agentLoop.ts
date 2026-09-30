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
  Citation,
  AgentToolAuthorization,
} from "./agentTypes";
import { ensureTokenizer, countTokens } from "../contextBuilder";
import { beginAgentToolTurn } from "./toolTurnCache";

/**
 * データ取得ツール呼び出しの既定上限。呼び出し元が maxToolCalls を渡さない
 * 場合のフォールバック（Context Creator・テスト等）。メインチャットは
 * model-aware な getAgentToolCallBudget(model) を渡して上書きする。
 */
const DEFAULT_MAX_TOOL_CALLS = 10;
/**
 * 1 件の tool_result が会話に積めるトークン上限（tokenBudget に対する割合）。
 * budget 判定は結果追加後にしか走らないため、巨大な get_scene 一発で
 * 文脈窓を溢れさせない事前ガードとして個別結果を切り詰める。
 */
const TOOL_RESULT_TOKEN_CAP_RATIO = 0.25;
/**
 * ask_user（ユーザーへの質問）の 1 ターンあたり既定上限。データ取得ツールの
 * 上限とは別カウント。適応的な多段質問を許しつつ、質問の連打／無限ループを
 * 抑止する。呼び出し元が maxUserQuestions を渡せば上書きできる。
 */
const DEFAULT_MAX_USER_QUESTIONS = 8;

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
    authorization?: AgentToolAuthorization,
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
  /**
   * データ取得ツール呼び出しの上限。未指定なら DEFAULT_MAX_TOOL_CALLS(10)。
   * メインチャットは getAgentToolCallBudget(model) を渡して model-aware に
   * スケールさせる。サブエージェントは親予算を分割した小さい値を渡す。
   */
  maxToolCalls?: number;
  /** ask_user 呼び出しの上限。未指定なら DEFAULT_MAX_USER_QUESTIONS(8)。 */
  maxUserQuestions?: number;
}

/** ループ終了理由。続行アフォーダンスの出し分けに使う。 */
export type AgentStoppedReason =
  | "completed"
  | "limit_calls"
  | "limit_tokens"
  | "limit_questions"
  | "aborted";

export interface AgentLoopResult {
  finalText: string;
  toolCallRecords: ToolCallRecord[];
  /** 最終レスポンスの thinking ブロック（UI 表示・metadata 保存用） */
  finalThinkingBlocks: ThinkingBlock[];
  /** 全レスポンスにまたがる Web 検索引用（URL 重複は畳む）。 */
  citations: Citation[];
  /** 全レスポンスのコスト合計（OpenRouter のみ実値、なければ null）。 */
  cost: number | null;
  /** 全ターンの入力トークン合計（N4。取得不可なら null）。 */
  tokensIn: number | null;
  /** 全ターンの出力トークン合計（N4。取得不可なら null）。 */
  tokensOut: number | null;
  /**
   * ループがなぜ止まったか。"limit_*" のとき UI は「続行」ボタンを出し、
   * ユーザーが新しい予算でターンを再開できるようにする。
   */
  stoppedReason: AgentStoppedReason;
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
  const maxToolCalls = options.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS;
  const maxUserQuestions =
    options.maxUserQuestions ?? DEFAULT_MAX_USER_QUESTIONS;

  await ensureTokenizer();

  const conversation: AgentMessagePayload[] = [...options.messages];
  const toolCallRecords: ToolCallRecord[] = [];
  let totalCalls = 0;
  let userQuestionCalls = 0;
  let totalTokens = 0;
  let limitMessageInserted = false;
  // 終了理由。abort 経路で true、limit 到達で具体的な理由をセットする。
  let aborted = false;
  let limitReason: Exclude<AgentStoppedReason, "completed" | "aborted"> | null =
    null;

  // このターンで宣言したツール名の集合。プロバイダが返した tool_use を dispatch
  // する前にこの集合と照合し、未宣言ツールの実行を拒否する。executeTool は
  // EXECUTORS メンバーシップだけで dispatch するため、宣言していなくても
  // EXECUTORS に存在するツールは実行されてしまう。read-only な現状では無害だが、
  // 将来 mutating executor が追加されたときに「宣言ターン以外では発火しない」
  // ことを構造的に保証するためのゲート（security review F-2）。
  const declaredToolNames = new Set(tools.map((t) => t.name));

  // Web 検索 (RAG) の引用・コスト・トークンを全レスポンスにまたがって蓄積する。
  const citations: Citation[] = [];
  let cost: number | null = null;
  // N4: ツールループの全ターンの input/output トークンを合算する。
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  const accumulate = (resp: AgentLLMResponse) => {
    if (resp.citations) {
      for (const c of resp.citations) {
        if (!citations.some((x) => x.url === c.url)) citations.push(c);
      }
    }
    if (resp.cost != null) cost = (cost ?? 0) + resp.cost;
    if (resp.inputTokens != null) tokensIn = (tokensIn ?? 0) + resp.inputTokens;
    if (resp.outputTokens != null) {
      tokensOut = (tokensOut ?? 0) + resp.outputTokens;
    }
  };
  const result = (
    finalText: string,
    finalThinkingBlocks: ThinkingBlock[],
  ): AgentLoopResult => ({
    finalText,
    toolCallRecords,
    finalThinkingBlocks,
    citations,
    cost,
    tokensIn,
    tokensOut,
    stoppedReason: aborted ? "aborted" : (limitReason ?? "completed"),
  });

  while (true) {
    // 次の LLM 呼び出し前に中断確認（Stop 後に新ターンを発火させない）。
    if (options.shouldAbort?.()) {
      aborted = true;
      return result("", []);
    }

    const response = await sendToLLM(conversation, tools);
    accumulate(response);

    // Collect any text blocks from this response
    const textContent = extractText(response.blocks);
    if (textContent) onTextChunk(textContent);

    const currentThinkingBlocks = extractThinkingBlocks(response.blocks);

    if (
      response.stopReason === "end_turn" ||
      response.stopReason === "max_tokens"
    ) {
      return result(textContent, currentThinkingBlocks);
    }

    if (response.stopReason !== "tool_use") {
      return result(textContent, currentThinkingBlocks);
    }

    // Process tool_use blocks
    const toolUses = extractToolUses(response.blocks);
    if (toolUses.length === 0) {
      return result(textContent, currentThinkingBlocks);
    }

    // If limit was already inserted and LLM still wants tools, stop
    if (limitMessageInserted) {
      return result(textContent, currentThinkingBlocks);
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

    // Execute each tool. ターン内共有キャッシュ（toolTurnCache）はバッチ開始時に
    // 破棄し、同一バッチのツール間でのみデータロードを共有する（stale 防止）。
    beginAgentToolTurn();
    const toolResults: ToolResult[] = [];
    for (const tu of toolUses) {
      // ask_user はデータ取得予算 (maxToolCalls) を消費せず別枠でカウント。
      // 適応的な多段質問が data fetch 予算を食い潰さないようにするため。
      if (tu.name === ASK_USER_TOOL) {
        userQuestionCalls++;
      } else {
        totalCalls++;
      }

      // 宣言ゲート: このターンで宣言していないツールは実行しない。skip すると
      // tool_use に対応する tool_result が欠落し次ターンの API が壊れるため、
      // error tool_result を返してペアリングを保つ（security review F-2）。
      if (!declaredToolNames.has(tu.name)) {
        const msg = `Tool not available this turn: ${tu.name}`;
        const rejected: ToolResult = {
          toolCallId: tu.id,
          name: tu.name,
          content: null,
          summary: msg,
          tokensUsed: 0,
          error: msg,
        };
        const record: ToolCallRecord = {
          name: tu.name,
          params: tu.input,
          resultSummary: msg,
          tokensUsed: 0,
        };
        toolCallRecords.push(record);
        onToolComplete?.(record);
        toolResults.push(rejected);
        continue;
      }

      onProgress({
        totalCalls,
        maxCalls: maxToolCalls,
        tokensUsed: totalTokens,
        tokenBudget,
        currentToolName: tu.name,
      });

      // helper `result()` と衝突しないよう ToolResult は toolRes 名で受ける。
      const capability = response.agentAuthorityCapabilities?.[tu.id];
      const authorization = capability ? { ...capability } : undefined;
      const toolRes = authorization
        ? await executeTool(tu.name, tu.id, tu.input, authorization)
        : await executeTool(tu.name, tu.id, tu.input);

      // ツール実行中に Stop / セッション切替が入った場合は、tool_result を
      // 積まずに即終了する（積むと次ターンの sendToLLM が再発火し暴走する）。
      if (options.shouldAbort?.()) {
        aborted = true;
        return result(textContent, currentThinkingBlocks);
      }

      totalTokens += toolRes.tokensUsed;

      const record: ToolCallRecord = {
        name: toolRes.name,
        params: tu.input,
        resultSummary: toolRes.summary,
        tokensUsed: toolRes.tokensUsed,
      };
      toolCallRecords.push(record);
      onToolComplete?.(record);

      toolResults.push(toolRes);
    }

    // Append tool results to conversation
    const toolResultTokenCap = Math.max(
      1,
      Math.floor(tokenBudget * TOOL_RESULT_TOKEN_CAP_RATIO),
    );
    for (const tr of toolResults) {
      // not-found 系は content:null + summary に理由を載せて返ってくる。
      // JSON.stringify(null) の literal "null" を LLM に渡さず summary を会話へ
      // 格上げする（summary も空なら明示の not-found メッセージ）。
      let content: string;
      if (tr.error) {
        content = `Error: ${tr.error}`;
      } else if (tr.content == null) {
        content = tr.summary || "No result (not found).";
      } else {
        content = JSON.stringify(tr.content);
      }
      const contentTokens = countTokens(content);
      if (contentTokens > toolResultTokenCap) {
        const keepChars = Math.max(
          1,
          Math.floor((content.length * toolResultTokenCap) / contentTokens),
        );
        content = `${content.slice(0, keepChars)}...[truncated: 元 ${contentTokens} tokens]`;
      }
      conversation.push({
        role: "tool_result",
        toolUseId: tr.toolCallId,
        content,
        isError: !!tr.error,
      });
    }

    onProgress({
      totalCalls,
      maxCalls: maxToolCalls,
      tokensUsed: totalTokens,
      tokenBudget,
    });

    // Check limits — insert system message then let LLM respond once more.
    // 最終 result() に伝える stoppedReason もここで確定する（質問上限 →
    // 呼び出し上限 → トークン予算 の優先順は制御メッセージの選択と揃える）。
    if (
      totalCalls >= maxToolCalls ||
      totalTokens >= tokenBudget ||
      userQuestionCalls >= maxUserQuestions
    ) {
      if (userQuestionCalls >= maxUserQuestions) {
        limitReason = "limit_questions";
      } else if (totalCalls >= maxToolCalls) {
        limitReason = "limit_calls";
      } else {
        limitReason = "limit_tokens";
      }
      const limitMsg =
        limitReason === "limit_questions"
          ? (options.userQuestionLimitMessage ?? options.callLimitMessage)
          : limitReason === "limit_calls"
            ? options.callLimitMessage
            : options.tokenBudgetMessage;
      conversation.push({ role: "user", content: limitMsg });
      limitMessageInserted = true;
    }
  }
}
