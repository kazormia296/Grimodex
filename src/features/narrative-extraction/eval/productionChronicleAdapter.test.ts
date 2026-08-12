import { describe, expect, it, vi } from "vitest";
import { runEventSynthesisTask } from "@/application/narrative-extraction/aiTasks/runEventSynthesisTask";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { NarrativeEvalCaseV1 } from "./types";
import {
  evaluateProductionChronicleArtifacts,
  isCertificationEligible,
  prepareProductionChronicleEvalCase,
  runProductionChroniclePipeline,
  type ProductionChroniclePipelineDeps,
} from "./productionChronicleAdapter";

vi.mock("@/features/ai-policy/policyGuard", () => ({
  blockIfPolicyOff: () => false,
}));
vi.mock("@/features/ai-usage/recordAiUsage", () => ({
  recordAiUsage: vi.fn(),
}));
vi.mock("@/features/chat/modelRouting", () => ({
  resolveRoleSendOverride: () => ({
    apiVariant: undefined,
    model: "test-model",
    provider: "test",
    endpointId: undefined,
  }),
}));
vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: () => ({ projectId: "narrative-eval-test" }),
  },
}));

function miniCase(coverage: "complete" | "partial" = "complete") {
  return {
    schemaVersion: 1,
    id: `chronicle.micro.production-${coverage}`,
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-08-10T00:00:00.000Z",
    coverage: {
      mode: coverage,
      includedDocumentIds: ["scene-a"],
      omittedDocumentIds: coverage === "partial" ? ["scene-locked"] : [],
    },
    documents: [
      {
        id: "scene-a",
        title: "北門",
        text: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
      },
      {
        id: "scene-locked",
        title: "閲覧対象外",
        text: "地下区画の隔壁が破損した。",
      },
    ],
    expected: {
      observations: {
        required: [
          {
            id: "required-gate",
            semanticKey: "north-gate-collapse",
            dimensions: {
              eventDetection: true,
              actuality: "actual",
              attribution: "narrator",
              narrativeFrame: "story-world",
              evidence: [
                {
                  documentId: "scene-a",
                  quote: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
                },
              ],
              clustering: "north-gate-collapse",
              significance: "major",
              proposalGate: "propose",
            },
          },
        ],
        forbidden: [],
      },
    },
    criticalViolationClasses: [],
  } satisfies NarrativeEvalCaseV1;
}

async function runPassingCase(evalCase = miniCase()) {
  const prepared = await prepareProductionChronicleEvalCase(evalCase);
  const sourceRef = prepared.windows[0]?.sourceRef;
  if (!sourceRef) throw new Error("fixture did not create a Source View");

  const artifacts = await runProductionChroniclePipeline(prepared, {
    createId: (() => {
      let index = 0;
      return () => `production-id-${++index}`;
    })(),
    observeWithAi: async () => [
      {
        localId: "obs-1",
        evidence: [
          {
            sourceRef,
            quote: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
          },
        ],
        assertion: {
          attribution: "narrator",
          narrativeFrame: "story-world",
        },
        payload: {
          predicate: "北門が倒れた",
          actuality: "actual",
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      },
    ],
    synthesizeWithAi: async ({ clusterRef, observations }) =>
      [
        {
          hypothesisId: "hypothesis-1",
          clusterRef,
          observationRefs: observations.map((entry) => entry.localId),
          titleSuggestion: "北門の倒壊",
          summary: "北門が倒壊した",
          actuality: "actual",
          significance: "major",
        },
      ] satisfies readonly EventHypothesis[],
  });
  return {
    artifacts,
    evaluation: evaluateProductionChronicleArtifacts(prepared, artifacts),
  };
}

function clusteringCase(
  goldClusterLabels: readonly string[],
): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1,
    id: "chronicle.micro.production-clustering",
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-08-10T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: goldClusterLabels.map(
        (_, index) => `scene-${index + 1}`,
      ),
      omittedDocumentIds: [],
    },
    documents: goldClusterLabels.map((_, index) => ({
      id: `scene-${index + 1}`,
      title: `場面${index + 1}`,
      text: `出来事${index + 1}が起きた。`,
    })),
    expected: {
      observations: {
        required: goldClusterLabels.map((clustering, index) => ({
          id: `required-${index + 1}`,
          semanticKey: `event-${index + 1}`,
          dimensions: {
            eventDetection: true,
            actuality: "actual",
            attribution: "narrator",
            narrativeFrame: "story-world",
            evidence: [
              {
                documentId: `scene-${index + 1}`,
                quote: `出来事${index + 1}が起きた。`,
              },
            ],
            clustering,
            significance: "major",
            proposalGate: "propose",
          },
        })),
        forbidden: [],
      },
    },
    criticalViolationClasses: [],
  };
}

