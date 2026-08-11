import type { CodexEntityHypothesis } from "@/features/narrative-extraction/ir/inferences/codexEntityHypothesis";
import type { EntityMentionForm } from "@/features/narrative-extraction/ir/observations/entityIdentity";
import {
  createCodexRelationProposalFromHypothesis,
  CODEX_RELATION_CREATE_PROPOSAL_KIND,
  type CreateCodexRelationProposal,
  type CreateCodexRelationProposalPayload,
} from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { CodexRelationHypothesis } from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";
import {
  CODEX_ENTITY_BIND_PROPOSAL_KIND,
  createNewBindCodexEntityProposal,
  bindExistingCodexEntityProposal,
  unresolvedBindCodexEntityProposal,
  type BindCodexEntityPayload,
  type BindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
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
import {
  buildInlineJsonArtifact,
  hydrateInlineArtifactsFromNative,
  loadInlineJsonArtifact,
  rememberInlineJsonArtifact,
} from "@/application/narrative-extraction/artifactRepository";
import { prepareAndApplyCodexCommit } from "@/application/narrative-extraction/codexCommitCoordinator";
import { buildProjectNarrativeSnapshot } from "@/application/narrative-extraction/projectSnapshotAdapter";
import {
  appendDecision,
  appendRevision,
  reviseAndDecide,
  saveProposalSet,
} from "@/application/narrative-extraction/proposalRepository";
import {
  cancelRun,
  createRun,
  getRun,
  listResumableRuns,
} from "@/application/narrative-extraction/runRepository";
import {
  narrativeExtractionClaimTask,
  narrativeExtractionFailTask,
  narrativeExtractionFinishTask,
  type ClaimTaskResult,
  type ReviewBundleProposal,
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
  useCodexStructureExtractionStore,
  type CodexCompiledDomainOperation,
  type CodexEntityReviewProposal,
  type CodexRelationReviewProposal,
  type CodexReviewEvidenceQuote,
  type CodexStructureCatalogSnapshot,
  type CodexStructureExtractionCoverage,
  type CodexStructureExtractionReviewProjection,
  type StartCodexStructureExtractionRequest,
} from "./codexStructureExtractionStore";
import {
  BUILTIN_CODEX_RELATION_VOCABULARY,
  buildCodexRelationSemanticKey,
  normalizeRelationLabel,
} from "./extraction/relationVocabulary";
import {
  buildCodexReviewRevisionEnvelope,
  parseCodexReviewRevisionEnvelope,
} from "./extraction/reviewRevisionEnvelope";
import {
  evaluateCodexRelationApplicability,
  rematchCodexRelationProposals,
  relationEndpointsReady,
} from "./extraction/relationApplicability";
import {
  matchExistingCodexRelation,
  type ExistingRelationCatalogRecord,
} from "./extraction/existingRelationMatcher";

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
/** Durable Evidence (+ labels) for cold-start restore (finish_task artifact). */
export const CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND =
  "codex.structure.review-projection@1" as const;

interface CodexStructureReviewArtifactPayload {
  readonly proposalSetId?: string;
  readonly evidenceByProposalId?: Readonly<
    Record<string, readonly CodexReviewEvidenceQuote[]>
  >;
  readonly relationLabelsByProposalId?: Readonly<
    Record<
      string,
      { readonly subjectLabel: string; readonly objectLabel: string }
    >
  >;
}

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
  /^(?:だ|である|であり|だった|です|でした|であります)/u;

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
 * Resolve symmetric pair from conservative Japanese asserting patterns.
 * Rejects case-particle / object uses: 「敵を倒した」「家族を守った」「友人を助けた」.
 */
function resolveSymmetricEndpoints(
  quote: string,
  left: CoMentionEntity,
  right: CoMentionEntity,
  label: string,
): { subject: CoMentionEntity; object: CoMentionEntity } | null {
  const tryPair = (
    a: CoMentionEntity,
    b: CoMentionEntity,
  ): { subject: CoMentionEntity; object: CoMentionEntity } | null => {
    // 「AとBは友人だ」 / 「AとBは友人である」 / 「AとBは恋人だった」
    const both = `${a.surface}と${b.surface}は${label}`;
    const bothIndex = quote.indexOf(both);
    if (bothIndex >= 0) {
      const after = quote.slice(bothIndex + both.length);
      if (
        RELATION_ASSERTING_COPULA.test(after) ||
        after.length === 0 ||
        /^[。．!！?？]/u.test(after)
      ) {
        return a.narrativeEntityId <= b.narrativeEntityId
          ? { subject: a, object: b }
          : { subject: b, object: a };
      }
    }
    // 「AはBの友人だ」
    const of = `${a.surface}は${b.surface}の${label}`;
    const ofIndex = quote.indexOf(of);
    if (ofIndex >= 0) {
      const after = quote.slice(ofIndex + of.length);
      if (
        RELATION_ASSERTING_COPULA.test(after) ||
        after.length === 0 ||
        /^[。．!！?？]/u.test(after)
      ) {
        return a.narrativeEntityId <= b.narrativeEntityId
          ? { subject: a, object: b }
          : { subject: b, object: a };
      }
    }
    return null;
  };

  return tryPair(left, right) ?? tryPair(right, left);
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

/** Document-global UTF-16 range covering prefix + surface + suffix. */
export function buildRelationCoMentionRange(occurrence: {
  readonly canonicalRange: CanonicalRange;
  readonly context: { readonly prefix: string; readonly suffix: string };
}): CanonicalRange {
  return {
    start: Math.max(
      0,
      occurrence.canonicalRange.start - occurrence.context.prefix.length,
    ),
    end: occurrence.canonicalRange.end + occurrence.context.suffix.length,
  };
}

/** Build Relation-only Evidence rows from Native prepass occurrences. */
export function buildRelationEvidenceFromOccurrences(
  occurrences: readonly EntityCandidateOccurrence[],
  documentTexts?: ReadonlyMap<string, string>,
): CodexReviewEvidenceQuote[] {
  return occurrences.map((occurrence) => {
    const range = buildRelationCoMentionRange(occurrence);
    const documentText = documentTexts?.get(occurrence.documentRef);
    const quote =
      documentText &&
      range.end <= documentText.length &&
      range.start < range.end
        ? documentText.slice(range.start, range.end)
        : buildRelationCoMentionQuote(occurrence);
    return {
      anchorId: occurrence.evidence.id,
      quote,
      documentRef: occurrence.documentRef,
      method: "exact-with-context" as const,
      blocked: false,
      canonicalRange: range,
    };
  });
}

function rangesOverlap(left: CanonicalRange, right: CanonicalRange): boolean {
  return left.start < right.end && right.start < left.end;
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
 * vocabulary label must appear in the *same* Evidence window. Windows merge by
 * overlapping canonical ranges (or identical quote text as a fallback).
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
  /** Optional document texts for rebuilding quotes from merged ranges. */
  readonly documentTexts?: ReadonlyMap<string, string>;
}): CodexStructureExtractionRelationSeed[] {
  const vocabulary = input.vocabulary ?? BUILTIN_CODEX_RELATION_VOCABULARY;
  const maxSeeds = input.maxSeeds ?? MAX_DERIVED_RELATION_SEEDS;
  const documentTexts = input.documentTexts;

  type Mention = {
    readonly documentRef: string;
    readonly anchorId: string;
    readonly quote: string;
    readonly range: CanonicalRange | null;
    readonly entity: CoMentionEntity;
  };

  type AnchorWindow = {
    documentRef: string;
    anchorId: string;
    quote: string;
    range: CanonicalRange | null;
    entities: CoMentionEntity[];
  };

  const mentions: Mention[] = [];
  for (const proposal of input.proposals) {
    for (const row of proposal.evidence) {
      if (!row.documentRef || row.blocked || !row.quote) continue;
      if (!row.quote.includes(proposal.displayTitle)) continue;
      mentions.push({
        documentRef: row.documentRef,
        anchorId: row.anchorId,
        quote: row.quote,
        range: row.canonicalRange ?? null,
        entity: {
          surface: proposal.displayTitle,
          narrativeEntityId: proposal.narrativeEntityId,
          proposalId: proposal.proposalId,
        },
      });
    }
  }

  const windows: AnchorWindow[] = [];
  for (const mention of mentions) {
    let mergedInto: AnchorWindow | null = null;
    for (const window of windows) {
      if (window.documentRef !== mention.documentRef) continue;
      const canMergeByRange =
        window.range !== null &&
        mention.range !== null &&
        rangesOverlap(window.range, mention.range);
      const canMergeByQuote =
        window.range === null &&
        mention.range === null &&
        window.quote === mention.quote;
      if (!canMergeByRange && !canMergeByQuote) continue;
      mergedInto = window;
      break;
    }

    if (!mergedInto) {
      windows.push({
        documentRef: mention.documentRef,
        anchorId: mention.anchorId,
        quote: mention.quote,
        range: mention.range,
        entities: [mention.entity],
      });
      continue;
    }

    if (
      !mergedInto.entities.some(
        (entity) =>
          entity.narrativeEntityId === mention.entity.narrativeEntityId,
      )
    ) {
      mergedInto.entities.push(mention.entity);
    }
    if (mergedInto.range && mention.range) {
      mergedInto.range = {
        start: Math.min(mergedInto.range.start, mention.range.start),
        end: Math.max(mergedInto.range.end, mention.range.end),
      };
      const documentText = documentTexts?.get(mergedInto.documentRef);
      if (
        documentText &&
        mergedInto.range.end <= documentText.length &&
        mergedInto.range.start < mergedInto.range.end
      ) {
        mergedInto.quote = documentText.slice(
          mergedInto.range.start,
          mergedInto.range.end,
        );
      } else if (
        mention.quote.length > mergedInto.quote.length &&
        mention.quote.includes(mergedInto.entities[0]?.surface ?? "")
      ) {
        // Prefer the longer overlapping context when document text is unavailable.
        mergedInto.quote = mention.quote;
      }
    }
  }

  const seeds: CodexStructureExtractionRelationSeed[] = [];
  const seedByKey = new Map<string, CodexStructureExtractionRelationSeed>();

  for (const window of windows) {
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

          const resolved =
            vocab.directionality === "directed"
              ? resolveDirectedEndpoints(window.quote, left, right, label)
              : resolveSymmetricEndpoints(window.quote, left, right, label);
          if (!resolved) continue;
          const { subject, object } = resolved;

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
      proposals.filter(
        (item) =>
          item.applicability === "applicable" &&
          item.status === "approved" &&
          !item.application,
      ).length +
      relationProposals.filter(
        (item) =>
          item.applicability === "applicable" &&
          item.status === "approved" &&
          !item.application,
      ).length,
  };
}

let lastRunId: string | null = null;

/** Stable Apply requestIds keyed by run + proposal set + pending approved ops. */
const applyRequestIdByPlanFingerprint = new Map<string, string>();

function buildApplyPlanFingerprint(
  runId: string,
  proposalSetId: string,
  operations: readonly { proposalId: string; revisionId: string }[],
): string {
  const sortedOps = [...operations]
    .sort((a, b) => a.proposalId.localeCompare(b.proposalId))
    .map((op) => `${op.proposalId}:${op.revisionId}`)
    .join("|");
  return `${runId}\0${proposalSetId}\0${sortedOps}`;
}

export function resetCodexStructureExtractionApiCachesForTests(): void {
  lastRunId = null;
  applyRequestIdByPlanFingerprint.clear();
}

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
  const documentTextsByRef = new Map<string, string>();
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
    for (const document of snapshot.documents) {
      documentTextsByRef.set(document.ref, document.canonical.text);
    }

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
          buildRelationEvidenceFromOccurrences(
            seed.occurrences,
            documentTextsByRef,
          ),
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
      documentTexts: documentTextsByRef,
    });

  const existingRelations: readonly ExistingRelationCatalogRecord[] =
    request.existingRelations ?? [];

  const resolveEndpointEntryId = (narrativeEntityId: string): string | null => {
    const entity = proposals.find(
      (proposal) =>
        proposal.proposal.payload.narrativeEntityId === narrativeEntityId,
    );
    if (!entity) return null;
    const binding = entity.proposal.payload.binding;
    if (binding.kind !== "bind-existing") return null;
    return resolveCodexEntitySourceKey(binding.entityRef, catalogSnapshot);
  };

  const relationProposals: CodexRelationReviewProposal[] =
    relationSeeds.flatMap((seed, index): CodexRelationReviewProposal[] => {
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

      const fromEntryId = resolveEndpointEntryId(seed.subjectEntityId);
      const toEntryId = resolveEndpointEntryId(seed.objectEntityId);
      const provisionalSemanticKey =
        fromEntryId && toEntryId
          ? buildCodexRelationSemanticKey({
              projectId: request.projectId,
              fromCodexId: fromEntryId,
              toCodexId: toEntryId,
              relationType: seed.predicate,
              directionality: seed.directionality ?? "directed",
              forwardLabel: seed.forwardLabel,
              inverseLabel: seed.inverseLabel ?? null,
            })
          : null;
      const existingMatch = matchExistingCodexRelation(
        provisionalSemanticKey,
        existingRelations,
      );
      if (existingMatch.status === "already-satisfied") {
        const evidenceQuotes =
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
        return [
          {
            proposalId: created.proposalId,
            revisionId: null,
            proposalKey: hypothesis.hypothesisId,
            status: "unreviewed" as const,
            applicability: "already-satisfied" as const,
            displayTitle: `${subjectLabel} → ${seed.forwardLabel} → ${objectLabel}`,
            proposal: created,
            evidence: evidenceQuotes.map((row) => ({
              anchorId: row.anchorId,
              quote: row.quote,
              documentRef: row.documentRef,
              method: "exact" as const,
              blocked: false,
            })),
            subjectLabel,
            objectLabel,
            blockedReason: "既に同じ関係が登録されています（適用不要）",
            existingRelationRef: existingMatch.existingRef,
            hypothesisId: hypothesis.hypothesisId,
          },
        ];
      }

      const blockedDeps = !relationEndpointsReady(
        {
          proposal: created,
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
        },
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
          existingRelations,
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
            payloadJson: buildCodexReviewRevisionEnvelope({
              reviewPayload: proposal.proposal.payload,
            }) as unknown as Record<string, unknown>,
          })),
          ...relationProposals.map((proposal) => ({
            proposalId: proposal.proposalId,
            proposalKey: proposal.proposalKey,
            kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
            // Domain payload only — dependencies live in summaryJson.
            payloadJson: buildCodexReviewRevisionEnvelope({
              reviewPayload: proposal.proposal.payload,
            }) as unknown as Record<string, unknown>,
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

      // Terminal "適用不要" decisions so already-satisfied rows leave resumable
      // unreviewed queues and survive cold-start without Apply attempts.
      for (const proposal of finalRelations) {
        if (
          proposal.applicability !== "already-satisfied" ||
          !proposal.revisionId
        ) {
          continue;
        }
        await appendDecision({
          runId,
          projectId: request.projectId,
          proposalId: proposal.proposalId,
          revisionId: proposal.revisionId,
          decision: "deferred",
          decisionJson: {
            reason: "already-satisfied",
            existingRelationRef: proposal.existingRelationRef ?? null,
          },
          createdBy: CODEX_STRUCTURE_LEASE_OWNER,
        });
      }

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
        artifacts: (() => {
          const evidenceByProposalId: Record<
            string,
            readonly CodexReviewEvidenceQuote[]
          > = {};
          const relationLabelsByProposalId: Record<
            string,
            { subjectLabel: string; objectLabel: string }
          > = {};
          for (const proposal of finalProposals) {
            evidenceByProposalId[proposal.proposalId] = proposal.evidence;
          }
          for (const proposal of finalRelations) {
            evidenceByProposalId[proposal.proposalId] = proposal.evidence;
            relationLabelsByProposalId[proposal.proposalId] = {
              subjectLabel: proposal.subjectLabel,
              objectLabel: proposal.objectLabel,
            };
          }
          const reviewDraft = buildInlineJsonArtifact(
            CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
            {
              proposalSetId: saved.proposalSetId,
              evidenceByProposalId,
              relationLabelsByProposalId,
            } as unknown as Record<string, unknown>,
          );
          rememberInlineJsonArtifact({
            runId,
            taskId: claim.task.taskId,
            attemptId: claim.task.attemptId,
            draft: reviewDraft,
          });
          return [reviewDraft.artifactInput];
        })(),
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
    folderId: request.folderId,
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
    existingRelations,
    ...counts,
  };

  // Intentionally do not setProjection — Dialog publishes after generation checks.
  return projection;
}

export function getCodexStructureReview(): CodexStructureExtractionReviewProjection | null {
  return useCodexStructureExtractionStore.getState().projection;
}

export function getLastCodexStructureRunId(): string | null {
  return lastRunId;
}

function folderIdFromScopeJson(scopeJson: unknown): string | null {
  if (!scopeJson || typeof scopeJson !== "object") return null;
  const folderId = (scopeJson as Record<string, unknown>).folderId;
  return typeof folderId === "string" ? folderId : null;
}

function coverageFromRunJson(
  coverageJson: unknown,
): CodexStructureExtractionCoverage {
  if (!coverageJson || typeof coverageJson !== "object") return {};
  const record = coverageJson as Record<string, unknown>;
  return {
    mode: typeof record.mode === "string" ? record.mode : undefined,
    documentCount:
      typeof record.documentCount === "number"
        ? record.documentCount
        : undefined,
    windowCount:
      typeof record.windowCount === "number" ? record.windowCount : undefined,
    completedWindows:
      typeof record.completedWindows === "number"
        ? record.completedWindows
        : undefined,
    gaps: Array.isArray(record.gaps)
      ? (record.gaps as CodexStructureExtractionCoverage["gaps"])
      : undefined,
  };
}

function catalogFromSummaryJson(
  summaryJson: unknown,
): CodexStructureCatalogSnapshot | null {
  if (!summaryJson || typeof summaryJson !== "object") return null;
  const catalog = (summaryJson as Record<string, unknown>).catalog;
  if (!catalog || typeof catalog !== "object") return null;
  const record = catalog as Record<string, unknown>;
  const entities = Array.isArray(record.entities) ? record.entities : [];
  const types = Array.isArray(record.types) ? record.types : [];
  return {
    entities: entities as CodexStructureCatalogSnapshot["entities"],
    types: types as CodexStructureCatalogSnapshot["types"],
  };
}

function isEvidenceMethod(
  value: unknown,
): value is CodexReviewEvidenceQuote["method"] {
  return (
    value === "exact" ||
    value === "exact-with-context" ||
    value === "fragmented" ||
    value === "unknown"
  );
}

function parseEvidenceQuotes(
  value: unknown,
): readonly CodexReviewEvidenceQuote[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (
      typeof record.anchorId !== "string" ||
      typeof record.quote !== "string" ||
      typeof record.documentRef !== "string" ||
      !isEvidenceMethod(record.method)
    ) {
      return [];
    }
    const canonicalRange =
      record.canonicalRange &&
      typeof record.canonicalRange === "object" &&
      typeof (record.canonicalRange as Record<string, unknown>).start ===
        "number" &&
      typeof (record.canonicalRange as Record<string, unknown>).end === "number"
        ? {
            start: (record.canonicalRange as { start: number }).start,
            end: (record.canonicalRange as { end: number }).end,
          }
        : undefined;
    return [
      {
        anchorId: record.anchorId,
        quote: record.quote,
        documentRef: record.documentRef,
        sceneId:
          typeof record.sceneId === "string" ? record.sceneId : undefined,
        sceneTitle:
          typeof record.sceneTitle === "string" ? record.sceneTitle : undefined,
        method: record.method,
        blocked: record.blocked === true ? true : undefined,
        canonicalRange,
      },
    ];
  });
}

