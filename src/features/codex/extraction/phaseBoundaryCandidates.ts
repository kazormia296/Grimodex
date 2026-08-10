import type { StateTransitionHypothesis } from "@/features/narrative-extraction/ir/inferences/stateTransition";
import { isTransientFacet } from "@/features/narrative-extraction/ir/inferences/stateSupport";

export interface PhaseBoundaryCandidate {
  readonly candidateId: string;
  readonly entityId: string;
  readonly anchorDocumentRef: string;
  readonly transitionIds: readonly string[];
  readonly transitions: readonly StateTransitionHypothesis[];
}

export interface BuildPhaseBoundaryCandidatesOptions {
  readonly createId?: () => string;
}

/**
 * Group durable transitions by (entityId, anchorDocumentRef).
 * Transient emotion/location transitions never become Phase candidates.
 * Same entity+anchor consolidates into one candidate.
 */
export function buildPhaseBoundaryCandidates(
  transitions: readonly StateTransitionHypothesis[],
  options: BuildPhaseBoundaryCandidatesOptions = {},
): readonly PhaseBoundaryCandidate[] {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const groups = new Map<
    string,
    {
      entityId: string;
      anchorDocumentRef: string;
      transitions: StateTransitionHypothesis[];
    }
  >();

  for (const transition of transitions) {
    if (isTransientFacet(transition.payload.facetKey)) continue;
    if (transition.payload.durability === "transient") continue;
    const anchor = transition.payload.anchorDocumentRef;
    if (!anchor) continue;

    const key = `${transition.payload.entityId}\0${anchor}`;
    const existing = groups.get(key);
    if (existing) {
      existing.transitions.push(transition);
      continue;
    }
    groups.set(key, {
      entityId: transition.payload.entityId,
      anchorDocumentRef: anchor,
      transitions: [transition],
    });
  }

  return [...groups.values()].map((group) => ({
    candidateId: createId(),
    entityId: group.entityId,
    anchorDocumentRef: group.anchorDocumentRef,
    transitionIds: group.transitions.map((t) => t.transitionId),
    transitions: group.transitions,
  }));
}
