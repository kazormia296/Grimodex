import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  runEventSynthesisTask,
  type ChronicleSynthesisTerminalOutput,
  type EventSynthesisSend,
} from "./runEventSynthesisTask";
import {
  runObservationExtractionTask,
  type ObservationExtractionSend,
} from "./runObservationExtractionTask";
import {
  NARRATIVE_STRUCTURED_REPAIR_PATH,
  runStructuredRepairTask,
  type StructuredRepairSend,
} from "./runStructuredRepairTask";
import { recordAiUsage } from "@/features/ai-usage/recordAiUsage";
import {
  createChildStageExecutionContext,
  createStageExecutionContext,
  NARRATIVE_STAGE_IDS,
} from "@/features/narrative-extraction/reconciler/stageExecution";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { digestStableJson } from "@/features/narrative-extraction/source/digest";
import { CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_VERSION } from "@/features/narrative-extraction/reconciler/chroniclePromptBuilder";
import { checkHypothesisActuality } from "@/features/chronicle/extraction/hypothesisActualityGate";
import {
  contractFollowingSynthesisResponse,
  promptText,
} from "./eventSynthesisContractResponder.testSupport";

const blockPolicyMock = vi.hoisted(() => vi.fn(() => false));
const blockLicenseMock = vi.hoisted(() => vi.fn(() => false));
const beginSkippedAuditMock = vi.hoisted(() =>
  vi.fn(async (input: Record<string, unknown>) => ({
    ...input,
    expectedWorkspacePath: "/workspace",
    operationId: input.operationId ?? "preflight-operation",
    executionId: input.executionId ?? "preflight-execution",
    parentExecutionId: input.parentExecutionId ?? null,
    startedAt: 1,
  })),
);
const skipSkippedAuditMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: blockPolicyMock,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: blockLicenseMock,
}));
vi.mock("@/features/ai-audit/api", () => ({
  beginAiAuditExecution: beginSkippedAuditMock,
  skipAiAuditExecution: skipSkippedAuditMock,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: () => ({
    apiVariant: undefined,
    model: "test-model",
    provider: "test-provider",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "project-test" }),
  },
}));

const usage = { inputTokens: 1, outputTokens: 1 } as const;
const recordAiUsageMock = vi.mocked(recordAiUsage);

function captureRepairSend(responseText: string): {
  readonly send: StructuredRepairSend;
  readonly captured: () => {
    readonly prompt: string;
    readonly options: Parameters<StructuredRepairSend>[1];
  } | null;
} {
  let request: {
    readonly prompt: string;
    readonly options: Parameters<StructuredRepairSend>[1];
  } | null = null;
  return {
    send: async (messages, options) => {
      const content = messages[0]?.content;
      request = {
        prompt: typeof content === "string" ? content : JSON.stringify(content),
        options,
      };
      return { text: responseText, ...usage };
    },
    captured: () => request,
  };
}

function expectDirectRootRepairContract(
  prompt: string,
  expectedShape: string,
): void {
  expect(prompt).toContain(
    "Return the repaired JSON object itself at the root",
  );
  expect(prompt).toContain(
    "Do not wrap it in `repairedJson` or any other wrapper property",
  );
  expect(prompt).not.toContain('{"repairedJson"');
  expect(prompt).toContain(expectedShape);

  const outputSection = prompt.slice(prompt.indexOf("# Output (JSON only)"));
  expect(outputSection).not.toContain('"observations"');
  expect(outputSection).not.toContain('"events"');
}

const observation: RawChronicleEventObservation = {
  localId: "obs-1",
  evidence: [{ sourceRef: "S0001", quote: "門が開いた。" }],
  assertion: { attribution: "narrator", narrativeFrame: "story-world" },
  payload: {
    predicate: "門が開いた",
    actuality: "actual",
    participants: [],
    temporalExpressions: [],
    durationKind: "instant",
  },
};

const repairedObservations = JSON.stringify({
  observations: [observation],
});

const repairedEvents = JSON.stringify({
  clusterRef: "cluster-1",
  resolution: "single-event",
  events: [
    {
      observationRefs: ["obs-1"],
      titleSuggestion: "門が開く",
      summary: "門が開いた",
      actuality: "actual",
      significance: "major",
    },
  ],
});

function eventSynthesisResponse(clusterRef: string): string {
  return JSON.stringify({
    clusterRef,
    resolution: "single-event",
    events: [
      {
        observationRefs: ["obs-1"],
        titleSuggestion: "門が開く",
        summary: "門が開いた",
        actuality: "actual",
        significance: "major",
      },
    ],
  });
}

function createRepairStageExecution(input: {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly stageExecutionId: string;
}) {
  const parent = createStageExecutionContext({
    ...input,
    stageId: NARRATIVE_STAGE_IDS.observationExtraction,
    stageExecutionId: `${input.stageExecutionId}-parent`,
  });
  return createChildStageExecutionContext(
    parent,
    NARRATIVE_STAGE_IDS.structuredRepair,
    input.stageExecutionId,
  );
}

function createEventStageExecution(input: {
  readonly projectId: string;
  readonly runId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly stageExecutionId: string;
}) {
  return createStageExecutionContext({
    ...input,
    stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
  });
}

