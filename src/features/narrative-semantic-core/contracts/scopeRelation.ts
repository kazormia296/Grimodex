import {
  SCOPE_AXES,
  validateNarrativeScopeV2,
  type NarrativeScopeV2,
  type ReferenceScopeConstraint,
  type TemporalBoundary,
  type TemporalScopeConstraint,
  type ScopeAxis,
} from "./scopeV2";

export type {
  NarrativeScopeV2,
  ReferenceScopeConstraint,
  TemporalBoundary,
  TemporalScopeConstraint,
  ScopeAxis,
} from "./scopeV2";

export const SCOPE_RELATIONS = [
  "equal",
  "contains",
  "contained-by",
  "overlaps",
  "disjoint",
  "unknown",
] as const;
export type ScopeRelation = (typeof SCOPE_RELATIONS)[number];

export const SCOPE_ORDER_AXES = ["story-time", "reading-order"] as const;
export type ScopeOrderAxis = (typeof SCOPE_ORDER_AXES)[number];
export type ScopeTemporalAxis = "storyTime" | "readingOrder";
export type ScopeReferenceAxis = Exclude<
  ScopeAxis,
  "storyTime" | "readingOrder"
>;

export interface ScopeComparisonBasis {
  readonly scopeRegistryVersion: string;
  readonly storyTimeOrderRevision?: string;
  readonly readingOrderRevision?: string;
  readonly worldlineRegistryRevision?: string;
  readonly narrativeLayerRegistryRevision?: string;
}

export interface ScopeRelationResult {
  readonly relation: ScopeRelation;
  readonly axes: Readonly<Record<ScopeAxis, ScopeRelation>>;
  readonly basis: ScopeComparisonBasis | null;
  readonly oracleUsed: boolean;
  readonly unresolvedReasons: readonly string[];
}

export interface ScopeOrderOracle {
  readonly axis: ScopeOrderAxis;
  readonly revisionToken: string;
  readonly compare: (
    leftRef: string,
    rightRef: string,
  ) => -1 | 0 | 1 | "unresolved";
}

export type ScopeRegistryDecision =
  | ScopeRelation
  | "unresolved"
  | readonly ScopeRelation[]
  | {
      readonly relation: ScopeRelation | "unresolved";
      readonly intersection?: "established" | "not-established" | "unresolved";
      readonly unresolvedReasons?: readonly string[];
      readonly conflictsWith?: readonly ScopeRelation[];
    };

export interface ScopeRelationRegistry {
  /** Revision of the reference facts used by compareReference. */
  readonly scopeRegistryVersion: string;
  readonly worldlineRevision?: string;
  readonly narrativeLayerRevision?: string;
  readonly compareReference?: (
    axis: ScopeReferenceAxis,
    leftRef: string,
    rightRef: string,
  ) => ScopeRegistryDecision;
  /** `compare` is accepted as a short compatibility seam for registry adapters. */
  readonly compare?: (
    axis: ScopeReferenceAxis,
    leftRef: string,
    rightRef: string,
  ) => ScopeRegistryDecision;
}

export type ScopeOrderOracleMap = Partial<
  Record<ScopeOrderAxis | ScopeTemporalAxis, ScopeOrderOracle>
>;

export interface ScopeRelationComparisonOptions {
  readonly basis?: ScopeComparisonBasis;
  readonly registry?: ScopeRelationRegistry;
  readonly orderOracles?: ScopeOrderOracleMap;
  /** A single revision token means both inputs are the same Scope revision. */
  readonly scopeRevision?: string;
  readonly leftScopeRevision?: string;
  readonly rightScopeRevision?: string;
}

export type ScopeOrderValidation =
  | { readonly status: "valid" }
  | {
      readonly status: "invalid";
      readonly reason: "reversed-interval" | "empty-interval";
    }
  | { readonly status: "unresolved"; readonly reason: string };

export interface ScopeAxisRelationResult {
  readonly relation: ScopeRelation;
  readonly oracleUsed: boolean;
  readonly intersectionEstablished: boolean;
  readonly unresolvedReasons: readonly string[];
}

export type ScopeRelationErrorCode =
  | "invalid-scope"
  | "invalid-order-oracle"
  | "invalid-order"
  | "basis-required"
  | "basis-mismatch"
  | "contradictory-proof";

export class ScopeRelationContractError extends Error {
  readonly code: ScopeRelationErrorCode;

  constructor(code: ScopeRelationErrorCode, message: string) {
    super(message);
    this.name = "ScopeRelationContractError";
    this.code = code;
  }
}

interface InternalAxisResult extends ScopeAxisRelationResult {
  readonly usedRegistryAxes: readonly ScopeReferenceAxis[];
  readonly usedOrderAxes: readonly ScopeOrderAxis[];
}

interface BoundComparison {
  readonly value: -1 | 0 | 1 | "unresolved";
  readonly usedOracle: boolean;
}

type BoundComparisonCache = Map<string, Map<string, BoundComparison>>;

function cachedBoundComparison(
  cache: BoundComparisonCache,
  leftRef: string,
  rightRef: string,
): BoundComparison | undefined {
  return cache.get(leftRef)?.get(rightRef);
}

function cacheBoundComparison(
  cache: BoundComparisonCache,
  leftRef: string,
  rightRef: string,
  comparison: BoundComparison,
): void {
  const row = cache.get(leftRef) ?? new Map<string, BoundComparison>();
  row.set(rightRef, comparison);
  cache.set(leftRef, row);
}