function isBindCodexEntityPayload(
  value: unknown,
): value is BindCodexEntityPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.narrativeEntityId === "string" &&
    typeof record.canonicalName === "string" &&
    Array.isArray(record.aliases) &&
    record.binding !== null &&
    typeof record.binding === "object" &&
    record.typeResolution !== null &&
    typeof record.typeResolution === "object"
  );
}

function isRelationCreatePayload(
  value: unknown,
): value is CreateCodexRelationProposalPayload {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.subjectEntityId === "string" &&
    typeof record.objectEntityId === "string" &&
    record.relation !== null &&
    typeof record.relation === "object"
  );
}

function wrapBindProposal(
  proposalId: string,
  payload: BindCodexEntityPayload,
): BindCodexEntityProposal {
  if (payload.binding.kind === "create-new") {
    return createNewBindCodexEntityProposal(
      payload as BindCodexEntityPayload & {
        binding: Extract<
          BindCodexEntityPayload["binding"],
          { kind: "create-new" }
        >;
      },
      { proposalId },
    );
  }
  if (payload.binding.kind === "bind-existing") {
    return bindExistingCodexEntityProposal(
      payload as BindCodexEntityPayload & {
        binding: Extract<
          BindCodexEntityPayload["binding"],
          { kind: "bind-existing" }
        >;
      },
      { proposalId },
    );
  }
  return unresolvedBindCodexEntityProposal(
    payload as BindCodexEntityPayload & {
      binding: Extract<
        BindCodexEntityPayload["binding"],
        { kind: "unresolved" }
      >;
    },
    { proposalId },
  );
}

