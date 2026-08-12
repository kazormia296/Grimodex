import type { Sha256Digest } from "../source/types";

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
