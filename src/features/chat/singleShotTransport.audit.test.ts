import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SETTINGS } from "./types";

const callOrder: string[] = [];
const runtimeTargetMock = vi.hoisted(() => vi.fn((): "web" | null => null));
const invokeMock = vi.hoisted(() =>
  vi.fn(async () => {
    callOrder.push("provider");
    return {
      blocks: [
        { type: "thinking", content: "公開thinking" },
        { type: "text", content: "result" },
      ],
      stopReason: "end_turn",
      inputTokens: 11,
      outputTokens: 5,
    };
  }),
);
const beginMock = vi.hoisted(() =>
  vi.fn(async (input: Record<string, unknown>) => {
    callOrder.push("audit-begin");
    return {
      ...input,
      expectedWorkspacePath: "/workspace",
      operationId: input.operationId ?? "operation-test",
      executionId: input.executionId ?? "execution-test",
      parentExecutionId: input.parentExecutionId ?? null,
      startedAt: 1,
    };
  }),
);
const dispatchedMock = vi.hoisted(() =>
  vi.fn(async () => {
    callOrder.push("audit-dispatched");
  }),
);
const completeMock = vi.hoisted(() =>
  vi.fn(async () => {
    callOrder.push("audit-complete");
  }),
);
const failMock = vi.hoisted(() => vi.fn(async () => undefined));
const skipMock = vi.hoisted(() =>
  vi.fn(async () => {
    callOrder.push("audit-skipped");
  }),
);

vi.mock("@/lib/tauri", () => ({ invoke: invokeMock }));
vi.mock("@/runtime/runtimeDocumentTarget", () => ({
  readDocumentRuntimeTarget: runtimeTargetMock,
}));
vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecution: beginMock,
  markAiAuditDispatched: dispatchedMock,
  completeAiAuditExecution: completeMock,
  failAiAuditExecution: failMock,
  skipAiAuditExecution: skipMock,
}));

import { testAiConnection } from "./api";
import {
  chatAuditRouteCoverage,
  invokeSingleShotChat,
  resolveChatAuditRoute,
} from "./singleShotTransport";
import { useAiSettingsStore } from "./store";

const SINGLE_SHOT_PATHS = [
  "AI audit path: synopsis",
  "AI audit path: session_title",
  "AI audit path: summarization",
  "AI audit path: foreshadow_audit_chapter",
  "AI audit path: foreshadow_propose_past_setups",
  "AI audit path: foreshadow_evaluate_setup_strength",
  "AI audit path: plot_thread_propose",
  "AI audit path: chronicle_extract",
  "AI audit path: beat_role",
  "AI audit path: codex_judgment",
  "AI audit path: codex_yomi",
  "AI audit path: map_branch",
  "AI audit path: tree_scaffold",
  "AI audit path: ab_chat",
] as const;

