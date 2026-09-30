import type {
  DetailBindingDestination,
  DetailSemanticBindingResolution,
} from "@/features/codex/details/semanticBindingResolver";
import type {
  PhaseDetailWrite,
  ProjectedDetailValue,
  StateFacet,
} from "@/features/codex/details/semanticBindingTypes";
import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type { PhaseBoundaryId } from "./phaseBoundary";

export type DetailProjectionId = string;

export type DetailProjectionScope =
  | {
      readonly kind: "base";
      /** Base accepts timeless facts, or corpus-initial current when full-scope. */
      readonly temporalEligibility: "timeless" | "corpus-initial";
    }
  | {
      readonly kind: "phase";
      readonly boundaryId: PhaseBoundaryId;
    };

export interface DetailProjectionHypothesisPayload {
  readonly entityId: NarrativeEntityId;
  readonly facetKey: StateFacet;
  readonly destination: DetailBindingDestination;
  readonly scope: DetailProjectionScope;
  readonly binding: DetailSemanticBindingResolution;
  /**
   * Proposed write. clear ≠ inherit ≠ set must remain distinct through
   * compose → proposal → commit.
   */
  readonly write: PhaseDetailWrite;
  readonly value: ProjectedDetailValue | null;
}

export interface DetailProjectionHypothesis {
  readonly projectionId: DetailProjectionId;
  readonly observationRefs: readonly string[];
  readonly payload: DetailProjectionHypothesisPayload;
}
