import { invoke } from "@/lib/tauri";
import {
  narrativeExtractionAppendHumanDecision,
  type AppendDecisionResult,
  type NarrativeExtractionWorkspaceBinding,
} from "@/application/narrative-extraction/nativeApi";

export const NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH =
  "nir1/entity-relation-review" as const;

export type Nir1ScopeValue =
  | { readonly kind: "any"; readonly purpose: string }
  | { readonly kind: "exact"; readonly value: string }
  | { readonly kind: "notApplicable"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface Nir1ScopeBinding {
  readonly reading: Nir1ScopeValue;
  readonly story: Nir1ScopeValue;
  readonly auto: Nir1ScopeValue;
  readonly phase: string;
  readonly reveal: string;
  readonly pov?: string | null;
  readonly authorityRevision: string;
}

export interface Nir1EvidenceInput {
  readonly evidenceId: string;
  readonly sourceRef: string;
  readonly quote: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
}

export interface Nir1EntityInput {
  readonly entityId: string;
  readonly entityType: string;
  readonly label: string;
  readonly sourceToken: string;
  readonly scope: Nir1ScopeBinding;
  readonly evidence: readonly Nir1EvidenceInput[];
}

export interface Nir1RelationInput {
  readonly edgeId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly relationType: string;
  readonly directionality: "directed" | "symmetric";
  readonly sourceToken: string;
  readonly evidenceIds: readonly string[];
}

export interface Nir1EntityRelationBundle {
  readonly projectId: string;
  /** Native replaces this request field with the persisted Revision ID. */
  readonly revisionId: string;
  readonly producer: "nir1-reviewed-entity-relation-v1";
  readonly entities: readonly Nir1EntityInput[];
  readonly relations: readonly Nir1RelationInput[];
}

export interface Nir1EntityRelationRevisionRequest {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalKey: string;
  readonly bundle: Nir1EntityRelationBundle;
}

export interface Nir1EntityRelationRevisionPrepareRequest {
  readonly projectId: string;
  readonly sceneId: string;
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly proposalKey?: string | null;
}

export interface Nir1EntityRelationRevisionCreateResult {
  readonly proposalSetId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly originKind: "nir1-typed";
  readonly producer: "nir1-reviewed-entity-relation-v1";
  readonly indexKey: "nir1-reviewed-entity-relation:v1";
  readonly eligibilitySource: "nir1-entity-relation-eligibility-set";
  readonly payloadDigest: string;
  readonly status: "unreviewed";
}

export interface Nir1EntityRelationRevisionReadRequest {
  readonly expectedWorkspacePath: string;
  readonly projectId: string;
  readonly revisionId: string;
}

export interface Nir1EntityRelationRevisionCurrentReadRequest {
  readonly expectedWorkspacePath: string;
  readonly projectId: string;
  readonly runId: string;
}

export interface Nir1EntityRelationRevisionRestoreRequest {
  readonly expectedWorkspacePath: string;
  readonly projectId: string;
  readonly entityId: string;
  readonly relationId?: string | null;
}

/**
 * The renderer publication is intentionally narrower than the Native typed
 * bundle.  Source tokens, Scope bindings, material closure and Freshness
 * evidence remain inside Native; the review surface only needs these labels,
 * identities and Evidence quotes to support an explicit human decision.
 */
export interface Nir1EntityRelationReviewEntity {
  readonly entityId: string;
  readonly entityType: string;
  readonly label: string;
  readonly evidence: readonly Nir1EvidenceInput[];
}

export interface Nir1EntityRelationReviewRelation {
  readonly edgeId: string;
  readonly fromEntityId: string;
  readonly toEntityId: string;
  readonly relationType: string;
  readonly directionality: "directed" | "symmetric";
  readonly evidenceIds: readonly string[];
}

export interface Nir1EntityRelationRevisionReadResult {
  readonly projectId: string;
  readonly runId: string;
  readonly proposalSetId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly sceneId: string;
  readonly entities: readonly Nir1EntityRelationReviewEntity[];
  readonly relations: readonly Nir1EntityRelationReviewRelation[];
}

export type Nir1EntityRelationRevisionReadResponse =
  | {
      readonly status: "available";
      readonly result: Nir1EntityRelationRevisionReadResult;
    }
  | {
      readonly status: "unavailable";
      readonly result: { readonly reason: string };
    };

export interface Nir1EntityRelationRevisionPrepareResult {
  readonly runId: string;
  readonly status: "draft";
  /**
   * Metadata-only receipt returned after Native has durably created the Run
   * and immutable Revision. The current-reader is the only path that can
   * publish Evidence to the renderer.
   */
  readonly receipt: {
    readonly proposalSetId: string;
    readonly proposalId: string;
    readonly revisionId: string;
    readonly status: "unreviewed";
  };
}

export type Nir1EntityRelationRevisionCurrentReadResponse =
  | {
      readonly status: "draft" | "available";
      readonly result: Nir1EntityRelationRevisionReadResult;
    }
  | {
      readonly status: "unavailable";
      readonly result: { readonly reason: string };
    };

export interface Nir1EntityRelationRevisionRestoreResult {
  readonly runId: string;
  readonly response: Nir1EntityRelationRevisionCurrentReadResponse;
}

export type Nir1EntityRelationHumanDecision =
  | "approved"
  | "rejected"
  | "deferred";

/**
 * Stores one unreviewed, Native-bound typed Entity/Relation Revision. The
 * caller must use the existing Native workspace binding; this API does not
 * activate graph retrieval or forward any material to an AI provider.
 */
export function createNir1EntityRelationRevision(
  request: Nir1EntityRelationRevisionRequest,
  workspaceBinding: NarrativeExtractionWorkspaceBinding,
): Promise<Nir1EntityRelationRevisionCreateResult> {
  return invoke("nir1_entity_relation_revision_create", {
    payload: {
      runId: request.runId,
      projectId: request.projectId,
      proposalKey: request.proposalKey,
      bundle: request.bundle,
    },
    workspaceBinding,
  });
}

/**
 * Resolve live Codex/Relation identities in Native and persist a dedicated
 * review Run plus unreviewed typed Revision atomically.
 */
export function prepareNir1EntityRelationRevision(
  request: Nir1EntityRelationRevisionPrepareRequest,
  workspaceBinding: NarrativeExtractionWorkspaceBinding,
): Promise<Nir1EntityRelationRevisionPrepareResult> {
  return invoke("nir1_entity_relation_revision_prepare", {
    payload: request,
    workspaceBinding,
  });
}

/**
 * Reopens only a current, explicitly human-approved typed Revision from the
 * Native cold reader. The return is the dedicated Entity/Relation projection;
 * generic review bundles and graph/AI routes remain separate.
 */
export function readNir1EntityRelationRevision(
  request: Nir1EntityRelationRevisionReadRequest,
): Promise<Nir1EntityRelationRevisionReadResponse> {
  return invoke("nir1_entity_relation_revision_read", {
    expectedWorkspacePath: request.expectedWorkspacePath,
    projectId: request.projectId,
    revisionId: request.revisionId,
  });
}

/** Read the current draft/approved typed Revision for a dedicated review Run. */
export function readCurrentNir1EntityRelationRevision(
  request: Nir1EntityRelationRevisionCurrentReadRequest,
): Promise<Nir1EntityRelationRevisionCurrentReadResponse> {
  return invoke("nir1_entity_relation_revision_read_current", {
    expectedWorkspacePath: request.expectedWorkspacePath,
    projectId: request.projectId,
    runId: request.runId,
  });
}

/**
 * Resolve a launcher target inside the Native typed family before the
 * bounded generic resumable-run list. The response remains the dedicated
 * current typed projection, including an unavailable reason for a matched
 * stale Run; no generic payload is consulted.
 */
export function restoreNir1EntityRelationRevision(
  request: Nir1EntityRelationRevisionRestoreRequest,
): Promise<Nir1EntityRelationRevisionRestoreResult | null> {
  return invoke("nir1_entity_relation_revision_restore", {
    expectedWorkspacePath: request.expectedWorkspacePath,
    projectId: request.projectId,
    entityId: request.entityId,
    relationId: request.relationId ?? null,
  });
}

/**
 * Use the existing Native human-decision ledger for the dedicated typed
 * proposal.  The typed reader remains the authority for the post-decision
 * status; this helper deliberately does not infer availability locally.
 */
export function decideNir1EntityRelationRevision(request: {
  readonly runId: string;
  readonly projectId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly decision: Nir1EntityRelationHumanDecision;
}): Promise<AppendDecisionResult> {
  return narrativeExtractionAppendHumanDecision({
    runId: request.runId,
    projectId: request.projectId,
    proposalId: request.proposalId,
    revisionId: request.revisionId,
    decision: request.decision,
    createdBy: "nir1-entity-relation-review",
  });
}