interface OrderOracleValidationState {
  readonly comparisons: Map<string, Map<string, -1 | 0 | 1 | "unresolved">>;
  readonly equalityParent: Map<string, string>;
  readonly strictProofs: Array<readonly [string, string]>;
  readonly strictOrder: Map<string, Set<string>>;
}

const REFERENCE_AXES = new Set<ScopeReferenceAxis>([
  "timeline",
  "worldline",
  "scene",
  "viewpoint",
  "knowledgeHolder",
  "audience",
  "narrativeLayer",
]);

const ORDER_AXIS_BY_SCOPE_AXIS: Record<ScopeTemporalAxis, ScopeOrderAxis> = {
  storyTime: "story-time",
  readingOrder: "reading-order",
};

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isScopeRelation(value: unknown): value is ScopeRelation {
  return (
    typeof value === "string" &&
    (SCOPE_RELATIONS as readonly string[]).includes(value)
  );
}

function uniqueReasons(reasons: readonly string[]): readonly string[] {
  return [...new Set(reasons.filter(isNonEmptyString))];
}

function axisResult(
  relation: ScopeRelation,
  options: {
    oracleUsed?: boolean;
    intersectionEstablished?: boolean;
    unresolvedReasons?: readonly string[];
    usedRegistryAxes?: readonly ScopeReferenceAxis[];
    usedOrderAxes?: readonly ScopeOrderAxis[];
  } = {},
): InternalAxisResult {
  return {
    relation,
    oracleUsed: options.oracleUsed ?? false,
    intersectionEstablished:
      options.intersectionEstablished ??
      (relation !== "disjoint" && relation !== "unknown"),
    unresolvedReasons: uniqueReasons(options.unresolvedReasons ?? []),
    usedRegistryAxes: options.usedRegistryAxes ?? [],
    usedOrderAxes: options.usedOrderAxes ?? [],
  };
}

function contractError(
  code: ScopeRelationErrorCode,
  message: string,
): ScopeRelationContractError {
  return new ScopeRelationContractError(code, message);
}

function validateOrderOracle(
  oracle: ScopeOrderOracle | undefined,
  expectedAxis: ScopeOrderAxis,
): ScopeOrderOracle | undefined {
  if (!oracle) return undefined;
  if (
    oracle.axis !== expectedAxis ||
    !isNonEmptyString(oracle.revisionToken) ||
    typeof oracle.compare !== "function"
  ) {
    throw contractError(
      "invalid-order-oracle",
      `Invalid ${expectedAxis} ScopeOrderOracle`,
    );
  }
  return oracle;
}

function createOrderOracleValidationState(): OrderOracleValidationState {
  return {
    comparisons: new Map(),
    equalityParent: new Map(),
    strictProofs: [],
    strictOrder: new Map(),
  };
}

function cachedOrderComparison(
  state: OrderOracleValidationState,
  leftRef: string,
  rightRef: string,
): (-1 | 0 | 1 | "unresolved") | undefined {
  return state.comparisons.get(leftRef)?.get(rightRef);
}

function cacheOrderComparison(
  state: OrderOracleValidationState,
  leftRef: string,
  rightRef: string,
  value: -1 | 0 | 1 | "unresolved",
): void {
  const row = state.comparisons.get(leftRef) ?? new Map();
  row.set(rightRef, value);
  state.comparisons.set(leftRef, row);
}

function findEqualityRoot(
  state: OrderOracleValidationState,
  reference: string,
): string {
  const parent = state.equalityParent.get(reference);
  if (!parent) {
    state.equalityParent.set(reference, reference);
    return reference;
  }
  if (parent === reference) return reference;
  const root = findEqualityRoot(state, parent);
  state.equalityParent.set(reference, root);
  return root;
}

function hasStrictOrderPath(
  state: OrderOracleValidationState,
  from: string,
  to: string,
  visited = new Set<string>(),
): boolean {
  if (from === to) return true;
  if (visited.has(from)) return false;
  visited.add(from);
  for (const next of state.strictOrder.get(from) ?? []) {
    if (hasStrictOrderPath(state, next, to, visited)) return true;
  }
  return false;
}

function rebuildStrictOrder(state: OrderOracleValidationState): void {
  state.strictOrder.clear();
  for (const [lowerReference, upperReference] of state.strictProofs) {
    const lower = findEqualityRoot(state, lowerReference);
    const upper = findEqualityRoot(state, upperReference);
    if (lower === upper || hasStrictOrderPath(state, upper, lower)) {
      throw contractError(
        "contradictory-proof",
        "ScopeOrderOracle returned a strict proof inside an equality cycle",
      );
    }
    const successors = state.strictOrder.get(lower) ?? new Set<string>();
    successors.add(upper);
    state.strictOrder.set(lower, successors);
  }
}

function unionEqualityProof(
  state: OrderOracleValidationState,
  leftReference: string,
  rightReference: string,
): void {
  const left = findEqualityRoot(state, leftReference);
  const right = findEqualityRoot(state, rightReference);
  if (left === right) return;
  const [root, child] = left < right ? [left, right] : [right, left];
  state.equalityParent.set(child, root);
  rebuildStrictOrder(state);
}

