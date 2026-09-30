import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadNarrativeEvalSuite } from "./narrativeEvalSuite";
import {
  assertChronicle015PreparedWindows,
  assertChronicle015SynthesisInput,
  bindChronicle015ObservationResponse,
  bindChronicle015SynthesisResponse,
  CHRONICLE_015_CASE_ID,
  CHRONICLE_015_QUOTE,
  runChronicle015ReferenceCase,
  type Chronicle015ReferenceRun,
} from "./chronicle015Reference";
import type { PreparedProductionChronicleEvalCase } from "./productionChronicleTypes";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";

const defaultTransportMock = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("Chronicle 015 reference must not use default transport");
  }),
);

vi.mock("@/features/chat/chatApi", () => ({
  sendChatMessageWithThinking: defaultTransportMock,
}));
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
    model: "fixture-reference-model",
    provider: "fixture-reference",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "chronicle-015-reference" }),
  },
}));

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);

async function load015Case() {
  const suite = await loadNarrativeEvalSuite({
    repoRoot,
    suiteId: "chronicle-motif-boundary-v1",
  });
  const evalCase = suite.cases.find(
    (candidate) => candidate.id === CHRONICLE_015_CASE_ID,
  );
  if (!evalCase) throw new Error(`Missing Gold case ${CHRONICLE_015_CASE_ID}`);
  return evalCase;
}

function runtimeObservation(localId: string): RawChronicleEventObservation {
  return {
    localId,
    evidence: [{ sourceRef: "S0002", quote: CHRONICLE_015_QUOTE }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      predicate: "ミナが儀礼剣を使って、捕虜を縛る縄を切った",
      actuality: "actual",
      participants: [
        { surface: "ミナ", role: "agent" },
        { surface: "儀礼剣", role: "instrument" },
        { surface: "捕虜を縛る縄", role: "patient" },
      ],
      temporalExpressions: [],
      durationKind: "instant",
    },
  };
}

function expectValidCounts(run: Chronicle015ReferenceRun): void {
  expect(run.report.counts).toEqual({
    observations: 1,
    unresolvedEvidence: 0,
    hypotheses: 1,
    proposals: 1,
    parseFailures: 0,
  });
  expect(run.report.persistenceEvidence).toBe(
    "not-instrumented; proposal-planning-only runner",
  );
  expect(run.trace).toMatchObject({
    observationCalls: 2,
    observationSends: 2,
    synthesisCalls: 1,
    synthesisSends: 1,
    observationParseStatuses: ["parsed", "parsed"],
    synthesisParseStatuses: ["parsed"],
    observationWindows: [{ sourceRef: "S0001" }, { sourceRef: "S0002" }],
  });
  expect(run.trace.synthesisInputs).toHaveLength(1);
  expect(run.trace.synthesisInputs[0]?.clusterRef).toMatch(/^cluster-/);
  expect(run.trace.synthesisInputs[0]?.observationRefs).toHaveLength(1);
  expect(run.evaluation.actual.appliedProposalIds).toEqual([]);
}

