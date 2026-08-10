import { create } from "zustand";
import type { BindCodexEntityProposal } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import type { CreateCodexRelationProposal } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type {
  NarrativeExtractionRunStatus,
  NarrativeExtractionTaskCounts,
  NarrativeProposalStatus,
} from "@/features/narrative-extraction/runtime/types";
import type { MutationAuthority } from "@/features/concurrency/mutationAuthority";
import type { ExistingEntityCatalogRecord } from "./extraction/existingEntityMatcher";
import type { KnowledgeTypeCatalogRecord } from "./extraction/entityResolver";

export interface StartCodexStructureExtractionRequest {
  readonly projectId: string;
  readonly folderId: string;
  readonly language?: string;
  readonly sceneIds: readonly string[];
  readonly authority: MutationAuthority;
  readonly workspacePath: string;
  readonly openRevision: number;
  readonly existingEntries?: readonly ExistingEntityCatalogRecord[];
  readonly typeCatalog?: readonly KnowledgeTypeCatalogRecord[];
  readonly useAi?: boolean;
}

export interface CodexStructureExtractionCoverageGap {
  readonly windowId?: string;
  readonly sourceRef?: string;
  readonly reason: string;
}

export interface CodexStructureExtractionCoverage {
  readonly mode?: string;
  readonly documentCount?: number;
  readonly windowCount?: number;
  readonly completedWindows?: number;
  readonly gaps?: readonly CodexStructureExtractionCoverageGap[];
}

/**
 * Safe bulk-approve gates for Entity Binding (spec §22).
 * Relation bulk approve is disabled in v1.
 */
export interface CodexEntityProposalSafetyFlags {
  readonly evidenceExact: boolean;
  readonly typeResolved: boolean;
  readonly noExistingCandidates: boolean;
  readonly explicitProperName: boolean;
  readonly explicitAliasesOnly: boolean;
  readonly noRelationDeps: boolean;
  /** create-new only — existing bind / enrichment is never bulk-safe. */
  readonly createNew: boolean;
}

export interface CodexReviewEvidenceQuote {
  readonly anchorId: string;
  readonly quote: string;
  readonly documentRef: string;
  readonly sceneId?: string;
  readonly sceneTitle?: string;
  readonly method: "exact" | "exact-with-context" | "fragmented" | "unknown";
  readonly blocked?: boolean;
}

