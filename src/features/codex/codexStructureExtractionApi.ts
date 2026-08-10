import type { CodexEntityHypothesis } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { EntityMentionForm } from "@/features/narrative-extraction/ir/observations/entityIdentity";
import {
  createCodexRelationProposalFromHypothesis,
  CODEX_RELATION_CREATE_PROPOSAL_KIND,
} from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { CodexRelationHypothesis } from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";
import { CODEX_ENTITY_BIND_PROPOSAL_KIND } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import { buildNarrativeSourceView } from "@/features/narrative-extraction/source/sourceView";
import type {
  CanonicalRange,
  NarrativeCorpusSnapshot,
  NarrativeSourceView,
  Sha256Digest,
} from "@/features/narrative-extraction/source/types";
import {
  planExtractionWindows,
  type WindowPlan,
} from "@/features/chronicle/extraction/windowPlanner";
import { prepareAndApplyCodexCommit } from "@/application/narrative-extraction/codexCommitCoordinator";
import { buildProjectNarrativeSnapshot } from "@/application/narrative-extraction/projectSnapshotAdapter";
import {
  appendDecision,
  appendRevision,
  saveProposalSet,
} from "@/application/narrative-extraction/proposalRepository";
import { createRun } from "@/application/narrative-extraction/runRepository";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";
import { parseAliases } from "./codexMatcher";
import { BUILTIN_CODEX_TYPES } from "./api";
import { runEntityCandidatePrepass } from "./extraction/entityCandidatePrepass";
import {
  matchExistingEntity,
  type ExistingEntityCatalogRecord,
} from "./extraction/existingEntityMatcher";
import {
  resolveEntityType,
  type KnowledgeTypeCatalogRecord,
} from "./extraction/entityResolver";
import { planBindCodexEntityProposals } from "./extraction/proposalPlanner";
import {
  compileBindExistingCodexEntityOperation,
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
  relationEndpointsReady,
  useCodexStructureExtractionStore,
  type CodexCompiledDomainOperation,
  type CodexEntityReviewProposal,
  type CodexRelationReviewProposal,
  type CodexReviewEvidenceQuote,
  type CodexStructureCatalogSnapshot,
  type CodexStructureExtractionReviewProjection,
  type StartCodexStructureExtractionRequest,
} from "./codexStructureExtractionStore";
import {
  BUILTIN_CODEX_RELATION_VOCABULARY,
  normalizeRelationLabel,
} from "./extraction/relationVocabulary";

export type { StartCodexStructureExtractionRequest };

export const CODEX_STRUCTURE_EXTRACT_SURFACE_PATH =
  "codex/structure-extract" as const;
export const CODEX_STRUCTURE_PROPOSAL_SET_KIND =
  "codex.structure.extract.review@1" as const;

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
  /** Unit-test only: real evidence quotes (never invent exact). */
  readonly evidence?: readonly CodexReviewEvidenceQuote[];
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
  readonly documentRef?: string;
  readonly anchorId?: string;
}

const MAX_DERIVED_RELATION_SEEDS = 20;
const MAX_RELATION_QUOTE_CHARS = 240;

type CoMentionEntity = {
  readonly surface: string;
  readonly narrativeEntityId: string;
  readonly proposalId: string;
};

/**
 * Resolve directed subject/object from conservative Japanese patterns.
 * Returns null when orientation cannot be determined from the quote.
 */
function resolveDirectedEndpoints(
  quote: string,
  left: CoMentionEntity,
  right: CoMentionEntity,
  label: string,
): { subject: CoMentionEntity; object: CoMentionEntity } | null {
  const patterns: Array<(a: CoMentionEntity, b: CoMentionEntity) => boolean> = [
    // 「ベルカはライカの父」→ subject=ベルカ, object=ライカ
    (subject, object) =>
      quote.includes(`${subject.surface}は${object.surface}の${label}`),
    // 「ライカの父はベルカ」→ subject=ベルカ, object=ライカ
    (subject, object) =>
      quote.includes(`${object.surface}の${label}は${subject.surface}`),
  ];
  for (const matches of patterns) {
    if (matches(left, right)) return { subject: left, object: right };
    if (matches(right, left)) return { subject: right, object: left };
  }
  return null;
}