async function evaluateClusterGroups(
  goldClusterLabels: readonly string[],
  actualClusterLabels: readonly string[],
) {
  const prepared = await prepareProductionChronicleEvalCase(
    clusteringCase(goldClusterLabels),
  );
  const artifacts = await runProductionChroniclePipeline(prepared, {
    createId: (() => {
      let index = 0;
      return () => `production-id-${++index}`;
    })(),
    observeWithAi: async ({ windows }) => {
      const window = windows[0];
      if (!window) throw new Error("missing extraction window");
      return [
        {
          localId: "obs",
          evidence: [{ sourceRef: window.sourceRef, quote: window.text }],
          assertion: {
            attribution: "narrator",
            narrativeFrame: "story-world",
          },
          payload: {
            predicate: window.text,
            actuality: "actual",
            participants: [],
            temporalExpressions: [],
            durationKind: "instant",
          },
        },
      ];
    },
    synthesizeWithAi: async ({ clusterRef, observations }) => [
      {
        hypothesisId: `hypothesis-${clusterRef}`,
        clusterRef,
        observationRefs: observations.map((entry) => entry.localId),
        titleSuggestion: "出来事",
        summary: "出来事が起きた",
        actuality: "actual",
        significance: "major",
      },
    ],
  });
  const refsByCluster = new Map<string, string[]>();
  artifacts.observations.forEach((observation, index) => {
    const label = actualClusterLabels[index];
    if (!label) throw new Error(`missing actual cluster label at ${index}`);
    const refs = refsByCluster.get(label) ?? [];
    refs.push(observation.localId);
    refsByCluster.set(label, refs);
  });
  const controlledArtifacts = {
    ...artifacts,
    clusters: [...refsByCluster].map(([clusterRef, observationRefs]) => ({
      clusterRef,
      observationRefs,
      blockingKey: clusterRef,
    })),
  };
  return evaluateProductionChronicleArtifacts(prepared, controlledArtifacts);
}

