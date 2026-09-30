import type { ProposalBase } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { TemporalConstraint } from "@/features/narrative-extraction/temporal/constraints";
import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";
import type { TemporalTimelineRef } from "@/features/narrative-extraction/temporal/timeline";

export const CREATE_TEMPORAL_CONSTRAINT_PROPOSAL_KIND =
  "temporal.constraint.create" as const;

export interface CreateTemporalConstraintProposalPayload {
  readonly timeline: TemporalTimelineRef;
  readonly constraint: TemporalConstraint;
  readonly involvedNodes: readonly TemporalNodeId[];
  readonly projectionCandidates: readonly {
    readonly kind: "scene-time" | "event-time" | "scene-story-order";
    readonly targetNodeId: TemporalNodeId;
    readonly status: "available" | "ambiguous" | "blocked";
  }[];
}

export type CreateTemporalConstraintProposal = ProposalBase<
  typeof CREATE_TEMPORAL_CONSTRAINT_PROPOSAL_KIND,
  { readonly kind: "temporal-constraint"; readonly logicalRef: string },
  CreateTemporalConstraintProposalPayload
>;