/** Minimal span that still contains every required surface (capped). */
function quoteSpanCovering(
  quote: string,
  parts: readonly string[],
): string | null {
  let start = quote.length;
  let end = 0;
  for (const part of parts) {
    const index = quote.indexOf(part);
    if (index < 0) return null;
    start = Math.min(start, index);
    end = Math.max(end, index + part.length);
  }
  if (end <= start) return null;
  const span = quote.slice(start, end);
  if (span.length <= MAX_RELATION_QUOTE_CHARS) return span;
  // Prefer a window that still contains all parts when possible.
  for (let windowStart = start; windowStart < end; windowStart += 1) {
    const windowEnd = windowStart + MAX_RELATION_QUOTE_CHARS;
    if (windowEnd > quote.length) break;
    const window = quote.slice(windowStart, windowEnd);
    if (parts.every((part) => window.includes(part))) return window;
  }
  return null;
}

/**
 * Conservative co-mention relation seeds: both entity surfaces and a builtin
 * vocabulary label must appear in the *same* Evidence quote. Document-bag joins
 * across separate anchors are intentionally rejected.
 */
export function deriveRelationSeedsFromCoMentions(input: {
  readonly proposals: readonly {
    readonly proposalId: string;
    readonly displayTitle: string;
    readonly narrativeEntityId: string;
    readonly evidence: readonly CodexReviewEvidenceQuote[];
  }[];
  readonly vocabulary?: typeof BUILTIN_CODEX_RELATION_VOCABULARY;
  readonly maxSeeds?: number;
}): CodexStructureExtractionRelationSeed[] {
  const vocabulary = input.vocabulary ?? BUILTIN_CODEX_RELATION_VOCABULARY;
  const maxSeeds = input.maxSeeds ?? MAX_DERIVED_RELATION_SEEDS;

  type AnchorWindow = {
    readonly documentRef: string;
    readonly anchorId: string;
    readonly quote: string;
    readonly entities: CoMentionEntity[];
  };

  const windowsByKey = new Map<string, AnchorWindow>();

  for (const proposal of input.proposals) {
    for (const row of proposal.evidence) {
      if (!row.documentRef || row.blocked || !row.quote) continue;
      if (!row.quote.includes(proposal.displayTitle)) continue;
      // Same document quote text is one span even when prepass assigned distinct
      // anchor ids to each entity mention inside that quote.
      const key = `${row.documentRef}\0${row.quote}`;
      let window = windowsByKey.get(key);
      if (!window) {
        window = {
          documentRef: row.documentRef,
          anchorId: row.anchorId,
          quote: row.quote,
          entities: [],
        };
        windowsByKey.set(key, window);
      }
      if (
        !window.entities.some(
          (entity) => entity.narrativeEntityId === proposal.narrativeEntityId,
        )
      ) {
        window.entities.push({
          surface: proposal.displayTitle,
          narrativeEntityId: proposal.narrativeEntityId,
          proposalId: proposal.proposalId,
        });
      }
    }
  }

  const seeds: CodexStructureExtractionRelationSeed[] = [];
  const seen = new Set<string>();

  for (const window of windowsByKey.values()) {
    if (window.entities.length < 2) continue;
    for (let i = 0; i < window.entities.length; i += 1) {
      for (let j = i + 1; j < window.entities.length; j += 1) {
        const left = window.entities[i]!;
        const right = window.entities[j]!;
        if (
          !window.quote.includes(left.surface) ||
          !window.quote.includes(right.surface)
        ) {
          continue;
        }
        for (const vocab of vocabulary) {
          const label = normalizeRelationLabel(vocab.forwardLabel);
          if (!label || !window.quote.includes(label)) continue;

          let subject = left;
          let object = right;
          if (vocab.directionality === "directed") {
            const resolved = resolveDirectedEndpoints(
              window.quote,
              left,
              right,
              label,
            );
            if (!resolved) continue;
            subject = resolved.subject;
            object = resolved.object;
          } else if (
            left.narrativeEntityId.localeCompare(right.narrativeEntityId) > 0
          ) {
            subject = right;
            object = left;
          }

          const quote = quoteSpanCovering(window.quote, [
            subject.surface,
            object.surface,
            label,
          ]);
          if (!quote) continue;

          const key = `${subject.narrativeEntityId}\0${object.narrativeEntityId}\0${vocab.relationType}\0${label}\0${window.anchorId}`;
          if (seen.has(key)) continue;
          // Symmetric undirected pairs still collapse A↔B; directed opposites stay distinct.
          if (vocab.directionality === "symmetric") {
            const keyRev = `${object.narrativeEntityId}\0${subject.narrativeEntityId}\0${vocab.relationType}\0${label}\0${window.anchorId}`;
            if (seen.has(keyRev)) continue;
            seen.add(keyRev);
          }
          seen.add(key);
          seeds.push({
            subjectEntityId: subject.narrativeEntityId,
            objectEntityId: object.narrativeEntityId,
            predicate: vocab.relationType,
            forwardLabel: vocab.forwardLabel,
            inverseLabel: vocab.inverseLabel,
            directionality: vocab.directionality,
            validity: "current",
            subjectLabel: subject.surface,
            objectLabel: object.surface,
            dependencyProposalIds: [subject.proposalId, object.proposalId],
            quote,
            documentRef: window.documentRef,
            anchorId: window.anchorId,
          });
          if (seeds.length >= maxSeeds) return seeds;
        }
      }
    }
  }
  return seeds;
}

