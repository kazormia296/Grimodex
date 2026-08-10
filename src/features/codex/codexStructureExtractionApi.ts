import type { CodexEntityHypothesis } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { EntityMentionForm } from "@/features/narrative-extraction/ir/observations/entityIdentity";
import { createCodexRelationProposalFromHypothesis } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { CodexRelationHypothesis } from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";
import {
  prepareAndApplyCodexCommit,
} from "@/application/narrative-extraction/codexCommitCoordinator";
import { parseAliases } from "./codexMatcher";
import { planBindCodexEntityProposals } from "./extraction/proposalPlanner";
import {
  compileCreateCodexEntryOperation,
  compileCreateCodexRelationOperation,
  compilePatchCodexEntryOperation,
  emptyCommitMap,
  registerCreatedBinding,
  registerExistingBinding,
  type CodexDomainOperationV1,
  type CommitMap,
} from "./extraction/compiler";
import {
  buildCodexEntityProposalSafetyFlags,
  emptyCodexTaskCounts,
  useCodexStructureExtractionStore,
  type CodexEntityReviewProposal,
  type CodexRelationReviewProposal,
  type CodexStructureExtractionReviewProjection,
  type StartCodexStructureExtractionRequest,
} from "./codexStructureExtractionStore";

export type { StartCodexStructureExtractionRequest };

export interface CodexStructureExtractionHeuristicSeed {
  readonly surface: string;
  readonly form?: EntityMentionForm;
  readonly coarseClass?: CodexEntityHypothesis["payload"]["coarseClass"];
  readonly typeRef?: string;
  readonly existingRef?: string;
  readonly existingCandidates?: readonly {
    readonly ref: string;
    readonly score: number;
    readonly methods: readonly (
      | "exact-name"
      | "exact-alias"
      | "explicit-identity"
      | "honorific-strip"
      | "prefix"
      | "substring"
      | "embedding"
    )[];
  }[];
  readonly aliases?: readonly {
    readonly surface: string;
    readonly status:
      | "explicit"
      | "coreference-only"
      | "user-confirmation-required";
  }[];
  readonly summarySuggestion?: string | null;
}

export interface CodexStructureExtractionRelationSeed {
  readonly subjectEntityId: string;
  readonly objectEntityId: string;
  readonly predicate: string;
  readonly forwardLabel: string;
  readonly inverseLabel?: string | null;
  readonly directionality?: "directed" | "symmetric";
  readonly validity?: "timeless" | "current";
  readonly subjectLabel?: string;
  readonly objectLabel?: string;
  readonly dependencyProposalIds?: readonly string[];
  readonly quote?: string;
}

/**
 * Build a minimal Entity Hypothesis for heuristic / unit-test paths.
 * AI resolution (runEntityResolutionTask) is optional via useAi.
 */
export function buildHeuristicEntityHypothesis(
  seed: CodexStructureExtractionHeuristicSeed,
  index: number,
  createId: () => string = () => crypto.randomUUID(),
): CodexEntityHypothesis {
  const entityId = `ne-${index + 1}`;
  const form = seed.form ?? "proper-name";
  const existingResolution = seed.existingCandidates?.length
    ? ({
        status: "ambiguous" as const,
        candidates: seed.existingCandidates.map((candidate) => ({
          ref: candidate.ref,
          score: candidate.score,
          methods: candidate.methods,
        })),
      })
    : seed.existingRef
      ? ({
          status: "resolved" as const,
          ref: seed.existingRef,
          method: "exact-name" as const,
        })
      : ({ status: "none" as const });

  return {
    hypothesisId: createId(),
    clusterRef: `cluster-${index + 1}`,
    payload: {
      entityId,
      canonicalName: seed.surface,
      mentionSurfaces: [
        {
          surface: seed.surface,
          form,
          observationIds: [`obs-${index + 1}`],
        },
      ],
      aliases: (seed.aliases ?? []).map((alias) => ({
        surface: alias.surface,
        status: alias.status,
        identityObservationIds: [],
      })),
      coarseClass: seed.coarseClass ?? "person",
      typeResolution: seed.typeRef
        ? { status: "resolved", typeRef: seed.typeRef }
        : { status: "unresolved" },
      existingResolution,
      summarySuggestion: seed.summarySuggestion ?? null,
    },
  };
}

