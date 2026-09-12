import { invoke } from "@/lib/tauri";
import type { NarrativeExtractionWorkspaceBinding } from "@/application/narrative-extraction/nativeApi";

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

export interface Nir1EntityRelationRevisionResult {
  readonly projectId: string;
  readonly runId: string;
  readonly proposalSetId: string;
  readonly proposalId: string;
  readonly revisionId: string;
  readonly bundleDigest: string;
  readonly eligibilitySource: "nir1-entity-relation-eligibility-set";
  readonly indexKey: "nir1-reviewed-entity-relation:v1";
  readonly bundle: Nir1EntityRelationBundle;
}

export type Nir1EntityRelationRevisionRead =
  | {
      readonly status: "available";
      readonly result: Nir1EntityRelationRevisionResult;
    }
  | {
      readonly status: "unavailable";
      readonly result: { readonly reason: string };
    };

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

/** Reads a reviewed typed Revision from the current Native workspace snapshot. */
export function readNir1EntityRelationRevision(
  expectedWorkspacePath: string,
  projectId: string,
  revisionId: string,
): Promise<Nir1EntityRelationRevisionRead> {
  return invoke("nir1_entity_relation_revision_read", {
    expectedWorkspacePath,
    projectId,
    revisionId,
  });
}