function recordStrictOrderProof(
  state: OrderOracleValidationState,
  leftRef: string,
  rightRef: string,
  value: -1 | 0 | 1 | "unresolved",
): void {
  if (value === "unresolved") return;
  if (value === 0) {
    unionEqualityProof(state, leftRef, rightRef);
    return;
  }
  const lower = value === -1 ? leftRef : rightRef;
  const upper = value === -1 ? rightRef : leftRef;
  state.strictProofs.push([lower, upper]);
  rebuildStrictOrder(state);
}

function orderOracleFor(
  axis: ScopeTemporalAxis,
  options: ScopeRelationComparisonOptions,
): ScopeOrderOracle | undefined {
  const map = options.orderOracles;
  if (!map) return undefined;
  const orderAxis = ORDER_AXIS_BY_SCOPE_AXIS[axis];
  return validateOrderOracle(map[orderAxis] ?? map[axis], orderAxis);
}

function compareReferences(
  leftRef: string,
  rightRef: string,
  oracle: ScopeOrderOracle | undefined,
  state = createOrderOracleValidationState(),
): BoundComparison {
  if (!oracle) {
    return leftRef === rightRef
      ? { value: 0, usedOracle: false }
      : { value: "unresolved", usedOracle: false };
  }

  if (leftRef !== rightRef) {
    // Validate identity for both endpoints before accepting any pairwise
    // proof. This keeps a malformed oracle from masking its identity
    // contradiction behind an earlier antisymmetry failure.
    compareReferences(leftRef, leftRef, oracle, state);
    compareReferences(rightRef, rightRef, oracle, state);
  }

  const cached = cachedOrderComparison(state, leftRef, rightRef);
  if (cached !== undefined) {
    return { value: cached, usedOracle: leftRef !== rightRef };
  }

  let value: -1 | 0 | 1 | "unresolved";
  try {
    value = oracle.compare(leftRef, rightRef);
  } catch {
    throw contractError(
      "invalid-order-oracle",
      `ScopeOrderOracle ${oracle.axis} threw while comparing references`,
    );
  }
  if (value !== -1 && value !== 0 && value !== 1 && value !== "unresolved") {
    throw contractError(
      "invalid-order-oracle",
      `ScopeOrderOracle ${oracle.axis} returned an invalid comparison`,
    );
  }

  if (leftRef === rightRef) {
    if (value !== 0 && value !== "unresolved") {
      throw contractError(
        "invalid-order-oracle",
        `ScopeOrderOracle ${oracle.axis} returned a nonzero identity comparison`,
      );
    }
    // An unknown reference may legitimately be unresolved even when both
    // operands are the same. Structural identity remains a zero proof.
    cacheOrderComparison(state, leftRef, rightRef, 0);
    return { value: 0, usedOracle: false };
  }

  let reverse: -1 | 0 | 1 | "unresolved";
  const cachedReverse = cachedOrderComparison(state, rightRef, leftRef);
  if (cachedReverse !== undefined) {
    reverse = cachedReverse;
  } else {
    try {
      reverse = oracle.compare(rightRef, leftRef);
    } catch {
      throw contractError(
        "invalid-order-oracle",
        `ScopeOrderOracle ${oracle.axis} threw while comparing reverse references`,
      );
    }
    if (
      reverse !== -1 &&
      reverse !== 0 &&
      reverse !== 1 &&
      reverse !== "unresolved"
    ) {
      throw contractError(
        "invalid-order-oracle",
        `ScopeOrderOracle ${oracle.axis} returned an invalid reverse comparison`,
      );
    }
    cacheOrderComparison(state, rightRef, leftRef, reverse);
  }
  const contradictoryUnresolved =
    (value === "unresolved") !== (reverse === "unresolved");
  const contradictoryDirection =
    value !== "unresolved" && reverse !== "unresolved" && reverse !== -value;
  if (contradictoryUnresolved || contradictoryDirection) {
    throw contractError(
      "contradictory-proof",
      `ScopeOrderOracle ${oracle.axis} returned contradictory comparisons for ${leftRef} and ${rightRef}`,
    );
  }
  cacheOrderComparison(state, leftRef, rightRef, value);
  recordStrictOrderProof(state, leftRef, rightRef, value);
  return { value, usedOracle: true };
}

function referenceIdentityEstablished(
  left: Extract<ReferenceScopeConstraint, { kind: "unresolved" }>,
  right: Extract<ReferenceScopeConstraint, { kind: "unresolved" }>,
  options: ScopeRelationComparisonOptions,
): boolean {
  if (
    isNonEmptyString(left.constraintId) &&
    left.constraintId === right.constraintId
  ) {
    return true;
  }
  if (isNonEmptyString(options.scopeRevision)) return true;
  return (
    isNonEmptyString(options.leftScopeRevision) &&
    options.leftScopeRevision === options.rightScopeRevision
  );
}

function temporalIdentityEstablished(
  left: Extract<TemporalScopeConstraint, { kind: "unresolved" }>,
  right: Extract<TemporalScopeConstraint, { kind: "unresolved" }>,
  options: ScopeRelationComparisonOptions,
): boolean {
  if (
    isNonEmptyString(left.constraintId) &&
    left.constraintId === right.constraintId
  ) {
    return true;
  }
  if (isNonEmptyString(options.scopeRevision)) return true;
  return (
    isNonEmptyString(options.leftScopeRevision) &&
    options.leftScopeRevision === options.rightScopeRevision
  );
}

