import type { Sha256Digest } from "../source/types";

/** ADR 009 Scope V2 reference-axis constraint. */
export type NarrativeScopeReferenceConstraint =
  | { readonly kind: "any" }
  | { readonly kind: "exact"; readonly ref: string }
  | {
      readonly kind: "unresolved";
      readonly reason:
        | "not-provided"
        | "ambiguous"
        | "missing-reference"
        | "unsupported-axis"
        | "legacy-axis-unknown";
      readonly constraintId?: string;
    };

export interface NarrativeScopeTemporalBoundary {
  readonly ref: string;
  readonly inclusive: boolean;
}

/** ADR 009 Scope V2 temporal-axis constraint. */
export type NarrativeScopeTemporalConstraint =
  | { readonly kind: "any" }
  | {
      readonly kind: "interval";
      readonly from?: NarrativeScopeTemporalBoundary;
      readonly until?: NarrativeScopeTemporalBoundary;
    }
  | {
      readonly kind: "unresolved";
      readonly reason:
        | "not-provided"
        | "ambiguous"
        | "missing-reference"
        | "unsupported-axis"
        | "legacy-axis-unknown";
      readonly constraintId?: string;
    };

/** The complete, explicit Scope shape required by Narrative IR V2. */
export interface NarrativeScopeV2 {
  readonly schemaVersion: 2;
  readonly registryVersion: string;
  readonly timeline: NarrativeScopeReferenceConstraint;
  readonly worldline: NarrativeScopeReferenceConstraint;
  readonly scene: NarrativeScopeReferenceConstraint;
  readonly viewpoint: NarrativeScopeReferenceConstraint;
  readonly knowledgeHolder: NarrativeScopeReferenceConstraint;
  readonly audience: NarrativeScopeReferenceConstraint;
  readonly narrativeLayer: NarrativeScopeReferenceConstraint;
  readonly storyTime: NarrativeScopeTemporalConstraint;
  readonly readingOrder: NarrativeScopeTemporalConstraint;
}

/**
 * Deterministic Core assessment of whether a projection's source basis still
 * matches live evidence. Non-semantic — see ADR 004 EvidenceFreshness axis.
 */
export type EvidenceFreshness =
  | "fresh"
  | "stale"
  | "source-missing"
  | "anchor-mismatch"
  | "read-set-drift"
  | "unknown";

/**
 * Reconciler Strategy assessment of semantic change. Non-authoritative —
 * must not gate Apply without a separate Decision.
 */
export type SemanticAssessment =
  | "unchanged"
  | "revision"
  | "retraction"
  | "conflict";

/** Sole propagation signal permitted across provenance / dependency edges. */
export type ReconciliationPropagationSignal = "needs-reconciliation";

export type ProposalChangeKind =
  | "add"
  | "revise"
  | "retract"
  | "merge"
  | "split";

export interface ReconcilerIdentity {
  readonly reconcilerId: string;
  readonly reconcilerVersion: string;
}

export interface ProposalSchemaRef {
  readonly proposalSchemaId: string;
  readonly proposalSchemaVersion: string;
}

export interface SourceBasisRevision {
  readonly sourceKind: string;
  readonly sourceKey: string;
  readonly revisionToken: string;
  readonly revisionObservedAt?: string;
}

/**
 * Vector of source revisions consulted for a reconciliation pass.
 * Not a single `basedOnSourceRevision` scalar — ADR 004 ClaimEnvelope.
 */
export type SourceBasis = readonly SourceBasisRevision[];

/** Native recomputes this digest from the canonical read-set array. */
export type ReadSetDigest = Sha256Digest;

export interface EvidenceSetEntry {
  readonly evidenceRef: string;
  readonly documentRef?: string;
  /** Exact quoted text resolved from the evidence anchor. */
  readonly quote?: string;
  readonly quoteDigest?: Sha256Digest;
  /** Logical source resolved to a current revision token by Native. */
  readonly sourceKey?: string;
  readonly revisionToken?: string;
}

export interface ReadSetEntry {
  readonly inputRef: string;
  readonly kind: "snapshot-document" | "projection" | "evidence" | "signal";
  /** Optional explicit resolver kind; required for scene-body vs snapshot. */
  readonly sourceKind?: string;
  /** The exact source revision observed by this reconciliation pass. */
  readonly revisionToken: string;
}

