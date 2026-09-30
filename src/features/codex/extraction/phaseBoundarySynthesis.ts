import type {
  PhaseBoundaryHypothesis,
  PhasePersistenceDecision,
} from "@/features/narrative-extraction/ir/inferences/phaseBoundary";
import type { StateEpistemicContext } from "@/features/narrative-extraction/ir/inferences/stateSupport";
import type { PhaseBoundaryCandidate } from "./phaseBoundaryCandidates";

const DEFAULT_EPISTEMIC: StateEpistemicContext = {
  polarity: "affirmed",
  commitment: "story-fact",
  support: "direct",
  narrativeFrame: "primary",
};

export interface SynthesizePhaseBoundariesOptions {
  readonly createId?: () => string;
  readonly epistemic?: StateEpistemicContext;
  readonly labelForCandidate?: (
    candidate: PhaseBoundaryCandidate,
  ) => string | null;
}

/**
 * Persistence gate (spec):
 * - proposal when ≥1 major durable OR ≥2 moderate durable transitions
 * - reject retrospective-only candidates for proposals (report-only / rejected)
 */
export function evaluatePhasePersistenceGate(
  candidate: PhaseBoundaryCandidate,
): PhasePersistenceDecision {
  const forward = candidate.transitions.filter(
    (transition) => !transition.payload.retrospectiveOnly,
  );
  if (forward.length === 0) {
    return {
      kind: "rejected",
      reason: "retrospective-only",
    };
  }

  const majorCount = forward.filter(
    (transition) => transition.payload.durability === "major",
  ).length;
  const moderateCount = forward.filter(
    (transition) => transition.payload.durability === "moderate",
  ).length;

  if (majorCount >= 1) {
    return { kind: "proposal", reason: "major-durable" };
  }
  if (moderateCount >= 2) {
    return { kind: "proposal", reason: "multi-moderate-durable" };
  }
  if (moderateCount === 1) {
    return {
      kind: "report-only",
      reason: "single-moderate-durable",
    };
  }
  return {
    kind: "rejected",
    reason: "no-durable-forward-transition",
  };
}

export function synthesizePhaseBoundaries(
  candidates: readonly PhaseBoundaryCandidate[],
  options: SynthesizePhaseBoundariesOptions = {},
): readonly PhaseBoundaryHypothesis[] {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const epistemic = options.epistemic ?? DEFAULT_EPISTEMIC;
  const boundaries: PhaseBoundaryHypothesis[] = [];

  for (const candidate of candidates) {
    const persistence = evaluatePhasePersistenceGate(candidate);
    const observationRefs = [
      ...new Set(
        candidate.transitions.flatMap(
          (transition) => transition.observationRefs,
        ),
      ),
    ];
    boundaries.push({
      boundaryId: createId(),
      observationRefs,
      payload: {
        entityId: candidate.entityId,
        anchorDocumentRef: candidate.anchorDocumentRef,
        labelSuggestion:
          options.labelForCandidate?.(candidate) ?? defaultLabel(candidate),
        transitions: candidate.transitions.map((transition) => ({
          transitionId: transition.transitionId,
          durability: transition.payload.durability,
          magnitude: transition.payload.magnitude,
          facetKey: transition.payload.facetKey,
        })),
        persistence,
      },
      epistemic,
    });
  }

  return boundaries;
}

function defaultLabel(candidate: PhaseBoundaryCandidate): string | null {
  const facets = candidate.transitions.map((t) => t.payload.facetKey);
  if (facets.some((facet) => facet.startsWith("role."))) {
    return "役割変化";
  }
  if (facets.some((facet) => facet.startsWith("injury."))) {
    return "負傷後";
  }
  return null;
}
