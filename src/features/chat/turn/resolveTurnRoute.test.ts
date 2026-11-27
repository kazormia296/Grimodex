import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { finalizeTurnPayload } from "@/features/ai-context/finalizeTurnPayload";
import {
  __resetDynamicModelCapsForTests,
  registerDynamicModelCaps,
} from "../agent/dynamicModelCaps";
import {
  __resetRegistryModelCapsForTests,
  setRegistryModelCaps,
} from "../agent/registryModelCaps";
import {
  DEFAULT_AI_SETTINGS,
  ollamaContextLengthSettingKey,
  type AiProvider,
} from "../types";
import {
  isLocalInferenceRoute,
  resolveChatTurnRoute,
  resolvedChatTurnRouteAuthorityKey,
} from "./resolveTurnRoute";

describe("resolveChatTurnRoute", () => {
  beforeEach(() => {
    __resetDynamicModelCapsForTests();
    __resetRegistryModelCapsForTests();
  });

  afterEach(() => {
    __resetDynamicModelCapsForTests();
    __resetRegistryModelCapsForTests();
  });

  it("registry の写し（表に無い id）は context と最大出力だけを変え、thinking・effort の送信は変えない（PR-C3）", () => {
    const cases = [
      { provider: "openai", model: "gpt-6-astra" },
      { provider: "openai", model: "gpt-5.6" },
      { provider: "anthropic", model: "claude-fable-5-2" },
      { provider: "anthropic", model: "claude-3-7-sonnet-20250219" },
      { provider: "openrouter", model: "vendor/new-model" },
    ] as const;
    const resolve = (provider: AiProvider, model: string) =>
      resolveChatTurnRoute({
        surface: "agent",
        activeSettings: { ...DEFAULT_AI_SETTINGS, provider, model },
        activeApiVariant: null,
        taskEffort: "high",
        thinkingEnabled: true,
      });
    const before = cases.map(({ provider, model }) => resolve(provider, model));
    setRegistryModelCaps({
      models: Object.fromEntries(
        cases.map(({ provider, model }) => [
          `${provider}/${model}`,
          // 最大出力は、既定の応答の長さ（4,096）より小さい値にする（clamp が wire に届く）。
          {
            contextWindow: 333_000,
            maxOutputTokens: 2_048,
            toolCall: true,
            reasoning: true,
          },
        ]),
      ),
    });
    cases.forEach(({ provider, model }, index) => {
      const after = resolve(provider, model);
      expect(after.thinking, `${provider}/${model}`).toEqual(
        before[index].thinking,
      );
      expect(after.toolProtocol).toBe(before[index].toolProtocol);
      expect(after.contextWindow, `${provider}/${model}`).toBe(333_000);
      expect(after.capabilities.contextWindowSource).toBe("registry");
      // wire の最大出力は、写しの最大出力を超えない。
      expect(after.outputBudget.requestMaxOutputTokens).toBeLessThanOrEqual(
        2_048,
      );
      expect(after.wireOutputTokens).toBeLessThanOrEqual(2_048);
    });
  });

  it("Anthropic 5 系は、chat と agent の出力上限が thinking を含む 32,000 になる（thinking の切替が off でも）", () => {
    // claude-fable-5-2 は能力表に無い id（同じ family の定義に解決する）。
    const models = [
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-2",
    ];
    for (const model of models) {
      for (const surface of ["chat", "agent"] as const) {
        for (const thinkingEnabled of [true, false]) {
          const route = resolveChatTurnRoute({
            surface,
            activeSettings: {
              ...DEFAULT_AI_SETTINGS,
              provider: "anthropic",
              model,
            },
            activeApiVariant: null,
            taskEffort: surface === "agent" ? "high" : "medium",
            thinkingEnabled,
          });
          const label = `${model} ${surface} thinking=${thinkingEnabled}`;
          expect(route.outputBudget, label).toMatchObject({
            requestMaxOutputTokens: 32_000,
            responseReservationTokens: 32_000,
          });
          expect(route.wireOutputTokens, label).toBe(32_000);
        }
      }
    }
  });

  it("adaptive thinking を送る Claude 4.6〜4.8 は、thinking の切替が on のときだけ 32,000 になる", () => {
    const models = [
      "claude-opus-4-8",
      "claude-opus-4-7",
      "claude-opus-4-6",
      "claude-sonnet-4-6",
    ];
    for (const model of models) {
      for (const surface of ["chat", "agent"] as const) {
        for (const thinkingEnabled of [true, false]) {
          const route = resolveChatTurnRoute({
            surface,
            activeSettings: {
              ...DEFAULT_AI_SETTINGS,
              provider: "anthropic",
              model,
            },
            activeApiVariant: null,
            taskEffort: surface === "agent" ? "high" : "medium",
            thinkingEnabled,
          });
          const expected = thinkingEnabled ? 32_000 : 4_096;
          const label = `${model} ${surface} thinking=${thinkingEnabled}`;
          expect(route.outputBudget.requestMaxOutputTokens, label).toBe(
            expected,
          );
          expect(route.wireOutputTokens, label).toBe(expected);
        }
      }
    }
  });

  it("budget_tokens 方式の thinking を送る近似（表に無い Claude 4.5 系の id）は、registry で予算も max_tokens も動かず、max_tokens は予算を上回る（PR-C3）", () => {
    const ids = [
      "claude-opus-4-5-preview",
      "claude-sonnet-4-5-20250929-preview",
    ];
    const resolve = (model: string) =>
      resolveChatTurnRoute({
        surface: "agent",
        activeSettings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "anthropic",
          model,
        },
        activeApiVariant: null,
        taskEffort: "high",
        thinkingEnabled: true,
      });
    const before = ids.map(resolve);
    for (const route of before) {
      expect(route.thinking).toMatchObject({
        thinking: { type: "enabled", budget_tokens: 8_000 },
      });
    }
    // 大きい context（予算が増える）と、小さい最大出力・小さい context（clamp が予算以下になる）。
    for (const entry of [
      { contextWindow: 1_000_000, maxOutputTokens: 128_000 },
      { contextWindow: 1_000_000, maxOutputTokens: 2_048 },
      { contextWindow: 4_096, maxOutputTokens: 1_024 },
    ]) {
      setRegistryModelCaps({
        models: Object.fromEntries(ids.map((id) => [`anthropic/${id}`, entry])),
      });
      ids.forEach((id, index) => {
        const after = resolve(id);
        expect(after.thinking, id).toEqual(before[index].thinking);
        expect(after.outputBudget, id).toEqual(before[index].outputBudget);
        expect(after.wireOutputTokens, id).toBe(before[index].wireOutputTokens);
        const budget = (
          after.thinking as { thinking?: { budget_tokens?: number } }
        ).thinking?.budget_tokens;
        expect(after.wireOutputTokens, id).toBeGreaterThan(budget ?? 0);
      });
    }
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
    expect(isLocalInferenceRoute(route)).toBe(true);
  });

  it.each([
    "http://localhost:1234/v1",
    "http://127.0.0.1:8080/v1",
    "http://[::1]:8080/v1",
    "http://192.168.1.25:1234/v1",
    "http://172.20.0.5:1234/v1",
    "http://10.10.0.4:1234/v1",
  ])("recognizes a local OpenAI-compatible endpoint at %s", (baseUrl) => {
    const route = resolveChatTurnRoute({
      surface: "chat",
      activeSettings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openai-compatible",
        model: "local-model",
        openaiCompatibleEndpoints: [
          {
            id: "local",
            label: "Local",
            baseUrl,
          },
        ],
        activeOpenaiCompatibleEndpointId: "local",
      },
      taskEffort: "medium",
    });

    expect(isLocalInferenceRoute(route)).toBe(true);
  });

  it.each([
    "https://inference.example.com/v1",
    "https://fda.gov/v1",
    "https://feature.example.com/v1",
  ])(
    "does not classify a public OpenAI-compatible endpoint as local: %s",
    (baseUrl) => {
      const route = resolveChatTurnRoute({
        surface: "chat",
        activeSettings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openai-compatible",
          model: "remote-model",
          openaiCompatibleEndpoints: [
            {
              id: "remote",
              label: "Remote",
              baseUrl,
            },
          ],
          activeOpenaiCompatibleEndpointId: "remote",
        },
        taskEffort: "medium",
      });

      expect(isLocalInferenceRoute(route)).toBe(false);
    },
  );

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