export interface CodexCompiledDomainOperation {
  readonly kind: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface CodexEntityReviewProposal {
  readonly proposalId: string;
  readonly revisionId: string | null;
  readonly proposalKey: string;
  readonly status: NarrativeProposalStatus;
  readonly applicability: "applicable" | "blocked";
  readonly displayTitle: string;
  readonly proposal: BindCodexEntityProposal;
  readonly evidence: readonly CodexReviewEvidenceQuote[];
  readonly safety: CodexEntityProposalSafetyFlags;
  readonly blockedReason?: string;
  readonly hypothesisId?: string;
  /**
   * Compiled Domain Operation locked at approve time.
   * Apply must reuse this payload so Native revision digests match.
   */
  readonly compiledOperation?: CodexCompiledDomainOperation | null;
}

export interface CodexRelationReviewProposal {
  readonly proposalId: string;
  readonly revisionId: string | null;
  readonly proposalKey: string;
  readonly status: NarrativeProposalStatus;
  readonly applicability: "applicable" | "blocked";
  readonly displayTitle: string;
  readonly proposal: CreateCodexRelationProposal;
  readonly evidence: readonly CodexReviewEvidenceQuote[];
  readonly subjectLabel: string;
  readonly objectLabel: string;
  readonly blockedReason?: string;
  readonly hypothesisId?: string;
  readonly compiledOperation?: CodexCompiledDomainOperation | null;
}

export interface CodexStructureCatalogEntity {
  readonly ref: string;
  readonly sourceKey: string;
  readonly name: string;
  readonly typeRef: string;
  readonly expectedVersion?: number;
  readonly aliases?: readonly string[];
}

export interface CodexStructureCatalogType {
  readonly ref: string;
  readonly sourceKey: string;
  readonly slug: string;
  readonly label: string;
}

export interface CodexStructureCatalogSnapshot {
  readonly entities: readonly CodexStructureCatalogEntity[];
  readonly types: readonly CodexStructureCatalogType[];
}

export interface CodexStructureExtractionReviewProjection {
  readonly runId: string;
  readonly projectId: string;
  readonly workspacePath: string | null;
  readonly openRevision: number | null;
  readonly proposalSetId: string | null;
  readonly status: NarrativeExtractionRunStatus;
  readonly coverage: CodexStructureExtractionCoverage;
  readonly taskCounts: NarrativeExtractionTaskCounts;
  readonly proposals: readonly CodexEntityReviewProposal[];
  readonly relationProposals: readonly CodexRelationReviewProposal[];
  readonly entityCount: number;
  readonly relationCount: number;
  readonly unresolvedCount: number;
  readonly approvedCount: number;
  /** Opaque K####/T#### → sourceKey/slug mapping for Apply. */
  readonly catalog: CodexStructureCatalogSnapshot | null;
}

export function isSafeForCodexEntityBulkApprove(
  flags: CodexEntityProposalSafetyFlags,
): boolean {
  return (
    flags.evidenceExact &&
    flags.typeResolved &&
    flags.noExistingCandidates &&
    flags.explicitProperName &&
    flags.explicitAliasesOnly &&
    flags.noRelationDeps &&
    flags.createNew
  );
}

export function buildCodexEntityProposalSafetyFlags(args: {
  readonly bindingKind: BindCodexEntityProposal["payload"]["binding"]["kind"];
  readonly typeStatus: BindCodexEntityProposal["payload"]["typeResolution"]["status"];
  readonly evidenceMethods: readonly CodexReviewEvidenceQuote["method"][];
  readonly hasExistingCandidates: boolean;
  readonly hasProperNameMention: boolean;
  readonly aliasesAllExplicit: boolean;
  readonly hasRelationDeps?: boolean;
}): CodexEntityProposalSafetyFlags {
  const evidenceExact =
    args.evidenceMethods.length > 0 &&
    args.evidenceMethods.every(
      (method) => method === "exact" || method === "exact-with-context",
    );
  return {
    evidenceExact,
    typeResolved: args.typeStatus === "resolved",
    noExistingCandidates: !args.hasExistingCandidates,
    explicitProperName: args.hasProperNameMention,
    explicitAliasesOnly: args.aliasesAllExplicit,
    noRelationDeps: !(args.hasRelationDeps ?? false),
    createNew: args.bindingKind === "create-new",
  };
}

const EMPTY_TASK_COUNTS: NarrativeExtractionTaskCounts = {
  queued: 0,
  running: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
};

interface CodexStructureExtractionState {
  projection: CodexStructureExtractionReviewProjection | null;
  selectedProposalId: string | null;
  selectedRelationProposalId: string | null;
  setProjection: (projection: CodexStructureExtractionReviewProjection) => void;
  clearProjection: () => void;
  clearIfScopeMismatch: (scope: {
    projectId: string;
    workspacePath: string;
    openRevision: number;
  }) => void;
  selectProposal: (proposalId: string | null) => void;
  selectRelationProposal: (proposalId: string | null) => void;
  updateProposalStatus: (
    proposalId: string,
    status: NarrativeProposalStatus,
  ) => void;
  updateRelationProposalStatus: (
    proposalId: string,
    status: NarrativeProposalStatus,
  ) => void;
  /**
   * Resolve unresolved binding to create-new or bind-existing.
   * Resets status to unreviewed (revision required).
   */
  resolveBinding: (
    proposalId: string,
    resolution:
      | { readonly kind: "create-new" }
      | { readonly kind: "bind-existing"; readonly entityRef: string },
  ) => void;
  reviseProposalFields: (
    proposalId: string,
    patch: {
      canonicalName?: string;
      summary?: string | null;
      aliases?: readonly string[];
      typeRef?: string;
    },
  ) => void;
  reviseRelationFields: (
    proposalId: string,
    patch: {
      directionality?: "directed" | "symmetric";
      forwardLabel?: string;
      inverseLabel?: string | null;
    },
  ) => void;
  /** Swap subject/object endpoints (and labels) for directed corrections. */
  swapRelationEndpoints: (proposalId: string) => void;
  bulkApproveSafe: () => number;
}

function replaceProposal(
  proposals: readonly CodexEntityReviewProposal[],
  proposalId: string,
  next: CodexEntityReviewProposal,
): CodexEntityReviewProposal[] {
  return proposals.map((proposal) =>
    proposal.proposalId === proposalId ? next : proposal,
  );
}

function replaceRelationProposal(
  proposals: readonly CodexRelationReviewProposal[],
  proposalId: string,
  next: CodexRelationReviewProposal,
): CodexRelationReviewProposal[] {
  return proposals.map((proposal) =>
    proposal.proposalId === proposalId ? next : proposal,
  );
}

function recount(
  proposals: readonly CodexEntityReviewProposal[],
  relationProposals: readonly CodexRelationReviewProposal[],
): Pick<
  CodexStructureExtractionReviewProjection,
  "entityCount" | "relationCount" | "unresolvedCount" | "approvedCount"
> {
  return {
    entityCount: proposals.length,
    relationCount: relationProposals.length,
    unresolvedCount:
      proposals.filter(
        (item) =>
          item.applicability === "blocked" ||
          item.proposal.payload.binding.kind === "unresolved",
      ).length +
      relationProposals.filter((item) => item.applicability === "blocked")
        .length,
    approvedCount:
      proposals.filter((item) => item.status === "approved").length +
      relationProposals.filter((item) => item.status === "approved").length,
  };
}

function relationEndpointsReady(
  relation: CodexRelationReviewProposal,
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
  const ready = (entity: CodexEntityReviewProposal | undefined): boolean => {
    if (!entity) return true; // endpoint may already exist outside this run
    if (entity.applicability === "blocked") return false;
    if (entity.proposal.payload.binding.kind === "unresolved") return false;
    return entity.status === "approved";
  };
  for (const dep of relation.proposal.dependencies) {
    const entity = entities.find((item) => item.proposalId === dep.proposalId);
    if (entity && !ready(entity)) return false;
  }
  return ready(subject) && ready(object);
}

export { relationEndpointsReady };

const RELATION_ENDPOINT_BLOCKED_REASON =
  "先に両端の Entity proposal を承認してください";

function withEvaluatedRelationApplicability(
  relation: CodexRelationReviewProposal,
  entities: readonly CodexEntityReviewProposal[],
): CodexRelationReviewProposal {
  if (!relationEndpointsReady(relation, entities)) {
    return {
      ...relation,
      applicability: "blocked",
      blockedReason: RELATION_ENDPOINT_BLOCKED_REASON,
      status: relation.status === "approved" ? "unreviewed" : relation.status,
    };
  }
  return {
    ...relation,
    applicability: "applicable",
    blockedReason: undefined,
  };
}

function reevaluateRelationProposals(
  entities: readonly CodexEntityReviewProposal[],
  relations: readonly CodexRelationReviewProposal[],
): readonly CodexRelationReviewProposal[] {
  return relations.map((relation) =>
    withEvaluatedRelationApplicability(relation, entities),
  );
}

export const useCodexStructureExtractionStore =
  create<CodexStructureExtractionState>((set, get) => ({
    projection: null,
    selectedProposalId: null,
    selectedRelationProposalId: null,

    setProjection: (projection) => {
      const entities = projection.proposals;
      const relationProposals = reevaluateRelationProposals(
        entities,
        projection.relationProposals ?? [],
      );
      const withRelations: CodexStructureExtractionReviewProjection = {
        ...projection,
        relationProposals,
        ...recount(entities, relationProposals),
      };
      const selected =
        withRelations.proposals.find(
          (proposal) => proposal.proposalId === get().selectedProposalId,
        )?.proposalId ??
        withRelations.proposals[0]?.proposalId ??
        null;
      const selectedRelation =
        withRelations.relationProposals.find(
          (proposal) =>
            proposal.proposalId === get().selectedRelationProposalId,
        )?.proposalId ??
        withRelations.relationProposals[0]?.proposalId ??
        null;
      set({
        projection: withRelations,
        selectedProposalId: selected,
        selectedRelationProposalId: selectedRelation,
      });
    },

    clearProjection: () => {
      set({
        projection: null,
        selectedProposalId: null,
        selectedRelationProposalId: null,
      });
    },

    clearIfScopeMismatch: (scope) => {
      const projection = get().projection;
      if (!projection) return;
      const mismatch =
        projection.projectId !== scope.projectId ||
        projection.workspacePath !== scope.workspacePath ||
        projection.openRevision !== scope.openRevision;
      if (mismatch) {
        set({
          projection: null,
          selectedProposalId: null,
          selectedRelationProposalId: null,
        });
      }
    },

    selectProposal: (proposalId) => {
      set({ selectedProposalId: proposalId });
    },

    selectRelationProposal: (proposalId) => {
      set({ selectedRelationProposalId: proposalId });
    },

    updateProposalStatus: (proposalId, status) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current || current.applicability === "blocked") return;
      if (
        status === "approved" &&
        (current.proposal.payload.binding.kind === "unresolved" ||
          current.proposal.payload.typeResolution.status !== "resolved")
      ) {
        return;
      }
      const proposals = replaceProposal(projection.proposals, proposalId, {
        ...current,
        status,
      });
      const relationProposals = reevaluateRelationProposals(
        proposals,
        projection.relationProposals,
      );
      set({
        projection: {
          ...projection,
          proposals,
          relationProposals,
          ...recount(proposals, relationProposals),
        },
      });
    },

    updateRelationProposalStatus: (proposalId, status) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.relationProposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current || current.applicability === "blocked") return;
      if (
        status === "approved" &&
        !relationEndpointsReady(current, projection.proposals)
      ) {
        return;
      }
      const relationProposals = replaceRelationProposal(
        projection.relationProposals,
        proposalId,
        { ...current, status },
      );
      set({
        projection: {
          ...projection,
          relationProposals,
          ...recount(projection.proposals, relationProposals),
        },
      });
    },

    resolveBinding: (proposalId, resolution) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current || current.proposal.payload.binding.kind !== "unresolved") {
        return;
      }
      const payload = current.proposal.payload;
      const aliases = payload.aliases
        .filter((alias) => alias.status === "explicit")
        .map((alias) => alias.surface);
      const nextProposal: BindCodexEntityProposal =
        resolution.kind === "create-new"
          ? {
              ...current.proposal,
              target: {
                kind: "new",
                logicalRef: payload.narrativeEntityId,
              },
              payload: {
                ...payload,
                binding: {
                  kind: "create-new",
                  entry: {
                    name: payload.canonicalName,
                    aliases,
                    summary: null,
                  },
                },
              },
            }
          : {
              ...current.proposal,
              target: {
                kind: "existing",
                entityRef: resolution.entityRef,
              },
              payload: {
                ...payload,
                binding: {
                  kind: "bind-existing",
                  entityRef: resolution.entityRef,
                  enrichment: {
                    aliasesToAdd: aliases,
                    summary: { kind: "leave" },
                  },
                },
              },
            };
      const typeResolved =
        nextProposal.payload.typeResolution.status === "resolved";
      const applicability =
        nextProposal.payload.binding.kind === "create-new" && !typeResolved
          ? ("blocked" as const)
          : ("applicable" as const);
      const proposals = replaceProposal(projection.proposals, proposalId, {
        ...current,
        proposal: nextProposal,
        applicability,
        blockedReason:
          applicability === "blocked" ? "Codex Type が未解決です" : undefined,
        revisionId: current.revisionId,
        status: "unreviewed",
        safety: buildCodexEntityProposalSafetyFlags({
          bindingKind: nextProposal.payload.binding.kind,
          typeStatus: nextProposal.payload.typeResolution.status,
          evidenceMethods: current.evidence.map((item) => item.method),
          hasExistingCandidates: false,
          hasProperNameMention: current.safety.explicitProperName,
          aliasesAllExplicit: current.safety.explicitAliasesOnly,
          hasRelationDeps: !current.safety.noRelationDeps,
        }),
      });
      const relationProposals = reevaluateRelationProposals(
        proposals,
        projection.relationProposals,
      );
      set({
        projection: {
          ...projection,
          proposals,
          relationProposals,
          ...recount(proposals, relationProposals),
        },
      });
    },

    reviseProposalFields: (proposalId, patch) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.proposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current) return;
      const payload = current.proposal.payload;
      const binding = payload.binding;
      let nextBinding = binding;
      if (binding.kind === "create-new") {
        nextBinding = {
          ...binding,
          entry: {
            name:
              patch.canonicalName !== undefined
                ? patch.canonicalName.trim()
                : binding.entry.name,
            aliases:
              patch.aliases !== undefined
                ? [...patch.aliases]
                : binding.entry.aliases,
            summary:
              patch.summary !== undefined
                ? patch.summary === null
                  ? null
                  : patch.summary.trim() || null
                : binding.entry.summary,
          },
        };
      } else if (
        binding.kind === "bind-existing" &&
        patch.summary !== undefined &&
        patch.summary !== null &&
        patch.summary.trim()
      ) {
        nextBinding = {
          ...binding,
          enrichment: {
            ...binding.enrichment,
            summary: {
              kind: "fill-if-empty",
              value: patch.summary.trim(),
            },
          },
        };
      }

      const nextType =
        patch.typeRef !== undefined
          ? ({ status: "resolved", typeRef: patch.typeRef } as const)
          : payload.typeResolution;

      const nextProposal: BindCodexEntityProposal = {
        ...current.proposal,
        payload: {
          ...payload,
          canonicalName:
            patch.canonicalName !== undefined
              ? patch.canonicalName.trim()
              : payload.canonicalName,
          typeResolution: nextType,
          binding: nextBinding,
          aliases:
            patch.aliases !== undefined
              ? patch.aliases.map((surface) => ({
                  surface,
                  status: "explicit" as const,
                }))
              : payload.aliases,
        },
      };

      const typeResolved = nextType.status === "resolved";
      const applicability =
        nextProposal.payload.binding.kind === "unresolved" ||
        (nextProposal.payload.binding.kind === "create-new" && !typeResolved)
          ? ("blocked" as const)
          : ("applicable" as const);

      const proposals = replaceProposal(projection.proposals, proposalId, {
        ...current,
        proposal: nextProposal,
        displayTitle: nextProposal.payload.canonicalName,
        revisionId: current.revisionId,
        status: "unreviewed",
        applicability,
        blockedReason:
          applicability === "blocked"
            ? nextProposal.payload.binding.kind === "unresolved"
              ? current.blockedReason
              : "Codex Type が未解決です"
            : undefined,
        safety: buildCodexEntityProposalSafetyFlags({
          bindingKind: nextProposal.payload.binding.kind,
          typeStatus: nextType.status,
          evidenceMethods: current.evidence.map((item) => item.method),
          hasExistingCandidates:
            nextProposal.payload.binding.kind === "unresolved",
          hasProperNameMention: current.safety.explicitProperName,
          aliasesAllExplicit: true,
          hasRelationDeps: !current.safety.noRelationDeps,
        }),
      });
      const relationProposals = reevaluateRelationProposals(
        proposals,
        projection.relationProposals,
      );
      set({
        projection: {
          ...projection,
          proposals,
          relationProposals,
          ...recount(proposals, relationProposals),
        },
      });
    },

    reviseRelationFields: (proposalId, patch) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.relationProposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current) return;
      const relation = current.proposal.payload.relation;
      const directionality = patch.directionality ?? relation.directionality;
      const forwardLabel =
        patch.forwardLabel !== undefined
          ? patch.forwardLabel.trim()
          : relation.forwardLabel;
      let inverseLabel =
        patch.inverseLabel !== undefined
          ? patch.inverseLabel === null
            ? null
            : patch.inverseLabel.trim() || null
          : relation.inverseLabel;
      if (directionality === "symmetric") {
        inverseLabel = forwardLabel;
      }
      if (!forwardLabel) return;

      const nextProposal: CreateCodexRelationProposal = {
        ...current.proposal,
        payload: {
          ...current.proposal.payload,
          relation: {
            ...relation,
            directionality,
            forwardLabel,
            inverseLabel,
          },
        },
      };
      const relationProposals = replaceRelationProposal(
        projection.relationProposals,
        proposalId,
        {
          ...current,
          proposal: nextProposal,
          displayTitle: `${current.subjectLabel} → ${forwardLabel} → ${current.objectLabel}`,
          revisionId: current.revisionId,
          status: "unreviewed",
        },
      );
      set({
        projection: {
          ...projection,
          relationProposals,
          ...recount(projection.proposals, relationProposals),
        },
      });
    },

    swapRelationEndpoints: (proposalId) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.relationProposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current) return;
      const payload = current.proposal.payload;
      const nextProposal: CreateCodexRelationProposal = {
        ...current.proposal,
        payload: {
          ...payload,
          subjectEntityId: payload.objectEntityId,
          objectEntityId: payload.subjectEntityId,
        },
      };
      const subjectLabel = current.objectLabel;
      const objectLabel = current.subjectLabel;
      const relationProposals = replaceRelationProposal(
        projection.relationProposals,
        proposalId,
        withEvaluatedRelationApplicability(
          {
            ...current,
            proposal: nextProposal,
            subjectLabel,
            objectLabel,
            displayTitle: `${subjectLabel} → ${payload.relation.forwardLabel} → ${objectLabel}`,
            revisionId: current.revisionId,
            status: "unreviewed",
          },
          projection.proposals,
        ),
      );
      set({
        projection: {
          ...projection,
          relationProposals,
          ...recount(projection.proposals, relationProposals),
        },
      });
    },

    /**
     * Local-only status flip for unit tests / selection criteria.
     * Product UI must call bulkApproveSafeCodexStructureProposals() so Native
     * revision + decision are persisted before Apply.
     */
    bulkApproveSafe: () => {
      const projection = get().projection;
      if (!projection) return 0;
      let approved = 0;
      const proposals = projection.proposals.map((proposal) => {
        if (
          proposal.applicability !== "applicable" ||
          proposal.status !== "unreviewed" ||
          !isSafeForCodexEntityBulkApprove(proposal.safety)
        ) {
          return proposal;
        }
        approved += 1;
        return { ...proposal, status: "approved" as const };
      });
      // Relation bulk approve intentionally disabled (spec §22).
      set({
        projection: {
          ...projection,
          proposals,
          ...recount(proposals, projection.relationProposals),
        },
      });
      return approved;
    },
  }));

export function emptyCodexTaskCounts(): NarrativeExtractionTaskCounts {
  return { ...EMPTY_TASK_COUNTS };
}

/** Test helper: wipe structure-extraction review state. */
export function resetCodexStructureExtractionStoreForTests(): void {
  useCodexStructureExtractionStore.setState({
    projection: null,
    selectedProposalId: null,
    selectedRelationProposalId: null,
  });
}
