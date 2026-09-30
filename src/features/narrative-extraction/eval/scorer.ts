import {
  NARRATIVE_EVAL_DIMENSIONS,
  type NarrativeActualGraph,
  type NarrativeActualObservation,
  type NarrativeCriticalViolation,
  type NarrativeDimensionScore,
  type NarrativeEvalCaseScore,
  type NarrativeEvalCaseV1,
  type NarrativeEvalDimension,
  type NarrativeEvalDimensions,
  type NarrativeObservedDimension,
} from "./types";

function newDimensionScore(): NarrativeDimensionScore {
  return {
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    unobservable: 0,
  };
}

function dimensionScores(): Record<
  NarrativeEvalDimension,
  NarrativeDimensionScore
> {
  return Object.fromEntries(
    NARRATIVE_EVAL_DIMENSIONS.map((dimension) => [
      dimension,
      newDimensionScore(),
    ]),
  ) as Record<NarrativeEvalDimension, NarrativeDimensionScore>;
}

function comparable(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value.map((entry) => comparable(entry)).sort());
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return JSON.stringify(
      Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, comparable(record[key])]),
      ),
    );
  }
  return JSON.stringify(value);
}

function sameValue(left: unknown, right: unknown): boolean {
  return comparable(left) === comparable(right);
}

function expectedValue(
  dimensions: NarrativeEvalDimensions,
  dimension: NarrativeEvalDimension,
): unknown {
  return dimensions[dimension];
}

function observedValue(
  observation: NarrativeActualObservation,
  dimension: NarrativeEvalDimension,
): NarrativeObservedDimension | undefined {
  return observation.dimensions[dimension];
}

/** Score one isolated case without collapsing semantic dimensions into one number. */
export function scoreNarrativeEvalCase(
  evalCase: NarrativeEvalCaseV1,
  actual: NarrativeActualGraph,
): NarrativeEvalCaseScore {
  const dimensions = dimensionScores();
  const unobservableDimensions: Array<{
    actualObservationId: string;
    dimension: NarrativeEvalDimension;
    reason: string;
  }> = [];
  const unmatchedActual = new Set(actual.observations.map((entry) => entry.id));

  for (const expected of evalCase.expected.observations.required) {
    const found = actual.observations.find(
      (entry) =>
        unmatchedActual.has(entry.id) &&
        entry.semanticKey === expected.semanticKey,
    );
    if (found) unmatchedActual.delete(found.id);
    for (const dimension of NARRATIVE_EVAL_DIMENSIONS) {
      const wanted = expectedValue(expected.dimensions, dimension);
      if (wanted === undefined) continue;
      if (!found) {
        dimensions[dimension].falseNegative++;
        continue;
      }
      const observed = observedValue(found, dimension);
      if (!observed || observed.status === "unobservable") {
        dimensions[dimension].falseNegative++;
        dimensions[dimension].unobservable++;
        unobservableDimensions.push({
          actualObservationId: found.id,
          dimension,
          reason:
            observed?.status === "unobservable"
              ? observed.reason
              : "dimension was omitted",
        });
        continue;
      }
      if (sameValue(observed.value, wanted)) {
        dimensions[dimension].truePositive++;
      } else {
        dimensions[dimension].falsePositive++;
        dimensions[dimension].falseNegative++;
      }
    }
  }

  for (const observation of actual.observations) {
    if (!unmatchedActual.has(observation.id)) continue;
    for (const dimension of NARRATIVE_EVAL_DIMENSIONS) {
      const observed = observedValue(observation, dimension);
      if (!observed) continue;
      if (observed.status === "observed") {
        dimensions[dimension].falsePositive++;
      } else {
        unobservableDimensions.push({
          actualObservationId: observation.id,
          dimension,
          reason: observed.reason,
        });
      }
    }
  }

  const criticalViolations: NarrativeCriticalViolation[] = [];
  for (const violationClass of evalCase.criticalViolationClasses) {
    for (const observation of actual.observations) {
      if (observation.semanticKey !== violationClass.match.semanticKey)
        continue;
      const observed = observation.dimensions[violationClass.match.dimension];
      if (
        observed?.status === "observed" &&
        sameValue(observed.value, violationClass.match.value)
      ) {
        criticalViolations.push({
          classId: violationClass.id,
          actualObservationId: observation.id,
          message: violationClass.description,
        });
      }
    }
  }

  if (evalCase.coverage.mode === "partial") {
    for (const claim of actual.coverageClaims ?? []) {
      if (claim.kind === "absence" || claim.kind === "complete") {
        criticalViolations.push({
          classId: "partial-coverage-absence",
          message: `Partial corpus made an unsupported ${claim.kind} claim: ${claim.value}`,
        });
      }
    }
  }
  if ((actual.appliedProposalIds?.length ?? 0) > 0) {
    criticalViolations.push({
      classId: "unapproved-proposal-apply",
      message: "Evaluation output attempted to apply an unreviewed Proposal",
    });
  }

  const passed =
    criticalViolations.length === 0 &&
    Object.values(dimensions).every(
      (score) => score.falsePositive === 0 && score.falseNegative === 0,
    );
  return {
    passed,
    dimensions,
    criticalViolations,
    unobservableDimensions,
  };
}