describe("Chronicle 015 fixed-response production reference seam", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("runs correct and wrong-meaning JSON through canonical stages and separates semantic verdicts", async () => {
    const evalCase = await load015Case();
    const correct = await runChronicle015ReferenceCase(evalCase, "correct");
    const wrongMeaning = await runChronicle015ReferenceCase(
      evalCase,
      "wrong-meaning",
    );

    expectValidCounts(correct);
    expectValidCounts(wrongMeaning);
    expect(correct.report).toMatchObject({
      observedScorerResult: "PASS",
      intendedSemanticVerdict: "PASS",
      semanticRequirement: "PASS",
    });
    expect(wrongMeaning.report).toMatchObject({
      observedScorerResult: "PASS",
      intendedSemanticVerdict: "FAIL",
      semanticRequirement: "HOLD",
    });
    expect(wrongMeaning.report.semanticNote).toContain(
      "does not compare predicate/roles",
    );

    const observed = wrongMeaning.artifacts.observations[0];
    expect(observed?.payload.predicate).toBe(
      "捕虜が儀礼剣を使って、ミナを縛る縄を切った",
    );
    expect(observed?.payload.participants).toEqual([
      { surface: "捕虜", role: "agent" },
      { surface: "儀礼剣", role: "instrument" },
      { surface: "ミナを縛る縄", role: "patient" },
    ]);
    expect(defaultTransportMock).not.toHaveBeenCalled();
    console.info(
      `CHRONICLE015_REFERENCE_REPORT ${JSON.stringify(correct.report)}`,
    );
    console.info(
      `CHRONICLE015_REFERENCE_REPORT ${JSON.stringify(wrongMeaning.report)}`,
    );
  });

  it("distinguishes an invalid observation response from a valid empty extraction", async () => {
    const evalCase = await load015Case();
    const run = await runChronicle015ReferenceCase(
      evalCase,
      "invalid-duration",
    );

    expect(run.report.counts).toEqual({
      observations: 0,
      unresolvedEvidence: 0,
      hypotheses: 0,
      proposals: 0,
      parseFailures: 1,
    });
    expect(run.report.persistenceEvidence).toBe(
      "not-instrumented; proposal-planning-only runner",
    );
    expect(run.trace).toMatchObject({
      observationCalls: 2,
      observationSends: 2,
      synthesisCalls: 0,
      synthesisSends: 0,
      observationParseStatuses: ["parsed", "invalid"],
      synthesisParseStatuses: [],
    });
    expect(run.evaluation.passed).toBe(false);
    expect(run.report.intendedSemanticVerdict).toBe("NOT_EVALUATED");
    expect(run.report.semanticRequirement).toBe("HOLD");
    expect(run.evaluation.actual.appliedProposalIds).toEqual([]);
    expect(defaultTransportMock).not.toHaveBeenCalled();
    console.info(`CHRONICLE015_REFERENCE_REPORT ${JSON.stringify(run.report)}`);
  });

  it("rejects missing, extra, and duplicate source windows", async () => {
    const evalCase = await load015Case();
    const prepared = (await runChronicle015ReferenceCase(evalCase, "correct"))
      .prepared;
    const first = prepared.windows[0];
    const second = prepared.windows[1];
    if (!first || !second)
      throw new Error("015 prepared windows are incomplete");

    expect(() =>
      assertChronicle015PreparedWindows({
        ...prepared,
        windows: [first],
      } as PreparedProductionChronicleEvalCase),
    ).toThrow(/exactly 2 source windows/);
    expect(() =>
      assertChronicle015PreparedWindows({
        ...prepared,
        windows: [first, second, { sourceRef: "S0003", text: "余分な窓" }],
      } as PreparedProductionChronicleEvalCase),
    ).toThrow(/exactly 2 source windows/);
    expect(() =>
      assertChronicle015PreparedWindows({
        ...prepared,
        windows: [first, { ...second, sourceRef: first.sourceRef }],
      } as PreparedProductionChronicleEvalCase),
    ).toThrow(/duplicate sourceRef/);
  });

  it("rejects unknown, extra, and duplicate runtime observations before synthesis binding", () => {
    const expectedObservationRefs = ["eval-window-002:obs-001"];
    const base = {
      clusterRef: "cluster-0001",
      expectedObservationRefs,
      expectedSourceRef: "S0002",
    } as const;
    expect(() =>
      assertChronicle015SynthesisInput({
        ...base,
        observations: [],
      }),
    ).toThrow(/missing or extra/);
    expect(() =>
      assertChronicle015SynthesisInput({
        ...base,
        observations: [runtimeObservation("unknown-runtime-ref")],
      }),
    ).toThrow(/unknown or out of order/);
    expect(() =>
      assertChronicle015SynthesisInput({
        ...base,
        observations: [
          runtimeObservation(expectedObservationRefs[0]),
          runtimeObservation("extra-runtime-ref"),
        ],
      }),
    ).toThrow(/missing or extra/);
    expect(() =>
      assertChronicle015SynthesisInput({
        ...base,
        expectedObservationRefs: ["runtime-a", "runtime-b"],
        observations: [
          runtimeObservation("runtime-a"),
          runtimeObservation("runtime-a"),
        ],
      }),
    ).toThrow(/duplicate localIds/);
  });

  it("rejects placeholder leakage outside the two designated binding fields", () => {
    expect(() =>
      bindChronicle015ObservationResponse(
        {
          observations: [
            {
              localId: "obs-1",
              evidence: [
                { sourceRef: "__SOURCE_REF_USE__", quote: CHRONICLE_015_QUOTE },
              ],
              assertion: {
                attribution: "narrator",
                narrativeFrame: "story-world",
              },
              payload: {
                predicate: "__CLUSTER_REF__",
                actuality: "actual",
                participants: [],
                temporalExpressions: [],
                durationKind: "instant",
              },
            },
          ],
        },
        "S0002",
      ),
    ).toThrow(/unbound placeholder/);

    const observation = runtimeObservation("eval-window-002:obs-001");
    expect(() =>
      bindChronicle015SynthesisResponse(
        {
          clusterRef: "__CLUSTER_REF__",
          events: [
            {
              observationRefs: ["__OBSERVATION_REF_1__"],
              titleSuggestion: "__SOURCE_REF_USE__",
              summary: "要約",
              actuality: "actual",
              significance: "major",
            },
          ],
        },
        {
          clusterRef: "cluster-0001",
          expectedObservationRefs: [observation.localId],
          expectedSourceRef: "S0002",
          observations: [observation],
        },
      ),
    ).toThrow(/unbound placeholder/);
  });
});
