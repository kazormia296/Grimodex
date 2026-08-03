import { afterEach, beforeEach, describe, it, expect } from "vitest";
import {
  getModelPricing,
  estimateInputCost,
  estimateTotalCost,
  formatCost,
} from "./modelPricing";
import {
  __resetDynamicModelCapsForTests,
  registerDynamicModelCaps,
} from "./agent/dynamicModelCaps";

const lsStore: Record<string, string> = {};
// @ts-expect-error – test stub
globalThis.localStorage = {
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

describe("estimateTotalCost", () => {
  it("sums input and output cost (sonnet 3/15 per 1M)", () => {
    // 1M in * $3 + 1M out * $15 = $18
    expect(
      estimateTotalCost("claude-sonnet-4-6", 1_000_000, 1_000_000),
    ).toBeCloseTo(18, 5);
  });

  it("returns null for an unknown model", () => {
    expect(estimateTotalCost("unknown-model-x", 1000, 1000)).toBeNull();
  });

  it("returns 0 for zero tokens on a known model", () => {
    expect(estimateTotalCost("claude-sonnet-4-6", 0, 0)).toBe(0);
  });
});

describe("getModelPricing", () => {
  it("returns pricing for a bare Anthropic model id", () => {
    const p = getModelPricing("claude-opus-4-7");
    expect(p).not.toBeNull();
    expect(p?.inputPerMillion).toBe(5);
    expect(p?.outputPerMillion).toBe(25);
  });

  it("strips OpenRouter prefix (anthropic/...)", () => {
    expect(getModelPricing("anthropic/claude-sonnet-4-6")).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
  });

  it("strips :beta / :online suffix", () => {
    expect(getModelPricing("anthropic/claude-opus-4-7:beta")).toEqual({
      inputPerMillion: 5,
      outputPerMillion: 25,
    });
  });

  it("normalizes dot-separated versions to dash (OpenRouter format)", () => {
    // OpenRouter で見かける `anthropic/claude-sonnet-4.6` を解決できる
    expect(getModelPricing("anthropic/claude-sonnet-4.6")).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
    expect(getModelPricing("claude-sonnet-4.6")).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
  });

  it("strips trailing date suffix (Anthropic dated id)", () => {
    expect(getModelPricing("claude-sonnet-4-6-20260101")).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
  });

  it("strips -latest suffix", () => {
    expect(getModelPricing("claude-opus-4-7-latest")).toEqual({
      inputPerMillion: 5,
      outputPerMillion: 25,
    });
  });

  it("is case-insensitive", () => {
    expect(getModelPricing("Claude-Opus-4-7")).not.toBeNull();
  });

  it("returns null for unknown models", () => {
    expect(getModelPricing("totally-made-up-model-9999")).toBeNull();
  });

  it("returns null for empty / nullish input", () => {
    expect(getModelPricing(null)).toBeNull();
    expect(getModelPricing(undefined)).toBeNull();
    expect(getModelPricing("")).toBeNull();
  });
});

describe("estimateInputCost", () => {
  it("computes USD per 1M tokens", () => {
    // claude-opus-4-7: $5 / 1M tokens. 45,000 tokens = $0.225
    const cost = estimateInputCost("claude-opus-4-7", 45_000);
    expect(cost).toBeCloseTo(0.225, 3);
  });

  it("returns null when model is unknown", () => {
    expect(estimateInputCost("unknown-model", 10_000)).toBeNull();
  });

  it("returns 0 for 0 tokens", () => {
    expect(estimateInputCost("claude-opus-4-7", 0)).toBe(0);
  });
});

describe("formatCost", () => {
  it("formats sub-cent costs as <$0.01", () => {
    expect(formatCost(0.0001)).toBe("<$0.01");
    expect(formatCost(0)).toBe("<$0.01");
  });

  it("formats sub-dollar costs with 2 decimals", () => {
    expect(formatCost(0.68)).toBe("$0.68");
    expect(formatCost(0.99)).toBe("$0.99");
  });

  it("formats single-dollar amounts with 2 decimals", () => {
    expect(formatCost(3.4)).toBe("$3.40");
    expect(formatCost(9.99)).toBe("$9.99");
  });

  it("rounds amounts >=$10 to integer", () => {
    expect(formatCost(15.4)).toBe("$15");
    expect(formatCost(150.7)).toBe("$151");
  });
});

describe("getModelPricing: 動的レジストリ優先", () => {
  beforeEach(() => {
    __resetDynamicModelCapsForTests();
    (globalThis.localStorage as { clear: () => void }).clear();
  });
  afterEach(() => {
    __resetDynamicModelCapsForTests();
    (globalThis.localStorage as { clear: () => void }).clear();
  });

  it("動的レジストリの pricing が手動テーブルより優先される", () => {
    registerDynamicModelCaps("openrouter", [
      {
        id: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        contextLength: 1_000_000,
        supportedParameters: ["tools"],
        pricingPrompt: "0.000004", // $4/1M (手動テーブルの $3 より高い)
        pricingCompletion: "0.000020",
      },
    ]);
    const p = getModelPricing("anthropic/claude-sonnet-4-6");
    expect(p?.inputPerMillion).toBeCloseTo(4.0);
    expect(p?.outputPerMillion).toBeCloseTo(20.0);
  });

  it("同名の Ollama bare ID は OpenRouter 動的 pricing を拾わない", () => {
    registerDynamicModelCaps("openrouter", [
      {
        id: "shared-local-model:latest",
        name: "Shared Local Model",
        pricingPrompt: "0.000004",
        pricingCompletion: "0.000020",
      },
    ]);

    expect(getModelPricing("shared-local-model:latest", "ollama")).toBeNull();
    expect(
      estimateInputCost("shared-local-model:latest", 10_000, "ollama"),
    ).toBeNull();
    expect(
      estimateTotalCost("shared-local-model:latest", 10_000, 5_000, "ollama"),
    ).toBeNull();

    // provider 未指定の既存 API と明示 OpenRouter は従来どおり動的価格を使う。
    expect(getModelPricing("shared-local-model:latest")).toEqual({
      inputPerMillion: 4,
      outputPerMillion: 20,
    });
    expect(getModelPricing("shared-local-model:latest", "openrouter")).toEqual({
      inputPerMillion: 4,
      outputPerMillion: 20,
    });
  });

  it("Ollamaのcloud風bare IDへ手動cloud価格も漏らさない", () => {
    expect(getModelPricing("claude-sonnet-4-6", "ollama")).toBeNull();
    expect(getModelPricing("claude-sonnet-4-6", "anthropic")).toMatchObject({
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
  });

  it("動的データがない場合は手動テーブルにフォールバックする", () => {
    const p = getModelPricing("claude-opus-4-8");
    expect(p?.inputPerMillion).toBe(5);
    expect(p?.outputPerMillion).toBe(25);
  });

  it("Fable 5 の手動テーブル fallback 価格", () => {
    const p = getModelPricing("claude-fable-5");
    expect(p?.inputPerMillion).toBe(10);
    expect(p?.outputPerMillion).toBe(50);
  });
});
