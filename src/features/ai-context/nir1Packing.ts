import { planContextCache } from "./cachePlanner";
import {
  selectContextItems,
  type ContextItemSelection,
} from "./budgetSelector";
import {
  createContextPlan,
  computeContextPlanDigest,
  type ContextDecision,
  type ContextItem,
  type ContextPlan,
  type ContextStability,
} from "./types";

export const NIR1_PACKING_KINDS = Object.freeze([
  "raw",
  "accepted-ir",
  "graph-evidence",
  "author-declared",
  "unreviewed-for-review",
] as const);

export type Nir1PackingKind = (typeof NIR1_PACKING_KINDS)[number];

export type Nir1QualificationMode = "native" | "fixture";

export const NIR1_ATOMIC_PARTS = Object.freeze([
  "statement",
  "negation",
  "attribution",
  "evidence",
  "qualification",
] as const);

export type Nir1AtomicPart = (typeof NIR1_ATOMIC_PARTS)[number];

export const NIR1_PREDECLARED_IMPROVEMENT = Object.freeze({
  slot: "qualifiedEvidence",
  baseline: 0,
  candidateTarget: 1,
} as const);

export const NIR1_PACKING_PURPOSES = Object.freeze([
  "writing",
  "review",
] as const);

export type Nir1PackingPurpose = (typeof NIR1_PACKING_PURPOSES)[number];

const NIR1_BASELINE_MEASUREMENT_VERSION =
  "nir1-context-item-tokens-v1" as const;

const NIR1_READER_STRING_FIELDS = Object.freeze([
  "revisionId",
  "materialBasisDigest",
  "sourceKey",
  "sourceRevisionToken",
  "dependencyId",
  "evidenceRef",
  "evidenceQuoteDigest",
  "decisionId",
] as const);

const NIR1_READER_FRESHNESS_FIELDS = Object.freeze([
  "semanticEpochId",
  "dependencySetDigest",
  "declarationSetId",
  "declarationSetDigest",
] as const);

const NIR1_AUTHORITY_PROOFS = new WeakSet<object>();
const NIR1_FIXTURE_PROOFS = new WeakSet<object>();
const NIR1_CONTEXT_PLANS = new WeakSet<object>();

export interface Nir1PackingItem {
  readonly id: string;
  readonly kind: Nir1PackingKind;
  readonly text: string;
  readonly tokens: number;
  readonly atomicGroup?: string;
  readonly atomicPart?: Nir1AtomicPart;
  readonly stability?: ContextStability;
  readonly qualificationProof?: Nir1QualificationProof;
}

/**
 * Deterministic fixture-only reader shape.  It deliberately has a distinct
 * source tag; fixture data cannot stand in for Native A2 authority.
 */
export interface Nir1FixtureA2CurrentReaderOutput {
  readonly source: "fixture-only-a2-current-reader";
  readonly status: "current";
  readonly decision: "approved";
  readonly revisionId: string;
  readonly materialBasisDigest: string;
  readonly sourceKey: string;
  readonly sourceRevisionToken: string;
  readonly dependencyId: string;
  readonly evidenceRef: string;
  readonly evidenceQuoteDigest: string;
  readonly freshness: {
    readonly semanticEpochId: string;
    readonly dependencySetDigest: string;
    readonly declarationSetId: string;
    readonly declarationSetDigest: string;
  };
  readonly decisionId: string;
}

export interface Nir1QualificationProof {
  readonly provenance: "fixture-only" | "native-a2-current-reader";
  readonly reader: {
    readonly source:
      | "fixture-only-a2-current-reader"
      | "native-a2-current-reader";
    readonly status: "current" | "stale";
    readonly decision: "approved" | "rejected";
    readonly revisionId: string;
    readonly materialBasisDigest: string;
    readonly sourceKey: string;
    readonly sourceRevisionToken: string;
    readonly dependencyId: string;
    readonly evidenceRef: string;
    readonly evidenceQuoteDigest: string;
    readonly freshness: {
      readonly semanticEpochId: string;
      readonly dependencySetDigest: string;
      readonly declarationSetId: string;
      readonly declarationSetDigest: string;
    };
    readonly decisionId: string;
  };
}

/**
 * This adapter exists only for offline deterministic fixtures.  Production
 * Native A2 output is adapted at the DB boundary; the fixture provenance is
 * never accepted by the default selector mode.
 */
export interface Nir1FixtureA2QualifiedInput {
  readonly source: "fixture-only-a2-adapter";
  readonly item: Omit<Nir1PackingItem, "qualificationProof">;
  readonly reader: Nir1FixtureA2CurrentReaderOutput;
}

export interface Nir1PackingBudget {
  readonly contextWindowTokens: number;
  readonly systemTokens: number;
  readonly historyTokens: number;
  readonly toolTokens: number;
  readonly responseReservationTokens: number;
}

const NIR1_BUDGET_FIELDS = Object.freeze([
  "contextWindowTokens",
  "systemTokens",
  "historyTokens",
  "toolTokens",
  "responseReservationTokens",
] as const);

export interface Nir1BudgetBreakdown extends Nir1PackingBudget {
  readonly reservedTokens: number;
  readonly contextBudgetTokens: number;
}

export interface Nir1PackingMapping {
  readonly id: string;
  readonly kind: Nir1PackingKind;
}

interface Nir1PackingGroup {
  readonly groupId: string;
  readonly kind: Nir1PackingKind;
  readonly items: readonly Nir1PackingItem[];
  readonly tokens: number;
  readonly firstIndex: number;
}

interface Nir1PackingPayload {
  readonly groupId: string;
  readonly itemIds: readonly string[];
  readonly items: readonly Nir1PackingItem[];
  readonly tokens: number;
}

type Nir1ContextItem = ContextItem<Nir1PackingPayload, Nir1PackingKind>;

export interface Nir1CachePlan {
  readonly selectedItems: readonly Nir1ContextItem[];
  readonly selectedKeys: readonly string[];
  readonly stableItems: readonly Nir1ContextItem[];
  readonly volatileItems: readonly Nir1ContextItem[];
  readonly selectedIds: readonly string[];
  readonly droppedIds: readonly string[];
}

export interface Nir1TokenMeasurement {
  readonly measureSelectionTokens: (
    items: readonly Nir1ContextItem[],
  ) => number;
  readonly measureItemTokens: (item: Nir1ContextItem) => number;
}

export interface Nir1PackingBaseline {
  readonly items: readonly Nir1PackingItem[];
  readonly mapping: readonly Nir1PackingMapping[];
  readonly budget: Readonly<Nir1PackingBudget>;
  readonly totalBudget: Readonly<Nir1BudgetBreakdown>;
  readonly contextBudgetTokens: number;
  readonly tokenMeasurement: Readonly<Nir1TokenMeasurement>;
  readonly measurementVersion: typeof NIR1_BASELINE_MEASUREMENT_VERSION;
  readonly materialFingerprint: string;
  readonly predeclaredImprovement: typeof NIR1_PREDECLARED_IMPROVEMENT;
}

