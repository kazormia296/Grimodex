import type { EntityReference, ObservationBase } from "./entityIdentity";

export type EntityRelationFamily =
  | "identity"
  | "kinship"
  | "social"
  | "affiliation"
  | "possessive"
  | "spatial"
  | "part-whole"
  | "comparative"
  | "other";

export type EntityRelationMode = "holds" | "begins" | "ends" | "changes";

export interface EntityRelationPayload {
  readonly subject: EntityReference;
  readonly predicate: string;
  readonly object: EntityReference;
  readonly family: EntityRelationFamily;
  readonly mode: EntityRelationMode;
}

export type EntityRelationObservation = ObservationBase<
  "entity-relation",
  EntityRelationPayload
>;