describe("single-shot AI audit contracts", () => {
  beforeEach(() => {
    callOrder.length = 0;
    vi.clearAllMocks();
    runtimeTargetMock.mockReturnValue(null);
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openrouter",
        model: "gpt-5.6",
      },
    });
  });

  it.each(SINGLE_SHOT_PATHS)("%s", async (label) => {
    const pathId = label.slice("AI audit path: ".length);
    await invokeSingleShotChat(
      {
        messages: [{ role: "user", content: "exact prompt" }],
        provider: null,
        model: null,
        apiVariant: null,
      },
      { projectId: "project-1", pathId },
    );

    expect(callOrder).toEqual([
      "audit-begin",
      "audit-dispatched",
      "provider",
      "audit-complete",
    ]);
    expect(beginMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        pathId,
        request: expect.objectContaining({
          messages: [{ role: "user", content: "exact prompt" }],
          auditMetadata: expect.objectContaining({
            routeObservation: expect.objectContaining({
              rendererProviderSnapshot: "openrouter",
              rendererModelSnapshot: "gpt-5.6",
              transportEffectiveRouteObserved: false,
            }),
          }),
        }),
      }),
    );
    expect(dispatchedMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        runtimeTarget: "electron",
        dispatchBoundary: "before_electron_native_ipc_invoke",
        transportTarget: "electron-native-ipc",
        providerReceiptObserved: false,
        modelDispatched: null,
      }),
    );
    expect(completeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        response: expect.objectContaining({ stopReason: "end_turn" }),
      }),
    );
    expect(invokeMock).toHaveBeenLastCalledWith(
      "send_chat_message",
      expect.objectContaining({
        auditContext: {
          expectedWorkspacePath: "/workspace",
          projectId: "project-1",
          operationId: "operation-test",
          executionId: "execution-test",
          parentExecutionId: null,
          pathId,
        },
      }),
    );
  });

  it("blocks provider dispatch when the durable audit start fails", async () => {
    beginMock.mockRejectedValueOnce(new Error("audit unavailable"));
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "must not send" }] },
        { projectId: "project-1", pathId: "synopsis" },
      ),
    ).rejects.toThrow("audit unavailable");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("durably records unsupported CLI single-shot as skipped before throwing", async () => {
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "cli",
        model: "gpt-5.6",
      },
    });

    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "must not dispatch" }] },
        { projectId: "project-1", pathId: "summarization" },
      ),
    ).rejects.toMatchObject({ code: "AI_SINGLE_SHOT_CLI_UNSUPPORTED" });

    expect(callOrder).toEqual(["audit-begin", "audit-skipped"]);
    expect(skipMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reason: "AI_SINGLE_SHOT_CLI_UNSUPPORTED",
        metadata: expect.objectContaining({ unsupportedProvider: "cli" }),
      }),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("AI audit path: ai_connection_test", async () => {
    invokeMock.mockResolvedValueOnce("Connection OK" as never);
    await testAiConnection("openrouter", "gpt-5.6");
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: null,
        pathId: "ai_connection_test",
        captureState: "complete",
      }),
    );
  });

  it.each([
    {
      provider: "openai-compatible",
      model: "local-model",
      expected: "openai-compatible-default-endpoint-resolved-downstream",
    },
    {
      provider: "ai-novelist",
      model: "2.0.0-GHQ",
      expected: "ai-novelist-api-variant-inferred-downstream-from-model",
    },
    {
      provider: "openrouter",
      model: "openrouter/fusion",
      apiVariant: "responses",
      expected: "api-variant-forced-downstream-for-openrouter-fusion",
    },
  ])(
    "marks native-only route resolution partial: $expected",
    ({ provider, model, apiVariant, expected }) => {
      const route = resolveChatAuditRoute({
        provider,
        model,
        apiVariant: apiVariant ?? null,
      });
      expect(chatAuditRouteCoverage(route)).toEqual(
        expect.objectContaining({
          captureState: "partial",
          limitations: expect.arrayContaining([expected]),
        }),
      );
    },
  );

  it("only calls a route complete when immutable turn fields prove it before transport", () => {
    const explicit = resolveChatAuditRoute({
      provider: "anthropic",
      model: "claude-4.6-sonnet",
      apiVariant: null,
    });
    expect(chatAuditRouteCoverage(explicit)).toEqual({
      captureState: "complete",
    });

    const settingsDerived = resolveChatAuditRoute({
      provider: null,
      model: null,
      apiVariant: null,
    });
    expect(chatAuditRouteCoverage(settingsDerived)).toEqual(
      expect.objectContaining({
        captureState: "partial",
        limitations: expect.arrayContaining([
          "provider-or-model-derived-from-renderer-settings-before-effective-request-receipt",
        ]),
      }),
    );
  });

  it.each(["anthropic", "ollama"])(
    "clears an unrelated settings api variant for an explicit %s provider override",
    (provider) => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openai",
          model: "gpt-5.6",
          modelApiVariant: "responses",
        },
      });

      const route = resolveChatAuditRoute({
        provider,
        model: provider === "anthropic" ? "claude-4.6-sonnet" : "gemma4",
        apiVariant: null,
        ...(provider === "ollama"
          ? { expectedOllamaEndpoint: DEFAULT_AI_SETTINGS.ollamaEndpoint }
          : {}),
      });

      // Downstream apply_provider_override clears model_api_variant whenever a
      // provider override is present; renderer evidence must match that route.
      expect(route.apiVariant).toBeNull();
      expect(route.transportResolutionLimitations).not.toContain(
        "api-variant-may-be-resolved-downstream-from-settings",
      );
      expect(chatAuditRouteCoverage(route)).toEqual({
        captureState: "complete",
      });
    },
  );

  it("marks a Web Editor request complete because BrowserMock receipts the final body", async () => {
    runtimeTargetMock.mockReturnValue("web");
    const route = resolveChatAuditRoute({
      provider: "anthropic",
      model: "claude-4.6-sonnet",
      apiVariant: null,
    });

    expect(chatAuditRouteCoverage(route)).toEqual({ captureState: "complete" });

    await invokeSingleShotChat(
      {
        messages: [{ role: "user", content: "exact browser prompt" }],
        provider: "anthropic",
        model: "claude-4.6-sonnet",
        apiVariant: null,
        thinking: "enabled",
        systemCacheSegments: ["cache me"],
      },
      { projectId: "project-1", pathId: "synopsis" },
    );
    expect(beginMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        captureState: "complete",
        request: expect.objectContaining({
          auditMetadata: expect.objectContaining({
            routeObservation: expect.objectContaining({
              captureState: "complete",
              rendererRouteProvenImmutable: true,
              transportEffectiveRouteObserved: false,
            }),
          }),
        }),
      }),
    );
    expect(dispatchedMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        runtimeTarget: "web",
        dispatchBoundary: "before_browser_mock_invoke",
        transportTarget: "browser-mock",
        providerReceiptObserved: false,
      }),
    );
  });
});
