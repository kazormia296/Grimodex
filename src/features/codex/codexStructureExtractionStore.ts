import { create } from "zustand";
import type { BindCodexEntityProposal } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import type { BindCodexPhaseProposal } from "@/features/narrative-extraction/proposals/bindCodexPhaseProposal";
import type { CreateCodexRelationProposal } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { SetCodexBaseDetailProposal } from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";
import type { PhasePersistenceDecision } from "@/features/narrative-extraction/ir/inferences/phaseBoundary";
import type { ProjectedDetailValue } from "@/features/codex/details/semanticBindingTypes";
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
}

/**
 * Safe bulk-approve gates for Base Detail (Phase/Detail slice §34).
 * Excludes clear / summarized / unbound from bulk.
 */
export interface CodexBaseDetailProposalSafetyFlags {
  readonly timeless: boolean;
  readonly emptyExisting: boolean;
  readonly lossless: boolean;
  readonly bound: boolean;
  readonly notClear: boolean;
  readonly notSummarized: boolean;
}

/**
 * Safe bulk-approve gates for Phase bind (Phase/Detail slice §34).
 * Excludes clear / summarized / unbound / existing-phase-append from bulk.
 */
export interface CodexPhaseProposalSafetyFlags {
  readonly noSummaryOverride: boolean;
  readonly noConflict: boolean;
  readonly bound: boolean;
  readonly notClear: boolean;
  readonly notSummarized: boolean;
  readonly notExistingPhaseAppend: boolean;
}

export interface CodexDetailValueDelta {
  readonly definitionRef: string;
  readonly facetKey?: string;
  readonly previousDisplay: string;
  readonly nextDisplay: string;
  readonly writeKind: "set" | "clear" | "inherit";
}

export interface CodexBaseDetailReviewProposal {
  readonly proposalId: string;
  readonly revisionId: string | null;
  readonly proposalKey: string;
  readonly status: NarrativeProposalStatus;
  readonly applicability: "applicable" | "blocked";
  readonly displayTitle: string;
  readonly proposal: SetCodexBaseDetailProposal;
  readonly evidence: readonly CodexReviewEvidenceQuote[];
  readonly safety: CodexBaseDetailProposalSafetyFlags;
  readonly entityLabel: string;
  readonly facetKey: string;
  readonly existingValue: ProjectedDetailValue | null;
  readonly unbound?: boolean;
  readonly blockedReason?: string;
}

