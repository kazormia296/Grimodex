import { describe, it, expect, vi } from "vitest";

// ensureTokenizer は WASM ロードを伴うのでスタブ化（ループのロジックだけ検証する）。
vi.mock("../contextBuilder", () => ({
  ensureTokenizer: vi.fn(async () => {}),
}));

import { runAgentLoop, type AgentLoopOptions } from "./agentLoop";
import type {
  AgentLLMResponse,
  AgentToolDefinition,
  ToolResult,
  Citation,
  ResponseBlock,
} from "./agentTypes";
import { parseHermesToolCalls } from "../toolProtocolParse";

/** テスト用の最小ツール定義（dispatch 宣言ゲートが参照するのは name のみ）。 */
function tool(name: string): AgentToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: "object", properties: {}, required: [] },
  };
}

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
    // 既存テストが使うツール名を宣言しておく（dispatch 宣言ゲートが
    // 未宣言ツールを拒否するため、宣言しないと実行されない）。
    tools: [tool("search_codex"), tool("ask_user")],
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

// ── dispatch 宣言ゲート (security review F-2) ────────────────────────────────
describe("runAgentLoop — declared-tools dispatch gate", () => {
  // 実際の脅威を直接固定: get_scene は EXECUTORS に存在する実ツールだが、
  // このターンで宣言していなければ実行されてはならない（未実装名だと既存の
  // unknown-tool パスと区別できないため、あえて既存 executor 名でテストする）。
  it("rejects an undeclared but real executor (get_scene) without calling executeTool", async () => {
    const sendToLLM = vi
      .fn<AgentLoopOptions["sendToLLM"]>()
      .mockResolvedValueOnce(toolUseResponse("get_scene"))
      .mockResolvedValueOnce(endResponse("recovered"));
    const executeTool = vi.fn(async () => toolResult());

    const res = await runAgentLoop(
      baseOptions({
        tools: [tool("search_codex")], // get_scene は宣言しない
        sendToLLM,
        executeTool,
      }),
    );

    // executeTool は未宣言ツールについて一度も呼ばれない。
    expect(executeTool).not.toHaveBeenCalled();
    // ループは止まらず error tool_result を積んで次ターンへ進み回復する。
    expect(sendToLLM).toHaveBeenCalledTimes(2);
    expect(res.finalText).toBe("recovered");
    // 拒否は error tool_result として次ターンの会話履歴に渡る。
    const secondTurnMessages = sendToLLM.mock.calls[1]?.[0] ?? [];
    const hasErrorToolResult = secondTurnMessages.some(
      (m) =>
        "content" in m &&
        typeof m.content === "string" &&
        m.content.includes("Tool not available this turn: get_scene"),
    );
    expect(hasErrorToolResult).toBe(true);
  });

  it("executes a declared tool normally (gate passes)", async () => {
    const sendToLLM = vi
      .fn<AgentLoopOptions["sendToLLM"]>()
      .mockResolvedValueOnce(toolUseResponse("get_scene"))
      .mockResolvedValueOnce(endResponse());
    const executeTool = vi.fn(async () =>
      toolResult({ name: "get_scene", tokensUsed: 3 }),
    );

    await runAgentLoop(
      baseOptions({
        tools: [tool("get_scene")], // 今度は宣言する
        sendToLLM,
        executeTool,
      }),
    );

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith("get_scene", "tool-1", {});
  });
});

// ── Web 検索 (RAG): 引用・コストの累積 ──────────────────────────────────────
const cite = (url: string): Citation => ({ url, title: "t", citedText: "x" });

/** responses を順に返す sendToLLM を持つ options を作る（baseOptions 流用）。 */
function seqOptions(responses: AgentLLMResponse[]): AgentLoopOptions {
  let i = 0;
  return baseOptions({
    sendToLLM: vi.fn(() => Promise.resolve(responses[i++])),
    executeTool: vi.fn(async () =>
      toolResult({ name: "search_codex", tokensUsed: 10 }),
    ),
  });
}

describe("runAgentLoop — web search citations/cost accumulation", () => {
  it("returns citations and cost from a single end_turn response", async () => {
    const res = await runAgentLoop(
      seqOptions([
        {
          blocks: [{ type: "text", content: "answer" }],
          stopReason: "end_turn",
          citations: [cite("https://a.com")],
          cost: 0.012,
        },
      ]),
    );
    expect(res.finalText).toBe("answer");
    expect(res.citations.map((c) => c.url)).toEqual(["https://a.com"]);
    expect(res.cost).toBe(0.012);
  });

  it("accumulates across iterations, dedupes citations by url, sums cost", async () => {
    const res = await runAgentLoop(
      seqOptions([
        {
          blocks: [
            { type: "tool_use", id: "t1", name: "search_codex", input: {} },
          ],
          stopReason: "tool_use",
          citations: [cite("https://a.com")],
          cost: 0.01,
        },
        {
          blocks: [{ type: "text", content: "final" }],
          stopReason: "end_turn",
          citations: [cite("https://a.com"), cite("https://b.com")],
          cost: 0.02,
        },
      ]),
    );
    expect(res.finalText).toBe("final");
    expect(res.citations.map((c) => c.url)).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
    expect(res.cost).toBeCloseTo(0.03, 5);
  });

  it("leaves cost null and citations empty when none provided (non-RAG)", async () => {
    const res = await runAgentLoop(
      seqOptions([
        {
          blocks: [{ type: "text", content: "plain" }],
          stopReason: "end_turn",
        },
      ]),
    );
    expect(res.citations).toEqual([]);
    expect(res.cost).toBeNull();
  });
});

// ── Hermes インバウンド契約 (受信パーサ) ────────────────────────────────────
// 実機なしで「本文 <tool_call> → 実 ToolUse → loop が turn-1 で終了しない」を
// 証明する。critical step (Hermes 本文 → blocks) は実パーサ parseHermesToolCalls
// を通すことで、parse_openai_response / parseOpenAIAgentResponse と同契約を担保。
describe("runAgentLoop — Hermes inbound contract", () => {
  /** parseOpenAIAgentResponse の Hermes 分岐と同じマッピングで応答を組む。 */
  function hermesResponse(body: string, allowed: string[]): AgentLLMResponse {
    const { strippedText, calls } = parseHermesToolCalls(body, allowed);
    const blocks: ResponseBlock[] = [];
    if (strippedText) blocks.push({ type: "text", content: strippedText });
    for (const c of calls) {
      blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.input });
    }
    return {
      blocks,
      stopReason: calls.length > 0 ? "tool_use" : "end_turn",
    };
  }

  it("continues past turn 1 on a body <tool_call> and executes the tool", async () => {
    const body =
      '検索します。\n<tool_call>{"name":"search_codex","arguments":{"query":"朱音"}}</tool_call>';
    const sendToLLM = vi
      .fn<AgentLoopOptions["sendToLLM"]>()
      .mockResolvedValueOnce(hermesResponse(body, ["search_codex"]))
      .mockResolvedValueOnce(endResponse("final"));
    const executeTool = vi.fn(async () => toolResult({ name: "search_codex" }));

    const res = await runAgentLoop(baseOptions({ sendToLLM, executeTool }));

    // turn-1 で終了せず、合成 ID 付きでツールを実行し、2 ターン目で完了する。
    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(executeTool).toHaveBeenCalledWith("search_codex", "hermes-0", {
      query: "朱音",
    });
    expect(sendToLLM).toHaveBeenCalledTimes(2);
    expect(res.finalText).toBe("final");
  });
});
