import {
  createEvidenceSpanCatalogSelectionResolver,
  type EvidenceSpanCatalogBinding,
  type EvidenceSpanCatalogSelectionResolver,
} from "../evidence/spanCatalog";
import type { ResolvedEvidenceAnchor } from "../evidence/types";
import { validateCitationIdBinding } from "@/application/narrative-extraction/aiTasks/citationIdObservation";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import {
  normalizeChronicleV2Actual,
  chronicleV2EvaluationScopeFor,
  type ChronicleV2AlignmentInput,
  type ChronicleV2Contract,
  type ChronicleV2EvidenceRegion,
  type ChronicleV2EvidenceCandidate,
  type ChronicleV2EvaluationScope,
  type ChronicleV2GoldClaim,
  type ChronicleV2NormalizedActualClaim,
  type ChronicleV2RawActualClaim,
} from "./chronicleV2Contract";
import {
  alignChronicleV2Claims,
  compareChronicleV2Claim,
  type ChronicleV2AlignmentReason,
  type ChronicleV2AlignmentResult,
} from "./chronicleV2Alignment";
import {
  buildChronicleV2TemporalRawRows,
  evaluateChronicleV2Temporal,
  remapChronicleV2TemporalGoldDocumentIds,
  validateChronicleV2EvidenceDocumentBindings,
  validateChronicleV2SourceDocumentBindings,
  type ChronicleV2SourceDocumentBinding,
  type ChronicleV2TemporalEvaluation,
} from "./chronicleV2Temporal";
import type {
  PreparedProductionChronicleEvalCase,
  ProductionChronicleArtifacts,
} from "./productionChronicleTypes";

export const CHRONICLE_V2_EVALUATOR_VERSION =
  "chronicle-evaluation-v2-evaluator/4" as const;

export const CHRONICLE_V2_DIMENSIONS = [
  "predicate",
  "participants",
  "roles",
  "actuality",
  "attribution",
  "narrativeFrame",
] as const;

export type ChronicleV2Dimension = (typeof CHRONICLE_V2_DIMENSIONS)[number];

export type ChronicleV2DimensionStatus =
  | "scored"
  | "unobservable"
  | "not-scored";

export interface ChronicleV2DimensionScore {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly unobservable: number;
  /** Number of actual/Gold pairs for which this dimension was compared. */
  readonly pairedComparisonDenominator: number;
  /** No Gold/actual pair is reported as not-scored, never as a dimension FP/FN. */
  readonly status: ChronicleV2DimensionStatus;
}

export interface ChronicleV2EvidenceValidation {
  readonly actualRef: string;
  readonly valid: boolean;
  readonly resolvedCount: number;
  readonly invalidCount: number;
  readonly reason?:
    | "empty-evidence"
    | "binding-mismatch"
    | "resolver-failed"
    | "anchor-mismatch";
  readonly ranges: readonly ChronicleV2ResolvedActualEvidence[];
}

export interface ChronicleV2ResolvedActualEvidence {
  readonly sourceRef: string;
  readonly documentId: string;
  readonly start: number;
  readonly end: number;
}

export interface ChronicleV2ObservationEvaluation {
  readonly passed: boolean;
  readonly goldCount: number;
  readonly actualCount: number;
  readonly matchedCount: number;
  readonly mismatchCount: number;
  readonly missingCount: number;
  readonly missingCountLowerBound: number;
  readonly unknownMatchCapacity: number;
  /** Exhaustive-only lower bound for actual rows beyond atomic Gold cardinality. */
  readonly cardinalityExcessLowerBound: number;
  readonly extraCount: number;
  readonly duplicateCount: number;
  readonly unscoredCount: number;
  readonly unobservableCount: number;
  readonly undeterminedGoldCount: number;
  readonly goldJudgedCount: number;
  readonly actualJudgedCount: number;
  readonly judgedCount: number;
  readonly denominator: number;
}

export interface ChronicleV2ProposalEvaluation {
  readonly mode: "unscored" | "scored";
  readonly status: "unscored" | "pass" | "fail" | "undetermined";
  readonly passed: boolean;
  readonly eligibleGoldCount: number;
  readonly proposedCorrectCount: number;
  readonly proposedIncorrectCount: number;
  readonly suppressedCorrectCount: number;
  readonly suppressedIncorrectCount: number;
  readonly unobservableCount: number;
  readonly judgedCount: number;
  readonly denominator: number;
}

export interface ChronicleV2ClusteringEvaluation {
  readonly status: "not-scored";
  readonly clusterCount: number;
  readonly hypothesisCount: number;
}