export interface CreateNir1PackingBaselineInput {
  readonly budget: Nir1PackingBudget;
  readonly items: readonly Nir1PackingItem[];
  readonly predeclaredImprovement?: typeof NIR1_PREDECLARED_IMPROVEMENT;
}

export interface SelectNir1PackingItemsInput {
  readonly budget: Nir1PackingBudget;
  readonly items: readonly Nir1PackingItem[];
  readonly baseline?: Nir1PackingBaseline;
  readonly purpose?: Nir1PackingPurpose;
  readonly requestId?: string;
  readonly binding?: Nir1CacheBinding;
  readonly qualificationMode?: Nir1QualificationMode;
}

export interface Nir1PackingSelection {
  readonly arm: "raw-priority-baseline" | "candidate";
  readonly selectedItems: readonly Nir1PackingItem[];
  readonly selectedIds: readonly string[];
  readonly omittedIds: readonly string[];
  readonly rejectedGroups: readonly string[];
  readonly decisions: readonly ContextDecision[];
  readonly usedTokens: number;
  readonly exactUsedTokens: number;
  readonly candidateTokens: number;
  readonly exactCandidateTokens: number;
  readonly contextBudgetTokens: number;
  readonly exactContextBudgetTokens: number;
  readonly proseOrder: readonly string[];
  readonly selectedText: readonly string[];
  readonly proseText: readonly string[];
  readonly qualifiedGroupIds: readonly string[];
  readonly cache: Nir1CachePlan;
  readonly contextItems: readonly Nir1ContextItem[];
}

export interface Nir1CacheBinding {
  readonly scopeToken: string;
  readonly sourceToken: string;
  readonly revisionId: string;
  readonly decisionId: string;
  readonly freshnessToken: string;
  readonly indexGeneration: string;
}

const NIR1_CACHE_BINDING_FIELDS = Object.freeze([
  "scopeToken",
  "sourceToken",
  "revisionId",
  "decisionId",
  "freshnessToken",
  "indexGeneration",
] as const);

export interface Nir1ContextPlan {
  readonly plan: ContextPlan<Nir1PackingPayload, Nir1PackingKind>;
  readonly selectedItems: readonly Nir1PackingItem[];
  readonly selectedIds: readonly string[];
  readonly cache: Nir1CachePlan;
  readonly selectionCount: 1;
  readonly inputItems: readonly Nir1PackingItem[];
  readonly inputFingerprint: string;
  readonly materialFingerprint: string;
  readonly qualificationMode: Nir1QualificationMode;
  readonly selectionValidityFingerprint: string;
  readonly totalBudget: Readonly<Nir1BudgetBreakdown>;
  readonly requestContext: Readonly<{
    readonly requestId: string;
    readonly purpose: Nir1PackingPurpose;
    readonly qualificationMode: Nir1QualificationMode;
  }>;
  readonly binding?: Nir1CacheBinding;
}

export interface CreateNir1ContextPlanInput extends SelectNir1PackingItemsInput {
  readonly requestId?: string;
  readonly binding?: Nir1CacheBinding;
}

export interface ReplanNir1ContextInput extends CreateNir1ContextPlanInput {
  readonly cachedPlan?: Nir1ContextPlan;
  /** @deprecated The cached plan's own binding is authoritative. */
  readonly cachedBinding?: Nir1CacheBinding;
}

function requireNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function requirePositiveSafeInteger(value: number, label: string): void {
  requireNonNegativeSafeInteger(value, label);
  if (value === 0) throw new RangeError(`${label} must be positive`);
}

function requireNonEmptyString(
  value: unknown,
  label: string,
): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  if (Array.isArray(value)) {
    value.forEach((entry) => deepFreeze(entry, seen));
  } else {
    Object.values(value as Record<string, unknown>).forEach((entry) =>
      deepFreeze(entry, seen),
    );
  }
  return Object.freeze(value);
}

function validateReaderShape(
  reader: Nir1QualificationProof["reader"],
  label: string,
  expectedSource: Nir1QualificationProof["reader"]["source"],
): void {
  if (!reader || typeof reader !== "object") {
    throw new TypeError(`${label} must be an object`);
  }
  if (reader.source !== expectedSource) {
    throw new TypeError(`${label}.source does not match the reader adapter`);
  }
  const readerRecord = reader as unknown as Record<string, unknown>;
  for (const key of NIR1_READER_STRING_FIELDS) {
    if (!Object.hasOwn(readerRecord, key)) {
      throw new TypeError(`${label}.${key} is required`);
    }
    requireNonEmptyString(readerRecord[key], `${label}.${key}`);
  }
  for (const [key, value] of Object.entries(reader)) {
    if (key === "freshness") continue;
    if (key === "source" || key === "status" || key === "decision") continue;
    requireNonEmptyString(value, `${label}.${key}`);
  }
  if (!reader.freshness || typeof reader.freshness !== "object") {
    throw new TypeError(`${label}.freshness must be an object`);
  }
  const freshnessRecord = reader.freshness as unknown as Record<
    string,
    unknown
  >;
  for (const key of NIR1_READER_FRESHNESS_FIELDS) {
    if (!Object.hasOwn(freshnessRecord, key)) {
      throw new TypeError(`${label}.freshness.${key} is required`);
    }
    requireNonEmptyString(freshnessRecord[key], `${label}.freshness.${key}`);
  }
  for (const [key, value] of Object.entries(freshnessRecord)) {
    requireNonEmptyString(value, `${label}.freshness.${key}`);
  }
}

function validateCurrentReaderOutput(
  reader: Nir1QualificationProof["reader"],
  label: string,
  expectedSource: Nir1QualificationProof["reader"]["source"] = "native-a2-current-reader",
): void {
  validateReaderShape(reader, label, expectedSource);
  if (reader.status !== "current") {
    throw new TypeError(`${label}.status must be current`);
  }
  if (reader.decision !== "approved") {
    throw new TypeError(`${label}.decision must be approved`);
  }
}

function isCurrentReaderProof(
  proof: Nir1QualificationProof | undefined,
): proof is Nir1QualificationProof {
  if (
    !proof ||
    proof.provenance !== "native-a2-current-reader" ||
    !NIR1_AUTHORITY_PROOFS.has(proof)
  ) {
    return false;
  }
  try {
    validateCurrentReaderOutput(proof.reader, "qualificationProof.reader");
    return true;
  } catch {
    return false;
  }
}

function isFixtureReaderProof(
  proof: Nir1QualificationProof | undefined,
): proof is Nir1QualificationProof {
  if (
    !proof ||
    proof.provenance !== "fixture-only" ||
    !NIR1_FIXTURE_PROOFS.has(proof)
  ) {
    return false;
  }
  try {
    validateCurrentReaderOutput(
      proof.reader,
      "qualificationProof.reader",
      "fixture-only-a2-current-reader",
    );
    return true;
  } catch {
    return false;
  }
}

function isSelectableQualificationProof(
  proof: Nir1QualificationProof | undefined,
  mode: Nir1QualificationMode,
): proof is Nir1QualificationProof {
  return mode === "fixture"
    ? isCurrentReaderProof(proof) || isFixtureReaderProof(proof)
    : isCurrentReaderProof(proof);
}

