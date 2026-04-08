import { describe, expect, it } from "vitest";
import {
  buildThinkingParams,
  formatContextWindow,
  getEffortForTask,
  getModelCapabilities,
  getToolTokenBudget,
  modelSupportsTools,
} from "./modelLimits";

describe("getModelCapabilities", () => {
  it("claude-opus-4-6: adaptive thinking, max effort, 1M context", () => {
    const caps = getModelCapabilities("claude-opus-4-6");
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.supportsThinking).toBe(false);
    expect(caps.supportsMaxEffort).toBe(true);
    expect(caps.supportsTools).toBe(true);
  });

  it("claude-sonnet-4-6: adaptive thinking, no max effort", () => {
    const caps = getModelCapabilities("claude-sonnet-4-6");
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.supportsMaxEffort).toBe(false);
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
  });

  it("OpenRouter プレフィックス付きモデルを解決する", () => {
    const caps = getModelCapabilities("anthropic/claude-opus-4-6");
    expect(caps.contextWindow).toBe(1_000_000);
    expect(caps.supportsAdaptiveThinking).toBe(true);
  });

  it("OpenRouter の日付サフィックス付きモデルを解決する (anthropic/)", () => {
    const caps = getModelCapabilities("anthropic/claude-sonnet-4-6-20250514");
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.contextWindow).toBe(200_000);
  });

  it("OpenRouter のドット表記モデルを解決する (4.6 → 4-6)", () => {
    const caps = getModelCapabilities("anthropic/claude-sonnet-4.6");
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.contextWindow).toBe(200_000);
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

describe("buildThinkingParams", () => {
  it("adaptive thinking モデル (Opus 4.6) は adaptive を返す", () => {
    const params = buildThinkingParams("claude-opus-4-6", "high");
    expect(params.thinking?.type).toBe("adaptive");
    expect(params.thinking?.effort).toBe("high");
    expect(params.thinking?.display).toBe("summarized");
    expect(params.effort).toBeUndefined();
  });

  it("budget_tokens モデル (Opus 4.5) は enabled + effort を返す", () => {
    const params = buildThinkingParams("claude-opus-4-5", "medium");
    expect(params.thinking?.type).toBe("enabled");
    expect(params.thinking?.budget_tokens).toBeGreaterThan(0);
    expect(params.effort).toBe("medium");
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

  it("effort 対応モデルは effort のみ返す", () => {
    const params = buildThinkingParams("claude-haiku-4-5-20251001", "medium");
    expect(params.thinking).toBeUndefined();
    expect(params.effort).toBe("medium");
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

  it("qwen3 + enabled=false: reasoningEnabled=true だが reasoningEffort は undefined", () => {
    const params = buildThinkingParams("qwen3", "high", "summarized", false);
    expect(params.reasoningEnabled).toBeUndefined();
    expect(params.reasoningEffort).toBeUndefined();
  });

  it("OpenRouter qwen/qwen3-235b-a22b: reasoningEnabled を返す", () => {
    const params = buildThinkingParams("qwen/qwen3-235b-a22b", "low");
    expect(params.reasoningEnabled).toBe(true);
    expect(params.reasoningEffort).toBe("low");
  });
});

describe("formatContextWindow", () => {
  it("1M", () => expect(formatContextWindow(1_000_000)).toBe("1M"));
  it("200k", () => expect(formatContextWindow(200_000)).toBe("200k"));
  it("8192", () => expect(formatContextWindow(8_192)).toBe("8.192k"));
});
