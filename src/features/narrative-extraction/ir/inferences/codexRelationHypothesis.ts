import type { NarrativeEntityId } from "./codexEntityHypothesis";
import type { EntityRelationFamily } from "../observations/entityRelation";

export type CodexRelationValidity =
  | "timeless"
  | "current"
  | "historical"
  | "prospective"
  | "ended"
  | "unknown";

export type CodexRelationDirectionality =
  | "directed"
  | "symmetric"
  | "ambiguous";

export type RelationPolarity = "affirmed" | "negated" | "uncertain";

export type RelationCommitment =
  | "story-fact"
  | "rumor"
  | "belief"
  | "speculation"
  | "conflicted";

export type RelationSupport =
  | "direct"
  | "corroborated"
  | "inferred"
  | "weak";

export type RelationNarrativeFrame =
  | "primary"
  | "memory"
  | "reported"
  | "hypothetical"
  | "other";

export interface RelationEpistemicContext {
  readonly polarity: RelationPolarity;
  readonly commitment: RelationCommitment;
  readonly support: RelationSupport;
  readonly narrativeFrame: RelationNarrativeFrame;
}

export interface CodexRelationHypothesisPayload {
  readonly subjectEntityId: NarrativeEntityId;
  readonly objectEntityId: NarrativeEntityId;
  readonly predicate: string;
  readonly family: EntityRelationFamily;
  readonly validity: CodexRelationValidity;
  readonly directionality: CodexRelationDirectionality;
  readonly forwardLabelSuggestion: string;
  readonly inverseLabelSuggestion: string | null;
}

export interface CodexRelationHypothesis {
  readonly hypothesisId: string;
  readonly observationRefs: readonly string[];
  readonly subjectResolved: boolean;
  readonly objectResolved: boolean;
  readonly payload: CodexRelationHypothesisPayload;
  readonly epistemic: RelationEpistemicContext;
}
