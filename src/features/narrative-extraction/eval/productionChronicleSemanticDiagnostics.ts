import { chronicleEvidenceTupleKey } from "@/features/chronicle/extraction/evidenceTupleKey";
import type {
  PreparedProductionChronicleEvalCase,
  ProductionChronicleArtifacts,
  ProductionChronicleEvaluation,
} from "./productionChronicleTypes";
import {
  NARRATIVE_EVAL_DIMENSIONS,
  type NarrativeActualObservation,
  type NarrativeEvalDimension,
} from "./types";

/** Version of the numeric-only per-case production diagnostics contract. */
export const PRODUCTION_CHRONICLE_SEMANTIC_DIAGNOSTICS_SCHEMA_VERSION =
  1 as const;
export const PRODUCTION_CHRONICLE_SEMANTIC_DIAGNOSTICS_MAX_COUNT =
  10_000 as const;

export const PRODUCTION_CHRONICLE_SEMANTIC_DIAGNOSTIC_REASON_KEYS = [
  "missingRequiredCount",
  "extraOutputCount",
  "noExactEvidenceMatchCount",
  "dimensionValueMismatchCount",
  "dimensionUnobservableCount",
] as const;

export type ProductionChronicleSemanticDiagnosticReason =
  (typeof PRODUCTION_CHRONICLE_SEMANTIC_DIAGNOSTIC_REASON_KEYS)[number];

export interface ProductionChronicleSemanticDiagnosticReasons {
  readonly missingRequiredCount: number;
  readonly extraOutputCount: number;
  readonly noExactEvidenceMatchCount: number;
  readonly dimensionValueMismatchCount: number;
  readonly dimensionUnobservableCount: number;
}

export interface ProductionChronicleSemanticDiagnostics {
  readonly schemaVersion: typeof PRODUCTION_CHRONICLE_SEMANTIC_DIAGNOSTICS_SCHEMA_VERSION;
  readonly requiredCount: number;
  /** Number of materialized production observations included in scoring. */
  readonly scoredCount: number;
  readonly matchedRequiredCount: number;
  readonly unmatchedRequiredCount: number;
  readonly unmatchedOutputCount: number;
  readonly dimensions: Readonly<
    Record<NarrativeEvalDimension, NumericDimensionScore>
  >;
  readonly reasons: ProductionChronicleSemanticDiagnosticReasons;
}

export interface NumericDimensionScore {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly unobservable: number;
}

interface ResolvedEvidence {
  readonly key: string;
}