function normalizeQualificationMode(
  mode: Nir1QualificationMode | undefined,
): Nir1QualificationMode {
  return mode ?? "native";
}

function qualificationFingerprint(
  proof: Nir1QualificationProof | undefined,
): string {
  if (!proof) return "";
  return JSON.stringify({ provenance: proof.provenance, reader: proof.reader });
}

function freezeItem(item: Nir1PackingItem): Nir1PackingItem {
  const sourceProof = item.qualificationProof;
  const proof = item.qualificationProof
    ? NIR1_AUTHORITY_PROOFS.has(item.qualificationProof) ||
      NIR1_FIXTURE_PROOFS.has(item.qualificationProof)
      ? item.qualificationProof
      : {
          provenance: item.qualificationProof.provenance,
          reader: {
            ...item.qualificationProof.reader,
            freshness: { ...item.qualificationProof.reader.freshness },
          },
        }
    : undefined;
  const frozen = deepFreeze({
    ...item,
    ...(proof ? { qualificationProof: proof } : {}),
  });
  if (proof && frozen.qualificationProof) {
    if (sourceProof && NIR1_AUTHORITY_PROOFS.has(sourceProof)) {
      NIR1_AUTHORITY_PROOFS.add(frozen.qualificationProof);
    }
    if (sourceProof && NIR1_FIXTURE_PROOFS.has(sourceProof)) {
      NIR1_FIXTURE_PROOFS.add(frozen.qualificationProof);
    }
  }
  return frozen;
}

function freezeItems(
  items: readonly Nir1PackingItem[],
): readonly Nir1PackingItem[] {
  return Object.freeze(items.map((item) => freezeItem(item)));
}

function validateBudget(budget: Nir1PackingBudget): Nir1BudgetBreakdown {
  if (!budget || typeof budget !== "object") {
    throw new TypeError("budget must be an object");
  }
  const record = budget as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (
      !NIR1_BUDGET_FIELDS.includes(key as (typeof NIR1_BUDGET_FIELDS)[number])
    ) {
      throw new TypeError(`budget.${key} is not part of the frozen budget`);
    }
  }
  for (const key of NIR1_BUDGET_FIELDS) {
    if (!Object.hasOwn(record, key)) {
      throw new TypeError(`budget.${key} is required`);
    }
    requireNonNegativeSafeInteger(record[key] as number, `budget.${key}`);
  }
  const reservedTokens =
    budget.systemTokens +
    budget.historyTokens +
    budget.toolTokens +
    budget.responseReservationTokens;
  if (budget.contextWindowTokens <= reservedTokens) {
    throw new RangeError("budget must leave a positive context budget");
  }
  return Object.freeze({
    ...budget,
    reservedTokens,
    contextBudgetTokens: budget.contextWindowTokens - reservedTokens,
  });
}

function validateItems(items: readonly Nir1PackingItem[]): void {
  const ids = new Set<string>();
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object")
      throw new TypeError(`items[${index}] must be an object`);
    requireNonEmptyString(item.id, `items[${index}].id`);
    if (ids.has(item.id))
      throw new TypeError(`duplicate NIR-1 packing item id: ${item.id}`);
    ids.add(item.id);
    requireNonEmptyString(item.text, `items[${index}].text`);
    requirePositiveSafeInteger(item.tokens, `items[${index}].tokens`);
    if (!NIR1_PACKING_KINDS.includes(item.kind)) {
      throw new TypeError(
        `unsupported NIR-1 packing item kind: ${String(item.kind)}`,
      );
    }
    if (item.kind === "raw") {
      if (
        item.atomicGroup !== undefined ||
        item.atomicPart !== undefined ||
        item.qualificationProof !== undefined
      ) {
        throw new TypeError(
          `Raw item ${item.id} must not carry atomic group metadata`,
        );
      }
      continue;
    }
    requireNonEmptyString(item.atomicGroup, `items[${index}].atomicGroup`);
    if (!NIR1_ATOMIC_PARTS.includes(item.atomicPart as Nir1AtomicPart)) {
      throw new TypeError(
        `items[${index}].atomicPart is incomplete or unknown`,
      );
    }
    if (item.qualificationProof !== undefined) {
      if (
        item.qualificationProof.provenance !== "fixture-only" &&
        item.qualificationProof.provenance !== "native-a2-current-reader"
      ) {
        throw new TypeError(`unsupported qualification provenance: ${item.id}`);
      }
      if (item.kind !== "accepted-ir" && item.kind !== "graph-evidence") {
        throw new TypeError(
          `only accepted-ir and graph-evidence may carry a qualification proof: ${item.id}`,
        );
      }
      validateReaderShape(
        item.qualificationProof.reader,
        `items[${index}].qualificationProof.reader`,
        item.qualificationProof.provenance === "fixture-only"
          ? "fixture-only-a2-current-reader"
          : "native-a2-current-reader",
      );
    }
  }
}

function authorityForKind(
  kind: Nir1PackingKind,
): ContextItem<Nir1PackingPayload, Nir1PackingKind>["authority"] {
  switch (kind) {
    case "raw":
      return "author_instruction";
    case "accepted-ir":
      return "canonical";
    case "graph-evidence":
      return "derived";
    case "author-declared":
      // Keep the shared packing order canonical > derived > declared.  Raw
      // remains the explicit author instruction and is always retained.
      return "canonical";
    case "unreviewed-for-review":
      return "episodic";
  }
}

function priorityForKind(kind: Nir1PackingKind): number {
  switch (kind) {
    case "raw":
      return 100;
    case "accepted-ir":
      return 80;
    case "graph-evidence":
      return 70;
    case "author-declared":
      return 60;
    case "unreviewed-for-review":
      return 10;
  }
}

function itemProjection(
  item: Nir1PackingItem,
  includeQualificationProof = true,
): Record<string, unknown> {
  return {
    id: item.id,
    kind: item.kind,
    text: item.text,
    tokens: item.tokens,
    atomicGroup: item.atomicGroup ?? null,
    atomicPart: item.atomicPart ?? null,
    stability: item.stability ?? null,
    ...(includeQualificationProof
      ? { qualificationProof: item.qualificationProof ?? null }
      : {}),
  };
}

function itemsFingerprint(items: readonly Nir1PackingItem[]): string {
  return JSON.stringify(items.map((item) => itemProjection(item)));
}

function budgetProjection(budget: Nir1PackingBudget): Nir1PackingBudget {
  return {
    contextWindowTokens: budget.contextWindowTokens,
    systemTokens: budget.systemTokens,
    historyTokens: budget.historyTokens,
    toolTokens: budget.toolTokens,
    responseReservationTokens: budget.responseReservationTokens,
  };
}

function bindingProjection(binding: Nir1CacheBinding | undefined): unknown {
  return binding
    ? {
        scopeToken: binding.scopeToken,
        sourceToken: binding.sourceToken,
        revisionId: binding.revisionId,
        decisionId: binding.decisionId,
        freshnessToken: binding.freshnessToken,
        indexGeneration: binding.indexGeneration,
      }
    : null;
}

