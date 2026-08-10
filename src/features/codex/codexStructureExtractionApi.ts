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
import {
  cancelRun,
  createRun,
  getRun,
} from "@/application/narrative-extraction/runRepository";
import {
  narrativeExtractionClaimTask,
  narrativeExtractionFailTask,
  narrativeExtractionFinishTask,
  type ClaimTaskResult,
} from "@/application/narrative-extraction/nativeApi";
import type { NarrativeProposalStatus } from "@/features/narrative-extraction/runtime/types";
import { parseAliases } from "./codexMatcher";
import { BUILTIN_CODEX_TYPES } from "./api";
import {
  runEntityCandidatePrepass,
  type EntityCandidateOccurrence,
} from "./extraction/entityCandidatePrepass";
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
  isSafeForCodexEntityBulkApprove,
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

const CODEX_STRUCTURE_LEASE_OWNER = "codex-structure-extract";
const CODEX_STRUCTURE_TASK_KIND = "codex.entity.resolve";

/**
 * Rebuild Relation dependency edges from ProposalSet summaryJson.
 * Dependencies are stored here (not in revision payloads) so approve revisions
 * cannot erase the gate graph.
 */
export function relationDependenciesFromSummaryJson(
  summaryJson: unknown,
): ReadonlyMap<
  string,
  readonly { readonly kind: string; readonly proposalId: string }[]
> {
  if (!summaryJson || typeof summaryJson !== "object") {
    return new Map();
  }
  const raw = (summaryJson as Record<string, unknown>).relationDependencies;
  if (!raw || typeof raw !== "object") {
    return new Map();
  }
  const out = new Map<
    string,
    readonly { readonly kind: string; readonly proposalId: string }[]
  >();
  for (const [proposalId, value] of Object.entries(
    raw as Record<string, unknown>,
  )) {
    if (!Array.isArray(value)) continue;
    const deps = value.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      if (
        typeof record.proposalId !== "string" ||
        typeof record.kind !== "string"
      ) {
        return [];
      }
      return [
        {
          kind: record.kind,
          proposalId: record.proposalId,
        },
      ];
    });
    out.set(proposalId, deps);
  }
  return out;
}

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
  /** Aggregated Evidence quotes when the same Relation appears in multiple anchors. */
  readonly evidenceQuotes?: readonly {
    readonly quote: string;
    readonly documentRef: string;
    readonly anchorId: string;
  }[];
}

const MAX_DERIVED_RELATION_SEEDS = 20;
const MAX_RELATION_QUOTE_CHARS = 240;
const RELATION_ASSERTING_COPULA =
  /^(?:だ|である|だった|です|でした|であります)/u;

type CoMentionEntity = {
  readonly surface: string;
  readonly narrativeEntityId: string;
  readonly proposalId: string;
};

/**
 * Resolve directed subject/object from conservative Japanese patterns.
 * Requires a relation-asserting copula after the label so action/case particles
 * like 「父を殺した」「師匠に会った」 do not become Relations.
 */
function resolveDirectedEndpoints(
  quote: string,
  left: CoMentionEntity,
  right: CoMentionEntity,
  label: string,
): { subject: CoMentionEntity; object: CoMentionEntity } | null {
  const tryOrder = (
    subject: CoMentionEntity,
    object: CoMentionEntity,
  ): boolean => {
    // 「ベルカはライカの父だ」
    const forward = `${subject.surface}は${object.surface}の${label}`;
    const forwardIndex = quote.indexOf(forward);
    if (forwardIndex >= 0) {
      const after = quote.slice(forwardIndex + forward.length);
      return RELATION_ASSERTING_COPULA.test(after);
    }
    // 「ライカの父はベルカだ」 / 「ライカの父はベルカ」
    const inverted = `${object.surface}の${label}は${subject.surface}`;
    const invertedIndex = quote.indexOf(inverted);
    if (invertedIndex >= 0) {
      const after = quote.slice(invertedIndex + inverted.length);
      return (
        after.length === 0 ||
        RELATION_ASSERTING_COPULA.test(after) ||
        /^[。．!！?？]/u.test(after)
      );
    }
    return false;
  };

  if (tryOrder(left, right)) return { subject: left, object: right };
  if (tryOrder(right, left)) return { subject: right, object: left };
  return null;
}

/**
 * Relation co-mention window from a prepass occurrence.
 * Entity Evidence quotes stay surface-only; Relation seeding needs the
 * surrounding sentence/context so subject+object+label can co-occur.
 */
export function buildRelationCoMentionQuote(occurrence: {
  readonly quote: string;
  readonly context: { readonly prefix: string; readonly suffix: string };
}): string {
  return `${occurrence.context.prefix}${occurrence.quote}${occurrence.context.suffix}`;
}

