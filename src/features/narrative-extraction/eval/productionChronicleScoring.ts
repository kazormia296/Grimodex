import { scoreNarrativeEvalCase } from "./scorer";
import { chronicleEvidenceTupleKey } from "@/features/chronicle/extraction/evidenceTupleKey";
import type {
  PreparedProductionChronicleEvalCase,
  ProductionChronicleArtifacts,
  ProductionChronicleCertificationReportLike,
  ProductionChronicleEvaluation,
} from "./productionChronicleTypes";
import type {
  NarrativeActualGraph,
  NarrativeCriticalViolation,
  NarrativeEvalCaseV1,
  NarrativeEvalExpectedObservation,
} from "./types";

function evidenceFingerprint(sourceRef: string, quote: string): string {
  return chronicleEvidenceTupleKey(sourceRef, quote);
}

function goldEvidenceKey(documentId: string, quote: string): string {
  return chronicleEvidenceTupleKey(documentId, quote);
}

function alignRequiredObservation(
  required: readonly NarrativeEvalExpectedObservation[],
  evidence: readonly { documentId: string; quote: string }[],
  usedExpectationIds: Set<string>,
): NarrativeEvalExpectedObservation | undefined {
  const actualKeys = new Set(
    evidence.map((item) => goldEvidenceKey(item.documentId, item.quote)),
  );
  return required.find(
    (expected) =>
      !usedExpectationIds.has(expected.id) &&
      (expected.dimensions.evidence ?? []).some((item) =>
        actualKeys.has(goldEvidenceKey(item.documentId, item.quote)),
      ),
  );
}

function normalizeClusterLabels(
  entries: readonly { readonly key: string; readonly clusterLabel: string }[],
): Map<string, string> {
  const normalizedByKey = new Map<string, string>();
  const classByClusterLabel = new Map<string, string>();
  for (const entry of entries) {
    let normalized = classByClusterLabel.get(entry.clusterLabel);
    if (!normalized) {
      normalized = `c${classByClusterLabel.size}`;
      classByClusterLabel.set(entry.clusterLabel, normalized);
    }
    normalizedByKey.set(entry.key, normalized);
  }
  return normalizedByKey;
}

function withoutClustering(
  dimensions: NarrativeEvalExpectedObservation["dimensions"],
): NarrativeEvalExpectedObservation["dimensions"] {
  const { clustering: _clustering, ...rest } = dimensions;
  return rest;
}