function inferCompiledOperationFromNativePayload(
  kind: string,
  payloadJson: Readonly<Record<string, unknown>>,
): CodexCompiledDomainOperation | null {
  if (kind === CODEX_RELATION_CREATE_PROPOSAL_KIND) {
    if (typeof payloadJson.relationId === "string") {
      return { kind: "codex.relation.create", payload: payloadJson };
    }
    return null;
  }
  if (kind !== CODEX_ENTITY_BIND_PROPOSAL_KIND) return null;
  if (
    typeof payloadJson.entryId === "string" &&
    typeof payloadJson.typeSlug === "string" &&
    typeof payloadJson.name === "string"
  ) {
    return { kind: "codex.entry.create", payload: payloadJson };
  }
  if (
    typeof payloadJson.entryId === "string" &&
    typeof payloadJson.baseVersion === "number" &&
    payloadJson.aliases &&
    typeof payloadJson.aliases === "object"
  ) {
    return { kind: "codex.entry.patch", payload: payloadJson };
  }
  if (
    typeof payloadJson.entryId === "string" &&
    typeof payloadJson.narrativeEntityId === "string" &&
    typeof payloadJson.baseVersion === "number"
  ) {
    return { kind: "codex.entity.bind-existing", payload: payloadJson };
  }
  return null;
}

