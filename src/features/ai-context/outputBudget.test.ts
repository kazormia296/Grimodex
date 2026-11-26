import { describe, expect, it } from "vitest";
import {
  anthropicThinkingAlwaysOn,
  resolveOutputBudgetPlan,
} from "./outputBudget";

// Rust の `anthropic_thinking_always_on_generations`（grimodex-ai/src/lib.rs）と
// 同じ例の表。片方の規則を変えるときは、もう片方の表も変える。
describe("anthropicThinkingAlwaysOn", () => {
  it.each([
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
    "claude-sonnet-5",
    "claude-haiku-5-5",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-mythos-5-1",
    "anthropic/claude-opus-5-5",
    "claude-opus-6",
  ])("%s は thinking が常に働く世代", (model) => {
    expect(anthropicThinkingAlwaysOn(model)).toBe(true);
  });

  it.each([
    "claude-opus-4-8",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
    "claude-haiku-4-5-20251001",
    "claude-test",
    "gpt-5",
    "claude-opus-",
  ])("%s は対象外", (model) => {
    expect(anthropicThinkingAlwaysOn(model)).toBe(false);
  });
});

describe("resolveOutputBudgetPlan", () => {
  it.each(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"])(
    "gives %s room for thinking whether or not thinking params are sent",
    (model) => {
      for (const thinking of [
        undefined,
        {},
        { thinking: { type: "adaptive" } },
      ]) {
        expect(
          resolveOutputBudgetPlan({
            provider: "anthropic",
            model,
            contextWindow: 1_000_000,
            thinking,
          }),
        ).toMatchObject({
          requestMaxOutputTokens: 32_000,
          responseReservationTokens: 32_000,
          exactOnWire: true,
        });
      }
    },
  );

  it.each([
    "claude-opus-4-8",
    "claude-opus-4-7",
    "claude-opus-4-6",
    "claude-sonnet-4-6",
  ])(
    "gives %s room for thinking only when adaptive thinking is sent",
    (model) => {
      const resolve = (thinking?: { thinking?: { type?: string } }) =>
        resolveOutputBudgetPlan({
          provider: "anthropic",
          model,
          contextWindow: 1_000_000,
          thinking,
        }).requestMaxOutputTokens;
      expect(resolve({ thinking: { type: "adaptive" } })).toBe(32_000);
      expect(resolve({})).toBe(4_096);
      expect(resolve(undefined)).toBe(4_096);
    },
  );

  it.each([
    "contextWindow",
    "modelMaxOutputTokens",
    "defaultVisibleOutputTokens",
    "defaultReasoningReservationTokens",
  ])("rejects a non-positive %s by name", (name) => {
    expect(() =>
      resolveOutputBudgetPlan({
        provider: "openai",
        model: "gpt-4o",
        contextWindow: 128_000,
        [name]: 0,
      }),
    ).toThrow(`${name} must be a positive safe integer`);
  });

  it("still clamps the thinking-inclusive Anthropic cap to the model and window", () => {
    const base = {
      provider: "anthropic" as const,
      model: "claude-haiku-5-5",
    };
    expect(
      resolveOutputBudgetPlan({
        ...base,
        contextWindow: 1_000_000,
        modelMaxOutputTokens: 8_000,
      }).requestMaxOutputTokens,
    ).toBe(8_000);
    expect(
      resolveOutputBudgetPlan({ ...base, contextWindow: 16_000 })
        .requestMaxOutputTokens,
    ).toBe(16_000 - 1_024);
  });

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
