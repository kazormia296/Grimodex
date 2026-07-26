import { describe, expect, it } from "vitest";
import { resolveOutputBudgetPlan } from "./outputBudget";

describe("resolveOutputBudgetPlan", () => {
  it.each([
    {
      provider: "anthropic" as const,
      model: "claude-sonnet-4-6",
      apiVariant: null,
      expected: 4_096,
    },
    {
      provider: "openai" as const,
      model: "gpt-4o",
      apiVariant: null,
      expected: 4_096,
    },
    {
      provider: "openai" as const,
      model: "o1",
      apiVariant: "responses",
      expected: 32_000,
    },
    {
      provider: "sakana" as const,
      model: "fugu",
      apiVariant: "responses",
      expected: 32_000,
      defaultVisibleOutputTokens: 32_000,
    },
    {
      provider: "openrouter" as const,
      model: "openai/o3",
      apiVariant: null,
      expected: 32_000,
    },
    {
      provider: "openrouter" as const,
      model: "anthropic/claude-sonnet-4.6",
      apiVariant: null,
      expected: 4_096,
    },
    {
      provider: "openai-compatible" as const,
      model: "gpt-5",
      apiVariant: null,
      expected: 32_000,
    },
    {
      provider: "openai-compatible" as const,
      model: "plain-model",
      apiVariant: null,
      expected: 4_096,
    },
  ])("uses the resolved capability for $provider/$model", (testCase) => {
    const { provider, model, apiVariant, expected } = testCase;
    expect(
      resolveOutputBudgetPlan({
        provider,
        model,
        apiVariant,
        contextWindow: 1_000_000,
        defaultVisibleOutputTokens:
          "defaultVisibleOutputTokens" in testCase
            ? testCase.defaultVisibleOutputTokens
            : undefined,
      }),
    ).toMatchObject({
      requestMaxOutputTokens: expected,
      responseReservationTokens: expected,
      exactOnWire: true,
    });
  });

  it("uses distinct visible and reasoning defaults from model capabilities", () => {
    expect(
      resolveOutputBudgetPlan({
        provider: "openai-compatible",
        model: "plain-model",
        contextWindow: 128_000,
        defaultVisibleOutputTokens: 6_000,
        defaultReasoningReservationTokens: 24_000,
      }).requestMaxOutputTokens,
    ).toBe(6_000);
    expect(
      resolveOutputBudgetPlan({
        provider: "openai-compatible",
        model: "gpt-5",
        contextWindow: 128_000,
        defaultVisibleOutputTokens: 6_000,
        defaultReasoningReservationTokens: 24_000,
      }).requestMaxOutputTokens,
    ).toBe(24_000);
  });

  it("uses the model-specific AI Novelist limit for legacy and v1 routes", () => {
    expect(
      resolveOutputBudgetPlan({
        provider: "ai-novelist",
        model: "damsel",
        apiVariant: "legacy",
        contextWindow: 2_400,
        modelMaxOutputTokens: 400,
      }).requestMaxOutputTokens,
    ).toBe(400);
    expect(
      resolveOutputBudgetPlan({
        provider: "ai-novelist",
        model: "spiko_ultra",
        apiVariant: "v1",
        contextWindow: 200_000,
        modelMaxOutputTokens: 32_768,
      }).requestMaxOutputTokens,
    ).toBe(32_768);
  });

  it("reserves manual Anthropic thinking plus visible output and sends that same limit", () => {
    const plan = resolveOutputBudgetPlan({
      provider: "anthropic",
      model: "claude-sonnet-4-5-20250929",
      apiVariant: null,
      contextWindow: 200_000,
      thinking: { thinking: { type: "enabled", budgetTokens: 8_000 } },
    });

    expect(plan).toMatchObject({
      requestMaxOutputTokens: 12_096,
      responseReservationTokens: 12_096,
      exactOnWire: true,
    });
  });

  it("marks CLI output as a conservative policy because the wire has no max flag", () => {
    expect(
      resolveOutputBudgetPlan({
        provider: "cli",
        model: "claude",
        apiVariant: null,
        contextWindow: 200_000,
      }),
    ).toMatchObject({
      requestMaxOutputTokens: null,
      responseReservationTokens: 10_000,
      exactOnWire: false,
    });
  });
});