function isValidCacheBinding(binding: unknown): binding is Nir1CacheBinding {
  if (!binding || typeof binding !== "object") return false;
  const record = binding as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        !NIR1_CACHE_BINDING_FIELDS.includes(
          key as (typeof NIR1_CACHE_BINDING_FIELDS)[number],
        ),
    )
  ) {
    return false;
  }
  return NIR1_CACHE_BINDING_FIELDS.every((key) => {
    const value = record[key];
    return typeof value === "string" && value.trim().length > 0;
  });
}

function requestFingerprint(input: {
  readonly items: readonly Nir1PackingItem[];
  readonly budget: Nir1PackingBudget;
  readonly purpose: Nir1PackingPurpose;
  readonly requestId: string;
  readonly binding?: Nir1CacheBinding;
  readonly qualificationMode: Nir1QualificationMode;
}): string {
  return JSON.stringify({
    items: JSON.parse(itemsFingerprint(input.items)),
    budget: budgetProjection(input.budget),
    purpose: input.purpose,
    requestId: input.requestId,
    qualificationMode: input.qualificationMode,
    selectionValidityFingerprint: selectionValidityFingerprint(
      input.items,
      input.purpose,
      input.qualificationMode,
    ),
    binding: bindingProjection(input.binding),
  });
}

function sameItem(left: Nir1PackingItem, right: Nir1PackingItem): boolean {
  return (
    JSON.stringify(itemProjection(left)) ===
    JSON.stringify(itemProjection(right))
  );
}

function singleItemGroup(
  item: Nir1PackingItem,
  index: number,
): Nir1PackingGroup {
  return {
    groupId: item.id,
    kind: item.kind,
    items: Object.freeze([item]),
    tokens: item.tokens,
    firstIndex: index,
  };
}

function toContextItem(
  group: Nir1PackingGroup,
  boostQualifiedEvidence = false,
): Nir1ContextItem {
  const items = Object.freeze([...group.items]);
  const contextKey =
    group.kind === "raw" ? `raw:${group.groupId}` : `group:${group.groupId}`;
  const payload = Object.freeze({
    groupId: group.groupId,
    itemIds: Object.freeze(items.map((item) => item.id)),
    items,
    tokens: group.tokens,
  });
  const qualifiedEvidence =
    boostQualifiedEvidence &&
    group.kind === "graph-evidence" &&
    group.items.every(
      (item) =>
        isCurrentReaderProof(item.qualificationProof) ||
        isFixtureReaderProof(item.qualificationProof),
    );
  return Object.freeze({
    key: contextKey,
    kind: group.kind,
    authority: qualifiedEvidence ? "canonical" : authorityForKind(group.kind),
    // The candidate's only measured improvement is that a complete,
    // qualified Graph/Evidence unit competes as one high-value unit.  The
    // frozen baseline uses the unboosted per-item priority below.
    priority: priorityForKind(group.kind) + (qualifiedEvidence ? 30 : 0),
    stability: items.some((item) => item.stability === "turn-volatile")
      ? "turn-volatile"
      : "session-stable",
    trim: Object.freeze({
      mode: "atomic" as const,
      minTokens: group.tokens,
      maxTokens: group.tokens,
    }),
    provenance: Object.freeze({
      sourceType: "nir1-packing",
      sourceId: contextKey,
    }),
    payload,
  });
}

function groupItems(
  items: readonly Nir1PackingItem[],
  purpose: Nir1PackingPurpose,
  qualificationMode: Nir1QualificationMode,
): {
  readonly groups: readonly Nir1PackingGroup[];
  readonly rejectedGroups: readonly string[];
} {
  const grouped = new Map<
    string,
    {
      items: Nir1PackingItem[];
      indexes: number[];
      firstIndex: number;
      kind?: Nir1PackingKind;
      proofFingerprint?: string;
      parts: Set<Nir1AtomicPart>;
      invalid: boolean;
    }
  >();
  const rawGroups: Nir1PackingGroup[] = [];
  for (const [index, item] of items.entries()) {
    if (item.kind === "raw") {
      rawGroups.push(singleItemGroup(item, index));
      continue;
    }
    const group = grouped.get(item.atomicGroup!);
    if (group) {
      group.items.push(item);
      group.indexes.push(index);
      if (group.kind !== item.kind) group.invalid = true;
      if (group.parts.has(item.atomicPart!)) group.invalid = true;
      group.parts.add(item.atomicPart!);
      const proof = qualificationFingerprint(item.qualificationProof);
      if (group.proofFingerprint !== proof) group.invalid = true;
      if (
        (item.kind === "accepted-ir" || item.kind === "graph-evidence") &&
        !isSelectableQualificationProof(
          item.qualificationProof,
          qualificationMode,
        )
      ) {
        group.invalid = true;
      }
      if (
        (item.kind === "author-declared" ||
          item.kind === "unreviewed-for-review") &&
        item.qualificationProof !== undefined
      ) {
        group.invalid = true;
      }
    } else {
      grouped.set(item.atomicGroup!, {
        items: [item],
        indexes: [index],
        firstIndex: index,
        kind: item.kind,
        proofFingerprint: qualificationFingerprint(item.qualificationProof),
        parts: new Set([item.atomicPart!]),
        invalid:
          item.kind === "accepted-ir" || item.kind === "graph-evidence"
            ? !isSelectableQualificationProof(
                item.qualificationProof,
                qualificationMode,
              )
            : item.qualificationProof !== undefined,
      });
    }
  }

  const rejectedGroups: string[] = [];
  for (const [groupId, group] of grouped.entries()) {
    const interleaved = group.indexes.some((index, offset) => {
      if (offset === 0) return false;
      for (
        let cursor = group.indexes[offset - 1] + 1;
        cursor < index;
        cursor += 1
      ) {
        if (items[cursor]?.atomicGroup !== groupId) return true;
      }
      return false;
    });
    const complete =
      !group.invalid &&
      group.kind !== undefined &&
      group.parts.size === NIR1_ATOMIC_PARTS.length &&
      group.items.length === NIR1_ATOMIC_PARTS.length &&
      NIR1_ATOMIC_PARTS.every((part) => group.parts.has(part)) &&
      !interleaved &&
      !(purpose === "writing" && group.kind === "unreviewed-for-review");
    if (!complete) {
      rejectedGroups.push(groupId);
      continue;
    }
    rawGroups.push({
      groupId,
      kind: group.kind!,
      items: Object.freeze([...group.items]),
      tokens: group.items.reduce((total, item) => total + item.tokens, 0),
      firstIndex: group.firstIndex,
    });
  }
  rawGroups.sort((left, right) => left.firstIndex - right.firstIndex);
  rejectedGroups.sort(
    (left, right) =>
      items.findIndex((item) => item.atomicGroup === left) -
      items.findIndex((item) => item.atomicGroup === right),
  );
  return {
    groups: Object.freeze(rawGroups),
    rejectedGroups: Object.freeze(rejectedGroups),
  };
}

