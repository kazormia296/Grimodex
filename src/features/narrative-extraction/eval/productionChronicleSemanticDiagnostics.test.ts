import path from "node:path";
import { describe, expect, it } from "vitest";
import { CITATION_ID_OBSERVATION_EVIDENCE_MODE } from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import { loadNarrativeEvalSuite } from "./narrativeEvalSuite";
import {
  evaluateProductionChronicleArtifacts,
  prepareProductionChronicleEvalCase,
  runProductionChroniclePipeline,
} from "./productionChronicleAdapter";
import { buildProductionChronicleSemanticDiagnostics } from "./productionChronicleSemanticDiagnostics";
import { NARRATIVE_EVAL_DIMENSIONS } from "./types";

const CASE_ID = "chronicle.micro.actual-gate-collapse-001";
const MAIN_QUOTE = "北門の鎖が切れ、重い門扉が街路へ倒れた。";
const EXTRA_SUPPORTED_QUOTE = "衛兵は鐘を鳴らし、通行人を広場へ退避させた。";
const CITATION_EXPANDED_QUOTE =
  "夜半、北門の鎖が切れ、重い門扉が街路へ倒れた。";
const UNSUPPORTED_QUOTE = "存在しない門の崩落が起きた。";

type Control =
  | "main"
  | "supported-extra"
  | "minor-extra"
  | "expanded-quote"
  | "predicate-only-wrong"
  | "role-only-wrong"
  | "empty-output"
  | "unsupported-extra";

function makeObservation(
  sourceRef: string,
  localId: string,
  quote: string,
  predicate: string,
  participants: RawChronicleEventObservation["payload"]["participants"] = [],
): RawChronicleEventObservation {
  return {
    localId,
    evidence: [{ sourceRef, quote }],
    assertion: {
      attribution: "narrator",
      narrativeFrame: "story-world",
    },
    payload: {
      predicate,
      actuality: "actual",
      participants,
      temporalExpressions: [],
      durationKind: "instant",
    },
  };
}

async function runControl(control: Control) {
  const repoRoot = path.resolve(import.meta.dirname, "../../../..");
  const suite = await loadNarrativeEvalSuite({
    repoRoot,
    suiteId: "chronicle-micro-v1",
  });
  const evalCase = suite.cases.find((candidate) => candidate.id === CASE_ID);
  if (!evalCase) throw new Error(`Missing control case ${CASE_ID}`);
  const citationMode = control === "expanded-quote";
  const prepared = await prepareProductionChronicleEvalCase(evalCase, {
    ...(citationMode
      ? { evidenceMode: CITATION_ID_OBSERVATION_EVIDENCE_MODE }
      : {}),
  });
  const sourceRef = prepared.windows[0]?.sourceRef;
  if (!sourceRef) throw new Error("Control case did not create a Source View");
  const controlSourceRef = citationMode
    ? prepared.evidenceSpanCatalog?.entries.find(
        (entry) => entry.quote === CITATION_EXPANDED_QUOTE,
      )?.sourceRef
    : sourceRef;
  if (!controlSourceRef) {
    throw new Error("Citation control did not find its catalog span");
  }

  const observations =
    control === "empty-output"
      ? []
      : [
          makeObservation(
            controlSourceRef,
            "control-main",
            citationMode ? CITATION_EXPANDED_QUOTE : MAIN_QUOTE,
            control === "predicate-only-wrong"
              ? "門扉の街路転倒"
              : "北門の倒壊",
            control === "role-only-wrong"
              ? [{ surface: "街路", role: "agent" }]
              : [],
          ),
        ];
  if (control === "supported-extra" || control === "minor-extra") {
    observations.push(
      makeObservation(
        controlSourceRef,
        "control-extra",
        EXTRA_SUPPORTED_QUOTE,
        "衛兵による退避誘導",
      ),
    );
  }
  if (control === "unsupported-extra") {
    observations[0] = makeObservation(
      controlSourceRef,
      "control-extra",
      UNSUPPORTED_QUOTE,
      "存在しない門の崩落",
    );
  }

  const artifacts = await runProductionChroniclePipeline(prepared, {
    createId: (() => {
      let index = 0;
      return () => `semantic-diagnostic-id-${++index}`;
    })(),
    observeWithAi: async () => observations,
    synthesizeWithAi: async ({
      clusterRef,
      observations: clusterObservations,
    }) => {
      const observation = clusterObservations[0];
      if (!observation) return [];
      const isMinorExtra =
        control === "minor-extra" &&
        observation.payload.predicate === "衛兵による退避誘導";
      return [
        {
          hypothesisId: `hypothesis-${clusterRef}`,
          clusterRef,
          observationRefs: clusterObservations.map((entry) => entry.localId),
          titleSuggestion: "制御されたイベント",
          summary: "制御用の合成仮説",
          actuality: "actual",
          significance: isMinorExtra ? "minor" : "major",
        },
      ] satisfies readonly EventHypothesis[];
    },
  });
  const evaluation = evaluateProductionChronicleArtifacts(prepared, artifacts);
  const diagnostics = buildProductionChronicleSemanticDiagnostics(
    prepared,
    artifacts,
    evaluation,
  );
  return { artifacts, diagnostics, evaluation, prepared };
}

function zeroReasons() {
  return {
    missingRequiredCount: 0,
    extraOutputCount: 0,
    noExactEvidenceMatchCount: 0,
    dimensionValueMismatchCount: 0,
    dimensionUnobservableCount: 0,
  };
}