describe("structured repair root-object contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    blockPolicyMock.mockReturnValue(false);
    blockLicenseMock.mockReturnValue(false);
    beginSkippedAuditMock.mockClear();
    skipSkippedAuditMock.mockClear();
  });

  it("sends the declared direct-root contract through the audited stage seam", async () => {
    const expectedShape = '{"observations":[]}';
    const repair = captureRepairSend(repairedObservations);
    const stageExecution = createRepairStageExecution({
      projectId: "project-test",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      stageExecutionId: "repair-stage-1",
    });

    await expect(
      runStructuredRepairTask({
        brokenText: "not-json",
        expectedShape,
        projectId: "project-test",
        stageExecution,
        responseValidator: () => "parsed",
        send: repair.send,
      }),
    ).resolves.toBe(repairedObservations);

    const captured = repair.captured();
    expect(captured).not.toBeNull();
    expectDirectRootRepairContract(captured?.prompt ?? "", expectedShape);
    expect(captured?.options).toMatchObject({
      projectId: "project-test",
      operationId: "run-1:task-1:attempt-1",
      executionId: "repair-stage-1",
      parentExecutionId: stageExecution.parentStageExecutionId,
      stageExecution,
      metadata: {
        chronicleStage: {
          contextSetDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          componentContractDigest: expect.stringMatching(
            /^sha256:[a-f0-9]{64}$/,
          ),
          finalRequestDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
      },
    });
  });

  it("emits one skipped no-response receipt for policy-blocked supplied stages", async () => {
    blockPolicyMock.mockReturnValue(true);
    const observationStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-preflight-policy",
      taskId: "task-observation",
      attemptId: "attempt-1",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "observation-preflight-policy",
    });
    const eventStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-preflight-policy",
      taskId: "task-event",
      attemptId: "attempt-1",
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      stageExecutionId: "event-preflight-policy",
    });
    const repairStage = createRepairStageExecution({
      projectId: "project-test",
      runId: "run-preflight-policy",
      taskId: "task-repair",
      attemptId: "attempt-1",
      stageExecutionId: "repair-preflight-policy",
    });
    const receipts: unknown[][] = [[], [], []];

    await expect(
      runObservationExtractionTask({
        windows: [{ sourceRef: "S0001", text: "本文" }],
        projectId: "project-test",
        stageExecution: observationStage,
        onStageReceipt: (receipt) => {
          receipts[0]!.push(receipt);
        },
      }),
    ).resolves.toEqual([]);
    await expect(
      runEventSynthesisTask({
        clusterRef: "cluster-1",
        observations: [observation],
        projectId: "project-test",
        stageExecution: eventStage,
        onStageReceipt: (receipt) => {
          receipts[1]!.push(receipt);
        },
      }),
    ).resolves.toEqual([]);
    await expect(
      runStructuredRepairTask({
        brokenText: "not-json",
        expectedShape: '{"observations":[]}',
        projectId: "project-test",
        stageExecution: repairStage,
        responseValidator: () => "invalid",
        onStageReceipt: (receipt) => {
          receipts[2]!.push(receipt);
        },
      }),
    ).resolves.toBeNull();

    for (const [index, stageId] of [
      NARRATIVE_STAGE_IDS.observationExtraction,
      NARRATIVE_STAGE_IDS.eventSynthesis,
      NARRATIVE_STAGE_IDS.structuredRepair,
    ].entries()) {
      expect(receipts[index]).toHaveLength(1);
      expect(receipts[index]?.[0]).toMatchObject({
        responseDigest: null,
        parseStatus: "not-attempted",
        terminalStatus: "skipped",
        stageExecution: { stageId },
        modelExecutionBinding: { resolutionStatus: "unresolved" },
        stageExecutionReceiptDigest: expect.stringMatching(
          /^sha256:[0-9a-f]{64}$/,
        ),
      });
    }
    expect(beginSkippedAuditMock).toHaveBeenCalledTimes(3);
    expect(skipSkippedAuditMock).toHaveBeenCalledTimes(3);
    expect(skipSkippedAuditMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        reason: expect.stringMatching(/preflight-blocked/),
        metadata: expect.objectContaining({
          chronicleStage: expect.objectContaining({
            terminalStatus: "skipped",
            responseDigest: null,
            parseStatus: "not-attempted",
          }),
        }),
      }),
    );
    expect(beginSkippedAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          chronicleStage: expect.not.objectContaining({
            terminalStatus: expect.anything(),
            parseStatus: expect.anything(),
            responseDigest: expect.anything(),
            stageExecutionReceiptDigest: expect.anything(),
          }),
        },
      }),
    );
  });

  it("emits one skipped no-response receipt for license-blocked supplied stages", async () => {
    blockLicenseMock.mockReturnValue(true);
    const stages = [
      createStageExecutionContext({
        projectId: "project-test",
        runId: "run-preflight-license",
        taskId: "task-observation",
        attemptId: "attempt-1",
        stageId: NARRATIVE_STAGE_IDS.observationExtraction,
        stageExecutionId: "observation-preflight-license",
      }),
      createStageExecutionContext({
        projectId: "project-test",
        runId: "run-preflight-license",
        taskId: "task-event",
        attemptId: "attempt-1",
        stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
        stageExecutionId: "event-preflight-license",
      }),
      createRepairStageExecution({
        projectId: "project-test",
        runId: "run-preflight-license",
        taskId: "task-repair",
        attemptId: "attempt-1",
        stageExecutionId: "repair-preflight-license",
      }),
    ];
    const receipts: unknown[][] = [[], [], []];
    await runObservationExtractionTask({
      windows: [{ sourceRef: "S0001", text: "本文" }],
      projectId: "project-test",
      stageExecution: stages[0],
      onStageReceipt: (receipt) => {
        receipts[0]!.push(receipt);
      },
    });
    await runEventSynthesisTask({
      clusterRef: "cluster-1",
      observations: [observation],
      projectId: "project-test",
      stageExecution: stages[1],
      onStageReceipt: (receipt) => {
        receipts[1]!.push(receipt);
      },
    });
    await runStructuredRepairTask({
      brokenText: "not-json",
      expectedShape: '{"observations":[]}',
      projectId: "project-test",
      stageExecution: stages[2],
      responseValidator: () => "invalid",
      onStageReceipt: (receipt) => {
        receipts[2]!.push(receipt);
      },
    });
    expect(receipts.map((value) => value)).toHaveLength(3);
    expect(receipts.flat()).toHaveLength(3);
    expect(receipts.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          responseDigest: null,
          parseStatus: "not-attempted",
          terminalStatus: "skipped",
        }),
      ]),
    );
    expect(beginSkippedAuditMock).toHaveBeenCalledTimes(3);
    expect(skipSkippedAuditMock).toHaveBeenCalledTimes(3);
  });

  it("uses skipped receipts for empty supplied executions without dispatch", async () => {
    const observationStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-preflight-empty",
      taskId: "task-observation",
      attemptId: "attempt-1",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "observation-preflight-empty",
    });
    const eventStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-preflight-empty",
      taskId: "task-event",
      attemptId: "attempt-1",
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      stageExecutionId: "event-preflight-empty",
    });
    const repairStage = createRepairStageExecution({
      projectId: "project-test",
      runId: "run-preflight-empty",
      taskId: "task-repair",
      attemptId: "attempt-1",
      stageExecutionId: "repair-preflight-empty",
    });
    const receipts: unknown[] = [];
    await runObservationExtractionTask({
      windows: [],
      projectId: "project-test",
      stageExecution: observationStage,
      onStageReceipt: (receipt) => {
        receipts.push(receipt);
      },
    });
    await runEventSynthesisTask({
      clusterRef: "cluster-empty",
      observations: [],
      projectId: "project-test",
      stageExecution: eventStage,
      onStageReceipt: (receipt) => {
        receipts.push(receipt);
      },
    });
    await runStructuredRepairTask({
      brokenText: "",
      expectedShape: '{"observations":[]}',
      projectId: "project-test",
      stageExecution: repairStage,
      responseValidator: () => "invalid",
      onStageReceipt: (receipt) => {
        receipts.push(receipt);
      },
    });
    expect(receipts).toHaveLength(3);
    expect(receipts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          responseDigest: null,
          parseStatus: "not-attempted",
          terminalStatus: "skipped",
        }),
      ]),
    );
    expect(beginSkippedAuditMock).toHaveBeenCalledTimes(3);
    expect(skipSkippedAuditMock).toHaveBeenCalledTimes(3);
  });

  it("does not publish a skipped receipt when durable preflight closure fails", async () => {
    blockPolicyMock.mockReturnValue(true);
    skipSkippedAuditMock.mockRejectedValueOnce(
      new Error("preflight terminal append failed"),
    );
    const stageExecution = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-preflight-persist-failure",
      taskId: "task-observation",
      attemptId: "attempt-1",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "observation-preflight-persist-failure",
    });
    const receipts: unknown[] = [];

    await expect(
      runObservationExtractionTask({
        windows: [{ sourceRef: "S0001", text: "本文" }],
        projectId: "project-test",
        stageExecution,
        onStageReceipt: (receipt) => {
          receipts.push(receipt);
        },
      }),
    ).rejects.toThrow("preflight terminal append failed");
    expect(beginSkippedAuditMock).toHaveBeenCalledOnce();
    expect(skipSkippedAuditMock).toHaveBeenCalledOnce();
    expect(receipts).toEqual([]);
  });

  it("validates stage identity before policy and empty-input preflight", async () => {
    blockPolicyMock.mockReturnValue(true);
    const wrongObservationStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-preflight-wrong",
      taskId: "task-observation",
      attemptId: "attempt-1",
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      stageExecutionId: "observation-preflight-wrong",
    });
    const wrongEventStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-preflight-wrong",
      taskId: "task-event",
      attemptId: "attempt-1",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "event-preflight-wrong",
    });
    const wrongRepairStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-preflight-wrong",
      taskId: "task-repair",
      attemptId: "attempt-1",
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      stageExecutionId: "repair-preflight-wrong",
    });
    await expect(
      runObservationExtractionTask({
        windows: [],
        projectId: "project-test",
        stageExecution: wrongObservationStage,
      }),
    ).rejects.toThrow(/stageId/);
    await expect(
      runEventSynthesisTask({
        clusterRef: "cluster-wrong",
        observations: [],
        projectId: "project-test",
        stageExecution: wrongEventStage,
      }),
    ).rejects.toThrow(/stageId/);
    await expect(
      runStructuredRepairTask({
        brokenText: "",
        expectedShape: '{"observations":[]}',
        projectId: "project-test",
        stageExecution: wrongRepairStage,
        responseValidator: () => "invalid",
      }),
    ).rejects.toThrow(/stageId/);
    expect(beginSkippedAuditMock).not.toHaveBeenCalled();
    expect(skipSkippedAuditMock).not.toHaveBeenCalled();
  });

  it("fails closed before dispatch when a Chronicle stage omits its schema validator", async () => {
    const repair = captureRepairSend(repairedObservations);
    const stageExecution = createRepairStageExecution({
      projectId: "project-test",
      runId: "run-missing-validator",
      taskId: "task-missing-validator",
      attemptId: "attempt-missing-validator",
      stageExecutionId: "repair-stage-missing-validator",
    });

    await expect(
      runStructuredRepairTask({
        brokenText: "not-json",
        expectedShape: '{"observations":[]}',
        projectId: "project-test",
        stageExecution,
        send: repair.send,
      }),
    ).rejects.toThrow(/responseValidator/);
    expect(repair.captured()).toBeNull();
  });

  it("captures one transport terminal receipt and reuses it for the usage mirror", async () => {
    const expectedShape = '{"observations":[]}';
    const stageExecution = createRepairStageExecution({
      projectId: "project-test",
      runId: "run-exact-once",
      taskId: "task-exact-once",
      attemptId: "attempt-exact-once",
      stageExecutionId: "repair-stage-exact-once",
    });
    const receipts: unknown[] = [];
    let transportTerminal: unknown;
    const send: StructuredRepairSend = async (_messages, options) => {
      transportTerminal =
        await options.onTerminalMetadata?.(repairedObservations);
      return { text: repairedObservations, ...usage };
    };

    recordAiUsageMock.mockClear();
    await expect(
      runStructuredRepairTask({
        brokenText: "not-json",
        expectedShape,
        projectId: "project-test",
        stageExecution,
        responseValidator: () => "parsed",
        send,
        onStageReceipt: (receipt) => {
          receipts.push(receipt);
        },
      }),
    ).resolves.toBe(repairedObservations);

    expect(receipts).toHaveLength(1);
    const mirror = recordAiUsageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload.surface === NARRATIVE_STRUCTURED_REPAIR_PATH);
    expect(mirror).toMatchObject({
      metadata: {
        chronicleStageAudit: {
          stageExecutionReceiptDigest: expect.stringMatching(
            /^sha256:[0-9a-f]{64}$/,
          ),
        },
      },
    });
    expect(
      (mirror?.metadata as Record<string, unknown> | undefined)
        ?.chronicleStageAudit,
    ).toMatchObject({
      stageExecutionReceiptDigest: (
        (transportTerminal as Record<string, unknown>)
          ?.chronicleStage as Record<string, unknown>
      )?.stageExecutionReceiptDigest,
    });
  });

  it.each([
    {
      label: "empty object",
      responseText: "{}",
      expectedStatus: "invalid",
      expectedResult: null,
    },
    {
      label: "legacy wrapper",
      responseText: '{"repairedJson":{"observations":[]}}',
      expectedStatus: "invalid",
      expectedResult: null,
    },
    {
      label: "schema-invalid direct root",
      responseText: '{"observations":[{}]}',
      expectedStatus: "invalid",
      expectedResult: null,
    },
    {
      label: "valid direct root",
      responseText: repairedObservations,
      expectedStatus: "parsed",
      expectedResult: repairedObservations,
    },
  ] as const)(
    "binds $label to the caller validator, terminal metadata, usage audit, and return value",
    async ({ responseText, expectedStatus, expectedResult }) => {
      const repair = captureRepairSend(responseText);
      const responseValidator = vi.fn(
        (candidate: string): "parsed" | "invalid" =>
          candidate === repairedObservations ? "parsed" : "invalid",
      );
      const stageExecution = createRepairStageExecution({
        projectId: "project-test",
        runId: `run-${expectedStatus}-${responseText.length}`,
        taskId: "task-repair-contract",
        attemptId: "attempt-repair-contract",
        stageExecutionId: `repair-stage-${expectedStatus}-${responseText.length}`,
      });

      recordAiUsageMock.mockClear();
      await expect(
        runStructuredRepairTask({
          brokenText: "not-json",
          expectedShape: '{"observations":[]}',
          projectId: "project-test",
          stageExecution,
          responseValidator,
          send: repair.send,
        }),
      ).resolves.toBe(expectedResult);
      expect(responseValidator).toHaveBeenCalledWith(responseText);

      const captured = repair.captured();
      expect(captured).not.toBeNull();
      const terminalMetadata =
        await captured?.options.onTerminalMetadata?.(responseText);
      expect(terminalMetadata).toMatchObject({
        chronicleStage: {
          parseStatus: expectedStatus,
          terminalStatus: expectedStatus === "parsed" ? "succeeded" : "failed",
        },
      });

      const childAudit = recordAiUsageMock.mock.calls
        .map(([payload]) => payload)
        .find(
          (payload) => payload.surface === NARRATIVE_STRUCTURED_REPAIR_PATH,
        );
      expect(childAudit).toMatchObject({
        surface: NARRATIVE_STRUCTURED_REPAIR_PATH,
        metadata: {
          chronicleStageAudit: {
            parseStatus: expectedStatus,
            terminalStatus:
              expectedStatus === "parsed" ? "succeeded" : "failed",
          },
        },
      });
    },
  );

  it("preserves the legacy no-stage prompt and returns its root JSON unchanged", async () => {
    const expectedShape = '{"events":[]}';
    const repair = captureRepairSend(repairedEvents);

    await expect(
      runStructuredRepairTask({
        brokenText: "not-json",
        expectedShape,
        projectId: "project-test",
        send: repair.send,
      }),
    ).resolves.toBe(repairedEvents);

    const captured = repair.captured();
    expect(captured?.prompt).toContain("# 期待する形");
    expect(captured?.prompt).toContain(expectedShape);
    expect(captured?.prompt).not.toContain('{"repairedJson"');
    expect(captured?.options).not.toHaveProperty("operationId");
  });

  it("keeps repaired observation output at the caller's root schema", async () => {
    const expectedShape =
      '{"observations":[{"localId":"string","evidence":[{"sourceRef":"S0001","quote":"string"}],"assertion":{"attribution":"narrator","narrativeFrame":"story-world"},"payload":{"predicate":"string","actuality":"actual","participants":[],"temporalExpressions":[],"durationKind":"instant"}}]}';
    const repair = captureRepairSend(repairedObservations);
    const parentStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-observation",
      taskId: "task-observation",
      attemptId: "attempt-observation",
      stageId: NARRATIVE_STAGE_IDS.observationExtraction,
      stageExecutionId: "observation-stage-1",
    });
    const send: ObservationExtractionSend = async () => ({
      text: "not-json",
      ...usage,
    });

    const result = await runObservationExtractionTask({
      windows: [{ sourceRef: "S0001", text: "門が開いた。" }],
      projectId: "project-test",
      stageExecution: parentStage,
      send,
      createStageExecutionId: () => "repair-stage-observation",
      repairSend: repair.send,
    });

    expect(result).toEqual([observation]);
    const captured = repair.captured();
    expect(captured).not.toBeNull();
    expectDirectRootRepairContract(captured?.prompt ?? "", expectedShape);
    expect(captured?.options).toMatchObject({
      operationId: "run-observation:task-observation:attempt-observation",
      executionId: "repair-stage-observation",
      parentExecutionId: "observation-stage-1",
      stageExecution: {
        stageId: NARRATIVE_STAGE_IDS.structuredRepair,
        parentStageExecutionId: "observation-stage-1",
      },
    });
  });

  it.each([
    ["empty object", "{}"],
    ["legacy wrapper", '{"repairedJson":{"observations":[]}}'],
    ["schema-invalid direct root", '{"observations":[{}]}'],
  ] as const)(
    "returns no observations and audits a failed child for %s repair output",
    async (_label, responseText) => {
      const repair = captureRepairSend(responseText);
      const parentStage = createStageExecutionContext({
        projectId: "project-test",
        runId: "run-observation-invalid",
        taskId: "task-observation-invalid",
        attemptId: "attempt-observation-invalid",
        stageId: NARRATIVE_STAGE_IDS.observationExtraction,
        stageExecutionId: "observation-stage-invalid",
      });
      const send: ObservationExtractionSend = async () => ({
        text: "not-json",
        ...usage,
      });

      recordAiUsageMock.mockClear();
      const result = await runObservationExtractionTask({
        windows: [{ sourceRef: "S0001", text: "門が開いた。" }],
        projectId: "project-test",
        stageExecution: parentStage,
        send,
        createStageExecutionId: () => "repair-stage-observation-invalid",
        repairSend: repair.send,
      });

      expect(result).toEqual([]);
      const childAudit = recordAiUsageMock.mock.calls
        .map(([payload]) => payload)
        .find(
          (payload) => payload.surface === NARRATIVE_STRUCTURED_REPAIR_PATH,
        );
      expect(childAudit).toMatchObject({
        metadata: {
          chronicleStageAudit: {
            parseStatus: "invalid",
            terminalStatus: "failed",
          },
        },
      });
    },
  );

  it("keeps repaired event output at the caller's root schema", async () => {
    const expectedShape = `{"clusterRef":"cluster-1","resolution":"single-event","events":[{"observationRefs":["obs-1"],"titleSuggestion":"t","summary":"s","actuality":"actual","significance":"major"}]}
clusterRef は "cluster-1" をそのまま使い、event-cluster: などの接頭辞を付けないでください。
使える localId はこの cluster の ["obs-1"] だけです。events[].observationRefs は、壊れた出力の値がそのどれかと一致するなら一字一句そのまま保ち（短縮・正規化をしない）、一致しない値（event-observation: などの余分な接頭辞付き）は、同じ Observation を指す localId に直してください。例の値は形の見本で、event ごとの値は壊れた出力から取ります。
events[].significance は "major"、"scene-level"、"minor"、"incidental" のいずれかです。それ以外の値（"moderate" など）は event を除かず、判断が付かなければ "minor" に直してください。
events[].actuality は "actual"、"attempted"、"prevented"、"rumored" のいずれかです。それ以外の actuality の event は、4 種類のどれかへ書き換えず events から除いてください。
events が空になる場合: {"clusterRef":"cluster-1","resolution":"unresolved","events":[]}`;
    const repair = captureRepairSend(repairedEvents);
    const parentStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-event",
      taskId: "task-event",
      attemptId: "attempt-event",
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      stageExecutionId: "event-stage-1",
    });
    const send = async () => ({ text: "not-json", ...usage });

    const result = await runEventSynthesisTask({
      clusterRef: "cluster-1",
      observations: [observation],
      projectId: "project-test",
      stageExecution: parentStage,
      send,
      createStageExecutionId: () => "repair-stage-event",
      repairSend: repair.send,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      clusterRef: "cluster-1",
      observationRefs: ["obs-1"],
      titleSuggestion: "門が開く",
    });
    const captured = repair.captured();
    expect(captured).not.toBeNull();
    expectDirectRootRepairContract(captured?.prompt ?? "", expectedShape);
    expect(captured?.options).toMatchObject({
      operationId: "run-event:task-event:attempt-event",
      executionId: "repair-stage-event",
      parentExecutionId: "event-stage-1",
      stageExecution: {
        stageId: NARRATIVE_STAGE_IDS.structuredRepair,
        parentStageExecutionId: "event-stage-1",
      },
    });
  });

  it("emits the shared C1 terminal-output matrix for root, repair, and deterministic-empty paths", async () => {
    const terminalOutputs: ChronicleSynthesisTerminalOutput[] = [];
    const rootStage = createEventStageExecution({
      projectId: "project-test",
      runId: "run-terminal-root",
      taskId: "task-terminal-root",
      attemptId: "attempt-terminal-root",
      stageExecutionId: "event-terminal-root",
    });
    const repairRootStage = createEventStageExecution({
      projectId: "project-test",
      runId: "run-terminal-repair",
      taskId: "task-terminal-repair",
      attemptId: "attempt-terminal-repair",
      stageExecutionId: "event-terminal-repair-root",
    });
    const emptyStage = createEventStageExecution({
      projectId: "project-test",
      runId: "run-terminal-empty",
      taskId: "task-terminal-empty",
      attemptId: "attempt-terminal-empty",
      stageExecutionId: "event-terminal-empty",
    });

    await runEventSynthesisTask({
      clusterRef: "cluster-root",
      observations: [observation],
      projectId: "project-test",
      stageExecution: rootStage,
      send: async () => ({
        text: eventSynthesisResponse("cluster-root"),
        ...usage,
      }),
      repairOnFailure: false,
      onTerminalOutput: (output) => {
        terminalOutputs.push(output);
      },
    });
    await runEventSynthesisTask({
      clusterRef: "cluster-repair",
      observations: [observation],
      projectId: "project-test",
      stageExecution: repairRootStage,
      send: async () => ({ text: "not-json", ...usage }),
      repairSend: captureRepairSend(eventSynthesisResponse("cluster-repair"))
        .send,
      createStageExecutionId: () => "event-terminal-repair-child",
      onTerminalOutput: (output) => {
        terminalOutputs.push(output);
      },
    });
    await runEventSynthesisTask({
      clusterRef: "cluster-empty",
      observations: [],
      projectId: "project-test",
      stageExecution: emptyStage,
      onTerminalOutput: (output) => {
        terminalOutputs.push(output);
      },
    });

    expect(
      terminalOutputs.map((output) => ({
        disposition: output.disposition,
        root: output.rootStageExecution.stageExecutionId,
        terminal: output.terminalStageExecution.stageExecutionId,
        eventCount: output.hypotheses.length,
      })),
    ).toEqual([
      {
        disposition: "root-success",
        root: "event-terminal-root",
        terminal: "event-terminal-root",
        eventCount: 1,
      },
      {
        disposition: "repair-success",
        root: "event-terminal-repair-root",
        terminal: "event-terminal-repair-child",
        eventCount: 1,
      },
      {
        disposition: "deterministic-empty",
        root: "event-terminal-empty",
        terminal: "event-terminal-empty",
        eventCount: 0,
      },
    ]);
    expect(terminalOutputs[1]?.terminalStageExecution).toMatchObject({
      parentStageExecutionId: "event-terminal-repair-root",
    });
    expect(terminalOutputs[2]).toMatchObject({
      rawObservations: [],
      hypotheses: [],
      eventOutput: {
        clusterRef: "cluster-empty",
        resolution: "no-events",
        events: [],
      },
    });

    const rootOutput = terminalOutputs[0];
    expect(rootOutput).toBeDefined();
    if (!rootOutput) return;
    expect(rootOutput.parsedOutputDigest).toBe(
      await digestStableJson({
        domain: "chronicle.parsed-output/1",
        kind: "chronicle.event-synthesis-output@1",
        observationCount: 1,
        eventCount: 1,
        observationRefs: ["obs-1"],
        rawObservationsDigest: rootOutput.rawObservationsDigest,
        eventOutputDigest: await digestStableJson(rootOutput.eventOutput),
      }),
    );
  });

  it("returns no events and audits a failed child for a wrapper repair output", async () => {
    const repair = captureRepairSend(
      '{"repairedJson":{"clusterRef":"cluster-1","events":[]}}',
    );
    const parentStage = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-event-invalid",
      taskId: "task-event-invalid",
      attemptId: "attempt-event-invalid",
      stageId: NARRATIVE_STAGE_IDS.eventSynthesis,
      stageExecutionId: "event-stage-invalid",
    });
    const send = async () => ({ text: "not-json", ...usage });

    recordAiUsageMock.mockClear();
    const result = await runEventSynthesisTask({
      clusterRef: "cluster-1",
      observations: [observation],
      projectId: "project-test",
      stageExecution: parentStage,
      send,
      createStageExecutionId: () => "repair-stage-event-invalid",
      repairSend: repair.send,
    });

    expect(result).toEqual([]);
    const childAudit = recordAiUsageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload.surface === NARRATIVE_STRUCTURED_REPAIR_PATH);
    expect(childAudit).toMatchObject({
      metadata: {
        chronicleStageAudit: {
          parseStatus: "invalid",
          terminalStatus: "failed",
        },
      },
    });
  });

  it("repairs a valid JSON response whose clusterRef does not echo the input", async () => {
    const clusterRef = "cluster-42";
    const repair = captureRepairSend(eventSynthesisResponse("cluster-ref"));
    const statuses: Array<"parsed" | "invalid"> = [];
    const send: EventSynthesisSend = async () => ({
      text: eventSynthesisResponse("cluster-ref"),
      ...usage,
    });

    const result = await runEventSynthesisTask({
      clusterRef,
      observations: [observation],
      projectId: "project-test",
      send,
      repairSend: repair.send,
      createId: () => "hypothesis-42",
      onParseStatus: (status) => {
        statuses.push(status);
      },
    });

    expect(result).toEqual([]);
    expect(statuses).toEqual(["invalid"]);
    expect(repair.captured()).not.toBeNull();
    expect(repair.captured()?.prompt).toContain(
      `{"clusterRef":"${clusterRef}"`,
    );
  });

  it("renders and accepts the exact input clusterRef in the event contract", async () => {
    const clusterRef = "cluster-42";
    let prompt = "";
    const statuses: Array<"parsed" | "invalid"> = [];
    const send: EventSynthesisSend = async (messages) => {
      const content = messages[0]?.content;
      prompt = typeof content === "string" ? content : JSON.stringify(content);
      return {
        text: eventSynthesisResponse(clusterRef),
        ...usage,
      };
    };

    const result = await runEventSynthesisTask({
      clusterRef,
      observations: [observation],
      projectId: "project-test",
      send,
      repairOnFailure: false,
      createId: () => "hypothesis-42",
      onParseStatus: (status) => {
        statuses.push(status);
      },
    });

    expect(result).toMatchObject([
      {
        hypothesisId: "hypothesis-42",
        clusterRef,
        observationRefs: ["obs-1"],
      },
    ]);
    expect(statuses).toEqual(["parsed"]);
    expect(prompt).toContain(
      `--- contextId=event-cluster:${clusterRef} inputRef=cluster:${clusterRef} ---\n${clusterRef}`,
    );
    expect(prompt).toContain(
      "event-cluster: や cluster: を追加せず、出力例のプレースホルダーを値としてコピーしないでください。",
    );
    expect(prompt).toContain('"clusterRef":"<cluster-ref-from-context>"');
  });

  it("keeps the static event component contract digest across cluster refs", async () => {
    const componentContractDigests: string[] = [];
    const contextSetDigests: string[] = [];

    for (const [index, clusterRef] of ["cluster-42", "cluster-43"].entries()) {
      recordAiUsageMock.mockClear();
      const stageExecution = createEventStageExecution({
        projectId: "project-test",
        runId: `run-event-digest-${index}`,
        taskId: "task-event-digest",
        attemptId: "attempt-event-digest",
        stageExecutionId: `event-stage-digest-${index}`,
      });
      const send: EventSynthesisSend = async () => ({
        text: eventSynthesisResponse(clusterRef),
        ...usage,
      });

      await expect(
        runEventSynthesisTask({
          clusterRef,
          observations: [observation],
          projectId: "project-test",
          stageExecution,
          send,
          repairOnFailure: false,
        }),
      ).resolves.toHaveLength(1);

      const audit = recordAiUsageMock.mock.calls
        .map(([payload]) => payload)
        .find((payload) => payload.surface === "narrative_event_synthesize");
      const stageAudit = (
        audit?.metadata as
          | {
              readonly chronicleStageAudit?: {
                readonly componentContractDigest?: string;
                readonly contextSetDigest?: string;
              };
            }
          | undefined
      )?.chronicleStageAudit;
      expect(stageAudit).toBeDefined();
      componentContractDigests.push(stageAudit?.componentContractDigest ?? "");
      contextSetDigests.push(stageAudit?.contextSetDigest ?? "");
    }

    expect(componentContractDigests[0]).toBe(componentContractDigests[1]);
    expect(contextSetDigests[0]).not.toBe(contextSetDigests[1]);
  });

  it("seals the canonical typed parsed-output digest in the event audit", async () => {
    const stageExecution = createEventStageExecution({
      projectId: "project-test",
      runId: "run-event-output-digest",
      taskId: "task-event-output-digest",
      attemptId: "attempt-event-output-digest",
      stageExecutionId: "event-stage-output-digest",
    });
    recordAiUsageMock.mockClear();

    await expect(
      runEventSynthesisTask({
        clusterRef: "cluster-1",
        observations: [observation],
        projectId: "project-test",
        stageExecution,
        send: async () => ({
          text: eventSynthesisResponse("cluster-1"),
          ...usage,
        }),
        repairOnFailure: false,
      }),
    ).resolves.toHaveLength(1);

    const audit = recordAiUsageMock.mock.calls
      .map(([payload]) => payload)
      .find((payload) => payload.surface === "narrative_event_synthesize");
    const stageAudit = (
      audit?.metadata as
        | {
            readonly chronicleStageAudit?: {
              readonly rawObservationsDigest?: string;
              readonly parsedOutputDigest?: string;
            };
          }
        | undefined
    )?.chronicleStageAudit;
    const rawObservationsDigest = await digestStableJson({
      kind: "chronicle.raw-observations@1",
      version: 1,
      observations: [observation],
    });
    const eventOutput = {
      clusterRef: "cluster-1",
      resolution: "single-event",
      events: [
        {
          observationRefs: ["obs-1"],
          titleSuggestion: "門が開く",
          summary: "門が開いた",
          actuality: "actual",
          significance: "major",
        },
      ],
    };
    const parsedOutputDigest = await digestStableJson({
      domain: "chronicle.parsed-output/1",
      kind: "chronicle.event-synthesis-output@1",
      observationCount: 1,
      eventCount: 1,
      observationRefs: ["obs-1"],
      rawObservationsDigest,
      eventOutputDigest: await digestStableJson(eventOutput),
    });
    expect(stageAudit).toMatchObject({
      rawObservationsDigest,
      parsedOutputDigest,
    });
  });
});

