import type { StateFacet } from "@/features/codex/details/semanticBindingTypes";
import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type { StateAssertionValue } from "../observations/stateAssertion";
import type { StateDurability, StateEpistemicContext } from "./stateSupport";

export type StateTrackId = string;

export interface StateTrackPoint {
  readonly observationId: string;
  readonly value: StateAssertionValue;
  readonly temporalMode:
    | "timeless"
    | "current"
    | "historical"
    | "prospective"
    | "unknown";
  readonly anchorDocumentRef: string | null;
  readonly retrospectiveOnly: boolean;
  readonly durability: StateDurability;
}

export interface StateTrackHypothesisPayload {
  readonly entityId: NarrativeEntityId;
  readonly facetKey: StateFacet;
  readonly durability: StateDurability;
  readonly points: readonly StateTrackPoint[];
}

export interface StateTrackHypothesis {
  readonly trackId: StateTrackId;
  readonly observationRefs: readonly string[];
  readonly payload: StateTrackHypothesisPayload;
  readonly epistemic: StateEpistemicContext;
}
