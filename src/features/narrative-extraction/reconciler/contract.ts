import type {
  EvidenceFreshness,
  EvidenceReadSetSeparation,
  NarrativeProposalDraftEnvelope,
  NarrativeProposalDraftPayload,
  NarrativeReconcilerInput,
  NarrativeReconcilerResult,
  NarrativeReconcilerRunContext,
  ProposalChangeKind,
  ReconciliationPropagationSignal,
  SemanticAssessment,
  SourceBasis,
} from "./types";

const ALLOWED_PROPAGATION: ReadonlySet<ReconciliationPropagationSignal> =
  new Set(["needs-reconciliation"]);

const FRESHNESS_VALUES: ReadonlySet<EvidenceFreshness> = new Set([
  "fresh",
  "stale",
  "source-missing",
  "anchor-mismatch",
  "read-set-drift",
  "unknown",
]);

const SEMANTIC_ASSESSMENT_VALUES: ReadonlySet<SemanticAssessment> = new Set([
  "unchanged",
  "revision",
  "retraction",
  "conflict",
]);

export function isEvidenceFreshness(value: string): value is EvidenceFreshness {
  return FRESHNESS_VALUES.has(value as EvidenceFreshness);
}

export function isSemanticAssessment(
  value: string,
): value is SemanticAssessment {
  return SEMANTIC_ASSESSMENT_VALUES.has(value as SemanticAssessment);
}

export function isAllowedPropagationSignal(
  signal: string,
): signal is ReconciliationPropagationSignal {
  return ALLOWED_PROPAGATION.has(signal as ReconciliationPropagationSignal);
}

export function assertDeclarativeReconcilerResult(
  result: NarrativeReconcilerResult,
): void {
  for (const signal of result.propagation) {
    if (!isAllowedPropagationSignal(signal)) {
      throw new Error(
        `NarrativeReconciler propagation '${signal}' is not allowed; only needs-reconciliation is permitted`,
      );
    }
  }
  for (const draft of result.drafts) {
    if (!isAllowedPropagationSignal(draft.propagation)) {
      throw new Error(
        `Proposal draft '${draft.draftId}' propagation '${draft.propagation}' is not allowed`,
      );
    }
  }
}

export function buildProposalDraftEnvelope(input: {
  readonly context: NarrativeReconcilerRunContext;
  readonly schema: {
    readonly schemaId: string;
    readonly schemaVersion: string;
  };
  readonly proposalKey: string;
  readonly kind: string;
  readonly sourceBasis: SourceBasis;
  readonly evidenceReadSet: EvidenceReadSetSeparation;
  readonly draft: NarrativeProposalDraftPayload;
  readonly createId?: () => string;
}): NarrativeProposalDraftEnvelope {
  const createId = input.createId ?? (() => crypto.randomUUID());
  return {
    draftId: createId(),
    proposalKey: input.proposalKey,
    kind: input.kind,
    reconcilerId: input.context.reconcilerId,
    reconcilerVersion: input.context.reconcilerVersion,
    schemaId: input.schema.schemaId,
    schemaVersion: input.schema.schemaVersion,
    sourceBasis: input.sourceBasis,
    evidenceSet: input.evidenceReadSet.evidenceSet,
    readSet: input.evidenceReadSet.readSet,
    readSetDigest: input.evidenceReadSet.readSetDigest,
    changeKind: input.draft.changeKind,
    targetProjectionRef: input.draft.targetProjectionRef,
    semanticAssessment: input.draft.semanticAssessment,
    propagation: "needs-reconciliation",
    payload: input.draft.payload,
  };
}

/**
 * Core-side freshness rollup for reconciler inputs. Semantic outcomes are
 * intentionally excluded — callers attach SemanticAssessment separately.
 */
export function rollupProjectionFreshness(
  input: NarrativeReconcilerInput,
): EvidenceFreshness {
  if (input.projections.length === 0) return "unknown";
  const statuses = input.projections.map((p) => p.freshness);
  if (statuses.some((s) => s === "source-missing")) return "source-missing";
  if (statuses.some((s) => s === "anchor-mismatch")) return "anchor-mismatch";
  if (statuses.some((s) => s === "read-set-drift")) return "read-set-drift";
  if (statuses.some((s) => s === "stale")) return "stale";
  if (statuses.every((s) => s === "fresh")) return "fresh";
  return "unknown";
}

export function staleProjectionRefs(
  input: NarrativeReconcilerInput,
): readonly string[] {
  return input.projections
    .filter((p) => p.freshness !== "fresh")
    .map((p) => p.projectionRef);
}

export function isCompensatingChangeKind(
  changeKind: ProposalChangeKind,
): boolean {
  return changeKind === "retract";
}
