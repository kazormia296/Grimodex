export const DEFAULT_MAX_TOOL_CALLS = 10;
export const DEFAULT_MAX_USER_QUESTIONS = 8;
export const TOOL_RESULT_TOKEN_CAP_RATIO = 0.25;
export const ASK_USER_TOOL_NAME = "ask_user";

export type AgentLimitReason =
  | "limit_calls"
  | "limit_tokens"
  | "limit_questions";

export type AgentStoppedReason = "completed" | AgentLimitReason | "aborted";

export interface AgentLoopRuleLimits {
  readonly maxToolCalls: number;
  readonly maxUserQuestions: number;
  readonly tokenBudget: number;
}

export interface AgentLoopRuleState extends AgentLoopRuleLimits {
  readonly totalCalls: number;
  readonly userQuestionCalls: number;
  readonly tokensUsed: number;
  readonly limitMessageInserted: boolean;
  readonly limitReason: AgentLimitReason | null;
  readonly aborted: boolean;
}

export interface AgentControlMessages {
  /** Messages are already localized by the caller for this UI language. */
  readonly uiLanguage: string;
  readonly callLimitMessage: string;
  readonly tokenBudgetMessage: string;
  readonly userQuestionLimitMessage?: string;
}

export function createAgentLoopRuleState(input: {
  readonly maxToolCalls?: number;
  readonly maxUserQuestions?: number;
  readonly tokenBudget: number;
}): AgentLoopRuleState {
  return {
    maxToolCalls: input.maxToolCalls ?? DEFAULT_MAX_TOOL_CALLS,
    maxUserQuestions: input.maxUserQuestions ?? DEFAULT_MAX_USER_QUESTIONS,
    tokenBudget: input.tokenBudget,
    totalCalls: 0,
    userQuestionCalls: 0,
    tokensUsed: 0,
    limitMessageInserted: false,
    limitReason: null,
    aborted: false,
  };
}

/**
 * Call only for the observed tool_use blocks; a post-limit response is ignored.
 * Legacy counts each execution; this module counts the whole batch when observed,
 * so counters can exceed legacy after a mid-batch abort (the stop reason matches).
 * Pass one item at a time when the caller needs execution-by-execution counts.
 */
export function recordToolUsesForResponse(
  state: AgentLoopRuleState,
  stopReason: string,
  toolNames: readonly string[],
): AgentLoopRuleState {
  if (
    stopReason !== "tool_use" ||
    state.limitMessageInserted ||
    state.aborted
  ) {
    return state;
  }

  return toolNames.reduce(
    (next, name) =>
      name === ASK_USER_TOOL_NAME
        ? { ...next, userQuestionCalls: next.userQuestionCalls + 1 }
        : { ...next, totalCalls: next.totalCalls + 1 },
    state,
  );
}

/** Add only results whose execution completed before an abort was observed. */
export function recordToolResultTokens(
  state: AgentLoopRuleState,
  tokensUsed: number,
): AgentLoopRuleState {
  return state.limitMessageInserted || state.aborted
    ? state
    : { ...state, tokensUsed: state.tokensUsed + tokensUsed };
}

export function getAgentLimitReason(
  state: AgentLoopRuleState,
): AgentLimitReason | null {
  if (state.userQuestionCalls >= state.maxUserQuestions) {
    return "limit_questions";
  }
  if (state.totalCalls >= state.maxToolCalls) return "limit_calls";
  if (state.tokensUsed >= state.tokenBudget) return "limit_tokens";
  return null;
}

export function insertLimitMessage(
  state: AgentLoopRuleState,
): AgentLoopRuleState {
  if (state.aborted) return state;
  const limitReason = getAgentLimitReason(state);
  return limitReason
    ? { ...state, limitMessageInserted: true, limitReason }
    : state;
}

export function markAgentLoopAborted(
  state: AgentLoopRuleState,
): AgentLoopRuleState {
  return { ...state, aborted: true };
}

export function resolveAgentStoppedReason(
  state: AgentLoopRuleState,
): AgentStoppedReason {
  return state.aborted ? "aborted" : (state.limitReason ?? "completed");
}

export function selectAgentControlMessage(
  reason: AgentLimitReason,
  messages: AgentControlMessages,
): string {
  if (reason === "limit_questions") {
    return messages.userQuestionLimitMessage ?? messages.callLimitMessage;
  }
  return reason === "limit_calls"
    ? messages.callLimitMessage
    : messages.tokenBudgetMessage;
}

export function formatToolResult(
  result:
    | {
        readonly content: unknown;
        readonly summary: string;
        readonly error?: string;
      }
    | { readonly text: string; readonly summary: string },
  tokenBudget: number,
  countTokens: (text: string) => number,
): { content: string; isError: boolean } {
  let content: string;
  if ("text" in result) {
    content = result.text;
  } else if (result.error) {
    content = `Error: ${result.error}`;
  } else if (result.content == null) {
    content = result.summary || "No result (not found).";
  } else {
    content = JSON.stringify(result.content)!;
  }

  const contentTokens = countTokens(content);
  const tokenCap = Math.max(
    1,
    Math.floor(tokenBudget * TOOL_RESULT_TOKEN_CAP_RATIO),
  );
  if (contentTokens > tokenCap) {
    const keepChars = Math.max(
      1,
      Math.floor((content.length * tokenCap) / contentTokens),
    );
    content = `${content.slice(0, keepChars)}...[truncated: 元 ${contentTokens} tokens]`;
  }

  return { content, isError: "error" in result && !!result.error };
}

/**
 * DR-MP4-12 C-3(c): at most maxToolCalls + maxUserQuestions sends are needed:
 * pre-limit batches consume one of those counters, then come the limit batch and
 * one final response. Legacy checks limits only after its first tool batch, so
 * zero limits still need an initial send and that final response.
 */
export function deriveAgentMaxSteps(
  maxToolCalls = DEFAULT_MAX_TOOL_CALLS,
  maxUserQuestions = DEFAULT_MAX_USER_QUESTIONS,
): number {
  if (!Number.isInteger(maxToolCalls) || maxToolCalls < 0) {
    throw new RangeError("maxToolCalls must be a non-negative integer");
  }
  if (!Number.isInteger(maxUserQuestions) || maxUserQuestions < 0) {
    throw new RangeError("maxUserQuestions must be a non-negative integer");
  }
  return Math.max(2, maxToolCalls + maxUserQuestions);
}
