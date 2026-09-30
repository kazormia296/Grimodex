import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type {
  ChronicleV2EvidenceRegion,
  ChronicleV2SourceDocument,
  ChronicleV2TemporalGold,
} from "./chronicleV2Contract";

/** Version of the independent, symbolic temporal projection. */
export const CHRONICLE_V2_TEMPORAL_VERSION =
  "chronicle-evaluation-v2-temporal/1" as const;

export const CHRONICLE_V2_TEMPORAL_KNOWN_EXPRESSIONS = ["夜半", "朝"] as const;
export type ChronicleV2TemporalKnownExpression =
  (typeof CHRONICLE_V2_TEMPORAL_KNOWN_EXPRESSIONS)[number];

export type ChronicleV2TemporalUnknownReason =
  "temporal-expression-out-of-vocabulary";

export type ChronicleV2TemporalNormalizedExpression =
  | {
      readonly status: "known";
      readonly value: ChronicleV2TemporalKnownExpression;
    }
  | {
      readonly status: "unknown";
      readonly reason: ChronicleV2TemporalUnknownReason;
    };

/** Materialized temporal metadata read from a production Observation. */
export interface ChronicleV2TemporalRawRow {
  readonly actualRef: string;
  readonly expressions: readonly string[];
  readonly evidenceRefs: readonly string[];
}

/** Gold-independent normalized temporal metadata. */
export interface ChronicleV2TemporalNormalizedRow {
  readonly actualRef: string;
  readonly expressions: readonly ChronicleV2TemporalNormalizedExpression[];
  readonly evidenceRefs: readonly string[];
}

export type ChronicleV2TemporalEventAssignmentStatus =
  | "match"
  | "mismatch"
  | "unobservable"
  | "unscored";

/** Event identity is supplied by the already-computed v2 event alignment. */
export interface ChronicleV2TemporalEventAssignment {
  readonly actualRef: string;
  readonly goldRef: string | null;
  readonly status: ChronicleV2TemporalEventAssignmentStatus;
}

export interface ChronicleV2TemporalEvidenceRange {
  readonly documentId: string;
  readonly start: number;
  readonly end: number;
}

/** Verified canonical evidence for one materialized actual row. */
export interface ChronicleV2TemporalEvidence {
  readonly actualRef: string;
  readonly valid: boolean;
  readonly ranges: readonly ChronicleV2TemporalEvidenceRange[];
}

/**
 * Ephemeral binding from source-authored document IDs to the IDs used by the
 * prepared production evaluation. The evaluator derives this from the
 * verified source document match; it is never inferred from a missing entry.
 */
export interface ChronicleV2SourceDocumentBinding {
  readonly contractDocumentId: string;
  readonly preparedDocumentId: string;
  readonly sourceRef: string;
  /** All verified Source View and citation refs owned by this document. */
  readonly evidenceSourceRefs: readonly string[];
}

/** Minimal evidence identity used to check a resolved range against bindings. */
export interface ChronicleV2EvidenceDocumentBindingReference {
  readonly sourceRef: string;
  readonly documentId: string;
}

export type ChronicleV2TemporalRelationResult =
  | "matched"
  | "missing"
  | "invalid-evidence"
  | "unobservable";

export type ChronicleV2TemporalRelationReason =
  | "event-identity-unavailable"
  | "temporal-evidence-invalid"
  | "temporal-expression-unknown";

/** Ephemeral per-relation projection. Diagnostics stores only its numeric view. */
export interface ChronicleV2TemporalRelationRow {
  readonly relationId: string;
  readonly targetClaimId: string;
  readonly actualRef: string | null;
  readonly metadataStatus: "known" | "missing" | "unknown";
  readonly result: ChronicleV2TemporalRelationResult;
  readonly evidenceSupported: boolean;
  readonly reason?: ChronicleV2TemporalRelationReason;
}

export type ChronicleV2TemporalStatus = "PASS" | "FAIL" | "UNDETERMINED";