function normalizeRegistryDecision(decision: ScopeRegistryDecision): {
  relation: ScopeRelation | "unresolved";
  intersection?: "established" | "not-established" | "unresolved";
  unresolvedReasons: readonly string[];
} {
  if (Array.isArray(decision)) {
    const unique = [...new Set(decision as readonly ScopeRelation[])];
    if (unique.length !== 1 || !isScopeRelation(unique[0])) {
      throw contractError(
        "contradictory-proof",
        "Scope Registry returned conflicting relation proofs",
      );
    }
    return {
      relation: unique[0],
      unresolvedReasons: [],
    };
  }
  if (typeof decision === "string") {
    if (decision === "unresolved") {
      return { relation: "unresolved", unresolvedReasons: [] };
    }
    if (!isScopeRelation(decision)) {
      throw contractError(
        "contradictory-proof",
        "Scope Registry returned an unknown relation",
      );
    }
    return { relation: decision, unresolvedReasons: [] };
  }
  if (decision === null || typeof decision !== "object") {
    throw contractError(
      "contradictory-proof",
      "Scope Registry returned an invalid proof",
    );
  }
  const objectDecision = decision as Exclude<
    ScopeRegistryDecision,
    ScopeRelation | "unresolved" | readonly ScopeRelation[]
  >;
  const relation = objectDecision.relation;
  if (relation !== "unresolved" && !isScopeRelation(relation)) {
    throw contractError(
      "contradictory-proof",
      "Scope Registry returned an unknown relation",
    );
  }
  const conflicts: readonly ScopeRelation[] =
    objectDecision.conflictsWith ?? [];
  if (
    conflicts.some((candidate) => !isScopeRelation(candidate)) ||
    conflicts.some((candidate) => candidate === relation)
  ) {
    throw contractError(
      "contradictory-proof",
      "Scope Registry returned conflicting relation proofs",
    );
  }
  if (conflicts.length > 0) {
    throw contractError(
      "contradictory-proof",
      "Scope Registry returned conflicting relation proofs",
    );
  }
  return {
    relation,
    intersection: objectDecision.intersection,
    unresolvedReasons: objectDecision.unresolvedReasons ?? [],
  };
}

function referenceConstraintRelation(
  axis: ScopeReferenceAxis,
  left: ReferenceScopeConstraint,
  right: ReferenceScopeConstraint,
  options: ScopeRelationComparisonOptions,
): InternalAxisResult {
  if (left.kind === "any" && right.kind === "any") return axisResult("equal");
  if (left.kind === "any") return axisResult("contains");
  if (right.kind === "any") return axisResult("contained-by");
  if (left.kind === "unresolved" && right.kind === "unresolved") {
    return axisResult(
      referenceIdentityEstablished(left, right, options) ? "equal" : "unknown",
      {
        intersectionEstablished: referenceIdentityEstablished(
          left,
          right,
          options,
        ),
        unresolvedReasons: referenceIdentityEstablished(left, right, options)
          ? []
          : [`${axis}-constraint-unresolved`],
      },
    );
  }
  if (left.kind === "unresolved" || right.kind === "unresolved") {
    return axisResult("unknown", {
      intersectionEstablished: false,
      unresolvedReasons: [`${axis}-constraint-unresolved`],
    });
  }
  if (left.ref === right.ref) return axisResult("equal");

  const registry = options.registry;
  const compare = registry?.compareReference ?? registry?.compare;
  if (!compare) {
    return axisResult("unknown", {
      intersectionEstablished: false,
      unresolvedReasons: [`${axis}-registry-unavailable`],
    });
  }
  const normalized = normalizeRegistryDecision(
    compare.call(registry, axis, left.ref, right.ref),
  );
  if (normalized.relation === "unresolved") {
    return axisResult("unknown", {
      oracleUsed: true,
      intersectionEstablished: false,
      unresolvedReasons:
        normalized.unresolvedReasons.length > 0
          ? normalized.unresolvedReasons
          : [`${axis}-registry-unresolved`],
      usedRegistryAxes: [axis],
    });
  }
  if (
    normalized.relation === "overlaps" &&
    normalized.intersection !== undefined &&
    normalized.intersection !== "established"
  ) {
    return axisResult("unknown", {
      oracleUsed: true,
      intersectionEstablished: false,
      unresolvedReasons: [`${axis}-intersection-unresolved`],
      usedRegistryAxes: [axis],
    });
  }
  if (
    normalized.relation === "disjoint" &&
    normalized.intersection === "established"
  ) {
    throw contractError(
      "contradictory-proof",
      `Scope Registry contradicted disjoint proof on ${axis}`,
    );
  }
  if (
    normalized.relation !== "disjoint" &&
    normalized.relation !== "unknown" &&
    normalized.relation !== "overlaps" &&
    normalized.intersection !== undefined &&
    normalized.intersection !== "established"
  ) {
    throw contractError(
      "contradictory-proof",
      `Scope Registry contradicted non-empty intersection proof on ${axis}`,
    );
  }
  return axisResult(normalized.relation, {
    oracleUsed: true,
    intersectionEstablished:
      normalized.relation !== "disjoint" && normalized.relation !== "unknown",
    unresolvedReasons: normalized.unresolvedReasons,
    usedRegistryAxes: [axis],
  });
}

