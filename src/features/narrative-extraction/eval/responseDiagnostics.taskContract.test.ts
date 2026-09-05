import { describe, expect, it, vi } from "vitest";
import {
  canonicalObservationParseStatus,
  canonicalSynthesisParseStatus,
  diagnoseObservationResponse,
  diagnoseSynthesisResponse,
} from "./responseDiagnostics";
import {
  runEventSynthesisTask,
  type EventSynthesisSend,
  type RunEventSynthesisTaskInput,
} from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import { rekeyObservationsForWindow } from "@/features/chronicle/extraction/windowExtractor";
import { createStageExecutionContext } from "@/features/narrative-extraction/reconciler/stageExecution";
import {
  digestStableJson,
  sha256Digest,
} from "@/features/narrative-extraction/source/digest";

const blockPolicyMock = vi.hoisted(() => vi.fn(() => false));
const blockLicenseMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: blockPolicyMock,
}));
vi.mock("@/features/license/gate", () => ({
  blockIfUnlicensed: blockLicenseMock,
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

const observation = {
  localId: "obs-1",
  evidence: [{ sourceRef: "S0001", quote: "門が倒れた。" }],
  assertion: { attribution: "narrator", narrativeFrame: "story-world" },
  payload: {
    predicate: "門が倒れた",
    actuality: "actual",
    participants: [],
    temporalExpressions: [],
    durationKind: "instant",
  },
} as const;

const synthesisEvent = {
  observationRefs: ["obs-1"],
  titleSuggestion: "門の倒壊",
  summary: "門が倒れた",
  actuality: "actual",
  significance: "major",
} as const;

async function runSyntheticRekeyedSynthesis(
  responseRef: string,
  windowKey = "eval-window-001",
) {
  const observations = rekeyObservationsForWindow(windowKey, [observation]);
  const clusterRef = `cluster-${windowKey}`;
  const responseText = JSON.stringify({
    clusterRef,
    resolution: "single-event",
    events: [{ ...synthesisEvent, observationRefs: [responseRef] }],
  });
  const stageExecution = createStageExecutionContext({
    projectId: "project-test",
    runId: `synthetic-ref-contract:${windowKey}:${responseRef}`,
    taskId: clusterRef,
    attemptId: "attempt-1",
    stageId: "narrative_event_synthesize",
    stageExecutionId: `synthesis:${windowKey}:${responseRef}`,
  });
  const send = vi.fn<EventSynthesisSend>().mockResolvedValue({
    text: responseText,
    inputTokens: 1,
    outputTokens: 1,
  });
  const onParseStatus = vi.fn();
  const onStageReceipt =
    vi.fn<NonNullable<RunEventSynthesisTaskInput["onStageReceipt"]>>();
  const onTerminalOutput =
    vi.fn<NonNullable<RunEventSynthesisTaskInput["onTerminalOutput"]>>();
  const result = await runEventSynthesisTask({
    clusterRef,
    observations,
    projectId: "project-test",
    stageExecution,
    repairOnFailure: false,
    send,
    onParseStatus,
    onStageReceipt,
    onTerminalOutput,
  });
  const diagnostic = diagnoseSynthesisResponse(responseText, {
    invocationIndex: 0,
    clusterRef,
    allowedObservationRefs: new Set(observations.map((entry) => entry.localId)),
  });

  expect(send).toHaveBeenCalledTimes(1);
  expect(onParseStatus).toHaveBeenCalledExactlyOnceWith(
    canonicalSynthesisParseStatus(diagnostic),
  );
  expect(onParseStatus).toHaveBeenCalledWith("parsed");
  const requestMetadata = send.mock.calls[0]![1]?.metadata?.chronicleStage;
  const receipt = onStageReceipt.mock.calls[0]?.[0];
  expect(onStageReceipt).toHaveBeenCalledTimes(1);
  expect(requestMetadata).toEqual(
    expect.objectContaining({
      stageExecution,
      contextSetDigest: receipt?.contextSetDigest,
      componentContractDigest: receipt?.componentContractDigest,
      finalRequestDigest: receipt?.finalRequestDigest,
    }),
  );
  expect(receipt).toMatchObject({
    stageExecution,
    responseDigest: await sha256Digest(responseText),
    rawObservationsDigest: await digestStableJson({
      kind: "chronicle.raw-observations@1",
      version: 1,
      observations,
    }),
    parseStatus: "parsed",
  });
  expect(onTerminalOutput).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      rootStageExecution: stageExecution,
      terminalStageExecution: stageExecution,
      clusterRef,
      rawObservations: observations,
      eventOutput: JSON.parse(responseText),
      hypotheses: result,
      rawObservationsDigest: receipt?.rawObservationsDigest,
      parsedOutputDigest: receipt?.parsedOutputDigest,
    }),
  );
  return {
    result,
    diagnostic,
    prompt: send.mock.calls[0]![0][0]!.content,
  };
}

