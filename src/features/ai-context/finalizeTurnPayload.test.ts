import { describe, expect, it } from "vitest";
import {
  ContextWindowExceededError,
  finalizeTurnPayload,
  type FinalizeTurnPayloadInput,
  type ResolvedTurnRoute,
} from "./finalizeTurnPayload";

const countCharacters = (text: string): number => Array.from(text).length;

function route(
  overrides: Partial<ResolvedTurnRoute> = {},
): ResolvedTurnRoute {
  return {
    surface: "chat",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    apiVariant: null,
    toolProtocol: "native",
    contextWindow: 100,
    wireOutputTokens: 10,
    ...overrides,
  };
}

function input(
  overrides: Partial<FinalizeTurnPayloadInput> = {},
): FinalizeTurnPayloadInput {
  return {
    route: route(),
    system: {
      fallback: "FALLBACK_ONLY",
      cacheSegments: ["aa", "bbb"],
      volatileTail: "c",
    },
    messages: [{ role: "user", content: "dddd" }],
    envelopeTokens: 0,
    safetyMarginTokens: 0,
    ...overrides,
  };
}

describe("finalizeTurnPayload", () => {
  it("measures Anthropic cache blocks plus the volatile tail, not the discarded fallback", () => {
    const result = finalizeTurnPayload(input(), countCharacters);

    expect(result.systemDelivery).toEqual({
      kind: "cache-blocks",
      blocks: [
        { text: "aa", cacheControl: "ephemeral" },
        { text: "bbb", cacheControl: "ephemeral" },
        { text: "c" },
      ],
    });
    expect(result.usage).toMatchObject({
      systemTokens: 6,
      conversationTokens: 4,
      inputTokens: 10,
      outputReservedTokens: 10,
      reservedTotalTokens: 20,
      remainingTokens: 80,
    });
  });

  it.each([
    {
      name: "OpenRouter Claude chat/completions",
      turnRoute: route({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
      }),
      expectedKind: "cache-blocks",
    },
    {
      name: "OpenRouter non-Claude",
      turnRoute: route({
        provider: "openrouter",
        model: "openai/gpt-5-chat",
      }),
      expectedKind: "plain",
    },
    {
      name: "Responses API",
      turnRoute: route({
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        apiVariant: "responses",
      }),
      expectedKind: "plain",
    },
    {
      name: "Hermes agent",
      turnRoute: route({
        surface: "agent",
        provider: "openrouter",
        model: "anthropic/claude-sonnet-4.6",
        toolProtocol: "hermes",
      }),
      expectedKind: "plain",
    },
  ])(
    "selects the exact $name system representation",
    ({ turnRoute, expectedKind }) => {
      const result = finalizeTurnPayload(
        input({ route: turnRoute }),
        countCharacters,
      );
      expect(result.systemDelivery.kind).toBe(expectedKind);
      if (expectedKind === "plain") {
        expect(result.usage.systemTokens).toBe("FALLBACK_ONLY".length);
        expect(result.transport.systemCacheSegments).toBeUndefined();
        expect(result.transport.systemVolatileTail).toBeUndefined();
      }
    },
  );

  it("counts rendered tool/protocol text, envelope overhead, and safety margin", () => {
    const result = finalizeTurnPayload(
      input({
        route: route({ contextWindow: 60, wireOutputTokens: 7 }),
        renderedToolPayloads: ["tool", "schema"],
        envelopeTokens: 3,
        safetyMarginTokens: 5,
      }),
      countCharacters,
    );

    expect(result.usage).toMatchObject({
      systemTokens: 6,
      conversationTokens: 4,
      toolTokens: 10,
      envelopeTokens: 3,
      safetyMarginTokens: 5,
      inputTokens: 23,
      outputReservedTokens: 7,
      reservedTotalTokens: 35,
      remainingTokens: 25,
    });
  });

  it("accepts an exact-window payload and rejects one token more with a typed error", () => {
    const exact = input({
      route: route({ contextWindow: 20, wireOutputTokens: 10 }),
    });
    expect(
      finalizeTurnPayload(exact, countCharacters).usage.remainingTokens,
    ).toBe(0);

    expect(() =>
      finalizeTurnPayload(
        {
          ...exact,
          route: { ...exact.route, contextWindow: 19 },
        },
        countCharacters,
      ),
    ).toThrowError(ContextWindowExceededError);

    try {
      finalizeTurnPayload(
        {
          ...exact,
          route: { ...exact.route, contextWindow: 19 },
        },
        countCharacters,
      );
    } catch (error) {
      expect(error).toMatchObject({
        code: "AI_CONTEXT_WINDOW_EXCEEDED",
        overflowTokens: 1,
      });
    }
  });

  it("deterministically downgrades cache blocks when plain delivery fits", () => {
    const result = finalizeTurnPayload(
      input({
        route: route({ contextWindow: 25, wireOutputTokens: 5 }),
        system: {
          fallback: "short",
          cacheSegments: ["cached-content-is-too-large"],
        },
        messages: [],
      }),
      countCharacters,
    );

    expect(result.systemDelivery).toEqual({ kind: "plain", text: "short" });
    expect(result.cacheDowngradeReason).toBe("budget");
    expect(result.transport.systemCacheSegments).toBeUndefined();
  });

  it("rejects invalid route and budget numbers before measuring", () => {
    for (const invalid of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        finalizeTurnPayload(
          input({ route: route({ contextWindow: invalid }) }),
          countCharacters,
        ),
      ).toThrow(/contextWindow/);
    }
  });
});
