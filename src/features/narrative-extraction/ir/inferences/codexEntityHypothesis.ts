import type {
  CoarseEntityClass,
  EntityMentionForm,
  ObservationId,
} from "../observations/entityIdentity";

/** Opaque catalog ref for an existing Codex entry (e.g. K0001). Never a DB UUID. */
export type KnowledgeEntityRef = string;

/** Opaque catalog ref for a Project Codex Type (e.g. T0001). */
export type KnowledgeTypeRef = string;

export type NarrativeEntityId = string;

export type CodexEntityTypeResolution =
  | {
      readonly status: "resolved";
      readonly typeRef: KnowledgeTypeRef;
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly KnowledgeTypeRef[];
    }
  | {
      readonly status: "unresolved";
    };

export type EntityBindingMatchMethod =
  | "exact-name"
  | "exact-alias"
  | "explicit-identity"
  | "honorific-strip"
  | "prefix"
  | "substring"
  | "embedding";

export interface EntityBindingCandidate {
  readonly ref: KnowledgeEntityRef;
  readonly score: number;
  readonly methods: readonly EntityBindingMatchMethod[];
}

export type CodexEntityExistingResolution =
  | {
      readonly status: "none";
    }
  | {
      readonly status: "resolved";
      readonly ref: KnowledgeEntityRef;
      readonly method: "exact-name" | "exact-alias" | "explicit-identity";
    }
  | {
      readonly status: "ambiguous";
      readonly candidates: readonly EntityBindingCandidate[];
    };

export interface CodexEntityHypothesisPayload {
  readonly entityId: NarrativeEntityId;
  readonly canonicalName: string;
  readonly mentionSurfaces: readonly {
    readonly surface: string;
    readonly form: EntityMentionForm;
    readonly observationIds: readonly ObservationId[];
  }[];
  readonly aliases: readonly {
    readonly surface: string;
    readonly status:
      | "explicit"
      | "coreference-only"
      | "user-confirmation-required";
    readonly identityObservationIds: readonly ObservationId[];
  }[];
  readonly coarseClass: CoarseEntityClass;
  readonly typeResolution: CodexEntityTypeResolution;
  readonly existingResolution: CodexEntityExistingResolution;
  readonly summarySuggestion: string | null;
}

export interface EntityClusterManifestEntry {
  readonly clusterId: string;
  readonly mentionObservationIds: readonly ObservationId[];
  readonly identityObservationIds: readonly ObservationId[];
  readonly deterministicSeedIds: readonly string[];
  readonly candidateExistingRefs: readonly KnowledgeEntityRef[];
  readonly candidateTypeRefs: readonly KnowledgeTypeRef[];
}

export interface CodexEntityHypothesis {
  readonly hypothesisId: string;
  readonly clusterRef: string;
  readonly payload: CodexEntityHypothesisPayload;
}
