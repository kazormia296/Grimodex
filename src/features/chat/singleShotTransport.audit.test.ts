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
import { digestStageModelExecutionBinding } from "@/features/narrative-extraction/reconciler/stageProvenance";
import type { AiAuditJsonObject } from "@/features/ai-audit/types";
import { bindChronicleStageAuditContext } from "@/application/narrative-extraction/aiTasks/chronicleStageAudit";
import {
  createStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "@/features/narrative-extraction/reconciler/stageExecution";
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
  "AI audit path: narrative_observation_extract",
  "AI audit path: narrative_event_synthesize",
  "AI audit path: narrative_entity_resolve",
  "AI audit path: narrative_relation_synthesize",
  "AI audit path: narrative_state_synthesize",
  "AI audit path: narrative_phase_synthesize",
  "AI audit path: narrative_detail_compose",
  "AI audit path: narrative_temporal_attach",
  "AI audit path: narrative_temporal_synthesize",
  "AI audit path: narrative_structured_repair",
  "AI audit path: narrative_plot_thread_synthesize",
  "AI audit path: narrative_plot_development_classify",
  "AI audit path: narrative_plot_marker_assign",
  "AI audit path: narrative_plot_relation_synthesize",
  "AI audit path: narrative_foreshadow_signal_synthesize",
  "AI audit path: narrative_setup_payoff_link",
  "AI audit path: narrative_foreshadow_global_reconcile",
  "AI audit path: narrative_foreshadow_quality_evaluate",
  "AI audit path: generic_import_role_classify",
  "AI audit path: generic_import_document_partition",
  "AI audit path: generic_import_custom_extract",
  "AI audit path: generic_import_record_reconcile",
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

  it("rejects Chronicle v2 begin metadata when protected fields are missing", async () => {
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "missing seal" }] },
        {
          projectId: "project-1",
          pathId: "narrative_observation_extract",
          metadata: { chronicleStage: { kind: "chronicle-stage", version: 2 } },
        },
      ),
    ).rejects.toThrow(/Chronicle Stage begin .*required/i);
    expect(beginMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();

    const partialStage = {
      kind: "chronicle-stage",
      version: 2,
      modelExecutionBinding: {
        kind: "chronicle-stage-model-binding" as const,
        version: 1 as const,
        provider: "anthropic",
        endpointBindingId: null,
        requestedModel: "claude-4.6-sonnet",
        effectiveModel: null,
        modelFingerprint: null,
        apiVariant: null,
        reasoningMode: null,
        generationMode: "explicit" as const,
        resolutionStatus: "requested-only" as const,
      },
    };
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "partial seal" }] },
        {
          projectId: "project-1",
          pathId: "narrative_observation_extract",
          metadata: { chronicleStage: partialStage },
        },
      ),
    ).rejects.toThrow(/Chronicle Stage begin .*required/i);
    expect(beginMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();

    const completeContext = bindChronicleStageAuditContext(
      { projectId: "project-1", pathId: "narrative_observation_extract" },
      createStageExecutionContext({
        projectId: "project-1",
        runId: "run-missing-binding",
        taskId: "task-missing-binding",
        attemptId: "attempt-missing-binding",
        stageId: NARRATIVE_STAGE_IDS.observationExtraction,
        stageExecutionId: "stage-missing-binding",
      }),
      {
        contextSetDigest: `sha256:${"5".repeat(64)}`,
        componentContractDigest: `sha256:${"6".repeat(64)}`,
        finalRequestDigest: `sha256:${"7".repeat(64)}`,
      },
    );
    const completeStage = completeContext.metadata?.chronicleStage as Record<
      string,
      unknown
    >;
    const missingDigest = { ...completeStage };
    delete missingDigest.modelBindingDigest;
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "missing digest" }] },
        {
          ...completeContext,
          metadata: {
            chronicleStage: missingDigest as unknown as AiAuditJsonObject,
          },
          onResolvedRouteMetadata: undefined,
        },
      ),
    ).rejects.toThrow(/modelBindingDigest.*required/i);

    const missingBinding = { ...completeStage };
    delete missingBinding.modelExecutionBinding;
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "missing binding" }] },
        {
          ...completeContext,
          metadata: {
            chronicleStage: missingBinding as unknown as AiAuditJsonObject,
          },
          onResolvedRouteMetadata: undefined,
        },
      ),
    ).rejects.toThrow(/modelExecutionBinding.*required/i);
    expect(beginMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("awaits route metadata before begin and carries the sealed metadata to terminal", async () => {
    const order: string[] = [];
    const stageExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-route-seal",
      taskId: "task-route-seal",
      attemptId: "attempt-route-seal",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-route-seal",
    });
    const boundContext = bindChronicleStageAuditContext(
      { projectId: "project-1", pathId: "narrative_observation_extract" },
      stageExecution,
      {
        contextSetDigest: `sha256:${"1".repeat(64)}`,
        componentContractDigest: `sha256:${"2".repeat(64)}`,
        finalRequestDigest: `sha256:${"3".repeat(64)}`,
      },
    );
    const initialStage = boundContext.metadata?.chronicleStage as Record<
      string,
      unknown
    >;
    let resolvedStage: Record<string, unknown> = initialStage;
    const onResolvedRouteMetadata = vi.fn(async () => {
      order.push("route-metadata");
      const modelExecutionBinding = {
        kind: "chronicle-stage-model-binding" as const,
        version: 1 as const,
        provider: "anthropic",
        endpointBindingId: null,
        requestedModel: "claude-4.6-sonnet",
        effectiveModel: null,
        modelFingerprint: null,
        apiVariant: null,
        reasoningMode: null,
        generationMode: "explicit" as const,
        resolutionStatus: "requested-only" as const,
      };
      resolvedStage = {
        ...initialStage,
        modelExecutionBinding,
        modelBindingDigest: await digestStageModelExecutionBinding(
          modelExecutionBinding,
        ),
      };
      return {
        chronicleStage: resolvedStage as unknown as AiAuditJsonObject,
      };
    });
    const onTerminalMetadata = vi.fn(async () => {
      order.push("terminal-hook");
      return {
        chronicleStage: {
          ...resolvedStage,
          parseStatus: "parsed",
          terminalStatus: "succeeded",
          stageExecutionReceiptDigest: `sha256:${"4".repeat(64)}`,
        } as unknown as AiAuditJsonObject,
        chronicleTerminal: true,
      };
    });
    const onAuditCompleted = vi.fn(async () => {
      order.push("audit-completed-hook");
    });

    await invokeSingleShotChat(
      {
        messages: [{ role: "user", content: "exact prompt" }],
        provider: "anthropic",
        model: "claude-4.6-sonnet",
      },
      {
        ...boundContext,
        onResolvedRouteMetadata,
        onTerminalMetadata,
        onAuditCompleted,
      },
    );

    expect(order).toEqual([
      "route-metadata",
      "terminal-hook",
      "audit-completed-hook",
    ]);
    expect(onAuditCompleted).toHaveBeenCalledOnce();
    expect(beginMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          chronicleStage: expect.objectContaining({
            version: 2,
            modelExecutionBinding: expect.objectContaining({
              resolutionStatus: "requested-only",
            }),
          }),
        }),
      }),
    );
    expect(completeMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({ chronicleTerminal: true }),
      }),
    );
  });

  it("fails the Chronicle execution when its terminal provenance hook fails", async () => {
    const hookError = new Error("receipt construction failed");
    const stageExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-hook-failure",
      taskId: "task-hook-failure",
      attemptId: "attempt-hook-failure",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-hook-failure",
    });
    const base = bindChronicleStageAuditContext(
      { projectId: "project-1", pathId: "narrative_observation_extract" },
      stageExecution,
      {
        contextSetDigest: `sha256:${"8".repeat(64)}`,
        componentContractDigest: `sha256:${"9".repeat(64)}`,
        finalRequestDigest: `sha256:${"a".repeat(64)}`,
      },
    );
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "must not be accepted" }] },
        {
          ...base,
          onTerminalMetadata: async () => {
            throw hookError;
          },
        },
      ),
    ).rejects.toBe(hookError);
    expect(failMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        error: expect.objectContaining({ message: hookError.message }),
      }),
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("does not publish a Chronicle receipt when durable audit completion fails", async () => {
    const receipts: unknown[] = [];
    completeMock.mockRejectedValueOnce(new Error("audit terminal unavailable"));
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "no orphan" }] },
        {
          projectId: "project-1",
          pathId: "narrative_observation_extract",
          onTerminalMetadata: async () => ({
            chronicleTerminal: true,
          }),
          onAuditCompleted: async () => {
            receipts.push("receipt");
          },
        },
      ),
    ).rejects.toThrow("audit terminal unavailable");
    expect(receipts).toEqual([]);
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
        {
          projectId: "project-1",
          pathId: "summarization",
          onNoResponseTerminalMetadata: async () => {
            callOrder.push("no-response-hook");
            return { chronicleTerminal: { responseDigest: null } };
          },
          onAuditCompleted: async () => {
            callOrder.push("audit-completed-hook");
          },
        },
      ),
    ).rejects.toMatchObject({ code: "AI_SINGLE_SHOT_CLI_UNSUPPORTED" });

    expect(callOrder).toEqual([
      "audit-begin",
      "no-response-hook",
      "audit-skipped",
      "audit-completed-hook",
    ]);
    expect(skipMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reason: "AI_SINGLE_SHOT_CLI_UNSUPPORTED",
        metadata: expect.objectContaining({ unsupportedProvider: "cli" }),
      }),
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("closes provider dispatch failure through the no-response hook before rethrowing", async () => {
    const order: string[] = [];
    const providerError = new Error("provider unavailable");
    invokeMock.mockRejectedValueOnce(providerError);
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "no response" }] },
        {
          projectId: "project-1",
          pathId: "narrative_observation_extract",
          onNoResponseTerminalMetadata: async () => {
            order.push("no-response-hook");
            return { chronicleTerminal: { responseDigest: null } };
          },
          onAuditCompleted: async () => {
            order.push("audit-completed-hook");
          },
        },
      ),
    ).rejects.toBe(providerError);
    expect(order).toEqual(["no-response-hook", "audit-completed-hook"]);
    expect(failMock).toHaveBeenCalledOnce();
    expect(failMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          chronicleTerminal: { responseDigest: null },
        }),
      }),
    );
  });

  it("rejects a Chronicle terminal Context Set digest swap before completion", async () => {
    const stageExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-seal",
      taskId: "task-seal",
      attemptId: "attempt-seal",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-seal",
    });
    const base = bindChronicleStageAuditContext(
      { projectId: "project-1", pathId: "narrative_observation_extract" },
      stageExecution,
      {
        contextSetDigest: `sha256:${"1".repeat(64)}`,
        componentContractDigest: `sha256:${"2".repeat(64)}`,
        finalRequestDigest: `sha256:${"3".repeat(64)}`,
      },
    );
    const beginStage = base.metadata?.chronicleStage as Record<string, unknown>;
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "sealed" }] },
        {
          ...base,
          onResolvedRouteMetadata: undefined,
          onTerminalMetadata: async () => ({
            chronicleStage: {
              ...beginStage,
              contextSetDigest: `sha256:${"4".repeat(64)}`,
              responseDigest: `sha256:${"5".repeat(64)}`,
              parseStatus: "parsed",
              terminalStatus: "succeeded",
              stageExecutionReceiptDigest: `sha256:${"6".repeat(64)}`,
            },
          }),
        },
      ),
    ).rejects.toThrow(/protected field.*contextSetDigest/i);
    expect(completeMock).not.toHaveBeenCalled();
    expect(failMock).toHaveBeenCalled();
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
