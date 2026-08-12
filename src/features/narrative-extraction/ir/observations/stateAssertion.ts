import type { StateFacet } from "@/features/codex/details/semanticBindingTypes";
import type { EntityReference, ObservationBase } from "./entityIdentity";

export type StateAspect = "holds" | "begins" | "ends" | "changes";

export type StateAssertionTemporalMode =
  | "timeless"
  | "current"
  | "historical"
  | "prospective"
  | "unknown";

/**
 * Observed state value surface. Dropdown values must use opaque option refs
 * (never raw option labels) so Detail compose can bind safely.
 */
export type StateAssertionValue =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "enum"; readonly optionRef: string }
  | { readonly kind: "entity"; readonly entityLocalId: string }
  | { readonly kind: "clear" };

export type StateDurabilityHint = "transient" | "moderate" | "major";

export interface StateAssertionPayload {
  readonly subject: EntityReference;
  readonly facetKey: StateFacet;
  readonly aspect: StateAspect;
  readonly value: StateAssertionValue;
  readonly temporalMode: StateAssertionTemporalMode;
  /** Optional extractor hint; synthesis may override via facet rules. */
  readonly durabilityHint?: StateDurabilityHint;
  /**
   * True when the assertion is only reported retrospectively (flashback /
   * reported memory) and does not establish a forward-looking Phase boundary.
   */
  readonly retrospectiveOnly?: boolean;
  /** Opaque document / scene anchor for discourse ordering. */
  readonly anchorDocumentRef?: string;
}

export type StateAssertionObservation = ObservationBase<
  "state-assertion",
  StateAssertionPayload
>;
