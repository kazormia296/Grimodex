import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildThinkingParams,
  clampReasoningEffort,
  formatContextWindow,
  getAgentToolCallBudget,
  getAgentToolCallBudgetForContext,
  getEffortForTask,
  getModelCapabilities,
  getToolTokenBudget,
  getToolTokenBudgetForContext,
  modelSupportsTools,
  resolveModelCapabilities,
} from "./modelLimits";
import {
  __resetDynamicModelCapsForTests,
  registerDynamicModelCaps,
} from "./dynamicModelCaps";
import { ollamaContextLengthSettingKey, type AiModel } from "../types";

const OLLAMA_ENDPOINT = "http://localhost:11434";

// localStorage スタブ（dynamicModelCaps が参照する）
const lsStore: Record<string, string> = {};
const localStorageMock = {
  getItem: (k: string) => lsStore[k] ?? null,
  setItem: (k: string, v: string) => {
    lsStore[k] = v;
  },
  removeItem: (k: string) => {
    delete lsStore[k];
  },
  clear: () => {
    for (const k of Object.keys(lsStore)) delete lsStore[k];
  },
};
// @ts-expect-error – test stub
globalThis.localStorage = localStorageMock;

describe("getModelCapabilities", () => {
  it("claude-fable-5: adaptive thinking, max effort, 1M context, 128k out", () => {
    const caps = getModelCapabilities("claude-fable-5");
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(128_000);
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.supportsMaxEffort).toBe(true);
    expect(caps.supportsEffort).toBe(true);
    expect(caps.supportsTools).toBe(true);
  });

  it("claude-opus-4-8: adaptive thinking, max effort, 1M context", () => {
    const caps = getModelCapabilities("claude-opus-4-8");
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(128_000);
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.supportsMaxEffort).toBe(true);
  });

  it("claude-opus-4-7: adaptive thinking, max effort, 1M context", () => {
    const caps = getModelCapabilities("claude-opus-4-7");
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.supportsMaxEffort).toBe(true);
  });

  it("claude-opus-4-6: adaptive thinking, max effort, 1M context", () => {
    const caps = getModelCapabilities("claude-opus-4-6");
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.supportsThinking).toBe(false);
    expect(caps.supportsMaxEffort).toBe(true);
    expect(caps.supportsTools).toBe(true);
  });

  it("claude-sonnet-4-6: adaptive thinking, no max effort, 1M context", () => {
    const caps = getModelCapabilities("claude-sonnet-4-6");
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.supportsMaxEffort).toBe(false);
  });

  it("claude-haiku-4-5: thinking/effort 非対応", () => {
    const caps = getModelCapabilities("claude-haiku-4-5-20251001");
    expect(caps.supportsAdaptiveThinking).toBe(false);
    expect(caps.supportsThinking).toBe(false);
    expect(caps.supportsEffort).toBe(false);
  });

  it("claude-opus-4-5: budget_tokens thinking", () => {
    const caps = getModelCapabilities("claude-opus-4-5");
    expect(caps.supportsThinking).toBe(true);
    expect(caps.supportsAdaptiveThinking).toBe(false);
  });

  it("gpt-4o: tools only, no thinking", () => {
    const caps = getModelCapabilities("gpt-4o");
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsThinking).toBe(false);
    expect(caps.supportsAdaptiveThinking).toBe(false);
    expect(caps.defaultVisibleOutputTokens).toBe(4_096);
    expect(caps.defaultReasoningReservationTokens).toBe(32_000);
  });

  it("OpenRouter プレフィックス付きモデルを解決する", () => {
    const caps = getModelCapabilities("anthropic/claude-opus-4-6");
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.supportsAdaptiveThinking).toBe(true);
  });

  it("OpenRouter の日付サフィックス付きモデルを解決する (anthropic/)", () => {
    const caps = getModelCapabilities("anthropic/claude-sonnet-4-6-20250514");
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
  });

  it("OpenRouter のドット表記モデルを解決する (4.6 → 4-6)", () => {
    const caps = getModelCapabilities("anthropic/claude-sonnet-4.6");
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
  });

  it("OpenRouter のドット+日付サフィックスモデルを解決する", () => {
    const caps = getModelCapabilities("anthropic/claude-opus-4.6-20250514");
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
  });

  it("日付サフィックス付きモデル (プレフィックスなし) を解決する", () => {
    const caps = getModelCapabilities("claude-opus-4-6-20250514");
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.contextWindow).toBe(1_000_000);
  });

  it("Ollama モデルはツール対応", () => {
    const caps = getModelCapabilities("ollama/llama3");
    expect(caps.supportsTools).toBe(true);
  });

  it("未知モデルはデフォルト値を返す", () => {
    const caps = getModelCapabilities("unknown/model");
    expect(caps.contextWindow).toBe(8_000);
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsThinking).toBe(false);
  });

  it("qwen3 (Ollama): supportsReasoning=true", () => {
    const caps = getModelCapabilities("qwen3");
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsThinking).toBe(false);
    expect(caps.supportsAdaptiveThinking).toBe(false);
    expect(caps.contextWindow).toBe(32_768);
  });

  it("deepseek-r1 (Ollama): supportsReasoning=true, tools 非対応", () => {
    const caps = getModelCapabilities("deepseek-r1");
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsTools).toBe(false);
    expect(caps.contextWindow).toBe(64_000);
  });

  it("qwen/qwen3 (OpenRouter プレフィックス) を解決する", () => {
    const caps = getModelCapabilities("qwen/qwen3-235b-a22b");
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.contextWindow).toBe(32_768);
  });

  it("deepseek/deepseek-r1 (OpenRouter プレフィックス) を解決する", () => {
    const caps = getModelCapabilities("deepseek/deepseek-r1");
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsTools).toBe(false);
  });
});

