import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_AI_SETTINGS } from "./types";

const callOrder: string[] = [];

function testDigest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}

const runtimeTargetMock = vi.hoisted(() => vi.fn((): "web" | null => null));
const isIpcLifecycleCancellationMock = vi.hoisted(() =>
  vi.fn((error: unknown): boolean => {
    if (error === null || typeof error !== "object") return false;
    const code = (error as { readonly code?: unknown }).code;
    return (
      code === "IPC_READ_CANCELLED" ||
      code === "IPC_DERIVED_CANCELLED" ||
      code === "IPC_MUTATION_CANCELLED"
    );
  }),
);
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
const cancelMock = vi.hoisted(() =>
  vi.fn(async () => {
    callOrder.push("audit-cancelled");
  }),
);
const skipMock = vi.hoisted(() =>
  vi.fn(async () => {
    callOrder.push("audit-skipped");
  }),
);

vi.mock("@/lib/tauri", () => ({
  invoke: invokeMock,
  isIpcLifecycleCancellation: isIpcLifecycleCancellationMock,
}));
vi.mock("@/runtime/runtimeDocumentTarget", () => ({
  readDocumentRuntimeTarget: runtimeTargetMock,
}));
vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecution: beginMock,
  markAiAuditDispatched: dispatchedMock,
  completeAiAuditExecution: completeMock,
  failAiAuditExecution: failMock,
  cancelAiAuditExecution: cancelMock,
  skipAiAuditExecution: skipMock,
}));

