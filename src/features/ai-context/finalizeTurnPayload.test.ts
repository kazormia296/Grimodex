import { describe, expect, it } from "vitest";
import localChatFixture from "../../../test-fixtures/nir1-df06-plain-chat.json";
import {
  estimateMessageEnvelopeTokens,
  TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
} from "@/application/chat/chatTurnPayload";
import { estimateTokens } from "@/features/chat/contextBuilder";
import { JA_CHAT_SYSTEM } from "@/prompts/ja/chatSystem";
import { resolveModelCapabilities } from "@/features/chat/agent/modelLimits";
import {
  ContextWindowExceededError,
  finalizeTurnPayload,
  OllamaContextWindowTooSmallError,
  OllamaContextWindowUnknownError,
  type FinalizeTurnPayloadInput,
  type ResolvedTurnRoute,
} from "./finalizeTurnPayload";

const countCharacters = (text: string): number => Array.from(text).length;

function route(overrides: Partial<ResolvedTurnRoute> = {}): ResolvedTurnRoute {
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

  it("rejects Ollama Agent when only the model maximum is known", () => {
    const ollamaAgent = input({
      route: route({
        surface: "agent",
        provider: "ollama",
        model: "gemma4:latest",
        contextWindow: 131_072,
        modelContextWindow: 131_072,
        contextWindowIsEffective: false,
        contextWindowSource: "model-maximum",
        wireOutputTokens: 4_096,
      }),
    });

    expect(() =>
      finalizeTurnPayload(ollamaAgent, countCharacters),
    ).toThrowError(OllamaContextWindowUnknownError);
    try {
      finalizeTurnPayload(ollamaAgent, countCharacters);
    } catch (error) {
      expect(error).toMatchObject({
        code: "OLLAMA_CONTEXT_WINDOW_UNKNOWN",
        requiredTokens: 4_113,
        modelContextWindow: 131_072,
      });
      expect(String(error)).toContain("OLLAMA_CONTEXT_LENGTH");
    }
  });

  it("rejects normal Ollama chat when the effective allocation is unknown", () => {
    expect(() =>
      finalizeTurnPayload(
        input({
          route: route({
            surface: "chat",
            provider: "ollama",
            model: "gemma4:latest",
            contextWindow: 131_072,
            modelContextWindow: 131_072,
            contextWindowIsEffective: false,
            contextWindowSource: "model-maximum",
            wireOutputTokens: 4_096,
          }),
        }),
        countCharacters,
      ),
    ).toThrowError(OllamaContextWindowUnknownError);
  });

  it("does not report the unknown-model 8k fallback as a real Ollama limit", () => {
    const unknownDefault = input({
      route: route({
        surface: "chat",
        provider: "ollama",
        model: "unknown-local:latest",
        contextWindow: 8_000,
        modelContextWindow: 8_000,
        contextWindowIsEffective: false,
        contextWindowSource: "default",
        wireOutputTokens: 4_096,
      }),
      messages: [{ role: "user", content: "x".repeat(4_000) }],
    });

    expect(() =>
      finalizeTurnPayload(unknownDefault, countCharacters),
    ).toThrowError(OllamaContextWindowUnknownError);
  });

  it("distinguishes an insufficient Ollama effective allocation", () => {
    const tooSmall = input({
      route: route({
        surface: "agent",
        provider: "ollama",
        model: "gemma4:latest",
        contextWindow: 27,
        modelContextWindow: 131_072,
        contextWindowIsEffective: true,
        contextWindowSource: "runner",
        wireOutputTokens: 10,
      }),
      renderedToolPayloads: ["x"],
    });

    expect(() => finalizeTurnPayload(tooSmall, countCharacters)).toThrowError(
      OllamaContextWindowTooSmallError,
    );
    try {
      finalizeTurnPayload(tooSmall, countCharacters);
    } catch (error) {
      expect(error).toMatchObject({
        code: "OLLAMA_CONTEXT_WINDOW_TOO_SMALL",
        limitKind: "effective",
        overflowTokens: 1,
        availableContextWindow: 27,
        modelContextWindow: 131_072,
      });
      expect(String(error)).toContain("same verified effective value");
    }
  });

  it("uses the same effective-allocation diagnosis for normal Ollama chat", () => {
    const tooSmall = input({
      route: route({
        surface: "chat",
        provider: "ollama",
        model: "gemma4:latest",
        contextWindow: 27,
        modelContextWindow: 131_072,
        contextWindowIsEffective: true,
        contextWindowSource: "runner",
        wireOutputTokens: 10,
      }),
      renderedToolPayloads: ["x"],
    });

    try {
      finalizeTurnPayload(tooSmall, countCharacters);
      throw new Error("expected Ollama context error");
    } catch (error) {
      expect(error).toMatchObject({
        code: "OLLAMA_CONTEXT_WINDOW_TOO_SMALL",
        limitKind: "effective",
        overflowTokens: 1,
      });
    }
  });

  it("distinguishes a payload larger than the Ollama model maximum", () => {
    const tooLargeForModel = input({
      route: route({
        surface: "agent",
        provider: "ollama",
        model: "small-local",
        contextWindow: 27,
        modelContextWindow: 27,
        contextWindowIsEffective: false,
        contextWindowSource: "model-maximum",
        wireOutputTokens: 10,
      }),
      renderedToolPayloads: ["x"],
    });

    try {
      finalizeTurnPayload(tooLargeForModel, countCharacters);
      throw new Error("expected Ollama context error");
    } catch (error) {
      expect(error).toMatchObject({
        code: "OLLAMA_CONTEXT_WINDOW_TOO_SMALL",
        limitKind: "model-maximum",
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

  it("matches the Native fallback estimator for local plain-chat JA/EN/emoji/JSON usage", () => {
    const model = "fixture-local-model";
    const outputTokens = localChatFixture.outputTokens;
    const unconfigured = resolveModelCapabilities(model, {
      provider: "openai-compatible",
      activeOpenaiCompatibleEndpointId: "fixture-local",
      openaiCompatibleEndpoints: [{ id: "fixture-local" }],
    });
    expect(unconfigured).toMatchObject({
      contextWindowIsEffective: false,
      contextWindowSource: "default",
    });

    const measurements = localChatFixture.cases.map((testCase) => {
      const systemText =
        `${JA_CHAT_SYSTEM.baseText}\n\n<current_scene>\n${testCase.raw}` +
        `\n</current_scene>\n\n<codex_entries>\n${testCase.codex}` +
        `\n</codex_entries>\n\n${JA_CHAT_SYSTEM.dataBoundaryReminder}`;
      const fixedSystemText =
        `${JA_CHAT_SYSTEM.baseText}\n\n<current_scene>\n\n</current_scene>` +
        `\n\n<codex_entries>\n\n</codex_entries>\n\n` +
        JA_CHAT_SYSTEM.dataBoundaryReminder;
      const messages = [
        { role: "system", content: systemText },
        { role: "user", content: testCase.user },
      ];
      const envelopeTokens = estimateMessageEnvelopeTokens(messages);
      expect(envelopeTokens).toBe(10);

      const finalInput = input({
        route: route({
          provider: "openai-compatible",
          model,
          contextWindow: Number.MAX_SAFE_INTEGER,
          wireOutputTokens: outputTokens,
        }),
        system: { fallback: systemText },
        messages,
        envelopeTokens,
        safetyMarginTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
      });
      const measured = finalizeTurnPayload(finalInput, estimateTokens);
      const fixedSystemTokens = estimateTokens(fixedSystemText);
      const selectedContextTokens =
        estimateTokens(testCase.raw) + estimateTokens(testCase.codex);
      const userTokens = estimateTokens(testCase.user);
      expect(systemText).toContain(testCase.raw);
      expect(systemText).toContain(testCase.codex);
      expect(fixedSystemTokens).toBeGreaterThan(0);
      expect(selectedContextTokens).toBeGreaterThan(0);
      expect(measured.usage).toMatchObject({
        systemTokens: estimateTokens(systemText),
        conversationTokens: userTokens,
        toolTokens: 0,
        envelopeTokens,
        safetyMarginTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
        outputReservedTokens: outputTokens,
      });
      const exactUsage =
        measured.usage.systemTokens +
        userTokens +
        envelopeTokens +
        outputTokens +
        TURN_PAYLOAD_SAFETY_MARGIN_TOKENS;
      expect(measured.usage.reservedTotalTokens).toBe(exactUsage);

      const configured = resolveModelCapabilities(model, {
        provider: "openai-compatible",
        activeOpenaiCompatibleEndpointId: "fixture-local",
        openaiCompatibleEndpoints: [
          {
            id: "fixture-local",
            customMaxContext: exactUsage,
            customMaxOutput: outputTokens,
          },
        ],
      });
      expect(configured).toMatchObject({
        contextWindow: exactUsage,
        contextWindowIsEffective: true,
        contextWindowSource: "hardcoded",
      });
      const atLimit = finalizeTurnPayload(
        {
          ...finalInput,
          route: {
            ...finalInput.route,
            contextWindow: configured.contextWindow,
          },
        },
        estimateTokens,
      );
      expect(atLimit.usage.remainingTokens).toBe(0);

      try {
        finalizeTurnPayload(
          {
            ...finalInput,
            route: {
              ...finalInput.route,
              contextWindow: exactUsage - 1,
            },
          },
          estimateTokens,
        );
        throw new Error("expected N-1 context failure");
      } catch (error) {
        expect(error).toBeInstanceOf(ContextWindowExceededError);
        expect(error).toMatchObject({
          code: "AI_CONTEXT_WINDOW_EXCEEDED",
          overflowTokens: 1,
        });
      }
      try {
        finalizeTurnPayload(
          {
            ...finalInput,
            route: {
              ...finalInput.route,
              contextWindow: exactUsage,
              wireOutputTokens: outputTokens + 1,
            },
          },
          estimateTokens,
        );
        throw new Error("expected N+1 output reservation failure");
      } catch (error) {
        expect(error).toMatchObject({
          code: "AI_CONTEXT_WINDOW_EXCEEDED",
          overflowTokens: 1,
        });
      }

      return {
        locale: testCase.name,
        fixedSystemTokens,
        userTokens,
        selectedContextTokens,
        framingTokens: envelopeTokens,
        outputTokens,
        safetyTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
        finalSystemTokens: measured.usage.systemTokens,
        reservedTotalTokens: exactUsage,
      };
    });

    expect(measurements).toEqual(
      localChatFixture.cases.map((testCase) => ({
        locale: testCase.name,
        ...testCase.expected,
        framingTokens: 10,
        outputTokens,
        safetyTokens: TURN_PAYLOAD_SAFETY_MARGIN_TOKENS,
      })),
    );
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