describe("supportsStructuredJson (structured/review ロールの能力ゲート)", () => {
  it("deepseek-r1 は構造化JSON非対応として curated (false)", () => {
    expect(getModelCapabilities("deepseek-r1").supportsStructuredJson).toBe(
      false,
    );
  });

  it("OpenRouter プレフィックス経由でも curated 値を継承する", () => {
    expect(
      getModelCapabilities("deepseek/deepseek-r1").supportsStructuredJson,
    ).toBe(false);
  });

  it("通常モデルは absent (= 既定 true 扱い)", () => {
    expect(
      getModelCapabilities("gpt-4o").supportsStructuredJson,
    ).toBeUndefined();
    expect(
      getModelCapabilities("claude-opus-4-8").supportsStructuredJson,
    ).toBeUndefined();
  });
});

describe("modelSupportsTools", () => {
  it("Claude は対応", () =>
    expect(modelSupportsTools("claude-opus-4-6")).toBe(true));
  it("GPT-4o は対応", () => expect(modelSupportsTools("gpt-4o")).toBe(true));
  it("Ollama は対応", () =>
    expect(modelSupportsTools("ollama/mistral")).toBe(true));
});

describe("getToolTokenBudget", () => {
  it("1M モデルは 30% = 300k", () => {
    expect(getToolTokenBudget("claude-opus-4-6")).toBe(300_000);
  });
  it("最低 2000 を保証", () => {
    expect(getToolTokenBudget("unknown/tiny")).toBeGreaterThanOrEqual(2_000);
  });
});

describe("getEffortForTask", () => {
  it("agent は high", () => expect(getEffortForTask("agent")).toBe("high"));
  it("chat は medium", () => expect(getEffortForTask("chat")).toBe("medium"));
  it("synopsis は low", () => expect(getEffortForTask("synopsis")).toBe("low"));
  it("session_title は low", () =>
    expect(getEffortForTask("session_title")).toBe("low"));
});

describe("resolveModelCapabilities ai-novelist v1", () => {
  it("spiko_ultra with apiVariant v1 enables tools and reasoning", () => {
    const caps = resolveModelCapabilities(
      "spiko_ultra",
      {
        provider: "ai-novelist",
      },
      "v1",
    );
    expect(caps.contextWindow).toBe(200_000);
    expect(caps.maxOutputTokens).toBe(32_768);
    expect(caps.supportsTools).toBe(true);
    expect(caps.supportsReasoning).toBe(true);
  });

  it("legacy spiko disables tools and reasoning", () => {
    const caps = resolveModelCapabilities(
      "spiko",
      {
        provider: "ai-novelist",
      },
      "legacy",
    );
    expect(caps.supportsTools).toBe(false);
    expect(caps.supportsReasoning).toBe(false);
  });
});