function buildScoringInputs(
  prepared: PreparedProductionChronicleEvalCase,
  artifacts: ProductionChronicleArtifacts,
): {
  readonly actual: NarrativeActualGraph;
  readonly evalCase: NarrativeEvalCaseV1;
} {
  const clusterByObservationId = new Map(
    artifacts.clusters.flatMap((cluster) =>
      cluster.observationRefs.map((ref) => [ref, cluster.clusterRef] as const),
    ),
  );
  const hypothesesByObservationId = new Map<
    string,
    (typeof artifacts.hypotheses)[number][]
  >();
  for (const hypothesis of artifacts.hypotheses) {
    for (const ref of hypothesis.observationRefs) {
      const hypotheses = hypothesesByObservationId.get(ref) ?? [];
      hypotheses.push(hypothesis);
      hypothesesByObservationId.set(ref, hypotheses);
    }
  }
  const proposedHypothesisIds = new Set(
    artifacts.plannedProposals.map((entry) => entry.hypothesisId),
  );
  const resolvedEvidence = new Set(
    artifacts.anchors.map((anchor) =>
      evidenceFingerprint(anchor.sourceRef, anchor.quote),
    ),
  );
  const usedExpectationIds = new Set<string>();

  const alignedObservations = artifacts.observations.map((observation) => {
    const evidence = observation.evidence.flatMap((item) => {
      if (
        !resolvedEvidence.has(evidenceFingerprint(item.sourceRef, item.quote))
      )
        return [];
      const documentId = prepared.documentIdBySourceRef.get(item.sourceRef);
      return documentId ? [{ documentId, quote: item.quote }] : [];
    });
    const expected = alignRequiredObservation(
      prepared.evalCase.expected.observations.required,
      evidence,
      usedExpectationIds,
    );
    if (expected) usedExpectationIds.add(expected.id);
    return {
      observation,
      evidence,
      expected,
      clusterRef:
        clusterByObservationId.get(observation.localId) ?? "not-clustered",
    };
  });
  const alignedByExpectationId = new Map(
    alignedObservations.flatMap((entry) =>
      entry.expected ? [[entry.expected.id, entry] as const] : [],
    ),
  );
  const matchedRequiredWithClustering =
    prepared.evalCase.expected.observations.required.filter(
      (expected) =>
        typeof expected.dimensions.clustering === "string" &&
        alignedByExpectationId.has(expected.id),
    );
  const normalizedExpectedClustering = normalizeClusterLabels(
    matchedRequiredWithClustering.map((expected) => ({
      key: expected.id,
      clusterLabel: expected.dimensions.clustering as string,
    })),
  );
  const normalizedActualClustering = normalizeClusterLabels(
    matchedRequiredWithClustering.map((expected) => ({
      key: expected.id,
      clusterLabel:
        alignedByExpectationId.get(expected.id)?.clusterRef ?? "not-clustered",
    })),
  );
  const scoringCase: NarrativeEvalCaseV1 = {
    ...prepared.evalCase,
    expected: {
      ...prepared.evalCase.expected,
      observations: {
        ...prepared.evalCase.expected.observations,
        required: prepared.evalCase.expected.observations.required.map(
          (expected) => {
            if (expected.dimensions.clustering === undefined) return expected;
            const normalized = normalizedExpectedClustering.get(expected.id);
            return {
              ...expected,
              dimensions: normalized
                ? { ...expected.dimensions, clustering: normalized }
                : withoutClustering(expected.dimensions),
            };
          },
        ),
      },
    },
  };

  const observations = alignedObservations.map(
    ({ observation, evidence, expected, clusterRef }) => {
      const hypotheses =
        hypothesesByObservationId.get(observation.localId) ?? [];
      const hypothesis =
        hypotheses.find((entry) =>
          proposedHypothesisIds.has(entry.hypothesisId),
        ) ?? hypotheses[0];
      return {
        id: observation.localId,
        semanticKey:
          expected?.semanticKey ??
          `production-observation:${observation.localId}`,
        dimensions: {
          eventDetection: { status: "observed" as const, value: true },
          actuality: {
            status: "observed" as const,
            value: observation.payload.actuality,
          },
          attribution: {
            status: "observed" as const,
            value: observation.assertion.attribution,
          },
          narrativeFrame: {
            status: "observed" as const,
            value: observation.assertion.narrativeFrame,
          },
          evidence: { status: "observed" as const, value: evidence },
          clustering: {
            status: "observed" as const,
            value:
              (expected && normalizedActualClustering.get(expected.id)) ??
              clusterRef,
          },
          significance: {
            status: "observed" as const,
            value: hypothesis?.significance ?? "not-synthesized",
          },
          proposalGate: {
            status: "observed" as const,
            value:
              hypothesis && proposedHypothesisIds.has(hypothesis.hypothesisId)
                ? "propose"
                : "suppress",
          },
        },
      };
    },
  );

  return {
    actual: {
      observations,
      coverageClaims:
        prepared.evalCase.coverage.mode === "partial"
          ? [{ kind: "resolved", value: "partial-corpus" }]
          : [],
      appliedProposalIds: [],
    },
    evalCase: scoringCase,
  };
}

export function evaluateProductionChronicleArtifacts(
  prepared: PreparedProductionChronicleEvalCase,
  artifacts: ProductionChronicleArtifacts,
): ProductionChronicleEvaluation {
  const { actual, evalCase } = buildScoringInputs(prepared, artifacts);
  const score = scoreNarrativeEvalCase(evalCase, actual);
  const adapterViolations: NarrativeCriticalViolation[] = [];
  if (artifacts.parseFailureCount > 0) {
    adapterViolations.push({
      classId: "parse-failure-as-empty",
      message: `${artifacts.parseFailureCount} production stage response(s) failed parsing`,
    });
  }
  if (artifacts.unresolvedEvidenceCount > 0) {
    adapterViolations.push({
      classId: "unresolved-evidence",
      message: `${artifacts.unresolvedEvidenceCount} evidence reference(s) did not resolve`,
    });
  }
  const criticalViolations = [
    ...score.criticalViolations,
    ...adapterViolations,
  ];
  return {
    ...score,
    actual,
    parseFailureCount: artifacts.parseFailureCount,
    unresolvedEvidenceCount: artifacts.unresolvedEvidenceCount,
    criticalViolations,
    passed: score.passed && criticalViolations.length === 0,
  };
}

export function isCertificationEligible(
  report: ProductionChronicleCertificationReportLike,
): boolean {
  return (
    report.diagnosticOnly !== true &&
    report.cases.length > 0 &&
    report.cases.every(({ evaluation }) => {
      const noDimensionIsUnobservable = Object.values(
        evaluation.dimensions,
      ).every((dimension) => dimension.unobservable === 0);
      return (
        evaluation.passed &&
        evaluation.parseFailureCount === 0 &&
        evaluation.unresolvedEvidenceCount === 0 &&
        evaluation.criticalViolations.length === 0 &&
        evaluation.unobservableDimensions.length === 0 &&
        noDimensionIsUnobservable
      );
    })
  );
}