function compareBound(
  left: TemporalBoundary | undefined,
  right: TemporalBoundary | undefined,
  compareRef: (leftRef: string, rightRef: string) => BoundComparison,
): BoundComparison {
  if (!left || !right) return { value: 0, usedOracle: false };
  return compareRef(left.ref, right.ref);
}

function validateInterval(
  interval: Extract<TemporalScopeConstraint, { kind: "interval" }>,
  axis: ScopeTemporalAxis,
  compareRef: (leftRef: string, rightRef: string) => BoundComparison,
): { readonly validation: ScopeOrderValidation; readonly usedOracle: boolean } {
  if (!interval.from || !interval.until) {
    return { validation: { status: "valid" }, usedOracle: false };
  }
  const comparison = compareBound(interval.from, interval.until, compareRef);
  if (comparison.value === "unresolved") {
    return {
      validation: {
        status: "unresolved",
        reason: `${axis}-order-unresolved`,
      },
      usedOracle: comparison.usedOracle,
    };
  }
  if (comparison.value > 0) {
    return {
      validation: { status: "invalid", reason: "reversed-interval" },
      usedOracle: comparison.usedOracle,
    };
  }
  if (
    comparison.value === 0 &&
    !(interval.from.inclusive && interval.until.inclusive)
  ) {
    return {
      validation: { status: "invalid", reason: "empty-interval" },
      usedOracle: comparison.usedOracle,
    };
  }
  return {
    validation: { status: "valid" },
    usedOracle: comparison.usedOracle,
  };
}

function maxLower(
  left: TemporalBoundary | undefined,
  right: TemporalBoundary | undefined,
  compareRef: (leftRef: string, rightRef: string) => BoundComparison,
): { readonly bound?: TemporalBoundary; readonly unresolved: boolean } {
  if (!left) return { bound: right, unresolved: false };
  if (!right) return { bound: left, unresolved: false };
  const comparison = compareBound(left, right, compareRef);
  if (comparison.value === "unresolved") return { unresolved: true };
  if (comparison.value > 0) return { bound: left, unresolved: false };
  if (comparison.value < 0) return { bound: right, unresolved: false };
  return {
    bound: {
      ref: left.ref,
      inclusive: left.inclusive && right.inclusive,
    },
    unresolved: false,
  };
}

function minUpper(
  left: TemporalBoundary | undefined,
  right: TemporalBoundary | undefined,
  compareRef: (leftRef: string, rightRef: string) => BoundComparison,
): { readonly bound?: TemporalBoundary; readonly unresolved: boolean } {
  if (!left) return { bound: right, unresolved: false };
  if (!right) return { bound: left, unresolved: false };
  const comparison = compareBound(left, right, compareRef);
  if (comparison.value === "unresolved") return { unresolved: true };
  if (comparison.value < 0) return { bound: left, unresolved: false };
  if (comparison.value > 0) return { bound: right, unresolved: false };
  return {
    bound: {
      ref: left.ref,
      inclusive: left.inclusive && right.inclusive,
    },
    unresolved: false,
  };
}

function isSuperset(
  container: Extract<TemporalScopeConstraint, { kind: "interval" }>,
  contained: Extract<TemporalScopeConstraint, { kind: "interval" }>,
  compareRef: (leftRef: string, rightRef: string) => BoundComparison,
): boolean | "unresolved" {
  if (container.from && !contained.from) return false;
  if (container.until && !contained.until) return false;
  if (container.from && contained.from) {
    const comparison = compareBound(container.from, contained.from, compareRef);
    if (comparison.value === "unresolved") return "unresolved";
    if (comparison.value > 0) return false;
    if (
      comparison.value === 0 &&
      !container.from.inclusive &&
      contained.from.inclusive
    ) {
      return false;
    }
  }
  if (container.until && contained.until) {
    const comparison = compareBound(
      container.until,
      contained.until,
      compareRef,
    );
    if (comparison.value === "unresolved") return "unresolved";
    if (comparison.value < 0) return false;
    if (
      comparison.value === 0 &&
      !container.until.inclusive &&
      contained.until.inclusive
    ) {
      return false;
    }
  }
  return true;
}

