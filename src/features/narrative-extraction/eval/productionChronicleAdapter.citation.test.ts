import { describe, expect, it, vi } from "vitest";
import { CITATION_ID_OBSERVATION_EVIDENCE_MODE } from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import { runObservationExtractionTask } from "@/application/narrative-extraction/aiTasks/runObservationExtractionTask";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { NarrativeEvalCaseV1 } from "./types";
import {
  evaluateProductionChronicleArtifacts,
  prepareProductionChronicleEvalCase,
  runProductionChroniclePipeline,
} from "./productionChronicleAdapter";

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
    getState: () => ({ projectId: "narrative-eval-citation-production" }),
  },
}));

function syntheticCase(): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1,
    id: "chronicle.micro.citation-id-production",
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-09-05T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: ["scene-a", "scene-b"],
      omittedDocumentIds: [],
    },
    documents: [
      {
        id: "scene-a",
        title: "第一場",
        text: "同じ文。門が開いた。",
      },
      {
        id: "scene-b",
        title: "第二場",
        text: "同じ文。灯りが消えた。",
      },
    ],
    expected: {
      observations: { required: [], forbidden: [] },
    },
    criticalViolationClasses: [],
  };
}

function case015CorpusOnly(): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1,
    id: "chronicle.micro.sword-recovered-015-citation-id",
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-09-05T00:00:00.000Z",
    coverage: {
      mode: "complete",
      includedDocumentIds: [
        "scene-sword-setup-recovered",
        "scene-sword-use-recovered",
      ],
      omittedDocumentIds: [],
    },
    // These are corpus words only. The fixed v2 claim below is deliberately
    // authored here, instead of being read from Gold or a v1 raw fixture.
    documents: [
      {
        id: "scene-sword-setup-recovered",
        title: "儀礼剣の発見",
        text: "謁見の間の壁には、刃こぼれした儀礼剣が一本掛けられていた。柄には王家の紋章が刻まれ、長いあいだ誰も触れていなかった。",
      },
      {
        id: "scene-sword-use-recovered",
        title: "儀礼剣の使用",
        text: "火の粉が梁へ移り、地下牢の出口が塞がれかけた。ミナは壁の儀礼剣を引き抜き、捕虜を縛る縄を切った。捕虜は煙の薄い階段へ逃れた。",
      },
    ],
    expected: { observations: { required: [], forbidden: [] } },
    criticalViolationClasses: [],
  };
}

function idResponse(
  aliases: string | readonly string[],
  predicate: string,
): string {
  const evidenceRefs = typeof aliases === "string" ? [aliases] : aliases;
  return JSON.stringify({
    observations: [
      {
        localId: "same-model-id",
        evidenceRefs,
        assertion: {
          attribution: "narrator",
          narrativeFrame: "story-world",
        },
        payload: {
          // This is intentionally not derived from the quote. The production
          // task must preserve the complete claim while replacing only refs.
          predicate,
          actuality: "actual",
          participants: [],
          temporalExpressions: [],
          durationKind: "instant",
        },
      },
    ],
  });
}