function existingRelationsFromSummaryJson(
  summaryJson: unknown,
): readonly ExistingRelationCatalogRecord[] {
  if (!summaryJson || typeof summaryJson !== "object") return [];
  const raw = (summaryJson as Record<string, unknown>).existingRelations;
  return Array.isArray(raw) ? (raw as ExistingRelationCatalogRecord[]) : [];
}

function parseEvidenceArtifact(
  raw: CodexStructureReviewArtifactPayload | null,
): {
  readonly proposalSetId?: string;
  readonly evidenceByProposalId: ReadonlyMap<
    string,
    readonly CodexReviewEvidenceQuote[]
  >;
  readonly relationLabelsByProposalId: ReadonlyMap<
    string,
    { readonly subjectLabel: string; readonly objectLabel: string }
  >;
} {
  const evidenceByProposalId = new Map<
    string,
    readonly CodexReviewEvidenceQuote[]
  >();
  const relationLabelsByProposalId = new Map<
    string,
    { readonly subjectLabel: string; readonly objectLabel: string }
  >();
  if (!raw) {
    return { evidenceByProposalId, relationLabelsByProposalId };
  }
  if (
    raw.evidenceByProposalId &&
    typeof raw.evidenceByProposalId === "object"
  ) {
    for (const [proposalId, value] of Object.entries(
      raw.evidenceByProposalId,
    )) {
      evidenceByProposalId.set(proposalId, parseEvidenceQuotes(value));
    }
  }
  if (
    raw.relationLabelsByProposalId &&
    typeof raw.relationLabelsByProposalId === "object"
  ) {
    for (const [proposalId, value] of Object.entries(
      raw.relationLabelsByProposalId,
    )) {
      if (!value || typeof value !== "object") continue;
      const record = value as Record<string, unknown>;
      if (
        typeof record.subjectLabel === "string" &&
        typeof record.objectLabel === "string"
      ) {
        relationLabelsByProposalId.set(proposalId, {
          subjectLabel: record.subjectLabel,
          objectLabel: record.objectLabel,
        });
      }
    }
  }
  return {
    proposalSetId:
      typeof raw.proposalSetId === "string" ? raw.proposalSetId : undefined,
    evidenceByProposalId,
    relationLabelsByProposalId,
  };
}

function decisionAlreadySatisfied(
  native: ReviewBundleProposal | undefined,
): { readonly existingRelationRef?: string } | null {
  if (!native || native.status !== "deferred") return null;
  const decision = native.latestDecision;
  if (!decision) return null;
  if (decision.revisionId !== native.currentRevisionId) return null;
  if (decision.decisionJson?.reason !== "already-satisfied") return null;
  const ref = decision.decisionJson?.existingRelationRef;
  return {
    existingRelationRef: typeof ref === "string" ? ref : undefined,
  };
}

function applicationFromNative(
  native: ReviewBundleProposal,
): CodexEntityReviewProposal["application"] {
  const app = native.application;
  if (!app) return null;
  if (app.revisionId !== native.currentRevisionId) {
    throw new Error(
      `NEX_APPLICATION_REVISION_MISMATCH: proposal '${native.proposalId}' application revision '${app.revisionId}' != current '${native.currentRevisionId}'`,
    );
  }
  return {
    revisionId: app.revisionId,
    appliedEntityKind: app.appliedEntityKind,
    appliedEntityId: app.appliedEntityId,
  };
}

function assertProposalNotApplied(
  proposal: { readonly proposalId: string; readonly application?: unknown },
  action: string,
): void {
  if (proposal.application) {
    throw new Error(
      `NEX_PROPOSAL_ALREADY_APPLIED: cannot ${action} applied proposal '${proposal.proposalId}'`,
    );
  }
}