export interface ChronicleV2ProductionEvaluation {
  readonly version: typeof CHRONICLE_V2_EVALUATOR_VERSION;
  readonly caseId: string;
  readonly rawActualClaims: readonly ChronicleV2RawActualClaim[];
  readonly normalizedActualClaims: readonly ChronicleV2NormalizedActualClaim[];
  readonly evidence: readonly ChronicleV2EvidenceValidation[];
  readonly evidenceCandidates: readonly ChronicleV2EvidenceCandidate[];
  /** Explicit source-authored to prepared-runtime document identity map. */
  readonly sourceDocumentBindings: readonly ChronicleV2SourceDocumentBinding[];
  readonly alignment: ChronicleV2AlignmentResult;
  readonly temporal: ChronicleV2TemporalEvaluation;
  readonly observation: ChronicleV2ObservationEvaluation;
  readonly proposal: ChronicleV2ProposalEvaluation;
  readonly clustering: ChronicleV2ClusteringEvaluation;
  readonly dimensions: Readonly<
    Record<ChronicleV2Dimension, ChronicleV2DimensionScore>
  >;
  readonly semanticStatus: "PASS" | "FAIL" | "UNDETERMINED";
  readonly evaluationScope: ChronicleV2EvaluationScope;
  readonly observationPassed: boolean;
  readonly proposalPassed: boolean;
  readonly semanticPassed: boolean;
  /** Draft Gold is never promoted to formal acceptance. */
  readonly accepted: boolean;
  readonly authorshipReady: boolean;
}

interface PreparedDocumentMatch {
  readonly documentId: string;
  readonly sourceRef: string;
  readonly text: string;
}

type GoldRange = ChronicleV2EvidenceRegion;

interface GoldRanges {
  readonly requiredDirect: ReadonlyMap<string, readonly GoldRange[]>;
  readonly allowedContext: ReadonlyMap<string, readonly GoldRange[]>;
}

interface ActualEvidenceResult {
  readonly validation: ChronicleV2EvidenceValidation;
  readonly anchors: readonly ResolvedEvidenceAnchor[];
}