import { testAiConnection } from "./api";
import {
  digestStageModelExecutionBinding,
  type StageModelExecutionBindingV1,
} from "@/features/narrative-extraction/reconciler/stageProvenance";
import type { AiAuditJsonObject } from "@/features/ai-audit/types";
import {
  bindChronicleStageAuditContext,
  buildChronicleStageAuditTerminal,
  buildChronicleStageAuditNoResponseTerminal,
} from "@/application/narrative-extraction/aiTasks/chronicleStageAudit";
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
    cancelMock.mockImplementation(async () => {
      callOrder.push("audit-cancelled");
    });
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

  it("closes a dispatched audit when response blocks are malformed", async () => {
    const responseError = {
      blocks: [{ type: "text", content: 42 }],
      stopReason: "end_turn",
    };
    const onAuditCompleted = vi.fn(async () => undefined);
    invokeMock.mockResolvedValueOnce(responseError as never);

    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "malformed response" }] },
        {
          projectId: "project-1",
          pathId: "synopsis",
          onAuditCompleted,
        },
      ),
    ).rejects.toThrow(/text block/i);
    expect(failMock).toHaveBeenCalledOnce();
    expect(completeMock).not.toHaveBeenCalled();
    expect(onAuditCompleted).not.toHaveBeenCalled();
    expect(failMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          chronicleStage: expect.anything(),
        }),
      }),
    );
  });

  it("closes malformed Chronicle responses with one canonical no-response receipt", async () => {
    const stageExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-malformed-chronicle-response",
      taskId: "task-malformed-chronicle-response",
      attemptId: "attempt-malformed-chronicle-response",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-malformed-chronicle-response",
    });
    const digests = {
      contextSetDigest: testDigest("1"),
      componentContractDigest: testDigest("2"),
      finalRequestDigest: testDigest("3"),
    };
    const base = bindChronicleStageAuditContext(
      { projectId: "project-1", pathId: "narrative_observation_extract" },
      stageExecution,
      digests,
    );
    const responseError = {
      blocks: [{ type: "text", content: 42 }],
      stopReason: "end_turn",
    };
    invokeMock.mockResolvedValueOnce(responseError as never);
    let capturedReceipt: unknown;
    const publishedReceipts: unknown[] = [];
    const onNoResponseTerminalMetadata = vi.fn(
      async (terminalStatus: "failed" | "cancelled" | "skipped") => {
        const terminal = await buildChronicleStageAuditNoResponseTerminal({
          stageExecution,
          ...digests,
          terminalStatus,
          onReceipt: (receipt) => {
            capturedReceipt = receipt;
          },
        });
        return { chronicleStage: terminal as unknown as AiAuditJsonObject };
      },
    );
    const onAuditCompleted = vi.fn(async () => {
      publishedReceipts.push(capturedReceipt);
    });

    await expect(
      invokeSingleShotChat(
        {
          messages: [{ role: "user", content: "malformed Chronicle response" }],
        },
        {
          ...base,
          onResolvedRouteMetadata: undefined,
          onNoResponseTerminalMetadata,
          onAuditCompleted,
        },
      ),
    ).rejects.toThrow(/text block/i);
    expect(onNoResponseTerminalMetadata).toHaveBeenCalledOnce();
    expect(failMock).toHaveBeenCalledOnce();
    expect(failMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          chronicleStage: expect.objectContaining({
            terminalStatus: "failed",
            parseStatus: "not-attempted",
            responseDigest: null,
          }),
        }),
      }),
    );
    expect(onAuditCompleted).toHaveBeenCalledOnce();
    expect(publishedReceipts).toHaveLength(1);
    expect(publishedReceipts[0]).toEqual(expect.anything());
    expect(completeMock).not.toHaveBeenCalled();
  });

  it("uses the same route snapshot for Chronicle binding and IPC after settings change", async () => {
    const stageExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-route-toctou",
      taskId: "task-route-toctou",
      attemptId: "attempt-route-toctou",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-route-toctou",
    });
    const digests = {
      contextSetDigest: testDigest("1"),
      componentContractDigest: testDigest("2"),
      finalRequestDigest: testDigest("3"),
    };
    let sealedBinding: StageModelExecutionBindingV1 | undefined;
    const boundContext = bindChronicleStageAuditContext(
      { projectId: "project-1", pathId: "narrative_observation_extract" },
      stageExecution,
      digests,
      (binding) => {
        sealedBinding = binding;
      },
    );
    const terminalContext = {
      ...boundContext,
      onTerminalMetadata: async (responseText: string) => {
        if (sealedBinding === undefined) throw new Error("binding not sealed");
        const terminal = await buildChronicleStageAuditTerminal({
          stageExecution,
          ...digests,
          responseText,
          parseStatus: "parsed",
          terminalStatus: "succeeded",
          modelExecutionBinding: sealedBinding,
        });
        return { chronicleStage: terminal as unknown as AiAuditJsonObject };
      },
    };
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "anthropic",
        model: "claude-4.6-sonnet",
      },
    });
    let releaseBegin!: () => void;
    let markBeginEntered!: () => void;
    const beginEntered = new Promise<void>((resolve) => {
      markBeginEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseBegin = resolve;
    });
    beginMock.mockImplementationOnce(async (input: Record<string, unknown>) => {
      markBeginEntered();
      await release;
      return {
        ...input,
        expectedWorkspacePath: "/workspace",
        operationId: input.operationId ?? "operation-toctou",
        executionId: input.executionId ?? "execution-toctou",
        parentExecutionId: input.parentExecutionId ?? null,
        startedAt: 1,
      };
    });

    const invocation = invokeSingleShotChat(
      {
        messages: [{ role: "user", content: "route snapshot" }],
        provider: null,
        model: null,
        apiVariant: null,
        endpointId: null,
      },
      terminalContext,
    );
    await beginEntered;
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openrouter",
        model: "gpt-5.6",
      },
    });
    releaseBegin();
    await invocation;

    expect(sealedBinding).toMatchObject({
      provider: "anthropic",
      requestedModel: "claude-4.6-sonnet",
    });
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          auditMetadata: expect.objectContaining({
            routeObservation: expect.objectContaining({
              rendererProviderSnapshot: "anthropic",
              rendererModelSnapshot: "claude-4.6-sonnet",
            }),
          }),
        }),
        metadata: expect.objectContaining({
          chronicleStage: expect.objectContaining({
            modelExecutionBinding: expect.objectContaining({
              provider: "anthropic",
              requestedModel: "claude-4.6-sonnet",
            }),
          }),
        }),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "send_chat_message",
      expect.objectContaining({
        provider: "anthropic",
        model: "claude-4.6-sonnet",
        apiVariant: null,
        endpointId: null,
      }),
    );
    expect(completeMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.objectContaining({
          chronicleStage: expect.objectContaining({
            modelExecutionBinding: expect.objectContaining({
              provider: "anthropic",
              requestedModel: "claude-4.6-sonnet",
            }),
          }),
        }),
      }),
    );
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

  it.each(["rawResponse", "credential", "unratified"] as const)(
    "rejects Chronicle v2 begin metadata with unratified field %s",
    async (field) => {
      const stageExecution = createStageExecutionContext({
        projectId: "project-1",
        runId: `run-begin-unknown-${field}`,
        taskId: "task-begin-unknown",
        attemptId: "attempt-begin-unknown",
        stageId: NARRATIVE_STAGE_IDS.observationExtraction,
        stageExecutionId: `stage-begin-unknown-${field}`,
      });
      const base = bindChronicleStageAuditContext(
        { projectId: "project-1", pathId: "narrative_observation_extract" },
        stageExecution,
        {
          contextSetDigest: testDigest("1"),
          componentContractDigest: testDigest("2"),
          finalRequestDigest: testDigest("3"),
        },
      );
      const beginStage = base.metadata?.chronicleStage as Record<
        string,
        unknown
      >;

      await expect(
        invokeSingleShotChat(
          { messages: [{ role: "user", content: "reject unknown begin" }] },
          {
            ...base,
            onResolvedRouteMetadata: undefined,
            metadata: {
              chronicleStage: {
                ...beginStage,
                [field]: field === "unratified" ? true : "must not persist",
              },
            } as unknown as AiAuditJsonObject,
          },
        ),
      ).rejects.toThrow(new RegExp(`unknown field '${field}'`, "i"));
      expect(beginMock).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalled();
    },
  );

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
    let resolvedBinding: StageModelExecutionBindingV1 | undefined;
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
      resolvedBinding = modelExecutionBinding;
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
      if (resolvedBinding === undefined) {
        throw new Error("route binding was not resolved");
      }
      const terminal = await buildChronicleStageAuditTerminal({
        stageExecution,
        contextSetDigest: testDigest("1"),
        componentContractDigest: testDigest("2"),
        finalRequestDigest: testDigest("3"),
        responseText: "result",
        parseStatus: "parsed",
        terminalStatus: "succeeded",
        modelExecutionBinding: resolvedBinding,
      });
      return {
        chronicleStage: terminal as unknown as AiAuditJsonObject,
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
        metadata: expect.not.objectContaining({
          chronicleStage: expect.anything(),
        }),
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

  it("classifies AbortError dispatch rejection as cancelled and emits one Chronicle receipt", async () => {
    const stageExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-cancelled",
      taskId: "task-cancelled",
      attemptId: "attempt-cancelled",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-cancelled",
    });
    const base = bindChronicleStageAuditContext(
      { projectId: "project-1", pathId: "narrative_observation_extract" },
      stageExecution,
      {
        contextSetDigest: testDigest("b"),
        componentContractDigest: testDigest("c"),
        finalRequestDigest: testDigest("d"),
      },
    );
    const abortError = new Error("aborted by caller");
    abortError.name = "AbortError";
    invokeMock.mockRejectedValueOnce(abortError);
    const receipts: unknown[] = [];
    const noResponseHook = vi.fn(
      async (terminalStatus: "failed" | "cancelled" | "skipped") => {
        callOrder.push("no-response-hook");
        const terminal = await buildChronicleStageAuditNoResponseTerminal({
          stageExecution,
          contextSetDigest: testDigest("b"),
          componentContractDigest: testDigest("c"),
          finalRequestDigest: testDigest("d"),
          terminalStatus,
        });
        return {
          chronicleStage: terminal as unknown as AiAuditJsonObject,
        };
      },
    );
    const onAuditCompleted = vi.fn(async () => {
      callOrder.push("audit-completed-hook");
      receipts.push("receipt");
    });

    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "cancel me" }] },
        {
          ...base,
          onResolvedRouteMetadata: undefined,
          onNoResponseTerminalMetadata: noResponseHook,
          onAuditCompleted,
        },
      ),
    ).rejects.toBe(abortError);
    expect(callOrder).toEqual([
      "audit-begin",
      "audit-dispatched",
      "no-response-hook",
      "audit-cancelled",
      "audit-completed-hook",
    ]);
    expect(noResponseHook).toHaveBeenCalledWith("cancelled", expect.anything());
    expect(cancelMock).toHaveBeenCalledOnce();
    expect(failMock).not.toHaveBeenCalled();
    expect(receipts).toHaveLength(1);
  });

  it("does not publish a cancellation receipt when durable cancellation fails", async () => {
    const stageExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-cancel-persist-failure",
      taskId: "task-cancel-persist-failure",
      attemptId: "attempt-cancel-persist-failure",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-cancel-persist-failure",
    });
    const base = bindChronicleStageAuditContext(
      { projectId: "project-1", pathId: "narrative_observation_extract" },
      stageExecution,
      {
        contextSetDigest: testDigest("e"),
        componentContractDigest: testDigest("f"),
        finalRequestDigest: testDigest("0"),
      },
    );
    const abortError = new Error("cancel persistence failure");
    abortError.name = "AbortError";
    invokeMock.mockRejectedValueOnce(abortError);
    cancelMock.mockRejectedValue(new Error("cancel append failed"));
    const noResponseHook = vi.fn(async () => {
      const terminal = await buildChronicleStageAuditNoResponseTerminal({
        stageExecution,
        contextSetDigest: testDigest("e"),
        componentContractDigest: testDigest("f"),
        finalRequestDigest: testDigest("0"),
        terminalStatus: "cancelled",
      });
      return { chronicleStage: terminal as unknown as AiAuditJsonObject };
    });
    const onAuditCompleted = vi.fn(async () => undefined);

    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "cancel no orphan" }] },
        {
          ...base,
          onResolvedRouteMetadata: undefined,
          onNoResponseTerminalMetadata: noResponseHook,
          onAuditCompleted,
        },
      ),
    ).rejects.toBe(abortError);
    expect(noResponseHook).toHaveBeenCalledOnce();
    expect(cancelMock).toHaveBeenCalledOnce();
    expect(onAuditCompleted).not.toHaveBeenCalled();
  });

  it.each([
    "ERR_CANCELED",
    "ABORT_ERR",
    "ECANCELED",
    "IPC_READ_CANCELLED",
    "IPC_DERIVED_CANCELLED",
    "IPC_MUTATION_CANCELLED",
  ] as const)(
    "classifies explicit cancellation code %s without changing provider failures",
    async (code) => {
      const cancellationError = { name: "Error", code, message: "cancelled" };
      invokeMock.mockRejectedValueOnce(cancellationError);
      const onNoResponseTerminalMetadata = vi.fn(
        async (status: "failed" | "cancelled" | "skipped") => {
          expect(status).toBe("cancelled");
          return { chronicleTerminal: { responseDigest: null } };
        },
      );
      const onAuditCompleted = vi.fn(async () => undefined);

      await expect(
        invokeSingleShotChat(
          { messages: [{ role: "user", content: "cancel by code" }] },
          {
            projectId: "project-1",
            pathId: "narrative_observation_extract",
            onNoResponseTerminalMetadata,
            onAuditCompleted,
          },
        ),
      ).rejects.toBe(cancellationError);
      expect(cancelMock).toHaveBeenCalledOnce();
      expect(failMock).not.toHaveBeenCalled();
      expect(onNoResponseTerminalMetadata).toHaveBeenCalledOnce();
      expect(onAuditCompleted).toHaveBeenCalledOnce();
    },
  );

  it.each([
    {
      label: "wrapped ERR_CANCELED",
      error: { name: "Wrapper", cause: { code: "ERR_CANCELED" } },
    },
    {
      label: "wrapped AbortError",
      error: { name: "Wrapper", cause: { name: "AbortError" } },
    },
  ])("classifies $label as cancellation", async ({ error }) => {
    invokeMock.mockRejectedValueOnce(error);
    const onAuditCompleted = vi.fn(async () => undefined);
    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "wrapped cancellation" }] },
        {
          projectId: "project-1",
          pathId: "narrative_observation_extract",
          onNoResponseTerminalMetadata: async () => ({
            chronicleTerminal: { responseDigest: null },
          }),
          onAuditCompleted,
        },
      ),
    ).rejects.toBe(error);
    expect(cancelMock).toHaveBeenCalledOnce();
    expect(failMock).not.toHaveBeenCalled();
    expect(onAuditCompleted).toHaveBeenCalledOnce();
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
    expect(failMock).toHaveBeenCalledOnce();
    expect(failMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          chronicleStage: expect.anything(),
        }),
      }),
    );
  });

  it.each(["rawResponse", "credential", "unratified"] as const)(
    "rejects Chronicle v2 terminal metadata with unknown field %s",
    async (field) => {
      const stageExecution = createStageExecutionContext({
        projectId: "project-1",
        runId: `run-terminal-unknown-${field}`,
        taskId: "task-terminal-unknown",
        attemptId: "attempt-terminal-unknown",
        stageId: NARRATIVE_STAGE_IDS.observationExtraction,
        stageExecutionId: `stage-terminal-unknown-${field}`,
      });
      const base = bindChronicleStageAuditContext(
        { projectId: "project-1", pathId: "narrative_observation_extract" },
        stageExecution,
        {
          contextSetDigest: testDigest("6"),
          componentContractDigest: testDigest("7"),
          finalRequestDigest: testDigest("8"),
        },
      );
      const validTerminal = await buildChronicleStageAuditTerminal({
        stageExecution,
        contextSetDigest: testDigest("6"),
        componentContractDigest: testDigest("7"),
        finalRequestDigest: testDigest("8"),
        responseText: "result",
        parseStatus: "parsed",
        terminalStatus: "succeeded",
      });

      await expect(
        invokeSingleShotChat(
          { messages: [{ role: "user", content: "reject unknown terminal" }] },
          {
            ...base,
            onResolvedRouteMetadata: undefined,
            onTerminalMetadata: async () => ({
              chronicleStage: {
                ...(validTerminal as unknown as Record<string, unknown>),
                [field]: field === "unratified" ? true : "must not persist",
              } as unknown as AiAuditJsonObject,
            }),
          },
        ),
      ).rejects.toThrow(new RegExp(`unknown field '${field}'`, "i"));
      expect(completeMock).not.toHaveBeenCalled();
      expect(failMock).toHaveBeenCalledOnce();
      expect(failMock).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.objectContaining({
          metadata: expect.not.objectContaining({
            chronicleStage: expect.anything(),
          }),
        }),
      );
    },
  );

  it.each([
    { transportStatus: "cancelled", hookStatus: "failed" },
    { transportStatus: "failed", hookStatus: "cancelled" },
    { transportStatus: "skipped", hookStatus: "failed" },
  ] as const)(
    "rejects no-response terminal status relabeling ($transportStatus -> $hookStatus) before durable close",
    async ({ transportStatus, hookStatus }) => {
      const stageExecution = createStageExecutionContext({
        projectId: "project-1",
        runId: `run-status-mismatch-${transportStatus}`,
        taskId: "task-status-mismatch",
        attemptId: "attempt-status-mismatch",
        stageId: NARRATIVE_STAGE_IDS.observationExtraction,
        stageExecutionId: `stage-status-mismatch-${transportStatus}`,
      });
      const base = bindChronicleStageAuditContext(
        { projectId: "project-1", pathId: "narrative_observation_extract" },
        stageExecution,
        {
          contextSetDigest: testDigest("9"),
          componentContractDigest: testDigest("a"),
          finalRequestDigest: testDigest("b"),
        },
      );
      const providerError = new Error(`transport ${transportStatus}`);
      if (transportStatus === "cancelled") {
        providerError.name = "AbortError";
        invokeMock.mockRejectedValueOnce(providerError);
      } else if (transportStatus === "failed") {
        invokeMock.mockRejectedValueOnce(providerError);
      }
      const onNoResponseTerminalMetadata = vi.fn(async () => {
        const terminal = await buildChronicleStageAuditNoResponseTerminal({
          stageExecution,
          contextSetDigest: testDigest("9"),
          componentContractDigest: testDigest("a"),
          finalRequestDigest: testDigest("b"),
          terminalStatus: hookStatus,
        });
        return { chronicleStage: terminal as unknown as AiAuditJsonObject };
      });
      const invocation = invokeSingleShotChat(
        {
          messages: [{ role: "user", content: "reject relabel" }],
          ...(transportStatus === "skipped" ? { provider: "cli" } : {}),
        },
        {
          ...base,
          onResolvedRouteMetadata: undefined,
          onNoResponseTerminalMetadata,
        },
      );

      await expect(invocation).rejects.toThrow(/terminalStatus.*transport/i);
      expect(onNoResponseTerminalMetadata).toHaveBeenCalledWith(
        transportStatus,
        expect.anything(),
      );
      const safeTerminalInput = expect.objectContaining({
        metadata: expect.not.objectContaining({
          chronicleStage: expect.anything(),
        }),
      });
      if (transportStatus === "cancelled") {
        expect(cancelMock).toHaveBeenCalledOnce();
        expect(cancelMock).toHaveBeenCalledWith(
          expect.anything(),
          safeTerminalInput,
        );
      } else if (transportStatus === "failed") {
        expect(failMock).toHaveBeenCalledOnce();
        expect(failMock).toHaveBeenCalledWith(
          expect.anything(),
          safeTerminalInput,
        );
      } else {
        expect(skipMock).toHaveBeenCalledOnce();
        expect(skipMock).toHaveBeenCalledWith(
          expect.anything(),
          safeTerminalInput,
        );
      }
    },
  );

  it("closes no-response audit generically when the hook returns invalid Chronicle metadata", async () => {
    const stageExecution = createStageExecutionContext({
      projectId: "project-1",
      runId: "run-no-response-invalid-hook",
      taskId: "task-no-response-invalid-hook",
      attemptId: "attempt-no-response-invalid-hook",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "stage-no-response-invalid-hook",
    });
    const base = bindChronicleStageAuditContext(
      { projectId: "project-1", pathId: "narrative_observation_extract" },
      stageExecution,
      {
        contextSetDigest: testDigest("c"),
        componentContractDigest: testDigest("d"),
        finalRequestDigest: testDigest("e"),
      },
    );
    const beginStage = base.metadata?.chronicleStage as Record<string, unknown>;
    const providerError = new Error("provider did not respond");
    invokeMock.mockRejectedValueOnce(providerError);

    await expect(
      invokeSingleShotChat(
        { messages: [{ role: "user", content: "invalid no-response" }] },
        {
          ...base,
          onResolvedRouteMetadata: undefined,
          onNoResponseTerminalMetadata: async () => ({
            chronicleStage: {
              ...beginStage,
              rawResponse: "must not persist",
              responseDigest: null,
              parseStatus: "not-attempted",
              terminalStatus: "failed",
              stageExecutionReceiptDigest: testDigest("f"),
            } as unknown as AiAuditJsonObject,
          }),
          onAuditCompleted: async () => {
            throw new Error("receipt must not publish");
          },
        },
      ),
    ).rejects.toThrow(/unknown field 'rawResponse'/i);
    expect(failMock).toHaveBeenCalledOnce();
    expect(failMock).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({
        metadata: expect.not.objectContaining({
          chronicleStage: expect.anything(),
        }),
      }),
    );
    expect(completeMock).not.toHaveBeenCalled();
  });

  it.each(["tampered receipt digest", "invalid status pair"] as const)(
    "rejects a Chronicle terminal %s before durable completion",
    async (mutation) => {
      const stageExecution = createStageExecutionContext({
        projectId: "project-1",
        runId: `run-terminal-${mutation.replace(/\s+/gu, "-")}`,
        taskId: "task-terminal-seal",
        attemptId: "attempt-terminal-seal",
        stageId: NARRATIVE_STAGE_IDS.observationExtraction,
        stageExecutionId: `stage-terminal-${mutation.replace(/\s+/gu, "-")}`,
      });
      const base = bindChronicleStageAuditContext(
        { projectId: "project-1", pathId: "narrative_observation_extract" },
        stageExecution,
        {
          contextSetDigest: testDigest("2"),
          componentContractDigest: testDigest("3"),
          finalRequestDigest: testDigest("4"),
        },
      );
      const validTerminal = await buildChronicleStageAuditTerminal({
        stageExecution,
        contextSetDigest: testDigest("2"),
        componentContractDigest: testDigest("3"),
        finalRequestDigest: testDigest("4"),
        responseText: "result",
        parseStatus: "parsed",
        terminalStatus: "succeeded",
      });
      const terminalStage = validTerminal as unknown as Record<string, unknown>;
      const mutatedStage = {
        ...terminalStage,
        ...(mutation === "tampered receipt digest"
          ? { stageExecutionReceiptDigest: testDigest("5") }
          : { parseStatus: "invalid", terminalStatus: "succeeded" }),
      } as unknown as AiAuditJsonObject;

      await expect(
        invokeSingleShotChat(
          { messages: [{ role: "user", content: "reject terminal" }] },
          {
            ...base,
            onResolvedRouteMetadata: undefined,
            onTerminalMetadata: async () => ({
              chronicleStage: mutatedStage,
            }),
          },
        ),
      ).rejects.toThrow(/receipt digest|parseStatus|terminalStatus/i);
      expect(completeMock).not.toHaveBeenCalled();
      expect(failMock).toHaveBeenCalled();
    },
  );

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

  it.each([
    {
      label: "explicit endpoint was deleted",
      args: { endpointId: "endpoint-a" },
      activeOpenaiCompatibleEndpointId: "endpoint-b",
    },
  ])(
    "rejects $label before audit begin or provider dispatch",
    async ({ args, activeOpenaiCompatibleEndpointId }) => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openai-compatible",
          model: "local-model",
          openaiCompatible: { baseUrl: "" },
          openaiCompatibleEndpoints: [
            { id: "endpoint-b", label: "B", baseUrl: "http://b/v1" },
          ],
          activeOpenaiCompatibleEndpointId,
        },
      });

      await expect(
        invokeSingleShotChat(
          {
            messages: [{ role: "user", content: "stale endpoint" }],
            provider: "openai-compatible",
            model: "local-model",
            ...args,
          },
          { projectId: "project-1", pathId: "synopsis" },
        ),
      ).rejects.toThrow(/endpoint.*configured|endpoint.*available/i);
      expect(beginMock).not.toHaveBeenCalled();
      expect(invokeMock).not.toHaveBeenCalled();
    },
  );

  it.each([null, "deleted-endpoint"] as const)(
    "materializes the first configured endpoint when the active id is %s",
    async (activeOpenaiCompatibleEndpointId) => {
      useAiSettingsStore.setState({
        settings: {
          ...DEFAULT_AI_SETTINGS,
          provider: "openai-compatible",
          model: "local-model",
          openaiCompatible: { baseUrl: "" },
          openaiCompatibleEndpoints: [
            { id: "endpoint-a", label: "A", baseUrl: "http://a/v1" },
            { id: "endpoint-b", label: "B", baseUrl: "http://b/v1" },
          ],
          activeOpenaiCompatibleEndpointId,
        },
      });

      await invokeSingleShotChat(
        {
          messages: [{ role: "user", content: "fallback endpoint" }],
          provider: "openai-compatible",
          model: "local-model",
        },
        { projectId: "project-1", pathId: "synopsis" },
      );
      expect(invokeMock).toHaveBeenCalledWith(
        "send_chat_message",
        expect.objectContaining({ endpointId: "endpoint-a" }),
      );
    },
  );

  it("seals and dispatches a known explicit endpoint without re-resolving it", async () => {
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "openai-compatible",
        model: "local-model",
        openaiCompatible: { baseUrl: "" },
        openaiCompatibleEndpoints: [
          { id: "endpoint-a", label: "A", baseUrl: "http://a/v1" },
          { id: "endpoint-b", label: "B", baseUrl: "http://b/v1" },
        ],
        activeOpenaiCompatibleEndpointId: "endpoint-b",
      },
    });
    const onResolvedRouteMetadata = vi.fn(async (route) => {
      expect(route.endpointId).toBe("endpoint-a");
      return {};
    });

    await invokeSingleShotChat(
      {
        messages: [{ role: "user", content: "known endpoint" }],
        provider: "openai-compatible",
        model: "local-model",
        endpointId: "endpoint-a",
      },
      {
        projectId: "project-1",
        pathId: "synopsis",
        onResolvedRouteMetadata,
      },
    );
    expect(onResolvedRouteMetadata).toHaveBeenCalledOnce();
    expect(beginMock).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          auditMetadata: expect.objectContaining({
            routeObservation: expect.objectContaining({
              rendererEndpointIdSnapshot: "endpoint-a",
            }),
          }),
        }),
      }),
    );
    expect(invokeMock).toHaveBeenCalledWith(
      "send_chat_message",
      expect.objectContaining({ endpointId: "endpoint-a" }),
    );
  });

  it("rejects an explicit endpoint when the provider does not own it", async () => {
    useAiSettingsStore.setState({
      settings: {
        ...DEFAULT_AI_SETTINGS,
        provider: "anthropic",
        model: "claude-4.6-sonnet",
        openaiCompatible: { baseUrl: "" },
        openaiCompatibleEndpoints: [
          { id: "endpoint-a", label: "A", baseUrl: "http://a/v1" },
        ],
      },
    });

    await expect(
      invokeSingleShotChat(
        {
          messages: [{ role: "user", content: "mismatched endpoint" }],
          provider: "anthropic",
          model: "claude-4.6-sonnet",
          endpointId: "endpoint-a",
        },
        { projectId: "project-1", pathId: "synopsis" },
      ),
    ).rejects.toThrow(/endpoint.*provider|provider.*endpoint/i);
    expect(beginMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
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
