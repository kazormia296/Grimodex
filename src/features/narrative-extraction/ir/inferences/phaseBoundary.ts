import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type {
  StateChangeMagnitude,
  StateDurability,
  StateEpistemicContext,
} from "./stateSupport";
import type { StateTransitionId } from "./stateTransition";

export type PhaseBoundaryId = string;

export type PhasePersistenceDecision =
  | {
      readonly kind: "proposal";
      readonly reason: "major-durable" | "multi-moderate-durable";
    }
  | {
      readonly kind: "report-only";
      readonly reason: string;
    }
  | {
      readonly kind: "rejected";
      readonly reason: string;
    };

export interface PhaseBoundaryTransitionRef {
  readonly transitionId: StateTransitionId;
  readonly durability: StateDurability;
  readonly magnitude: StateChangeMagnitude;
  readonly facetKey: string;
}

export interface PhaseBoundaryHypothesisPayload {
  readonly entityId: NarrativeEntityId;
  /** Opaque scene / document anchor. Same entity+anchor consolidates to one boundary. */
  readonly anchorDocumentRef: string;
  readonly labelSuggestion: string | null;
  readonly transitions: readonly PhaseBoundaryTransitionRef[];
  readonly persistence: PhasePersistenceDecision;
}

export interface PhaseBoundaryHypothesis {
  readonly boundaryId: PhaseBoundaryId;
  readonly observationRefs: readonly string[];
  readonly payload: PhaseBoundaryHypothesisPayload;
  readonly epistemic: StateEpistemicContext;
}