/**
 * Cache identity includes the proof brand and the complete-group validity that
 * the current selector will actually use. A structured clone keeps the JSON
 * fields but loses the in-process authority brand, so it must not reuse a plan.
 */
function selectionValidityFingerprint(
  items: readonly Nir1PackingItem[],
  purpose: Nir1PackingPurpose,
  qualificationMode: Nir1QualificationMode,
): string {
  const grouped = groupItems(items, purpose, qualificationMode);
  return JSON.stringify({
    mode: qualificationMode,
    proofAuthenticity: items.map((item) => ({
      id: item.id,
      kind: item.kind,
      proof: isCurrentReaderProof(item.qualificationProof)
        ? "native"
        : isFixtureReaderProof(item.qualificationProof)
          ? "fixture"
          : item.qualificationProof
            ? "unverified"
            : "missing",
    })),
    validGroups: grouped.groups.map((group) => ({
      groupId: group.groupId,
      kind: group.kind,
      itemIds: group.items.map((item) => item.id),
      tokens: group.tokens,
      firstIndex: group.firstIndex,
    })),
    rejectedGroups: grouped.rejectedGroups,
  });
}

function createBaselineFromFrozenItems(
  budget: Nir1BudgetBreakdown,
  items: readonly Nir1PackingItem[],
  predeclaredImprovement: typeof NIR1_PREDECLARED_IMPROVEMENT,
): Nir1PackingBaseline {
  const frozenItems = Object.freeze(items.map((item) => freezeItem(item)));
  const mapping = Object.freeze(
    frozenItems.map((item) => Object.freeze({ id: item.id, kind: item.kind })),
  );
  const tokenMeasurement: Nir1TokenMeasurement = Object.freeze({
    measureSelectionTokens: (contextItems: readonly Nir1ContextItem[]) =>
      contextItems.reduce(
        (total: number, item: Nir1ContextItem) => total + item.payload.tokens,
        0,
      ),
    measureItemTokens: (item: Nir1ContextItem) => item.payload.tokens,
  });
  return Object.freeze({
    items: frozenItems,
    mapping,
    budget: Object.freeze({
      contextWindowTokens: budget.contextWindowTokens,
      systemTokens: budget.systemTokens,
      historyTokens: budget.historyTokens,
      toolTokens: budget.toolTokens,
      responseReservationTokens: budget.responseReservationTokens,
    }),
    totalBudget: budget,
    contextBudgetTokens: budget.contextBudgetTokens,
    tokenMeasurement,
    measurementVersion: NIR1_BASELINE_MEASUREMENT_VERSION,
    materialFingerprint: itemsFingerprint(frozenItems),
    predeclaredImprovement,
  });
}

export function createNir1PackingBaseline(
  input: CreateNir1PackingBaselineInput,
): Nir1PackingBaseline {
  const totalBudget = validateBudget(input.budget);
  const items = freezeItems(input.items);
  validateItems(items);
  const predeclaredImprovement = Object.freeze({
    ...(input.predeclaredImprovement ?? NIR1_PREDECLARED_IMPROVEMENT),
  });
  return createBaselineFromFrozenItems(
    totalBudget,
    items,
    predeclaredImprovement,
  );
}

export const createNir1RawPriorityBaseline = createNir1PackingBaseline;

function sameBudget(
  left: Nir1PackingBudget,
  right: Nir1PackingBudget,
): boolean {
  return (
    left.contextWindowTokens === right.contextWindowTokens &&
    left.systemTokens === right.systemTokens &&
    left.historyTokens === right.historyTokens &&
    left.toolTokens === right.toolTokens &&
    left.responseReservationTokens === right.responseReservationTokens
  );
}

function isDeepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== "object") return true;
  const object = value as object;
  if (seen.has(object)) return true;
  if (!Object.isFrozen(object)) return false;
  seen.add(object);
  return Object.values(value as Record<string, unknown>).every((entry) =>
    isDeepFrozen(entry, seen),
  );
}

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

/**
 * A cached plan is reusable only when it came from this factory and all of
 * its derived projections still describe the same one-pass selection. A
 * spread/structured clone has no factory brand; a nested mutation cannot
 * survive the factory's deep freeze, but this check also catches a foreign
 * object that happens to resemble the public shape.
 */
function isCanonicalNir1ContextPlan(
  cachedPlan: Nir1ContextPlan,
  requestId: string,
): boolean {
  try {
    if (
      !NIR1_CONTEXT_PLANS.has(cachedPlan as object) ||
      !isDeepFrozen(cachedPlan) ||
      cachedPlan.selectionCount !== 1 ||
      cachedPlan.plan.requestId !== requestId
    ) {
      return false;
    }
    const selectedIds = cachedPlan.selectedItems.map((item) => item.id);
    if (!sameStringArray(selectedIds, cachedPlan.selectedIds)) return false;
    const planItems = cachedPlan.plan.items;
    const cacheItems = cachedPlan.cache.selectedItems;
    if (JSON.stringify(planItems) !== JSON.stringify(cacheItems)) return false;
    if (
      !sameStringArray(
        cachedPlan.cache.selectedKeys,
        planItems.map((item) => item.key),
      )
    ) {
      return false;
    }
    const contextIds = planItems.flatMap((item) => item.payload.itemIds);
    if (!sameStringArray(contextIds, selectedIds)) return false;
    if (!sameStringArray(cachedPlan.cache.selectedIds, selectedIds))
      return false;
    const contextText = planItems.flatMap((item) =>
      item.payload.items.map((candidate) => candidate.text),
    );
    if (
      !sameStringArray(
        contextText,
        cachedPlan.selectedItems.map((item) => item.text),
      )
    ) {
      return false;
    }
    const selectedDecisionKeys = cachedPlan.plan.decisions
      .filter((decision) => decision.status === "selected")
      .map((decision) => decision.key);
    if (
      !sameStringArray(
        selectedDecisionKeys,
        planItems.map((item) => item.key),
      )
    ) {
      return false;
    }
    const candidateTokens = cachedPlan.plan.decisions.reduce(
      (total, decision) => total + decision.tokensBefore,
      0,
    );
    const selectedTokens = cachedPlan.plan.decisions.reduce(
      (total, decision) => total + decision.tokensAfter,
      0,
    );
    if (
      cachedPlan.plan.usage.candidateTokens !== candidateTokens ||
      cachedPlan.plan.usage.selectedTokens !== selectedTokens ||
      cachedPlan.plan.usage.trimmedTokens !==
        Math.max(0, candidateTokens - selectedTokens)
    ) {
      return false;
    }
    const { digest, ...draft } = cachedPlan.plan;
    return digest === computeContextPlanDigest(draft);
  } catch {
    return false;
  }
}

