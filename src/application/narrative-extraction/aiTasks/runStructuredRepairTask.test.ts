import { beforeEach, describe, expect, it, vi } from "vitest";

import { runEventSynthesisTask } from "./runEventSynthesisTask";
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

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: () => false,
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

describe("structured repair root-object contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const expectedShape =
      '{"clusterRef":"cluster-1","resolution":"single-event","events":[{"observationRefs":["obs-1"],"titleSuggestion":"t","summary":"s","actuality":"actual","significance":"major"}]}';
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
});
