import { describe, expect, it } from "vitest";

import { DEFAULT_AI_SETTINGS } from "../types";
import { resolveChatTurnRoute } from "./resolveTurnRoute";

describe("resolveChatTurnRoute", () => {
  it("uses the model visible-output capability instead of an OpenAI provider heuristic", () => {
    const route = resolveChatTurnRoute({
      surface: "chat",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openai",
        model: "gpt-4o",
      },
      activeApiVariant: null,
      taskEffort: "medium",
    });

    expect(route.capabilities.defaultVisibleOutputTokens).toBe(4_096);
    expect(route.outputBudget).toMatchObject({
      requestMaxOutputTokens: 4_096,
      responseReservationTokens: 4_096,
      exactOnWire: true,
    });
    expect(route.wireOutputTokens).toBe(4_096);
  });

  it("keeps Sakana's orchestration reservation as an explicit capability", () => {
    const route = resolveChatTurnRoute({
      surface: "agent",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "sakana",
        model: "fugu",
      },
      activeApiVariant: "responses",
      taskEffort: "high",
    });

    expect(route.capabilities.defaultVisibleOutputTokens).toBe(32_000);
    expect(route.outputBudget.requestMaxOutputTokens).toBe(32_000);
    expect(route.toolProtocol).toBe("native");
  });

  it("freezes composer provider, endpoint, and resolved tool protocol in one route", () => {
    const route = resolveChatTurnRoute({
      surface: "agent",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openai",
        model: "gpt-4o",
        toolProtocolMode: "hermes",
        openaiCompatibleEndpoints: [
          {
            id: "local",
            label: "Local",
            baseUrl: "http://127.0.0.1:8080/v1",
            apiVariant: null,
            customMaxContext: 64_000,
            customMaxOutput: 8_000,
          },
        ],
      },
      activeApiVariant: null,
      composer: {
        provider: "openai-compatible",
        model: "plain-model",
        endpointId: "local",
      },
      taskEffort: "medium",
    });

    expect(route).toMatchObject({
      source: "composer",
      provider: "openai-compatible",
      model: "plain-model",
      resolvedEndpointId: "local",
      toolProtocol: "hermes",
      contextWindow: 64_000,
      wireOutputTokens: 4_096,
    });
    expect(Object.isFrozen(route)).toBe(true);
  });
});