function temporalConstraintRelation(
  axis: ScopeTemporalAxis,
  left: TemporalScopeConstraint,
  right: TemporalScopeConstraint,
  options: ScopeRelationComparisonOptions,
): InternalAxisResult {
  if (left.kind === "any" && right.kind === "any") return axisResult("equal");
  if (left.kind === "any") return axisResult("contains");
  if (right.kind === "any") return axisResult("contained-by");
  if (left.kind === "unresolved" && right.kind === "unresolved") {
    const equal = temporalIdentityEstablished(left, right, options);
    return axisResult(equal ? "equal" : "unknown", {
      intersectionEstablished: equal,
      unresolvedReasons: equal ? [] : [`${axis}-constraint-unresolved`],
    });
  }
  if (left.kind === "unresolved" || right.kind === "unresolved") {
    return axisResult("unknown", {
      intersectionEstablished: false,
      unresolvedReasons: [`${axis}-constraint-unresolved`],
    });
  }

  if (
    left.from?.ref === right.from?.ref &&
    left.from?.inclusive === right.from?.inclusive &&
    left.until?.ref === right.until?.ref &&
    left.until?.inclusive === right.until?.inclusive
  ) {
    const oracle = orderOracleFor(axis, options);
    if (oracle) {
      const state = createOrderOracleValidationState();
      for (const boundary of [left.from, left.until]) {
        if (boundary) {
          compareReferences(boundary.ref, boundary.ref, oracle, state);
        }
      }
    }
    if (
      left.from &&
      left.until &&
      left.from.ref === left.until.ref &&
      !(left.from.inclusive && left.until.inclusive)
    ) {
      throw contractError(
        "invalid-order",
        `${axis} interval is empty-interval`,
      );
    }
    // The canonical interval structure itself establishes equality. Order
    // validation remains a separate lint and does not enter the Basis.
    return axisResult("equal");
  }

  const orderAxis = ORDER_AXIS_BY_SCOPE_AXIS[axis];
  const oracle = orderOracleFor(axis, options);
  const oracleState = createOrderOracleValidationState();
  const cache: BoundComparisonCache = new Map();
  let orderOracleUsed = false;
  const compareRef = (leftRef: string, rightRef: string): BoundComparison => {
    const cached = cachedBoundComparison(cache, leftRef, rightRef);
    if (cached) return cached;
    const comparison = compareReferences(
      leftRef,
      rightRef,
      oracle,
      oracleState,
    );
    orderOracleUsed ||= comparison.usedOracle;
    cacheBoundComparison(cache, leftRef, rightRef, comparison);
    return comparison;
  };
  const leftValidation = validateInterval(left, axis, compareRef);
  const rightValidation = validateInterval(right, axis, compareRef);
  const validations = [leftValidation.validation, rightValidation.validation];
  const invalid = validations.find(
    (validation) => validation.status === "invalid",
  );
  if (invalid?.status === "invalid") {
    throw contractError(
      "invalid-order",
      `${axis} interval is ${invalid.reason}`,
    );
  }
  const unresolvedValidation = validations.find(
    (validation) => validation.status === "unresolved",
  );
  if (unresolvedValidation?.status === "unresolved") {
    return axisResult("unknown", {
      oracleUsed: orderOracleUsed,
      intersectionEstablished: false,
      unresolvedReasons: [unresolvedValidation.reason],
      usedOrderAxes: orderOracleUsed ? [orderAxis] : [],
    });
  }

  const lower = maxLower(left.from, right.from, compareRef);
  const upper = minUpper(left.until, right.until, compareRef);
  if (lower.unresolved || upper.unresolved) {
    return axisResult("unknown", {
      oracleUsed: orderOracleUsed,
      intersectionEstablished: false,
      unresolvedReasons: [`${axis}-order-unresolved`],
      usedOrderAxes: orderOracleUsed ? [orderAxis] : [],
    });
  }

  let intersectionEstablished = true;
  if (lower.bound && upper.bound) {
    const intersectionOrder = compareRef(lower.bound.ref, upper.bound.ref);
    if (intersectionOrder.value === "unresolved") {
      return axisResult("unknown", {
        oracleUsed: orderOracleUsed,
        intersectionEstablished: false,
        unresolvedReasons: [`${axis}-order-unresolved`],
        usedOrderAxes: orderOracleUsed ? [orderAxis] : [],
      });
    }
    intersectionEstablished =
      intersectionOrder.value < 0 ||
      (intersectionOrder.value === 0 &&
        lower.bound.inclusive &&
        upper.bound.inclusive);
  }
  if (!intersectionEstablished) {
    return axisResult("disjoint", {
      oracleUsed: orderOracleUsed,
      intersectionEstablished: false,
      usedOrderAxes: orderOracleUsed ? [orderAxis] : [],
    });
  }

  const leftContainsRight = isSuperset(left, right, compareRef);
  const rightContainsLeft = isSuperset(right, left, compareRef);
  if (
    leftContainsRight === "unresolved" ||
    rightContainsLeft === "unresolved"
  ) {
    return axisResult("unknown", {
      oracleUsed: orderOracleUsed,
      intersectionEstablished: false,
      unresolvedReasons: [`${axis}-order-unresolved`],
      usedOrderAxes: orderOracleUsed ? [orderAxis] : [],
    });
  }
  const relation =
    leftContainsRight && rightContainsLeft
      ? "equal"
      : leftContainsRight
        ? "contains"
        : rightContainsLeft
          ? "contained-by"
          : "overlaps";
  return axisResult(relation, {
    oracleUsed: orderOracleUsed,
    intersectionEstablished: true,
    usedOrderAxes: orderOracleUsed ? [orderAxis] : [],
  });
}

function axisRelationInternal(
  axis: ScopeAxis,
  left: ReferenceScopeConstraint | TemporalScopeConstraint,
  right: ReferenceScopeConstraint | TemporalScopeConstraint,
  options: ScopeRelationComparisonOptions,
): InternalAxisResult {
  if (REFERENCE_AXES.has(axis as ScopeReferenceAxis)) {
    return referenceConstraintRelation(
      axis as ScopeReferenceAxis,
      left as ReferenceScopeConstraint,
      right as ReferenceScopeConstraint,
      options,
    );
  }
  return temporalConstraintRelation(
    axis as ScopeTemporalAxis,
    left as TemporalScopeConstraint,
    right as TemporalScopeConstraint,
    options,
  );
}

function isReferenceScopeConstraint(
  value: unknown,
): value is ReferenceScopeConstraint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { readonly kind?: unknown }).kind;
  return kind === "any" || kind === "exact" || kind === "unresolved";
}

