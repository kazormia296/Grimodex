import { readFileSync } from "node:fs";
import * as ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  ASK_USER_TOOL_NAME,
  DEFAULT_MAX_TOOL_CALLS,
  DEFAULT_MAX_USER_QUESTIONS,
  TOOL_RESULT_TOKEN_CAP_RATIO,
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

const source = readFileSync(
  new URL("./agentLoopRules.ts", import.meta.url),
  "utf8",
);
const ast = ts.createSourceFile(
  "agentLoopRules.ts",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const imports = ast.statements.filter(ts.isImportDeclaration);

describe("agentLoopRules module boundary", () => {
  it("has no Mastra imports and only type imports from electron/shared", () => {
    expect(source).not.toContain("@mastra/");
    expect(
      imports.every((declaration) => {
        const specifier = ts.isStringLiteral(declaration.moduleSpecifier)
          ? declaration.moduleSpecifier.text
          : "";
        const importsShared =
          specifier === "electron/shared" ||
          specifier.startsWith("electron/shared/") ||
          specifier === "../../shared" ||
          specifier.startsWith("../../shared/");
        return importsShared && declaration.importClause?.isTypeOnly === true;
      }),
    ).toBe(true);
  });
});

describe("agent loop rules", () => {
  it("uses legacy defaults while accepting the caller's token budget", () => {
    expect(DEFAULT_MAX_TOOL_CALLS).toBe(10);
    expect(DEFAULT_MAX_USER_QUESTIONS).toBe(8);
    expect(TOOL_RESULT_TOKEN_CAP_RATIO).toBe(0.25);
    expect(createAgentLoopRuleState({ tokenBudget: 321 })).toMatchObject({
      maxToolCalls: 10,
      maxUserQuestions: 8,
      tokenBudget: 321,
    });
  });

  it("counts ask_user separately and ignores non-tool and post-limit responses", () => {
    let state = createAgentLoopRuleState({
      maxToolCalls: 2,
      maxUserQuestions: 3,
      tokenBudget: 100,
    });
    expect(
      recordToolUsesForResponse(state, "end_turn", [ASK_USER_TOOL_NAME]),
    ).toBe(state);

    state = recordToolUsesForResponse(state, "tool_use", [
      ASK_USER_TOOL_NAME,
      "read_scene",
    ]);
    expect(state).toMatchObject({ totalCalls: 1, userQuestionCalls: 1 });

    state = recordToolUsesForResponse(state, "tool_use", [
      ASK_USER_TOOL_NAME,
      "read_scene",
    ]);
    state = insertLimitMessage({
      ...state,
      totalCalls: 2,
      userQuestionCalls: 3,
    });
    const limited = recordToolUsesForResponse(state, "tool_use", ["another"]);
    expect(limited).toBe(state);
    expect(limited.limitReason).toBe("limit_questions");
  });

  it("uses >= at zero, one, and large limits", () => {
    const zero = createAgentLoopRuleState({
      maxToolCalls: 0,
      maxUserQuestions: 0,
      tokenBudget: 0,
    });
    const afterZeroBatch = recordToolUsesForResponse(zero, "tool_use", [
      "read_scene",
      ASK_USER_TOOL_NAME,
    ]);
    expect(getAgentLimitReason(afterZeroBatch)).toBe("limit_questions");

    const one = createAgentLoopRuleState({
      maxToolCalls: 1,
      maxUserQuestions: 1,
      tokenBudget: 1,
    });
    expect(
      getAgentLimitReason(
        recordToolUsesForResponse(one, "tool_use", ["read_scene"]),
      ),
    ).toBe("limit_calls");

    const large = createAgentLoopRuleState({
      maxToolCalls: 10_000,
      maxUserQuestions: 10_000,
      tokenBudget: 10_000,
    });
    expect(
      getAgentLimitReason(
        recordToolUsesForResponse(large, "tool_use", ["read_scene"]),
      ),
    ).toBeNull();
  });

  it("chooses questions, then calls, then tokens when limits coincide", () => {
    let state = createAgentLoopRuleState({
      maxToolCalls: 1,
      maxUserQuestions: 1,
      tokenBudget: 1,
    });
    state = recordToolUsesForResponse(state, "tool_use", [
      "read_scene",
      ASK_USER_TOOL_NAME,
    ]);
    state = recordToolResultTokens(state, 1);
    expect(getAgentLimitReason(state)).toBe("limit_questions");

    state = { ...state, userQuestionCalls: 0 };
    expect(getAgentLimitReason(state)).toBe("limit_calls");
    state = { ...state, totalCalls: 0 };
    expect(getAgentLimitReason(state)).toBe("limit_tokens");
  });

  it("selects the supplied localized message and preserves the legacy fallback", () => {
    const messages = {
      uiLanguage: "ja",
      callLimitMessage: "呼び出し上限",
      tokenBudgetMessage: "token 上限",
      userQuestionLimitMessage: "質問上限",
    };
    expect(selectAgentControlMessage("limit_questions", messages)).toBe(
      "質問上限",
    );
    expect(selectAgentControlMessage("limit_calls", messages)).toBe(
      "呼び出し上限",
    );
    expect(selectAgentControlMessage("limit_tokens", messages)).toBe(
      "token 上限",
    );
    expect(
      selectAgentControlMessage("limit_questions", {
        ...messages,
        userQuestionLimitMessage: undefined,
      }),
    ).toBe("呼び出し上限");
  });

  it("resolves completed, limited, and aborted outcomes with abort taking priority", () => {
    let state = createAgentLoopRuleState({ tokenBudget: 20 });
    expect(resolveAgentStoppedReason(state)).toBe("completed");
    state = insertLimitMessage({ ...state, totalCalls: 10 });
    expect(resolveAgentStoppedReason(state)).toBe("limit_calls");
    expect(resolveAgentStoppedReason(markAgentLoopAborted(state))).toBe(
      "aborted",
    );
    const aborted = markAgentLoopAborted({ ...state, totalCalls: 10 });
    expect(recordToolUsesForResponse(aborted, "tool_use", ["read_scene"])).toBe(
      aborted,
    );
    expect(recordToolResultTokens(aborted, 10)).toBe(aborted);
    expect(insertLimitMessage(aborted)).toBe(aborted);
  });

  it("counts the observed batch before a mid-batch abort", () => {
    const batch = recordToolUsesForResponse(
      createAgentLoopRuleState({ tokenBudget: 100 }),
      "tool_use",
      [ASK_USER_TOOL_NAME, "read_scene"],
    );
    const aborted = markAgentLoopAborted(batch);
    expect(aborted).toMatchObject({ userQuestionCalls: 1, totalCalls: 1 });
    expect(resolveAgentStoppedReason(aborted)).toBe("aborted");
  });

  it("formats tool results at the exact cap and truncates cap plus one", () => {
    const exact = formatToolResult(
      { content: "", summary: "unused" },
      8,
      (text) => text.length,
    );
    expect(exact).toEqual({ content: '""', isError: false });

    const over = formatToolResult(
      { content: "a", summary: "unused" },
      8,
      (text) => text.length,
    );
    expect(over).toEqual({
      content: '"a...[truncated: 元 3 tokens]',
      isError: false,
    });

    expect(
      formatToolResult({ content: "a", summary: "unused" }, 0, () => 1).content,
    ).toBe('"a"');
  });

  it("caps error content, uses null summaries, and propagates tokenizer errors", () => {
    let counted = "";
    const errorResult = formatToolResult(
      { content: null, summary: "unused", error: "bad" },
      100,
      (text) => {
        counted = text;
        return text.length;
      },
    );
    expect(counted).toBe("Error: bad");
    expect(errorResult).toEqual({ content: "Error: bad", isError: true });
    expect(
      formatToolResult(
        { content: null, summary: "unused", error: "abcdefgh" },
        8,
        (text) => text.length,
      ),
    ).toEqual({
      content: "Er...[truncated: 元 15 tokens]",
      isError: true,
    });
    expect(
      formatToolResult(
        { content: null, summary: "", error: undefined },
        100,
        (text) => text.length,
      ).content,
    ).toBe("No result (not found).");
    expect(() =>
      formatToolResult({ content: "value", summary: "unused" }, 100, () => {
        throw new Error("tokenizer failed");
      }),
    ).toThrow("tokenizer failed");
  });

  it("derives maxSteps from both counters and covers legacy's zero-limit sends", () => {
    expect(deriveAgentMaxSteps()).toBe(18);
    expect(
      [25, 16, 12, 10].map((calls) => deriveAgentMaxSteps(calls, 8)),
    ).toEqual([33, 24, 20, 18]);
    expect(deriveAgentMaxSteps(1, 1)).toBe(2);
    expect(deriveAgentMaxSteps(0, 0)).toBe(2);
    expect(deriveAgentMaxSteps(0, 1)).toBe(2);
    expect(() => deriveAgentMaxSteps(1.1, 1)).toThrow(
      "maxToolCalls must be a non-negative integer",
    );
    expect(() => deriveAgentMaxSteps(1, 1.1)).toThrow(
      "maxUserQuestions must be a non-negative integer",
    );
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() => deriveAgentMaxSteps(invalid, 1)).toThrow(RangeError);
      expect(() => deriveAgentMaxSteps(1, invalid)).toThrow(RangeError);
    }
  });
});
