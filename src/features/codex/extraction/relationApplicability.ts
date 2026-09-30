import type { BindCodexEntityProposal } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import type { CreateCodexRelationProposal } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import { buildCodexRelationSemanticKey } from "./relationVocabulary";
import {
  matchExistingCodexRelation,
  type ExistingRelationCatalogRecord,
} from "./existingRelationMatcher";
import type {
  CodexEntityReviewProposal,
  CodexRelationReviewProposal,
  CodexStructureCatalogSnapshot,
} from "../codexStructureExtractionStore";

export const RELATION_ENDPOINT_BLOCKED_REASON =
  "先に両端の Entity proposal を承認してください";
export const RELATION_ALREADY_SATISFIED_REASON =
  "既に同じ関係が登録されています（適用不要）";

function resolveEndpointEntryId(
  entity: CodexEntityReviewProposal | undefined,
  catalog: CodexStructureCatalogSnapshot | null | undefined,
): string | null {
  if (!entity) return null;
  const binding = entity.proposal.payload.binding;
  if (binding.kind !== "bind-existing") return null;
  const hit = catalog?.entities.find((row) => row.ref === binding.entityRef);
  return hit?.sourceKey ?? binding.entityRef;
}

function findEntityForEndpoint(
  entities: readonly CodexEntityReviewProposal[],
  narrativeEntityId: string,
  dependencyProposalIds: readonly string[],
): CodexEntityReviewProposal | undefined {
  const byId = entities.find(
    (entity) => entity.proposal.payload.narrativeEntityId === narrativeEntityId,
  );
  if (byId) return byId;
  return entities.find((entity) =>
    dependencyProposalIds.includes(entity.proposalId),
  );
}

/**
 * Resolve Codex entry IDs for Relation endpoints when both are bind-existing.
 */
export function resolveRelationEndpointEntryIds(args: {
  readonly relation: CreateCodexRelationProposal;
  readonly entities: readonly CodexEntityReviewProposal[];
  readonly catalog: CodexStructureCatalogSnapshot | null | undefined;
}): { readonly fromCodexId: string; readonly toCodexId: string } | null {
  const deps = args.relation.dependencies.map((dep) => dep.proposalId);
  const subject = findEntityForEndpoint(
    args.entities,
    args.relation.payload.subjectEntityId,
    deps,
  );
  const object = findEntityForEndpoint(
    args.entities,
    args.relation.payload.objectEntityId,
    deps,
  );
  const fromCodexId = resolveEndpointEntryId(subject, args.catalog);
  const toCodexId = resolveEndpointEntryId(object, args.catalog);
  if (!fromCodexId || !toCodexId) return null;
  return { fromCodexId, toCodexId };
}

export function buildRelationSemanticKeyForReview(args: {
  readonly projectId: string;
  readonly relation: CreateCodexRelationProposal;
  readonly entities: readonly CodexEntityReviewProposal[];
  readonly catalog: CodexStructureCatalogSnapshot | null | undefined;
}): string | null {
  const endpoints = resolveRelationEndpointEntryIds(args);
  if (!endpoints) return null;
  const { relation } = args.relation.payload;
  return buildCodexRelationSemanticKey({
    projectId: args.projectId,
    fromCodexId: endpoints.fromCodexId,
    toCodexId: endpoints.toCodexId,
    relationType: relation.relationType,
    directionality: relation.directionality,
    forwardLabel: relation.forwardLabel,
    inverseLabel: relation.inverseLabel,
  });
}

function entityReadyForRelation(
  entity: CodexEntityReviewProposal | undefined,
): boolean {
  // Endpoint may already exist outside this run (no proposal row).
  if (!entity) return true;
  if (entity.applicability === "blocked") return false;
  if (entity.proposal.payload.binding.kind === "unresolved") return false;
  return entity.status === "approved";
}

export function relationEndpointsReady(
  relation: Pick<CodexRelationReviewProposal, "proposal">,
  entities: readonly CodexEntityReviewProposal[],
): boolean {
  const byNarrativeId = new Map(
    entities.map((entity) => [
      entity.proposal.payload.narrativeEntityId,
      entity,
    ]),
  );
  const subject = byNarrativeId.get(relation.proposal.payload.subjectEntityId);
  const object = byNarrativeId.get(relation.proposal.payload.objectEntityId);
  for (const dep of relation.proposal.dependencies) {
    const entity = entities.find((item) => item.proposalId === dep.proposalId);
    if (entity && !entityReadyForRelation(entity)) return false;
  }
  return entityReadyForRelation(subject) && entityReadyForRelation(object);
}

