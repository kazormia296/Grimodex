import type { Sha256Digest } from "../source/types";
import type {
  DependencyRole as CanonicalDependencyRole,
  DependencySelector as CanonicalDependencySelector,
} from "@/features/narrative-semantic-core/contracts/dependencyRole";
import type {
  AssertionModality as CanonicalAssertionModality,
  AssertionPolarity as CanonicalAssertionPolarity,
  AssertionSupportClass as CanonicalAssertionSupportClass,
  ContextSetEntry as CanonicalContextSetEntry,
  DependencySetEntry as CanonicalDependencySetEntry,
  HumanDerivedRevisionBasisV2 as CanonicalHumanDerivedRevisionBasisV2,
  InterpretationRevisionBasisV2 as CanonicalInterpretationRevisionBasisV2,
  NarrativeAssertionDigests as CanonicalNarrativeAssertionDigests,
  NarrativeAssertionProducer as CanonicalNarrativeAssertionProducer,
  NarrativeChangeKind as CanonicalNarrativeChangeKind,
  NarrativeChangeIntent as CanonicalNarrativeChangeIntent,
  NarrativeEffectiveMaterialBasis as CanonicalNarrativeEffectiveMaterialBasis,
  NarrativePayloadSchemaRef as CanonicalNarrativePayloadSchemaRef,
  NarrativeProjectionBinding as CanonicalNarrativeProjectionBinding,
  NarrativeRevisionEnvelopeV2 as CanonicalNarrativeRevisionEnvelopeV2,
} from "@/features/narrative-semantic-core/contracts/narrativeIr";
import type {
  NarrativeScopeV2 as CanonicalNarrativeScopeV2,
  ReferenceScopeConstraint as CanonicalReferenceScopeConstraint,
  TemporalBoundary as CanonicalTemporalBoundary,
  TemporalScopeConstraint as CanonicalTemporalScopeConstraint,
} from "@/features/narrative-semantic-core/contracts/scopeV2";

/** ADR 009 Scope V2 reference-axis constraint. */
export type NarrativeScopeReferenceConstraint =
  CanonicalReferenceScopeConstraint;

export type NarrativeScopeTemporalBoundary = CanonicalTemporalBoundary;

/** ADR 009 Scope V2 temporal-axis constraint. */
export type NarrativeScopeTemporalConstraint = CanonicalTemporalScopeConstraint;

/** The complete, explicit Scope shape required by Narrative IR V2. */
export type NarrativeScopeV2 = CanonicalNarrativeScopeV2;

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

export type ProposalChangeKind = CanonicalNarrativeChangeKind;

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

/** ADR 010 selector and role contracts are owned by the semantic core. */
export type DependencySelector = CanonicalDependencySelector;
export type DependencyRole = CanonicalDependencyRole;
export type ContextSetEntry = CanonicalContextSetEntry;
export type DependencySetEntry = CanonicalDependencySetEntry;
export type ContextExposure = ContextSetEntry["exposure"];

export type SourceBasisEntry = SourceBasisRevision;

export type NarrativeAssertionModality = CanonicalAssertionModality;
export type AssertionModality = NarrativeAssertionModality;

export type NarrativeAssertionPolarity = CanonicalAssertionPolarity;
export type AssertionPolarity = NarrativeAssertionPolarity;

export type NarrativeAssertionSupportClass = CanonicalAssertionSupportClass;
export type AssertionSupportClass = NarrativeAssertionSupportClass;

export type NarrativeProducerKind = CanonicalNarrativeAssertionProducer["kind"];
export type ProducerKind = NarrativeProducerKind;

export type NarrativeAssertionProducer = CanonicalNarrativeAssertionProducer;

export type NarrativePayloadSchemaRef = CanonicalNarrativePayloadSchemaRef;

export type NarrativeAssertionDigests = CanonicalNarrativeAssertionDigests;

export type NarrativeRevisionChangeIntent = CanonicalNarrativeChangeIntent;

export type NarrativeEffectiveMaterialBasis =
  CanonicalNarrativeEffectiveMaterialBasis;

export type InterpretationRevisionBasisV2 =
  CanonicalInterpretationRevisionBasisV2;

export type HumanDerivedRevisionBasisV2 = CanonicalHumanDerivedRevisionBasisV2;

export type NarrativeProjectionBindingV2 = CanonicalNarrativeProjectionBinding;

export type NarrativeRevisionEnvelopeV2<
  TPayload = Readonly<Record<string, unknown>>,
> = CanonicalNarrativeRevisionEnvelopeV2<TPayload>;
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