function rebuildEntityFromNative(args: {
  readonly native: ReviewBundleProposal;
  readonly evidence: readonly CodexReviewEvidenceQuote[];
}): CodexEntityReviewProposal | null {
  const envelope = parseCodexReviewRevisionEnvelope(args.native.payloadJson);
  const reviewPayload = envelope
    ? envelope.reviewPayload
    : isBindCodexEntityPayload(args.native.payloadJson)
      ? args.native.payloadJson
      : null;
  if (!reviewPayload || !isBindCodexEntityPayload(reviewPayload)) {
    return null;
  }
  const proposal = wrapBindProposal(args.native.proposalId, reviewPayload);
  const evidence =
    args.evidence.length > 0
      ? args.evidence
      : [
          {
            anchorId: `missing-${args.native.proposalId}`,
            quote: "",
            documentRef: "",
            method: "unknown" as const,
            blocked: true,
          },
        ];
  const safety = buildCodexEntityProposalSafetyFlags({
    bindingKind: proposal.payload.binding.kind,
    typeStatus: proposal.payload.typeResolution.status,
    evidenceMethods: evidence.map((row) => row.method),
    hasExistingCandidates: proposal.payload.binding.kind !== "create-new",
    hasProperNameMention: true,
    aliasesAllExplicit: proposal.payload.aliases.every(
      (alias) => alias.status === "explicit",
    ),
  });
  const typeResolved = proposal.payload.typeResolution.status === "resolved";
  const applicability =
    proposal.payload.binding.kind === "unresolved" ||
    (proposal.payload.binding.kind === "create-new" && !typeResolved)
      ? ("blocked" as const)
      : ("applicable" as const);
  const compiledOperation =
    envelope?.compiledOperation ??
    (!isBindCodexEntityPayload(args.native.payloadJson)
      ? inferCompiledOperationFromNativePayload(
          args.native.kind,
          args.native.payloadJson,
        )
      : null);
  return {
    proposalId: args.native.proposalId,
    revisionId: args.native.currentRevisionId,
    proposalKey: args.native.proposalKey,
    status: args.native.status,
    applicability,
    displayTitle: proposal.payload.canonicalName,
    proposal,
    evidence,
    safety,
    blockedReason:
      applicability === "blocked"
        ? proposal.payload.binding.kind === "unresolved"
          ? "Binding が未解決です"
          : "Codex Type が未解決です"
        : undefined,
    compiledOperation,
    application: applicationFromNative(args.native),
  };
}

function rebuildRelationFromNative(args: {
  readonly native: ReviewBundleProposal;
  readonly evidence: readonly CodexReviewEvidenceQuote[];
  readonly labels?: {
    readonly subjectLabel: string;
    readonly objectLabel: string;
  };
  readonly dependencies: readonly {
    readonly kind: string;
    readonly proposalId: string;
  }[];
  readonly entityTitles: ReadonlyMap<string, string>;
}): CodexRelationReviewProposal | null {
  const envelope = parseCodexReviewRevisionEnvelope(args.native.payloadJson);
  const reviewPayload = envelope
    ? envelope.reviewPayload
    : isRelationCreatePayload(args.native.payloadJson)
      ? args.native.payloadJson
      : null;
  if (!reviewPayload || !isRelationCreatePayload(reviewPayload)) {
    return null;
  }
  const satisfied = decisionAlreadySatisfied(args.native);
  // Prefer live Entity titles (covers rename / endpoint swap). Artifact labels
  // are fallback for endpoints not present in the entity title map.
  const subjectLabel =
    args.entityTitles.get(reviewPayload.subjectEntityId) ??
    args.labels?.subjectLabel ??
    reviewPayload.subjectEntityId;
  const objectLabel =
    args.entityTitles.get(reviewPayload.objectEntityId) ??
    args.labels?.objectLabel ??
    reviewPayload.objectEntityId;
  const proposal: CreateCodexRelationProposal = {
    proposalId: args.native.proposalId,
    kind: CODEX_RELATION_CREATE_PROPOSAL_KIND,
    target: { kind: "new", logicalRef: args.native.proposalKey },
    payload: reviewPayload,
    dependencies: args.dependencies.map((dep) => ({
      kind: "requires-resolution" as const,
      proposalId: dep.proposalId,
    })),
  };
  const compiledOperation =
    envelope?.compiledOperation ??
    (!isRelationCreatePayload(args.native.payloadJson)
      ? inferCompiledOperationFromNativePayload(
          args.native.kind,
          args.native.payloadJson,
        )
      : null);
  return {
    proposalId: args.native.proposalId,
    revisionId: args.native.currentRevisionId,
    proposalKey: args.native.proposalKey,
    status: args.native.status,
    applicability: satisfied ? "already-satisfied" : "applicable",
    displayTitle: `${subjectLabel} → ${reviewPayload.relation.forwardLabel} → ${objectLabel}`,
    proposal,
    evidence: args.evidence,
    subjectLabel,
    objectLabel,
    existingRelationRef: satisfied?.existingRelationRef,
    blockedReason: satisfied
      ? "既に同じ関係が登録されています（適用不要）"
      : undefined,
    compiledOperation,
    application: applicationFromNative(args.native),
  };
}

/**
 * Build a review projection from Native without publishing to the store.
 * Callers (Dialog) must setProjection only after generation/folder authority checks.
 */
