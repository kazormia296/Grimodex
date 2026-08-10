import type { CodexEntityHypothesis } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { EntityMentionForm } from "@/features/narrative-extraction/ir/observations/entityIdentity";
import { createCodexRelationProposalFromHypothesis } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { CodexRelationHypothesis } from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";
import type { PhaseBoundaryHypothesis } from "@/features/narrative-extraction/ir/inferences/phaseBoundary";
import type { DetailProjectionHypothesis } from "@/features/narrative-extraction/ir/inferences/detailProjection";
import {
  compilePhaseAndDetailOpsAfterEntities,
  prepareAndApplyCodexCommit,
} from "@/application/narrative-extraction/codexCommitCoordinator";
import { parseAliases } from "./codexMatcher";
import { planBindCodexEntityProposals } from "./extraction/proposalPlanner";
import { planPhaseAndDetailProposals } from "./extraction/phaseProposalPlanner";
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
import type { PhaseDetailWrite } from "./details/semanticBindingTypes";
import {
  buildCodexBaseDetailProposalSafetyFlags,
  buildCodexEntityProposalSafetyFlags,
  buildCodexPhaseProposalSafetyFlags,
  emptyCodexTaskCounts,
  useCodexStructureExtractionStore,
  type CodexBaseDetailReviewProposal,
  type CodexDetailValueDelta,
  type CodexEntityReviewProposal,
  type CodexPhaseReviewProposal,
  type CodexRelationReviewProposal,
  type CodexStructureExtractionReviewProjection,
  type StartCodexStructureExtractionRequest,
} from "./codexStructureExtractionStore";
import { formatProjectedDetailValue } from "./extraction-ui/BaseDetailProposalCard";
import type { ProjectedDetailValue } from "@/features/codex/details/semanticBindingTypes";
import type { ExistingPhaseCatalogRecord } from "./extraction/existingPhaseMatcher";

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

/** Heuristic / test seed for Phase + Base Detail proposals via the planner. */
export interface CodexStructureExtractionPhaseSeed {
  readonly entityId: string;
  readonly anchorDocumentRef: string;
  readonly labelSuggestion?: string | null;
  readonly persistenceReason?: "major-durable" | "multi-moderate-durable";
  readonly facetKey?: string;
  readonly definitionRef?: string;
  readonly nextValue?: ProjectedDetailValue;
  readonly existingValue?: ProjectedDetailValue | null;
  readonly quote?: string;
}

export interface CodexStructureExtractionBaseDetailSeed {
  readonly entityId: string;
  readonly facetKey: string;
  readonly definitionRef?: string;
  readonly value: ProjectedDetailValue;
  readonly temporalEligibility?: "timeless" | "corpus-initial";
  readonly existingValue?: ProjectedDetailValue | null;
  readonly unbound?: boolean;
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
    readonly phaseSeeds?: readonly CodexStructureExtractionPhaseSeed[];
    readonly baseDetailSeeds?: readonly CodexStructureExtractionBaseDetailSeed[];
    readonly existingPhases?: readonly ExistingPhaseCatalogRecord[];
    readonly extractionScope?: "full-corpus" | "partial";
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

  const entityBindingProposalIds = new Map(
    proposals.map((proposal) => [
      proposal.proposal.payload.narrativeEntityId,
      proposal.proposalId,
    ]),
  );

  const phaseSeeds = request.phaseSeeds ?? [];
  const baseDetailSeeds = request.baseDetailSeeds ?? [];
  const boundaries: PhaseBoundaryHypothesis[] = phaseSeeds.map((seed, index) => ({
    boundaryId: `boundary-${index + 1}`,
    observationRefs: [`phase-obs-${index + 1}`],
    payload: {
      entityId: seed.entityId,
      anchorDocumentRef: seed.anchorDocumentRef,
      labelSuggestion: seed.labelSuggestion ?? null,
      transitions: [
        {
          transitionId: `tr-${index + 1}`,
          durability: "major",
          magnitude: "major",
          facetKey: seed.facetKey ?? "role.current",
        },
      ],
      persistence: {
        kind: "proposal",
        reason: seed.persistenceReason ?? "major-durable",
      },
    },
    epistemic: {
      polarity: "affirmed",
      commitment: "story-fact",
      support: "direct",
      narrativeFrame: "primary",
    },
  }));

