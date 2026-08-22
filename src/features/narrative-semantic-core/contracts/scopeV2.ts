import {
  digestStableJson,
  sha256Digest,
  stableJsonStringify,
} from "@/features/narrative-extraction/source/digest";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import { isContractNonEmptyString } from "./contractString";

/** The only Scope structural version admitted by the NIR-0 contract. */
export const SCOPE_V2_SCHEMA_VERSION = 2 as const;
export const SCOPE_V2_REGISTRY_VERSION = "narrative-scope/2" as const;

export const SCOPE_AXES = [
  "timeline",
  "worldline",
  "scene",
  "viewpoint",
  "knowledgeHolder",
  "audience",
  "narrativeLayer",
  "storyTime",
  "readingOrder",
] as const;
export type ScopeAxis = (typeof SCOPE_AXES)[number];

export const SCOPE_UNRESOLVED_REASONS = [
  "not-provided",
  "ambiguous",
  "missing-reference",
  "unsupported-axis",
  "legacy-axis-unknown",
] as const;
export type ScopeUnresolvedReason = (typeof SCOPE_UNRESOLVED_REASONS)[number];

export type ReferenceScopeConstraint =
  | { readonly kind: "any" }
  | { readonly kind: "exact"; readonly ref: string }
  | {
      readonly kind: "unresolved";
      readonly reason: ScopeUnresolvedReason;
      readonly constraintId?: string;
    };

export interface TemporalBoundary {
  readonly ref: string;
  readonly inclusive: boolean;
}

export type TemporalScopeConstraint =
  | { readonly kind: "any" }
  | {
      readonly kind: "interval";
      readonly from?: TemporalBoundary;
      readonly until?: TemporalBoundary;
    }
  | {
      readonly kind: "unresolved";
      readonly reason: ScopeUnresolvedReason;
      readonly constraintId?: string;
    };

export interface NarrativeScopeV2 {
  readonly schemaVersion: typeof SCOPE_V2_SCHEMA_VERSION;
  readonly registryVersion: typeof SCOPE_V2_REGISTRY_VERSION;

  readonly timeline: ReferenceScopeConstraint;
  readonly worldline: ReferenceScopeConstraint;
  readonly scene: ReferenceScopeConstraint;
  readonly viewpoint: ReferenceScopeConstraint;
  readonly knowledgeHolder: ReferenceScopeConstraint;
  readonly audience: ReferenceScopeConstraint;
  readonly narrativeLayer: ReferenceScopeConstraint;

  readonly storyTime: TemporalScopeConstraint;
  readonly readingOrder: TemporalScopeConstraint;
}

export type ScopeStructuralFailureReason =
  | "scope-must-be-object"
  | "unsupported-schema-version"
  | "unsupported-registry-version"
  | "unknown-axis"
  | "missing-axis"
  | "unsupported-constraint-kind"
  | "constraint-must-be-object"
  | "unknown-constraint-field"
  | "empty-reference"
  | "unsupported-unresolved-reason"
  | "invalid-constraint-id"
  | "interval-boundary-required"
  | "invalid-interval-boundary"
  | "unknown-interval-boundary-field";

export type ScopeStructuralValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: ScopeStructuralFailureReason;
      readonly path?: string;
    };

interface ValidationFailure {
  readonly valid: false;
  readonly reason: ScopeStructuralFailureReason;
  readonly path: string;
}

const REFERENCE_CONSTRAINT_KINDS = new Set(["any", "exact", "unresolved"]);
const TEMPORAL_CONSTRAINT_KINDS = new Set(["any", "interval", "unresolved"]);
const UNRESOLVED_REASON_SET = new Set<string>(SCOPE_UNRESOLVED_REASONS);
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): ValidationFailure | undefined {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  return unknown
    ? {
        valid: false,
        reason: "unknown-constraint-field",
        path: `${path}.${unknown}`,
      }
    : undefined;
}

function validateUnresolved(
  value: Record<string, unknown>,
  path: string,
): ValidationFailure | undefined {
  const unknownFields = rejectUnknownFields(
    value,
    new Set(["kind", "reason", "constraintId"]),
    path,
  );
  if (unknownFields) return unknownFields;
  if (!UNRESOLVED_REASON_SET.has(value.reason as string)) {
    return {
      valid: false,
      reason: "unsupported-unresolved-reason",
      path: `${path}.reason`,
    };
  }
  if (
    hasOwn(value, "constraintId") &&
    !isContractNonEmptyString(value.constraintId)
  ) {
    return {
      valid: false,
      reason: "invalid-constraint-id",
      path: `${path}.constraintId`,
    };
  }
  return undefined;
}

