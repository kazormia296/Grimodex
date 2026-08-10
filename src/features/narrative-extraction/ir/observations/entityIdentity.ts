import type { RawEvidenceReference } from "../../evidence/types";
import type { NarrativeAssertionContext } from "./eventOccurrence";

export type ObservationId = string;

/** Opaque local referent within one extraction run (never a DB entry id). */
export type EntityReference =
  | { readonly kind: "local"; readonly localId: string }
  | { readonly kind: "surface"; readonly surface: string };

export type CoarseEntityClass =
  | "person"
  | "place"
  | "organization"
  | "item"
  | "concept"
  | "other"
  | "unknown";

export type EntityMentionForm =
  | "proper-name"
  | "alias"
  | "title"
  | "description"
  | "pronoun"
  | "collective"
  | "implicit";

export interface EntityMentionPayload {
  readonly surface: string | null;
  readonly mentionForm: EntityMentionForm;
  readonly entityClassHints: readonly CoarseEntityClass[];
  readonly referent: EntityReference;
  readonly grammaticalRole?:
    | "subject"
    | "object"
    | "possessor"
    | "recipient"
    | "speaker"
    | "addressee"
    | "other";
}

export interface ObservationBase<Kind extends string, Payload> {
  readonly localId: ObservationId;
  readonly kind: Kind;
  readonly evidence: readonly RawEvidenceReference[];
  readonly assertion: NarrativeAssertionContext;
  readonly payload: Payload;
}

export type EntityMentionObservation = ObservationBase<
  "entity-mention",
  EntityMentionPayload
>;

export interface EntityIdentityPayload {
  readonly subject: EntityReference;
  readonly identity:
    | {
        readonly kind: "alias";
        readonly surface: string;
      }
    | {
        readonly kind: "renamed-to";
        readonly surface: string;
      }
    | {
        readonly kind: "same-as";
        readonly other: EntityReference;
      };
  readonly temporalMode:
    | "timeless"
    | "current"
    | "historical"
    | "unknown";
}

export type EntityIdentityObservation = ObservationBase<
  "entity-identity",
  EntityIdentityPayload
>;
