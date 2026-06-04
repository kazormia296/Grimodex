import { describe, it, expect } from "vitest";
import {
  getModelPricing,
  estimateInputCost,
  estimateTotalCost,
  formatCost,
} from "./modelPricing";

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
    expect(p?.inputPerMillion).toBe(15);
    expect(p?.outputPerMillion).toBe(75);
  });

  it("strips OpenRouter prefix (anthropic/...)", () => {
    expect(getModelPricing("anthropic/claude-sonnet-4-6")).toEqual({
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
  });

  it("strips :beta / :online suffix", () => {
    expect(getModelPricing("anthropic/claude-opus-4-7:beta")).toEqual({
      inputPerMillion: 15,
      outputPerMillion: 75,
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
      inputPerMillion: 15,
      outputPerMillion: 75,
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
    // claude-opus-4-7: $15 / 1M tokens. 45,000 tokens = $0.675
    const cost = estimateInputCost("claude-opus-4-7", 45_000);
    expect(cost).toBeCloseTo(0.675, 3);
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