/** Build Relation-only Evidence rows from Native prepass occurrences. */
export function buildRelationEvidenceFromOccurrences(
  occurrences: readonly EntityCandidateOccurrence[],
): CodexReviewEvidenceQuote[] {
  return occurrences.map((occurrence) => ({
    anchorId: occurrence.evidence.id,
    quote: buildRelationCoMentionQuote(occurrence),
    documentRef: occurrence.documentRef,
    method: "exact-with-context" as const,
    blocked: false,
  }));
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
  const seedByKey = new Map<string, CodexStructureExtractionRelationSeed>();

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

          // Semantic Relation key — Evidence anchors aggregate into one proposal.
          const key =
            vocab.directionality === "symmetric"
              ? [
                  subject.narrativeEntityId < object.narrativeEntityId
                    ? subject.narrativeEntityId
                    : object.narrativeEntityId,
                  subject.narrativeEntityId < object.narrativeEntityId
                    ? object.narrativeEntityId
                    : subject.narrativeEntityId,
                  vocab.relationType,
                  label,
                ].join("\0")
              : [
                  subject.narrativeEntityId,
                  object.narrativeEntityId,
                  vocab.relationType,
                  label,
                  normalizeRelationLabel(vocab.inverseLabel ?? ""),
                ].join("\0");

          const evidenceRow = {
            quote,
            documentRef: window.documentRef,
            anchorId: window.anchorId,
          };
          const existing = seedByKey.get(key);
          if (existing) {
            const evidenceQuotes = [
              ...(existing.evidenceQuotes ?? []),
              evidenceRow,
            ];
            const next: CodexStructureExtractionRelationSeed = {
              ...existing,
              evidenceQuotes,
              quote: existing.quote ?? quote,
              documentRef: existing.documentRef ?? window.documentRef,
              anchorId: existing.anchorId ?? window.anchorId,
            };
            seedByKey.set(key, next);
            const index = seeds.findIndex((seed) => seed === existing);
            if (index >= 0) seeds[index] = next;
            continue;
          }

          const seed: CodexStructureExtractionRelationSeed = {
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
            evidenceQuotes: [evidenceRow],
          };
          seedByKey.set(key, seed);
          seeds.push(seed);
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
  // Globally unique across runs (DB PRIMARY KEY); stable within one ProposalSet.
  const createId = (): string => crypto.randomUUID();

  const catalogs = buildCodexStructureCatalogs({
    existingEntries: request.existingEntries,
    typeCatalog: request.typeCatalog,
  });
  const existingCatalog = catalogs.existingCatalog;
  const typeCatalog = catalogs.typeCatalog;
  const catalogSnapshot = catalogs.snapshot;

  let seeds = request.heuristicSeeds ? [...request.heuristicSeeds] : null;
  const evidenceBySurface = new Map<string, CodexReviewEvidenceQuote[]>();
  /** Relation seeding windows (context), separate from Entity surface Evidence. */
  const relationEvidenceBySurface = new Map<
    string,
    CodexReviewEvidenceQuote[]
  >();
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
        relationEvidenceBySurface.set(
          seed.surface,
          buildRelationEvidenceFromOccurrences(seed.occurrences),
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
        // Unit-test / injected seeds already carry Relation windows as quotes.
        relationEvidenceBySurface.set(seed.surface, [...seed.evidence]);
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
        evidence:
          relationEvidenceBySurface.get(proposal.displayTitle) ??
          proposal.evidence,
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
          evidence: (() => {
            const quotes =
              seed.evidenceQuotes && seed.evidenceQuotes.length > 0
                ? seed.evidenceQuotes
                : seed.quote && seed.documentRef
                  ? [
                      {
                        quote: seed.quote,
                        documentRef: seed.documentRef,
                        anchorId:
                          seed.anchorId ?? `rel-anchor-${created.proposalId}`,
                      },
                    ]
                  : [];
            if (quotes.length === 0) {
              return [
                {
                  anchorId: `rel-anchor-${created.proposalId}`,
                  quote: "",
                  documentRef: "",
                  method: "unknown" as const,
                  blocked: true,
                },
              ];
            }
            return quotes.map((row) => ({
              anchorId: row.anchorId,
              quote: row.quote,
              documentRef: row.documentRef,
              method: "exact" as const,
              blocked: false,
            }));
          })(),
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
  let runStatus: CodexStructureExtractionReviewProjection["status"] =
    "completed";
  let taskCounts = {
    ...emptyCodexTaskCounts(),
    completed: hypotheses.length + relationProposals.length,
  };

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
        taskChain: [CODEX_STRUCTURE_TASK_KIND],
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
          taskKind: CODEX_STRUCTURE_TASK_KIND,
          priority: 1,
          inputJson: { stage: 1 },
        },
      ],
    });
    runId = createdRun.runId;

    let claim: ClaimTaskResult | null = null;
    try {
      claim = await narrativeExtractionClaimTask({
        runId,
        projectId: request.projectId,
        leaseOwner: CODEX_STRUCTURE_LEASE_OWNER,
        taskKinds: [CODEX_STRUCTURE_TASK_KIND],
      });
      if (!claim.claimed || !claim.task) {
        throw new Error(`Failed to claim task ${CODEX_STRUCTURE_TASK_KIND}`);
      }

      const saved = await saveProposalSet({
        runId,
        projectId: request.projectId,
        setKind: CODEX_STRUCTURE_PROPOSAL_SET_KIND,
        summaryJson: {
          proposalCount: proposals.length + relationProposals.length,
          catalog: catalogSnapshot,
          // Immutable across append_revision: Relation dependency graph keyed by
          // stable proposal IDs (also sent as ProposalSeed.proposalId below).
          relationDependencies: Object.fromEntries(
            relationProposals.map((proposal) => [
              proposal.proposalId,
              proposal.proposal.dependencies,
            ]),
          ),
        },
        proposals: [
          ...proposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            proposalKey: proposal.proposalKey,
            kind: CODEX_ENTITY_BIND_PROPOSAL_KIND,
            payloadJson: proposal.proposal.payload,
          })),
          ...relationProposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            proposalKey: proposal.proposalKey,
            kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
            // Domain payload only — dependencies live in summaryJson.
            payloadJson: proposal.proposal.payload,
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
        if (seed.proposalId !== proposal.proposalId) {
          throw new Error(
            `Native remapped entity proposalId for ${proposal.proposalKey}; expected stable client id`,
          );
        }
        return {
          ...proposal,
          proposalId: seed.proposalId,
          revisionId: seed.revisionId,
          status: seed.status ?? proposal.status,
        };
      });
      finalRelations = relationProposals.map((proposal) => {
        const seed = byKey.get(proposal.proposalKey);
        if (!seed?.revisionId) {
          throw new Error(
            `Missing Native revision for relation key ${proposal.proposalKey}`,
          );
        }
        if (seed.proposalId !== proposal.proposalId) {
          throw new Error(
            `Native remapped relation proposalId for ${proposal.proposalKey}; expected stable client id`,
          );
        }
        return {
          ...proposal,
          proposalId: seed.proposalId,
          revisionId: seed.revisionId,
          status: seed.status ?? proposal.status,
        };
      });

      await narrativeExtractionFinishTask({
        runId,
        projectId: request.projectId,
        taskId: claim.task.taskId,
        attemptId: claim.task.attemptId,
        leaseOwner: CODEX_STRUCTURE_LEASE_OWNER,
        outputJson: {
          proposalSetId: saved.proposalSetId,
          entityProposalCount: finalProposals.length,
          relationProposalCount: finalRelations.length,
        },
      });

      const nativeRun = await getRun(runId, request.projectId);
      runStatus = nativeRun.run.status;
      taskCounts = {
        ...emptyCodexTaskCounts(),
        ...nativeRun.taskCounts,
      };
    } catch (error) {
      if (claim?.task) {
        try {
          await narrativeExtractionFailTask({
            runId,
            projectId: request.projectId,
            taskId: claim.task.taskId,
            attemptId: claim.task.attemptId,
            leaseOwner: CODEX_STRUCTURE_LEASE_OWNER,
            errorMessage:
              error instanceof Error ? error.message : String(error),
            requeue: false,
          });
        } catch {
          // Prefer original failure; fail-task is best-effort.
        }
      } else {
        try {
          await cancelRun(runId, request.projectId);
        } catch {
          // Prefer original failure; cancel is best-effort.
        }
      }
      throw error;
    }
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
    status: runStatus,
    coverage: {
      mode: "complete",
      documentCount: coverageDocumentCount,
      windowCount: coverageWindowCount,
      completedWindows: coverageWindowCount,
      gaps: [],
    },
    taskCounts,
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

export interface BulkApproveSafeCodexStructureResult {
  readonly approved: number;
  readonly failed: readonly {
    readonly proposalId: string;
    readonly error: string;
  }[];
}

/**
 * Persist-aware bulk approve for safe Entity proposals.
 * Loops decideCodexStructureProposal (revision + decision + Relation re-eval).
 * Continues after individual failures and reports them.
 */
export async function bulkApproveSafeCodexStructureProposals(): Promise<BulkApproveSafeCodexStructureResult> {
  const projection = useCodexStructureExtractionStore.getState().projection;
  if (!projection) {
    throw new Error("No active codex structure extraction review");
  }
  const targets = projection.proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "unreviewed" &&
      isSafeForCodexEntityBulkApprove(proposal.safety),
  );
  let approved = 0;
  const failed: { proposalId: string; error: string }[] = [];
  for (const proposal of targets) {
    try {
      await decideCodexStructureProposal({
        proposalId: proposal.proposalId,
        status: "approved",
        kind: "entity",
      });
      approved += 1;
    } catch (error) {
      failed.push({
        proposalId: proposal.proposalId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { approved, failed };
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
