import { describe, expect, it, vi } from "vitest";
import {
  createAgentLoopRuleState,
  deriveAgentMaxSteps,
  formatToolResult,
  getAgentLimitReason,
  insertLimitMessage,
  markAgentLoopAborted,
  recordToolResultTokens,
  recordToolUsesForResponse,
  resolveAgentStoppedReason,
  selectAgentControlMessage,
} from "./agentLoopRules.js";

vi.mock("../../../src/features/chat/contextBuilder", () => ({
  ensureTokenizer: async () => undefined,
  countTokens: (text: string) => text.length,
}));
vi.mock("../../../src/features/chat/agent/toolTurnCache", () => ({
  beginAgentToolTurn: () => undefined,
}));

const controlMessages = {
  uiLanguage: "ja",
  callLimitMessage: "呼び出し上限。現在の情報で回答してください。",
  tokenBudgetMessage: "token 上限。現在の情報で回答してください。",
  userQuestionLimitMessage: "質問上限。現在の情報で進めてください。",
};

interface Scenario {
  readonly toolName: string | null;
  readonly tokenBudget: number;
  readonly maxToolCalls?: number;
  readonly maxUserQuestions?: number;
  readonly tokensUsed?: number;
  readonly resultContent?: unknown;
  readonly resultSummary?: string;
  readonly abortAfterTool?: boolean;
  readonly finalResponseHasToolUse?: boolean;
}

interface LegacyObservation {
  readonly result: {
    readonly stoppedReason: string;
    readonly toolCallRecords: readonly unknown[];
  };
  readonly sentMessages: unknown[][];
  readonly executeCalls: number;
}

interface LegacyLoopOptions {
  readonly messages: readonly { role: string; content: string }[];
  readonly tools: readonly unknown[];
  readonly tokenBudget: number;
  readonly maxToolCalls?: number;
  readonly maxUserQuestions?: number;
  readonly sendToLLM: (messages: readonly unknown[]) => Promise<unknown>;
  readonly executeTool: (name: string, toolCallId: string) => Promise<unknown>;
  readonly onProgress: (...args: never[]) => void;
  readonly onTextChunk: (text: string) => void;
  readonly shouldAbort?: () => boolean;
  readonly callLimitMessage: string;
  readonly tokenBudgetMessage: string;
  readonly userQuestionLimitMessage: string;
}

interface LegacyLoopModule {
  readonly runAgentLoop: (
    options: LegacyLoopOptions,
  ) => Promise<LegacyObservation["result"]>;
}

async function loadLegacyLoop(): Promise<LegacyLoopModule["runAgentLoop"]> {
  const legacy = await vi.importActual<LegacyLoopModule>(
    "../../../src/features/chat/agent/agentLoop",
  );
  return legacy.runAgentLoop;
}

function toolResponse(name: string) {
  return {
    stopReason: "tool_use",
    blocks: [{ type: "tool_use", id: "tc-1", name, input: {} }],
  } as never;
}

function endResponse() {
  return {
    stopReason: "end_turn",
    blocks: [{ type: "text", content: "done" }],
  } as never;
}

async function runLegacy(scenario: Scenario): Promise<LegacyObservation> {
  const runAgentLoop = await loadLegacyLoop();
  const sentMessages: unknown[][] = [];
  let executeCalls = 0;
  let abortChecks = 0;
  const result = await runAgentLoop({
    messages: [{ role: "user", content: "start" }],
    tools: scenario.toolName ? [{ name: scenario.toolName }] : [],
    tokenBudget: scenario.tokenBudget,
    ...(scenario.maxToolCalls === undefined
      ? {}
      : { maxToolCalls: scenario.maxToolCalls }),
    ...(scenario.maxUserQuestions === undefined
      ? {}
      : { maxUserQuestions: scenario.maxUserQuestions }),
    sendToLLM: async (messages) => {
      sentMessages.push([...messages]);
      if (sentMessages.length === 1) {
        return scenario.toolName
          ? toolResponse(scenario.toolName)
          : endResponse();
      }
      return scenario.finalResponseHasToolUse && scenario.toolName
        ? toolResponse(scenario.toolName)
        : endResponse();
    },
    executeTool: async (name, toolCallId) => {
      executeCalls += 1;
      return {
        name,
        toolCallId,
        content: scenario.resultContent ?? null,
        summary: scenario.resultSummary ?? "summary",
        tokensUsed: scenario.tokensUsed ?? 1,
      } as never;
    },
    onProgress: () => undefined,
    onTextChunk: () => undefined,
    ...(scenario.abortAfterTool
      ? {
          shouldAbort: () => {
            abortChecks += 1;
            return abortChecks === 2;
          },
        }
      : {}),
    callLimitMessage: controlMessages.callLimitMessage,
    tokenBudgetMessage: controlMessages.tokenBudgetMessage,
    userQuestionLimitMessage: controlMessages.userQuestionLimitMessage,
  });
  return { result, sentMessages, executeCalls };
}