export interface ChronicleV2TemporalEvaluation {
  readonly version: typeof CHRONICLE_V2_TEMPORAL_VERSION;
  /** Ephemeral materialized input; never copied into numeric diagnostics. */
  readonly rawRows: readonly ChronicleV2TemporalRawRow[];
  /** Gold-independent normalization of the materialized input. */
  readonly normalizedRows: readonly ChronicleV2TemporalNormalizedRow[];
  /** Ephemeral relation details used to derive the numeric projection. */
  readonly relationRows: readonly ChronicleV2TemporalRelationRow[];
  readonly requiredRelationCount: number;
  readonly matchedCount: number;
  readonly missingCount: number;
  readonly invalidEvidenceCount: number;
  readonly unobservableCount: number;
  readonly blockedByEventIdentityCount: number;
  readonly unscoredGoldCount: number;
  readonly judgedCount: number;
  readonly denominator: number;
  readonly status: ChronicleV2TemporalStatus;
  readonly passed: boolean;
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareSourceDocumentBindings(
  left: ChronicleV2SourceDocumentBinding,
  right: ChronicleV2SourceDocumentBinding,
): number {
  return (
    compareStrings(left.contractDocumentId, right.contractDocumentId) ||
    compareStrings(left.preparedDocumentId, right.preparedDocumentId) ||
    compareStrings(left.sourceRef, right.sourceRef)
  );
}

function assertNonEmptyBindingField(value: string, label: string): void {
  if (value.trim().length === 0 || value !== value.trim()) {
    throw new Error(
      `Chronicle v2 source document binding ${label} must be a non-empty trimmed string`,
    );
  }
}

/**
 * Validate and canonicalize the explicit source-to-prepared document map.
 * Every source document must be represented exactly once, while prepared IDs
 * and source refs must remain one-to-one. A missing map entry is an error;
 * callers must never fall back to treating the two ID namespaces as equal.
 */
export function validateChronicleV2SourceDocumentBindings(
  bindings: readonly ChronicleV2SourceDocumentBinding[],
  sourceDocuments: readonly Pick<ChronicleV2SourceDocument, "id">[],
): readonly ChronicleV2SourceDocumentBinding[] {
  const sourceIds = sourceDocuments.map((document) => document.id);
  assertUniqueIds(sourceIds, "contract source document");
  const contractIds = new Set(sourceIds);
  const seenContractIds = new Set<string>();
  const seenPreparedIds = new Set<string>();
  const seenSourceRefs = new Set<string>();
  const seenEvidenceSourceRefs = new Set<string>();
  for (const binding of bindings) {
    assertNonEmptyBindingField(
      binding.contractDocumentId,
      "contractDocumentId",
    );
    assertNonEmptyBindingField(
      binding.preparedDocumentId,
      "preparedDocumentId",
    );
    assertNonEmptyBindingField(binding.sourceRef, "sourceRef");
    if (binding.evidenceSourceRefs.length === 0) {
      throw new Error(
        `Chronicle v2 source document binding requires evidence source refs: ${binding.contractDocumentId}`,
      );
    }
    if (!contractIds.has(binding.contractDocumentId)) {
      throw new Error(
        `Chronicle v2 source document binding references an unknown contract document: ${binding.contractDocumentId}`,
      );
    }
    if (seenContractIds.has(binding.contractDocumentId)) {
      throw new Error(
        `Chronicle v2 source document binding repeats contract document: ${binding.contractDocumentId}`,
      );
    }
    if (seenPreparedIds.has(binding.preparedDocumentId)) {
      throw new Error(
        `Chronicle v2 source document binding repeats prepared document: ${binding.preparedDocumentId}`,
      );
    }
    if (seenSourceRefs.has(binding.sourceRef)) {
      throw new Error(
        `Chronicle v2 source document binding repeats source ref: ${binding.sourceRef}`,
      );
    }
    const localEvidenceRefs = new Set<string>();
    for (const evidenceSourceRef of binding.evidenceSourceRefs) {
      assertNonEmptyBindingField(evidenceSourceRef, "evidenceSourceRef");
      if (localEvidenceRefs.has(evidenceSourceRef)) {
        throw new Error(
          `Chronicle v2 source document binding repeats evidence source ref: ${evidenceSourceRef}`,
        );
      }
      if (seenEvidenceSourceRefs.has(evidenceSourceRef)) {
        throw new Error(
          `Chronicle v2 source document binding repeats evidence source ref globally: ${evidenceSourceRef}`,
        );
      }
      localEvidenceRefs.add(evidenceSourceRef);
      seenEvidenceSourceRefs.add(evidenceSourceRef);
    }
    if (!localEvidenceRefs.has(binding.sourceRef)) {
      throw new Error(
        `Chronicle v2 source document binding source ref is absent from evidence refs: ${binding.sourceRef}`,
      );
    }
    seenContractIds.add(binding.contractDocumentId);
    seenPreparedIds.add(binding.preparedDocumentId);
    seenSourceRefs.add(binding.sourceRef);
  }
  if (seenContractIds.size !== contractIds.size) {
    const missing = sourceIds.find((id) => !seenContractIds.has(id));
    throw new Error(
      `Chronicle v2 source document binding is missing contract document: ${missing ?? "unknown"}`,
    );
  }
  return [...bindings].sort(compareSourceDocumentBindings).map((binding) => ({
    ...binding,
    evidenceSourceRefs: [...binding.evidenceSourceRefs].sort(compareStrings),
  }));
}

/**
 * Remap source-authored temporal Gold regions into the prepared document ID
 * namespace using an already validated explicit binding.
 */
export function remapChronicleV2TemporalGoldDocumentIds(
  temporalGold: ChronicleV2TemporalGold,
  bindings: readonly ChronicleV2SourceDocumentBinding[],
  sourceDocuments: readonly Pick<ChronicleV2SourceDocument, "id">[],
): ChronicleV2TemporalGold {
  const canonicalBindings = validateChronicleV2SourceDocumentBindings(
    bindings,
    sourceDocuments,
  );
  const preparedByContractId = new Map(
    canonicalBindings.map(
      (binding) =>
        [binding.contractDocumentId, binding.preparedDocumentId] as const,
    ),
  );
  return {
    ...temporalGold,
    relations: temporalGold.relations.map((relation) => {
      const preparedDocumentId = preparedByContractId.get(
        relation.requiredRegion.documentId,
      );
      if (!preparedDocumentId) {
        throw new Error(
          `Chronicle v2 temporal Gold document is unmapped: ${relation.requiredRegion.documentId}`,
        );
      }
      return {
        ...relation,
        requiredRegion: {
          ...relation.requiredRegion,
          documentId: preparedDocumentId,
        },
      };
    }),
  };
}

/**
 * Ensure every resolved evidence range stays in the prepared document
 * namespace selected by its canonical source ref. This is deliberately a
 * consistency check only; it does not turn an unbound reference into a
 * valid one.
 */
export function validateChronicleV2EvidenceDocumentBindings(
  references: readonly ChronicleV2EvidenceDocumentBindingReference[],
  bindings: readonly ChronicleV2SourceDocumentBinding[],
): void {
  const preparedByEvidenceSourceRef = new Map<string, string>();
  const preparedBySourceViewRef = new Map<string, string>();
  for (const binding of bindings) {
    preparedBySourceViewRef.set(binding.sourceRef, binding.preparedDocumentId);
    for (const sourceRef of binding.evidenceSourceRefs) {
      preparedByEvidenceSourceRef.set(sourceRef, binding.preparedDocumentId);
    }
  }
  for (const reference of references) {
    assertNonEmptyBindingField(reference.sourceRef, "evidence sourceRef");
    assertNonEmptyBindingField(reference.documentId, "evidence documentId");
    const expectedDocumentId =
      preparedByEvidenceSourceRef.get(reference.sourceRef) ??
      preparedBySourceViewRef.get(reference.sourceRef);
    if (!expectedDocumentId) {
      throw new Error(
        `Chronicle v2 evidence source ref is not bound: ${reference.sourceRef}`,
      );
    }
    if (reference.documentId !== expectedDocumentId) {
      throw new Error(
        `Chronicle v2 evidence document binding disagrees for ${reference.sourceRef}`,
      );
    }
  }
}

function assertUniqueIds(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (value.trim().length === 0 || seen.has(value)) {
      throw new Error(`Chronicle v2 temporal ${label} IDs must be unique`);
    }
    seen.add(value);
  }
}

