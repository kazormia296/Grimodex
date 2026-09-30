import type {
  ChronicleV2AlignmentInput,
  ChronicleV2EvidenceCandidate,
  ChronicleV2GoldClaim,
  ChronicleV2Normalized,
  ChronicleV2NormalizedActualClaim,
  ChronicleV2UnknownReason,
} from "./chronicleV2Contract";

/** Version of the deterministic v2 claim alignment contract. */
export const CHRONICLE_V2_ALIGNMENT_VERSION =
  "chronicle-evaluation-v2-alignment/3" as const;

export const CHRONICLE_V2_ALIGNMENT_DIMENSIONS = [
  "predicate",
  "participants",
  "roles",
  "actuality",
  "attribution",
  "narrativeFrame",
] as const;

export type ChronicleV2AlignmentDimension =
  (typeof CHRONICLE_V2_ALIGNMENT_DIMENSIONS)[number];

export const CHRONICLE_V2_ALIGNMENT_REASON_CODES = [
  "predicate-mismatch",
  "participant-missing",
  "participant-extra",
  "entity-mismatch",
  "role-mismatch",
  "actuality-mismatch",
  "attribution-mismatch",
  "frame-mismatch",
  "evidence-invalid",
  "evidence-no-candidate",
  "duplicate-claim",
  "meaning-out-of-vocabulary",
  "missing-claim",
  "extra-claim",
  "outside-annotation",
] as const;

export type ChronicleV2AlignmentReason =
  (typeof CHRONICLE_V2_ALIGNMENT_REASON_CODES)[number];

export type ChronicleV2AssignmentStatus =
  | "match"
  | "mismatch"
  | "unobservable"
  | "unscored";

export interface ChronicleV2ClaimAssignment {
  readonly actualRef: string;
  readonly goldRef: string | null;
  readonly status: ChronicleV2AssignmentStatus;
  readonly reason?: ChronicleV2AlignmentReason | ChronicleV2UnknownReason;
}

export interface ChronicleV2AlignmentResult {
  readonly version: typeof CHRONICLE_V2_ALIGNMENT_VERSION;
  /** Candidate edges are sorted and de-duplicated for digest stability. */
  readonly candidates: readonly ChronicleV2EvidenceCandidate[];
  /** One row per actual claim, sorted by actualRef. */
  readonly assignments: readonly ChronicleV2ClaimAssignment[];
  readonly matchedCount: number;
  /** Actual rows paired with a Gold row but with meaning mismatch. */
  readonly mismatchCount: number;
  readonly extraCount: number;
  readonly duplicateCount: number;
  readonly unscoredCount: number;
  /** Definite Gold rows in neither the matched nor undetermined set. */
  readonly missingCount: number;
  readonly unobservableCount: number;
  /** Exact semantic Gold identities consumed by one-to-one matches. */
  readonly matchedGoldRefs: readonly string[];
  /** Gold claims held by an unknown actual candidate, never definite misses. */
  readonly undeterminedGoldRefs: readonly string[];
  readonly undeterminedGoldCount: number;
  readonly missingGoldRefs: readonly string[];
  /** Maximum one-to-one Gold capacity of compatible unknown actual rows. */
  readonly unknownMatchCapacity: number;
  /** A conservative lower bound on Gold rows that cannot be recovered. */
  readonly missingCountLowerBound: number;
  /**
   * Exhaustive cardinality lower bound, kept separate from semantic
   * classification and unknown Gold capacity.
   */
  readonly cardinalityExcessLowerBound: number;
  readonly falsePositiveCount: number;
  readonly falseNegativeCount: number;
  readonly passed: boolean;
}

type KnownValue<T> = Extract<ChronicleV2Normalized<T>, { status: "known" }>;

export type ChronicleV2DimensionComparison = "equal" | "mismatch" | "unknown";

export interface ChronicleV2ClaimComparison {
  readonly exact: boolean;
  /** Compatible means no known actual field contradicts the Gold claim. */
  readonly compatible: boolean;
  readonly similarity: number;
  readonly dimensions: Readonly<
    Record<ChronicleV2AlignmentDimension, ChronicleV2DimensionComparison>
  >;
  readonly reason?: ChronicleV2AlignmentReason;
}