describe("productionChronicleAdapter citation-ID mode", () => {
  it("keeps per-window binding, occurrence Source Views, and tuple identity through scoring", async () => {
    const prepared = await prepareProductionChronicleEvalCase(syntheticCase(), {
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    });
    const predicates: string[] = [];
    const artifacts = await runProductionChroniclePipeline(prepared, {
      createId: (() => {
        let index = 0;
        return () => `citation-production-${++index}`;
      })(),
      observeWithAi: (input) => {
        const boundWindow = input.windows[0];
        const binding = input.evidenceSpanCatalogBinding;
        if (!boundWindow || !binding) {
          throw new Error("citation production input lost its window binding");
        }
        const alias = binding.aliases[0]?.alias;
        if (!alias) throw new Error("citation production alias is missing");
        const predicate =
          predicates.length === 0 ? "門が開いた" : "wrong-meaning-b";
        predicates.push(predicate);
        return runObservationExtractionTask({
          ...input,
          send: async () => ({
            text: idResponse(alias, predicate),
            inputTokens: 1,
            outputTokens: 1,
          }),
        });
      },
      synthesizeWithAi: async ({ clusterRef, observations }) =>
        [
          {
            hypothesisId: `hypothesis-${clusterRef}`,
            clusterRef,
            observationRefs: observations.map((entry) => entry.localId),
            titleSuggestion: "同じ文の観測",
            summary: "同じ文に関する仮説",
            actuality: "actual",
            significance: "major",
          },
        ] satisfies readonly EventHypothesis[],
    });

    const evaluation = evaluateProductionChronicleArtifacts(
      prepared,
      artifacts,
    );
    expect(artifacts.observations).toHaveLength(2);
    expect(artifacts.observations.map((entry) => entry.localId)).toEqual([
      "eval-window-001:obs-001",
      "eval-window-002:obs-001",
    ]);
    expect(artifacts.observations.map((entry) => entry.evidence[0])).toEqual([
      { sourceRef: "E000001", quote: "同じ文。" },
      { sourceRef: "E000003", quote: "同じ文。" },
    ]);
    expect(
      artifacts.observations.map((entry) => entry.payload.predicate),
    ).toEqual(["門が開いた", "wrong-meaning-b"]);
    expect(artifacts.anchors.map((anchor) => anchor.sourceRef)).toEqual([
      "E000001",
      "E000003",
    ]);
    expect(artifacts.unresolvedEvidenceCount).toBe(0);
    expect(evaluation.unresolvedEvidenceCount).toBe(0);
  });

  it("fails closed when a fixed ID prediction mixes an alias with a foreign ref", async () => {
    const prepared = await prepareProductionChronicleEvalCase(syntheticCase(), {
      evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE,
    });
    await expect(
      runProductionChroniclePipeline(prepared, {
        observeWithAi: (input) => {
          const binding = input.evidenceSpanCatalogBinding;
          const alias = binding?.aliases[0]?.alias;
          if (!alias) throw new Error("citation production alias is missing");
          return runObservationExtractionTask({
            ...input,
            send: async () => ({
              text: idResponse([alias, "Eforeign-token-999"], "bad"),
              inputTokens: 1,
              outputTokens: 1,
            }),
          });
        },
      }),
    ).rejects.toThrow(/foreign|unknown|citation|reference/i);
  });

  it("routes the case-015 corpus through v2 with an independently authored correct claim", async () => {
    const prepared = await prepareProductionChronicleEvalCase(
      case015CorpusOnly(),
      { evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE },
    );
    const targetEntry = prepared.evidenceSpanCatalog?.entries.find(
      (entry) =>
        entry.quote === "ミナは壁の儀礼剣を引き抜き、捕虜を縛る縄を切った。",
    );
    if (!targetEntry) throw new Error("case-015 target occurrence is missing");
    const targetWindow = prepared.windows.find(
      (window) =>
        prepared.documentIdBySourceRef.get(window.sourceRef) ===
        "scene-sword-use-recovered",
    );
    if (!targetWindow?.windowId)
      throw new Error("case-015 target window missing");
    const targetBinding = prepared.evidenceSpanCatalogBindingsByWindowId?.get(
      targetWindow.windowId,
    );
    const targetAlias = targetBinding?.aliases.find(
      (alias) => alias.canonicalSourceRef === targetEntry.sourceRef,
    )?.alias;
    if (!targetBinding || !targetAlias) {
      throw new Error("case-015 target alias is missing");
    }

    const artifacts = await runProductionChroniclePipeline(prepared, {
      observeWithAi: (input) => {
        const window = input.windows[0];
        const binding = input.evidenceSpanCatalogBinding;
        if (!window || !binding) throw new Error("case-015 binding missing");
        const alias = binding.aliases.find(
          (entry) => entry.canonicalSourceRef === targetEntry.sourceRef,
        )?.alias;
        const response = alias
          ? idResponse(alias, "ミナが儀礼剣を使って、捕虜を縛る縄を切った")
          : JSON.stringify({ observations: [] });
        return runObservationExtractionTask({
          ...input,
          send: async () => ({
            text: response,
            inputTokens: 1,
            outputTokens: 1,
          }),
        });
      },
      synthesizeWithAi: async ({ clusterRef, observations }) =>
        [
          {
            hypothesisId: "case-015-hypothesis",
            clusterRef,
            observationRefs: observations.map((entry) => entry.localId),
            titleSuggestion: "捕虜の縄切断",
            summary: "ミナが捕虜の縄を切った",
            actuality: "actual",
            significance: "major",
          },
        ] satisfies readonly EventHypothesis[],
    });

    expect(artifacts.observations).toHaveLength(1);
    expect(artifacts.observations[0]?.payload.predicate).toBe(
      "ミナが儀礼剣を使って、捕虜を縛る縄を切った",
    );
    expect(artifacts.observations[0]?.evidence).toEqual([
      {
        sourceRef: targetEntry.sourceRef,
        quote: targetEntry.quote,
      },
    ]);
    expect(artifacts.anchors).toHaveLength(1);
    expect(artifacts.anchors[0]?.canonicalRange).toEqual(
      targetEntry.canonicalRange,
    );
    expect(artifacts.unresolvedEvidenceCount).toBe(0);
  });
});