interface AlignedObservation {
  readonly actual: NarrativeActualObservation;
  readonly evidenceKeys: readonly string[];
  readonly expectedId?: string;
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function assertCount(value: number, label: string): number {
  if (
    !isNonNegativeSafeInteger(value) ||
    value > PRODUCTION_CHRONICLE_SEMANTIC_DIAGNOSTICS_MAX_COUNT
  ) {
    throw new Error(
      `Production Chronicle semantic diagnostic ${label} must be an integer between 0 and ${PRODUCTION_CHRONICLE_SEMANTIC_DIAGNOSTICS_MAX_COUNT}`,
    );
  }
  return value;
}

function evidenceKey(documentId: string, quote: string): string {
  return chronicleEvidenceTupleKey(documentId, quote);
}

function sourceEvidenceKey(sourceRef: string, quote: string): string {
  return chronicleEvidenceTupleKey(sourceRef, quote);
}

function buildResolvedEvidenceIndex(
  prepared: PreparedProductionChronicleEvalCase,
  artifacts: ProductionChronicleArtifacts,
): ReadonlyMap<string, ResolvedEvidence> {
  const index = new Map<string, ResolvedEvidence>();
  for (const anchor of artifacts.anchors) {
    const documentId = prepared.documentIdBySourceRef.get(anchor.sourceRef);
    if (!documentId) continue;
    const resolved: ResolvedEvidence = {
      key: evidenceKey(documentId, anchor.quote),
    };
    index.set(sourceEvidenceKey(anchor.sourceRef, anchor.quote), resolved);
  }
  return index;
}

function requiredEvidenceKeys(
  required: PreparedProductionChronicleEvalCase["evalCase"]["expected"]["observations"]["required"],
): ReadonlyMap<string, ReadonlySet<string>> {
  return new Map(
    required.map((expected) => [
      expected.id,
      new Set(
        (expected.dimensions.evidence ?? []).map((evidence) =>
          evidenceKey(evidence.documentId, evidence.quote),
        ),
      ),
    ]),
  );
}

function buildAlignedObservations(
  prepared: PreparedProductionChronicleEvalCase,
  artifacts: ProductionChronicleArtifacts,
  actual: readonly NarrativeActualObservation[],
): {
  readonly aligned: readonly AlignedObservation[];
  readonly matchedRequiredCount: number;
} {
  if (actual.length !== artifacts.observations.length) {
    throw new Error(
      "Production Chronicle semantic diagnostics require one actual row per materialized observation",
    );
  }
  const resolvedBySourceEvidence = buildResolvedEvidenceIndex(
    prepared,
    artifacts,
  );
  const required = prepared.evalCase.expected.observations.required;
  const requiredKeysById = requiredEvidenceKeys(required);
  const usedRequiredIds = new Set<string>();
  const aligned = artifacts.observations.map((observation, index) => {
    const actualObservation = actual[index];
    if (!actualObservation || actualObservation.id !== observation.localId) {
      throw new Error(
        "Production Chronicle semantic diagnostics require actual rows to preserve materialized observation order and IDs",
      );
    }
    const evidenceKeys = observation.evidence.flatMap((evidence) => {
      const resolved = resolvedBySourceEvidence.get(
        sourceEvidenceKey(evidence.sourceRef, evidence.quote),
      );
      return resolved ? [resolved.key] : [];
    });
    const evidenceKeySet = new Set(evidenceKeys);
    const expected = required.find((candidate) => {
      if (usedRequiredIds.has(candidate.id)) return false;
      const expectedKeys = requiredKeysById.get(candidate.id);
      return (
        expectedKeys !== undefined &&
        [...expectedKeys].some((key) => evidenceKeySet.has(key))
      );
    });
    if (expected) usedRequiredIds.add(expected.id);
    return {
      actual: actualObservation,
      evidenceKeys,
      ...(expected ? { expectedId: expected.id } : {}),
    } satisfies AlignedObservation;
  });
  return {
    aligned,
    matchedRequiredCount: usedRequiredIds.size,
  };
}

function copyDimensionScores(
  evaluation: ProductionChronicleEvaluation,
): Record<NarrativeEvalDimension, NumericDimensionScore> {
  return Object.fromEntries(
    NARRATIVE_EVAL_DIMENSIONS.map((dimension) => {
      const score = evaluation.dimensions[dimension];
      if (!score) {
        throw new Error(
          `Production Chronicle semantic diagnostics missing dimension ${dimension}`,
        );
      }
      return [
        dimension,
        {
          truePositive: assertCount(
            score.truePositive,
            `${dimension}.truePositive`,
          ),
          falsePositive: assertCount(
            score.falsePositive,
            `${dimension}.falsePositive`,
          ),
          falseNegative: assertCount(
            score.falseNegative,
            `${dimension}.falseNegative`,
          ),
          unobservable: assertCount(
            score.unobservable,
            `${dimension}.unobservable`,
          ),
        },
      ];
    }),
  ) as Record<NarrativeEvalDimension, NumericDimensionScore>;
}

function countDimensionValueMismatches(
  evaluation: ProductionChronicleEvaluation,
  aligned: readonly AlignedObservation[],
): number {
  const unmatchedOutput = aligned.filter((entry) => !entry.expectedId);
  let mismatchCount = 0;
  for (const dimension of NARRATIVE_EVAL_DIMENSIONS) {
    const unmatchedObservedCount = unmatchedOutput.reduce(
      (count, entry) =>
        count +
        (entry.actual.dimensions[dimension]?.status === "observed" ? 1 : 0),
      0,
    );
    const falsePositiveCount = evaluation.dimensions[dimension].falsePositive;
    if (falsePositiveCount < unmatchedObservedCount) {
      throw new Error(
        `Production Chronicle semantic diagnostics could not reconcile ${dimension} false positives`,
      );
    }
    // The production scorer increments FP for an observed unmatched output,
    // and increments FP+FN for a value mismatch on a matched output. Removing
    // the former leaves exactly the scorer's value-mismatch branches. This
    // keeps clustering parity with the scorer's label normalization without
    // reimplementing that normalization here.
    mismatchCount += falsePositiveCount - unmatchedObservedCount;
  }
  return mismatchCount;
}

function countNoExactEvidenceMatches(
  prepared: PreparedProductionChronicleEvalCase,
  aligned: readonly AlignedObservation[],
): number {
  const requiredKeys = new Set<string>();
  for (const expected of prepared.evalCase.expected.observations.required) {
    for (const evidence of expected.dimensions.evidence ?? []) {
      requiredKeys.add(evidenceKey(evidence.documentId, evidence.quote));
    }
  }
  return aligned.filter(
    (entry) =>
      !entry.expectedId &&
      !entry.evidenceKeys.some((key) => requiredKeys.has(key)),
  ).length;
}

/**
 * Build the bounded numeric diagnostics attached to one production case.
 *
 * Evidence tuple alignment is deliberately independent from the semantic
 * scorer's `semanticKey` alignment. The resulting object contains only fixed
 * schema keys, counts, and the scorer's fixed dimension counters; it never
 * persists corpus text, evidence strings, IDs, model fields, or error data.
 */
export function buildProductionChronicleSemanticDiagnostics(
  prepared: PreparedProductionChronicleEvalCase,
  artifacts: ProductionChronicleArtifacts,
  evaluation: ProductionChronicleEvaluation,
): ProductionChronicleSemanticDiagnostics {
  const { aligned, matchedRequiredCount } = buildAlignedObservations(
    prepared,
    artifacts,
    evaluation.actual.observations,
  );
  const requiredCount = prepared.evalCase.expected.observations.required.length;
  const scoredCount = evaluation.actual.observations.length;
  const unmatchedRequiredCount = requiredCount - matchedRequiredCount;
  const unmatchedOutputCount = scoredCount - matchedRequiredCount;
  if (unmatchedRequiredCount < 0 || unmatchedOutputCount < 0) {
    throw new Error(
      "Production Chronicle semantic diagnostic alignment counts are inconsistent",
    );
  }
  const dimensions = copyDimensionScores(evaluation);
  const reasons: ProductionChronicleSemanticDiagnosticReasons = {
    missingRequiredCount: assertCount(
      unmatchedRequiredCount,
      "reasons.missingRequiredCount",
    ),
    extraOutputCount: assertCount(
      unmatchedOutputCount,
      "reasons.extraOutputCount",
    ),
    noExactEvidenceMatchCount: assertCount(
      countNoExactEvidenceMatches(prepared, aligned),
      "reasons.noExactEvidenceMatchCount",
    ),
    dimensionValueMismatchCount: assertCount(
      countDimensionValueMismatches(evaluation, aligned),
      "reasons.dimensionValueMismatchCount",
    ),
    dimensionUnobservableCount: assertCount(
      evaluation.unobservableDimensions.length,
      "reasons.dimensionUnobservableCount",
    ),
  };
  return {
    schemaVersion: PRODUCTION_CHRONICLE_SEMANTIC_DIAGNOSTICS_SCHEMA_VERSION,
    requiredCount: assertCount(requiredCount, "requiredCount"),
    scoredCount: assertCount(scoredCount, "scoredCount"),
    matchedRequiredCount: assertCount(
      matchedRequiredCount,
      "matchedRequiredCount",
    ),
    unmatchedRequiredCount: assertCount(
      unmatchedRequiredCount,
      "unmatchedRequiredCount",
    ),
    unmatchedOutputCount: assertCount(
      unmatchedOutputCount,
      "unmatchedOutputCount",
    ),
    dimensions,
    reasons,
  };
}