describe("buildThinkingParams", () => {
  it("adaptive thinking モデル (Opus 4.6) は adaptive を返す", () => {
    const params = buildThinkingParams("claude-opus-4-6", "high");
    expect(params.thinking?.type).toBe("adaptive");
    expect(params.thinking?.effort).toBe("high");
    expect(params.thinking?.display).toBe("summarized");
    expect(params.effort).toBeUndefined();
  });

  it("budget_tokens モデル (Opus 4.5) は enabled を返す（effort は supportsEffort=false のため省略）", () => {
    const params = buildThinkingParams("claude-opus-4-5", "medium");
    expect(params.thinking?.type).toBe("enabled");
    expect(params.thinking?.budget_tokens).toBeGreaterThan(0);
    expect(params.effort).toBeUndefined();
  });

  it("budget_tokens モデル (Sonnet 4.5) は effort を付けない", () => {
    const params = buildThinkingParams("claude-sonnet-4-5-20250929", "high");
    expect(params.thinking?.type).toBe("enabled");
    expect(params.effort).toBeUndefined();
  });

  it("display: omitted を指定できる", () => {
    const params = buildThinkingParams("claude-sonnet-4-6", "low", "omitted");
    expect(params.thinking?.display).toBe("omitted");
  });

  it("thinking 非対応モデルは空を返す", () => {
    const params = buildThinkingParams("gpt-4o", "medium");
    expect(params.thinking).toBeUndefined();
    expect(params.effort).toBeUndefined();
  });

  it("enabled=false のとき対応モデルでも空を返す (adaptive)", () => {
    const params = buildThinkingParams(
      "claude-opus-4-6",
      "high",
      "summarized",
      false,
    );
    expect(params.thinking).toBeUndefined();
    expect(params.effort).toBeUndefined();
  });

  it("enabled=false のとき対応モデルでも空を返す (budget_tokens)", () => {
    const params = buildThinkingParams(
      "claude-opus-4-5",
      "medium",
      "summarized",
      false,
    );
    expect(params.thinking).toBeUndefined();
    expect(params.effort).toBeUndefined();
  });

  it("enabled=true はデフォルト動作と同じ", () => {
    const withFlag = buildThinkingParams(
      "claude-sonnet-4-6",
      "medium",
      "summarized",
      true,
    );
    const withDefault = buildThinkingParams("claude-sonnet-4-6", "medium");
    expect(withFlag).toEqual(withDefault);
  });

  it("thinking/effort 非対応モデル (Haiku 4.5) は空を返す", () => {
    const params = buildThinkingParams("claude-haiku-4-5-20251001", "medium");
    expect(params.thinking).toBeUndefined();
    expect(params.effort).toBeUndefined();
  });

  it("qwen3 (reasoning モデル): reasoningEnabled=true, reasoningEffort を返す", () => {
    const params = buildThinkingParams("qwen3", "high");
    expect(params.reasoningEnabled).toBe(true);
    expect(params.reasoningEffort).toBe("high");
    expect(params.thinking).toBeUndefined();
    expect(params.effort).toBeUndefined();
  });

  it("deepseek-r1: reasoningEnabled=true を返す", () => {
    const params = buildThinkingParams("deepseek-r1", "medium");
    expect(params.reasoningEnabled).toBe(true);
    expect(params.reasoningEffort).toBe("medium");
  });

  it("qwen3 + enabled=false (toggleable): reasoningEnabled=false で明示無効化", () => {
    const params = buildThinkingParams("qwen3", "high", "summarized", false);
    expect(params.reasoningEnabled).toBe(false);
    expect(params.reasoningEffort).toBeUndefined();
  });

  it("OpenRouter qwen/qwen3-235b-a22b: reasoningEnabled を返す", () => {
    const params = buildThinkingParams("qwen/qwen3-235b-a22b", "low");
    expect(params.reasoningEnabled).toBe(true);
    expect(params.reasoningEffort).toBe("low");
  });
});

