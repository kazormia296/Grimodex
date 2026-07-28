import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockRunAgentLoop,
  mockBlockIfPolicyOff,
  mockBlockIfUnlicensed,
  mockRecordAiUsage,
  mockRefreshDynamicCaps,
  mockSendAgentMessage,
  mockEnsureTokenizer,
  mockCountTokens,
} = vi.hoisted(() => ({
  mockRunAgentLoop: vi.fn(),
  mockBlockIfPolicyOff: vi.fn<() => boolean>(),
  mockBlockIfUnlicensed: vi.fn<() => boolean>(),
  mockRecordAiUsage: vi.fn(),
  mockRefreshDynamicCaps: vi.fn(),
  mockSendAgentMessage: vi.fn(),
  mockEnsureTokenizer: vi.fn(() => Promise.resolve()),
  mockCountTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

vi.mock("./agent/agentLoop", () => ({ runAgentLoop: mockRunAgentLoop }));
// 実 LLM / DB に触れる依存はすべてスタブ化（パースとゲートのロジックだけ検証する）。
vi.mock("./agent/toolExecutors", () => ({ executeTool: vi.fn() }));
vi.mock("./agent/toolDefinitions", () => ({ AGENT_TOOLS: [] }));
vi.mock("./agent/modelLimits", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./agent/modelLimits")>();
  return {
    ...actual,
    buildThinkingParams: vi.fn(() => ({})),
    getEffortForTask: vi.fn(() => "low"),
  };
});
vi.mock("./chatApi", () => ({ sendAgentMessage: mockSendAgentMessage }));
vi.mock("./store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./store")>();
  return {
    ...actual,
    refreshDynamicCapsForProvider: mockRefreshDynamicCaps,
  };
});
vi.mock("./contextBuilder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./contextBuilder")>();
  return {
    ...actual,
    ensureTokenizer: mockEnsureTokenizer,
    countTokens: mockCountTokens,
  };
});
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: mockRecordAiUsage,
}));
vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: mockBlockIfPolicyOff,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: mockBlockIfUnlicensed,
}));

import {
  canAttemptContextCreator,
  runContextCreator,
} from "./contextCreatorApi";
import type { AgentLoopOptions, AgentLoopResult } from "./agent/agentLoop";
import {
  __resetDynamicModelCapsForTests,
  registerDynamicModelCaps,
} from "./agent/dynamicModelCaps";
import { DEFAULT_AI_SETTINGS, useAiSettingsStore } from "./store";
import type { AiModel } from "./types";
import { useSettingsStore } from "@/features/settings/settingsStore";
import { roleSettingKey, ROLE_PROVIDERS_KEY } from "./modelRouting";