function digestStableString(value: string): Sha256Digest {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return `sha256:${hash.toString(16).padStart(64, "0")}` as Sha256Digest;
}

function mergeRanges(ranges: readonly CanonicalRange[]): CanonicalRange {
  return {
    start: Math.min(...ranges.map((range) => range.start)),
    end: Math.max(...ranges.map((range) => range.end)),
  };
}

async function buildSourceViewsForPlan(
  snapshot: NarrativeCorpusSnapshot,
  plan: WindowPlan,
): Promise<readonly NarrativeSourceView[]> {
  const documentByRef = new Map(
    snapshot.documents.map((document) => [document.ref, document] as const),
  );
  const views: NarrativeSourceView[] = [];
  for (const window of plan.windows) {
    const document = documentByRef.get(window.documentRef);
    if (!document) continue;
    views.push(
      await buildNarrativeSourceView({
        ref: window.sourceRef,
        document,
        documentRange: mergeRanges([
          ...window.ownedRanges,
          ...window.contextRanges,
        ]),
      }),
    );
  }
  return views;
}

function coarseClassForSlug(
  slug: string,
): CodexEntityHypothesis["payload"]["coarseClass"] {
  switch (slug) {
    case "character":
      return "person";
    case "location":
      return "place";
    case "item":
      return "item";
    case "lore":
      return "concept";
    default:
      return "unknown";
  }
}

/** Build opaque K#### / T#### catalogs from local Codex entries + builtin types. */
export function buildCodexStructureCatalogs(args: {
  readonly entries?: readonly {
    readonly id: string;
    readonly name: string | null;
    readonly aliases: string | null;
    readonly type: string;
    readonly version: number;
  }[];
  readonly typeCatalog?: readonly KnowledgeTypeCatalogRecord[];
  readonly existingEntries?: readonly ExistingEntityCatalogRecord[];
}): {
  readonly existingCatalog: ExistingEntityCatalogRecord[];
  readonly typeCatalog: KnowledgeTypeCatalogRecord[];
  readonly snapshot: CodexStructureCatalogSnapshot;
} {
  const typeCatalog =
    args.typeCatalog && args.typeCatalog.length > 0
      ? [...args.typeCatalog]
      : BUILTIN_CODEX_TYPES.map((slug, index) => ({
          ref: `T${String(index + 1).padStart(4, "0")}`,
          sourceKey: slug,
          slug,
          label: slug,
          coarseClassHints: [coarseClassForSlug(slug)],
          expectedVersion: 1,
        }));
  const typeRefBySlug = new Map(
    typeCatalog.map((type) => [type.slug, type.ref] as const),
  );
  const existingCatalog =
    args.existingEntries && args.existingEntries.length > 0
      ? [...args.existingEntries]
      : (args.entries ?? []).map((entry, index) => ({
          ref: `K${String(index + 1).padStart(4, "0")}`,
          sourceKey: entry.id,
          name: entry.name ?? "",
          aliases: parseAliases(entry.aliases),
          typeRef:
            typeRefBySlug.get(entry.type) ?? typeCatalog[0]?.ref ?? "T0001",
          expectedVersion: entry.version,
        }));
  return {
    existingCatalog,
    typeCatalog,
    snapshot: {
      entities: existingCatalog.map((entry) => ({
        ref: entry.ref,
        sourceKey: entry.sourceKey,
        name: entry.name,
        typeRef: entry.typeRef,
        expectedVersion: entry.expectedVersion,
        aliases: Array.isArray(entry.aliases)
          ? [...entry.aliases]
          : typeof entry.aliases === "string"
            ? parseAliases(entry.aliases)
            : [],
      })),
      types: typeCatalog.map((type) => ({
        ref: type.ref,
        sourceKey: type.sourceKey,
        slug: type.slug,
        label: type.label,
      })),
    },
  };
}

export function resolveCodexTypeSlug(
  typeRef: string,
  catalog: CodexStructureCatalogSnapshot | null | undefined,
): string {
  return catalog?.types.find((type) => type.ref === typeRef)?.slug ?? typeRef;
}