export interface CodexPhaseReviewProposal {
  readonly proposalId: string;
  readonly revisionId: string | null;
  readonly proposalKey: string;
  readonly status: NarrativeProposalStatus;
  readonly applicability: "applicable" | "blocked";
  readonly displayTitle: string;
  readonly proposal: BindCodexPhaseProposal;
  readonly evidence: readonly CodexReviewEvidenceQuote[];
  readonly safety: CodexPhaseProposalSafetyFlags;
  readonly entityLabel: string;
  readonly persistence: PhasePersistenceDecision | null;
  readonly valueDeltas: readonly CodexDetailValueDelta[];
  readonly existingPhaseCandidates: readonly {
    readonly ref: string;
    readonly score: number;
  }[];
  readonly blockedReason?: string;
  readonly boundaryId?: string;
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
  readonly baseDetailProposals: readonly CodexBaseDetailReviewProposal[];
  readonly phaseProposals: readonly CodexPhaseReviewProposal[];
  readonly entityCount: number;
  readonly relationCount: number;
  readonly baseDetailCount: number;
  readonly phaseCount: number;
  readonly unresolvedCount: number;
  readonly approvedCount: number;
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

export function isSafeForCodexBaseDetailBulkApprove(
  flags: CodexBaseDetailProposalSafetyFlags,
): boolean {
  return (
    flags.timeless &&
    flags.emptyExisting &&
    flags.lossless &&
    flags.bound &&
    flags.notClear &&
    flags.notSummarized
  );
}

export function isSafeForCodexPhaseBulkApprove(
  flags: CodexPhaseProposalSafetyFlags,
): boolean {
  return (
    flags.noSummaryOverride &&
    flags.noConflict &&
    flags.bound &&
    flags.notClear &&
    flags.notSummarized &&
    flags.notExistingPhaseAppend
  );
}

export function buildCodexBaseDetailProposalSafetyFlags(args: {
  readonly temporalEligibility: "timeless" | "corpus-initial";
  readonly existingValue: ProjectedDetailValue | null;
  readonly evidenceMethods: readonly CodexReviewEvidenceQuote["method"][];
  readonly bound: boolean;
  readonly valueKind: ProjectedDetailValue["kind"];
  readonly summarized?: boolean;
}): CodexBaseDetailProposalSafetyFlags {
  const lossless =
    args.evidenceMethods.length > 0 &&
    args.evidenceMethods.every(
      (method) => method === "exact" || method === "exact-with-context",
    );
  const emptyExisting =
    args.existingValue === null || args.existingValue.kind === "clear";
  return {
    timeless: args.temporalEligibility === "timeless",
    emptyExisting,
    lossless,
    bound: args.bound,
    notClear: args.valueKind !== "clear",
    notSummarized: !(args.summarized ?? false),
  };
}

export function buildCodexPhaseProposalSafetyFlags(args: {
  readonly summaryOverrideKind: "leave" | "set";
  readonly bindingKind: BindCodexPhaseProposal["payload"]["binding"]["kind"];
  readonly hasConflict: boolean;
  readonly bound: boolean;
  readonly hasClearWrite: boolean;
}): CodexPhaseProposalSafetyFlags {
  const noSummaryOverride = args.summaryOverrideKind === "leave";
  return {
    noSummaryOverride,
    noConflict: !args.hasConflict,
    bound: args.bound,
    notClear: !args.hasClearWrite,
    notSummarized: noSummaryOverride,
    notExistingPhaseAppend: args.bindingKind !== "bind-existing",
  };
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
  selectedBaseDetailProposalId: string | null;
  selectedPhaseProposalId: string | null;
  setProjection: (projection: CodexStructureExtractionReviewProjection) => void;
  clearProjection: () => void;
  clearIfScopeMismatch: (scope: {
    projectId: string;
    workspacePath: string;
    openRevision: number;
  }) => void;
  selectProposal: (proposalId: string | null) => void;
  selectRelationProposal: (proposalId: string | null) => void;
  selectBaseDetailProposal: (proposalId: string | null) => void;
  selectPhaseProposal: (proposalId: string | null) => void;
  updateProposalStatus: (
    proposalId: string,
    status: NarrativeProposalStatus,
  ) => void;
  updateRelationProposalStatus: (
    proposalId: string,
    status: NarrativeProposalStatus,
  ) => void;
  updateBaseDetailProposalStatus: (
    proposalId: string,
    status: NarrativeProposalStatus,
  ) => void;
  updatePhaseProposalStatus: (
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
  reviseBaseDetailValue: (
    proposalId: string,
    value: ProjectedDetailValue,
  ) => void;
  bindBaseDetailDefinition: (
    proposalId: string,
    definitionRef: string,
    options?: { readonly rememberBinding?: boolean },
  ) => void;
  resolvePhaseBinding: (
    proposalId: string,
    resolution:
      | { readonly kind: "create-new"; readonly label?: string }
      | {
          readonly kind: "bind-existing";
          readonly phaseRef: string;
          readonly expectedVersion: number;
        },
  ) => void;
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

function replaceBaseDetailProposal(
  proposals: readonly CodexBaseDetailReviewProposal[],
  proposalId: string,
  next: CodexBaseDetailReviewProposal,
): CodexBaseDetailReviewProposal[] {
  return proposals.map((proposal) =>
    proposal.proposalId === proposalId ? next : proposal,
  );
}

function replacePhaseProposal(
  proposals: readonly CodexPhaseReviewProposal[],
  proposalId: string,
  next: CodexPhaseReviewProposal,
): CodexPhaseReviewProposal[] {
  return proposals.map((proposal) =>
    proposal.proposalId === proposalId ? next : proposal,
  );
}

function recount(
  proposals: readonly CodexEntityReviewProposal[],
  relationProposals: readonly CodexRelationReviewProposal[],
  baseDetailProposals: readonly CodexBaseDetailReviewProposal[] = [],
  phaseProposals: readonly CodexPhaseReviewProposal[] = [],
): Pick<
  CodexStructureExtractionReviewProjection,
  | "entityCount"
  | "relationCount"
  | "baseDetailCount"
  | "phaseCount"
  | "unresolvedCount"
  | "approvedCount"
> {
  return {
    entityCount: proposals.length,
    relationCount: relationProposals.length,
    baseDetailCount: baseDetailProposals.length,
    phaseCount: phaseProposals.length,
    unresolvedCount:
      proposals.filter(
        (item) =>
          item.applicability === "blocked" ||
          item.proposal.payload.binding.kind === "unresolved",
      ).length +
      relationProposals.filter((item) => item.applicability === "blocked")
        .length +
      baseDetailProposals.filter(
        (item) => item.applicability === "blocked" || item.unbound,
      ).length +
      phaseProposals.filter(
        (item) =>
          item.applicability === "blocked" ||
          item.proposal.payload.binding.kind === "unresolved",
      ).length,
    approvedCount:
      proposals.filter((item) => item.status === "approved").length +
      relationProposals.filter((item) => item.status === "approved").length +
      baseDetailProposals.filter((item) => item.status === "approved").length +
      phaseProposals.filter((item) => item.status === "approved").length,
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

export const useCodexStructureExtractionStore =
  create<CodexStructureExtractionState>((set, get) => ({
    projection: null,
    selectedProposalId: null,
    selectedRelationProposalId: null,
    selectedBaseDetailProposalId: null,
    selectedPhaseProposalId: null,

    setProjection: (projection) => {
      const withDefaults: CodexStructureExtractionReviewProjection = {
        ...projection,
        relationProposals: projection.relationProposals ?? [],
        baseDetailProposals: projection.baseDetailProposals ?? [],
        phaseProposals: projection.phaseProposals ?? [],
        ...recount(
          projection.proposals,
          projection.relationProposals ?? [],
          projection.baseDetailProposals ?? [],
          projection.phaseProposals ?? [],
        ),
      };
      const selected =
        withDefaults.proposals.find(
          (proposal) => proposal.proposalId === get().selectedProposalId,
        )?.proposalId ??
        withDefaults.proposals[0]?.proposalId ??
        null;
      const selectedRelation =
        withDefaults.relationProposals.find(
          (proposal) =>
            proposal.proposalId === get().selectedRelationProposalId,
        )?.proposalId ??
        withDefaults.relationProposals[0]?.proposalId ??
        null;
      const selectedBase =
        withDefaults.baseDetailProposals.find(
          (proposal) =>
            proposal.proposalId === get().selectedBaseDetailProposalId,
        )?.proposalId ??
        withDefaults.baseDetailProposals[0]?.proposalId ??
        null;
      const selectedPhase =
        withDefaults.phaseProposals.find(
          (proposal) => proposal.proposalId === get().selectedPhaseProposalId,
        )?.proposalId ??
        withDefaults.phaseProposals[0]?.proposalId ??
        null;
      set({
        projection: withDefaults,
        selectedProposalId: selected,
        selectedRelationProposalId: selectedRelation,
        selectedBaseDetailProposalId: selectedBase,
        selectedPhaseProposalId: selectedPhase,
      });
    },

    clearProjection: () => {
      set({
        projection: null,
        selectedProposalId: null,
        selectedRelationProposalId: null,
        selectedBaseDetailProposalId: null,
        selectedPhaseProposalId: null,
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
          selectedBaseDetailProposalId: null,
          selectedPhaseProposalId: null,
        });
      }
    },

    selectProposal: (proposalId) => {
      set({ selectedProposalId: proposalId });
    },

    selectRelationProposal: (proposalId) => {
      set({ selectedRelationProposalId: proposalId });
    },

    selectBaseDetailProposal: (proposalId) => {
      set({ selectedBaseDetailProposalId: proposalId });
    },

    selectPhaseProposal: (proposalId) => {
      set({ selectedPhaseProposalId: proposalId });
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
      set({
        projection: {
          ...projection,
          proposals,
          ...recount(proposals, projection.relationProposals, projection.baseDetailProposals, projection.phaseProposals),
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
          ...recount(projection.proposals, relationProposals, projection.baseDetailProposals, projection.phaseProposals),
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
          applicability === "blocked"
            ? "Codex Type が未解決です"
            : undefined,
        revisionId: crypto.randomUUID(),
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
      set({
        projection: {
          ...projection,
          proposals,
          ...recount(proposals, projection.relationProposals, projection.baseDetailProposals, projection.phaseProposals),
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
        revisionId: crypto.randomUUID(),
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
      set({
        projection: {
          ...projection,
          proposals,
          ...recount(proposals, projection.relationProposals, projection.baseDetailProposals, projection.phaseProposals),
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
          revisionId: crypto.randomUUID(),
          status: "unreviewed",
        },
      );
      set({
        projection: {
          ...projection,
          relationProposals,
          ...recount(projection.proposals, relationProposals, projection.baseDetailProposals, projection.phaseProposals),
        },
      });
    },

    updateBaseDetailProposalStatus: (proposalId, status) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.baseDetailProposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current || current.applicability === "blocked") return;
      if (
        status === "approved" &&
        (current.unbound ||
          !current.proposal.payload.definitionRef.trim() ||
          current.proposal.payload.value.kind === "clear")
      ) {
        return;
      }
      const baseDetailProposals = replaceBaseDetailProposal(
        projection.baseDetailProposals,
        proposalId,
        { ...current, status },
      );
      set({
        projection: {
          ...projection,
          baseDetailProposals,
          ...recount(
            projection.proposals,
            projection.relationProposals,
            baseDetailProposals,
            projection.phaseProposals,
          ),
        },
      });
    },

    updatePhaseProposalStatus: (proposalId, status) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.phaseProposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current || current.applicability === "blocked") return;
      if (
        status === "approved" &&
        current.proposal.payload.binding.kind === "unresolved"
      ) {
        return;
      }
      const phaseProposals = replacePhaseProposal(
        projection.phaseProposals,
        proposalId,
        { ...current, status },
      );
      set({
        projection: {
          ...projection,
          phaseProposals,
          ...recount(
            projection.proposals,
            projection.relationProposals,
            projection.baseDetailProposals,
            phaseProposals,
          ),
        },
      });
    },

    reviseBaseDetailValue: (proposalId, value) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.baseDetailProposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current) return;
      const nextProposal: SetCodexBaseDetailProposal = {
        ...current.proposal,
        payload: {
          ...current.proposal.payload,
          value,
        },
      };
      const safety = buildCodexBaseDetailProposalSafetyFlags({
        temporalEligibility: nextProposal.payload.temporalEligibility,
        existingValue: current.existingValue,
        evidenceMethods: current.evidence.map((item) => item.method),
        bound: !current.unbound && Boolean(nextProposal.payload.definitionRef),
        valueKind: value.kind,
      });
      const baseDetailProposals = replaceBaseDetailProposal(
        projection.baseDetailProposals,
        proposalId,
        {
          ...current,
          proposal: nextProposal,
          revisionId: crypto.randomUUID(),
          status: "unreviewed",
          safety,
          displayTitle: `${current.entityLabel} · ${current.facetKey}`,
        },
      );
      set({
        projection: {
          ...projection,
          baseDetailProposals,
          ...recount(
            projection.proposals,
            projection.relationProposals,
            baseDetailProposals,
            projection.phaseProposals,
          ),
        },
      });
    },

    bindBaseDetailDefinition: (proposalId, definitionRef, options) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.baseDetailProposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current) return;
      void options?.rememberBinding;
      const nextProposal: SetCodexBaseDetailProposal = {
        ...current.proposal,
        payload: {
          ...current.proposal.payload,
          definitionRef,
        },
      };
      const safety = buildCodexBaseDetailProposalSafetyFlags({
        temporalEligibility: nextProposal.payload.temporalEligibility,
        existingValue: current.existingValue,
        evidenceMethods: current.evidence.map((item) => item.method),
        bound: Boolean(definitionRef.trim()),
        valueKind: nextProposal.payload.value.kind,
      });
      const baseDetailProposals = replaceBaseDetailProposal(
        projection.baseDetailProposals,
        proposalId,
        {
          ...current,
          proposal: nextProposal,
          unbound: !definitionRef.trim(),
          applicability: definitionRef.trim()
            ? ("applicable" as const)
            : ("blocked" as const),
          blockedReason: definitionRef.trim()
            ? undefined
            : "Detail 定義が未割当です",
          revisionId: crypto.randomUUID(),
          status: "unreviewed",
          safety,
        },
      );
      set({
        projection: {
          ...projection,
          baseDetailProposals,
          ...recount(
            projection.proposals,
            projection.relationProposals,
            baseDetailProposals,
            projection.phaseProposals,
          ),
        },
      });
    },

    resolvePhaseBinding: (proposalId, resolution) => {
      const projection = get().projection;
      if (!projection) return;
      const current = projection.phaseProposals.find(
        (proposal) => proposal.proposalId === proposalId,
      );
      if (!current || current.proposal.payload.binding.kind !== "unresolved") {
        return;
      }
      const payload = current.proposal.payload;
      const nextProposal: BindCodexPhaseProposal =
        resolution.kind === "create-new"
          ? {
              ...current.proposal,
              target: {
                kind: "new",
                logicalRef: `phase:${payload.narrativeEntityId}:${payload.anchorDocumentRef}`,
              },
              payload: {
                ...payload,
                binding: {
                  kind: "create-new",
                  phase: {
                    label:
                      resolution.label?.trim() ||
                      payload.labelSuggestion?.trim() ||
                      `Phase @ ${payload.anchorDocumentRef}`,
                    anchorDocumentRef: payload.anchorDocumentRef,
                  },
                },
              },
            }
          : {
              ...current.proposal,
              target: {
                kind: "existing",
                phaseRef: resolution.phaseRef,
              },
              payload: {
                ...payload,
                binding: {
                  kind: "bind-existing",
                  phaseRef: resolution.phaseRef,
                  expectedVersion: resolution.expectedVersion,
                },
              },
            };
      const hasClearWrite = nextProposal.payload.detailOverrides.some(
        (item) => item.write.kind === "clear",
      );
      const safety = buildCodexPhaseProposalSafetyFlags({
        summaryOverrideKind: nextProposal.payload.summaryOverride.kind,
        bindingKind: nextProposal.payload.binding.kind,
        hasConflict: false,
        bound: true,
        hasClearWrite,
      });
      const phaseProposals = replacePhaseProposal(
        projection.phaseProposals,
        proposalId,
        {
          ...current,
          proposal: nextProposal,
          applicability: "applicable",
          blockedReason: undefined,
          revisionId: crypto.randomUUID(),
          status: "unreviewed",
          safety,
          existingPhaseCandidates: [],
        },
      );
      set({
        projection: {
          ...projection,
          phaseProposals,
          ...recount(
            projection.proposals,
            projection.relationProposals,
            projection.baseDetailProposals,
            phaseProposals,
          ),
        },
      });
    },

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
      const baseDetailProposals = projection.baseDetailProposals.map(
        (proposal) => {
          if (
            proposal.applicability !== "applicable" ||
            proposal.status !== "unreviewed" ||
            !isSafeForCodexBaseDetailBulkApprove(proposal.safety)
          ) {
            return proposal;
          }
          approved += 1;
          return { ...proposal, status: "approved" as const };
        },
      );
      const phaseProposals = projection.phaseProposals.map((proposal) => {
        if (
          proposal.applicability !== "applicable" ||
          proposal.status !== "unreviewed" ||
          !isSafeForCodexPhaseBulkApprove(proposal.safety)
        ) {
          return proposal;
        }
        approved += 1;
        return { ...proposal, status: "approved" as const };
      });
      set({
        projection: {
          ...projection,
          proposals,
          baseDetailProposals,
          phaseProposals,
          ...recount(
            proposals,
            projection.relationProposals,
            baseDetailProposals,
            phaseProposals,
          ),
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
    selectedBaseDetailProposalId: null,
    selectedPhaseProposalId: null,
  });
}