function isTemporalScopeConstraint(
  value: unknown,
): value is TemporalScopeConstraint {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const kind = (value as { readonly kind?: unknown }).kind;
  return kind === "any" || kind === "interval" || kind === "unresolved";
}

function validateAxisConstraintFamily(
  axis: ScopeAxis,
  left: unknown,
  right: unknown,
): void {
  const expected = REFERENCE_AXES.has(axis as ScopeReferenceAxis)
    ? isReferenceScopeConstraint
    : isTemporalScopeConstraint;
  if (!expected(left) || !expected(right)) {
    const family = REFERENCE_AXES.has(axis as ScopeReferenceAxis)
      ? "reference"
      : "temporal";
    throw contractError(
      "invalid-scope",
      `Scope axis ${axis} requires ${family} constraints`,
    );
  }
}

export function compareScopeAxis(
  axis: ScopeReferenceAxis,
  left: ReferenceScopeConstraint,
  right: ReferenceScopeConstraint,
  options?: ScopeRelationComparisonOptions,
): ScopeAxisRelationResult;
export function compareScopeAxis(
  axis: ScopeTemporalAxis,
  left: TemporalScopeConstraint,
  right: TemporalScopeConstraint,
  options?: ScopeRelationComparisonOptions,
): ScopeAxisRelationResult;
export function compareScopeAxis(
  axis: ScopeAxis,
  left: ReferenceScopeConstraint | TemporalScopeConstraint,
  right: ReferenceScopeConstraint | TemporalScopeConstraint,
  options: ScopeRelationComparisonOptions = {},
): ScopeAxisRelationResult {
  if (!(SCOPE_AXES as readonly string[]).includes(axis)) {
    throw contractError("invalid-scope", `Unknown Scope axis: ${axis}`);
  }
  validateAxisConstraintFamily(axis, left, right);
  const result = axisRelationInternal(axis, left, right, options);
  enforceBasis(options, result, {
    registryAxes: result.usedRegistryAxes,
    orderAxes: result.usedOrderAxes,
  });
  return result;
}

function enforceBasis(
  options: ScopeRelationComparisonOptions,
  result: Pick<InternalAxisResult, "oracleUsed">,
  usage: {
    readonly registryAxes: readonly ScopeReferenceAxis[];
    readonly orderAxes: readonly ScopeOrderAxis[];
  },
): ScopeComparisonBasis | null {
  if (!result.oracleUsed) return null;
  const basis = options.basis;
  if (!basis) {
    throw contractError(
      "basis-required",
      "An Oracle- or Registry-derived Scope relation requires Basis",
    );
  }
  if (!isNonEmptyString(basis.scopeRegistryVersion)) {
    throw contractError(
      "basis-mismatch",
      "Scope Comparison Basis requires scopeRegistryVersion",
    );
  }
  const registry = options.registry;
  if (
    registry &&
    usage.registryAxes.length > 0 &&
    basis.scopeRegistryVersion !== registry.scopeRegistryVersion
  ) {
    throw contractError(
      "basis-mismatch",
      "Scope Comparison Basis does not match the Registry revision",
    );
  }
  const orderOracles = options.orderOracles;
  for (const axis of usage.orderAxes) {
    const scopeAxis = axis === "story-time" ? "storyTime" : "readingOrder";
    const oracle = orderOracles?.[axis] ?? orderOracles?.[scopeAxis];
    const expected =
      axis === "story-time"
        ? basis.storyTimeOrderRevision
        : basis.readingOrderRevision;
    if (!oracle || expected !== oracle.revisionToken) {
      throw contractError(
        "basis-mismatch",
        `Scope Comparison Basis does not match the ${axis} Oracle revision`,
      );
    }
  }
  if (
    usage.registryAxes.includes("worldline") &&
    registry?.worldlineRevision &&
    basis.worldlineRegistryRevision !== registry.worldlineRevision
  ) {
    throw contractError(
      "basis-mismatch",
      "Scope Comparison Basis does not match the worldline Registry revision",
    );
  }
  if (
    usage.registryAxes.includes("narrativeLayer") &&
    registry?.narrativeLayerRevision &&
    basis.narrativeLayerRegistryRevision !== registry.narrativeLayerRevision
  ) {
    throw contractError(
      "basis-mismatch",
      "Scope Comparison Basis does not match the narrative-layer Registry revision",
    );
  }
  return basis;
}

function relationOverrides(
  relations: Readonly<Record<ScopeAxis, ScopeRelation>>,
  evidence: Partial<Record<ScopeAxis, boolean | ScopeRelation>> | undefined,
): {
  readonly relations: Record<ScopeAxis, ScopeRelation>;
  readonly intersections: Partial<Record<ScopeAxis, boolean>>;
} {
  const nextRelations = { ...relations } as Record<ScopeAxis, ScopeRelation>;
  const intersections: Partial<Record<ScopeAxis, boolean>> = {};
  for (const [axis, value] of Object.entries(evidence ?? {}) as [
    ScopeAxis,
    boolean | ScopeRelation,
  ][]) {
    if (typeof value === "boolean") intersections[axis] = value;
    else if (isScopeRelation(value)) nextRelations[axis] = value;
  }
  return { relations: nextRelations, intersections };
}