function recountProjection(
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

let lastRunId: string | null = null;

/**
 * Thin coordinator for structure extraction review:
 * builds heuristic Entity (+ optional Relation) proposals → store projection.
 * AI path is optional (`useAi`); commit is via applyCodexStructureExtractionReview.
 */
export async function startCodexStructureExtraction(
  request: StartCodexStructureExtractionRequest & {
    readonly heuristicSeeds?: readonly CodexStructureExtractionHeuristicSeed[];
    readonly relationSeeds?: readonly CodexStructureExtractionRelationSeed[];
  },
): Promise<CodexStructureExtractionReviewProjection> {
  const createId = (() => {
    let n = 0;
    return () => {
      n += 1;
      return `codex-bind-${n}`;
    };
  })();

  // Optional AI path reserved for later wiring (runEntityResolutionTask).
  if (request.useAi) {
    // Keep stub: callers may set useAi without requiring live models in tests.
  }

  const seeds =
    request.heuristicSeeds ??
    request.sceneIds.slice(0, 3).map((sceneId, index) => ({
      surface: `候補${index + 1}`,
      form: "proper-name" as const,
      typeRef: request.typeCatalog?.[0]?.ref,
      summarySuggestion: `Scene ${sceneId} から抽出`,
    }));

  const hypotheses = seeds.map((seed, index) =>
    buildHeuristicEntityHypothesis(seed, index, createId),
  );

  const planned = planBindCodexEntityProposals({
    hypotheses,
    createId,
  });

  const proposals: CodexEntityReviewProposal[] = planned.map((item, index) => {
    const binding = item.proposal.payload.binding;
    const seed = seeds[Math.min(index, seeds.length - 1)];
    const hasProperName = (seed?.form ?? "proper-name") === "proper-name";
    const aliasesAllExplicit = item.proposal.payload.aliases.every(
      (alias) => alias.status === "explicit",
    );
    return {
      proposalId: item.proposal.proposalId,
      revisionId: crypto.randomUUID(),
      proposalKey: item.hypothesisId,
      status: "unreviewed" as const,
      applicability: item.blocked
        ? ("blocked" as const)
        : ("applicable" as const),
      displayTitle: item.proposal.payload.canonicalName,
      proposal: item.proposal,
      evidence: [
        {
          anchorId: `anchor-${item.proposal.proposalId}`,
          quote: item.proposal.payload.canonicalName,
          documentRef: `D${String(index + 1).padStart(6, "0")}`,
          method: "exact" as const,
        },
      ],
      safety: buildCodexEntityProposalSafetyFlags({
        bindingKind: binding.kind,
        typeStatus: item.proposal.payload.typeResolution.status,
        evidenceMethods: ["exact"],
        hasExistingCandidates: binding.kind !== "create-new",
        hasProperNameMention: hasProperName,
        aliasesAllExplicit,
        hasRelationDeps: item.proposal.dependencies.length > 0,
      }),
      blockedReason: item.blockedReason,
      hypothesisId: item.hypothesisId,
    };
  });

  const entityLabelById = new Map(
    proposals.map((proposal) => [
      proposal.proposal.payload.narrativeEntityId,
      proposal.displayTitle,
    ]),
  );

  const relationProposals: CodexRelationReviewProposal[] = (
    request.relationSeeds ?? []
  ).flatMap((seed, index) => {
    const hypothesis: CodexRelationHypothesis = {
      hypothesisId: createId(),
      observationRefs: [`rel-obs-${index + 1}`],
      subjectResolved: true,
      objectResolved: true,
      payload: {
        subjectEntityId: seed.subjectEntityId,
        objectEntityId: seed.objectEntityId,
        predicate: seed.predicate,
        family: "social",
        validity: seed.validity ?? "current",
        directionality: seed.directionality ?? "directed",
        forwardLabelSuggestion: seed.forwardLabel,
        inverseLabelSuggestion: seed.inverseLabel ?? null,
      },
      epistemic: {
        polarity: "affirmed",
        commitment: "story-fact",
        support: "direct",
        narrativeFrame: "primary",
      },
    };
    const created = createCodexRelationProposalFromHypothesis({
      hypothesis,
      gate: { kind: "proposal", validity: seed.validity ?? "current" },
      logicalRef: `rel-${index + 1}`,
      relation: {
        relationType: seed.predicate,
        directionality: seed.directionality ?? "directed",
        forwardLabel: seed.forwardLabel,
        inverseLabel: seed.inverseLabel ?? null,
      },
      dependencyProposalIds: seed.dependencyProposalIds ?? [],
      createId,
    });
    if (!created) return [];
    const subjectLabel =
      seed.subjectLabel ??
      entityLabelById.get(seed.subjectEntityId) ??
      seed.subjectEntityId;
    const objectLabel =
      seed.objectLabel ??
      entityLabelById.get(seed.objectEntityId) ??
      seed.objectEntityId;
    const blockedDeps = (seed.dependencyProposalIds ?? []).some((depId) => {
      const entity = proposals.find((item) => item.proposalId === depId);
      return (
        !entity ||
        entity.applicability === "blocked" ||
        entity.proposal.payload.binding.kind === "unresolved"
      );
    });
    return [
      {
        proposalId: created.proposalId,
        revisionId: crypto.randomUUID(),
        proposalKey: hypothesis.hypothesisId,
        status: "unreviewed" as const,
        applicability: blockedDeps
          ? ("blocked" as const)
          : ("applicable" as const),
        displayTitle: `${subjectLabel} → ${seed.forwardLabel} → ${objectLabel}`,
        proposal: created,
        evidence: [
          {
            anchorId: `rel-anchor-${created.proposalId}`,
            quote: seed.quote ?? seed.forwardLabel,
            documentRef: `R${String(index + 1).padStart(6, "0")}`,
            method: "exact" as const,
          },
        ],
        subjectLabel,
        objectLabel,
        blockedReason: blockedDeps
          ? "両端 Entity Binding が未解決です"
          : undefined,
        hypothesisId: hypothesis.hypothesisId,
      } satisfies CodexRelationReviewProposal,
    ];
  });

  const runId = createId();
  lastRunId = runId;
  const counts = recountProjection(proposals, relationProposals);
  const projection: CodexStructureExtractionReviewProjection = {
    runId,
    projectId: request.projectId,
    workspacePath: request.workspacePath,
    openRevision: request.openRevision,
    proposalSetId: `proposal-set-${runId}`,
    status: "completed",
    coverage: {
      mode: "complete",
      documentCount: request.sceneIds.length,
      windowCount: Math.max(1, request.sceneIds.length),
      completedWindows: Math.max(1, request.sceneIds.length),
      gaps: [],
    },
    taskCounts: {
      ...emptyCodexTaskCounts(),
      completed: hypotheses.length + relationProposals.length,
    },
    proposals,
    relationProposals,
    ...counts,
  };

  useCodexStructureExtractionStore.getState().setProjection(projection);
  return projection;
}

export function getCodexStructureReview(): CodexStructureExtractionReviewProjection | null {
  return useCodexStructureExtractionStore.getState().projection;
}

export function getLastCodexStructureRunId(): string | null {
  return lastRunId;
}

export interface ApplyCodexStructureExtractionInput {
  readonly projectId: string;
  readonly entries: readonly {
    readonly id: string;
    readonly version: number;
    readonly aliases: string | null;
    readonly type: string;
  }[];
  /** Map KnowledgeTypeRef → type slug used by codex.entry.create. */
  readonly resolveTypeSlug?: (typeRef: string) => string;
}

/**
 * Compile approved Bind + Relation proposals and apply via codexCommitCoordinator.
 */
export async function applyCodexStructureExtractionReview(
  input: ApplyCodexStructureExtractionInput,
): Promise<number> {
  const projection = useCodexStructureExtractionStore.getState().projection;
  if (!projection || projection.projectId !== input.projectId) {
    throw new Error("No active codex structure extraction review for project");
  }
  if (!projection.proposalSetId) {
    throw new Error("Missing proposalSetId for codex commit");
  }

  const entryById = new Map(input.entries.map((entry) => [entry.id, entry]));
  const resolveTypeSlug =
    input.resolveTypeSlug ?? ((typeRef: string) => typeRef);

  const operations: {
    operation: CodexDomainOperationV1;
    proposalId: string;
    revisionId: string;
  }[] = [];
  let commitMap: CommitMap = emptyCommitMap();
  const existingBindings: {
    narrativeEntityId: string;
    codexEntryId: string;
    source: "existing";
  }[] = [];

  const approvedEntities = projection.proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "approved" &&
      proposal.revisionId,
  );

  for (const review of approvedEntities) {
    const binding = review.proposal.payload.binding;
    const narrativeEntityId = review.proposal.payload.narrativeEntityId;
    const revisionId = review.revisionId!;
    let operation: CodexDomainOperationV1 | null = null;

    if (binding.kind === "create-new") {
      const typeRef =
        review.proposal.payload.typeResolution.status === "resolved"
          ? review.proposal.payload.typeResolution.typeRef
          : "character";
      operation = compileCreateCodexEntryOperation({
        narrativeEntityId,
        typeSlug: resolveTypeSlug(typeRef),
        name: binding.entry.name,
        aliases: binding.entry.aliases,
        summary: binding.entry.summary,
      });
      commitMap = registerCreatedBinding(
        commitMap,
        narrativeEntityId,
        operation.payload.entryId,
      );
    } else if (binding.kind === "bind-existing") {
      const entry = entryById.get(binding.entityRef);
      if (!entry) {
        throw new Error(
          `Existing Codex entry ${binding.entityRef} not found for bind`,
        );
      }
      existingBindings.push({
        narrativeEntityId,
        codexEntryId: entry.id,
        source: "existing",
      });
      commitMap = registerExistingBinding(
        commitMap,
        narrativeEntityId,
        entry.id,
      );
      operation = compilePatchCodexEntryOperation({
        narrativeEntityId,
        entryId: entry.id,
        baseVersion: entry.version,
        aliasesToAdd: binding.enrichment.aliasesToAdd,
        existingAliases: parseAliases(entry.aliases),
        summary: binding.enrichment.summary,
      });
    }

    if (operation) {
      operations.push({
        operation,
        proposalId: review.proposalId,
        revisionId,
      });
    }
  }

  const approvedRelations = projection.relationProposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "approved" &&
      proposal.revisionId,
  );

  for (const review of approvedRelations) {
    const operation = compileCreateCodexRelationOperation(
      review.proposal,
      commitMap,
      { projectId: input.projectId },
    );
    operations.push({
      operation,
      proposalId: review.proposalId,
      revisionId: review.revisionId!,
    });
  }

  if (operations.length === 0) return 0;

  await prepareAndApplyCodexCommit({
    projectId: input.projectId,
    runId: projection.runId,
    proposalSetId: projection.proposalSetId,
    requestId: crypto.randomUUID(),
    sessionId: crypto.randomUUID(),
    surface: "codex/CodexStructureExtractDialog",
    operations,
    existingBindings,
  });

  return operations.length;
}
