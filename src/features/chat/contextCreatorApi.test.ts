import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockRunAgentLoop,
  mockBlockIfPolicyOff,
  mockBlockIfUnlicensed,
  mockRecordAiUsage,
} = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockBlockIfPolicyOff: vi.fn<() => boolean>(),
  mockBlockIfUnlicensed: vi.fn<() => boolean>(),
  mockRecordAiUsage: vi.fn(),
}));

vi.mock("./agent/agentLoop", () => ({ runAgentLoop: mockRunAgentLoop }));
// 実 LLM / DB に触れる依存はすべてスタブ化（パースとゲートのロジックだけ検証する）。
vi.mock("./agent/toolExecutors", () => ({ executeTool: vi.fn() }));
vi.mock("./agent/toolDefinitions", () => ({ AGENT_TOOLS: [] }));
vi.mock("./agent/modelLimits", () => ({
  buildThinkingParams: vi.fn(() => ({})),
  getEffortForTask: vi.fn(() => "low"),
}));
vi.mock("./chatApi", () => ({ sendAgentMessage: vi.fn() }));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: mockRecordAiUsage,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: mockBlockIfPolicyOff,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: mockBlockIfUnlicensed,
}));

import { runContextCreator } from "./contextCreatorApi";
import type { AgentLoopOptions, AgentLoopResult } from "./agent/agentLoop";

function loopResult(finalText: string): AgentLoopResult {
  return {
    finalText,
    toolCallRecords: [],
    finalThinkingBlocks: [],
    citations: [],
    cost: null,
    tokensIn: null,
    tokensOut: null,
  };
}

describe("runContextCreator — policy / license chokepoints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBlockIfPolicyOff.mockReturnValue(false);
    mockBlockIfUnlicensed.mockReturnValue(false);
    mockRunAgentLoop.mockResolvedValue(loopResult("[]"));
  });

  it("blocks before any LLM call when chat policy is off", async () => {
    mockBlockIfPolicyOff.mockReturnValue(true);
    const res = await runContextCreator("instr", [], "model-x");
    expect(res).toEqual([]);
    expect(mockBlockIfPolicyOff).toHaveBeenCalledWith("chat");
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
    expect(mockRecordAiUsage).not.toHaveBeenCalled();
  });

  it("blocks before any LLM call when license is restricted", async () => {
    mockBlockIfUnlicensed.mockReturnValue(true);
    const res = await runContextCreator("instr", [], "model-x");
    expect(res).toEqual([]);
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
  });

  it("runs the agent loop when both gates pass", async () => {
    await runContextCreator("instr", [], "model-x");
    expect(mockRunAgentLoop).toHaveBeenCalledTimes(1);
  });
});

describe("runContextCreator — final-message JSON extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBlockIfPolicyOff.mockReturnValue(false);
    mockBlockIfUnlicensed.mockReturnValue(false);
  });

  const entry = (id: string) =>
    `{"id":"${id}","name":"朱音","type":"character","summary":"s","reason":"r"}`;

  it("parses only the final assistant message, ignoring intermediate-turn text", async () => {
    mockRunAgentLoop.mockImplementation(
      async (options: AgentLoopOptions): Promise<AgentLoopResult> => {
        // 中間 tool-use ターンの説明文（stray '[' を含む）も onTextChunk される。
        options.onTextChunk("検索します [codex を見ます");
        return loopResult(`完了。[${entry("e1")}]`);
      },
    );

    const res = await runContextCreator("instr", [], "m");
    expect(res).toEqual([
      {
        id: "e1",
        name: "朱音",
        type: "character",
        summary: "s",
        reason: "r",
        alreadyPinned: false,
      },
    ]);
  });

  it("extracts a balanced array despite stray brackets around it in the final message", async () => {
    mockRunAgentLoop.mockResolvedValue(
      loopResult(`メモ [下書き] です。\n[${entry("e2")}]\nおわり`),
    );
    const res = await runContextCreator("instr", [], "m");
    expect(res.map((e) => e.id)).toEqual(["e2"]);
  });

  it("picks the last parseable array when multiple arrays appear", async () => {
    mockRunAgentLoop.mockResolvedValue(
      loopResult(`例: ["sample"]\n結果: [${entry("e9")}]`),
    );
    const res = await runContextCreator("instr", [], "m");
    expect(res.map((e) => e.id)).toEqual(["e9"]);
  });

  it("prefers the outer entry array over nested array fields like aliases", async () => {
    // 最後の '[' から走査すると aliases の内側配列が先にパース成功してしまう。
    // id 付きオブジェクトを含む配列を優先することで外側を採用する。
    mockRunAgentLoop.mockResolvedValue(
      loopResult(
        '[{"id":"e7","name":"朱音","type":"character","summary":"s","reason":"r","aliases":["朱","音"]}]',
      ),
    );
    const res = await runContextCreator("instr", [], "m");
    expect(res.map((e) => e.id)).toEqual(["e7"]);
  });

  it("handles brackets inside JSON string values", async () => {
    mockRunAgentLoop.mockResolvedValue(
      loopResult(
        '[{"id":"e4","name":"印章 [王家]","type":"item","summary":"","reason":""}]',
      ),
    );
    const res = await runContextCreator("instr", [], "m");
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe("印章 [王家]");
  });

  it("returns [] when the final message has no JSON array", async () => {
    mockRunAgentLoop.mockResolvedValue(
      loopResult("該当するエントリは見つかりませんでした。"),
    );
    const res = await runContextCreator("instr", [], "m");
    expect(res).toEqual([]);
  });

  it("flags alreadyPinned entries from pinnedIds", async () => {
    mockRunAgentLoop.mockResolvedValue(loopResult(`[${entry("e3")}]`));
    const res = await runContextCreator("instr", ["e3"], "m");
    expect(res[0].alreadyPinned).toBe(true);
  });
});