describe("OpenAI reasoning モデルの能力解決", () => {
  it("o3: reasoning 対応・常時推論 (canDisableReasoning=false)", () => {
    const caps = getModelCapabilities("o3");
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.canDisableReasoning).toBe(false);
    expect(caps.supportsTools).toBe(true);
  });

  it("openai/o3 (OpenRouter プレフィックス) を解決する", () => {
    const caps = getModelCapabilities("openai/o3");
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.canDisableReasoning).toBe(false);
  });

  it("o3-mini は o3 に誤マッチしない (最長一致)", () => {
    const o3 = getModelCapabilities("o3");
    const mini = getModelCapabilities("o3-mini");
    // どちらも reasoning だが別エントリとして解決される。
    expect(mini.supportsReasoning).toBe(true);
    // o3-mini の dated 変種も o3-mini に解決する。
    const dated = getModelCapabilities("openai/o3-mini-2025-01-31");
    expect(dated.supportsReasoning).toBe(true);
    expect(o3).not.toBe(undefined);
  });

  it("gpt-5 / gpt-5-mini は常時推論 (canDisableReasoning=false)", () => {
    expect(getModelCapabilities("gpt-5").canDisableReasoning).toBe(false);
    expect(getModelCapabilities("gpt-5-mini").canDisableReasoning).toBe(false);
  });

  it("gpt-5.1 (ドット表記) は toggleable reasoning", () => {
    const caps = getModelCapabilities("gpt-5.1");
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.canDisableReasoning).toBeUndefined();
  });

  it("gpt-5-pro は high 固定 (reasoningEffortValues=['high'])", () => {
    const caps = getModelCapabilities("gpt-5-pro");
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.canDisableReasoning).toBe(false);
    expect(caps.reasoningEffortValues).toEqual(["high"]);
  });

  it("gpt-5-chat は非 reasoning (gpt-5 に巻き込まれない)", () => {
    const caps = getModelCapabilities("gpt-5-chat");
    expect(caps.supportsReasoning).toBe(false);
    const dated = getModelCapabilities("openai/gpt-5-chat-2025-01-01");
    expect(dated.supportsReasoning).toBe(false);
  });

  it("openai-compatible カスタム endpoint では reasoning を無効化する", () => {
    const caps = resolveModelCapabilities(
      "o3",
      { provider: "openai-compatible", openaiCompatible: {} },
      null,
    );
    expect(caps.supportsReasoning).toBe(false);
  });
});

describe("clampReasoningEffort", () => {
  it("allowed 未指定なら max を high に正規化、それ以外は素通し", () => {
    expect(clampReasoningEffort("low")).toBe("low");
    expect(clampReasoningEffort("high")).toBe("high");
    expect(clampReasoningEffort("max")).toBe("high");
  });
  it("['high'] 固定なら low/medium も high に丸める", () => {
    expect(clampReasoningEffort("low", ["high"])).toBe("high");
    expect(clampReasoningEffort("medium", ["high"])).toBe("high");
    expect(clampReasoningEffort("high", ["high"])).toBe("high");
  });
});

describe("buildThinkingParams: OpenAI reasoning + effort 上書き", () => {
  it("o3 ON: reasoningEnabled=true, effort=high", () => {
    const params = buildThinkingParams("o3", "high");
    expect(params.reasoningEnabled).toBe(true);
    expect(params.reasoningEffort).toBe("high");
  });

  it("o3 (always-on) + enabled=false でも推論を維持する", () => {
    const params = buildThinkingParams("o3", "high", "summarized", false);
    expect(params.reasoningEnabled).toBe(true);
    expect(params.reasoningEffort).toBe("high");
  });

  it("gpt-5.1 (toggleable) + enabled=false → reasoningEnabled=false", () => {
    const params = buildThinkingParams(
      "gpt-5.1",
      "medium",
      "summarized",
      false,
    );
    expect(params.reasoningEnabled).toBe(false);
  });

  it("gpt-5-pro は task/override が low でも effort=high に clamp", () => {
    const params = buildThinkingParams(
      "gpt-5-pro",
      "low",
      "summarized",
      true,
      null,
      null,
      "low",
    );
    expect(params.reasoningEffort).toBe("high");
  });

  it("effortOverride が taskEffort に優先する", () => {
    const params = buildThinkingParams(
      "qwen3",
      "high",
      "summarized",
      true,
      null,
      null,
      "low",
    );
    expect(params.reasoningEffort).toBe("low");
  });

  it("effortOverride は Anthropic adaptive には漏れない", () => {
    const params = buildThinkingParams(
      "claude-opus-4-6",
      "high",
      "summarized",
      true,
      null,
      null,
      "low",
    );
    // adaptive は taskEffort をそのまま使う。
    expect(params.thinking?.effort).toBe("high");
  });
});

describe("formatContextWindow", () => {
  it("1M", () => expect(formatContextWindow(1_000_000)).toBe("1M"));
  it("200k", () => expect(formatContextWindow(200_000)).toBe("200k"));
  it("8192", () => expect(formatContextWindow(8_192)).toBe("8.192k"));
});