function replayRules(scenario: Scenario) {
  let state = createAgentLoopRuleState({
    tokenBudget: scenario.tokenBudget,
    ...(scenario.maxToolCalls === undefined
      ? {}
      : { maxToolCalls: scenario.maxToolCalls }),
    ...(scenario.maxUserQuestions === undefined
      ? {}
      : { maxUserQuestions: scenario.maxUserQuestions }),
  });
  if (!scenario.toolName) return state;

  state = recordToolUsesForResponse(state, "tool_use", [scenario.toolName]);
  if (scenario.abortAfterTool) return markAgentLoopAborted(state);
  state = recordToolResultTokens(state, scenario.tokensUsed ?? 1);
  return getAgentLimitReason(state) ? insertLimitMessage(state) : state;
}

function records(messages: unknown[]): Record<string, unknown>[] {
  return messages.filter(
    (message): message is Record<string, unknown> =>
      typeof message === "object" && message !== null,
  );
}

function findControlMessage(messages: unknown[]): string | undefined {
  return records(messages).find(
    (message) =>
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content !== "start",
  )?.content as string | undefined;
}

function findToolResult(
  messages: unknown[],
): Record<string, unknown> | undefined {
  return records(messages).find((message) => message.role === "tool_result");
}

describe("agentLoopRules legacy parity", () => {
  it("matches call-limit control, final tool-use suppression, and stopped reason", async () => {
    const scenario: Scenario = {
      toolName: "read_scene",
      maxToolCalls: 1,
      maxUserQuestions: 8,
      tokenBudget: 100,
      tokensUsed: 1,
      finalResponseHasToolUse: true,
    };
    const legacy = await runLegacy(scenario);
    let state = replayRules(scenario);
    const reason = getAgentLimitReason(state)!;
    const controlMessage = selectAgentControlMessage(reason, controlMessages);
    state = insertLimitMessage(state);
    const afterLimitToolUse = recordToolUsesForResponse(state, "tool_use", [
      "read_scene",
    ]);

    expect(legacy.result.stoppedReason).toBe(resolveAgentStoppedReason(state));
    expect(legacy.result.stoppedReason).toBe("limit_calls");
    expect(findControlMessage(legacy.sentMessages[1])).toBe(controlMessage);
    expect(legacy.sentMessages).toHaveLength(2);
    expect(legacy.executeCalls).toBe(1);
    expect(afterLimitToolUse.totalCalls).toBe(state.totalCalls);
  });

  it("matches question priority when question, calls, and tokens reach their caps", async () => {
    const scenario: Scenario = {
      toolName: "ask_user",
      maxToolCalls: 1,
      maxUserQuestions: 1,
      tokenBudget: 1,
      tokensUsed: 1,
    };
    const legacy = await runLegacy(scenario);
    const state = replayRules(scenario);
    const reason = getAgentLimitReason(state)!;
    expect(reason).toBe("limit_questions");
    expect(legacy.result.stoppedReason).toBe(resolveAgentStoppedReason(state));
    expect(findControlMessage(legacy.sentMessages[1])).toBe(
      selectAgentControlMessage(reason, controlMessages),
    );
  });

  it("matches token-limit control when questions and calls remain below their caps", async () => {
    const scenario: Scenario = {
      toolName: "read_scene",
      maxToolCalls: 2,
      maxUserQuestions: 2,
      tokenBudget: 1,
      tokensUsed: 1,
    };
    const legacy = await runLegacy(scenario);
    const state = replayRules(scenario);
    const reason = getAgentLimitReason(state)!;
    expect(reason).toBe("limit_tokens");
    expect(legacy.result.stoppedReason).toBe(resolveAgentStoppedReason(state));
    expect(findControlMessage(legacy.sentMessages[1])).toBe(
      selectAgentControlMessage(reason, controlMessages),
    );
  });

  it("matches abort after tool execution without recording result tokens", async () => {
    const scenario: Scenario = {
      toolName: "read_scene",
      maxToolCalls: 10,
      maxUserQuestions: 8,
      tokenBudget: 100,
      tokensUsed: 50,
      abortAfterTool: true,
    };
    const legacy = await runLegacy(scenario);
    const state = replayRules(scenario);
    expect(legacy.result.stoppedReason).toBe(resolveAgentStoppedReason(state));
    expect(legacy.result.stoppedReason).toBe("aborted");
    expect(legacy.sentMessages).toHaveLength(1);
    expect(legacy.result.toolCallRecords).toHaveLength(0);
    expect(state.tokensUsed).toBe(0);
  });

  it("matches a normal completed response", async () => {
    const scenario: Scenario = { toolName: null, tokenBudget: 100 };
    const legacy = await runLegacy(scenario);
    const state = replayRules(scenario);
    expect(legacy.result.stoppedReason).toBe(resolveAgentStoppedReason(state));
    expect(legacy.result.stoppedReason).toBe("completed");
    expect(legacy.sentMessages).toHaveLength(1);
  });

  it("keeps maxSteps at or above legacy sends for window limits and zero limits", async () => {
    for (const maxToolCalls of [25, 16, 12, 10]) {
      const runAgentLoop = await loadLegacyLoop();
      const maxUserQuestions = 8;
      const toolNames = [
        ...Array.from({ length: maxToolCalls - 1 }, () => "read_scene"),
        ...Array.from({ length: maxUserQuestions }, () => "ask_user"),
      ];
      let sent = 0;
      const result = await runAgentLoop({
        messages: [{ role: "user", content: "start" }],
        tools: [{ name: "read_scene" }, { name: "ask_user" }] as never,
        tokenBudget: 100_000,
        maxToolCalls,
        maxUserQuestions,
        sendToLLM: async () => {
          const toolName = toolNames[sent++];
          return toolName ? toolResponse(toolName) : endResponse();
        },
        executeTool: async (name, toolCallId) =>
          ({
            name,
            toolCallId,
            content: null,
            summary: "summary",
            tokensUsed: 0,
          }) as never,
        onProgress: () => undefined,
        onTextChunk: () => undefined,
        callLimitMessage: controlMessages.callLimitMessage,
        tokenBudgetMessage: controlMessages.tokenBudgetMessage,
        userQuestionLimitMessage: controlMessages.userQuestionLimitMessage,
      });
      expect(result.stoppedReason).toBe("limit_questions");
      expect(sent).toBe(maxToolCalls + maxUserQuestions);
      expect(
        deriveAgentMaxSteps(maxToolCalls, maxUserQuestions),
      ).toBeGreaterThanOrEqual(sent);
    }

    const zeroLimit = await runLegacy({
      toolName: "read_scene",
      maxToolCalls: 0,
      maxUserQuestions: 0,
      tokenBudget: 0,
      tokensUsed: 0,
    });
    expect(zeroLimit.result.stoppedReason).toBe("limit_questions");
    expect(zeroLimit.sentMessages).toHaveLength(2);
    expect(deriveAgentMaxSteps(0, 0)).toBeGreaterThanOrEqual(
      zeroLimit.sentMessages.length,
    );
  });

  it("matches the 25 percent tool-result cap and truncation marker", async () => {
    const scenario: Scenario = {
      toolName: "read_scene",
      maxToolCalls: 10,
      maxUserQuestions: 8,
      tokenBudget: 8,
      tokensUsed: 0,
      resultContent: "abcdefgh",
    };
    const legacy = await runLegacy(scenario);
    const state = replayRules(scenario);
    const legacyResult = findToolResult(legacy.sentMessages[1]);
    const rulesResult = formatToolResult(
      { content: scenario.resultContent, summary: "summary" },
      scenario.tokenBudget,
      (text) => text.length,
    );
    expect(legacy.result.stoppedReason).toBe(resolveAgentStoppedReason(state));
    expect(legacyResult?.content).toBe(rulesResult.content);
    expect(legacyResult?.isError).toBe(rulesResult.isError);
    expect(rulesResult.content).toBe('"a...[truncated: 元 10 tokens]');
  });

  it("matches legacy when JSON.stringify returns undefined for content", async () => {
    const content = { toJSON: () => undefined };
    const scenario: Scenario = {
      toolName: "read_scene",
      tokenBudget: 100,
      resultContent: content,
    };
    const legacyError = await runLegacy(scenario).catch(
      (error: unknown) => error,
    );
    let rulesError: unknown;
    try {
      formatToolResult(
        { content, summary: "summary" },
        100,
        (text) => text.length,
      );
    } catch (error) {
      rulesError = error;
    }

    expect(legacyError).toBeInstanceOf(TypeError);
    expect(rulesError).toBeInstanceOf(TypeError);
    expect((rulesError as Error).message).toBe((legacyError as Error).message);
  });
});