function knownExpression(
  value: string,
): ChronicleV2TemporalKnownExpression | undefined {
  return (
    CHRONICLE_V2_TEMPORAL_KNOWN_EXPRESSIONS as readonly string[]
  ).includes(value)
    ? (value as ChronicleV2TemporalKnownExpression)
    : undefined;
}

export function buildChronicleV2TemporalRawRows(
  observations: readonly RawChronicleEventObservation[],
): readonly ChronicleV2TemporalRawRow[] {
  const rows = observations.map((observation) => ({
    actualRef: observation.localId,
    expressions: [...observation.payload.temporalExpressions],
    evidenceRefs: observation.evidence.map((evidence) => evidence.sourceRef),
  }));
  assertUniqueIds(
    rows.map((row) => row.actualRef),
    "actual temporal row",
  );
  return rows;
}

export function normalizeChronicleV2TemporalRows(
  rows: readonly ChronicleV2TemporalRawRow[],
): readonly ChronicleV2TemporalNormalizedRow[] {
  assertUniqueIds(
    rows.map((row) => row.actualRef),
    "actual temporal row",
  );
  return rows.map((row) => ({
    actualRef: row.actualRef,
    expressions: row.expressions.map((expression) => {
      const known = knownExpression(expression);
      return known
        ? { status: "known", value: known }
        : {
            status: "unknown",
            reason: "temporal-expression-out-of-vocabulary",
          };
    }),
    evidenceRefs: [...row.evidenceRefs],
  }));
}