function assertFrozenBaselineInput(
  baseline: Nir1PackingBaseline,
  items: readonly Nir1PackingItem[],
  budget: Nir1PackingBudget,
): readonly Nir1PackingItem[] {
  const frozenItems = freezeItems(items);
  validateItems(frozenItems);
  if (
    !Object.isFrozen(baseline) ||
    !Object.isFrozen(baseline.items) ||
    !baseline.items.every((item) => Object.isFrozen(item)) ||
    !Object.isFrozen(baseline.mapping) ||
    !baseline.mapping.every((mapping) => Object.isFrozen(mapping)) ||
    !Object.isFrozen(baseline.budget) ||
    !Object.isFrozen(baseline.totalBudget) ||
    !Object.isFrozen(baseline.tokenMeasurement) ||
    !Object.isFrozen(baseline.predeclaredImprovement)
  ) {
    throw new TypeError(
      "NIR-1 baseline must remain deeply frozen after creation",
    );
  }
  if (baseline.measurementVersion !== NIR1_BASELINE_MEASUREMENT_VERSION) {
    throw new TypeError("NIR-1 baseline token measurement version changed");
  }
  const expectedBudget = validateBudget(budget);
  if (
    !sameBudget(baseline.budget, budget) ||
    !sameBudget(baseline.totalBudget, budget) ||
    baseline.totalBudget.reservedTokens !== expectedBudget.reservedTokens ||
    baseline.totalBudget.contextBudgetTokens !==
      expectedBudget.contextBudgetTokens ||
    baseline.contextBudgetTokens !== expectedBudget.contextBudgetTokens
  ) {
    throw new TypeError(
      "NIR-1 packing baseline budget cannot change after freeze",
    );
  }
  if (
    JSON.stringify(baseline.predeclaredImprovement) !==
    JSON.stringify(NIR1_PREDECLARED_IMPROVEMENT)
  ) {
    throw new TypeError(
      "NIR-1 predeclared improvement slot cannot change after freeze",
    );
  }
  if (
    typeof baseline.tokenMeasurement.measureSelectionTokens !== "function" ||
    typeof baseline.tokenMeasurement.measureItemTokens !== "function"
  ) {
    throw new TypeError(
      "NIR-1 baseline token measurement cannot change after freeze",
    );
  }
  if (frozenItems.length !== baseline.items.length) {
    throw new TypeError(
      "NIR-1 packing baseline input length cannot change after freeze",
    );
  }
  for (const [index, item] of frozenItems.entries()) {
    const frozen = baseline.items[index];
    const mapping = baseline.mapping[index];
    if (!frozen || !mapping || !sameItem(item, frozen)) {
      throw new TypeError(
        `NIR-1 packing baseline item ${item.id} changed kind, text, tokens, group, part, proof, or order`,
      );
    }
    if (mapping.id !== item.id || mapping.kind !== item.kind) {
      throw new TypeError(
        "NIR-1 packing baseline mapping changed after freeze",
      );
    }
    const probe = toContextItem(singleItemGroup(item, index));
    if (
      baseline.tokenMeasurement.measureItemTokens(probe) !== item.tokens ||
      baseline.tokenMeasurement.measureSelectionTokens([probe]) !== item.tokens
    ) {
      throw new TypeError(
        "NIR-1 baseline token measurement changed after freeze",
      );
    }
  }
  if (itemsFingerprint(frozenItems) !== baseline.materialFingerprint) {
    throw new TypeError(
      "NIR-1 packing baseline material fingerprint changed after freeze",
    );
  }
  return frozenItems;
}

function selectedIdsFromContextItems(
  contextItems: readonly Nir1ContextItem[],
): Set<string> {
  return new Set(contextItems.flatMap((item) => item.payload.itemIds));
}

function materializeSelection(
  baseline: Nir1PackingBaseline,
  sourceItems: readonly Nir1PackingItem[],
  contextItems: readonly Nir1ContextItem[],
  selection: ContextItemSelection<Nir1PackingPayload, Nir1PackingKind>,
  rejectedGroups: readonly string[],
  arm: Nir1PackingSelection["arm"],
  qualificationMode: "native" | "fixture",
): Nir1PackingSelection {
  const selectedContextItems = Object.freeze([...selection.selectedItems]);
  const selectedIdSet = selectedIdsFromContextItems(selectedContextItems);
  // Reconstruct from the exact member IDs emitted by the selector. Group IDs
  // are metadata and may legally collide with a Raw item ID.
  const selectedItems = Object.freeze(
    sourceItems.filter((item) => selectedIdSet.has(item.id)),
  );
  const selectedIds = Object.freeze(selectedItems.map((item) => item.id));
  const omittedIds = Object.freeze(
    sourceItems
      .filter((item) => !selectedIdSet.has(item.id))
      .map((item) => item.id),
  );
  const exactUsedTokens = selectedItems.reduce(
    (total, item) => total + item.tokens,
    0,
  );
  const exactCandidateTokens =
    baseline.tokenMeasurement.measureSelectionTokens(contextItems);
  const cacheBase = planContextCache(selectedContextItems);
  const cacheSelectedIds = Object.freeze(
    cacheBase.selectedItems.flatMap((item) => item.payload.itemIds),
  );
  if (
    cacheSelectedIds.length !== selectedIds.length ||
    cacheSelectedIds.some((id, index) => id !== selectedIds[index])
  ) {
    throw new TypeError(
      "NIR-1 selected order must be identical across selector, ContextPlan, and cache",
    );
  }
  const cache: Nir1CachePlan = Object.freeze({
    ...cacheBase,
    selectedItems: Object.freeze([...cacheBase.selectedItems]),
    selectedKeys: Object.freeze([...cacheBase.selectedKeys]),
    stableItems: Object.freeze([...cacheBase.stableItems]),
    volatileItems: Object.freeze([...cacheBase.volatileItems]),
    selectedIds: cacheSelectedIds,
    droppedIds: Object.freeze([]),
  });
  const qualifiedGroupIds = Object.freeze(
    selectedContextItems
      .filter(
        (item) => item.kind === "accepted-ir" || item.kind === "graph-evidence",
      )
      .filter((item) =>
        item.payload.items.every((candidate) =>
          isSelectableQualificationProof(
            candidate.qualificationProof,
            qualificationMode,
          ),
        ),
      )
      .map((item) => item.payload.groupId),
  );
  const selectedText = Object.freeze(selectedItems.map((item) => item.text));
  return Object.freeze({
    arm,
    selectedItems,
    selectedIds,
    omittedIds,
    rejectedGroups: Object.freeze([...rejectedGroups]),
    decisions: Object.freeze(selection.decisions),
    usedTokens: exactUsedTokens,
    exactUsedTokens,
    candidateTokens: exactCandidateTokens,
    exactCandidateTokens,
    contextBudgetTokens: baseline.contextBudgetTokens,
    exactContextBudgetTokens: baseline.contextBudgetTokens,
    proseOrder: selectedIds,
    selectedText,
    proseText: selectedText,
    qualifiedGroupIds,
    cache,
    contextItems: selectedContextItems,
  });
}