/**
 * Recompute Relation applicability including existing-Relation semantic match.
 * Call after Entity binding resolve, Relation field/swap edits, approve, and Apply preflight.
 */
export function evaluateCodexRelationApplicability(args: {
  readonly relation: CodexRelationReviewProposal;
  readonly entities: readonly CodexEntityReviewProposal[];
  readonly projectId: string;
  readonly existingRelations: readonly ExistingRelationCatalogRecord[];
  readonly catalog: CodexStructureCatalogSnapshot | null | undefined;
}): CodexRelationReviewProposal {
  const { relation, entities } = args;

  const semanticKey = buildRelationSemanticKeyForReview({
    projectId: args.projectId,
    relation: relation.proposal,
    entities,
    catalog: args.catalog,
  });
  const existingMatch = matchExistingCodexRelation(
    semanticKey,
    args.existingRelations,
  );
  if (existingMatch.status === "already-satisfied") {
    return {
      ...relation,
      applicability: "already-satisfied",
      existingRelationRef: existingMatch.existingRef,
      blockedReason: RELATION_ALREADY_SATISFIED_REASON,
      // Terminal UI state — not Appropriable; Native decision recorded separately.
      status: "unreviewed",
      compiledOperation: null,
    };
  }

  if (!relationEndpointsReady(relation, entities)) {
    return {
      ...relation,
      applicability: "blocked",
      existingRelationRef: undefined,
      blockedReason: RELATION_ENDPOINT_BLOCKED_REASON,
      status: relation.status === "approved" ? "unreviewed" : relation.status,
    };
  }

  return {
    ...relation,
    applicability: "applicable",
    existingRelationRef: undefined,
    blockedReason: undefined,
  };
}

export function rematchCodexRelationProposals(args: {
  readonly entities: readonly CodexEntityReviewProposal[];
  readonly relations: readonly CodexRelationReviewProposal[];
  readonly projectId: string;
  readonly existingRelations: readonly ExistingRelationCatalogRecord[];
  readonly catalog: CodexStructureCatalogSnapshot | null | undefined;
}): readonly CodexRelationReviewProposal[] {
  return args.relations.map((relation) =>
    evaluateCodexRelationApplicability({
      relation,
      entities: args.entities,
      projectId: args.projectId,
      existingRelations: args.existingRelations,
      catalog: args.catalog,
    }),
  );
}

/** Recompute Entity displayTitle / applicability / safety from latest Bind payload. */
export function deriveEntityReviewPresentation(
  proposal: BindCodexEntityProposal,
  evidenceMethods: readonly (
    | "exact"
    | "exact-with-context"
    | "fragmented"
    | "unknown"
  )[],
  previous?: Pick<
    CodexEntityReviewProposal,
    "safety" | "blockedReason" | "displayTitle"
  >,
): Pick<
  CodexEntityReviewProposal,
  "displayTitle" | "applicability" | "blockedReason" | "safety"
> {
  const binding = proposal.payload.binding;
  const typeStatus = proposal.payload.typeResolution.status;
  const typeResolved = typeStatus === "resolved";
  const applicability =
    binding.kind === "unresolved" ||
    (binding.kind === "create-new" && !typeResolved)
      ? ("blocked" as const)
      : ("applicable" as const);
  return {
    displayTitle: proposal.payload.canonicalName,
    applicability,
    blockedReason:
      applicability === "blocked"
        ? binding.kind === "unresolved"
          ? "Binding が未解決です"
          : "Codex Type が未解決です"
        : undefined,
    safety: {
      evidenceExact:
        evidenceMethods.length > 0 &&
        evidenceMethods.every(
          (method) => method === "exact" || method === "exact-with-context",
        ),
      typeResolved,
      noExistingCandidates: binding.kind === "create-new",
      explicitProperName: previous?.safety.explicitProperName ?? true,
      explicitAliasesOnly: previous?.safety.explicitAliasesOnly ?? true,
      noRelationDeps: previous?.safety.noRelationDeps ?? true,
      createNew: binding.kind === "create-new",
    },
  };
}
