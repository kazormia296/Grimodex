import type { PhaseBoundaryHypothesis } from "@/features/narrative-extraction/ir/inferences/phaseBoundary";
import type { DetailProjectionHypothesis } from "@/features/narrative-extraction/ir/inferences/detailProjection";
import type { StateTrackHypothesis } from "@/features/narrative-extraction/ir/inferences/stateTrack";
import {
  bindExistingCodexPhaseProposal,
  createNewBindCodexPhaseProposal,
  unresolvedBindCodexPhaseProposal,
  type BindCodexPhaseProposal,
  type PhaseDetailOverrideItem,
} from "@/features/narrative-extraction/proposals/bindCodexPhaseProposal";
import {
  createSetCodexBaseDetailProposal,
  type SetCodexBaseDetailProposal,
} from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";
import {
  matchExistingPhase,
  type ExistingPhaseCatalogRecord,
} from "./existingPhaseMatcher";
import { isSetWrite } from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";

export interface PlanPhaseAndDetailProposalsInput {
  readonly boundaries: readonly PhaseBoundaryHypothesis[];
  readonly detailProjections: readonly DetailProjectionHypothesis[];
  readonly stateTracks?: readonly StateTrackHypothesis[];
  readonly existingPhases: readonly ExistingPhaseCatalogRecord[];
  /**
   * When extraction scope is not full-corpus, Base Detail accepts timeless only.
   */
  readonly extractionScope: "full-corpus" | "partial";
  readonly entityBindingProposalIds?: ReadonlyMap<string, string>;
  readonly createId?: () => string;
}

export interface PlannedPhaseProposal {
  readonly proposal: BindCodexPhaseProposal;
  readonly boundaryId: string;
  readonly blocked: boolean;
  readonly blockedReason?: string;
}

export interface PlannedBaseDetailProposal {
  readonly proposal: SetCodexBaseDetailProposal;
  readonly projectionId: string;
}

export interface PhaseProposalPlan {
  readonly phaseProposals: readonly PlannedPhaseProposal[];
  readonly baseDetailProposals: readonly PlannedBaseDetailProposal[];
}

function overridesForBoundary(
  boundaryId: string,
  projections: readonly DetailProjectionHypothesis[],
): PhaseDetailOverrideItem[] {
  const items: PhaseDetailOverrideItem[] = [];
  for (const projection of projections) {
    if (projection.payload.destination !== "phase") continue;
    if (projection.payload.scope.kind !== "phase") continue;
    if (projection.payload.scope.boundaryId !== boundaryId) continue;
    if (projection.payload.binding.status !== "resolved") continue;
    items.push({
      definitionRef: projection.payload.binding.definitionRef,
      write: projection.payload.write,
    });
  }
  return items;
}

/**
 * Plan BindCodexPhase + SetCodexBaseDetail proposals.
 *
 * Rules:
 * - Phase persistence gate must be proposal
 * - Same entity+anchor already consolidated upstream
 * - Base only timeless, or corpus-initial when full-corpus scope
 * - Summary override defaults to leave
 * - No contentOverride / contextModeOverride
 */
export function planPhaseAndDetailProposals(
  input: PlanPhaseAndDetailProposalsInput,
): PhaseProposalPlan {
  const createId = input.createId ?? (() => crypto.randomUUID());
  const phaseProposals: PlannedPhaseProposal[] = [];
  const baseDetailProposals: PlannedBaseDetailProposal[] = [];

  for (const boundary of input.boundaries) {
    if (boundary.payload.persistence.kind !== "proposal") continue;

    const detailOverrides = overridesForBoundary(
      boundary.boundaryId,
      input.detailProjections,
    );
    const match = matchExistingPhase(boundary, input.existingPhases);
    const deps = input.entityBindingProposalIds?.get(
      boundary.payload.entityId,
    );
    const dependencies = deps
      ? [{ kind: "requires-resolution" as const, proposalId: deps }]
      : [];

    const basePayload = {
      narrativeEntityId: boundary.payload.entityId,
      anchorDocumentRef: boundary.payload.anchorDocumentRef,
      labelSuggestion: boundary.payload.labelSuggestion,
      summaryOverride: { kind: "leave" as const },
      detailOverrides,
    };

    if (match.status === "resolved") {
      phaseProposals.push({
        boundaryId: boundary.boundaryId,
        blocked: false,
        proposal: bindExistingCodexPhaseProposal(
          {
            ...basePayload,
            binding: {
              kind: "bind-existing",
              phaseRef: match.ref,
              expectedVersion: match.expectedVersion,
            },
          },
          { createId, dependencies },
        ),
      });
      continue;
    }

    if (match.status === "ambiguous") {
      phaseProposals.push({
        boundaryId: boundary.boundaryId,
        blocked: true,
        blockedReason: "既存 Phase 候補が複数あります",
        proposal: unresolvedBindCodexPhaseProposal(
          {
            ...basePayload,
            binding: {
              kind: "unresolved",
              candidates: match.candidates.map((candidate) => ({
                ref: candidate.ref,
                score: candidate.score,
              })),
              allowCreateNew: true,
            },
          },
          { createId, dependencies },
        ),
      });
      continue;
    }

    const label =
      boundary.payload.labelSuggestion?.trim() ||
      `Phase @ ${boundary.payload.anchorDocumentRef}`;
    phaseProposals.push({
      boundaryId: boundary.boundaryId,
      blocked: false,
      proposal: createNewBindCodexPhaseProposal(
        {
          ...basePayload,
          binding: {
            kind: "create-new",
            phase: {
              label,
              anchorDocumentRef: boundary.payload.anchorDocumentRef,
            },
          },
        },
        { createId, dependencies },
      ),
    });
  }

  for (const projection of input.detailProjections) {
    if (projection.payload.destination !== "base") continue;
    if (projection.payload.scope.kind !== "base") continue;
    if (projection.payload.binding.status !== "resolved") continue;
    if (!isSetWrite(projection.payload.write)) continue;

    const eligibility = projection.payload.scope.temporalEligibility;
    if (eligibility === "corpus-initial" && input.extractionScope === "partial") {
      // Partial scope → timeless only for base
      continue;
    }
    if (eligibility !== "timeless" && eligibility !== "corpus-initial") {
      continue;
    }
    // When partial, only timeless reaches here due to filter above;
    // when full-corpus, both timeless and corpus-initial are allowed.
    if (
      input.extractionScope === "partial" &&
      eligibility !== "timeless"
    ) {
      continue;
    }

    const proposal = createSetCodexBaseDetailProposal({
      narrativeEntityId: projection.payload.entityId,
      definitionRef: projection.payload.binding.definitionRef,
      facetKey: projection.payload.facetKey,
      value: projection.payload.write.value,
      temporalEligibility: eligibility,
      createId,
      dependencyProposalIds: input.entityBindingProposalIds
        ? [
            ...(input.entityBindingProposalIds.has(projection.payload.entityId)
              ? [input.entityBindingProposalIds.get(projection.payload.entityId)!]
              : []),
          ]
        : [],
    });
    if (!proposal) continue;
    baseDetailProposals.push({
      projectionId: projection.projectionId,
      proposal,
    });
  }

  return { phaseProposals, baseDetailProposals };
}
