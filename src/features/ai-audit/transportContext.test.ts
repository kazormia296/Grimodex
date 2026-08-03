import { describe, expect, it } from "vitest";
import {
  auditRequestFromChatArgs,
  type AiAuditResolvedRouteSnapshot,
} from "./transportContext";

const EFFECTIVE_ROUTE: AiAuditResolvedRouteSnapshot = {
  provider: "ollama",
  model: "qwen3:8b",
  apiVariant: "chat-completions",
  endpointId: null,
  endpointOrigin: "http://127.0.0.1:11434",
  authority: "turn-snapshot",
  transportResolutionLimitations: [],
};

describe("auditRequestFromChatArgs", () => {
  it("captures every model-visible chat argument and the effective route exactly", () => {
    const request = auditRequestFromChatArgs(
      {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "developer", content: "developer prompt" },
          { role: "user", content: "manuscript prompt" },
        ],
        tools: [
          {
            name: "search_codex",
            description: "Search project knowledge",
            inputSchema: { type: "object", required: ["query"] },
          },
        ],
        provider: null,
        model: null,
        thinking: { type: "enabled", budgetTokens: 2048 },
        effort: "max",
        reasoningEnabled: true,
        reasoningEffort: "high",
        apiVariant: "chat-completions",
        endpointId: null,
        requestMaxOutputTokens: 8192,
        resolvedToolProtocol: "native-tools",
        systemCacheSegments: ["stable system", "stable project context"],
        systemVolatileTail: "latest scene context",
        webSearch: { enabled: true, maxUses: 3 },
      },
      EFFECTIVE_ROUTE,
    );

    expect(request).toEqual({
      messages: [
        { role: "system", content: "system prompt" },
        { role: "developer", content: "developer prompt" },
        { role: "user", content: "manuscript prompt" },
      ],
      options: {
        thinking: { type: "enabled", budgetTokens: 2048 },
        effort: "max",
        reasoningEnabled: true,
        reasoningEffort: "high",
        apiVariant: "chat-completions",
        endpointId: null,
        requestMaxOutputTokens: 8192,
        resolvedToolProtocol: "native-tools",
        webSearch: { enabled: true, maxUses: 3 },
      },
      modelVisibleContext: {
        systemCacheSegments: ["stable system", "stable project context"],
        systemVolatileTail: "latest scene context",
      },
      tools: [
        {
          name: "search_codex",
          description: "Search project knowledge",
          inputSchema: { type: "object", required: ["query"] },
        },
      ],
      auditMetadata: {
        routeObservation: {
          captureState: "complete",
          requestedProvider: null,
          requestedModel: null,
          rendererProviderSnapshot: "ollama",
          rendererModelSnapshot: "qwen3:8b",
          rendererApiVariantSnapshot: "chat-completions",
          rendererEndpointIdSnapshot: null,
          rendererEndpointOriginSnapshot: "http://127.0.0.1:11434",
          rendererRouteProvenImmutable: true,
          authority: "turn-snapshot",
          transportEffectiveRouteObserved: false,
          transportResolutionLimitations: [],
          resolutionBoundary: "renderer_before_transport",
        },
      },
    });
  });

  it("excludes transport-only credentials and endpoint authority inputs", () => {
    const request = auditRequestFromChatArgs(
      {
        messages: [{ role: "user", content: "safe prompt" }],
        provider: "ollama",
        model: "qwen3:8b",
        expectedOllamaEndpoint:
          "http://user:password@127.0.0.1:11434/private?token=secret",
        authorization: "Bearer secret",
        apiKey: "sk-secret",
        api_key: "sk-secret-2",
        cookie: "session=secret",
        headers: { Authorization: "Bearer secret" },
        env: { OPENAI_API_KEY: "secret" },
        binaryPath: "/private/codex",
      },
      EFFECTIVE_ROUTE,
    );

    expect(JSON.stringify(request)).not.toContain("secret");
    expect(request).not.toHaveProperty("expectedOllamaEndpoint");
    expect(request).not.toHaveProperty("authorization");
    expect(request).not.toHaveProperty("apiKey");
    expect(request).not.toHaveProperty("api_key");
    expect(request).not.toHaveProperty("cookie");
    expect(request).not.toHaveProperty("headers");
    expect(request).not.toHaveProperty("env");
    expect(request).not.toHaveProperty("binaryPath");
    expect(request.auditMetadata).toEqual(
      expect.objectContaining({
        routeObservation: expect.objectContaining({
          rendererEndpointOriginSnapshot: "http://127.0.0.1:11434",
        }),
      }),
    );
  });
});
