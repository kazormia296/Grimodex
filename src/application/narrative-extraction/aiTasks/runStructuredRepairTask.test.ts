import { beforeEach, describe, expect, it, vi } from "vitest";

import { runEventSynthesisTask } from "./runEventSynthesisTask";
import {
  runObservationExtractionTask,
  type ObservationExtractionSend,
} from "./runObservationExtractionTask";
import {
  runStructuredRepairTask,
  type StructuredRepairSend,
} from "./runStructuredRepairTask";
import {
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

describe("structured repair root-object contract", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the declared direct-root contract through the audited stage seam", async () => {
    const expectedShape = '{"observations":[]}';
    const repair = captureRepairSend(repairedObservations);
    const stageExecution = createStageExecutionContext({
      projectId: "project-test",
      runId: "run-1",
      taskId: "task-1",
      attemptId: "attempt-1",
      stageId: NARRATIVE_STAGE_IDS.structuredRepair,
      stageExecutionId: "repair-stage-1",
    });

    await expect(
      runStructuredRepairTask({
        brokenText: "not-json",
        expectedShape,
        projectId: "project-test",
        stageExecution,
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
      parentExecutionId: null,
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
});
