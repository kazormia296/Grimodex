import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { AiProvider } from "@/features/chat/types";
import {
  ContextWindowExceededError,
  finalizeTurnPayload,
  OllamaContextWindowTooSmallError,
  OllamaContextWindowUnknownError,
  type FinalizeTurnPayloadInput,
  type ResolvedTurnRoute,
} from "./finalizeTurnPayload";

interface GoldenCase {
  name: string;
  input: FinalizeTurnPayloadInput;
}

const PROVIDERS: { [Provider in AiProvider]: Provider } = {
  openrouter: "openrouter",
  openai: "openai",
  anthropic: "anthropic",
  ollama: "ollama",
  "openai-compatible": "openai-compatible",
  sakana: "sakana",
  "ai-novelist": "ai-novelist",
  cli: "cli",
};

function makeInput(
  routeOverrides: Partial<ResolvedTurnRoute> = {},
  inputOverrides: Partial<FinalizeTurnPayloadInput> = {},
): FinalizeTurnPayloadInput {
  return {
    route: {
      surface: "chat",
      provider: "openai-compatible",
      model: "golden-model",
      apiVariant: null,
      toolProtocol: "native",
      contextWindow: 100,
      wireOutputTokens: 5,
      ...routeOverrides,
    },
    system: { fallback: "system" },
    messages: [{ role: "user", content: "user" }],
    envelopeTokens: 0,
    safetyMarginTokens: 0,
    ...inputOverrides,
  };
}

const cases: GoldenCase[] = [
  {
    name: "window-plain-no-cache",
    input: makeInput(
      {},
      {
        system: { fallback: "plain-system" },
        messages: [{ role: "user", content: "u" }],
      },
    ),
  },
  {
    name: "window-cache",
    input: makeInput(
      { provider: "anthropic", model: "claude-golden", wireOutputTokens: 5 },
      {
        system: {
          fallback: "discarded-fallback",
          cacheSegments: ["cache"],
          volatileTail: "tail",
        },
        messages: [{ role: "user", content: "user" }],
      },
    ),
  },
  {
    name: "cache-budget-downgrade",
    input: makeInput(
      { provider: "anthropic", model: "claude-golden", contextWindow: 12 },
      {
        system: { fallback: "short", cacheSegments: ["long-cache-block"] },
        messages: [],
      },
    ),
  },
  {
    name: "cache-budget-downgrade-exact-fit",
    input: makeInput(
      { provider: "anthropic", model: "claude-golden", contextWindow: 10 },
      {
        system: { fallback: "short", cacheSegments: ["long-cache-block"] },
        messages: [],
      },
    ),
  },
  {
    name: "cache-window-boundary-exact",
    input: makeInput(
      { provider: "anthropic", model: "claude-golden", contextWindow: 10 },
      {
        system: {
          fallback: "plain",
          cacheSegments: ["cache"],
        },
        messages: [],
      },
    ),
  },
  {
    name: "plain-overflow",
    input: makeInput(
      { contextWindow: 20, wireOutputTokens: 3 },
      {
        system: { fallback: "system" },
        messages: [{ role: "user", content: "conversation" }],
      },
    ),
  },
  ...([4, 5, 6] as const).map((contextWindow) => ({
    name: `window-boundary-${contextWindow - 5}`,
    input: makeInput(
      { contextWindow, wireOutputTokens: 3 },
      {
        system: { fallback: "S" },
        messages: [{ role: "user", content: "U" }],
      },
    ),
  })),
  ...Object.values(PROVIDERS).map((provider) => ({
    name: `provider-${provider}`,
    input: makeInput(
      {
        provider,
        model:
          provider === "openrouter"
            ? "anthropic/claude-golden"
            : `${provider}-golden`,
      },
      {
        system: {
          fallback: "fallback",
          cacheSegments: ["segment"],
          volatileTail: "tail",
        },
        messages: [{ role: "user", content: "u" }],
      },
    ),
  })),
  {
    name: "ollama-effective-window-too-small",
    input: makeInput(
      {
        provider: "ollama",
        model: "local-golden",
        contextWindow: 12,
        modelContextWindow: 2048,
        contextWindowIsEffective: true,
        contextWindowSource: "runner",
        wireOutputTokens: 3,
      },
      {
        system: { fallback: "system" },
        messages: [{ role: "user", content: "user" }],
      },
    ),
  },
];

function outcome(input: FinalizeTurnPayloadInput): unknown {
  try {
    return finalizeTurnPayload(input, (text) => text.length);
  } catch (error) {
    if (error instanceof ContextWindowExceededError) {
      return {
        error: {
          name: error.name,
          code: error.code,
          overflowTokens: error.overflowTokens,
          usage: error.usage,
        },
      };
    }
    if (error instanceof OllamaContextWindowTooSmallError) {
      return {
        error: {
          name: error.name,
          code: error.code,
          overflowTokens: error.overflowTokens,
          limitKind: error.limitKind,
          availableContextWindow: error.availableContextWindow,
          modelContextWindow: error.modelContextWindow,
          usage: error.usage,
        },
      };
    }
    if (error instanceof OllamaContextWindowUnknownError) {
      return {
        error: {
          name: error.name,
          code: error.code,
          requiredTokens: error.requiredTokens,
          modelContextWindow: error.modelContextWindow,
          usage: error.usage,
        },
      };
    }
    throw error;
  }
}

describe("finalizeTurnPayload golden", () => {
  it("preserves the pre-move JSON output byte for byte", () => {
    const fixtureUrl = new URL(
      "./__fixtures__/finalizeTurnPayload/golden.json",
      import.meta.url,
    );
    const fixtureBytes = readFileSync(fixtureUrl, "utf8");
    const output = {
      cases: cases.map(({ name, input }) => ({
        name,
        input,
        outcome: outcome(input),
      })),
    };
    expect(JSON.stringify(output)).toBe(
      JSON.stringify(JSON.parse(fixtureBytes)),
    );
  });
});