export function composeScopeRelations(
  axes: Readonly<Record<ScopeAxis, ScopeRelation>>,
  evidence?: Partial<Record<ScopeAxis, boolean | ScopeRelation>>,
): ScopeRelation {
  const overridden = relationOverrides(axes, evidence);
  const relations = SCOPE_AXES.map((axis) => overridden.relations[axis]);
  if (relations.some((relation) => relation === "disjoint")) return "disjoint";
  if (relations.some((relation) => relation === "unknown")) return "unknown";
  if (relations.every((relation) => relation === "equal")) return "equal";
  if (
    relations.every(
      (relation) => relation === "equal" || relation === "contains",
    ) &&
    relations.some((relation) => relation === "contains")
  ) {
    return "contains";
  }
  if (
    relations.every(
      (relation) => relation === "equal" || relation === "contained-by",
    ) &&
    relations.some((relation) => relation === "contained-by")
  ) {
    return "contained-by";
  }
  if (
    relations.every(
      (relation) => relation !== "disjoint" && relation !== "unknown",
    ) &&
    SCOPE_AXES.every((axis) => {
      const relation = overridden.relations[axis];
      return relation !== "overlaps"
        ? (overridden.intersections[axis] ?? true)
        : overridden.intersections[axis] === true;
    })
  ) {
    return "overlaps";
  }
  return "unknown";
}

export function compareScopeRelation(
  left: NarrativeScopeV2,
  right: NarrativeScopeV2,
  options: ScopeRelationComparisonOptions = {},
): ScopeRelationResult {
  const leftValidation = validateNarrativeScopeV2(left);
  if (!leftValidation.valid) {
    throw contractError(
      "invalid-scope",
      `Invalid left Scope V2: ${leftValidation.reason}`,
    );
  }
  const rightValidation = validateNarrativeScopeV2(right);
  if (!rightValidation.valid) {
    throw contractError(
      "invalid-scope",
      `Invalid right Scope V2: ${rightValidation.reason}`,
    );
  }

  const axisResults = Object.fromEntries(
    SCOPE_AXES.map((axis) => [
      axis,
      axisRelationInternal(axis, left[axis], right[axis], options),
    ]),
  ) as Record<ScopeAxis, InternalAxisResult>;
  const axes = Object.fromEntries(
    SCOPE_AXES.map((axis) => [axis, axisResults[axis].relation]),
  ) as Record<ScopeAxis, ScopeRelation>;
  const relation = composeScopeRelations(
    axes,
    Object.fromEntries(
      SCOPE_AXES.map((axis) => [
        axis,
        axisResults[axis].intersectionEstablished,
      ]),
    ) as Partial<Record<ScopeAxis, boolean>>,
  );
  const oracleUsed = SCOPE_AXES.some((axis) => axisResults[axis].oracleUsed);
  const usedRegistryAxes = [
    ...new Set(
      SCOPE_AXES.flatMap((axis) => axisResults[axis].usedRegistryAxes),
    ),
  ];
  const usedOrderAxes = [
    ...new Set(SCOPE_AXES.flatMap((axis) => axisResults[axis].usedOrderAxes)),
  ];
  const resolvedBasis = enforceBasis(
    options,
    { oracleUsed },
    { registryAxes: usedRegistryAxes, orderAxes: usedOrderAxes },
  );
  return {
    relation,
    axes,
    basis: resolvedBasis,
    oracleUsed,
    unresolvedReasons: uniqueReasons(
      SCOPE_AXES.flatMap((axis) => axisResults[axis].unresolvedReasons),
    ),
  };
}

export function validateScopeOrder(
  constraint: TemporalScopeConstraint,
  oracle: ScopeOrderOracle,
): ScopeOrderValidation {
  const orderAxis = oracle.axis;
  validateOrderOracle(oracle, orderAxis);
  if (constraint.kind === "any") return { status: "valid" };
  if (constraint.kind === "unresolved") {
    return { status: "unresolved", reason: constraint.reason };
  }
  const oracleState = createOrderOracleValidationState();
  const cache: BoundComparisonCache = new Map();
  const compareRef = (leftRef: string, rightRef: string): BoundComparison => {
    const cached = cachedBoundComparison(cache, leftRef, rightRef);
    if (cached) return cached;
    const comparison = compareReferences(
      leftRef,
      rightRef,
      oracle,
      oracleState,
    );
    cacheBoundComparison(cache, leftRef, rightRef, comparison);
    return comparison;
  };
  return validateInterval(
    constraint,
    orderAxis === "story-time" ? "storyTime" : "readingOrder",
    compareRef,
  ).validation;
}

export function validateNarrativeScopeOrder(
  scope: NarrativeScopeV2,
  oracles: ScopeOrderOracleMap,
): Readonly<Record<ScopeTemporalAxis, ScopeOrderValidation>> {
  const validation = validateNarrativeScopeV2(scope);
  if (!validation.valid) {
    throw contractError(
      "invalid-scope",
      `Invalid Scope V2: ${validation.reason}`,
    );
  }
  const result = {} as Record<ScopeTemporalAxis, ScopeOrderValidation>;
  for (const axis of ["storyTime", "readingOrder"] as const) {
    const oracle = orderOracleFor(axis, { orderOracles: oracles });
    if (!oracle) {
      result[axis] =
        scope[axis].kind === "interval" && scope[axis].from && scope[axis].until
          ? { status: "unresolved", reason: `${axis}-order-oracle-unavailable` }
          : { status: "valid" };
      continue;
    }
    result[axis] = validateScopeOrder(scope[axis], oracle);
  }
  return result;
}