function purposeExcludedIds(
  items: readonly Nir1PackingItem[],
  purpose: Nir1PackingPurpose,
): { readonly ids: ReadonlySet<string>; readonly groups: readonly string[] } {
  if (purpose === "review")
    return { ids: new Set(), groups: Object.freeze([]) };
  const groups = new Map<string, Nir1PackingItem[]>();
  for (const item of items) {
    if (item.kind !== "unreviewed-for-review") continue;
    const group = groups.get(item.atomicGroup!);
    if (group) group.push(item);
    else groups.set(item.atomicGroup!, [item]);
  }
  const ids = new Set<string>();
  const groupIds: string[] = [];
  for (const [groupId, group] of groups) {
    // Writing is fail-closed for the whole unreviewed material group. This
    // applies before either arm invokes the shared selector.
    group.forEach((item) => ids.add(item.id));
    groupIds.push(groupId);
  }
  return { ids, groups: Object.freeze(groupIds) };
}

/**
 * Candidate packing's shared algorithm: required Raw units are admitted first,
 * then complete groups are considered by the canonical kind rank and original
 * input position. A group that does not fit is skipped so a later smaller group
 * can still use the remaining budget. Rust mirrors this exact ordering.
 */
function candidateKindRank(kind: Nir1PackingKind): number {
  switch (kind) {
    case "raw":
      return 5;
    case "graph-evidence":
      return 4;
    case "accepted-ir":
      return 3;
    case "author-declared":
      return 2;
    case "unreviewed-for-review":
      return 1;
  }
}

function selectCandidateContextItems(
  input: Readonly<{
    readonly items: readonly Nir1ContextItem[];
    readonly budgetTokens: number;
    readonly measureSelectionTokens: Nir1TokenMeasurement["measureSelectionTokens"];
    readonly measureItemTokens: Nir1TokenMeasurement["measureItemTokens"];
  }>,
): ContextItemSelection<Nir1PackingPayload, Nir1PackingKind> {
  const items = [...input.items];
  const itemTokens = items.map((item, index) => {
    const tokens = input.measureItemTokens(item);
    requireNonNegativeSafeInteger(tokens, `candidateItemTokens[${index}]`);
    return tokens;
  });
  const candidateTokens = input.measureSelectionTokens(items);
  requireNonNegativeSafeInteger(candidateTokens, "candidateTokens");
  const selected = new Set<number>();
  let usedTokens = 0;

  for (const [index, item] of items.entries()) {
    if (item.kind !== "raw") continue;
    selected.add(index);
    usedTokens += itemTokens[index];
  }
  if (usedTokens > input.budgetTokens) {
    throw new RangeError(
      "required Raw context does not fit the context budget",
    );
  }

  const candidates = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind !== "raw")
    .sort(
      (left, right) =>
        candidateKindRank(right.item.kind) -
          candidateKindRank(left.item.kind) || left.index - right.index,
    );
  for (const candidate of candidates) {
    const nextTokens = usedTokens + itemTokens[candidate.index];
    if (nextTokens > input.budgetTokens) continue;
    usedTokens = nextTokens;
    selected.add(candidate.index);
  }

  const selectedItems = items.filter((_, index) => selected.has(index));
  const selectedTokens = input.measureSelectionTokens(selectedItems);
  requireNonNegativeSafeInteger(selectedTokens, "selectedTokens");
  return {
    selectedItems,
    decisions: items.map((item, index) => {
      const isSelected = selected.has(index);
      return {
        key: item.key,
        status: isSelected ? "selected" : "trimmed",
        reason: isSelected ? "within-budget" : "budget-priority",
        tokensBefore: itemTokens[index],
        tokensAfter: isSelected ? itemTokens[index] : 0,
      };
    }),
    usage: {
      candidateTokens,
      selectedTokens,
      trimmedTokens: Math.max(0, candidateTokens - selectedTokens),
      budgetTokens: input.budgetTokens,
    },
  };
}

function selectWithSharedMeasurement(
  baseline: Nir1PackingBaseline,
  sourceItems: readonly Nir1PackingItem[],
  contextItems: readonly Nir1ContextItem[],
  rejectedGroups: readonly string[],
  arm: Nir1PackingSelection["arm"],
  qualificationMode: Nir1QualificationMode,
): Nir1PackingSelection {
  const rawTokens = sourceItems
    .filter((item) => item.kind === "raw")
    .reduce((total, item) => total + item.tokens, 0);
  if (!sourceItems.some((item) => item.kind === "raw")) {
    throw new RangeError("at least one required Raw context item is needed");
  }
  if (rawTokens > baseline.contextBudgetTokens) {
    throw new RangeError(
      "required Raw context does not fit the context budget",
    );
  }
  const selection =
    arm === "raw-priority-baseline"
      ? selectContextItems({
          items: contextItems,
          budgetTokens: baseline.contextBudgetTokens,
          measureSelectionTokens:
            baseline.tokenMeasurement.measureSelectionTokens,
          measureItemTokens: baseline.tokenMeasurement.measureItemTokens,
        })
      : selectCandidateContextItems({
          items: contextItems,
          budgetTokens: baseline.contextBudgetTokens,
          measureSelectionTokens:
            baseline.tokenMeasurement.measureSelectionTokens,
          measureItemTokens: baseline.tokenMeasurement.measureItemTokens,
        });
  return materializeSelection(
    baseline,
    sourceItems,
    contextItems,
    selection,
    rejectedGroups,
    arm,
    qualificationMode,
  );
}

/** The existing selector, frozen to the Raw-priority input/configuration. */
export function selectNir1RawPriorityBaseline(
  input: SelectNir1PackingItemsInput,
): Nir1PackingSelection {
  const baseline =
    input.baseline ??
    createNir1PackingBaseline({ budget: input.budget, items: input.items });
  const frozenItems = assertFrozenBaselineInput(
    baseline,
    input.items,
    input.budget,
  );
  // The baseline and candidate must see the same frozen material.  The
  // baseline ignores qualification for ranking, while preserving it in its
  // output so P-12 can prove the measured selection difference directly.
  const baselineItems = frozenItems;
  const purpose = input.purpose ?? "writing";
  const excluded = purposeExcludedIds(baselineItems, purpose);
  const eligibleItems = baselineItems.filter(
    (item) => !excluded.ids.has(item.id),
  );
  const contextItems = Object.freeze(
    eligibleItems.map((item, index) =>
      toContextItem(singleItemGroup(item, index)),
    ),
  );
  return selectWithSharedMeasurement(
    baseline,
    baselineItems,
    contextItems,
    excluded.groups,
    "raw-priority-baseline",
    "native",
  );
}

export function selectNir1PackingItems(
  input: SelectNir1PackingItemsInput,
): Nir1PackingSelection {
  const baseline =
    input.baseline ??
    createNir1PackingBaseline({ budget: input.budget, items: input.items });
  const frozenItems = assertFrozenBaselineInput(
    baseline,
    input.items,
    input.budget,
  );
  const purpose = input.purpose ?? "writing";
  const qualificationMode = normalizeQualificationMode(input.qualificationMode);
  const { groups, rejectedGroups } = groupItems(
    frozenItems,
    purpose,
    qualificationMode,
  );
  const contextItems = Object.freeze(
    groups.map((group) => toContextItem(group, true)),
  );
  return selectWithSharedMeasurement(
    baseline,
    frozenItems,
    contextItems,
    rejectedGroups,
    "candidate",
    qualificationMode,
  );
}

