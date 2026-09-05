import { describe, expect, it, vi } from "vitest";
import {
  canonicalObservationParseStatus,
  canonicalSynthesisParseStatus,
  diagnoseObservationResponse,
  diagnoseSynthesisResponse,
} from "./responseDiagnostics";
import { runEventSynthesisTask } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";

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

describe("Chronicle response diagnostics and task callback contract", () => {
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