function loopResult(finalText: string): AgentLoopResult {
  return {
    finalText,
    toolCallRecords: [],
    finalThinkingBlocks: [],
    citations: [],
    cost: null,
    tokensIn: null,
    tokensOut: null,
    stoppedReason: "completed",
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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

  it("rechecks policy immediately before every LLM transport", async () => {
    mockRunAgentLoop.mockImplementation(
      async (options: AgentLoopOptions): Promise<AgentLoopResult> => {
        mockBlockIfPolicyOff.mockReturnValue(true);
        await options.sendToLLM(options.messages, options.tools);
        return loopResult("[]");
      },
    );

    await expect(runContextCreator("instr", [], "model-x")).rejects.toThrow(
      "route changed during execution",
    );
    expect(mockSendAgentMessage).not.toHaveBeenCalled();
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

describe("runContextCreator — Ollama route preflight", () => {
  const ollamaEndpoint = "http://localhost:11434";
  const modelId = "gemma4:latest";
  const modelWithRunnerContext: AiModel = {
    id: modelId,
    name: modelId,
    contextLength: 131_072,
    effectiveContextLength: 65_536,
    effectiveContextSource: "runner",
    supportedParameters: ["tools"],
  };
  let previousSettings: ReturnType<
    typeof useAiSettingsStore.getState
  >["settings"];
  let previousCache: Record<string, string>;

  beforeEach(() => {
    vi.clearAllMocks();
    __resetDynamicModelCapsForTests();
    previousSettings = useAiSettingsStore.getState().settings;
    previousCache = useSettingsStore.getState().cache;
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "ollama",
        model: modelId,
        ollamaEndpoint,
        ollamaContextLengths: {},
      },
      chatModelOverride: null,
      chatProviderOverride: null,
      chatModelVariantOverride: null,
      chatEndpointIdOverride: null,
      models: [],
    });
    useSettingsStore.setState((state) => ({
      cache: {
        ...state.cache,
        [roleSettingKey("agent")]: "",
        [ROLE_PROVIDERS_KEY]: "{}",
      },
    }));
    mockBlockIfPolicyOff.mockReturnValue(false);
    mockBlockIfUnlicensed.mockReturnValue(false);
    mockSendAgentMessage.mockResolvedValue({
      blocks: [{ type: "text", content: "[]" }],
      stopReason: "end_turn",
    });
    mockRunAgentLoop.mockImplementation(
      async (options: AgentLoopOptions): Promise<AgentLoopResult> => {
        await options.sendToLLM(options.messages, options.tools);
        return loopResult("[]");
      },
    );
  });

  afterEach(() => {
    __resetDynamicModelCapsForTests();
    useAiSettingsStore.setState({
      settings: previousSettings,
      chatModelOverride: null,
      chatProviderOverride: null,
      chatModelVariantOverride: null,
      chatEndpointIdOverride: null,
      models: [],
    });
    useSettingsStore.setState({ cache: previousCache });
  });

  it("keeps the Creator entry point available for a cached no-tools cross-provider Ollama role", () => {
    registerDynamicModelCaps("openrouter", [
      {
        id: "completion-only-cloud",
        name: "Completion only cloud",
        supportedParameters: [],
      },
    ]);
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "replaceable-agent:latest",
          name: "Replaceable Agent",
          supportedParameters: [],
        },
      ],
      { ollamaEndpoint },
    );
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openrouter",
        model: "completion-only-cloud",
        ollamaEndpoint,
      },
    });
    useSettingsStore.setState((state) => ({
      cache: {
        ...state.cache,
        [roleSettingKey("agent")]: "replaceable-agent:latest",
        [ROLE_PROVIDERS_KEY]: JSON.stringify({
          agent: { provider: "ollama" },
        }),
      },
    }));

    expect(canAttemptContextCreator(null)).toBe(true);
  });

  it("uses /api/show and runner metadata instead of the unknown-model 8k fallback", async () => {
    mockRefreshDynamicCaps.mockImplementation(async () => {
      registerDynamicModelCaps("ollama", [modelWithRunnerContext], {
        ollamaEndpoint,
        selectedModelId: modelId,
      });
      return [modelWithRunnerContext];
    });

    await expect(
      runContextCreator("関連人物を探す", [], modelId),
    ).resolves.toEqual([]);

    expect(mockRefreshDynamicCaps).toHaveBeenCalledWith("ollama", {
      force: true,
      selectedModelId: modelId,
      ollamaEndpoint,
      requireOllamaCapabilities: true,
    });
    expect(mockSendAgentMessage).toHaveBeenCalledOnce();
    expect(mockSendAgentMessage.mock.calls[0]?.[7]).toBe(modelId);
    expect(mockSendAgentMessage.mock.calls[0]?.[10]).toBe(4_096);
    expect(mockSendAgentMessage.mock.calls[0]?.[11]).toBe("ollama");
    expect(mockSendAgentMessage.mock.calls[0]?.[12]).toBeNull();
    expect(mockSendAgentMessage.mock.calls[0]?.[13]).toBe("native");
    expect(mockSendAgentMessage.mock.calls[0]?.[14]).toBe(ollamaEndpoint);
  });

  it.each([null, []])(
    "stops before the loop when selected model metadata cannot be verified (%s)",
    async (observation) => {
      mockRefreshDynamicCaps.mockResolvedValue(observation);

      await expect(
        runContextCreator("関連人物を探す", [], modelId),
      ).rejects.toThrow(/gemma4:latest/u);

      expect(mockRunAgentLoop).not.toHaveBeenCalled();
      expect(mockSendAgentMessage).not.toHaveBeenCalled();
    },
  );

  it("runs the final payload guard when model maximum is known but effective context is not", async () => {
    const maximumOnly: AiModel = {
      id: modelId,
      name: modelId,
      contextLength: 131_072,
      supportedParameters: ["tools"],
    };
    mockRefreshDynamicCaps.mockImplementation(async () => {
      registerDynamicModelCaps("ollama", [maximumOnly], {
        ollamaEndpoint,
        selectedModelId: modelId,
      });
      return [maximumOnly];
    });

    await expect(
      runContextCreator("x".repeat(10_000), [], modelId),
    ).rejects.toMatchObject({
      name: "OllamaContextWindowUnknownError",
      modelContextWindow: 131_072,
    });

    expect(mockRunAgentLoop).toHaveBeenCalledOnce();
    expect(mockSendAgentMessage).not.toHaveBeenCalled();
  });

  it("rejects an undersized runner allocation before transport", async () => {
    const undersized: AiModel = {
      ...modelWithRunnerContext,
      effectiveContextLength: 4_096,
    };
    mockRefreshDynamicCaps.mockImplementation(async () => {
      registerDynamicModelCaps("ollama", [undersized], {
        ollamaEndpoint,
        selectedModelId: modelId,
      });
      return [undersized];
    });

    await expect(
      runContextCreator("x".repeat(10_000), [], modelId),
    ).rejects.toMatchObject({
      name: "OllamaContextWindowTooSmallError",
      limitKind: "effective",
      availableContextWindow: 4_096,
      modelContextWindow: 131_072,
    });

    expect(mockSendAgentMessage).not.toHaveBeenCalled();
  });

  it("aborts if model authority changes while the tokenizer is loading", async () => {
    const tokenizerReady = deferred<void>();
    mockEnsureTokenizer.mockReturnValueOnce(tokenizerReady.promise);
    mockRefreshDynamicCaps.mockImplementation(async () => {
      registerDynamicModelCaps("ollama", [modelWithRunnerContext], {
        ollamaEndpoint,
        selectedModelId: modelId,
      });
      return [modelWithRunnerContext];
    });

    const run = runContextCreator("関連人物を探す", [], modelId);
    const rejection = expect(run).rejects.toThrow(/model selection changed/u);
    await vi.waitFor(() => {
      expect(mockEnsureTokenizer).toHaveBeenCalledOnce();
    });
    const settings = useAiSettingsStore.getState().settings;
    useAiSettingsStore.setState({
      settings: settings
        ? { ...settings, model: "another-model:latest" }
        : settings,
    });
    tokenizerReady.resolve();

    await rejection;
    expect(mockRunAgentLoop).not.toHaveBeenCalled();
    expect(mockSendAgentMessage).not.toHaveBeenCalled();
  });

  it("probes a no-tools Agent role before falling back to the active Ollama model", async () => {
    const noToolsModel: AiModel = {
      id: "embed-only:latest",
      name: "embed-only:latest",
      contextLength: 8_192,
      effectiveContextLength: 8_192,
      effectiveContextSource: "runner",
      supportedParameters: [],
    };
    registerDynamicModelCaps("ollama", [noToolsModel, modelWithRunnerContext], {
      ollamaEndpoint,
    });
    useSettingsStore.setState((state) => ({
      cache: {
        ...state.cache,
        [roleSettingKey("agent")]: noToolsModel.id,
        [ROLE_PROVIDERS_KEY]: JSON.stringify({
          agent: { provider: "ollama" },
        }),
      },
    }));
    mockRefreshDynamicCaps.mockImplementation(
      async (_provider: string, options: { selectedModelId?: string }) => {
        return options.selectedModelId === noToolsModel.id
          ? [noToolsModel]
          : [modelWithRunnerContext];
      },
    );

    await runContextCreator("関連人物を探す", [], modelId);

    expect(mockRefreshDynamicCaps).toHaveBeenNthCalledWith(
      1,
      "ollama",
      expect.objectContaining({ selectedModelId: noToolsModel.id }),
    );
    expect(mockRefreshDynamicCaps).toHaveBeenNthCalledWith(
      2,
      "ollama",
      expect.objectContaining({ selectedModelId: modelId }),
    );
    expect(mockSendAgentMessage.mock.calls[0]?.[7]).toBe(modelId);
  });
});