describe("production Chronicle semantic diagnostics", () => {
  it("reports a fixed numeric shape for an exact main event", async () => {
    const { diagnostics, evaluation } = await runControl("main");

    expect(diagnostics).toEqual({
      schemaVersion: 1,
      requiredCount: 1,
      scoredCount: 1,
      matchedRequiredCount: 1,
      unmatchedRequiredCount: 0,
      unmatchedOutputCount: 0,
      dimensions: Object.fromEntries(
        NARRATIVE_EVAL_DIMENSIONS.map((dimension) => [
          dimension,
          {
            truePositive: 1,
            falsePositive: 0,
            falseNegative: 0,
            unobservable: 0,
          },
        ]),
      ),
      reasons: zeroReasons(),
    });
    expect(evaluation.passed).toBe(true);
    expect(Object.keys(diagnostics)).toEqual([
      "schemaVersion",
      "requiredCount",
      "scoredCount",
      "matchedRequiredCount",
      "unmatchedRequiredCount",
      "unmatchedOutputCount",
      "dimensions",
      "reasons",
    ]);
  });

  it.each(["supported-extra", "minor-extra"] as const)(
    "counts a %s output and applies the expected proposal gate",
    async (control) => {
      const { artifacts, diagnostics, evaluation } = await runControl(control);

      expect(diagnostics.requiredCount).toBe(1);
      expect(diagnostics.scoredCount).toBe(2);
      expect(diagnostics.matchedRequiredCount).toBe(1);
      expect(diagnostics.unmatchedRequiredCount).toBe(0);
      expect(diagnostics.unmatchedOutputCount).toBe(1);
      expect(diagnostics.reasons).toEqual({
        missingRequiredCount: 0,
        extraOutputCount: 1,
        noExactEvidenceMatchCount: 1,
        dimensionValueMismatchCount: 0,
        dimensionUnobservableCount: 0,
      });
      for (const dimension of NARRATIVE_EVAL_DIMENSIONS) {
        expect(diagnostics.dimensions[dimension]).toEqual({
          truePositive: 1,
          falsePositive: 1,
          falseNegative: 0,
          unobservable: 0,
        });
      }
      expect(evaluation.passed).toBe(false);
      expect(artifacts.plannedProposals).toHaveLength(
        control === "minor-extra" ? 1 : 2,
      );
    },
  );

  it("distinguishes an expanded quote from an exact evidence tuple", async () => {
    const { diagnostics, evaluation, prepared } =
      await runControl("expanded-quote");

    const catalogQuotes =
      prepared.evidenceSpanCatalog?.entries.map((entry) => entry.quote) ?? [];
    expect(catalogQuotes).toContain(CITATION_EXPANDED_QUOTE);
    expect(catalogQuotes).not.toContain(MAIN_QUOTE);

    expect(diagnostics).toMatchObject({
      requiredCount: 1,
      scoredCount: 1,
      matchedRequiredCount: 0,
      unmatchedRequiredCount: 1,
      unmatchedOutputCount: 1,
      reasons: {
        missingRequiredCount: 1,
        extraOutputCount: 1,
        noExactEvidenceMatchCount: 1,
        dimensionValueMismatchCount: 0,
        dimensionUnobservableCount: 0,
      },
    });
    expect(evaluation.passed).toBe(false);
    expect(evaluation.unresolvedEvidenceCount).toBe(0);
    expect(evaluation.dimensions.clustering.falseNegative).toBe(0);
  });

  it("counts a valid empty output as a missing required observation", async () => {
    const { diagnostics, evaluation } = await runControl("empty-output");

    expect(diagnostics).toMatchObject({
      requiredCount: 1,
      scoredCount: 0,
      matchedRequiredCount: 0,
      unmatchedRequiredCount: 1,
      unmatchedOutputCount: 0,
      reasons: {
        missingRequiredCount: 1,
        extraOutputCount: 0,
        noExactEvidenceMatchCount: 0,
        dimensionValueMismatchCount: 0,
        dimensionUnobservableCount: 0,
      },
    });
    for (const dimension of NARRATIVE_EVAL_DIMENSIONS) {
      expect(diagnostics.dimensions[dimension]).toEqual({
        truePositive: 0,
        falsePositive: 0,
        falseNegative: dimension === "clustering" ? 0 : 1,
        unobservable: 0,
      });
    }
    expect(evaluation.passed).toBe(false);
  });

  it.each(["predicate-only-wrong", "role-only-wrong"] as const)(
    "preserves the current scorer blind spot for %s controls",
    async (control) => {
      const { diagnostics, evaluation } = await runControl(control);

      expect(evaluation.passed).toBe(true);
      expect(diagnostics.matchedRequiredCount).toBe(1);
      expect(diagnostics.reasons).toEqual(zeroReasons());
      for (const dimension of NARRATIVE_EVAL_DIMENSIONS) {
        expect(diagnostics.dimensions[dimension]).toEqual({
          truePositive: 1,
          falsePositive: 0,
          falseNegative: 0,
          unobservable: 0,
        });
      }
    },
  );

  it("counts unsupported evidence as an extra and preserves the unresolved failure", async () => {
    const { artifacts, diagnostics, evaluation } =
      await runControl("unsupported-extra");

    expect(diagnostics).toMatchObject({
      requiredCount: 1,
      scoredCount: 1,
      matchedRequiredCount: 0,
      unmatchedRequiredCount: 1,
      unmatchedOutputCount: 1,
      reasons: {
        missingRequiredCount: 1,
        extraOutputCount: 1,
        noExactEvidenceMatchCount: 1,
        dimensionValueMismatchCount: 0,
        dimensionUnobservableCount: 0,
      },
    });
    expect(artifacts.anchors).toHaveLength(0);
    expect(evaluation.unresolvedEvidenceCount).toBe(1);
    expect(evaluation.passed).toBe(false);
  });
});