function coversRange(
  covering: ChronicleV2TemporalEvidenceRange,
  target: ChronicleV2EvidenceRegion,
): boolean {
  return (
    covering.documentId === target.documentId &&
    covering.start <= target.start &&
    covering.end >= target.end
  );
}

/**
 * Check that a union of one actual's verified canonical ranges covers a Gold
 * temporal span. Adjacent or overlapping ranges may form the cover.
 */
export function chronicleV2TemporalCoversRange(
  ranges: readonly ChronicleV2TemporalEvidenceRange[],
  target: ChronicleV2EvidenceRegion,
): boolean {
  if (target.end <= target.start) return false;
  let cursor = target.start;
  const candidates = ranges
    .filter(
      (range) =>
        range.documentId === target.documentId &&
        range.end > target.start &&
        range.start < target.end,
    )
    .sort((left, right) => left.start - right.start || left.end - right.end);
  for (const candidate of candidates) {
    if (candidate.start > cursor) return false;
    if (coversRange(candidate, target)) return true;
    cursor = Math.max(cursor, candidate.end);
    if (cursor >= target.end) return true;
  }
  return cursor >= target.end;
}

function statusForExpressions(
  expressions: readonly ChronicleV2TemporalNormalizedExpression[],
): "known" | "missing" | "unknown" {
  if (expressions.some((expression) => expression.status === "unknown")) {
    return expressions.some((expression) => expression.status === "known")
      ? "known"
      : "unknown";
  }
  return expressions.length > 0 ? "known" : "missing";
}

function temporalStatus(
  invalidEvidenceCount: number,
  missingCount: number,
  unobservableCount: number,
): ChronicleV2TemporalStatus {
  if (invalidEvidenceCount > 0 || missingCount > 0) return "FAIL";
  if (unobservableCount > 0) return "UNDETERMINED";
  return "PASS";
}

function assertTemporalGold(gold: ChronicleV2TemporalGold): void {
  if (gold.coverage !== "targeted") {
    throw new Error("Chronicle v2 temporal Gold must be targeted");
  }
  assertUniqueIds(
    gold.relations.map((relation) => relation.id),
    "Gold relation",
  );
  assertUniqueIds(gold.unscoredClaimIds, "unscored Gold claim");
  for (const relation of gold.relations) {
    if (relation.expression !== "夜半") {
      throw new Error(
        `Chronicle v2 temporal relation is outside the 夜半 scope: ${relation.id}`,
      );
    }
    if (relation.requiredRegion.end <= relation.requiredRegion.start) {
      throw new Error(
        `Chronicle v2 temporal relation has an invalid evidence region: ${relation.id}`,
      );
    }
  }
}

/**
 * Score the scoped temporal relation layer after event identity and evidence
 * have been established by the v2 production evaluator.
 */
