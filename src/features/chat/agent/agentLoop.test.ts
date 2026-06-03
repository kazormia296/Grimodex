import { describe, it, expect, vi } from "vitest";

// ensureTokenizer は WASM ロードを伴うのでスタブ化（ループのロジックだけ検証する）。
vi.mock("../contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
}));

import { runAgentLoop, type AgentLoopOptions } from "./agentLoop";
import type { AgentLLMResponse, ToolResult } from "./agentTypes";

function toolUseResponse(
  name: string,
  id = "tool-1",
  input: Record<string, unknown> = {},
): AgentLLMResponse {
  return {
    blocks: [{ type: "tool_use", id, name, input }],
    stopReason: "tool_use",
  };
}

function endResponse(text = "done"): AgentLLMResponse {
  return { blocks: [{ type: "text", content: text }], stopReason: "end_turn" };
}

function toolResult(overrides: Partial<ToolResult> = {}): ToolResult {
  return {
    toolCallId: "tool-1",
    name: "search_codex",
    content: { ok: true },
    summary: "ok",
    tokensUsed: 5,
    ...overrides,
  };
}

function baseOptions(over: Partial<AgentLoopOptions> = {}): AgentLoopOptions {
  return {
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    tokenBudget: 100_000,
    sendToLLM: vi.fn(),
    executeTool: vi.fn(async () => toolResult()),
    onProgress: vi.fn(),
    onTextChunk: vi.fn(),
    callLimitMessage: "CALL_LIMIT",
    tokenBudgetMessage: "TOKEN_LIMIT",
    userQuestionLimitMessage: "UQ_LIMIT",
    ...over,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("runAgentLoop", () => {
  it("awaits a slow tool Promise before calling the LLM again", async () => {
    let resolveTool!: (r: ToolResult) => void;
    const pending = new Promise<ToolResult>((res) => {
      resolveTool = res;
    });
    const sendToLLM = vi
      .fn<AgentLoopOptions["sendToLLM"]>()
      .mockResolvedValueOnce(toolUseResponse("ask_user"))
      .mockResolvedValueOnce(endResponse());
    const executeTool = vi.fn(() => pending);

    const loop = runAgentLoop(baseOptions({ sendToLLM, executeTool }));
    await tick();

    // ツールが未解決の間は次の sendToLLM を呼ばない（= ループが待機している）。
    expect(sendToLLM).toHaveBeenCalledTimes(1);

    resolveTool(toolResult({ name: "ask_user" }));
    await loop;

    expect(sendToLLM).toHaveBeenCalledTimes(2);
  });

  it("aborts after a tool resolves without firing the next LLM call (runaway guard)", async () => {
    let resolveTool!: (r: ToolResult) => void;
    const pending = new Promise<ToolResult>((res) => {
      resolveTool = res;
    });
    let aborted = false;
    const sendToLLM = vi
      .fn<AgentLoopOptions["sendToLLM"]>()
      .mockResolvedValue(toolUseResponse("ask_user"));
    const executeTool = vi.fn(() => pending);

    const loop = runAgentLoop(
      baseOptions({ sendToLLM, executeTool, shouldAbort: () => aborted }),
    );
    await tick();
    expect(sendToLLM).toHaveBeenCalledTimes(1);

    // Stop 相当: 中断フラグを立ててから Promise を解決する。
    aborted = true;
    resolveTool(toolResult({ name: "ask_user" }));
    await loop;

    // 解決後に sendToLLM が再発火していないこと（暴走しない）。
    expect(sendToLLM).toHaveBeenCalledTimes(1);
  });

  it("does not start a new turn when aborted between turns", async () => {
    let aborted = false;
    const sendToLLM = vi
      .fn<AgentLoopOptions["sendToLLM"]>()
      .mockImplementation(async () => {
        aborted = true; // 1ターン目の LLM 応答後に中断要求が入る想定
        return toolUseResponse("search_codex");
      });
    const loop = runAgentLoop(
      baseOptions({ sendToLLM, shouldAbort: () => aborted }),
    );
    await loop;
    // tool 実行直後の abort チェックで return するため、2ターン目は無い。
    expect(sendToLLM).toHaveBeenCalledTimes(1);
  });

  it("exempts ask_user from MAX_TOOL_CALLS and caps it via MAX_USER_QUESTIONS", async () => {
    const sendToLLM = vi
      .fn<AgentLoopOptions["sendToLLM"]>()
      .mockResolvedValue(toolUseResponse("ask_user"));
    const executeTool = vi.fn(async () =>
      toolResult({ name: "ask_user", tokensUsed: 1 }),
    );
    await runAgentLoop(baseOptions({ sendToLLM, executeTool }));

    // ask_user だけを繰り返すと、データツール上限(10)ではなく質問上限(8)で止まる。
    // 挿入される制御メッセージが UQ_LIMIT であることがその証左。
    const lastCallMessages = sendToLLM.mock.calls.at(-1)?.[0] ?? [];
    const hasUqLimit = lastCallMessages.some(
      (m) => "content" in m && m.content === "UQ_LIMIT",
    );
    const hasCallLimit = lastCallMessages.some(
      (m) => "content" in m && m.content === "CALL_LIMIT",
    );
    expect(hasUqLimit).toBe(true);
    expect(hasCallLimit).toBe(false);
  });

  it("counts data tools toward MAX_TOOL_CALLS", async () => {
    const sendToLLM = vi
      .fn<AgentLoopOptions["sendToLLM"]>()
      .mockResolvedValue(toolUseResponse("search_codex"));
    const executeTool = vi.fn(async () =>
      toolResult({ name: "search_codex", tokensUsed: 1 }),
    );
    await runAgentLoop(baseOptions({ sendToLLM, executeTool }));

    const lastCallMessages = sendToLLM.mock.calls.at(-1)?.[0] ?? [];
    const hasCallLimit = lastCallMessages.some(
      (m) => "content" in m && m.content === "CALL_LIMIT",
    );
    expect(hasCallLimit).toBe(true);
  });
});
