import type { StateFacet } from "@/features/codex/details/semanticBindingTypes";
import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type { StateAssertionValue } from "../observations/stateAssertion";
import type {
  StateChangeMagnitude,
  StateDurability,
  StateEpistemicContext,
} from "./stateSupport";
import type { StateTrackId } from "./stateTrack";

export type StateTransitionId = string;

export interface StateTransitionHypothesisPayload {
  readonly entityId: NarrativeEntityId;
  readonly facetKey: StateFacet;
  readonly trackId: StateTrackId;
  readonly fromValue: StateAssertionValue | null;
  readonly toValue: StateAssertionValue;
  readonly magnitude: StateChangeMagnitude;
  readonly durability: StateDurability;
  readonly anchorDocumentRef: string | null;
  readonly retrospectiveOnly: boolean;
}

export interface StateTransitionHypothesis {
  readonly transitionId: StateTransitionId;
  readonly observationRefs: readonly string[];
  readonly payload: StateTransitionHypothesisPayload;
  readonly epistemic: StateEpistemicContext;
}
