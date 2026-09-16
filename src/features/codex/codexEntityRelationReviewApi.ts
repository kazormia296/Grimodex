import {
  captureNarrativeExtractionWorkspaceBinding,
  narrativeExtractionListResumableRuns,
} from "@/application/narrative-extraction/nativeApi";
import {
  runAuthoritativeMutation,
  type MutationAuthority,
} from "@/features/concurrency/mutationAuthority";
import {
  NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
  prepareNir1EntityRelationRevision,
  readCurrentNir1EntityRelationRevision,
  type Nir1EntityRelationRevisionCurrentReadResponse,
  type Nir1EntityRelationRevisionPrepareResult,
  type Nir1EntityRelationRevisionReadResult,
} from "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi";

export interface CodexEntityRelationReviewPrepareInput {
  readonly projectId: string;
  readonly workspacePath: string;
  readonly authority: MutationAuthority;
  readonly sceneId: string;
  readonly entityIds: readonly string[];
  readonly relationIds: readonly string[];
  readonly proposalKey: string;
}

export interface CodexEntityRelationReviewRestore {
  readonly runId: string;
  readonly response: Nir1EntityRelationRevisionCurrentReadResponse;
}

/**
 * The launcher target is used only to select a matching durable Run during a
 * warm restore. Native includes both Relation endpoint Entities in the review
 * projection, so both the launcher Entity and optional Relation must match.
 */
export interface CodexEntityRelationReviewRestoreTarget {
  readonly entityId: string;
  readonly relationId?: string | null;
}

function matchesRestoreTarget(
  response: Nir1EntityRelationRevisionCurrentReadResponse,
  target: CodexEntityRelationReviewRestoreTarget,
): boolean {
  if (response.status === "unavailable") return false;
  const entityMatches = response.result.entities.some(
    (entity) => entity.entityId === target.entityId,
  );
  const relationMatches =
    !target.relationId ||
    response.result.relations.some(
      (relation) => relation.edgeId === target.relationId,
    );
  return entityMatches && relationMatches;
}

function exactIdList(values: readonly string[]): string[] {
  return [...new Set(values)]
    .filter(
      (value) =>
        value.length > 0 && value.trim() === value && !value.includes("\u0000"),
    )
    .sort();
}

function requireExactValue(value: string, label: string): string {
  if (
    value.length === 0 ||
    value.trim() !== value ||
    value.includes("\u0000")
  ) {
    throw new Error(
      `NIR1_ENTITY_RELATION_${label.toUpperCase()}_INVALID: exact value required`,
    );
  }
  return value;
}

/**
 * Direct Option B coordinator. The selector is only an input adapter; Native
 * resolves the live Codex entities, relations, endpoints, Evidence, and Scope.
 */
export async function prepareCodexEntityRelationReview(
  input: CodexEntityRelationReviewPrepareInput,
): Promise<Nir1EntityRelationRevisionPrepareResult> {
  const workspaceOpenRevision = input.authority.workspaceOpenRevision;
  if (
    input.authority.projectId !== input.projectId ||
    input.authority.workspacePath !== input.workspacePath ||
    workspaceOpenRevision === null ||
    !Number.isSafeInteger(workspaceOpenRevision) ||
    workspaceOpenRevision < 1
  ) {
    throw new Error(
      "NEX_CHRONICLE_WORKSPACE_BINDING_INVALID: typed review authority changed",
    );
  }
  const entityIds = exactIdList(input.entityIds);
  const relationIds = exactIdList(input.relationIds);
  if (entityIds.length === 0 && relationIds.length === 0) {
    throw new Error(
      "NIR1_ENTITY_RELATION_TYPED_REVIEW_EMPTY: select an Entity or Relation",
    );
  }
  const payload = {
    projectId: input.projectId,
    sceneId: requireExactValue(input.sceneId, "scene"),
    entityIds,
    relationIds,
    proposalKey: requireExactValue(input.proposalKey, "proposal_key"),
  } as const;
  const outcome = await runAuthoritativeMutation(input.authority, async () => {
    const binding = await captureNarrativeExtractionWorkspaceBinding(
      input.workspacePath,
    );
    return prepareNir1EntityRelationRevision(payload, binding);
  });
  if (outcome.status !== "current" || !outcome.value) {
    throw new Error(
      "NEX_CHRONICLE_WORKSPACE_BINDING_INVALID: typed review authority changed",
    );
  }
  return outcome.value;
}

export async function restoreCodexEntityRelationReview(
  projectId: string,
  workspacePath: string,
  target?: CodexEntityRelationReviewRestoreTarget,
): Promise<CodexEntityRelationReviewRestore | null> {
  const summaries = await narrativeExtractionListResumableRuns({
    projectId,
    surfacePathId: NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH,
    limit: 8,
  });
  let unavailableFallback: CodexEntityRelationReviewRestore | null = null;
  for (const summary of summaries) {
    if (
      summary.projectId !== projectId ||
      summary.surfacePathId !== NIR1_ENTITY_RELATION_REVIEW_SURFACE_PATH
    ) {
      continue;
    }
    const response = await readCurrentNir1EntityRelationRevision({
      expectedWorkspacePath: workspacePath,
      projectId,
      runId: summary.runId,
    });
    if (target && response.status === "unavailable") {
      unavailableFallback ??= { runId: summary.runId, response };
      continue;
    }
    if (target && !matchesRestoreTarget(response, target)) continue;
    return { runId: summary.runId, response };
  }
  return unavailableFallback;
}

export interface CodexEntityRelationReviewReplacementInput {
  readonly projectId: string;
  readonly workspacePath: string;
  readonly authority: MutationAuthority;
  readonly result: Nir1EntityRelationRevisionReadResult;
}

export function replacementPrepareInput(
  input: CodexEntityRelationReviewReplacementInput,
): CodexEntityRelationReviewPrepareInput {
  return {
    projectId: input.projectId,
    workspacePath: input.workspacePath,
    authority: input.authority,
    sceneId: input.result.sceneId,
    entityIds: input.result.entities.map((entity) => entity.entityId),
    relationIds: input.result.relations.map((relation) => relation.edgeId),
    proposalKey: `codex-replacement:${input.result.runId}:${input.result.revisionId}`,
  };
}