export const selectNir1PackingBaseline = selectNir1RawPriorityBaseline;

export function createNir1ContextPlan(
  input: CreateNir1ContextPlanInput,
): Nir1ContextPlan {
  const requestId = input.requestId ?? "nir1-d1-context";
  const purpose = input.purpose ?? "writing";
  const qualificationMode = normalizeQualificationMode(input.qualificationMode);
  if (input.binding !== undefined && !isValidCacheBinding(input.binding)) {
    throw new TypeError(
      "NIR-1 cache binding must contain every identity component",
    );
  }
  const baseline =
    input.baseline ??
    createNir1PackingBaseline({ budget: input.budget, items: input.items });
  const frozenItems = assertFrozenBaselineInput(
    baseline,
    input.items,
    input.budget,
  );
  const selection = selectNir1PackingItems({
    ...input,
    baseline,
    purpose,
    qualificationMode,
  });
  const validityFingerprint = selectionValidityFingerprint(
    frozenItems,
    purpose,
    qualificationMode,
  );
  const plan = createContextPlan({
    requestId,
    items: selection.contextItems,
    decisions: selection.decisions,
    usage: {
      candidateTokens: selection.candidateTokens,
      selectedTokens: selection.usedTokens,
      trimmedTokens: Math.max(
        0,
        selection.candidateTokens - selection.usedTokens,
      ),
      budgetTokens: selection.contextBudgetTokens,
    },
  });
  const contextPlan: Nir1ContextPlan = deepFreeze({
    plan,
    selectedItems: selection.selectedItems,
    selectedIds: selection.selectedIds,
    cache: selection.cache,
    selectionCount: 1 as const,
    inputItems: frozenItems,
    inputFingerprint: requestFingerprint({
      items: frozenItems,
      budget: baseline.budget,
      purpose,
      requestId,
      binding: input.binding,
      qualificationMode,
    }),
    materialFingerprint: itemsFingerprint(frozenItems),
    qualificationMode,
    selectionValidityFingerprint: validityFingerprint,
    totalBudget: baseline.totalBudget,
    requestContext: Object.freeze({ requestId, purpose, qualificationMode }),
    ...(input.binding ? { binding: deepFreeze({ ...input.binding }) } : {}),
  });
  NIR1_CONTEXT_PLANS.add(contextPlan as object);
  return contextPlan;
}

export function isNir1CacheBindingCurrent(
  cached: Nir1CacheBinding,
  current: Nir1CacheBinding,
): boolean {
  if (!isValidCacheBinding(cached) || !isValidCacheBinding(current))
    return false;
  return (
    cached.scopeToken === current.scopeToken &&
    cached.sourceToken === current.sourceToken &&
    cached.revisionId === current.revisionId &&
    cached.decisionId === current.decisionId &&
    cached.freshnessToken === current.freshnessToken &&
    cached.indexGeneration === current.indexGeneration
  );
}

export function replanNir1Context(
  input: ReplanNir1ContextInput,
): Nir1ContextPlan {
  const requestId = input.requestId ?? "nir1-d1-context";
  const purpose = input.purpose ?? "writing";
  const qualificationMode = normalizeQualificationMode(input.qualificationMode);
  if (input.binding !== undefined && !isValidCacheBinding(input.binding)) {
    throw new TypeError(
      "NIR-1 cache binding must contain every identity component",
    );
  }
  const cachedPlan = input.cachedPlan;
  // `cachedPlan.binding` is the only cached identity considered. The legacy
  // caller hint is intentionally ignored so two caller-supplied equal
  // bindings cannot authorize reuse.
  const cachedPlanBinding = cachedPlan?.binding;
  const bindingMatches =
    cachedPlanBinding !== undefined &&
    input.binding !== undefined &&
    isNir1CacheBindingCurrent(cachedPlanBinding, input.binding);
  const currentItems = freezeItems(input.items);
  validateItems(currentItems);
  const inputMaterialFingerprint = itemsFingerprint(currentItems);
  const currentValidityFingerprint = selectionValidityFingerprint(
    currentItems,
    purpose,
    qualificationMode,
  );
  const currentFingerprint = requestFingerprint({
    items: currentItems,
    budget: input.budget,
    purpose,
    requestId,
    binding: input.binding,
    qualificationMode,
  });
  const expectedTotalBudget = validateBudget(input.budget);
  const cachedInputMatches =
    cachedPlan !== undefined &&
    bindingMatches &&
    isCanonicalNir1ContextPlan(cachedPlan, requestId) &&
    cachedPlan.materialFingerprint === inputMaterialFingerprint &&
    cachedPlan.inputFingerprint === currentFingerprint &&
    cachedPlan.qualificationMode === qualificationMode &&
    cachedPlan.selectionValidityFingerprint === currentValidityFingerprint &&
    sameBudget(cachedPlan.totalBudget, input.budget) &&
    cachedPlan.totalBudget.reservedTokens ===
      expectedTotalBudget.reservedTokens &&
    cachedPlan.totalBudget.contextBudgetTokens ===
      expectedTotalBudget.contextBudgetTokens &&
    cachedPlan.requestContext.requestId === requestId &&
    cachedPlan.requestContext.purpose === purpose &&
    cachedPlan.requestContext.qualificationMode === qualificationMode &&
    itemsFingerprint(cachedPlan.inputItems) === inputMaterialFingerprint;
  if (cachedInputMatches) {
    return cachedPlan;
  }
  // A changed frozen input starts a new baseline snapshot. A stale caller
  // baseline is never allowed to make a changed item look cache-current.
  return createNir1ContextPlan({ ...input, baseline: undefined });
}

export function adaptNir1FixtureQualifiedInput(
  input: Nir1FixtureA2QualifiedInput,
): Nir1PackingItem {
  if (input.source !== "fixture-only-a2-adapter") {
    throw new TypeError(
      "fixture qualification must come from the fixture-only adapter",
    );
  }
  if (
    input.item.kind !== "accepted-ir" &&
    input.item.kind !== "graph-evidence"
  ) {
    throw new TypeError(
      "only accepted-ir and graph-evidence can carry an A2 qualification proof",
    );
  }
  if (
    (input.item as Partial<Nir1PackingItem>).qualificationProof !== undefined
  ) {
    throw new TypeError(
      "qualified input must not carry a caller-supplied qualification proof",
    );
  }
  validateCurrentReaderOutput(
    input.reader,
    "fixture-only A2 current-reader output",
    "fixture-only-a2-current-reader",
  );
  const adapted = freezeItem({
    ...input.item,
    qualificationProof: Object.freeze({
      provenance: "fixture-only" as const,
      reader: input.reader,
    }),
  });
  if (!adapted.qualificationProof) {
    throw new TypeError(
      "Native A2 adapter failed to create an authority proof",
    );
  }
  NIR1_FIXTURE_PROOFS.add(adapted.qualificationProof);
  return adapted;
}