function validateReferenceConstraint(
  value: unknown,
  path: string,
): ValidationFailure | undefined {
  if (!isRecord(value)) {
    return { valid: false, reason: "constraint-must-be-object", path };
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !REFERENCE_CONSTRAINT_KINDS.has(kind)) {
    return {
      valid: false,
      reason: "unsupported-constraint-kind",
      path: `${path}.kind`,
    };
  }
  if (kind === "any") {
    return rejectUnknownFields(value, new Set(["kind"]), path) ?? undefined;
  }
  if (kind === "exact") {
    const unknownFields = rejectUnknownFields(
      value,
      new Set(["kind", "ref"]),
      path,
    );
    if (unknownFields) return unknownFields;
    return isContractNonEmptyString(value.ref)
      ? undefined
      : { valid: false, reason: "empty-reference", path: `${path}.ref` };
  }
  return validateUnresolved(value, path);
}

function validateTemporalBoundary(
  value: unknown,
  path: string,
): ValidationFailure | undefined {
  if (!isRecord(value)) {
    return { valid: false, reason: "invalid-interval-boundary", path };
  }
  const unknownFields = rejectUnknownFields(
    value,
    new Set(["ref", "inclusive"]),
    path,
  );
  if (unknownFields) {
    return {
      ...unknownFields,
      reason: "unknown-interval-boundary-field",
    };
  }
  if (
    !isContractNonEmptyString(value.ref) ||
    typeof value.inclusive !== "boolean"
  ) {
    return { valid: false, reason: "invalid-interval-boundary", path };
  }
  return undefined;
}

function validateTemporalConstraint(
  value: unknown,
  path: string,
): ValidationFailure | undefined {
  if (!isRecord(value)) {
    return { valid: false, reason: "constraint-must-be-object", path };
  }
  const kind = value.kind;
  if (typeof kind !== "string" || !TEMPORAL_CONSTRAINT_KINDS.has(kind)) {
    return {
      valid: false,
      reason: "unsupported-constraint-kind",
      path: `${path}.kind`,
    };
  }
  if (kind === "any") {
    return rejectUnknownFields(value, new Set(["kind"]), path);
  }
  if (kind === "unresolved") return validateUnresolved(value, path);

  const unknownFields = rejectUnknownFields(
    value,
    new Set(["kind", "from", "until"]),
    path,
  );
  if (unknownFields) return unknownFields;
  if (!hasOwn(value, "from") && !hasOwn(value, "until")) {
    return { valid: false, reason: "interval-boundary-required", path };
  }
  for (const boundary of ["from", "until"] as const) {
    if (!hasOwn(value, boundary)) continue;
    const result = validateTemporalBoundary(
      value[boundary],
      `${path}.${boundary}`,
    );
    if (result) return result;
  }
  return undefined;
}

/**
 * Validates only the structural Scope V2 contract. Registry and Oracle facts
 * are intentionally outside this function; callers must not infer relations
 * from a structurally valid scope.
 */
export function validateNarrativeScopeV2(
  value: unknown,
): ScopeStructuralValidationResult {
  if (!isRecord(value)) return { valid: false, reason: "scope-must-be-object" };
  if (value.schemaVersion !== SCOPE_V2_SCHEMA_VERSION) {
    return { valid: false, reason: "unsupported-schema-version" };
  }
  if (value.registryVersion !== SCOPE_V2_REGISTRY_VERSION) {
    return { valid: false, reason: "unsupported-registry-version" };
  }

  const topLevelKeys = new Set([
    "schemaVersion",
    "registryVersion",
    ...SCOPE_AXES,
  ]);
  const unknownKey = Object.keys(value).find((key) => !topLevelKeys.has(key));
  if (unknownKey) {
    return {
      valid: false,
      reason: "unknown-axis",
      path: unknownKey,
    };
  }
  for (const axis of SCOPE_AXES) {
    if (!hasOwn(value, axis)) {
      return { valid: false, reason: "missing-axis", path: axis };
    }
  }

  for (const axis of SCOPE_AXES) {
    const result =
      axis === "storyTime" || axis === "readingOrder"
        ? validateTemporalConstraint(value[axis], axis)
        : validateReferenceConstraint(value[axis], axis);
    if (result) return result;
  }
  return { valid: true };
}

export function assertNarrativeScopeV2(scope: NarrativeScopeV2): void {
  const result = validateNarrativeScopeV2(scope);
  if (!result.valid) {
    throw new TypeError(
      `Invalid Narrative Scope V2 at ${result.path ?? "scope"}: ${result.reason}`,
    );
  }
}

/** Returns the byte-level canonical JSON representation used by all digests. */
export function canonicalNarrativeScopeV2(scope: NarrativeScopeV2): string {
  assertNarrativeScopeV2(scope);
  return stableJsonStringify(scope);
}

export async function digestNarrativeScopeV2(
  scope: NarrativeScopeV2,
): Promise<Sha256Digest> {
  return sha256Digest(canonicalNarrativeScopeV2(scope));
}

/** Compatibility name for callers that already use the generic digest helper. */
export async function digestCanonicalNarrativeScopeV2(
  scope: NarrativeScopeV2,
): Promise<Sha256Digest> {
  assertNarrativeScopeV2(scope);
  return digestStableJson(scope);
}