  const detailProjections: DetailProjectionHypothesis[] = [
    ...phaseSeeds.flatMap((seed, index): DetailProjectionHypothesis[] => {
      if (!seed.definitionRef || !seed.nextValue) return [];
      return [
        {
          projectionId: `phase-proj-${index + 1}`,
          observationRefs: [`phase-obs-${index + 1}`],
          payload: {
            entityId: seed.entityId,
            facetKey: seed.facetKey ?? "role.current",
            destination: "phase",
            scope: { kind: "phase", boundaryId: `boundary-${index + 1}` },
            binding: {
              status: "resolved",
              definitionRef: seed.definitionRef,
              basis: "confirmed-binding",
            },
            write: { kind: "set", value: seed.nextValue },
            value: seed.nextValue,
          },
        },
      ];
    }),
    ...baseDetailSeeds.flatMap((seed, index): DetailProjectionHypothesis[] => {
      if (seed.unbound || !seed.definitionRef) {
        // Still surface unbound rows via a synthetic review proposal below.
        return [];
      }
      return [
        {
          projectionId: `base-proj-${index + 1}`,
          observationRefs: [`base-obs-${index + 1}`],
          payload: {
            entityId: seed.entityId,
            facetKey: seed.facetKey,
            destination: "base",
            scope: {
              kind: "base",
              temporalEligibility: seed.temporalEligibility ?? "timeless",
            },
            binding: {
              status: "resolved",
              definitionRef: seed.definitionRef,
              basis: "confirmed-binding",
            },
            write: { kind: "set", value: seed.value },
            value: seed.value,
          },
        },
      ];
    }),
  ];

  const plannedPhaseDetail = planPhaseAndDetailProposals({
    boundaries,
    detailProjections,
    existingPhases: request.existingPhases ?? [],
    extractionScope: request.extractionScope ?? "partial",
    entityBindingProposalIds,
    createId,
  });

  const phaseProposals: CodexPhaseReviewProposal[] =
    plannedPhaseDetail.phaseProposals.map((item, index) => {
      const seed = phaseSeeds[Math.min(index, Math.max(0, phaseSeeds.length - 1))];
      const binding = item.proposal.payload.binding;
      const hasClearWrite = item.proposal.payload.detailOverrides.some(
        (override) => override.write.kind === "clear",
      );
      const deltas: CodexDetailValueDelta[] =
        item.proposal.payload.detailOverrides.map((override) => {
          const nextDisplay =
            override.write.kind === "set"
              ? formatProjectedDetailValue(override.write.value)
              : override.write.kind === "clear"
                ? "(clear)"
                : "(inherit)";
          return {
            definitionRef: override.definitionRef,
            facetKey: seed?.facetKey,
            previousDisplay: formatProjectedDetailValue(
              seed?.existingValue ?? null,
            ),
            nextDisplay,
            writeKind: override.write.kind,
          };
        });
      const entityLabel =
        entityLabelById.get(item.proposal.payload.narrativeEntityId) ??
        item.proposal.payload.narrativeEntityId;
      return {
        proposalId: item.proposal.proposalId,
        revisionId: crypto.randomUUID(),
        proposalKey: item.boundaryId,
        status: "unreviewed" as const,
        applicability: item.blocked
          ? ("blocked" as const)
          : ("applicable" as const),
        displayTitle:
          item.proposal.payload.labelSuggestion ??
          (binding.kind === "create-new"
            ? binding.phase.label
            : `Phase @ ${item.proposal.payload.anchorDocumentRef}`),
        proposal: item.proposal,
        evidence: [
          {
            anchorId: `phase-anchor-${item.proposal.proposalId}`,
            quote: seed?.quote ?? item.proposal.payload.anchorDocumentRef,
            documentRef: item.proposal.payload.anchorDocumentRef,
            method: "exact" as const,
          },
        ],
        safety: buildCodexPhaseProposalSafetyFlags({
          summaryOverrideKind: item.proposal.payload.summaryOverride.kind,
          bindingKind: binding.kind,
          hasConflict: item.blocked,
          bound: true,
          hasClearWrite,
        }),
        entityLabel,
        persistence: {
          kind: "proposal",
          reason: seed?.persistenceReason ?? "major-durable",
        },
        valueDeltas: deltas,
        existingPhaseCandidates:
          binding.kind === "unresolved"
            ? binding.candidates.map((candidate) => ({
                ref: candidate.ref,
                score: candidate.score,
              }))
            : [],
        blockedReason: item.blockedReason,
        boundaryId: item.boundaryId,
      } satisfies CodexPhaseReviewProposal;
    });

