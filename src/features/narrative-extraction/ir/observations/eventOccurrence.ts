import type { RawEvidenceReference } from "../../evidence/types";

export type EventObservationActuality =
  | "actual"
  | "planned"
  | "intended"
  | "attempted"
  | "prevented"
  | "hypothetical"
  | "counterfactual"
  | "dreamed"
  /** Reported hearsay; the source does not establish truth in the story world. */
  | "rumored"
  | "unknown";

export type EventDurationKind =
  | "instant"
  | "bounded-interval"
  | "ongoing-process"
  | "unknown";

export interface NarrativeAssertionContext {
  readonly attribution: "narrator" | `character:${string}` | "unknown";
  readonly narrativeFrame:
    | "story-world"
    | "flashback"
    | "dream"
    | "reported"
    | "hypothetical"
    | "unknown";
}

export interface RawChronicleEventObservation {
  readonly localId: string;
  readonly evidence: readonly RawEvidenceReference[];
  readonly assertion: NarrativeAssertionContext;
  readonly payload: {
    readonly predicate: string;
    readonly semanticType?: string;
    readonly actuality: EventObservationActuality;
    readonly participants: readonly {
      readonly surface: string;
      readonly role: string;
    }[];
    readonly locationSurface?: string;
    readonly temporalExpressions: readonly string[];
    readonly durationKind: EventDurationKind;
  };
}
