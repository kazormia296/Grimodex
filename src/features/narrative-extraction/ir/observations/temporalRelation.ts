import type {
  RelativeTemporalLiteral,
  TemporalIntervalRelation,
} from "../../temporal/constraints";

export type TemporalSubjectReference =
  | { readonly kind: "opaque-node"; readonly nodeRef: string }
  | { readonly kind: "surface"; readonly surface: string };

export interface TemporalRelationObservationPayload {
  readonly left: TemporalSubjectReference;
  readonly relation: TemporalIntervalRelation;
  readonly right: TemporalSubjectReference;
  readonly offset: RelativeTemporalLiteral["amount"] | null;
}

export interface RawTemporalRelationObservation {
  readonly localId: string;
  readonly documentRef: string;
  readonly surface: string;
  readonly payload: TemporalRelationObservationPayload;
  readonly commitment:
    | "story-fact"
    | "attributed-claim"
    | "belief"
    | "rumor"
    | "unknown";
}
