import type { ProposalBase } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { CalendarResolution } from "@/features/narrative-extraction/temporal/resolution";

export const SET_EVENT_TEMPORAL_METADATA_PROPOSAL_KIND =
  "temporal.event.metadata.set" as const;

export interface SetEventTemporalMetadataProposalPayload {
  readonly eventId: string;
  readonly resolvedTime: CalendarResolution;
  readonly sourceConstraintIds: readonly [string, ...string[]];
  readonly existing:
    | { readonly status: "empty" }
    | { readonly status: "same" }
    | {
        readonly status: "different";
        readonly current: {
          readonly startDay: number | null;
          readonly endDay: number | null;
        };
      };
}

export type SetEventTemporalMetadataProposal = ProposalBase<
  typeof SET_EVENT_TEMPORAL_METADATA_PROPOSAL_KIND,
  { readonly kind: "event"; readonly eventId: string },
  SetEventTemporalMetadataProposalPayload
>;

export function isSafeEventTemporalProjection(
  payload: SetEventTemporalMetadataProposalPayload,
): boolean {
  return (
    payload.existing.status === "empty" || payload.existing.status === "same"
  );
}
