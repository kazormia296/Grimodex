import type { DocumentRef, NarrativeEventId } from "../temporal/nodes";

export type ChronicleEventActuality = "actual" | "attempted" | "prevented";

export type ChronicleEventSignificance = "major" | "scene-level";

export interface CreateChronicleEventProposalPayloadV1 {
  readonly eventId: NarrativeEventId;
  readonly title: string;
  readonly note: string | null;
  readonly actuality: ChronicleEventActuality;
  readonly significance: ChronicleEventSignificance;
  readonly semanticType?: string;
  readonly evidenceAnchorIds: readonly [string, ...string[]];
  readonly evidenceDocumentRefs: readonly [DocumentRef, ...DocumentRef[]];
  readonly disclosure: {
    readonly secret: boolean;
    readonly revealDocumentRef: DocumentRef;
  };
  readonly unresolvedMetadata: {
    readonly participantSurfaces: readonly string[];
    readonly locationSurface: string | null;
    readonly temporalExpressions: readonly string[];
  };
}

export const CHRONICLE_EVENT_PROPOSAL_KIND = "chronicle.create-event@1" as const;