export function resolveCodexEntitySourceKey(
  entityRef: string,
  catalog: CodexStructureCatalogSnapshot | null | undefined,
): string {
  return (
    catalog?.entities.find((entity) => entity.ref === entityRef)?.sourceKey ??
    entityRef
  );
}

export function catalogEntityDisplayName(
  entityRef: string,
  catalog: CodexStructureCatalogSnapshot | null | undefined,
): string {
  const hit = catalog?.entities.find((entity) => entity.ref === entityRef);
  return hit?.name?.trim() ? hit.name : entityRef;
}

/**
 * Build a minimal Entity Hypothesis for heuristic / unit-test paths.
 * Product Dialog must not invent scene-id dummy seeds.
 */
export function buildHeuristicEntityHypothesis(
  seed: CodexStructureExtractionHeuristicSeed,
  index: number,
  createId: () => string = () => crypto.randomUUID(),
): CodexEntityHypothesis {
  const entityId = `ne-${index + 1}`;
  const form = seed.form ?? "proper-name";
  const existingResolution = seed.existingCandidates?.length
    ? {
        status: "ambiguous" as const,
        candidates: seed.existingCandidates.map((candidate) => ({
          ref: candidate.ref,
          score: candidate.score,
          methods: candidate.methods,
        })),
      }
    : seed.existingRef
      ? {
          status: "resolved" as const,
          ref: seed.existingRef,
          method: "exact-name" as const,
        }
      : { status: "none" as const };

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
    /** Test seam only — product path always persists Native Run/ProposalSet. */
    readonly skipNativePersist?: boolean;
  },
): Promise<CodexStructureExtractionReviewProjection> {
  const createId = (() => {
    let n = 0;
    return () => {
      n += 1;
      return `codex-bind-${n}`;
    };
  })();

  const catalogs = buildCodexStructureCatalogs({
    existingEntries: request.existingEntries,
    typeCatalog: request.typeCatalog,
  });
  const existingCatalog = catalogs.existingCatalog;
  const typeCatalog = catalogs.typeCatalog;
  const catalogSnapshot = catalogs.snapshot;

  let seeds = request.heuristicSeeds ? [...request.heuristicSeeds] : null;
  const evidenceBySurface = new Map<string, CodexReviewEvidenceQuote[]>();
  let coverageDocumentCount = request.sceneIds.length;
  let coverageWindowCount = Math.max(1, request.sceneIds.length);
  let snapshotDigest: string | null = null;

  if (!seeds) {
    const snapshotResult = await buildProjectNarrativeSnapshot({
      projectId: request.projectId,
      folderId: request.folderId,
      language: request.language ?? "ja",
      sceneIds: request.sceneIds,
      authority: request.authority,
    });
    if (!snapshotResult.ok) {
      throw new Error(
        `Snapshot build failed: ${snapshotResult.diagnostics
          .map((diagnostic) => diagnostic.code)
          .join(", ")}`,
      );
    }
    const snapshot = snapshotResult.snapshot;
    snapshotDigest = snapshot.digest;
    const windowPlan = planExtractionWindows(snapshot);
    const sourceViews = await buildSourceViewsForPlan(snapshot, windowPlan);
    coverageDocumentCount = snapshot.documents.length;
    coverageWindowCount = Math.max(1, windowPlan.windows.length);

    const prepass = await runEntityCandidatePrepass({
      snapshot,
      sourceViews,
      minimumOccurrenceCount: 1,
      createEvidenceAnchorId: createId,
    });
    seeds = [];
    if (prepass.status === "complete") {
      for (const seed of prepass.seeds) {
        const existingResolution = matchExistingEntity(
          { surfaces: [seed.surface] },
          existingCatalog,
        );
        const typeResolution = resolveEntityType({
          existingResolution,
          existingCatalog,
          typeCatalog,
          coarseClass: seed.features.appearsAsProperName ? "person" : "unknown",
        });
        evidenceBySurface.set(
          seed.surface,
          seed.occurrences.map((occurrence) => ({
            anchorId: occurrence.evidence.id,
            quote: occurrence.evidence.quote,
            documentRef: occurrence.evidence.documentRef,
            method: occurrence.evidence.method,
            blocked: false,
          })),
        );
        seeds.push({
          surface: seed.surface,
          form: seed.features.appearsAsProperName ? "proper-name" : "alias",
          coarseClass: seed.features.appearsAsProperName ? "person" : "unknown",
          typeRef:
            typeResolution.status === "resolved"
              ? typeResolution.typeRef
              : undefined,
          existingRef:
            existingResolution.status === "resolved"
              ? existingResolution.ref
              : undefined,
          existingCandidates:
            existingResolution.status === "ambiguous"
              ? existingResolution.candidates
              : undefined,
          evidence: evidenceBySurface.get(seed.surface),
        });
      }
    }
  } else {
    for (const seed of seeds) {
      if (seed.evidence?.length) {
        evidenceBySurface.set(seed.surface, [...seed.evidence]);
      }
    }
  }

  // Optional AI path reserved for later wiring (runEntityResolutionTask).
  if (request.useAi) {
    // Keep stub: callers may set useAi without requiring live models in tests.
  }

  const hypotheses = (seeds ?? []).map((seed, index) =>
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
      revisionId: null,
      proposalKey: item.hypothesisId,
      status: "unreviewed" as const,
      applicability: item.blocked
        ? ("blocked" as const)
        : ("applicable" as const),
      displayTitle: item.proposal.payload.canonicalName,
      proposal: item.proposal,
      evidence: (() => {
        const quotes = evidenceBySurface.get(
          item.proposal.payload.canonicalName,
        );
        if (quotes?.length) return quotes;
        return [
          {
            anchorId: `missing-${item.proposal.proposalId}`,
            quote: "",
            documentRef: "",
            method: "unknown" as const,
            blocked: true,
          },
        ];
      })(),
      safety: buildCodexEntityProposalSafetyFlags({
        bindingKind: binding.kind,
        typeStatus: item.proposal.payload.typeResolution.status,
        evidenceMethods: (() => {
          const quotes = evidenceBySurface.get(
            item.proposal.payload.canonicalName,
          );
          return quotes?.length
            ? quotes.map((row) => row.method)
            : (["unknown"] as const);
        })(),
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

  const relationSeeds =
    request.relationSeeds ??
    deriveRelationSeedsFromCoMentions({
      proposals: proposals.map((proposal) => ({
        proposalId: proposal.proposalId,
        displayTitle: proposal.displayTitle,
        narrativeEntityId: proposal.proposal.payload.narrativeEntityId,
        evidence: proposal.evidence,
      })),
    });

  const relationProposals: CodexRelationReviewProposal[] =
    relationSeeds.flatMap((seed, index) => {
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
      const blockedDeps = !relationEndpointsReady(
        {
          proposalId: created.proposalId,
          revisionId: null,
          proposalKey: hypothesis.hypothesisId,
          status: "unreviewed",
          applicability: "applicable",
          displayTitle: "",
          proposal: created,
          evidence: [],
          subjectLabel,
          objectLabel,
        },
        proposals,
      );
      return [
        {
          proposalId: created.proposalId,
          revisionId: null,
          proposalKey: hypothesis.hypothesisId,
          status: "unreviewed" as const,
          applicability: blockedDeps
            ? ("blocked" as const)
            : ("applicable" as const),
          displayTitle: `${subjectLabel} → ${seed.forwardLabel} → ${objectLabel}`,
          proposal: created,
          evidence: [
            {
              anchorId: seed.anchorId ?? `rel-anchor-${created.proposalId}`,
              quote: seed.quote ?? "",
              documentRef: seed.documentRef ?? "",
              method:
                seed.quote && seed.documentRef
                  ? ("exact" as const)
                  : ("unknown" as const),
              blocked: !(seed.quote && seed.documentRef),
            },
          ],
          subjectLabel,
          objectLabel,
          blockedReason: blockedDeps
            ? "先に両端の Entity proposal を承認してください"
            : undefined,
          hypothesisId: hypothesis.hypothesisId,
        } satisfies CodexRelationReviewProposal,
      ];
    });

  let runId = createId();
  let proposalSetId: string | null = `proposal-set-${runId}`;
  let finalProposals: CodexEntityReviewProposal[];
  let finalRelations: CodexRelationReviewProposal[];

  if (!(request as { skipNativePersist?: boolean }).skipNativePersist) {
    const createdRun = await createRun({
      projectId: request.projectId,
      surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
      scopeJson: {
        folderId: request.folderId,
        sceneIds: [...request.sceneIds],
      },
      specJson: {
        domain: "codex",
        version: 1,
        taskChain: ["codex.entity.resolve"],
      },
      specDigest: digestStableString("codex.structure.extract.v1"),
      snapshotDigest,
      coverageJson: {
        mode: "complete",
        documentCount: coverageDocumentCount,
        windowCount: coverageWindowCount,
      },
      catalogDigest: digestStableString(JSON.stringify(catalogSnapshot)),
      tasks: [
        {
          taskKind: "codex.entity.resolve",
          priority: 1,
          inputJson: { stage: 1 },
        },
      ],
    });
    runId = createdRun.runId;
    const saved = await saveProposalSet({
      runId,
      projectId: request.projectId,
      setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
      summaryJson: {
        proposalCount: proposals.length + relationProposals.length,
        catalog: catalogSnapshot,
      },
      proposals: [
        ...proposals.map((proposal) => ({
          proposalKey: proposal.proposalKey,
          kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
          payloadJson: proposal.proposal.payload,
        })),
        ...relationProposals.map((proposal) => ({
          proposalKey: proposal.proposalKey,
          kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
          // Persist dependencies alongside the domain payload so cold-start
          // restore can rebuild Relation gates after Native ID remapping.
          payloadJson: {
            ...proposal.proposal.payload,
            dependencies: proposal.proposal.dependencies,
          },
        })),
      ],
    });
    proposalSetId = saved.proposalSetId;
    const byKey = new Map(
      saved.proposals.map((seed) => [seed.proposalKey, seed] as const),
    );
    finalProposals = proposals.map((proposal) => {
      const seed = byKey.get(proposal.proposalKey);
      if (!seed?.revisionId) {
        throw new Error(
          `Missing Native revision for entity key ${proposal.proposalKey}`,
        );
      }
      return {
        ...proposal,
        proposalId: seed.proposalId,
        revisionId: seed.revisionId,
        status: seed.status ?? proposal.status,
      };
    });
    const nativeIdByLocalProposalId = new Map(
      proposals.map((proposal, index) => {
        const native = finalProposals[index];
        return [proposal.proposalId, native!.proposalId] as const;
      }),
    );
    finalRelations = relationProposals.map((proposal) => {
      const seed = byKey.get(proposal.proposalKey);
      if (!seed?.revisionId) {
        throw new Error(
          `Missing Native revision for relation key ${proposal.proposalKey}`,
        );
      }
      const remappedDependencies = proposal.proposal.dependencies.map(
        (dependency) => ({
          ...dependency,
          proposalId:
            nativeIdByLocalProposalId.get(dependency.proposalId) ??
            dependency.proposalId,
        }),
      );
      return {
        ...proposal,
        proposalId: seed.proposalId,
        revisionId: seed.revisionId,
        status: seed.status ?? proposal.status,
        proposal: {
          ...proposal.proposal,
          dependencies: remappedDependencies,
        },
      };
    });
  } else {
    finalProposals = proposals.map((proposal) => ({
      ...proposal,
      revisionId: proposal.revisionId ?? `test-rev-${proposal.proposalKey}`,
    }));
    finalRelations = relationProposals.map((proposal) => ({
      ...proposal,
      revisionId: proposal.revisionId ?? `test-rev-${proposal.proposalKey}`,
    }));
  }

  lastRunId = runId;
  const counts = recountProjection(finalProposals, finalRelations);
  const projection: CodexStructureExtractionReviewProjection = {
    runId,
    projectId: request.projectId,
    workspacePath: request.workspacePath,
    openRevision: request.openRevision,
    proposalSetId,
    status: "completed",
    coverage: {
      mode: "complete",
      documentCount: coverageDocumentCount,
      windowCount: coverageWindowCount,
      completedWindows: coverageWindowCount,
      gaps: [],
    },
    taskCounts: {
      ...emptyCodexTaskCounts(),
      completed: hypotheses.length + finalRelations.length,
    },
    proposals: finalProposals,
    relationProposals: finalRelations,
    catalog: catalogSnapshot,
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
 * Prefer operation payloads locked at approve time (`compiledOperation`) so Native
 * revision digests match Apply operations.
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
    const revisionId = review.revisionId!;
    const operation =
      (review.compiledOperation as CodexDomainOperationV1 | null | undefined) ??
      compileEntityOperationForReview(review, projection.catalog, input);
    if (!operation) {
      throw new Error(
        `Approved entity proposal ${review.proposalId} has no compilable operation`,
      );
    }

    const narrativeEntityId = review.proposal.payload.narrativeEntityId;
    const entryId =
      "entryId" in operation.payload &&
      typeof operation.payload.entryId === "string"
        ? operation.payload.entryId
        : null;
    if (operation.kind === "codex.entry.create" && entryId) {
      commitMap = registerCreatedBinding(commitMap, narrativeEntityId, entryId);
    } else if (
      (operation.kind === "codex.entry.patch" ||
        operation.kind === "codex.entity.bind-existing") &&
      entryId
    ) {
      existingBindings.push({
        narrativeEntityId,
        codexEntryId: entryId,
        source: "existing",
      });
      commitMap = registerExistingBinding(
        commitMap,
        narrativeEntityId,
        entryId,
      );
    }

    operations.push({
      operation,
      proposalId: review.proposalId,
      revisionId,
    });
  }

  const approvedRelations = projection.relationProposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "approved" &&
      proposal.revisionId,
  );

  for (const review of approvedRelations) {
    const operation =
      (review.compiledOperation as CodexDomainOperationV1 | null | undefined) ??
      compileCreateCodexRelationOperation(review.proposal, commitMap, {
        projectId: input.projectId,
      });
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

function compileEntityOperationForReview(
  review: CodexEntityReviewProposal,
  catalog: CodexStructureCatalogSnapshot | null | undefined,
  input?: ApplyCodexStructureExtractionInput,
): CodexDomainOperationV1 | null {
  const binding = review.proposal.payload.binding;
  const narrativeEntityId = review.proposal.payload.narrativeEntityId;
  const resolveTypeSlug =
    input?.resolveTypeSlug ??
    ((typeRef: string) => resolveCodexTypeSlug(typeRef, catalog));

  if (binding.kind === "create-new") {
    const typeRef =
      review.proposal.payload.typeResolution.status === "resolved"
        ? review.proposal.payload.typeResolution.typeRef
        : "character";
    return compileCreateCodexEntryOperation({
      narrativeEntityId,
      typeSlug: resolveTypeSlug(typeRef),
      name: binding.entry.name,
      aliases: binding.entry.aliases,
      summary: binding.entry.summary,
    });
  }

  if (binding.kind === "bind-existing") {
    const entryId = resolveCodexEntitySourceKey(binding.entityRef, catalog);
    const catalogEntity = catalog?.entities.find(
      (entity) =>
        entity.sourceKey === entryId || entity.ref === binding.entityRef,
    );
    const live = input?.entries.find((entry) => entry.id === entryId);
    const baseVersion =
      live?.version ?? catalogEntity?.expectedVersion ?? undefined;
    if (baseVersion == null) {
      throw new Error(
        `Missing baseVersion for bind-existing entry ${binding.entityRef}`,
      );
    }
    const existingAliases =
      live != null
        ? parseAliases(live.aliases)
        : [...(catalogEntity?.aliases ?? [])];
    const patch = compilePatchCodexEntryOperation({
      narrativeEntityId,
      entryId,
      baseVersion,
      aliasesToAdd: binding.enrichment.aliasesToAdd,
      existingAliases,
      summary: binding.enrichment.summary,
    });
    if (patch) return patch;
    return compileBindExistingCodexEntityOperation({
      narrativeEntityId,
      entryId,
      baseVersion,
    });
  }

  return null;
}

export async function decideCodexStructureProposal(args: {
  readonly proposalId: string;
  readonly status: NarrativeProposalStatus;
  readonly kind?: "entity" | "relation";
}): Promise<void> {
  const projection = useCodexStructureExtractionStore.getState().projection;
  if (!projection)
    throw new Error("No active codex structure extraction review");
  const kind = args.kind ?? "entity";
  const proposal =
    kind === "entity"
      ? projection.proposals.find((item) => item.proposalId === args.proposalId)
      : projection.relationProposals.find(
          (item) => item.proposalId === args.proposalId,
        );
  if (!proposal?.revisionId) {
    throw new Error(`Proposal ${args.proposalId} missing revisionId`);
  }
  if (args.status === "unreviewed") {
    if (kind === "entity") {
      useCodexStructureExtractionStore
        .getState()
        .updateProposalStatus(args.proposalId, args.status);
    } else {
      useCodexStructureExtractionStore
        .getState()
        .updateRelationProposalStatus(args.proposalId, args.status);
    }
    return;
  }

  let revisionId = proposal.revisionId;
  let compiledOperation: CodexCompiledDomainOperation | null = null;

  if (args.status === "approved") {
    // Lock Domain Operation into Native revision before decision so Apply digests match.
    if (kind === "entity") {
      const entity = proposal as CodexEntityReviewProposal;
      const operation = compileEntityOperationForReview(
        entity,
        projection.catalog,
      );
      if (!operation) {
        throw new Error(
          `Cannot approve blocked/unresolved entity proposal ${args.proposalId}`,
        );
      }
      compiledOperation = {
        kind: operation.kind,
        payload: operation.payload as unknown as Readonly<
          Record<string, unknown>
        >,
      };
    } else {
      const relation = proposal as CodexRelationReviewProposal;
      if (!relationEndpointsReady(relation, projection.proposals)) {
        throw new Error(
          `Cannot approve Relation ${args.proposalId}: 先に両端の Entity proposal を承認してください`,
        );
      }
      // Relation compile needs CommitMap of approved entity bindings; use provisional map
      // from already-approved entity compiled ops + this run's create targets.
      let commitMap = emptyCommitMap();
      for (const entity of projection.proposals) {
        const op = entity.compiledOperation;
        if (!op) continue;
        const narrativeEntityId = entity.proposal.payload.narrativeEntityId;
        const entryId =
          typeof op.payload.entryId === "string" ? op.payload.entryId : null;
        if (!entryId) continue;
        if (op.kind === "codex.entry.create") {
          commitMap = registerCreatedBinding(
            commitMap,
            narrativeEntityId,
            entryId,
          );
        } else {
          commitMap = registerExistingBinding(
            commitMap,
            narrativeEntityId,
            entryId,
          );
        }
      }
      const operation = compileCreateCodexRelationOperation(
        relation.proposal,
        commitMap,
        { projectId: projection.projectId },
      );
      compiledOperation = {
        kind: operation.kind,
        payload: operation.payload as unknown as Readonly<
          Record<string, unknown>
        >,
      };
    }

    const revised = await appendRevision({
      runId: projection.runId,
      projectId: projection.projectId,
      proposalId: args.proposalId,
      expectedCurrentRevisionId: revisionId,
      payloadJson: compiledOperation.payload,
      createdBy: "codex-structure-extract-dialog",
    });
    revisionId = revised.revisionId;
  }

  const decision =
    args.status === "approved"
      ? "approved"
      : args.status === "rejected"
        ? "rejected"
        : args.status === "held"
          ? "held"
          : "deferred";
  await appendDecision({
    runId: projection.runId,
    projectId: projection.projectId,
    proposalId: args.proposalId,
    revisionId,
    decision,
    createdBy: "codex-structure-extract-dialog",
  });

  const latest = useCodexStructureExtractionStore.getState().projection;
  if (!latest) return;
  if (kind === "entity") {
    useCodexStructureExtractionStore.getState().setProjection({
      ...latest,
      proposals: latest.proposals.map((item) =>
        item.proposalId === args.proposalId
          ? {
              ...item,
              status: args.status,
              revisionId,
              compiledOperation:
                args.status === "approved" ? compiledOperation : null,
            }
          : item,
      ),
      ...recountProjection(
        latest.proposals.map((item) =>
          item.proposalId === args.proposalId
            ? { ...item, status: args.status }
            : item,
        ),
        latest.relationProposals,
      ),
    });
  } else {
    useCodexStructureExtractionStore.getState().setProjection({
      ...latest,
      relationProposals: latest.relationProposals.map((item) =>
        item.proposalId === args.proposalId
          ? {
              ...item,
              status: args.status,
              revisionId,
              compiledOperation:
                args.status === "approved" ? compiledOperation : null,
            }
          : item,
      ),
      ...recountProjection(
        latest.proposals,
        latest.relationProposals.map((item) =>
          item.proposalId === args.proposalId
            ? { ...item, status: args.status }
            : item,
        ),
      ),
    });
  }
}

export async function reviseCodexStructureProposal(args: {
  readonly proposalId: string;
  readonly patch: {
    canonicalName?: string;
    summary?: string | null;
    aliases?: readonly string[];
    typeRef?: string;
  };
}): Promise<void> {
  const store = useCodexStructureExtractionStore.getState();
  const projection = store.projection;
  if (!projection)
    throw new Error("No active codex structure extraction review");
  const current = projection.proposals.find(
    (item) => item.proposalId === args.proposalId,
  );
  if (!current?.revisionId) {
    throw new Error(`Proposal ${args.proposalId} missing revisionId`);
  }
  store.reviseProposalFields(args.proposalId, args.patch);
  const updated = useCodexStructureExtractionStore
    .getState()
    .projection?.proposals.find((item) => item.proposalId === args.proposalId);
  if (!updated) {
    throw new Error(`Proposal ${args.proposalId} missing after revise`);
  }
  const result = await appendRevision({
    runId: projection.runId,
    projectId: projection.projectId,
    proposalId: args.proposalId,
    expectedCurrentRevisionId: current.revisionId,
    payloadJson: updated.proposal.payload as unknown as Readonly<
      Record<string, unknown>
    >,
    createdBy: "codex-structure-extract-dialog",
  });
  const latest = useCodexStructureExtractionStore.getState().projection;
  if (!latest) return;
  useCodexStructureExtractionStore.getState().setProjection({
    ...latest,
    proposals: latest.proposals.map((proposal) =>
      proposal.proposalId === args.proposalId
        ? { ...proposal, revisionId: result.revisionId, status: "unreviewed" }
        : proposal,
    ),
  });
}