export async function getCodexStructureExtractionReview(
  runId: string,
  scope?: {
    readonly projectId: string;
    readonly workspacePath?: string;
    readonly openRevision?: number;
    readonly folderId?: string;
  },
): Promise<CodexStructureExtractionReviewProjection> {
  const current = useCodexStructureExtractionStore.getState().projection;
  if (current && current.runId === runId) {
    if (scope && current.projectId !== scope.projectId) {
      throw new Error(
        "Codex structure extraction run belongs to another project",
      );
    }
    if (
      scope?.workspacePath !== undefined &&
      current.workspacePath !== null &&
      current.workspacePath !== scope.workspacePath
    ) {
      throw new Error(
        "Codex structure extraction run belongs to another workspace",
      );
    }
    if (
      scope?.openRevision !== undefined &&
      current.openRevision !== null &&
      current.openRevision !== scope.openRevision
    ) {
      throw new Error(
        "Codex structure extraction run belongs to another workspace revision",
      );
    }
    if (
      scope?.folderId !== undefined &&
      current.folderId != null &&
      current.folderId !== scope.folderId
    ) {
      throw new Error(
        "Codex structure extraction run belongs to another folder",
      );
    }
    return current;
  }

  if (!scope) {
    throw new Error(
      `Codex structure extraction review not loaded for run ${runId}`,
    );
  }

  const runProjection = await getRun(runId, scope.projectId);
  if (
    runProjection.run.surfacePathId !== CODEX_STRUCTURE_EXTRACT_SURFACE_PATH
  ) {
    throw new Error("Run is not a codex structure extraction surface");
  }
  const runFolderId = folderIdFromScopeJson(runProjection.run.scopeJson);
  if (
    scope.folderId !== undefined &&
    runFolderId !== null &&
    runFolderId !== scope.folderId
  ) {
    throw new Error(
      `Codex structure extraction run folder mismatch: expected ${scope.folderId}, got ${runFolderId}`,
    );
  }

  let bundle;
  try {
    bundle = await hydrateInlineArtifactsFromNative({
      runId,
      projectId: scope.projectId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to restore codex structure extraction review from Native: ${message}`,
      { cause: error },
    );
  }

  if (!bundle.proposalSet) {
    throw new Error(
      `Codex structure extraction run ${runId} has no Native proposal set`,
    );
  }

  const artifactPayload =
    await loadInlineJsonArtifact<CodexStructureReviewArtifactPayload>(
      runId,
      CODEX_STRUCTURE_REVIEW_ARTIFACT_KIND,
      { projectId: scope.projectId },
    );
  if (!artifactPayload) {
    throw new Error(
      `Codex structure extraction run ${runId} missing review-projection artifact`,
    );
  }
  const artifact = parseEvidenceArtifact(artifactPayload);
  if (
    artifact.proposalSetId &&
    artifact.proposalSetId !== bundle.proposalSet.proposalSetId
  ) {
    throw new Error(
      `Codex structure extraction run ${runId} review artifact proposalSetId mismatch`,
    );
  }

  const depsByRelationId = relationDependenciesFromSummaryJson(
    bundle.proposalSet.summaryJson,
  );
  const catalog = catalogFromSummaryJson(bundle.proposalSet.summaryJson);
  const existingRelations = existingRelationsFromSummaryJson(
    bundle.proposalSet.summaryJson,
  );

  const entityNatives = bundle.proposals.filter(
    (row) => row.kind === CODEX_ENTITY_BIND_PROPOSAL_KIND,
  );
  const relationNatives = bundle.proposals.filter(
    (row) => row.kind === CODEX_RELATION_CREATE_PROPOSAL_KIND,
  );

  const proposals = entityNatives.flatMap((native) => {
    const row = rebuildEntityFromNative({
      native,
      evidence: artifact.evidenceByProposalId.get(native.proposalId) ?? [],
    });
    return row ? [row] : [];
  });
  if (proposals.length === 0 && entityNatives.length > 0) {
    throw new Error(
      `Codex structure extraction run ${runId} missing review payloads for entities`,
    );
  }

  const entityTitles = new Map(
    proposals.map((row) => [
      row.proposal.payload.narrativeEntityId,
      row.displayTitle,
    ]),
  );

  const rebuiltRelations = relationNatives.flatMap((native) => {
    const row = rebuildRelationFromNative({
      native,
      evidence: artifact.evidenceByProposalId.get(native.proposalId) ?? [],
      labels: artifact.relationLabelsByProposalId.get(native.proposalId),
      dependencies: depsByRelationId.get(native.proposalId) ?? [],
      entityTitles,
    });
    return row ? [row] : [];
  });
  if (rebuiltRelations.length === 0 && relationNatives.length > 0) {
    throw new Error(
      `Codex structure extraction run ${runId} missing review payloads for relations`,
    );
  }

  // Native "already-satisfied" decisions are terminal and authoritative — a
  // rematch that cannot re-derive the semantic match (e.g. entity bindings
  // still pending approval) must not silently flip the row back to
  // blocked/applicable.
  const nativeAlreadySatisfiedRefById = new Map<string, string | undefined>();
  for (const native of relationNatives) {
    const satisfied = decisionAlreadySatisfied(native);
    if (satisfied) {
      nativeAlreadySatisfiedRefById.set(
        native.proposalId,
        satisfied.existingRelationRef,
      );
    }
  }

  const relationProposals = rematchCodexRelationProposals({
    entities: proposals,
    relations: rebuiltRelations,
    projectId: scope.projectId,
    existingRelations,
    catalog,
  }).map((relation) => {
    if (
      relation.applicability === "already-satisfied" ||
      !nativeAlreadySatisfiedRefById.has(relation.proposalId)
    ) {
      return relation;
    }
    return {
      ...relation,
      applicability: "already-satisfied" as const,
      existingRelationRef: nativeAlreadySatisfiedRefById.get(
        relation.proposalId,
      ),
      blockedReason: "既に同じ関係が登録されています（適用不要）",
      status: "unreviewed" as const,
      compiledOperation: null,
    };
  });

  const counts = recountProjection(proposals, relationProposals);
  const projection: CodexStructureExtractionReviewProjection = {
    runId,
    projectId: scope.projectId,
    workspacePath: scope.workspacePath ?? null,
    openRevision: scope.openRevision ?? null,
    proposalSetId: artifact.proposalSetId ?? bundle.proposalSet.proposalSetId,
    folderId: runFolderId ?? scope.folderId ?? null,
    status: runProjection.run.status,
    coverage: coverageFromRunJson(runProjection.run.coverageJson),
    taskCounts: runProjection.taskCounts,
    proposals,
    relationProposals,
    catalog,
    existingRelations,
    ...counts,
  };

  lastRunId = runId;
  // Intentionally do not setProjection — Dialog publishes after generation checks.
  return projection;
}

/**
 * Restore the newest resumable Codex structure extraction review for a dialog scope.
 * Soft-fails (returns null) when Native ledger has no matching run.
 * Does not publish to the store.
 */
export async function restoreCodexStructureExtractionReview(scope: {
  readonly projectId: string;
  readonly workspacePath: string;
  readonly openRevision: number;
  readonly folderId: string;
}): Promise<CodexStructureExtractionReviewProjection | null> {
  const current = useCodexStructureExtractionStore.getState().projection;
  if (
    current &&
    current.projectId === scope.projectId &&
    current.workspacePath === scope.workspacePath &&
    current.openRevision === scope.openRevision &&
    current.folderId === scope.folderId
  ) {
    return current;
  }

  try {
    const resumable = await listResumableRuns({
      projectId: scope.projectId,
      surfacePathId: CODEX_STRUCTURE_EXTRACT_SURFACE_PATH,
      limit: 8,
    });
    for (const candidate of resumable) {
      const candidateFolder = folderIdFromScopeJson(candidate.run.scopeJson);
      if (candidateFolder !== null && candidateFolder !== scope.folderId) {
        continue;
      }
      try {
        return await getCodexStructureExtractionReview(
          candidate.run.runId,
          scope,
        );
      } catch {
        continue;
      }
    }
    return null;
  } catch {
    return null;
  }
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

  // Preflight: rematch existing Relations so Apply never sends semantic duplicates.
  const rematchedRelations = rematchCodexRelationProposals({
    entities: projection.proposals,
    relations: projection.relationProposals,
    projectId: projection.projectId,
    existingRelations: projection.existingRelations ?? [],
    catalog: projection.catalog,
  });
  if (
    rematchedRelations.some(
      (row, index) =>
        row.applicability !==
        projection.relationProposals[index]?.applicability,
    )
  ) {
    useCodexStructureExtractionStore.getState().setProjection({
      ...projection,
      relationProposals: rematchedRelations,
    });
    await persistNewlySatisfiedRelationDecisions(
      projection,
      useCodexStructureExtractionStore.getState().projection ?? {
        ...projection,
        relationProposals: rematchedRelations,
      },
    );
  }
  const active =
    useCodexStructureExtractionStore.getState().projection ?? projection;

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

  // Seed CommitMap from already-applied Entity proposals so Relations can
  // resolve endpoints without re-sending those operations. Applied entities
  // are always "existing" for subsequent commits (even if originally create-new),
  // because Native only wires source==="existing" bindings into CommitMap.
  for (const review of active.proposals) {
    const appliedId = review.application?.appliedEntityId;
    if (!appliedId) continue;
    const narrativeEntityId = review.proposal.payload.narrativeEntityId;
    existingBindings.push({
      narrativeEntityId,
      codexEntryId: appliedId,
      source: "existing",
    });
    commitMap = registerExistingBinding(
      commitMap,
      narrativeEntityId,
      appliedId,
    );
  }

  const approvedEntities = active.proposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "approved" &&
      proposal.revisionId &&
      !proposal.application,
  );

  for (const review of approvedEntities) {
    const revisionId = review.revisionId!;
    const operation =
      (review.compiledOperation as CodexDomainOperationV1 | null | undefined) ??
      compileEntityOperationForReview(review, active.catalog, input);
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

  const approvedRelations = active.relationProposals.filter(
    (proposal) =>
      proposal.applicability === "applicable" &&
      proposal.status === "approved" &&
      proposal.revisionId &&
      !proposal.application,
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
  if (!active.proposalSetId) {
    throw new Error("Missing proposalSetId for codex commit");
  }

  const planFingerprint = buildApplyPlanFingerprint(
    active.runId,
    active.proposalSetId,
    operations,
  );
  let requestId = applyRequestIdByPlanFingerprint.get(planFingerprint);
  if (!requestId) {
    requestId = crypto.randomUUID();
    applyRequestIdByPlanFingerprint.set(planFingerprint, requestId);
  }

  await prepareAndApplyCodexCommit({
    projectId: input.projectId,
    runId: active.runId,
    proposalSetId: active.proposalSetId,
    requestId,
    sessionId: crypto.randomUUID(),
    surface: "codex/CodexStructureExtractDialog",
    operations,
    existingBindings,
  });

  applyRequestIdByPlanFingerprint.delete(planFingerprint);

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
  assertProposalNotApplied(proposal, "decide");
  if (
    kind === "relation" &&
    (proposal as CodexRelationReviewProposal).applicability ===
      "already-satisfied"
  ) {
    throw new Error(
      `Cannot decide already-satisfied Relation ${args.proposalId}`,
    );
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

  const decision =
    args.status === "approved"
      ? "approved"
      : args.status === "rejected"
        ? "rejected"
        : args.status === "held"
          ? "held"
          : "deferred";

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
      const rematched = evaluateCodexRelationApplicability({
        relation,
        entities: projection.proposals,
        projectId: projection.projectId,
        existingRelations: projection.existingRelations ?? [],
        catalog: projection.catalog,
      });
      if (rematched.applicability === "already-satisfied") {
        useCodexStructureExtractionStore.getState().setProjection({
          ...projection,
          relationProposals: projection.relationProposals.map((item) =>
            item.proposalId === args.proposalId ? rematched : item,
          ),
          ...recountProjection(
            projection.proposals,
            projection.relationProposals.map((item) =>
              item.proposalId === args.proposalId ? rematched : item,
            ),
          ),
        });
        if (rematched.revisionId) {
          await appendDecision({
            runId: projection.runId,
            projectId: projection.projectId,
            proposalId: rematched.proposalId,
            revisionId: rematched.revisionId,
            decision: "deferred",
            decisionJson: {
              reason: "already-satisfied",
              existingRelationRef: rematched.existingRelationRef ?? null,
            },
            createdBy: CODEX_STRUCTURE_LEASE_OWNER,
          });
        }
        return;
      }
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

    // Atomic revision + decision in ONE Native transaction so an approve can
    // never leave a fresh revision without its decision.
    const result = await reviseAndDecide({
      runId: projection.runId,
      projectId: projection.projectId,
      proposalId: args.proposalId,
      expectedCurrentRevisionId: revisionId,
      payloadJson: buildCodexReviewRevisionEnvelope({
        reviewPayload:
          kind === "entity"
            ? (proposal as CodexEntityReviewProposal).proposal.payload
            : (proposal as CodexRelationReviewProposal).proposal.payload,
        compiledOperation,
      }) as unknown as Readonly<Record<string, unknown>>,
      decision,
      createdBy: "codex-structure-extract-dialog",
    });
    revisionId = result.revisionId;
  } else {
    // Reject / held / deferred keep the current revision — decision only.
    await appendDecision({
      runId: projection.runId,
      projectId: projection.projectId,
      proposalId: args.proposalId,
      revisionId,
      decision,
      createdBy: "codex-structure-extract-dialog",
    });
  }

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
  assertProposalNotApplied(current, "revise");
  const snapshot = projection;
  store.reviseProposalFields(args.proposalId, args.patch);
  const updated = useCodexStructureExtractionStore
    .getState()
    .projection?.proposals.find((item) => item.proposalId === args.proposalId);
  if (!updated) {
    useCodexStructureExtractionStore.getState().setProjection(snapshot);
    throw new Error(`Proposal ${args.proposalId} missing after revise`);
  }
  let result;
  try {
    result = await appendRevision({
      runId: projection.runId,
      projectId: projection.projectId,
      proposalId: args.proposalId,
      expectedCurrentRevisionId: current.revisionId,
      payloadJson: buildCodexReviewRevisionEnvelope({
        reviewPayload: updated.proposal.payload,
      }) as unknown as Readonly<Record<string, unknown>>,
      createdBy: "codex-structure-extract-dialog",
    });
  } catch (error) {
    useCodexStructureExtractionStore.getState().setProjection(snapshot);
    throw error;
  }
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
  await persistNewlySatisfiedRelationDecisions(projection, latest);
}

async function persistNewlySatisfiedRelationDecisions(
  before: CodexStructureExtractionReviewProjection,
  after: CodexStructureExtractionReviewProjection,
): Promise<void> {
  for (const relation of after.relationProposals) {
    if (
      relation.applicability !== "already-satisfied" ||
      !relation.revisionId
    ) {
      continue;
    }
    const previous = before.relationProposals.find(
      (item) => item.proposalId === relation.proposalId,
    );
    if (previous?.applicability === "already-satisfied") continue;
    await appendDecision({
      runId: after.runId,
      projectId: after.projectId,
      proposalId: relation.proposalId,
      revisionId: relation.revisionId,
      decision: "deferred",
      decisionJson: {
        reason: "already-satisfied",
        existingRelationRef: relation.existingRelationRef ?? null,
      },
      createdBy: CODEX_STRUCTURE_LEASE_OWNER,
    });
  }
}

/**
 * Persist Binding resolution to Native and rematch Relations for already-satisfied.
 */
export async function resolveCodexStructureBinding(args: {
  readonly proposalId: string;
  readonly resolution:
    | { readonly kind: "create-new" }
    | { readonly kind: "bind-existing"; readonly entityRef: string };
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
  assertProposalNotApplied(current, "resolve binding");
  const snapshot = projection;
  store.resolveBinding(args.proposalId, args.resolution);
  const updated = useCodexStructureExtractionStore
    .getState()
    .projection?.proposals.find((item) => item.proposalId === args.proposalId);
  if (!updated) {
    useCodexStructureExtractionStore.getState().setProjection(snapshot);
    throw new Error(`Proposal ${args.proposalId} missing after resolve`);
  }
  let result;
  try {
    result = await appendRevision({
      runId: projection.runId,
      projectId: projection.projectId,
      proposalId: args.proposalId,
      expectedCurrentRevisionId: current.revisionId,
      payloadJson: buildCodexReviewRevisionEnvelope({
        reviewPayload: updated.proposal.payload,
      }) as unknown as Readonly<Record<string, unknown>>,
      createdBy: CODEX_STRUCTURE_LEASE_OWNER,
    });
  } catch (error) {
    useCodexStructureExtractionStore.getState().setProjection(snapshot);
    throw error;
  }
  const mid = useCodexStructureExtractionStore.getState().projection;
  if (!mid) return;
  useCodexStructureExtractionStore.getState().setProjection({
    ...mid,
    proposals: mid.proposals.map((proposal) =>
      proposal.proposalId === args.proposalId
        ? { ...proposal, revisionId: result.revisionId, status: "unreviewed" }
        : proposal,
    ),
  });
  const latest = useCodexStructureExtractionStore.getState().projection;
  if (!latest) return;
  await persistNewlySatisfiedRelationDecisions(projection, latest);
}

export async function reviseCodexStructureRelation(args: {
  readonly proposalId: string;
  readonly patch: {
    directionality?: "directed" | "symmetric";
    forwardLabel?: string;
    inverseLabel?: string | null;
  };
}): Promise<void> {
  const store = useCodexStructureExtractionStore.getState();
  const projection = store.projection;
  if (!projection)
    throw new Error("No active codex structure extraction review");
  const current = projection.relationProposals.find(
    (item) => item.proposalId === args.proposalId,
  );
  if (!current?.revisionId) {
    throw new Error(`Relation ${args.proposalId} missing revisionId`);
  }
  assertProposalNotApplied(current, "revise");
  const snapshot = projection;
  store.reviseRelationFields(args.proposalId, args.patch);
  const updated = useCodexStructureExtractionStore
    .getState()
    .projection?.relationProposals.find(
      (item) => item.proposalId === args.proposalId,
    );
  if (!updated) {
    useCodexStructureExtractionStore.getState().setProjection(snapshot);
    throw new Error(`Relation ${args.proposalId} missing after revise`);
  }
  let result;
  try {
    result = await appendRevision({
      runId: projection.runId,
      projectId: projection.projectId,
      proposalId: args.proposalId,
      expectedCurrentRevisionId: current.revisionId,
      payloadJson: buildCodexReviewRevisionEnvelope({
        reviewPayload: updated.proposal.payload,
      }) as unknown as Readonly<Record<string, unknown>>,
      createdBy: CODEX_STRUCTURE_LEASE_OWNER,
    });
  } catch (error) {
    useCodexStructureExtractionStore.getState().setProjection(snapshot);
    throw error;
  }
  const mid = useCodexStructureExtractionStore.getState().projection;
  if (!mid) return;
  useCodexStructureExtractionStore.getState().setProjection({
    ...mid,
    relationProposals: mid.relationProposals.map((proposal) =>
      proposal.proposalId === args.proposalId
        ? { ...proposal, revisionId: result.revisionId, status: "unreviewed" }
        : proposal,
    ),
  });
  const latest = useCodexStructureExtractionStore.getState().projection;
  if (!latest) return;
  await persistNewlySatisfiedRelationDecisions(projection, latest);
}

export async function swapCodexStructureRelationEndpoints(args: {
  readonly proposalId: string;
}): Promise<void> {
  const store = useCodexStructureExtractionStore.getState();
  const projection = store.projection;
  if (!projection)
    throw new Error("No active codex structure extraction review");
  const current = projection.relationProposals.find(
    (item) => item.proposalId === args.proposalId,
  );
  if (!current?.revisionId) {
    throw new Error(`Relation ${args.proposalId} missing revisionId`);
  }
  assertProposalNotApplied(current, "swap endpoints");
  const snapshot = projection;
  store.swapRelationEndpoints(args.proposalId);
  const updated = useCodexStructureExtractionStore
    .getState()
    .projection?.relationProposals.find(
      (item) => item.proposalId === args.proposalId,
    );
  if (!updated) {
    useCodexStructureExtractionStore.getState().setProjection(snapshot);
    throw new Error(`Relation ${args.proposalId} missing after swap`);
  }
  let result;
  try {
    result = await appendRevision({
      runId: projection.runId,
      projectId: projection.projectId,
      proposalId: args.proposalId,
      expectedCurrentRevisionId: current.revisionId,
      payloadJson: buildCodexReviewRevisionEnvelope({
        reviewPayload: updated.proposal.payload,
      }) as unknown as Readonly<Record<string, unknown>>,
      createdBy: CODEX_STRUCTURE_LEASE_OWNER,
    });
  } catch (error) {
    useCodexStructureExtractionStore.getState().setProjection(snapshot);
    throw error;
  }
  const mid = useCodexStructureExtractionStore.getState().projection;
  if (!mid) return;
  useCodexStructureExtractionStore.getState().setProjection({
    ...mid,
    relationProposals: mid.relationProposals.map((proposal) =>
      proposal.proposalId === args.proposalId
        ? { ...proposal, revisionId: result.revisionId, status: "unreviewed" }
        : proposal,
    ),
  });
  const latest = useCodexStructureExtractionStore.getState().projection;
  if (!latest) return;
  await persistNewlySatisfiedRelationDecisions(projection, latest);
}