export function evaluateChronicleV2Temporal(input: {
  readonly temporalGold: ChronicleV2TemporalGold;
  readonly rawRows: readonly ChronicleV2TemporalRawRow[];
  readonly exactEventAssignments: readonly ChronicleV2TemporalEventAssignment[];
  readonly evidenceByActual: readonly ChronicleV2TemporalEvidence[];
}): ChronicleV2TemporalEvaluation {
  assertTemporalGold(input.temporalGold);
  const rawRows = [...input.rawRows].sort((left, right) =>
    compareStrings(left.actualRef, right.actualRef),
  );
  const normalizedRows = normalizeChronicleV2TemporalRows(rawRows);
  assertUniqueIds(
    input.exactEventAssignments.map((assignment) => assignment.actualRef),
    "event assignment actual",
  );
  assertUniqueIds(
    input.evidenceByActual.map((evidence) => evidence.actualRef),
    "evidence actual",
  );
  const normalizedByActual = new Map(
    normalizedRows.map((row) => [row.actualRef, row] as const),
  );
  const evidenceByActual = new Map(
    input.evidenceByActual.map((evidence) => [evidence.actualRef, evidence]),
  );
  const relationRows: ChronicleV2TemporalRelationRow[] = [];
  let matchedCount = 0;
  let missingCount = 0;
  let invalidEvidenceCount = 0;
  let unobservableCount = 0;
  let blockedByEventIdentityCount = 0;

  for (const relation of input.temporalGold.relations) {
    const assignments = input.exactEventAssignments.filter(
      (assignment) =>
        assignment.status === "match" &&
        assignment.goldRef === relation.targetClaimId,
    );
    if (assignments.length !== 1) {
      unobservableCount += 1;
      blockedByEventIdentityCount += 1;
      relationRows.push({
        relationId: relation.id,
        targetClaimId: relation.targetClaimId,
        actualRef: null,
        metadataStatus: "missing",
        result: "unobservable",
        evidenceSupported: false,
        reason: "event-identity-unavailable",
      });
      continue;
    }

    const actualRef = assignments[0]!.actualRef;
    const normalized = normalizedByActual.get(actualRef);
    const evidence = evidenceByActual.get(actualRef);
    const evidenceSupported = Boolean(
      evidence?.valid &&
      chronicleV2TemporalCoversRange(evidence.ranges, relation.requiredRegion),
    );
    const metadataStatus = normalized
      ? statusForExpressions(normalized.expressions)
      : "missing";
    if (!evidenceSupported) {
      invalidEvidenceCount += 1;
      relationRows.push({
        relationId: relation.id,
        targetClaimId: relation.targetClaimId,
        actualRef,
        metadataStatus,
        result: "invalid-evidence",
        evidenceSupported: false,
        reason: "temporal-evidence-invalid",
      });
      continue;
    }

    const hasNightHalf = Boolean(
      normalized?.expressions.some(
        (expression) =>
          expression.status === "known" && expression.value === "夜半",
      ),
    );
    if (hasNightHalf) {
      matchedCount += 1;
      relationRows.push({
        relationId: relation.id,
        targetClaimId: relation.targetClaimId,
        actualRef,
        metadataStatus,
        result: "matched",
        evidenceSupported: true,
      });
      continue;
    }
    const hasUnknown = Boolean(
      normalized?.expressions.some(
        (expression) => expression.status === "unknown",
      ),
    );
    if (hasUnknown) {
      unobservableCount += 1;
      relationRows.push({
        relationId: relation.id,
        targetClaimId: relation.targetClaimId,
        actualRef,
        metadataStatus: "unknown",
        result: "unobservable",
        evidenceSupported: true,
        reason: "temporal-expression-unknown",
      });
      continue;
    }
    missingCount += 1;
    relationRows.push({
      relationId: relation.id,
      targetClaimId: relation.targetClaimId,
      actualRef,
      metadataStatus: "missing",
      result: "missing",
      evidenceSupported: true,
    });
  }

  const requiredRelationCount = input.temporalGold.relations.length;
  const judgedCount = requiredRelationCount - unobservableCount;
  const status = temporalStatus(
    invalidEvidenceCount,
    missingCount,
    unobservableCount,
  );
  return {
    version: CHRONICLE_V2_TEMPORAL_VERSION,
    rawRows,
    normalizedRows,
    relationRows,
    requiredRelationCount,
    matchedCount,
    missingCount,
    invalidEvidenceCount,
    unobservableCount,
    blockedByEventIdentityCount,
    unscoredGoldCount: input.temporalGold.unscoredClaimIds.length,
    judgedCount,
    denominator: requiredRelationCount,
    status,
    passed: status === "PASS",
  };
}