describe("event synthesis actuality contract (component contract 3 wording, kept in 4)", () => {
  const hypotheticalObservation: RawChronicleEventObservation = {
    localId: "obs-h",
    evidence: [
      {
        sourceRef: "S0001",
        quote: "もし西の堤防が切れれば、下町は水に沈むだろう",
      },
    ],
    assertion: {
      attribution: "character:技師",
      narrativeFrame: "hypothetical",
    },
    payload: {
      predicate: "下町が水に沈む",
      actuality: "hypothetical",
      participants: [],
      temporalExpressions: [],
      durationKind: "unknown",
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    blockPolicyMock.mockReturnValue(false);
    blockLicenseMock.mockReturnValue(false);
  });

  function contractSend(
    observations: readonly RawChronicleEventObservation[],
    prompts: string[],
  ): EventSynthesisSend {
    return async (messages) => {
      const prompt = promptText(messages);
      prompts.push(prompt);
      return {
        text: contractFollowingSynthesisResponse({
          prompt,
          clusterRef: "cluster-h",
          observations,
        }),
        ...usage,
      };
    };
  }

  function contractRepairSend(
    observations: readonly RawChronicleEventObservation[],
    prompts: string[],
  ): StructuredRepairSend {
    return async (messages) => {
      const prompt = promptText(messages);
      prompts.push(prompt);
      return {
        text: contractFollowingSynthesisResponse({
          prompt,
          clusterRef: "cluster-h",
          observations,
        }),
        ...usage,
      };
    };
  }

  it("lists only the four Chronicle actualities and gives the unresolved empty exit", async () => {
    const prompts: string[] = [];
    await runEventSynthesisTask({
      clusterRef: "cluster-h",
      observations: [hypotheticalObservation],
      projectId: "project-test",
      send: contractSend([hypotheticalObservation], prompts),
      repairOnFailure: false,
    });

    const prompt = prompts[0] ?? "";
    expect(prompt).toContain(
      'events[].actuality に使えるのは "actual"、"attempted"、"prevented"、"rumored" の 4 種類だけです。',
    );
    expect(prompt).toContain("4 種類のどれかへ書き換えず");
    expect(prompt).toContain('"unknown"');
    expect(prompt).toContain(
      '{"clusterRef":"<cluster-ref-from-context>","resolution":"unresolved","events":[]}',
    );
  });

  it("returns a root-success unresolved terminal for a hypothetical-only cluster", async () => {
    const prompts: string[] = [];
    const repairPrompts: string[] = [];
    const terminalOutputs: ChronicleSynthesisTerminalOutput[] = [];
    const result = await runEventSynthesisTask({
      clusterRef: "cluster-h",
      observations: [hypotheticalObservation],
      projectId: "project-test",
      stageExecution: createEventStageExecution({
        projectId: "project-test",
        runId: "run-hypothetical",
        taskId: "task-hypothetical",
        attemptId: "attempt-hypothetical",
        stageExecutionId: "event-hypothetical",
      }),
      send: contractSend([hypotheticalObservation], prompts),
      repairSend: contractRepairSend([hypotheticalObservation], repairPrompts),
      createStageExecutionId: () => "repair-hypothetical",
      onTerminalOutput: (output) => {
        terminalOutputs.push(output);
      },
    });

    expect(result).toEqual([]);
    expect(repairPrompts).toEqual([]);
    expect(terminalOutputs).toHaveLength(1);
    expect(terminalOutputs[0]).toMatchObject({
      disposition: "root-success",
      clusterRef: "cluster-h",
      hypotheses: [],
      eventOutput: {
        clusterRef: "cluster-h",
        resolution: "unresolved",
        events: [],
      },
    });
  });

  it("repairs a hypothetical event into the unresolved empty terminal without promoting it", async () => {
    const repairPrompts: string[] = [];
    const terminalOutputs: ChronicleSynthesisTerminalOutput[] = [];
    const result = await runEventSynthesisTask({
      clusterRef: "cluster-h",
      observations: [hypotheticalObservation],
      projectId: "project-test",
      stageExecution: createEventStageExecution({
        projectId: "project-test",
        runId: "run-hypothetical-repair",
        taskId: "task-hypothetical-repair",
        attemptId: "attempt-hypothetical-repair",
        stageExecutionId: "event-hypothetical-repair",
      }),
      // The root ignores the contract and echoes the hypothetical actuality.
      send: async () => ({
        text: JSON.stringify({
          clusterRef: "cluster-h",
          resolution: "single-event",
          events: [
            {
              observationRefs: ["obs-h"],
              titleSuggestion: "下町が水に沈む",
              summary: "下町が水に沈む",
              actuality: "hypothetical",
              significance: "major",
            },
          ],
        }),
        ...usage,
      }),
      repairSend: contractRepairSend([hypotheticalObservation], repairPrompts),
      createStageExecutionId: () => "repair-hypothetical-child",
      onTerminalOutput: (output) => {
        terminalOutputs.push(output);
      },
    });

    expect(result).toEqual([]);
    // 振る舞い（修復が unresolved／[] の終端で成功する）を先に見る。prompt の文字列は後で補助的に見る。
    expect(terminalOutputs).toHaveLength(1);
    expect(terminalOutputs[0]).toMatchObject({
      disposition: "repair-success",
      hypotheses: [],
      eventOutput: { resolution: "unresolved", events: [] },
    });
    expect(repairPrompts).toHaveLength(1);
    expect(repairPrompts[0]).toContain(
      '{"clusterRef":"cluster-h","resolution":"unresolved","events":[]}',
    );
    expect(repairPrompts[0]).toContain(
      '"actual"、"attempted"、"prevented"、"rumored"',
    );
  });

  it("builds a mixed cluster event only from the Chronicle-actuality observations", async () => {
    const mixed = [observation, hypotheticalObservation];
    const prompts: string[] = [];
    const terminalOutputs: ChronicleSynthesisTerminalOutput[] = [];
    const result = await runEventSynthesisTask({
      clusterRef: "cluster-h",
      observations: mixed,
      projectId: "project-test",
      stageExecution: createEventStageExecution({
        projectId: "project-test",
        runId: "run-mixed",
        taskId: "task-mixed",
        attemptId: "attempt-mixed",
        stageExecutionId: "event-mixed",
      }),
      send: contractSend(mixed, prompts),
      repairOnFailure: false,
      onTerminalOutput: (output) => {
        terminalOutputs.push(output);
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      observationRefs: ["obs-1"],
      actuality: "actual",
    });
    expect(checkHypothesisActuality(result[0]!, mixed)).toEqual({ ok: true });
    expect(terminalOutputs[0]).toMatchObject({
      disposition: "root-success",
      eventOutput: { resolution: "single-event" },
    });
  });

  it("leaves a promoted hypothetical event to the actuality gate, which rejects it", async () => {
    const result = await runEventSynthesisTask({
      clusterRef: "cluster-h",
      observations: [hypotheticalObservation],
      projectId: "project-test",
      send: async () => ({
        text: JSON.stringify({
          clusterRef: "cluster-h",
          resolution: "single-event",
          events: [
            {
              observationRefs: ["obs-h"],
              titleSuggestion: "下町が水に沈む",
              summary: "下町が水に沈む",
              actuality: "actual",
              significance: "major",
            },
          ],
        }),
        ...usage,
      }),
      repairOnFailure: false,
    });

    expect(result).toHaveLength(1);
    expect(
      checkHypothesisActuality(result[0]!, [hypotheticalObservation]),
    ).toEqual({
      ok: false,
      reason: "hypothesis-observation-actuality-mismatch",
    });
  });
});

describe("event synthesis reference and enum clarity (component contract 4)", () => {
  // Shapes taken from the 2026-11-04 claude-sonnet-5-5 evaluation (PD novels,
  // quotes shortened): the model copied the contextId heading as clusterRef,
  // answered significance "moderate", and the repair shortened the localIds.
  const windowObservation: RawChronicleEventObservation = {
    localId: "window-001:obs-009",
    evidence: [{ sourceRef: "S0009", quote: "全身すっかり緑色に変わっていた" }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      predicate: "河童の体色が変わる",
      actuality: "actual",
      participants: [],
      temporalExpressions: [],
      durationKind: "instant",
    },
  };
  const clusterRef = "cluster-0009";

  function response(overrides: {
    readonly clusterRef?: string;
    readonly observationRefs?: readonly string[];
    readonly significance?: string;
  }): string {
    return JSON.stringify({
      clusterRef: overrides.clusterRef ?? clusterRef,
      resolution: "single-event",
      events: [
        {
          observationRefs: overrides.observationRefs ?? [
            windowObservation.localId,
          ],
          titleSuggestion: "河童の体色の変化に気づく",
          summary: "河童の体が緑色に変わっていることに気づく。",
          actuality: "actual",
          significance: overrides.significance ?? "minor",
        },
      ],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    blockPolicyMock.mockReturnValue(false);
  });

  it("tells the model to use the body cluster value, not the heading, and lists the four significances", async () => {
    const prompts: string[] = [];
    await runEventSynthesisTask({
      clusterRef,
      observations: [windowObservation],
      projectId: "project-test",
      send: async (messages) => {
        prompts.push(promptText(messages));
        return { text: response({}), ...usage };
      },
      repairOnFailure: false,
    });

    expect(CHRONICLE_EVENT_SYNTHESIS_COMPONENT_CONTRACT_VERSION).toBe("4");
    const prompt = prompts[0] ?? "";
    const [instruction, rest] = prompt.split(
      "# Context Set (chronicle.prompt/1)",
    );
    // The heading the model sees is still contextId=event-cluster:<value>.
    expect(rest).toContain(
      `--- contextId=event-cluster:${clusterRef} inputRef=cluster:${clusterRef} ---\n${clusterRef}`,
    );
    expect(instruction).toContain(
      "event-cluster の見出し行（contextId=event-cluster:X）の下に書かれた本文の値 X",
    );
    expect(instruction).toContain(
      "event-cluster: や cluster: を追加せず、出力例のプレースホルダーを値としてコピーしないでください。",
    );
    expect(instruction).toContain(
      'events[].significance に使えるのは "major"、"scene-level"、"minor"、"incidental" の 4 種類だけです。',
    );
    // The output example no longer carries the "event-cluster" word.
    const shape = rest!.split("# Output (JSON only)")[1]!;
    expect(shape).not.toContain("event-cluster");
    expect(shape).toContain('"clusterRef":"<cluster-ref-from-context>"');
  });

  it("tells the repair to keep refs verbatim and lists the four significances", async () => {
    const repair = captureRepairSend(response({}));
    await runEventSynthesisTask({
      clusterRef,
      observations: [windowObservation],
      projectId: "project-test",
      send: async () => ({
        text: response({ clusterRef: `event-cluster:${clusterRef}` }),
        ...usage,
      }),
      repairSend: repair.send,
    });

    const prompt = repair.captured()?.prompt ?? "";
    expect(prompt).toContain(
      `clusterRef は "${clusterRef}" をそのまま使い、event-cluster: などの接頭辞を付けないでください。`,
    );
    expect(prompt).toContain(
      '使える localId はこの cluster の ["window-001:obs-009"] だけです。',
    );
    // One priority rule: a value that matches a localId is kept as is; a value
    // that does not (extra prefix) is mapped back to the localId.
    expect(prompt).toContain(
      "壊れた出力の値がそのどれかと一致するなら一字一句そのまま保ち（短縮・正規化をしない）、一致しない値（event-observation: などの余分な接頭辞付き）は、同じ Observation を指す localId に直してください。",
    );
    expect(prompt).toContain(
      'events[].significance は "major"、"scene-level"、"minor"、"incidental" のいずれかです。それ以外の値（"moderate" など）は event を除かず、判断が付かなければ "minor" に直してください。',
    );
    // The example ref is a real localId of the cluster, not the old "obs-1".
    expect(prompt).not.toContain('"obs-1"');
  });

  it.each([
    [
      "event-cluster: prefix on clusterRef",
      { clusterRef: `event-cluster:${clusterRef}` },
    ],
    ["significance moderate", { significance: "moderate" }],
    ["shortened localId (obs-009)", { observationRefs: ["obs-009"] }],
  ])(
    "reports %s as invalid and emits no terminal output",
    async (_label, overrides) => {
      const stageExecution = createEventStageExecution({
        projectId: "project-test",
        runId: "run-clarity",
        taskId: "task-clarity",
        attemptId: "attempt-clarity",
        stageExecutionId: "stage-clarity",
      });
      const statuses: Array<"parsed" | "invalid"> = [];
      const terminals: ChronicleSynthesisTerminalOutput[] = [];
      const result = await runEventSynthesisTask({
        clusterRef,
        observations: [windowObservation],
        projectId: "project-test",
        stageExecution,
        send: async () => ({ text: response(overrides), ...usage }),
        repairOnFailure: false,
        onParseStatus: (status) => statuses.push(status),
        onTerminalOutput: (output) => {
          terminals.push(output);
        },
      });

      expect(result).toEqual([]);
      expect(statuses).toEqual(["invalid"]);
      expect(terminals).toEqual([]);
    },
  );

  it("does not pass a repaired response whose refs were shortened (apparent success) to Native", async () => {
    const stageExecution = createEventStageExecution({
      projectId: "project-test",
      runId: "run-apparent",
      taskId: "task-apparent",
      attemptId: "attempt-apparent",
      stageExecutionId: "stage-apparent",
    });
    const statuses: Array<"parsed" | "invalid"> = [];
    const terminals: ChronicleSynthesisTerminalOutput[] = [];
    // Root: prefixed clusterRef. Repair: fixes clusterRef but shortens the ref.
    const repair = captureRepairSend(
      response({ observationRefs: ["obs-009"] }),
    );
    const result = await runEventSynthesisTask({
      clusterRef,
      observations: [windowObservation],
      projectId: "project-test",
      stageExecution,
      send: async () => ({
        text: response({ clusterRef: `event-cluster:${clusterRef}` }),
        ...usage,
      }),
      repairSend: repair.send,
      createStageExecutionId: () => "repair-apparent",
      onParseStatus: (status) => statuses.push(status),
      onTerminalOutput: (output) => {
        terminals.push(output);
      },
    });

    expect(repair.captured()).not.toBeNull();
    expect(result).toEqual([]);
    expect(statuses).toEqual(["invalid"]);
    expect(terminals).toEqual([]);
  });

  it("still accepts a repaired response that keeps the localId verbatim", async () => {
    const stageExecution = createEventStageExecution({
      projectId: "project-test",
      runId: "run-kept",
      taskId: "task-kept",
      attemptId: "attempt-kept",
      stageExecutionId: "stage-kept",
    });
    const terminals: ChronicleSynthesisTerminalOutput[] = [];
    const repair = captureRepairSend(response({}));
    const result = await runEventSynthesisTask({
      clusterRef,
      observations: [windowObservation],
      projectId: "project-test",
      stageExecution,
      send: async () => ({
        text: response({ clusterRef: `event-cluster:${clusterRef}` }),
        ...usage,
      }),
      repairSend: repair.send,
      createStageExecutionId: () => "repair-kept",
      onTerminalOutput: (output) => {
        terminals.push(output);
      },
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.observationRefs).toEqual(["window-001:obs-009"]);
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.disposition).toBe("repair-success");
  });

  describe("all-or-nothing acceptance across several events and refs", () => {
    const secondObservation: RawChronicleEventObservation = {
      ...windowObservation,
      localId: "window-001:obs-010",
      evidence: [{ sourceRef: "S0010", quote: "彼は水の中へ潜った" }],
      payload: { ...windowObservation.payload, predicate: "河童が潜る" },
    };
    const observations = [windowObservation, secondObservation];

    function twoEventResponse(
      first: readonly string[],
      second: readonly string[],
    ): string {
      const event = (refs: readonly string[], title: string) => ({
        observationRefs: refs,
        titleSuggestion: title,
        summary: `${title}。`,
        actuality: "actual",
        significance: "minor",
      });
      return JSON.stringify({
        clusterRef,
        resolution: "multiple-events",
        events: [event(first, "体色の変化"), event(second, "潜る")],
      });
    }

    async function run(
      responseText: string,
      options: {
        readonly repairText?: string;
        readonly repairOnFailure?: boolean;
      } = {},
    ) {
      const stageExecution = createEventStageExecution({
        projectId: "project-test",
        runId: "run-multi",
        taskId: "task-multi",
        attemptId: "attempt-multi",
        stageExecutionId: "stage-multi",
      });
      const statuses: Array<"parsed" | "invalid"> = [];
      const terminals: ChronicleSynthesisTerminalOutput[] = [];
      const repair = captureRepairSend(options.repairText ?? "not-json");
      const result = await runEventSynthesisTask({
        clusterRef,
        observations,
        projectId: "project-test",
        stageExecution,
        send: async () => ({ text: responseText, ...usage }),
        repairOnFailure: options.repairOnFailure ?? false,
        repairSend: repair.send,
        createStageExecutionId: () => "repair-multi",
        onParseStatus: (status) => statuses.push(status),
        onTerminalOutput: (output) => {
          terminals.push(output);
        },
      });
      return { result, statuses, terminals, repair };
    }

    it("accepts several events whose refs all resolve", async () => {
      const { result, statuses, terminals } = await run(
        twoEventResponse(["window-001:obs-009"], ["window-001:obs-010"]),
      );

      expect(statuses).toEqual(["parsed"]);
      expect(result.map((hypothesis) => hypothesis.observationRefs)).toEqual([
        ["window-001:obs-009"],
        ["window-001:obs-010"],
      ]);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.disposition).toBe("root-success");
    });

    it.each([
      [
        "a known and an unknown ref in one event",
        twoEventResponse(
          ["window-001:obs-009", "obs-010"],
          ["window-001:obs-010"],
        ),
      ],
      [
        "an unknown ref only in the second event",
        twoEventResponse(["window-001:obs-009"], ["obs-010"]),
      ],
    ])(
      "treats %s as invalid, never as a partial success",
      async (_label, text) => {
        const { result, statuses, terminals, repair } = await run(text);

        expect(result).toEqual([]);
        expect(statuses).toEqual(["invalid"]);
        expect(terminals).toEqual([]);
        // repairOnFailure=false: the repair child is not asked.
        expect(repair.captured()).toBeNull();
      },
    );

    it("sends a partly unresolved response to repair and accepts the verbatim repair", async () => {
      const broken = twoEventResponse(["window-001:obs-009"], ["obs-010"]);
      const repaired = twoEventResponse(
        ["window-001:obs-009"],
        ["window-001:obs-010"],
      );
      const { result, statuses, terminals, repair } = await run(broken, {
        repairText: repaired,
        repairOnFailure: true,
      });

      const prompt = repair.captured()?.prompt ?? "";
      expect(prompt).toContain(
        '使える localId はこの cluster の ["window-001:obs-009","window-001:obs-010"] だけです。',
      );
      // The broken text reaches the repair child, so it can see its own refs.
      expect(prompt).toContain('"observationRefs":["obs-010"]');
      expect(statuses).toEqual(["parsed"]);
      // Each event keeps its own ref; the first localId is not copied to all.
      expect(result.map((hypothesis) => hypothesis.observationRefs)).toEqual([
        ["window-001:obs-009"],
        ["window-001:obs-010"],
      ]);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]?.disposition).toBe("repair-success");
    });

    it("repairs an extra event-observation: prefix on a ref back to its localId", async () => {
      const broken = twoEventResponse(
        ["event-observation:window-001:obs-009"],
        ["window-001:obs-010"],
      );
      const repaired = twoEventResponse(
        ["window-001:obs-009"],
        ["window-001:obs-010"],
      );
      const { result, statuses, terminals, repair } = await run(broken, {
        repairText: repaired,
        repairOnFailure: true,
      });

      const prompt = repair.captured()?.prompt ?? "";
      expect(prompt).toContain("event-observation:window-001:obs-009");
      expect(prompt).toContain(
        "一致しない値（event-observation: などの余分な接頭辞付き）",
      );
      expect(statuses).toEqual(["parsed"]);
      expect(result.map((hypothesis) => hypothesis.observationRefs)).toEqual([
        ["window-001:obs-009"],
        ["window-001:obs-010"],
      ]);
      expect(terminals[0]?.disposition).toBe("repair-success");
    });

    it("stays invalid when the repair keeps the extra prefix", async () => {
      const prefixed = twoEventResponse(
        ["event-observation:window-001:obs-009"],
        ["window-001:obs-010"],
      );
      const { result, statuses, terminals } = await run(prefixed, {
        repairText: prefixed,
        repairOnFailure: true,
      });

      expect(result).toEqual([]);
      expect(statuses).toEqual(["invalid"]);
      expect(terminals).toEqual([]);
    });
  });

  it("keeps the unresolved empty exit valid (no refs to resolve)", async () => {
    const statuses: Array<"parsed" | "invalid"> = [];
    const result = await runEventSynthesisTask({
      clusterRef,
      observations: [windowObservation],
      projectId: "project-test",
      send: async () => ({
        text: JSON.stringify({
          clusterRef,
          resolution: "unresolved",
          events: [],
        }),
        ...usage,
      }),
      repairOnFailure: false,
      onParseStatus: (status) => statuses.push(status),
    });

    expect(result).toEqual([]);
    expect(statuses).toEqual(["parsed"]);
  });
});