/**
 * Evidence set — passages that directly support the draft assertion.
 * Read set — every input consulted during reconciliation (may be broader).
 */
export interface EvidenceReadSetSeparation {
  readonly evidenceSet: readonly EvidenceSetEntry[];
  readonly readSet: readonly ReadSetEntry[];
  readonly readSetDigest: ReadSetDigest;
}

export interface ProjectionFreshnessInput {
  readonly projectionRef: string;
  readonly freshness: EvidenceFreshness;
  readonly sourceBasis: SourceBasis;
}

export interface NarrativeReconcilerRunContext extends ReconcilerIdentity {
  readonly runId: string;
  readonly taskId: string;
}

export interface NarrativeReconcilerInput {
  readonly context: NarrativeReconcilerRunContext;
  readonly snapshotRef: string;
  readonly snapshotDigest: Sha256Digest;
  readonly projections: readonly ProjectionFreshnessInput[];
}

export interface NarrativeProposalDraftPayload {
  readonly changeKind: ProposalChangeKind;
  readonly targetProjectionRef?: string;
  readonly semanticAssessment: SemanticAssessment;
  readonly diagnostic?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface ReconciliationEnvelopeV1
  extends ReconcilerIdentity, ProposalSchemaRef, EvidenceReadSetSeparation {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly taskId: string;
  readonly sourceBasis: SourceBasis;
  readonly changeKind: ProposalChangeKind;
  readonly targetProjectionRef?: string;
}

/** ADR 010 selector contract reused by Envelope V2. */
export type DependencySelector =
  | { readonly kind: "whole-source" }
  | {
      readonly kind: "text-range";
      readonly unit: "utf16";
      readonly from: number;
      readonly to: number;
      readonly anchorDigest?: Sha256Digest;
      readonly normalizerVersion: string;
    }
  | {
      readonly kind: "field-path";
      readonly objectIdentity: string;
      readonly fieldPath: string;
    }
  | {
      readonly kind: "exact-object-set";
      readonly objectIdentities: readonly string[];
      readonly setDigest: Sha256Digest;
    }
  | {
      readonly kind: "component-contract";
      readonly contractId: string;
      readonly contractDigest: Sha256Digest;
    };

export type DependencyRole =
  | "direct-evidence"
  | "opaque-model-context"
  | "entity-resolution"
  | "temporal-resolution"
  | "scope-resolution"
  | "projection-match"
  | "author-correction"
  | "component-contract"
  | "quality-context"
  | "ranking-only";

export type ContextExposure =
  | "model-visible"
  | "deterministic-stage"
  | "author-supplied";

export interface ContextSetEntry {
  readonly contextId: string;
  readonly inputRef: string;
  readonly stageId: string;
  readonly exposure: ContextExposure;
  readonly selector: DependencySelector;
}

export interface DependencySetEntry {
  readonly dependencyId: string;
  readonly inputRef: string;
  readonly contextIds: readonly string[];
  readonly role: DependencyRole;
  readonly selector: DependencySelector;
}

export type SourceBasisEntry = SourceBasisRevision;

export type NarrativeAssertionModality =
  | "modality-explicit-text"
  | "modality-narrator-claim"
  | "modality-hearsay"
  | "modality-character-belief"
  | "modality-inference"
  | "modality-hypothesis"
  | "modality-author-declaration"
  | "modality-imported-assertion";
export type AssertionModality = NarrativeAssertionModality;

export type NarrativeAssertionPolarity =
  | "affirmative"
  | "negative"
  | "uncertain";
export type AssertionPolarity = NarrativeAssertionPolarity;

export type NarrativeAssertionSupportClass =
  | "author-declared"
  | "direct-source"
  | "reported-source"
  | "single-source-inference"
  | "multi-source-inference"
  | "imported-assertion"
  | "unresolved";
export type AssertionSupportClass = NarrativeAssertionSupportClass;

export type NarrativeProducerKind =
  | "ai-inference"
  | "reconciler-proposal"
  | "author-declaration"
  | "import-metadata"
  | "legacy-migration";
export type ProducerKind = NarrativeProducerKind;

export interface NarrativeAssertionProducer {
  readonly kind: NarrativeProducerKind;
  readonly id: string;
  readonly version: string;
}

export interface NarrativePayloadSchemaRef {
  readonly id: string;
  readonly version: string;
}

export interface NarrativeAssertionDigests {
  readonly assertionCoreDigest: Sha256Digest;
  readonly scopeDigest: Sha256Digest;
  readonly assertionDigest: Sha256Digest;
}

export interface NarrativeRevisionChangeIntent {
  readonly changeKind: ProposalChangeKind;
  readonly targetProjectionRef?: string;
}

export interface NarrativeEffectiveMaterialBasis {
  readonly sourceBasis: readonly SourceBasisEntry[];
  readonly evidenceSet: readonly EvidenceSetEntry[];
  readonly dependencySet: readonly DependencySetEntry[];
  readonly dependencySetDigest: Sha256Digest;
  readonly materialBasisDigest: Sha256Digest;
}

export interface InterpretationRevisionBasisV2 {
  readonly kind: "interpretation";
  readonly runId: string;
  readonly taskId: string;
  readonly producer: NarrativeAssertionProducer;
  readonly contextSet: readonly ContextSetEntry[];
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
  readonly finalRequestDigest: Sha256Digest;
}

export interface HumanDerivedRevisionBasisV2 {
  readonly kind: "human-derived";
  readonly parentRevisionId: string;
  readonly expectedParentEnvelopeDigest: Sha256Digest;
  readonly parentAssertionDigest: Sha256Digest;
  readonly rootInterpretationRevisionId: string;
  readonly derivation: {
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly kind: "projection-only" | "scope-override";
    readonly proposalPayloadChangedPaths: readonly string[];
  };
  readonly revisionActor: {
    readonly kind: "human";
    readonly surfaceId: string;
  };
  readonly derivationContextSet: readonly ContextSetEntry[];
  readonly derivationContextSetDigest: Sha256Digest;
}

export interface NarrativeProjectionBindingV2 {
  /** `narrative_proposals.kind`; intentionally distinct from schema ref. */
  readonly proposalKind: string;
  readonly proposalSchemaRef: NarrativePayloadSchemaRef;
  readonly proposalPayloadDigest: Sha256Digest;
  readonly adapterContractId: string;
  readonly adapterContractVersion: string;
}

export interface NarrativeRevisionEnvelopeV2<
  TPayload = Readonly<Record<string, unknown>>,
> {
  readonly schemaVersion: 2;
  readonly assertion: {
    readonly assertionId: string | null;
    readonly assertionKind: string;
    readonly payloadSchemaRef: NarrativePayloadSchemaRef;
    readonly payload: TPayload;
    readonly scope: NarrativeScopeV2;
    readonly modality: NarrativeAssertionModality;
    readonly polarity: NarrativeAssertionPolarity;
    readonly supportClass: NarrativeAssertionSupportClass;
    readonly producer: NarrativeAssertionProducer;
    readonly producerConfidence?: number;
  };
  readonly assertionDigests: NarrativeAssertionDigests;
  readonly changeIntent: NarrativeRevisionChangeIntent;
  readonly effectiveMaterialBasis: NarrativeEffectiveMaterialBasis;
  readonly revisionBasis:
    | InterpretationRevisionBasisV2
    | HumanDerivedRevisionBasisV2;
  readonly projectionBinding: NarrativeProjectionBindingV2;
}
export type ReconciliationEnvelopeV2<
  TPayload = Readonly<Record<string, unknown>>,
> = NarrativeRevisionEnvelopeV2<TPayload>;

export interface NarrativeProposalDraftEnvelope extends ReconciliationEnvelopeV1 {
  readonly draftId: string;
  readonly proposalKey: string;
  readonly kind: string;
  readonly semanticAssessment: SemanticAssessment;
  readonly propagation: ReconciliationPropagationSignal;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface NarrativeReconcilerResult {
  readonly drafts: readonly NarrativeProposalDraftEnvelope[];
  readonly propagation: readonly ReconciliationPropagationSignal[];
}

/**
 * Thin contract: reconcilers accept freshness inputs and return declarative
 * proposal drafts only. Implementations must not surface SQL, DB operations,
 * Prepared Plan commands, or Typed Writer commands.
 */
export interface NarrativeReconciler {
  readonly identity: ReconcilerIdentity;
  reconcile(input: NarrativeReconcilerInput): NarrativeReconcilerResult;
}