interface MatchingEdge {
  readonly goldRef: string;
  readonly similarity: number;
  readonly reason?: ChronicleV2AlignmentReason;
}

interface MatchingPair {
  readonly actualIndex: number;
  readonly goldRef: string;
}

interface MatchingPlan {
  readonly pairCount: number;
  readonly similarity: number;
  /** Sparse rows keep the DP work bounded by the Gold set size. */
  readonly pairs: readonly MatchingPair[];
}

function isKnown<T>(value: ChronicleV2Normalized<T>): value is KnownValue<T> {
  return value.status === "known";
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareNullableStrings(
  left: string | null,
  right: string | null,
): number {
  if (left === right) return 0;
  // A paired row sorts before an unpaired row when all higher-priority
  // matching objectives tie. This makes the canonical-ID tie break stable.
  if (left === null) return 1;
  if (right === null) return -1;
  return compareStrings(left, right);
}

function sortCandidates(
  candidates: readonly ChronicleV2EvidenceCandidate[],
): readonly ChronicleV2EvidenceCandidate[] {
  const seen = new Set<string>();
  return [...candidates]
    .filter((candidate) => {
      const key = [
        candidate.actualRef,
        candidate.goldRef ?? "<null>",
        candidate.evidenceValid ? "1" : "0",
        candidate.overlap ? "1" : "0",
        candidate.directSupport ? "1" : "0",
        candidate.contextSupport ? "1" : "0",
      ].join("\u0000");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort(
      (left, right) =>
        compareStrings(left.actualRef, right.actualRef) ||
        compareNullableStrings(left.goldRef, right.goldRef) ||
        Number(right.evidenceValid) - Number(left.evidenceValid) ||
        Number(right.overlap) - Number(left.overlap) ||
        Number(right.directSupport) - Number(left.directSupport) ||
        Number(right.contextSupport) - Number(left.contextSupport),
    );
}

function assertUniqueIds(values: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (value.trim().length === 0 || seen.has(value)) {
      throw new Error(`Chronicle v2 ${label} IDs must be unique and non-empty`);
    }
    seen.add(value);
  }
}

function unknownReason(
  actual: ChronicleV2NormalizedActualClaim,
): ChronicleV2UnknownReason | undefined {
  const values: readonly ChronicleV2Normalized<unknown>[] = [
    actual.predicate,
    ...actual.participants.flatMap((participant) => [
      participant.entity,
      participant.role,
    ]),
    actual.actuality,
    actual.attribution,
    actual.narrativeFrame,
  ];
  const unknown = values.find((value) => value.status === "unknown");
  return unknown?.status === "unknown" ? unknown.reason : undefined;
}

function unknownAssignmentReason(
  reason: ChronicleV2UnknownReason | undefined,
): ChronicleV2UnknownReason | ChronicleV2AlignmentReason | undefined {
  if (reason === "predicate-out-of-vocabulary") {
    return "meaning-out-of-vocabulary";
  }
  return reason;
}

function participantDimension(
  actual: ChronicleV2NormalizedActualClaim,
  gold: ChronicleV2GoldClaim,
  dimension: "participants" | "roles",
): ChronicleV2DimensionComparison {
  if (actual.participants.length !== gold.participants.length) {
    return "mismatch";
  }
  let hasUnknown = false;
  let masks = new Set<number>([0]);
  for (const actualParticipant of actual.participants) {
    const next = new Set<number>();
    for (const mask of masks) {
      for (const [index, goldParticipant] of gold.participants.entries()) {
        const bit = 1 << index;
        if ((mask & bit) !== 0) continue;
        const entityCompatible =
          !isKnown(actualParticipant.entity) ||
          actualParticipant.entity.value === goldParticipant.entity;
        const roleCompatible =
          !isKnown(actualParticipant.role) ||
          actualParticipant.role.value === goldParticipant.role;
        const compatible =
          dimension === "participants"
            ? entityCompatible
            : entityCompatible && roleCompatible;
        if (!compatible) continue;
        next.add(mask | bit);
      }
    }
    if (!isKnown(actualParticipant.entity)) hasUnknown = true;
    if (dimension === "roles" && !isKnown(actualParticipant.role)) {
      hasUnknown = true;
    }
    masks = next;
    if (masks.size === 0) return "mismatch";
  }
  const fullMask = (1 << gold.participants.length) - 1;
  if (!masks.has(fullMask)) return "mismatch";
  return hasUnknown ? "unknown" : "equal";
}

function participantPairCompatible(
  actual: ChronicleV2NormalizedActualClaim["participants"][number],
  gold: ChronicleV2GoldClaim["participants"][number],
): boolean {
  return (
    (!isKnown(actual.entity) || actual.entity.value === gold.entity) &&
    (!isKnown(actual.role) || actual.role.value === gold.role)
  );
}

/**
 * Check participant compatibility with an injective matching. Unknown
 * participant fields are wildcards, but they cannot reuse a Gold participant.
 */
function participantsCompatible(
  actual: ChronicleV2NormalizedActualClaim,
  gold: ChronicleV2GoldClaim,
): boolean {
  if (actual.participants.length !== gold.participants.length) return false;
  let masks = new Set<number>([0]);
  for (const actualParticipant of actual.participants) {
    const next = new Set<number>();
    for (const mask of masks) {
      for (const [index, goldParticipant] of gold.participants.entries()) {
        const bit = 1 << index;
        if ((mask & bit) !== 0) continue;
        if (!participantPairCompatible(actualParticipant, goldParticipant)) {
          continue;
        }
        next.add(mask | bit);
      }
    }
    masks = next;
    if (masks.size === 0) return false;
  }
  return masks.has((1 << gold.participants.length) - 1);
}

export function compareChronicleV2Claim(
  actual: ChronicleV2NormalizedActualClaim,
  gold: ChronicleV2GoldClaim,
): ChronicleV2ClaimComparison {
  const predicate: ChronicleV2DimensionComparison = !isKnown(actual.predicate)
    ? "unknown"
    : actual.predicate.value === gold.predicate
      ? "equal"
      : "mismatch";
  const participants = participantDimension(actual, gold, "participants");
  const roles = participantDimension(actual, gold, "roles");
  const actuality: ChronicleV2DimensionComparison = !isKnown(actual.actuality)
    ? "unknown"
    : actual.actuality.value === gold.actuality
      ? "equal"
      : "mismatch";
  const attribution: ChronicleV2DimensionComparison = !isKnown(
    actual.attribution,
  )
    ? "unknown"
    : actual.attribution.value === gold.attribution
      ? "equal"
      : "mismatch";
  const narrativeFrame: ChronicleV2DimensionComparison = !isKnown(
    actual.narrativeFrame,
  )
    ? "unknown"
    : actual.narrativeFrame.value === gold.narrativeFrame
      ? "equal"
      : "mismatch";
  const dimensions = {
    predicate,
    participants,
    roles,
    actuality,
    attribution,
    narrativeFrame,
  } satisfies Record<
    ChronicleV2AlignmentDimension,
    ChronicleV2DimensionComparison
  >;

  let reason: ChronicleV2AlignmentReason | undefined;
  if (predicate === "mismatch") reason = "predicate-mismatch";
  else if (actual.participants.length < gold.participants.length) {
    reason = "participant-missing";
  } else if (actual.participants.length > gold.participants.length) {
    reason = "participant-extra";
  } else if (!participantsCompatible(actual, gold)) {
    // Prefer the entity reason when the entity multiset is observably wrong;
    // a role-only change retains the same entity multiset and gets role-
    // mismatch. For partial unknown rows this still reports a known
    // contradiction rather than silently treating it as uncertain.
    if (participants === "mismatch") reason = "entity-mismatch";
    else if (roles === "mismatch") reason = "role-mismatch";
    else if (
      actual.participants.some((participant) => {
        const role = participant.role;
        if (role.status !== "known") return false;
        return !gold.participants.some(
          (candidate) => candidate.role === role.value,
        );
      })
    ) {
      reason = "role-mismatch";
    } else {
      reason = "entity-mismatch";
    }
  } else if (actuality === "mismatch") reason = "actuality-mismatch";
  else if (attribution === "mismatch") reason = "attribution-mismatch";
  else if (narrativeFrame === "mismatch") reason = "frame-mismatch";

  const compatible = reason === undefined;
  const exact =
    compatible && Object.values(dimensions).every((value) => value === "equal");
  const similarity = Object.values(dimensions).filter(
    (value) => value === "equal",
  ).length;
  return {
    exact,
    compatible,
    similarity,
    dimensions,
    ...(reason ? { reason } : {}),
  };
}

function activeCandidatesFor(
  actualRef: string,
  candidates: readonly ChronicleV2EvidenceCandidate[],
): readonly ChronicleV2EvidenceCandidate[] {
  return candidates.filter(
    (candidate) =>
      candidate.actualRef === actualRef &&
      candidate.goldRef !== null &&
      candidate.evidenceValid &&
      candidate.overlap &&
      candidate.directSupport &&
      candidate.contextSupport,
  );
}

function hasInvalidCandidate(
  actualRef: string,
  candidates: readonly ChronicleV2EvidenceCandidate[],
): boolean {
  return candidates.some(
    (candidate) =>
      candidate.actualRef === actualRef && !candidate.evidenceValid,
  );
}

function hasNoCandidate(
  actualRef: string,
  candidates: readonly ChronicleV2EvidenceCandidate[],
): boolean {
  return activeCandidatesFor(actualRef, candidates).length === 0;
}

function betterPlan(left: MatchingPlan, right: MatchingPlan): boolean {
  if (left.pairCount !== right.pairCount) {
    return left.pairCount > right.pairCount;
  }
  if (left.similarity !== right.similarity) {
    return left.similarity > right.similarity;
  }
  // Pair lists are appended in actual order. Since pairCount ties here, a
  // sparse lexicographic comparison is equivalent to comparing the full
  // actualRef -> GoldRef vector, while staying O(Gold) per state.
  for (let index = 0; index < left.pairs.length; index += 1) {
    const leftPair = left.pairs[index]!;
    const rightPair = right.pairs[index]!;
    if (leftPair.actualIndex !== rightPair.actualIndex) {
      return leftPair.actualIndex < rightPair.actualIndex;
    }
    const comparison = compareStrings(leftPair.goldRef, rightPair.goldRef);
    if (comparison !== 0) return comparison < 0;
  }
  return false;
}

/**
 * Find a maximum-cardinality, maximum-similarity matching. The DP state is
 * only the set of consumed Gold IDs, so work is linear in actual rows for a
 * fixed Gold set. Canonical actual and Gold IDs settle all remaining ties.
 */
function maximumMatching(
  actualRefs: readonly string[],
  edgesByActual: ReadonlyMap<string, readonly MatchingEdge[]>,
  goldRefs: readonly string[],
): ReadonlyMap<string, string> {
  const goldIndex = new Map(goldRefs.map((goldRef, index) => [goldRef, index]));
  let states = new Map<bigint, MatchingPlan>([
    [0n, { pairCount: 0, similarity: 0, pairs: [] }],
  ]);
  for (const [actualIndex, actualRef] of actualRefs.entries()) {
    const edges = [...(edgesByActual.get(actualRef) ?? [])].sort(
      (left, right) =>
        compareStrings(left.goldRef, right.goldRef) ||
        right.similarity - left.similarity,
    );
    const next = new Map<bigint, MatchingPlan>();
    for (const [mask, plan] of states) {
      const skipped: MatchingPlan = {
        pairCount: plan.pairCount,
        similarity: plan.similarity,
        pairs: plan.pairs,
      };
      const priorSkipped = next.get(mask);
      if (!priorSkipped || betterPlan(skipped, priorSkipped)) {
        next.set(mask, skipped);
      }
      for (const edge of edges) {
        const index = goldIndex.get(edge.goldRef);
        if (index === undefined) continue;
        const bit = 1n << BigInt(index);
        if ((mask & bit) !== 0n) continue;
        const paired: MatchingPlan = {
          pairCount: plan.pairCount + 1,
          similarity: plan.similarity + edge.similarity,
          pairs: [...plan.pairs, { actualIndex, goldRef: edge.goldRef }],
        };
        const pairedMask = mask | bit;
        const priorPaired = next.get(pairedMask);
        if (!priorPaired || betterPlan(paired, priorPaired)) {
          next.set(pairedMask, paired);
        }
      }
    }
    states = next;
  }
  let best: MatchingPlan | undefined;
  for (const plan of states.values()) {
    if (!best || betterPlan(plan, best)) best = plan;
  }
  const result = new Map<string, string>();
  if (!best) return result;
  for (const pair of best.pairs) {
    result.set(actualRefs[pair.actualIndex]!, pair.goldRef);
  }
  return result;
}

function uniqueSorted(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort(compareStrings);
}

function edgeFor(
  gold: ChronicleV2GoldClaim,
  comparison: ChronicleV2ClaimComparison,
): MatchingEdge {
  return {
    goldRef: gold.id,
    similarity: comparison.similarity,
    ...(comparison.reason ? { reason: comparison.reason } : {}),
  };
}

/**
 * Deterministically align actual claims to source-authored Gold claims.
 *
 * Evidence edges only narrow the comparison graph. Meaning is compared from
 * the normalized actual and Gold independently, and one Gold identity can be
 * consumed at most once. Unknown actual values hold every compatible Gold
 * edge uncertain instead of selecting one arbitrarily or claiming a false
 * positive/negative.
 */
export function alignChronicleV2Claims(
  input: ChronicleV2AlignmentInput,
): ChronicleV2AlignmentResult {
  assertUniqueIds(
    input.goldClaims.map((claim) => claim.id),
    "Gold claim",
  );
  assertUniqueIds(
    input.normalizedActualClaims.map((claim) => claim.actualRef),
    "actual claim",
  );
  const goldById = new Map(input.goldClaims.map((claim) => [claim.id, claim]));
  const actualByRef = new Map(
    input.normalizedActualClaims.map((claim) => [claim.actualRef, claim]),
  );
  const candidates = sortCandidates(input.evidenceCandidates).filter(
    (candidate) =>
      actualByRef.has(candidate.actualRef) &&
      (candidate.goldRef === null || goldById.has(candidate.goldRef)),
  );
  const goldRefs = [...goldById.keys()].sort(compareStrings);
  const sortedActuals = [...input.normalizedActualClaims].sort((left, right) =>
    compareStrings(left.actualRef, right.actualRef),
  );

  // First reserve every exact match possible. This prevents an early
  // ambiguous actual from consuming an identity needed by a later actual.
  const exactEdgesByActual = new Map<string, readonly MatchingEdge[]>();
  for (const actual of sortedActuals) {
    if (unknownReason(actual)) continue;
    const edges: MatchingEdge[] = [];
    for (const candidate of activeCandidatesFor(actual.actualRef, candidates)) {
      const gold = candidate.goldRef
        ? goldById.get(candidate.goldRef)
        : undefined;
      if (!gold) continue;
      const comparison = compareChronicleV2Claim(actual, gold);
      if (comparison.exact) edges.push(edgeFor(gold, comparison));
    }
    exactEdgesByActual.set(actual.actualRef, edges);
  }
  const exactByActual = maximumMatching(
    sortedActuals.map((actual) => actual.actualRef),
    exactEdgesByActual,
    goldRefs,
  );
  const exactGold = new Set(exactByActual.values());

  const assignmentsByActual = new Map<string, ChronicleV2ClaimAssignment>();
  const mismatchEdgesByActual = new Map<string, readonly MatchingEdge[]>();
  const unknownCompatibleByActual = new Map<string, readonly string[]>();

  for (const actual of sortedActuals) {
    const actualRef = actual.actualRef;
    const active = activeCandidatesFor(actualRef, candidates);
    const unknown = unknownReason(actual);
    const comparisons = active
      .map((candidate) => {
        const gold = candidate.goldRef
          ? goldById.get(candidate.goldRef)
          : undefined;
        if (!gold || candidate.goldRef === null) return undefined;
        return {
          gold,
          comparison: compareChronicleV2Claim(actual, gold),
        };
      })
      .filter(
        (
          value,
        ): value is {
          gold: ChronicleV2GoldClaim;
          comparison: ChronicleV2ClaimComparison;
        } => value !== undefined,
      );

    if (unknown) {
      // Unknown rows remain unobservable whenever any valid candidate is
      // semantically compatible. Reservation only controls which compatible
      // Gold identities contribute to uncertainty capacity; it must not turn
      // a compatible row into a diagnostic mismatch against another edge.
      const allCompatibleGold = uniqueSorted(
        comparisons
          .filter((entry) => entry.comparison.compatible)
          .map((entry) => entry.gold.id),
      );
      const availableCompatibleGold = allCompatibleGold.filter(
        (goldRef) => !exactGold.has(goldRef),
      );
      if (allCompatibleGold.length > 0) {
        if (availableCompatibleGold.length > 0) {
          unknownCompatibleByActual.set(actualRef, availableCompatibleGold);
        }
        assignmentsByActual.set(actualRef, {
          actualRef,
          goldRef: null,
          status: "unobservable",
          reason: unknownAssignmentReason(unknown),
        });
        continue;
      }
      const mismatchEdges = comparisons
        .filter((entry) => !entry.comparison.compatible)
        .map((entry) => edgeFor(entry.gold, entry.comparison));
      if (mismatchEdges.length > 0) {
        mismatchEdgesByActual.set(actualRef, mismatchEdges);
      } else {
        assignmentsByActual.set(actualRef, {
          actualRef,
          goldRef: null,
          status: "unobservable",
          reason: unknownAssignmentReason(unknown),
        });
      }
      continue;
    }

    const exactGoldCandidates = comparisons
      .filter((entry) => entry.comparison.exact && exactGold.has(entry.gold.id))
      .map((entry) => entry.gold.id)
      .sort(compareStrings);
    const exactGoldRef = exactByActual.get(actualRef);
    if (exactGoldRef) {
      assignmentsByActual.set(actualRef, {
        actualRef,
        goldRef: exactGoldRef,
        status: "match",
      });
      continue;
    }
    if (exactGoldCandidates.length > 0) {
      assignmentsByActual.set(actualRef, {
        actualRef,
        goldRef: exactGoldCandidates[0]!,
        status: "mismatch",
        reason: "duplicate-claim",
      });
      continue;
    }

    // Targeted annotation leaves valid actual rows outside the annotated
    // Gold set neutral. Evidence may still have produced a broad candidate
    // edge; the target coverage mode is the authority for this partition.
    if (
      input.coverage.observation === "targeted" &&
      !hasInvalidCandidate(actualRef, candidates)
    ) {
      assignmentsByActual.set(actualRef, {
        actualRef,
        goldRef: null,
        status: "unscored",
        reason: "outside-annotation",
      });
      continue;
    }

    const mismatchEdges = comparisons
      .filter((entry) => !entry.comparison.exact)
      .map((entry) => edgeFor(entry.gold, entry.comparison));
    if (mismatchEdges.length > 0) {
      mismatchEdgesByActual.set(actualRef, mismatchEdges);
      continue;
    }

    assignmentsByActual.set(actualRef, {
      actualRef,
      goldRef: null,
      status: "mismatch",
      reason: hasInvalidCandidate(actualRef, candidates)
        ? "evidence-invalid"
        : hasNoCandidate(actualRef, candidates)
          ? "evidence-no-candidate"
          : "extra-claim",
    });
  }

  const mismatchActualRefs = [...mismatchEdgesByActual.keys()].sort(
    compareStrings,
  );
  const remainingGoldRefs = goldRefs.filter(
    (goldRef) => !exactGold.has(goldRef),
  );
  const mismatchEdgesForAvailableGold = new Map<
    string,
    readonly MatchingEdge[]
  >();
  for (const actualRef of mismatchActualRefs) {
    mismatchEdgesForAvailableGold.set(
      actualRef,
      (mismatchEdgesByActual.get(actualRef) ?? []).filter(
        (edge) => !exactGold.has(edge.goldRef),
      ),
    );
  }
  const mismatchByActual = maximumMatching(
    mismatchActualRefs,
    mismatchEdgesForAvailableGold,
    remainingGoldRefs,
  );
  for (const actualRef of mismatchActualRefs) {
    const goldRef = mismatchByActual.get(actualRef);
    if (goldRef) {
      const edge = (mismatchEdgesByActual.get(actualRef) ?? []).find(
        (candidate) => candidate.goldRef === goldRef,
      );
      assignmentsByActual.set(actualRef, {
        actualRef,
        goldRef,
        status: "mismatch",
        reason: edge?.reason ?? "entity-mismatch",
      });
    } else {
      // A Gold identity already consumed by an exact match cannot be reused.
      // The unmatched actual remains a separately counted extra row.
      assignmentsByActual.set(actualRef, {
        actualRef,
        goldRef: null,
        status: "mismatch",
        reason: "extra-claim",
      });
    }
  }

  const assignments = sortedActuals.map((actual) => {
    const assignment = assignmentsByActual.get(actual.actualRef);
    if (!assignment) {
      throw new Error(
        `Chronicle v2 alignment did not classify actual: ${actual.actualRef}`,
      );
    }
    return assignment;
  });

  const undeterminedGold = new Set<string>();
  for (const refs of unknownCompatibleByActual.values()) {
    for (const goldRef of refs) undeterminedGold.add(goldRef);
  }
  for (const goldRef of exactGold) undeterminedGold.delete(goldRef);
  const missingGold = new Set(
    goldRefs.filter(
      (goldRef) => !exactGold.has(goldRef) && !undeterminedGold.has(goldRef),
    ),
  );

  const unknownActualRefs = [...unknownCompatibleByActual.keys()].sort(
    compareStrings,
  );
  const unknownEdgesByActual = new Map<string, readonly MatchingEdge[]>();
  for (const actualRef of unknownActualRefs) {
    unknownEdgesByActual.set(
      actualRef,
      (unknownCompatibleByActual.get(actualRef) ?? [])
        .filter((goldRef) => !exactGold.has(goldRef))
        .map((goldRef) => ({ goldRef, similarity: 0 })),
    );
  }
  const unknownMatchCapacity = maximumMatching(
    unknownActualRefs,
    unknownEdgesByActual,
    remainingGoldRefs,
  ).size;
  const missingCountLowerBound = Math.max(
    0,
    goldRefs.length - exactGold.size - unknownMatchCapacity,
  );
  // This count describes an exhaustive cardinality overflow only. Keep it
  // independent from semantic mismatch/extra rows and unknown capacity so a
  // targeted annotation or an unknown-compatible row cannot be over-counted.
  const cardinalityExcessLowerBound =
    input.coverage.observation === "exhaustive"
      ? Math.max(0, input.normalizedActualClaims.length - goldRefs.length)
      : 0;

  const matchedCount = assignments.filter(
    (entry) => entry.status === "match",
  ).length;
  const mismatchCount = assignments.filter(
    (entry) =>
      entry.status === "mismatch" &&
      entry.goldRef !== null &&
      entry.reason !== "duplicate-claim",
  ).length;
  const duplicateCount = assignments.filter(
    (entry) => entry.reason === "duplicate-claim",
  ).length;
  const extraCount = assignments.filter(
    (entry) =>
      entry.status === "mismatch" &&
      entry.goldRef === null &&
      entry.reason !== "duplicate-claim",
  ).length;
  const unobservableCount = assignments.filter(
    (entry) => entry.status === "unobservable",
  ).length;
  const unscoredCount = assignments.filter(
    (entry) => entry.status === "unscored",
  ).length;
  const missingCount = missingGold.size;
  const undeterminedGoldCount = undeterminedGold.size;
  const falsePositiveCount = mismatchCount + extraCount + duplicateCount;
  const falseNegativeCount = missingCount;

  return {
    version: CHRONICLE_V2_ALIGNMENT_VERSION,
    candidates,
    assignments,
    matchedCount,
    mismatchCount,
    extraCount,
    duplicateCount,
    unscoredCount,
    missingCount,
    unobservableCount,
    matchedGoldRefs: [...exactGold].sort(compareStrings),
    undeterminedGoldRefs: [...undeterminedGold].sort(compareStrings),
    undeterminedGoldCount,
    missingGoldRefs: [...missingGold].sort(compareStrings),
    unknownMatchCapacity,
    missingCountLowerBound,
    cardinalityExcessLowerBound,
    falsePositiveCount,
    falseNegativeCount,
    passed:
      mismatchCount === 0 &&
      extraCount === 0 &&
      duplicateCount === 0 &&
      unscoredCount === 0 &&
      missingCount === 0 &&
      undeterminedGoldCount === 0 &&
      unobservableCount === 0 &&
      cardinalityExcessLowerBound === 0,
  };
}