interface ValidatedBindingContext {
  readonly binding: EvidenceSpanCatalogBinding;
  readonly resolveSelectedRefs: EvidenceSpanCatalogSelectionResolver;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function emptyDimensionScore(): ChronicleV2DimensionScore {
  return {
    truePositive: 0,
    falsePositive: 0,
    falseNegative: 0,
    unobservable: 0,
    pairedComparisonDenominator: 0,
    status: "not-scored",
  };
}

function emptyDimensions(): Record<
  ChronicleV2Dimension,
  ChronicleV2DimensionScore
> {
  return Object.fromEntries(
    CHRONICLE_V2_DIMENSIONS.map((dimension) => [
      dimension,
      emptyDimensionScore(),
    ]),
  ) as Record<ChronicleV2Dimension, ChronicleV2DimensionScore>;
}

function incrementDimension(
  dimensions: Record<ChronicleV2Dimension, ChronicleV2DimensionScore>,
  dimension: ChronicleV2Dimension,
  key: "truePositive" | "falsePositive" | "falseNegative" | "unobservable",
): void {
  const current = dimensions[dimension];
  dimensions[dimension] = {
    ...current,
    [key]: current[key] + 1,
  };
}

function incrementPairedComparison(
  dimensions: Record<ChronicleV2Dimension, ChronicleV2DimensionScore>,
  dimension: ChronicleV2Dimension,
): void {
  const current = dimensions[dimension];
  dimensions[dimension] = {
    ...current,
    pairedComparisonDenominator: current.pairedComparisonDenominator + 1,
  };
}

function finalizeDimensionStatuses(
  dimensions: Record<ChronicleV2Dimension, ChronicleV2DimensionScore>,
): Record<ChronicleV2Dimension, ChronicleV2DimensionScore> {
  return Object.fromEntries(
    CHRONICLE_V2_DIMENSIONS.map((dimension) => {
      const score = dimensions[dimension];
      const status: ChronicleV2DimensionStatus =
        score.pairedComparisonDenominator > 0
          ? "scored"
          : score.unobservable > 0
            ? "unobservable"
            : "not-scored";
      return [dimension, { ...score, status }];
    }),
  ) as Record<ChronicleV2Dimension, ChronicleV2DimensionScore>;
}

function hasOverlap(left: GoldRange, right: GoldRange): boolean {
  return (
    left.documentId === right.documentId &&
    left.start < right.end &&
    right.start < left.end
  );
}

function documentMatches(
  prepared: PreparedProductionChronicleEvalCase,
  contract: ChronicleV2Contract,
): ReadonlyMap<string, PreparedDocumentMatch> {
  const result = new Map<string, PreparedDocumentMatch>();
  for (const source of contract.sourceDocuments) {
    const matches = prepared.evalCase.documents.filter(
      (document) =>
        document.title === source.title && document.text === source.text,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Chronicle v2 source document does not map uniquely: ${source.id}`,
      );
    }
    const document = matches[0];
    if (!document)
      throw new Error(`Chronicle v2 source document missing: ${source.id}`);
    const sourceRef = prepared.sourceViews.find(
      (view) => prepared.documentIdBySourceRef.get(view.ref) === document.id,
    )?.ref;
    if (!sourceRef) {
      throw new Error(
        `Chronicle v2 source document has no production Source View: ${document.id}`,
      );
    }
    result.set(source.id, {
      documentId: document.id,
      sourceRef,
      text: document.text,
    });
  }
  return result;
}

function sourceDocumentBindingsFor(
  preparedCase: PreparedProductionChronicleEvalCase,
  preparedMatches: ReadonlyMap<string, PreparedDocumentMatch>,
  contract: ChronicleV2Contract,
): readonly ChronicleV2SourceDocumentBinding[] {
  const bindings = contract.sourceDocuments.map((document) => {
    const preparedMatch = preparedMatches.get(document.id);
    if (!preparedMatch) {
      throw new Error(
        `Chronicle v2 source document match is missing: ${document.id}`,
      );
    }
    return {
      contractDocumentId: document.id,
      preparedDocumentId: preparedMatch.documentId,
      sourceRef: preparedMatch.sourceRef,
      evidenceSourceRefs: [...preparedCase.documentIdBySourceRef.entries()]
        .filter(([, documentId]) => documentId === preparedMatch.documentId)
        .map(([sourceRef]) => sourceRef),
    } satisfies ChronicleV2SourceDocumentBinding;
  });
  return validateChronicleV2SourceDocumentBindings(
    bindings,
    contract.sourceDocuments,
  );
}

function rawActualFromObservation(
  observation: RawChronicleEventObservation,
): ChronicleV2RawActualClaim {
  return {
    id: observation.localId,
    predicate: observation.payload.predicate,
    participants: observation.payload.participants.map((participant) => ({
      entity: participant.surface,
      role: participant.role,
    })),
    actuality: observation.payload.actuality,
    attribution: observation.assertion.attribution,
    narrativeFrame: observation.assertion.narrativeFrame,
    evidenceRefs: observation.evidence.map((evidence) => evidence.sourceRef),
  };
}

function observationWindowId(localId: string): string | undefined {
  const match = /^eval-window-(\d+):/.exec(localId);
  return match?.[1] ? `window-${match[1]}` : undefined;
}

async function validatedBindingContexts(
  prepared: PreparedProductionChronicleEvalCase,
): Promise<ReadonlyMap<string, ValidatedBindingContext>> {
  const bindings = prepared.evidenceSpanCatalogBindingsByWindowId;
  if (!bindings || bindings.size === 0) {
    throw new Error(
      "Chronicle v2 production evaluation requires per-window citation bindings",
    );
  }
  const contexts = new Map<string, ValidatedBindingContext>();
  for (const [windowId, binding] of bindings) {
    const captured = await validateCitationIdBinding(binding);
    if (
      captured.windows.length !== 1 ||
      captured.windows[0]?.windowId !== windowId
    ) {
      throw new Error(
        `Chronicle v2 citation binding does not match its production window: ${windowId}`,
      );
    }
    contexts.set(windowId, {
      binding: captured,
      resolveSelectedRefs:
        await createEvidenceSpanCatalogSelectionResolver(captured),
    });
  }
  return contexts;
}

function sameRange(
  left: { readonly start: number; readonly end: number },
  right: { readonly start: number; readonly end: number },
): boolean {
  return left.start === right.start && left.end === right.end;
}

function sameAnchorIdentity(
  expected: ResolvedEvidenceAnchor,
  actual: ResolvedEvidenceAnchor,
): boolean {
  return (
    actual.sourceRef === expected.sourceRef &&
    actual.documentRef === expected.documentRef &&
    actual.quote === expected.quote &&
    sameRange(actual.canonicalRange, expected.canonicalRange) &&
    sameRange(actual.sourceRange, expected.sourceRange) &&
    actual.quoteDigest === expected.quoteDigest &&
    actual.snapshotDigest === expected.snapshotDigest &&
    actual.contentDigest === expected.contentDigest &&
    actual.documentDigest === expected.documentDigest &&
    actual.documentArtifactDigest === expected.documentArtifactDigest &&
    actual.sourceDigest === expected.sourceDigest
  );
}

function artifactAnchorFor(
  artifacts: ProductionChronicleArtifacts,
  expected: ResolvedEvidenceAnchor,
): ResolvedEvidenceAnchor | undefined {
  const sameOccurrence = (anchor: ResolvedEvidenceAnchor): boolean =>
    anchor.sourceRef === expected.sourceRef &&
    anchor.quote === expected.quote &&
    sameRange(anchor.canonicalRange, expected.canonicalRange);
  const related = artifacts.anchors.filter(sameOccurrence);
  if (related.length === 0) return undefined;
  // Every artifact anchor for one canonical occurrence must retain the
  // resolver's complete digest identity. Do not let a duplicate clean anchor
  // hide a stale or tampered sibling for the same production evidence.
  if (related.some((anchor) => !sameAnchorIdentity(expected, anchor))) {
    return undefined;
  }
  return related[0];
}

function bindingAliasFor(
  context: ValidatedBindingContext | undefined,
  observation: RawChronicleEventObservation,
  sourceRef: string,
): string | undefined {
  if (!context) return;
  const windowId = observationWindowId(observation.localId);
  const boundWindowId = context.binding.windows[0]?.windowId;
  if (windowId && boundWindowId !== windowId) return;
  return context.binding.aliases
    .filter(
      (alias) =>
        alias.canonicalSourceRef === sourceRef &&
        (!windowId || alias.windowIds.includes(windowId)) &&
        (!boundWindowId || alias.windowIds.includes(boundWindowId)),
    )
    .map((alias) => alias.alias)
    .sort(compareStrings)[0];
}

async function resolveActualEvidence(
  prepared: PreparedProductionChronicleEvalCase,
  observation: RawChronicleEventObservation,
  artifacts: ProductionChronicleArtifacts,
  contexts: ReadonlyMap<string, ValidatedBindingContext>,
): Promise<ActualEvidenceResult> {
  if (observation.evidence.length === 0) {
    return {
      validation: {
        actualRef: observation.localId,
        valid: false,
        resolvedCount: 0,
        invalidCount: 1,
        reason: "empty-evidence",
        ranges: [],
      },
      anchors: [],
    };
  }
  const ranges: ChronicleV2ResolvedActualEvidence[] = [];
  const anchors: ResolvedEvidenceAnchor[] = [];
  let invalidCount = 0;
  let reason: ChronicleV2EvidenceValidation["reason"];
  const context = (() => {
    const windowId = observationWindowId(observation.localId);
    if (windowId) return contexts.get(windowId);
    return contexts.size === 1 ? [...contexts.values()][0] : undefined;
  })();
  for (const evidence of observation.evidence) {
    const alias = bindingAliasFor(context, observation, evidence.sourceRef);
    if (!context || !alias) {
      invalidCount += 1;
      reason ??= "binding-mismatch";
      continue;
    }
    let selected: Awaited<ReturnType<EvidenceSpanCatalogSelectionResolver>>;
    try {
      selected = await context.resolveSelectedRefs([alias]);
    } catch {
      invalidCount += 1;
      reason ??= "binding-mismatch";
      continue;
    }
    const resolvedEvidence = selected.rawEvidenceReferences[0];
    const resolutionAnchor = selected.anchors[0];
    if (
      !resolvedEvidence ||
      !resolutionAnchor ||
      resolvedEvidence.sourceRef !== evidence.sourceRef ||
      resolvedEvidence.quote !== evidence.quote
    ) {
      invalidCount += 1;
      reason ??= "anchor-mismatch";
      continue;
    }
    const artifactAnchor = artifactAnchorFor(artifacts, resolutionAnchor);
    if (!artifactAnchor) {
      invalidCount += 1;
      reason ??= "anchor-mismatch";
      continue;
    }
    anchors.push(resolutionAnchor);
    const documentId = prepared.documentIdBySourceRef.get(evidence.sourceRef);
    if (!documentId) {
      invalidCount += 1;
      reason ??= "resolver-failed";
      continue;
    }
    ranges.push({
      sourceRef: evidence.sourceRef,
      documentId,
      start: resolutionAnchor.canonicalRange.start,
      end: resolutionAnchor.canonicalRange.end,
    });
  }
  return {
    validation: {
      actualRef: observation.localId,
      valid: invalidCount === 0 && ranges.length > 0,
      resolvedCount: ranges.length,
      invalidCount,
      ...(reason ? { reason } : {}),
      ranges,
    },
    anchors,
  };
}

function goldRanges(
  contract: ChronicleV2Contract,
  preparedMatches: ReadonlyMap<string, PreparedDocumentMatch>,
): GoldRanges {
  const requiredDirect = new Map<string, readonly GoldRange[]>();
  const allowedContext = new Map<string, readonly GoldRange[]>();
  for (const claim of contract.observationGold.claims) {
    const resolveRegions = (
      regions: ChronicleV2GoldClaim["requiredDirectRegions"],
    ): readonly GoldRange[] => {
      const ranges: GoldRange[] = [];
      for (const region of regions) {
        const source = preparedMatches.get(region.documentId);
        if (!source)
          throw new Error(
            `Chronicle v2 Gold document is unmapped: ${region.documentId}`,
          );
        if (
          region.start < 0 ||
          region.end <= region.start ||
          region.end > source.text.length
        ) {
          throw new Error(
            `Chronicle v2 Gold evidence region is outside the source: ${claim.id}`,
          );
        }
        ranges.push({
          documentId: source.documentId,
          start: region.start,
          end: region.end,
        });
      }
      return ranges;
    };
    requiredDirect.set(claim.id, resolveRegions(claim.requiredDirectRegions));
    allowedContext.set(claim.id, resolveRegions(claim.allowedContextRegions));
  }
  return { requiredDirect, allowedContext };
}

function coversRange(covering: GoldRange, target: GoldRange): boolean {
  return (
    covering.documentId === target.documentId &&
    covering.start <= target.start &&
    covering.end >= target.end
  );
}

/** Check interval coverage rather than accepting a small overlap at a gap. */
export function chronicleV2CoversAllRanges(
  coveringRanges: readonly GoldRange[],
  requiredRanges: readonly GoldRange[],
): boolean {
  return requiredRanges.every((required) => {
    let cursor = required.start;
    const covering = coveringRanges
      .filter(
        (candidate) =>
          candidate.documentId === required.documentId &&
          candidate.end > required.start &&
          candidate.start < required.end,
      )
      .sort((left, right) => left.start - right.start || left.end - right.end);
    for (const candidate of covering) {
      if (candidate.start > cursor) break;
      if (coversRange(candidate, required)) {
        cursor = required.end;
        break;
      }
      cursor = Math.max(cursor, candidate.end);
      if (cursor >= required.end) break;
    }
    return cursor >= required.end;
  });
}

function contextSupportForObservation(
  prepared: PreparedProductionChronicleEvalCase,
  observation: RawChronicleEventObservation,
  allowedContextRanges: readonly GoldRange[],
  contexts: ReadonlyMap<string, ValidatedBindingContext>,
): boolean {
  if (allowedContextRanges.length === 0) return true;
  const windowId = observationWindowId(observation.localId);
  const context = windowId
    ? contexts.get(windowId)
    : contexts.size === 1
      ? [...contexts.values()][0]
      : undefined;
  const window = context?.binding.windows.find(
    (candidate) => !windowId || candidate.windowId === windowId,
  );
  if (!window) return false;
  const sourceKey = prepared.documentIdBySourceRef.get(window.sourceView.ref);
  if (!sourceKey) return false;
  const visibleRange: GoldRange = {
    documentId: sourceKey,
    start: window.sourceView.documentRange.start,
    end: window.sourceView.documentRange.end,
  };
  return allowedContextRanges.every(
    (region) =>
      region.documentId === sourceKey && coversRange(visibleRange, region),
  );
}

function buildEvidenceCandidates(
  prepared: PreparedProductionChronicleEvalCase,
  claims: readonly ChronicleV2GoldClaim[],
  observations: readonly RawChronicleEventObservation[],
  evidence: readonly ActualEvidenceResult[],
  rangesByGoldId: GoldRanges,
  contexts: ReadonlyMap<string, ValidatedBindingContext>,
): readonly ChronicleV2EvidenceCandidate[] {
  const result: ChronicleV2EvidenceCandidate[] = [];
  for (const [index, observation] of observations.entries()) {
    const actualEvidence = evidence[index];
    if (!actualEvidence) continue;
    for (const claim of claims) {
      const requiredDirectRanges =
        rangesByGoldId.requiredDirect.get(claim.id) ?? [];
      const allowedContextRanges =
        rangesByGoldId.allowedContext.get(claim.id) ?? [];
      const overlap =
        actualEvidence.validation.valid &&
        actualEvidence.validation.ranges.some((actualRange) =>
          requiredDirectRanges.some((goldRange) =>
            hasOverlap(
              {
                documentId: actualRange.documentId,
                start: actualRange.start,
                end: actualRange.end,
              },
              goldRange,
            ),
          ),
        );
      const directSupport =
        actualEvidence.validation.valid &&
        chronicleV2CoversAllRanges(
          actualEvidence.validation.ranges.map((range) => ({
            documentId: range.documentId,
            start: range.start,
            end: range.end,
          })),
          requiredDirectRanges,
        );
      const contextSupport = contextSupportForObservation(
        prepared,
        observation,
        allowedContextRanges,
        contexts,
      );
      result.push({
        actualRef: observation.localId,
        goldRef: claim.id,
        evidenceValid: actualEvidence.validation.valid,
        overlap,
        directSupport,
        contextSupport,
      });
    }
  }
  return result;
}

function dimensionObservable(
  actual: ChronicleV2NormalizedActualClaim,
  dimension: ChronicleV2Dimension,
): boolean {
  switch (dimension) {
    case "predicate":
      return actual.predicate.status === "known";
    case "participants":
      return actual.participants.every(
        (participant) => participant.entity.status === "known",
      );
    case "roles":
      return actual.participants.every(
        (participant) =>
          participant.entity.status === "known" &&
          participant.role.status === "known",
      );
    case "actuality":
      return actual.actuality.status === "known";
    case "attribution":
      return actual.attribution.status === "known";
    case "narrativeFrame":
      return actual.narrativeFrame.status === "known";
  }
}

function scoreDimensions(
  contract: ChronicleV2Contract,
  normalizedActualClaims: readonly ChronicleV2NormalizedActualClaim[],
  alignment: ChronicleV2AlignmentResult,
): Record<ChronicleV2Dimension, ChronicleV2DimensionScore> {
  const dimensions = emptyDimensions();
  const goldById = new Map(
    contract.observationGold.claims.map((claim) => [claim.id, claim] as const),
  );
  const actualByRef = new Map(
    normalizedActualClaims.map((actual) => [actual.actualRef, actual] as const),
  );
  for (const assignment of alignment.assignments) {
    const actual = actualByRef.get(assignment.actualRef);
    if (!actual) continue;
    const gold = assignment.goldRef
      ? goldById.get(assignment.goldRef)
      : undefined;
    // Unknown values are scored per field. A known predicate or entity still
    // contributes to its dimension even when attribution/role/etc. is
    // unobservable; one unknown field must not erase independent evidence.
    // A duplicate, an extra actual, or an evidence failure has no
    // one-to-one semantic pair. Those cases are scored by the observation
    // and evidence ledgers; treating them as six independent dimension FPs
    // would recreate the v1 cascade.
    if (!gold) {
      for (const dimension of CHRONICLE_V2_DIMENSIONS) {
        if (!dimensionObservable(actual, dimension)) {
          incrementDimension(dimensions, dimension, "unobservable");
        }
      }
      continue;
    }
    if (
      assignment.reason === "evidence-no-candidate" ||
      assignment.reason === "evidence-invalid" ||
      assignment.reason === "duplicate-claim"
    ) {
      for (const dimension of CHRONICLE_V2_DIMENSIONS) {
        if (!dimensionObservable(actual, dimension)) {
          incrementDimension(dimensions, dimension, "unobservable");
        }
      }
      continue;
    }
    const comparison = compareChronicleV2Claim(actual, gold);
    for (const dimension of CHRONICLE_V2_DIMENSIONS) {
      const fieldComparison = comparison.dimensions[dimension];
      if (!dimensionObservable(actual, dimension)) {
        incrementDimension(dimensions, dimension, "unobservable");
      }
      if (fieldComparison === "unknown") {
        continue;
      } else if (fieldComparison === "equal") {
        incrementPairedComparison(dimensions, dimension);
        incrementDimension(dimensions, dimension, "truePositive");
      } else {
        incrementPairedComparison(dimensions, dimension);
        incrementDimension(dimensions, dimension, "falsePositive");
        incrementDimension(dimensions, dimension, "falseNegative");
      }
    }
  }
  // Missing and uncertain Gold claims have no actual counterpart whose
  // individual dimensions can be compared. They remain visible in the
  // observation ledger, while these dimension rows stay not-scored.
  return finalizeDimensionStatuses(dimensions);
}

function evaluateProposal(
  contract: ChronicleV2Contract,
  alignment: ChronicleV2AlignmentResult,
  artifacts: ProductionChronicleArtifacts,
): ChronicleV2ProposalEvaluation {
  if (contract.proposalPolicy.mode === "unscored") {
    return {
      mode: "unscored",
      status: "unscored",
      // Unscored is a neutral state, never a Proposal pass. Observation and
      // semantic status remain independent of this flag.
      passed: false,
      eligibleGoldCount: 0,
      proposedCorrectCount: 0,
      proposedIncorrectCount: 0,
      suppressedCorrectCount: 0,
      suppressedIncorrectCount: 0,
      unobservableCount: 0,
      judgedCount: 0,
      denominator: 0,
    };
  }
  const proposedHypothesisIds = new Set(
    artifacts.plannedProposals.map((proposal) => proposal.hypothesisId),
  );
  const proposedActualRefs = new Set(
    artifacts.hypotheses
      .filter((hypothesis) =>
        proposedHypothesisIds.has(hypothesis.hypothesisId),
      )
      .flatMap((hypothesis) => hypothesis.observationRefs),
  );
  let proposedCorrectCount = 0;
  let proposedIncorrectCount = 0;
  let suppressedCorrectCount = 0;
  let suppressedIncorrectCount = 0;
  let unobservableCount = 0;
  for (const claimId of contract.proposalPolicy.scoredClaimIds) {
    const assignment = alignment.assignments.find(
      (candidate) =>
        candidate.goldRef === claimId && candidate.status === "match",
    );
    if (!assignment) {
      unobservableCount += 1;
      continue;
    }
    const expected = contract.proposalPolicy.expectedDecisions[claimId];
    const proposed = proposedActualRefs.has(assignment.actualRef);
    if (expected === "propose") {
      if (proposed) proposedCorrectCount += 1;
      else suppressedIncorrectCount += 1;
    } else if (proposed) {
      proposedIncorrectCount += 1;
    } else {
      suppressedCorrectCount += 1;
    }
  }
  const eligibleGoldCount = contract.proposalPolicy.scoredClaimIds.length;
  const judgedCount = eligibleGoldCount - unobservableCount;
  const hasDecisionFailure =
    proposedIncorrectCount > 0 || suppressedIncorrectCount > 0;
  const passed = !hasDecisionFailure && unobservableCount === 0;
  const status = hasDecisionFailure
    ? "fail"
    : unobservableCount > 0
      ? "undetermined"
      : "pass";
  return {
    mode: "scored",
    status,
    passed,
    eligibleGoldCount,
    proposedCorrectCount,
    proposedIncorrectCount,
    suppressedCorrectCount,
    suppressedIncorrectCount,
    unobservableCount,
    judgedCount,
    denominator: eligibleGoldCount,
  };
}

/**
 * Evaluate the materialized production observations under the independent
 * source-authored Chronicle v2 contract. The v1 scorer remains untouched.
 */
export async function evaluateChronicleV2Production(
  prepared: PreparedProductionChronicleEvalCase,
  artifacts: ProductionChronicleArtifacts,
  contract: ChronicleV2Contract,
): Promise<ChronicleV2ProductionEvaluation> {
  if (prepared.evidenceMode !== "citation-id-v2") {
    throw new Error(
      "Chronicle v2 production evaluation requires citation-id-v2 evidence",
    );
  }
  if (
    !contract.authorship.independentSourceAnnotation ||
    contract.authorship.candidateOutputContamination
  ) {
    throw new Error("Chronicle v2 Gold authorship is not independent");
  }
  const preparedMatches = documentMatches(prepared, contract);
  const sourceDocumentBindings = sourceDocumentBindingsFor(
    prepared,
    preparedMatches,
    contract,
  );
  const rangesByGoldId = goldRanges(contract, preparedMatches);
  const bindingContexts = await validatedBindingContexts(prepared);
  const rawActualClaims = artifacts.observations.map(rawActualFromObservation);
  const normalizedActualClaims = rawActualClaims.map(
    normalizeChronicleV2Actual,
  );
  const evidenceResults: ActualEvidenceResult[] = [];
  for (const observation of artifacts.observations) {
    evidenceResults.push(
      await resolveActualEvidence(
        prepared,
        observation,
        artifacts,
        bindingContexts,
      ),
    );
  }
  const evidenceCandidates = buildEvidenceCandidates(
    prepared,
    contract.observationGold.claims,
    artifacts.observations,
    evidenceResults,
    rangesByGoldId,
    bindingContexts,
  );
  const alignmentInput: ChronicleV2AlignmentInput = {
    goldClaims: contract.observationGold.claims,
    normalizedActualClaims,
    evidenceCandidates,
    coverage: contract.coverage,
    proposalPolicy: contract.proposalPolicy,
  };
  const alignment = alignChronicleV2Claims(alignmentInput);
  const evidence = evidenceResults.map((result) => result.validation);
  validateChronicleV2EvidenceDocumentBindings(
    evidence.flatMap((entry) =>
      entry.ranges.map((range) => ({
        sourceRef: range.sourceRef,
        documentId: range.documentId,
      })),
    ),
    sourceDocumentBindings,
  );
  const temporalRawRows = buildChronicleV2TemporalRawRows(
    artifacts.observations,
  );
  const temporal = evaluateChronicleV2Temporal({
    temporalGold: remapChronicleV2TemporalGoldDocumentIds(
      contract.temporalGold,
      sourceDocumentBindings,
      contract.sourceDocuments,
    ),
    rawRows: temporalRawRows,
    exactEventAssignments: alignment.assignments,
    evidenceByActual: evidence.map((entry) => ({
      actualRef: entry.actualRef,
      valid: entry.valid,
      ranges: entry.ranges.map((range) => ({
        documentId: range.documentId,
        start: range.start,
        end: range.end,
      })),
    })),
  });
  const observation: ChronicleV2ObservationEvaluation = {
    passed:
      alignment.passed &&
      alignment.missingCountLowerBound === 0 &&
      alignment.cardinalityExcessLowerBound === 0 &&
      evidence.every((entry) => entry.valid),
    goldCount: contract.observationGold.claims.length,
    actualCount: normalizedActualClaims.length,
    matchedCount: alignment.matchedCount,
    mismatchCount: alignment.mismatchCount,
    missingCount: alignment.missingCount,
    missingCountLowerBound: alignment.missingCountLowerBound,
    unknownMatchCapacity: alignment.unknownMatchCapacity,
    cardinalityExcessLowerBound: alignment.cardinalityExcessLowerBound,
    extraCount: alignment.extraCount,
    duplicateCount: alignment.duplicateCount,
    unscoredCount: alignment.unscoredCount,
    unobservableCount: alignment.unobservableCount,
    undeterminedGoldCount: alignment.undeterminedGoldCount,
    goldJudgedCount:
      contract.observationGold.claims.length - alignment.undeterminedGoldCount,
    actualJudgedCount:
      normalizedActualClaims.length -
      alignment.unobservableCount -
      alignment.unscoredCount,
    judgedCount:
      contract.observationGold.claims.length -
      alignment.undeterminedGoldCount +
      normalizedActualClaims.length -
      alignment.unobservableCount -
      alignment.unscoredCount,
    denominator:
      contract.observationGold.claims.length + normalizedActualClaims.length,
  };
  const proposal = evaluateProposal(contract, alignment, artifacts);
  const clustering: ChronicleV2ClusteringEvaluation = {
    status: "not-scored",
    clusterCount: artifacts.clusters.length,
    hypothesisCount: artifacts.hypotheses.length,
  };
  const dimensions = scoreDimensions(
    contract,
    normalizedActualClaims,
    alignment,
  );
  const hasKnownFailure =
    alignment.mismatchCount > 0 ||
    alignment.extraCount > 0 ||
    alignment.duplicateCount > 0 ||
    alignment.missingCount > 0 ||
    alignment.missingCountLowerBound > 0 ||
    alignment.cardinalityExcessLowerBound > 0 ||
    evidence.some((entry) => !entry.valid) ||
    temporal.status === "FAIL" ||
    proposal.status === "fail";
  const hasUncertainty =
    alignment.unobservableCount > 0 ||
    alignment.undeterminedGoldCount > 0 ||
    alignment.unscoredCount > 0 ||
    temporal.status === "UNDETERMINED" ||
    proposal.status === "undetermined";
  const semanticStatus = hasKnownFailure
    ? "FAIL"
    : hasUncertainty
      ? "UNDETERMINED"
      : "PASS";
  const authorshipReady =
    contract.authorship.status === "draft-for-human-review" &&
    Boolean(contract.authorship.formalCertification);
  return {
    version: CHRONICLE_V2_EVALUATOR_VERSION,
    caseId: contract.caseId,
    rawActualClaims,
    normalizedActualClaims,
    evidence,
    evidenceCandidates,
    sourceDocumentBindings,
    alignment,
    temporal,
    observation,
    proposal,
    clustering,
    dimensions,
    semanticStatus,
    evaluationScope: chronicleV2EvaluationScopeFor(
      contract.proposalPolicy.mode,
    ),
    observationPassed: observation.passed,
    proposalPassed: proposal.passed,
    semanticPassed: semanticStatus === "PASS",
    accepted: semanticStatus === "PASS" && proposal.passed && authorshipReady,
    authorshipReady,
  };
}

export type { ChronicleV2AlignmentReason };
