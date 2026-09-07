import { describe, expect, it, vi } from "vitest";
import {
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
  LEGACY_OBSERVATION_EVIDENCE_MODE,
  type ObservationEvidenceMode,
} from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import {
  prepareObservationEvalCase,
  runProductionObservationExtraction,
} from "./observationAdapter";
import type { NarrativeEvalCaseV1 } from "./types";

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
    getState: () => ({ projectId: "narrative-eval-observation-identity" }),
  },
}));

const CLAIMS = [
  { predicate: "門が開いた", quote: "門が開いた。" },
  { predicate: "灯りが消えた", quote: "灯りが消えた。" },
] as const;

function identityCase(requiredCount: 1 | 2): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1,
    id: `chronicle.micro.observation-identity-${requiredCount}`,
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-09-05T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: ["scene-gate", "scene-light"],
      omittedDocumentIds: [],
    },
    documents: [
      {
        id: "scene-gate",
        title: "門前",
        text: CLAIMS[0].quote,
      },
      {
        id: "scene-light",
        title: "灯台",
        text: CLAIMS[1].quote,
      },
    ],
    expected: {
      observations: {
        required: CLAIMS.slice(0, requiredCount).map((claim, index) => ({
          id: `required-${index + 1}`,
          semanticKey: `observation:${claim.predicate}:${index}`,
          dimensions: { eventDetection: true },
        })),
        forbidden: [],
      },
    },
    criticalViolationClasses: [],
  };
}

function responseForWindow(
  mode: ObservationEvidenceMode,
  prepared: Awaited<ReturnType<typeof prepareObservationEvalCase>>,
  index: number,
): string {
  const claim = CLAIMS[index];
  const window = prepared.windows[index];
  if (!claim || !window)
    throw new Error(`missing identity fixture window ${index}`);

  if (mode === CITATION_ID_OBSERVATION_EVIDENCE_MODE) {
    const binding = prepared.evidenceSpanCatalogBindingsByWindowId?.get(
      window.windowId ?? "",
    );
    const alias = binding?.aliases[0]?.alias;
    if (!alias)
      throw new Error(`missing citation alias for ${window.windowId}`);
    return JSON.stringify({
      observations: [
        {
          localId: "obs-1",
          evidenceRefs: [alias],
          assertion: {
            attribution: "narrator",
            narrativeFrame: "story-world",
          },
          payload: {
            predicate: claim.predicate,
            actuality: "actual",
            participants: [],
            temporalExpressions: [],
            durationKind: "instant",
          },
        },
      ],
    });
  }

  return JSON.stringify({
    observations: [
      {
        localId: "obs-1",
        evidence: [{ sourceRef: window.sourceRef, quote: claim.quote }],
        assertion: {
          attribution: "narrator",
          narrativeFrame: "story-world",
        },
        payload: {
          predicate: claim.predicate,
          actuality: "actual",
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      },
    ],
  });
}

describe.each([
  LEGACY_OBSERVATION_EVIDENCE_MODE,
  CITATION_ID_OBSERVATION_EVIDENCE_MODE,
])("observationAdapter window identity (%s)", (evidenceMode) => {
  it.each([
    { requiredCount: 2 as const, truePositive: 2, falsePositive: 0 },
    { requiredCount: 1 as const, truePositive: 1, falsePositive: 1 },
  ])(
    "keeps two obs-1 responses independently scorable when $requiredCount claims are required",
    async ({ requiredCount, truePositive, falsePositive }) => {
      const prepared = await prepareObservationEvalCase(
        identityCase(requiredCount),
        { evidenceMode },
      );
      expect(prepared.windows).toHaveLength(2);

      let invocation = 0;
      const { evaluation, observations } =
        await runProductionObservationExtraction(prepared, async () => ({
          text: responseForWindow(evidenceMode, prepared, invocation++),
          inputTokens: 1,
          outputTokens: 1,
        }));

      expect(evaluation.parseStatus).toBe("parsed");
      expect(observations).toHaveLength(2);
      expect(
        new Set(observations.map((observation) => observation.localId)).size,
      ).toBe(2);
      expect(
        observations.map((observation) => observation.payload.predicate),
      ).toEqual(CLAIMS.map((claim) => claim.predicate));
      expect(
        observations.map((observation) => observation.evidence[0]?.quote),
      ).toEqual(CLAIMS.map((claim) => claim.quote));
      expect(
        new Set(
          observations.map((observation) => observation.evidence[0]?.sourceRef),
        ).size,
      ).toBe(2);
      expect(evaluation.dimensions.eventDetection).toEqual({
        truePositive,
        falsePositive,
        falseNegative: 0,
        unobservable: 0,
      });
    },
  );
});