  const plannedBase = plannedPhaseDetail.baseDetailProposals.map(
    (item, index) => {
      const seed =
        baseDetailSeeds.find(
          (candidate) =>
            candidate.entityId === item.proposal.payload.narrativeEntityId &&
            candidate.facetKey === item.proposal.payload.facetKey,
        ) ?? baseDetailSeeds[index];
      const entityLabel =
        entityLabelById.get(item.proposal.payload.narrativeEntityId) ??
        item.proposal.payload.narrativeEntityId;
      const existingValue = seed?.existingValue ?? null;
      return {
        proposalId: item.proposal.proposalId,
        revisionId: crypto.randomUUID(),
        proposalKey: item.projectionId,
        status: "unreviewed" as const,
        applicability: "applicable" as const,
        displayTitle: `${entityLabel} · ${item.proposal.payload.facetKey}`,
        proposal: item.proposal,
        evidence: [
          {
            anchorId: `base-anchor-${item.proposal.proposalId}`,
            quote: seed?.quote ?? item.proposal.payload.facetKey,
            documentRef: `B${String(index + 1).padStart(6, "0")}`,
            method: "exact" as const,
          },
        ],
        safety: buildCodexBaseDetailProposalSafetyFlags({
          temporalEligibility: item.proposal.payload.temporalEligibility,
          existingValue,
          evidenceMethods: ["exact"],
          bound: true,
          valueKind: item.proposal.payload.value.kind,
        }),
        entityLabel,
        facetKey: item.proposal.payload.facetKey,
        existingValue,
      } satisfies CodexBaseDetailReviewProposal;
    },
  );

  const unboundBase: CodexBaseDetailReviewProposal[] = baseDetailSeeds
    .filter((seed) => seed.unbound || !seed.definitionRef)
    .map((seed, index) => {
      const entityLabel =
        entityLabelById.get(seed.entityId) ?? seed.entityId;
      const proposalId = createId();
      return {
        proposalId,
        revisionId: crypto.randomUUID(),
        proposalKey: `unbound-base-${index + 1}`,
        status: "unreviewed",
        applicability: "blocked",
        displayTitle: `${entityLabel} · ${seed.facetKey}`,
        proposal: {
          proposalId,
          kind: "codex.detail.base.set",
          target: {
            kind: "narrative-entity",
            narrativeEntityId: seed.entityId,
          },
          payload: {
            narrativeEntityId: seed.entityId,
            definitionRef: seed.definitionRef ?? "",
            facetKey: seed.facetKey,
            value: seed.value,
            temporalEligibility: seed.temporalEligibility ?? "timeless",
          },
          dependencies: [],
        },
        evidence: [
          {
            anchorId: `unbound-base-anchor-${index + 1}`,
            quote: seed.quote ?? seed.facetKey,
            documentRef: `U${String(index + 1).padStart(6, "0")}`,
            method: "exact",
          },
        ],
        safety: buildCodexBaseDetailProposalSafetyFlags({
          temporalEligibility: seed.temporalEligibility ?? "timeless",
          existingValue: seed.existingValue ?? null,
          evidenceMethods: ["exact"],
          bound: false,
          valueKind: seed.value.kind,
        }),
        entityLabel,
        facetKey: seed.facetKey,
        existingValue: seed.existingValue ?? null,
        unbound: true,
        blockedReason: "Detail 定義が未割当です",
      } satisfies CodexBaseDetailReviewProposal;
    });