describe("Chronicle response diagnostics and task callback contract", () => {
  it("sends an exact localId copy contract with rekeyed IDs only in dynamic Context", async () => {
    const first = await runSyntheticRekeyedSynthesis("eval-window-001:obs-001");
    const second = await runSyntheticRekeyedSynthesis(
      "eval-window-002:obs-001",
      "eval-window-002",
    );
    const [instruction, contextAndShape] = first.prompt.split(
      "# Context Set (chronicle.prompt/1)",
    );
    const [context, shape] = contextAndShape!.split("# Output (JSON only)");
    expect(instruction).toContain("events[].observationRefs");
    expect(instruction).toContain("localId 値だけを一字一句そのままコピー");
    expect(instruction).toContain("このリクエスト");
    expect(instruction).toContain("同一候補 Cluster");
    expect(instruction).toContain("contextId や inputRef");
    expect(instruction).toContain("出力例のプレースホルダー");
    expect(instruction).toContain("省略、推測、正規化しない");
    expect(instruction).toContain("別リクエストや別 Cluster");
    expect(context).toContain(
      "contextId=event-observation:eval-window-001:obs-001 inputRef=observation:eval-window-001:obs-001",
    );
    expect(context).toContain("- localId=eval-window-001:obs-001;");
    expect(JSON.parse(shape!)).toMatchObject({
      clusterRef: "<event-cluster-ref-from-context>",
      events: [{ observationRefs: ["<observation-localId-from-context>"] }],
    });
    expect(shape).not.toContain('"obs-1"');
    expect(`${instruction}${shape}`).not.toContain("eval-window-");
    expect(second.prompt.split("# Context Set (chronicle.prompt/1)")[0]).toBe(
      instruction,
    );
    expect(second.prompt.split("# Output (JSON only)")[1]).toBe(shape);
    expect(first.result).toMatchObject([
      { observationRefs: ["eval-window-001:obs-001"] },
    ]);
    expect(first.diagnostic.refs).toEqual({
      status: "valid",
      checkedCount: 1,
      rejectedCount: 0,
      errors: [],
    });
    expect(first.diagnostic.output).toMatchObject({
      candidateCount: 1,
      normalizerDroppedCount: 0,
      acceptedCount: 1,
    });
  });

  // Synthetic reproduction of the observed UNKNOWN_OBSERVATION_REF violation.
  // No raw live response was persisted; these values are not an actual replay
  // or evidence that the live model emitted the literal "obs-1".
  it.each([
    ["example ID", "obs-1"],
    ["contextId", "event-observation:eval-window-001:obs-001"],
    ["inputRef", "observation:eval-window-001:obs-001"],
    ["normalized ID", "eval-window-001:obs-1"],
    ["output placeholder", "<observation-localId-from-context>"],
    ["other request ID", "eval-window-002:obs-001"],
    ["other cluster ID", "eval-window-001:obs-002"],
  ])("drops a synthetic event with an unallowed %s", async (_label, ref) => {
    const { result, diagnostic } = await runSyntheticRekeyedSynthesis(ref);
    expect(result).toEqual([]);
    expect(diagnostic.schema).toEqual({ status: "valid", errors: [] });
    expect(diagnostic.refs).toEqual({
      status: "invalid",
      checkedCount: 1,
      rejectedCount: 1,
      errors: [
        {
          code: "UNKNOWN_OBSERVATION_REF",
          path: "events[0].observationRefs[0]",
        },
      ],
    });
    expect(diagnostic.output).toEqual({
      candidateCount: 1,
      schemaAcceptedCount: 1,
      schemaRejectedCount: 0,
      normalizerDroppedCount: 1,
      acceptedCount: 0,
      rejectedCount: 1,
      salvagedCount: 0,
    });
  });

  it("matches observation onParseStatus even when valid rows are all ref-filtered", async () => {
    const responseText = JSON.stringify({
      observations: [
        {
          ...observation,
          evidence: [{ sourceRef: "S9999", quote: "unknown" }],
        },
      ],
    });
    let actualStatus: "parsed" | "invalid" | undefined;
    const result = await runObservationExtractionTask({
      windows: [{ sourceRef: "S0001", text: "門が倒れた。" }],
      projectId: "project-test",
      repairOnFailure: false,
      send: async () => ({
        text: responseText,
        inputTokens: 1,
        outputTokens: 1,
      }),
      onParseStatus: (status) => {
        actualStatus = status;
      },
    });
    const diagnostic = diagnoseObservationResponse(responseText, {
      invocationIndex: 0,
      allowedSourceRefs: new Set(["S0001"]),
    });

    expect(actualStatus).toBe(canonicalObservationParseStatus(diagnostic));
    expect(actualStatus).toBe("parsed");
    expect(result).toEqual([]);
  });

  it("matches synthesis onParseStatus for ref filtering and cluster mismatch", async () => {
    const refFilteredResponse = JSON.stringify({
      clusterRef: "cluster-1",
      resolution: "single-event",
      events: [{ ...synthesisEvent, observationRefs: ["obs-unknown"] }],
    });
    let refFilteredStatus: "parsed" | "invalid" | undefined;
    const refFilteredResult = await runEventSynthesisTask({
      clusterRef: "cluster-1",
      observations: [observation],
      projectId: "project-test",
      repairOnFailure: false,
      send: async () => ({
        text: refFilteredResponse,
        inputTokens: 1,
        outputTokens: 1,
      }),
      onParseStatus: (status) => {
        refFilteredStatus = status;
      },
    });
    const refFilteredDiagnostic = diagnoseSynthesisResponse(
      refFilteredResponse,
      {
        invocationIndex: 0,
        clusterRef: "cluster-1",
        allowedObservationRefs: new Set(["obs-1"]),
      },
    );
    expect(refFilteredStatus).toBe(
      canonicalSynthesisParseStatus(refFilteredDiagnostic),
    );
    expect(refFilteredStatus).toBe("parsed");
    expect(refFilteredResult).toEqual([]);

    const wrongClusterResponse = JSON.stringify({
      clusterRef: "cluster-other",
      resolution: "single-event",
      events: [synthesisEvent],
    });
    let wrongClusterStatus: "parsed" | "invalid" | undefined;
    const wrongClusterResult = await runEventSynthesisTask({
      clusterRef: "cluster-1",
      observations: [observation],
      projectId: "project-test",
      repairOnFailure: false,
      send: async () => ({
        text: wrongClusterResponse,
        inputTokens: 1,
        outputTokens: 1,
      }),
      onParseStatus: (status) => {
        wrongClusterStatus = status;
      },
    });
    const wrongClusterDiagnostic = diagnoseSynthesisResponse(
      wrongClusterResponse,
      {
        invocationIndex: 1,
        clusterRef: "cluster-1",
        allowedObservationRefs: new Set(["obs-1"]),
      },
    );
    expect(wrongClusterStatus).toBe(
      canonicalSynthesisParseStatus(wrongClusterDiagnostic),
    );
    expect(wrongClusterStatus).toBe("invalid");
    expect(wrongClusterResult).toEqual([]);
  });
});