// ---------------------------------------------------------------------------
// 動的レジストリ統合テスト
// ---------------------------------------------------------------------------

function makeOpenRouterModel(
  id: string,
  extra: Partial<AiModel> = {},
): AiModel {
  return {
    id,
    name: id,
    contextLength: 100_000,
    maxCompletionTokens: 8_192,
    supportedParameters: ["tools"],
    ...extra,
  };
}

describe("動的 capability レジストリ統合", () => {
  beforeEach(() => {
    __resetDynamicModelCapsForTests();
    localStorageMock.clear();
  });
  afterEach(() => {
    __resetDynamicModelCapsForTests();
    localStorageMock.clear();
  });

  it("レジストリ空のとき既存の hardcoded テストが全て通る (回帰)", () => {
    // 動的レジストリが空でも、既存ロジックは変わらない
    const caps = getModelCapabilities("claude-opus-4-6");
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.supportsAdaptiveThinking).toBe(true);
  });

  it("Ollama /api/show の未知モデル最大値を 8k fallback に落とさない", () => {
    registerDynamicModelCaps("ollama", [
      {
        id: "gemma4:latest",
        name: "gemma4:latest",
        contextLength: 131_072,
        supportedParameters: ["tools"],
      },
    ]);

    const caps = resolveModelCapabilities("gemma4:latest", {
      provider: "ollama",
    });
    expect(caps).toMatchObject({
      contextWindow: 131_072,
      modelContextWindow: 131_072,
      contextWindowIsEffective: false,
      contextWindowSource: "model-maximum",
      supportsTools: true,
    });
  });

  it("Ollama runner の実効値を手動設定より優先する", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "gemma4:latest",
          name: "gemma4:latest",
          contextLength: 131_072,
          effectiveContextLength: 16_384,
          effectiveContextSource: "runner",
        },
      ],
      { ollamaEndpoint: OLLAMA_ENDPOINT },
    );

    const caps = resolveModelCapabilities("gemma4:latest", {
      provider: "ollama",
      ollamaEndpoint: OLLAMA_ENDPOINT,
      ollamaContextLengths: {
        [ollamaContextLengthSettingKey(OLLAMA_ENDPOINT, "gemma4:latest")]:
          65_536,
      },
    });
    expect(caps).toMatchObject({
      contextWindow: 16_384,
      modelContextWindow: 131_072,
      contextWindowIsEffective: true,
      contextWindowSource: "runner",
    });
  });

  it("Ollama Modelfile num_ctx を実効値として扱う", () => {
    registerDynamicModelCaps("ollama", [
      {
        id: "gemma4:latest",
        name: "gemma4:latest",
        contextLength: 131_072,
        effectiveContextLength: 32_768,
        effectiveContextSource: "model-parameter",
      },
    ]);

    expect(
      resolveModelCapabilities("gemma4:latest", {
        provider: "ollama",
      }),
    ).toMatchObject({
      contextWindow: 32_768,
      modelContextWindow: 131_072,
      contextWindowIsEffective: true,
      contextWindowSource: "model-parameter",
    });
  });

  it("Ollama 手動実効値をモデル最大値で clamp する", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "gemma4:latest",
          name: "gemma4:latest",
          contextLength: 131_072,
        },
      ],
      { ollamaEndpoint: OLLAMA_ENDPOINT },
    );

    const caps = resolveModelCapabilities("gemma4:latest", {
      provider: "ollama",
      ollamaEndpoint: OLLAMA_ENDPOINT,
      ollamaContextLengths: {
        [ollamaContextLengthSettingKey(OLLAMA_ENDPOINT, "gemma4:latest")]:
          262_144,
      },
    });
    expect(caps).toMatchObject({
      contextWindow: 131_072,
      modelContextWindow: 131_072,
      contextWindowIsEffective: true,
      contextWindowSource: "ollama-settings",
    });
  });

  it("Ollama bare ID と :latest を同じ手動設定namespaceとして扱う", () => {
    expect(ollamaContextLengthSettingKey(OLLAMA_ENDPOINT, "Gemma4")).toBe(
      ollamaContextLengthSettingKey(OLLAMA_ENDPOINT, "gemma4:latest"),
    );
  });

  it("Ollama :latest のlegacy exact keyをbare ID選択でも読む", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "gemma4:latest",
          name: "gemma4:latest",
          contextLength: 131_072,
        },
      ],
      { ollamaEndpoint: OLLAMA_ENDPOINT },
    );

    const legacyLatestKey = JSON.stringify([OLLAMA_ENDPOINT, "gemma4:latest"]);
    const caps = resolveModelCapabilities("gemma4", {
      provider: "ollama",
      ollamaEndpoint: OLLAMA_ENDPOINT,
      ollamaContextLengths: {
        [legacyLatestKey]: 65_536,
      },
    });

    expect(caps).toMatchObject({
      contextWindow: 65_536,
      modelContextWindow: 131_072,
      contextWindowIsEffective: true,
      contextWindowSource: "ollama-settings",
    });
  });

  it("Ollama 手動実効値を未知モデルの 8k fallback で clamp しない", () => {
    const caps = resolveModelCapabilities("unlisted-local:latest", {
      provider: "ollama",
      ollamaEndpoint: OLLAMA_ENDPOINT,
      ollamaContextLengths: {
        [ollamaContextLengthSettingKey(
          OLLAMA_ENDPOINT,
          "unlisted-local:latest",
        )]: 131_072,
      },
    });
    expect(caps).toMatchObject({
      contextWindow: 131_072,
      contextWindowIsEffective: true,
      contextWindowSource: "ollama-settings",
    });
  });

  it("Ollama 手動実効値を同名 curated モデル値で clamp しない", () => {
    const caps = resolveModelCapabilities("qwen3", {
      provider: "ollama",
      ollamaEndpoint: OLLAMA_ENDPOINT,
      ollamaContextLengths: {
        [ollamaContextLengthSettingKey(OLLAMA_ENDPOINT, "qwen3")]: 131_072,
      },
    });
    expect(caps).toMatchObject({
      contextWindow: 131_072,
      modelContextWindow: 0,
      contextWindowIsEffective: true,
      contextWindowSource: "ollama-settings",
    });
  });

  it("Ollama 手動実効値を別endpointの同名モデルへ流用しない", () => {
    const caps = resolveModelCapabilities("unlisted-local:latest", {
      provider: "ollama",
      ollamaEndpoint: "http://localhost:21434",
      ollamaContextLengths: {
        [ollamaContextLengthSettingKey(
          OLLAMA_ENDPOINT,
          "unlisted-local:latest",
        )]: 131_072,
      },
    });

    expect(caps).toMatchObject({
      contextWindow: 8_000,
      contextWindowIsEffective: false,
      contextWindowSource: "default",
    });
  });

  it("動的 metadata は provider を指定しない lookup へ漏れない", () => {
    registerDynamicModelCaps("ollama", [
      {
        id: "gemma4:latest",
        name: "gemma4:latest",
        contextLength: 131_072,
      },
    ]);

    expect(getModelCapabilities("gemma4:latest").contextWindow).toBe(8_000);
  });

  it("登録後: anthropic/claude-sonnet-4.6 → 1M context + supportsReasoning", () => {
    registerDynamicModelCaps("openrouter", [
      makeOpenRouterModel("anthropic/claude-sonnet-4.6", {
        contextLength: 1_000_000,
        maxCompletionTokens: 64_000,
        supportedParameters: ["tools", "reasoning"],
      }),
    ]);
    const caps = resolveModelCapabilities("anthropic/claude-sonnet-4.6", {
      provider: "openrouter",
    });
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.maxOutputTokens).toBe(64_000);
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.supportsThinking).toBe(false);
    expect(caps.supportsAdaptiveThinking).toBe(false);
    expect(caps.supportsEffort).toBe(false);
  });

  it("未知 Opus id が 8k fallback から脱出する", () => {
    registerDynamicModelCaps("openrouter", [
      makeOpenRouterModel("anthropic/claude-opus-99-9", {
        contextLength: 1_000_000,
        supportedParameters: ["tools", "reasoning"],
      }),
    ]);
    const caps = resolveModelCapabilities("anthropic/claude-opus-99-9", {
      provider: "openrouter",
    });
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.supportsReasoning).toBe(true);
  });

  it("openai/o3 の canDisableReasoning=false を継承する", () => {
    registerDynamicModelCaps("openrouter", [
      makeOpenRouterModel("openai/o3", {
        contextLength: 200_000,
        supportedParameters: ["tools", "reasoning"],
      }),
    ]);
    const caps = resolveModelCapabilities("openai/o3", {
      provider: "openrouter",
    });
    expect(caps.supportsReasoning).toBe(true);
    expect(caps.canDisableReasoning).toBe(false);
  });

  it("openrouter provider: adaptive thinking → supportsReasoning に変換 (offline fallback)", () => {
    // 動的レジストリ空 → hardcoded anthropic/claude-opus-4-6 は supportsAdaptiveThinking=true
    const caps = resolveModelCapabilities("anthropic/claude-opus-4-6", {
      provider: "openrouter",
    });
    expect(caps.supportsAdaptiveThinking).toBe(false);
    expect(caps.supportsThinking).toBe(false);
    expect(caps.supportsEffort).toBe(false);
    expect(caps.supportsReasoning).toBe(true);
  });

  it("openrouter provider: non-thinking モデルは変換しない", () => {
    const caps = resolveModelCapabilities("openai/gpt-4o", {
      provider: "openrouter",
    });
    expect(caps.supportsReasoning).toBe(false);
    expect(caps.supportsTools).toBe(true);
  });

  it("sakana provider: bare な fugu id でも 1M 窓に解決する (DEFAULT 8k に落ちない)", () => {
    // fugu / fugu-ultra はスラッシュ無し id なので動的/ハードコード表に載らず、
    // provider 分岐が無いと DEFAULT_CAPABILITIES(8k) に落ちてプロンプトが過小充填になる。
    for (const model of ["fugu", "fugu-ultra", "fugu-ultra-20260615"]) {
      const caps = resolveModelCapabilities(model, { provider: "sakana" });
      expect(caps.contextWindow).toBe(1_000_000);
      expect(caps.defaultVisibleOutputTokens).toBe(32_000);
      expect(caps.supportsTools).toBe(true);
      // orchestration 系で native reasoning ではないので余計な reasoning は送らない。
      expect(caps.supportsReasoning).toBe(false);
    }
  });

  it("buildThinkingParams: Claude via OpenRouter → reasoning wire format", () => {
    // 動的データあり（supportsReasoning=true）
    registerDynamicModelCaps("openrouter", [
      makeOpenRouterModel("anthropic/claude-opus-4-6", {
        contextLength: 1_000_000,
        supportedParameters: ["tools", "reasoning"],
      }),
    ]);
    const params = buildThinkingParams(
      "anthropic/claude-opus-4-6",
      "high",
      "summarized",
      true,
      { provider: "openrouter" },
    );
    expect(params.reasoningEnabled).toBe(true);
    expect(params.reasoningEffort).toBe("high");
    expect(params.thinking).toBeUndefined();
  });

  it("buildThinkingParams: Claude via OpenRouter offline fallback → reasoning wire format", () => {
    // 動的レジストリ空でも resolveModelCapabilities の変換で reasoning が返る
    const params = buildThinkingParams(
      "anthropic/claude-opus-4-6",
      "medium",
      "summarized",
      true,
      { provider: "openrouter" },
    );
    expect(params.reasoningEnabled).toBe(true);
    expect(params.reasoningEffort).toBe("medium");
    expect(params.thinking).toBeUndefined();
  });
});

describe("getAgentToolCallBudget — model-aware tool-call limit", () => {
  it("scales the cap up with the context window", () => {
    // 1M 窓（Opus 4.8 等）→ 25、200k → 16、小窓は従来どおり 10。
    expect(getAgentToolCallBudget("claude-opus-4-8")).toBe(25);
    expect(getAgentToolCallBudget("claude-opus-4-5")).toBe(16); // 200k
    expect(getAgentToolCallBudget("claude-haiku-4-5-20251001")).toBe(16); // 200k
    expect(getAgentToolCallBudget("deepseek-r1")).toBe(12); // 64k
    expect(getAgentToolCallBudget("qwen3")).toBe(10); // 32k
  });

  it("route で解決済みの context を直接利用できる", () => {
    expect(getAgentToolCallBudgetForContext(131_072)).toBe(12);
    expect(getToolTokenBudgetForContext(131_072)).toBe(39_321);
  });

  it("keeps small / unknown models at the safe floor of 10", () => {
    // 既定能力（8k）の未知モデルは引き上げない（文脈溢れ・コスト爆発を回避）。
    expect(getAgentToolCallBudget("some-unknown-local-model")).toBe(10);
    expect(getAgentToolCallBudget("")).toBe(10);
  });
});