  const baseDetailProposals = [...plannedBase, ...unboundBase];
  const counts = recountProjection(
    proposals,
    relationProposals,
    baseDetailProposals,
    phaseProposals,
  );
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
      completed:
        hypotheses.length +
        relationProposals.length +
        baseDetailProposals.length +
        phaseProposals.length,
    },
    proposals,
    relationProposals,
    baseDetailProposals,
    phaseProposals,
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
  /** Map Detail definitionRef → concrete definition id. */
  readonly resolveDefinitionId?: (definitionRef: string) => string;
  /** Encode Base Detail projected value to storage string. */
  readonly encodeBaseValue?: (
    value: ProjectedDetailValue,
  ) => string | null;
  /** Encode Phase Detail write to storage string (undefined = skip). */
  readonly encodePhaseWrite?: (
    definitionId: string,
    write: PhaseDetailWrite,
  ) => string | null | undefined;
  /** Resolve document ref → tree node id for Phase create. */
  readonly resolveAnchorNodeId?: (documentRef: string) => string | null;
  /** Existing phase override rows keyed by phase catalog ref / id. */
  readonly existingPhaseOverrides?: ReadonlyMap<
    string,
    readonly { readonly definitionId: string; readonly value: string | null }[]
  >;
  /** Existing Base Detail OCC versions keyed by `${entryId}:${definitionId}`. */
  readonly existingBaseDetailVersions?: ReadonlyMap<string, number>;
}

function defaultEncodeProjectedValue(value: ProjectedDetailValue): string | null {
  if (value.kind === "clear") return null;
  if (value.kind === "text") return value.text;
  if (value.kind === "enum") return value.optionRef;
  if (value.kind === "entity") return value.entityId;
  return null;
}

function defaultEncodePhaseWrite(
  _definitionId: string,
  write: PhaseDetailWrite,
): string | null | undefined {
  if (write.kind === "inherit") return undefined;
  if (write.kind === "clear") return null;
  return defaultEncodeProjectedValue(write.value);
}

/**
 * Compile approved Bind + Relation + Base Detail + Phase proposals and apply
 * via codexCommitCoordinator (entity bindings first, then Phase/Detail via CommitMap).
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
  const resolveDefinitionId =
    input.resolveDefinitionId ?? ((definitionRef: string) => definitionRef);
  const encodeBaseValue =
    input.encodeBaseValue ?? defaultEncodeProjectedValue;
  const encodePhaseWrite =
    input.encodePhaseWrite ?? defaultEncodePhaseWrite;

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

  const approvedBaseDetails = (projection.baseDetailProposals ?? []).filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "approved" &&
      proposal.revisionId &&
      !proposal.unbound,
  );
  const approvedPhases = (projection.phaseProposals ?? []).filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "approved" &&
      proposal.revisionId &&
      proposal.proposal.payload.binding.kind !== "unresolved",
  );

  const phaseDetailOps = compilePhaseAndDetailOpsAfterEntities({
    commitMap,
    resolveDefinitionId,
    encodeBaseValue,
    encodePhaseWrite,
    resolveAnchorNodeId: input.resolveAnchorNodeId,
    baseDetailProposals: approvedBaseDetails.map((review) => {
      const entryId = commitMap.entityBindings[
        review.proposal.payload.narrativeEntityId
      ]?.codexEntryId;
      const definitionId = resolveDefinitionId(
        review.proposal.payload.definitionRef,
      );
      const versionKey =
        entryId !== undefined ? `${entryId}:${definitionId}` : undefined;
      return {
        proposal: review.proposal,
        proposalId: review.proposalId,
        revisionId: review.revisionId!,
        existingVersion:
          versionKey !== undefined
            ? input.existingBaseDetailVersions?.get(versionKey)
            : undefined,
      };
    }),
    phaseProposals: approvedPhases.map((review) => {
      const binding = review.proposal.payload.binding;
      const phaseKey =
        binding.kind === "bind-existing" ? binding.phaseRef : undefined;
      return {
        proposal: review.proposal,
        proposalId: review.proposalId,
        revisionId: review.revisionId!,
        existingOverrides:
          phaseKey !== undefined
            ? input.existingPhaseOverrides?.get(phaseKey)
            : undefined,
      };
    }),
  });
  operations.push(...phaseDetailOps);

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
