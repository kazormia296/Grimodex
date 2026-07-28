import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { finalizeTurnPayload } from "@/features/ai-context/finalizeTurnPayload";
import {
  __resetDynamicModelCapsForTests,
  registerDynamicModelCaps,
} from "../agent/dynamicModelCaps";
import { DEFAULT_AI_SETTINGS, ollamaContextLengthSettingKey } from "../types";
import {
  resolveChatTurnRoute,
  resolvedChatTurnRouteAuthorityKey,
} from "./resolveTurnRoute";

describe("resolveChatTurnRoute", () => {
  beforeEach(() => {
    __resetDynamicModelCapsForTests();
  });

  afterEach(() => {
    __resetDynamicModelCapsForTests();
  });

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

  it("keeps existing Codex CLI settings on the exec transport", () => {
    const route = resolveChatTurnRoute({
      surface: "chat",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "cli",
        cli: { kind: "codex", model: "gpt-5" },
      },
      taskEffort: "medium",
    });

    expect(route.transport).toBe("cli-exec");
  });

  it("pins the configured Ollama endpoint in the resolved route", () => {
    const route = resolveChatTurnRoute({
      surface: "agent",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "ollama",
        model: "gemma4:latest",
        ollamaEndpoint: "http://127.0.0.1:11434/",
      },
      taskEffort: "medium",
    });

    expect(route.resolvedOllamaEndpoint).toBe("http://127.0.0.1:11434/");
    expect(route.resolvedEndpointId).toBeNull();
  });

  it("routes Codex app-server and auto modes through the resident transport", () => {
    for (const codexTransport of ["app-server", "auto"] as const) {
      const route = resolveChatTurnRoute({
        surface: "chat",
        activeSettings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "cli",
          cli: { kind: "codex", codexTransport },
        },
        taskEffort: "medium",
      });
      expect(route.transport).toBe("codex-app-server");
    }
  });

  it("fails closed to codex exec for an unknown persisted transport", () => {
    const route = resolveChatTurnRoute({
      surface: "chat",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "cli",
        cli: { kind: "codex", codexTransport: "unexpected" as never },
      },
      taskEffort: "medium",
    });

    expect(route.transport).toBe("cli-exec");
  });

  it("carries separate Ollama model-maximum and effective diagnostics", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "gemma4:latest",
          name: "gemma4:latest",
          contextLength: 131_072,
          supportedParameters: ["tools"],
        },
      ],
      { ollamaEndpoint: DEFAULT_AI_SETTINGS.ollamaEndpoint },
    );

    const maximumOnly = resolveChatTurnRoute({
      surface: "agent",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "ollama",
        model: "gemma4:latest",
      },
      taskEffort: "high",
    });
    expect(maximumOnly).toMatchObject({
      contextWindow: 131_072,
      modelContextWindow: 131_072,
      contextWindowIsEffective: false,
      contextWindowSource: "model-maximum",
    });

    const configured = resolveChatTurnRoute({
      surface: "agent",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "ollama",
        model: "gemma4:latest",
        ollamaContextLengths: {
          [ollamaContextLengthSettingKey(
            DEFAULT_AI_SETTINGS.ollamaEndpoint,
            "gemma4:latest",
          )]: 131_072,
        },
      },
      taskEffort: "high",
    });
    expect(configured).toMatchObject({
      contextWindow: 131_072,
      modelContextWindow: 131_072,
      contextWindowIsEffective: true,
      contextWindowSource: "ollama-settings",
    });

    const finalized = finalizeTurnPayload(
      {
        route: configured,
        system: { fallback: "s".repeat(100) },
        messages: [],
        renderedConversationPayloads: ["c".repeat(937)],
        renderedToolPayloads: ["t".repeat(5_591)],
        safetyMarginTokens: 32,
      },
      (text) => text.length,
    );
    expect(finalized.usage).toMatchObject({
      reservedTotalTokens: 10_756,
      remainingTokens: 120_316,
    });
  });

  it("resolves identical bare model ids in their provider namespaces", () => {
    registerDynamicModelCaps(
      "ollama",
      [
        {
          id: "shared:latest",
          name: "shared:latest",
          contextLength: 131_072,
        },
      ],
      { ollamaEndpoint: DEFAULT_AI_SETTINGS.ollamaEndpoint },
    );
    registerDynamicModelCaps("openrouter", [
      {
        id: "shared:latest",
        name: "shared:latest",
        contextLength: 32_768,
      },
    ]);

    const ollamaRoute = resolveChatTurnRoute({
      surface: "chat",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "ollama",
        model: "shared:latest",
      },
      taskEffort: "medium",
    });
    const openrouterRoute = resolveChatTurnRoute({
      surface: "chat",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openrouter",
        model: "shared:latest",
      },
      taskEffort: "medium",
    });

    expect(ollamaRoute.contextWindow).toBe(131_072);
    expect(openrouterRoute.contextWindow).toBe(32_768);
  });

  it("distinguishes same-name models when only endpoint authority changes", () => {
    const endpoints = [
      {
        id: "shared",
        label: "Shared",
        baseUrl: "https://a.example/v1",
        customMaxContext: 32_768,
      },
    ];
    const routeA = resolveChatTurnRoute({
      surface: "chat",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openai-compatible",
        model: "shared-model",
        openaiCompatibleEndpoints: endpoints,
        activeOpenaiCompatibleEndpointId: "shared",
      },
      taskEffort: "medium",
    });
    const routeB = resolveChatTurnRoute({
      surface: "chat",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openai-compatible",
        model: "shared-model",
        openaiCompatibleEndpoints: [
          {
            ...endpoints[0],
            baseUrl: "https://b.example/v1",
            customMaxContext: 131_072,
          },
        ],
        activeOpenaiCompatibleEndpointId: "shared",
      },
      taskEffort: "medium",
    });

    expect(routeA.provider).toBe(routeB.provider);
    expect(routeA.model).toBe(routeB.model);
    expect(routeA.resolvedEndpointId).toBe(routeB.resolvedEndpointId);
    expect(resolvedChatTurnRouteAuthorityKey(routeA)).not.toBe(
      resolvedChatTurnRouteAuthorityKey(routeB),
    );
  });
});