describe("productionChronicleAdapter", () => {
  it("observes all eight dimensions through the production stages without Apply", async () => {
    const { artifacts, evaluation } = await runPassingCase();
    const actual = evaluation.actual.observations[0];

    expect(artifacts.matches).toEqual([
      {
        hypothesisId: "hypothesis-1",
        match: { status: "none" },
      },
    ]);
    expect(artifacts.plannedProposals).toHaveLength(1);
    expect(actual?.semanticKey).toBe("north-gate-collapse");
    expect(
      Object.values(actual?.dimensions ?? {}).every(
        (dimension) => dimension?.status === "observed",
      ),
    ).toBe(true);
    expect(actual?.dimensions.evidence).toEqual({
      status: "observed",
      value: [
        {
          documentId: "scene-a",
          quote: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
        },
      ],
    });
    expect(actual?.dimensions.clustering).toEqual({
      status: "observed",
      value: "c0",
    });
    expect(evaluation.actual.appliedProposalIds).toEqual([]);
    expect(evaluation.passed).toBe(true);
    expect(
      isCertificationEligible({
        diagnosticOnly: false,
        cases: [{ evaluation }],
      }),
    ).toBe(true);
  });

  it("scores production clustering by pairwise grouping without Gold labels", async () => {
    const equivalent = await evaluateClusterGroups(
      ["gold-collapse", "gold-collapse", "gold-aftermath"],
      ["production-group-a", "production-group-a", "production-group-b"],
    );

    expect(
      equivalent.actual.observations.map(
        (observation) =>
          observation.dimensions.clustering?.status === "observed" &&
          observation.dimensions.clustering.value,
      ),
    ).toEqual(["c0", "c0", "c1"]);
    expect(equivalent.dimensions.clustering).toEqual({
      truePositive: 3,
      falsePositive: 0,
      falseNegative: 0,
      unobservable: 0,
    });
    expect(equivalent.passed).toBe(true);

    const different = await evaluateClusterGroups(
      ["gold-collapse", "gold-collapse", "gold-aftermath"],
      ["production-group-a", "production-group-b", "production-group-b"],
    );
    expect(different.dimensions.clustering.falsePositive).toBeGreaterThan(0);
    expect(different.dimensions.clustering.falseNegative).toBeGreaterThan(0);
    expect(different.passed).toBe(false);
  });

  it("merges observations with identical evidence before clustering", async () => {
    const prepared = await prepareProductionChronicleEvalCase(miniCase());
    const synthesizeWithAi = vi.fn(
      async ({
        clusterRef,
        observations,
      }: Parameters<
        NonNullable<ProductionChroniclePipelineDeps["synthesizeWithAi"]>
      >[0]) =>
        [
          {
            hypothesisId: "hypothesis-merged",
            clusterRef,
            observationRefs: observations.map((entry) => entry.localId),
            titleSuggestion: "北門の倒壊",
            summary: "北門が倒壊した",
            actuality: "actual",
            significance: "major",
          },
        ] satisfies readonly EventHypothesis[],
    );
    const artifacts = await runProductionChroniclePipeline(prepared, {
      observeWithAi: async ({ windows }) => {
        const window = windows[0];
        if (!window) throw new Error("missing extraction window");
        const evidence = [
          {
            sourceRef: window.sourceRef,
            quote: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
          },
        ];
        return [
          {
            localId: "obs-1",
            evidence,
            assertion: {
              attribution: "narrator",
              narrativeFrame: "story-world",
            },
            payload: {
              predicate: "北門が倒れた",
              actuality: "actual",
              participants: [],
              temporalExpressions: [],
              durationKind: "instant",
            },
          },
          {
            localId: "obs-2",
            evidence,
            assertion: {
              attribution: "narrator",
              narrativeFrame: "story-world",
            },
            payload: {
              predicate: "門扉が街路へ倒れた",
              actuality: "actual",
              participants: [],
              temporalExpressions: [],
              durationKind: "instant",
            },
          },
        ];
      },
      synthesizeWithAi,
    });

    expect(artifacts.observations).toHaveLength(1);
    expect(artifacts.clusters).toHaveLength(1);
    expect(synthesizeWithAi).toHaveBeenCalledTimes(1);
    expect(synthesizeWithAi.mock.calls[0]?.[0].observations).toHaveLength(1);
  });

  it("does not make complete or absence claims for partial coverage", async () => {
    const { evaluation } = await runPassingCase(miniCase("partial"));

    expect(
      evaluation.actual.coverageClaims?.some(
        (claim) => claim.kind === "complete" || claim.kind === "absence",
      ) ?? false,
    ).toBe(false);
  });

  it("rejects certification when any dimension remains unobservable", async () => {
    const { evaluation } = await runPassingCase();
    const incomplete = {
      ...evaluation,
      unobservableDimensions: [
        {
          actualObservationId: "obs-1",
          dimension: "significance" as const,
          reason: "missing synthesis result",
        },
      ],
    };

    expect(
      isCertificationEligible({
        diagnosticOnly: false,
        cases: [{ evaluation: incomplete }],
      }),
    ).toBe(false);
  });

  it("fails closed when the production observation response has the wrong shape", async () => {
    const prepared = await prepareProductionChronicleEvalCase(miniCase());
    const artifacts = await runProductionChroniclePipeline(prepared, {
      observeWithAi: (input) =>
        runObservationExtractionTask({
          ...input,
          send: async () => ({
            text: '{"wrong":[]}',
            inputTokens: 1,
            outputTokens: 1,
          }),
        }),
    });
    const evaluation = evaluateProductionChronicleArtifacts(
      prepared,
      artifacts,
    );

    expect(evaluation.parseFailureCount).toBe(1);
    expect(evaluation.passed).toBe(false);
    expect(
      isCertificationEligible({
        diagnosticOnly: false,
        cases: [{ evaluation }],
      }),
    ).toBe(false);
  });

  it("fails closed when the production synthesis response has the wrong shape", async () => {
    const prepared = await prepareProductionChronicleEvalCase(miniCase());
    const sourceRef = prepared.windows[0]?.sourceRef;
    if (!sourceRef) throw new Error("fixture did not create a Source View");
    const artifacts = await runProductionChroniclePipeline(prepared, {
      observeWithAi: async () => [
        {
          localId: "obs-1",
          evidence: [
            {
              sourceRef,
              quote: "北門の鎖が切れ、重い門扉が街路へ倒れた。",
            },
          ],
          assertion: {
            attribution: "narrator",
            narrativeFrame: "story-world",
          },
          payload: {
            predicate: "北門が倒れた",
            actuality: "actual",
            participants: [],
            temporalExpressions: [],
            durationKind: "instant",
          },
        },
      ],
      synthesizeWithAi: (input) =>
        runEventSynthesisTask({
          ...input,
          send: async () => ({
            text: '{"wrong":[]}',
            inputTokens: 1,
            outputTokens: 1,
          }),
        }),
    });
    const evaluation = evaluateProductionChronicleArtifacts(
      prepared,
      artifacts,
    );

    expect(evaluation.parseFailureCount).toBe(1);
    expect(evaluation.passed).toBe(false);
  });
});
