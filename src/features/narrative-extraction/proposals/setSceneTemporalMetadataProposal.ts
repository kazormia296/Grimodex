import type { ProposalBase } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { DocumentRef } from "@/features/narrative-extraction/temporal/nodes";
import type { CalendarResolution } from "@/features/narrative-extraction/temporal/resolution";

export const SET_SCENE_TEMPORAL_METADATA_PROPOSAL_KIND =
  "temporal.scene.metadata.set" as const;

export interface SetSceneTemporalMetadataProposalPayload {
  readonly documentRef: DocumentRef;
  readonly resolvedTime: CalendarResolution;
  readonly sourceConstraintIds: readonly [string, ...string[]];
  readonly sceneProfile: "single-period" | "bounded-span";
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

export type SetSceneTemporalMetadataProposal = ProposalBase<
  typeof SET_SCENE_TEMPORAL_METADATA_PROPOSAL_KIND,
  { readonly kind: "scene"; readonly documentRef: DocumentRef },
  SetSceneTemporalMetadataProposalPayload
>;

/** v1: blocked when existing.status === "different". */
export function isSafeSceneTemporalProjection(
  payload: SetSceneTemporalMetadataProposalPayload,
): boolean {
  return (
    (payload.existing.status === "empty" ||
      payload.existing.status === "same") &&
    (payload.sceneProfile === "single-period" ||
      payload.sceneProfile === "bounded-span")
  );
}
