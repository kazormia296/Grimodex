import dependencyRolePolicy from "../../../../policies/narrative/narrative-dependency-role-registry.json";
import { sha256Hex } from "@grimodex/scan-contract";
import { stableJsonStringify } from "@/features/narrative-extraction/source/digest";
import { isContractTrimmedNonEmptyString } from "./contractString";

export const DEPENDENCY_ROLE_CONTRACT_VERSION =
  "narrative-dependency-role/1" as const;

export const DEPENDENCY_ROLE_IDS = [
  "direct-evidence",
  "opaque-model-context",
  "entity-resolution",
  "temporal-resolution",
  "scope-resolution",
  "projection-match",
  "author-correction",
  "component-contract",
  "quality-context",
  "ranking-only",
] as const;
export type DependencyRole = (typeof DEPENDENCY_ROLE_IDS)[number];

export const NARRATIVE_CONSUMER_KIND_IDS = [
  "narrative-extraction-run",
  "proposal-revision",
  "extraction-artifact",
  "application",
  "application-contribution",
  "derived-projection",
  "semantic-index",
  "narrative-ir-revision",
  "related-scenes-materialization",
  "chat-context-materialization",
  "structure-health-diagnostic",
] as const;
export type NarrativeConsumerKind =
  (typeof NARRATIVE_CONSUMER_KIND_IDS)[number];

export const SOURCE_CHANGE_CLASS_IDS = [
  "source-content-changed",
  "source-missing",
  "anchor-missing",
  "exact-content-relocated",
  "selected-set-collapsed",
  "component-unavailable",
  "quality-input-changed",
  "ranking-input-changed",
] as const;
export type SourceChangeClass = (typeof SOURCE_CHANGE_CLASS_IDS)[number];

export const DEPENDENCY_FRESHNESS_IDS = [
  "fresh",
  "stale",
  "source-missing",
  "anchor-mismatch",
  "read-set-drift",
  "unknown",
] as const;
export type DependencyFreshness = (typeof DEPENDENCY_FRESHNESS_IDS)[number];

export const DEPENDENCY_BUILD_ACTION_IDS = [
  "none",
  "revalidate-exact",
  "reanchor-candidate",
  "resolve-only",
  "recompile-only",
  "rebuild-required",
  "refresh-available",
  "manual",
] as const;
export type DependencyBuildAction =
  (typeof DEPENDENCY_BUILD_ACTION_IDS)[number];

export const REQUIRED_BUILD_ACTION_IDS = [
  "revalidate-exact",
  "reanchor-candidate",
  "resolve-only",
  "recompile-only",
  "rebuild-required",
  "manual",
] as const;
export type RequiredBuildAction = (typeof REQUIRED_BUILD_ACTION_IDS)[number];

export const ADVISORY_BUILD_ACTION_IDS = ["refresh-available"] as const;

export const FINDING_REASON_CODE_IDS = [
  "source-revision-changed",
  "source-missing",
  "evidence-overlap",
  "context-overlap",
  "exact-content-relocated",
  "quote-not-found",
  "quote-ambiguous",
  "read-set-drift",
  "normalizer-incompatible",
  "component-incompatible",
  "target-modified",
] as const;
export type DependencyFindingReasonCode =
  (typeof FINDING_REASON_CODE_IDS)[number];

export const ACTION_REQUIREMENT_IDS = ["required", "advisory", "none"] as const;
export type DependencyActionRequirement =
  (typeof ACTION_REQUIREMENT_IDS)[number];

export interface WholeSourceSelector {
  readonly kind: "whole-source";
}

export interface TextRangeSelector {
  readonly kind: "text-range";
  readonly unit: "utf16";
  readonly from: number;
  readonly to: number;
  readonly normalizerVersion: string;
  readonly anchorDigest?: string;
}

export interface FieldPathSelector {
  readonly kind: "field-path";
  readonly objectIdentity: string;
  readonly fieldPath: string;
}

export interface ExactObjectSetSelector {
  readonly kind: "exact-object-set";
  readonly objectIdentities: readonly string[];
  readonly setDigest: string;
}

export interface ComponentContractSelector {
  readonly kind: "component-contract";
  readonly contractId: string;
  readonly contractDigest: string;
}

export type DependencySelector =
  | WholeSourceSelector
  | TextRangeSelector
  | FieldPathSelector
  | ExactObjectSetSelector
  | ComponentContractSelector;

export interface DependencyEffectRule {
  readonly id: string;
  readonly role: string;
  readonly consumerKind: string;
  readonly changeClass: string;
  readonly freshness: string;
  readonly reasonCode: string | null;
  readonly buildAction: string;
  readonly actionRequirement: string;
}

export interface DependencyEffectRegistry {
  readonly roleContractVersion: string;
  readonly roles: readonly DependencyRole[];
  readonly consumerKinds: readonly NarrativeConsumerKind[];
  readonly sourceChangeClasses: readonly SourceChangeClass[];
  readonly effectRules: readonly DependencyEffectRule[];
}

export interface DependencyEffect {
  readonly freshness: DependencyFreshness;
  readonly reasonCode: DependencyFindingReasonCode | null;
  readonly buildAction: DependencyBuildAction;
  readonly actionRequirement: DependencyActionRequirement;
}

export interface DependencyEffectInput {
  readonly role: string;
  readonly consumerKind: string;
  readonly changeClass: string;
}

export interface ConsumerBuildSummary {
  readonly requiredActions: readonly RequiredBuildAction[];
  readonly advisoryActions: readonly DependencyBuildAction[];
  readonly compatibilityPrimaryAction: DependencyBuildAction;
}

export type DependencySelectorErrorCode =
  | "unknown-selector"
  | "invalid-selector"
  | "invalid-digest"
  | "invalid-range"
  | "range-out-of-bounds"
  | "surrogate-boundary"
  | "empty-selector-field";

export interface DependencySelectorError {
  readonly code: DependencySelectorErrorCode;
}

export type DependencySelectorValidationResult =
  | { readonly valid: true; readonly selector: DependencySelector }
  | { readonly valid: false; readonly error: DependencySelectorError };

export type DependencyEffectErrorCode =
  | "invalid-registry"
  | "unknown-role"
  | "unknown-consumer-kind"
  | "unknown-change-class"
  | "missing-effect-rule"
  | "invalid-effect";

export interface DependencyEffectError {
  readonly code: DependencyEffectErrorCode;
  readonly message: string;
}

export type DependencyEffectEvaluationResult =
  | { readonly ok: true; readonly effect: DependencyEffect }
  | { readonly ok: false; readonly error: DependencyEffectError };

export interface DependencySetDigestEntry {
  readonly sourceObjectIdentity: string;
  readonly dependencyKey: string;
  readonly selectorDigest: string;
}

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function nonEmpty(value: unknown): value is string {
  return isContractTrimmedNonEmptyString(value);
}

function isAsciiAlphaNumeric(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return (
    codePoint !== undefined &&
    ((codePoint >= 0x30 && codePoint <= 0x39) ||
      (codePoint >= 0x41 && codePoint <= 0x5a) ||
      (codePoint >= 0x61 && codePoint <= 0x7a))
  );
}

function isNormalizerVersionToken(value: unknown): value is string {
  const characters = typeof value === "string" ? Array.from(value) : [];
  if (characters.length === 0 || !isAsciiAlphaNumeric(characters[0])) {
    return false;
  }
  return characters.slice(1).every(
    (character) =>
      isAsciiAlphaNumeric(character) ||
      character === "-" ||
      character === "_" ||
      character === "." ||
      character === "/",
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && SHA256_DIGEST.test(value);
}

function isKnown<T extends readonly string[]>(
  values: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && values.includes(value as T[number]);
}

function selectorError(
  code: DependencySelectorErrorCode,
): DependencySelectorValidationResult {
  return { valid: false, error: { code } };
}

function isInsideSurrogatePair(source: string, offset: number): boolean {
  if (offset <= 0 || offset >= source.length) return false;
  const previous = source.charCodeAt(offset - 1);
  const current = source.charCodeAt(offset);
  return (
    previous >= 0xd800 &&
    previous <= 0xdbff &&
    current >= 0xdc00 &&
    current <= 0xdfff
  );
}

export function validateDependencySelector(
  value: unknown,
  source?: string,
): DependencySelectorValidationResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    return selectorError("invalid-selector");
  }

  switch (value.kind) {
    case "whole-source":
      return hasOnlyKeys(value, ["kind"])
        ? { valid: true, selector: { kind: "whole-source" } }
        : selectorError("invalid-selector");
    case "text-range": {
      const from = value.from;
      const to = value.to;
      const normalizerVersion = value.normalizerVersion;
      if (
        !hasOnlyKeys(value, [
          "kind",
          "unit",
          "from",
          "to",
          "normalizerVersion",
          "anchorDigest",
        ]) ||
        value.unit !== "utf16" ||
        typeof from !== "number" ||
        typeof to !== "number" ||
        typeof normalizerVersion !== "string" ||
        !Number.isSafeInteger(from) ||
        !Number.isSafeInteger(to) ||
        from < 0 ||
        to <= from ||
        !isNormalizerVersionToken(normalizerVersion)
      ) {
        return selectorError("invalid-range");
      }
      if (value.anchorDigest !== undefined && !isDigest(value.anchorDigest)) {
        return selectorError("invalid-digest");
      }
      if (source !== undefined) {
        if (to > source.length) {
          return selectorError("range-out-of-bounds");
        }
        if (
          isInsideSurrogatePair(source, from) ||
          isInsideSurrogatePair(source, to)
        ) {
          return selectorError("surrogate-boundary");
        }
      }
      return {
        valid: true,
        selector: {
          kind: "text-range",
          unit: "utf16",
          from,
          to,
          normalizerVersion,
          ...(value.anchorDigest === undefined
            ? {}
            : { anchorDigest: value.anchorDigest }),
        },
      };
    }
    case "field-path":
      if (
        !hasOnlyKeys(value, ["kind", "objectIdentity", "fieldPath"]) ||
        !nonEmpty(value.objectIdentity) ||
        !nonEmpty(value.fieldPath)
      ) {
        return selectorError("empty-selector-field");
      }
      return {
        valid: true,
        selector: {
          kind: "field-path",
          objectIdentity: value.objectIdentity,
          fieldPath: value.fieldPath,
        },
      };
    case "exact-object-set": {
      if (
        !hasOnlyKeys(value, ["kind", "objectIdentities", "setDigest"]) ||
        !Array.isArray(value.objectIdentities) ||
        value.objectIdentities.length === 0 ||
        value.objectIdentities.some((identity) => !nonEmpty(identity)) ||
        new Set(value.objectIdentities).size !== value.objectIdentities.length
      ) {
        return selectorError("empty-selector-field");
      }
      if (!isDigest(value.setDigest)) {
        return selectorError("invalid-digest");
      }
      return {
        valid: true,
        selector: {
          kind: "exact-object-set",
          objectIdentities: [...value.objectIdentities],
          setDigest: value.setDigest,
        },
      };
    }
    case "component-contract":
      if (
        !hasOnlyKeys(value, ["kind", "contractId", "contractDigest"]) ||
        !nonEmpty(value.contractId)
      ) {
        return selectorError("empty-selector-field");
      }
      if (!isDigest(value.contractDigest)) {
        return selectorError("invalid-digest");
      }
      return {
        valid: true,
        selector: {
          kind: "component-contract",
          contractId: value.contractId,
          contractDigest: value.contractDigest,
        },
      };
    default:
      return selectorError("unknown-selector");
  }
}

function canonicalSelector(selector: DependencySelector): DependencySelector {
  if (selector.kind !== "exact-object-set") return selector;
  return {
    ...selector,
    objectIdentities: [...selector.objectIdentities].sort(compareUtf16),
  };
}

function compareUtf16(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizedSelector(value: unknown): DependencySelector {
  const result = validateDependencySelector(value);
  if (!result.valid) {
    throw new TypeError(`invalid-selector: ${result.error.code}`);
  }
  return canonicalSelector(result.selector);
}

export function canonicalizeDependencySelector(value: unknown): string {
  return stableJsonStringify(normalizedSelector(value));
}

export function canonicalizeDependencyKeyInput(
  role: unknown,
  selector: unknown,
): string {
  if (!isKnown(DEPENDENCY_ROLE_IDS, role)) {
    throw new TypeError(`unknown-role: Unknown Dependency role: ${role}`);
  }
  return stableJsonStringify({ role, selector: normalizedSelector(selector) });
}

export function computeDependencyKeySync(
  role: unknown,
  selector: unknown,
): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalizeDependencyKeyInput(role, selector))}`;
}

export async function computeDependencyKey(
  role: unknown,
  selector: unknown,
): Promise<`sha256:${string}`> {
  return computeDependencyKeySync(role, selector);
}

export function canonicalizeDependencySet(
  entries: readonly DependencySetDigestEntry[],
): string {
  const normalized = entries.map((entry) => {
    if (
      !nonEmpty(entry.sourceObjectIdentity) ||
      !isDigest(entry.dependencyKey) ||
      !isDigest(entry.selectorDigest)
    ) {
      throw new TypeError("invalid dependency set digest entry");
    }
    return {
      sourceObjectIdentity: entry.sourceObjectIdentity,
      dependencyKey: entry.dependencyKey,
      selectorDigest: entry.selectorDigest,
    };
  });
  normalized.sort((left, right) => {
    return (
      compareUtf16(left.sourceObjectIdentity, right.sourceObjectIdentity) ||
      compareUtf16(left.dependencyKey, right.dependencyKey) ||
      compareUtf16(left.selectorDigest, right.selectorDigest)
    );
  });
  return stableJsonStringify(normalized);
}

export function computeDependencySetDigestSync(
  entries: readonly DependencySetDigestEntry[],
): `sha256:${string}` {
  return `sha256:${sha256Hex(canonicalizeDependencySet(entries))}`;
}

export function isDependencyRole(value: unknown): value is DependencyRole {
  return isKnown(DEPENDENCY_ROLE_IDS, value);
}

export function isNarrativeConsumerKind(
  value: unknown,
): value is NarrativeConsumerKind {
  return isKnown(NARRATIVE_CONSUMER_KIND_IDS, value);
}

export function isSourceChangeClass(
  value: unknown,
): value is SourceChangeClass {
  return isKnown(SOURCE_CHANGE_CLASS_IDS, value);
}

export function isDependencyFreshness(
  value: unknown,
): value is DependencyFreshness {
  return isKnown(DEPENDENCY_FRESHNESS_IDS, value);
}

export function isDependencyBuildAction(
  value: unknown,
): value is DependencyBuildAction {
  return isKnown(DEPENDENCY_BUILD_ACTION_IDS, value);
}

export function isDependencyActionRequirement(
  value: unknown,
): value is DependencyActionRequirement {
  return isKnown(ACTION_REQUIREMENT_IDS, value);
}

export function isDependencyReasonCode(
  value: unknown,
): value is DependencyFindingReasonCode {
  return value === null || isKnown(FINDING_REASON_CODE_IDS, value);
}

export function validateDependencyEffectRegistry(
  registry: DependencyEffectRegistry,
): readonly string[] {
  const errors: string[] = [];
  if (registry.roleContractVersion !== DEPENDENCY_ROLE_CONTRACT_VERSION) {
    errors.push("registry roleContractVersion is not the ratified version");
  }
  if (
    registry.roles.length !== DEPENDENCY_ROLE_IDS.length ||
    new Set(registry.roles).size !== registry.roles.length ||
    !DEPENDENCY_ROLE_IDS.every((role) => registry.roles.includes(role))
  ) {
    errors.push("registry roles are incomplete or contain unknown roles");
  }
  if (
    registry.sourceChangeClasses.length !== SOURCE_CHANGE_CLASS_IDS.length ||
    new Set(registry.sourceChangeClasses).size !==
      registry.sourceChangeClasses.length ||
    !SOURCE_CHANGE_CLASS_IDS.every((changeClass) =>
      registry.sourceChangeClasses.includes(changeClass),
    )
  ) {
    errors.push("registry source change classes are incomplete or duplicated");
  }
  if (
    registry.consumerKinds.length !== NARRATIVE_CONSUMER_KIND_IDS.length ||
    registry.consumerKinds.some(
      (consumerKind) => !isNarrativeConsumerKind(consumerKind),
    ) ||
    new Set(registry.consumerKinds).size !== registry.consumerKinds.length ||
    !NARRATIVE_CONSUMER_KIND_IDS.every((consumerKind) =>
      registry.consumerKinds.includes(consumerKind),
    )
  ) {
    errors.push(
      "registry consumer kinds are incomplete or contain unknown or duplicate values",
    );
  }
  const ruleIds = new Set<string>();
  const effectKeys = new Set<string>();
  const coveredRoles = new Set<string>();
  for (const rule of registry.effectRules) {
    if (!nonEmpty(rule.id)) errors.push("effect rule id must be non-empty");
    if (ruleIds.has(rule.id))
      errors.push(`duplicate effect rule id: ${rule.id}`);
    ruleIds.add(rule.id);
    const effectKey = `${rule.role}|${rule.consumerKind}|${rule.changeClass}`;
    if (effectKeys.has(effectKey))
      errors.push(`duplicate effect key: ${effectKey}`);
    effectKeys.add(effectKey);
    coveredRoles.add(rule.role);
    if (!isDependencyRole(rule.role))
      errors.push(`unknown effect role: ${rule.role}`);
    if (!isNarrativeConsumerKind(rule.consumerKind)) {
      errors.push(`unknown effect consumer kind: ${rule.consumerKind}`);
    }
    if (!isSourceChangeClass(rule.changeClass)) {
      errors.push(`unknown effect source change class: ${rule.changeClass}`);
    }
    if (!isDependencyFreshness(rule.freshness)) {
      errors.push(`unknown effect Freshness: ${rule.freshness}`);
    }
    if (!isDependencyReasonCode(rule.reasonCode)) {
      errors.push(`unknown effect reason code: ${String(rule.reasonCode)}`);
    }
    if (!isDependencyBuildAction(rule.buildAction)) {
      errors.push(`unknown effect Build Action: ${rule.buildAction}`);
    }
    if (!isDependencyActionRequirement(rule.actionRequirement)) {
      errors.push(
        `unknown effect action requirement: ${rule.actionRequirement}`,
      );
    }
    if (
      rule.freshness === "unknown" &&
      rule.changeClass !== "component-unavailable"
    ) {
      errors.push(
        `unknown Freshness is only valid for component-unavailable: ${rule.id}`,
      );
    }
    if (
      isDependencyBuildAction(rule.buildAction) &&
      isDependencyActionRequirement(rule.actionRequirement) &&
      ((REQUIRED_BUILD_ACTION_IDS.includes(
        rule.buildAction as RequiredBuildAction,
      ) &&
        rule.actionRequirement !== "required") ||
        (rule.buildAction === "refresh-available" &&
          rule.actionRequirement !== "advisory") ||
        (rule.buildAction === "none" && rule.actionRequirement !== "none"))
    ) {
      errors.push(`effect rule action channel mismatch: ${rule.id}`);
    }
  }
  for (const role of DEPENDENCY_ROLE_IDS) {
    if (!coveredRoles.has(role))
      errors.push(`role has no effect rule: ${role}`);
  }
  return errors;
}

function rawRegistryToTyped(value: unknown): DependencyEffectRegistry {
  if (!isRecord(value))
    throw new TypeError("dependency role policy must be an object");
  const roles = Array.isArray(value.roles)
    ? value.roles.map((role) => (isRecord(role) ? role.id : undefined))
    : [];
  const sourceChangeClasses = Array.isArray(value.sourceChangeClasses)
    ? value.sourceChangeClasses
    : [];
  const effectRules = Array.isArray(value.effectRules)
    ? value.effectRules.map((rule) => {
        if (!isRecord(rule)) return {} as DependencyEffectRule;
        return {
          id: typeof rule.id === "string" ? rule.id : "",
          role: typeof rule.role === "string" ? rule.role : "",
          consumerKind:
            typeof rule.consumerKind === "string" ? rule.consumerKind : "",
          changeClass:
            typeof rule.changeClass === "string" ? rule.changeClass : "",
          freshness: typeof rule.freshness === "string" ? rule.freshness : "",
          reasonCode:
            rule.reasonCode === null || typeof rule.reasonCode === "string"
              ? rule.reasonCode
              : "",
          buildAction:
            typeof rule.buildAction === "string" ? rule.buildAction : "",
          actionRequirement:
            typeof rule.actionRequirement === "string"
              ? rule.actionRequirement
              : "",
        };
      })
    : [];
  return {
    roleContractVersion:
      typeof value.roleContractVersion === "string"
        ? value.roleContractVersion
        : "",
    roles: roles as DependencyRole[],
    consumerKinds: [...NARRATIVE_CONSUMER_KIND_IDS],
    sourceChangeClasses: sourceChangeClasses as SourceChangeClass[],
    effectRules,
  };
}

export function loadDependencyRoleRegistry(
  policy: unknown = dependencyRolePolicy,
): DependencyEffectRegistry {
  const registry = rawRegistryToTyped(policy);
  const errors = validateDependencyEffectRegistry(registry);
  if (errors.length > 0) {
    throw new Error(
      `Invalid narrative Dependency Role registry: ${errors.join("; ")}`,
    );
  }
  return registry;
}

export const DEFAULT_DEPENDENCY_EFFECT_REGISTRY = loadDependencyRoleRegistry();

export function evaluateDependencyEffect(
  registry: DependencyEffectRegistry,
  input: unknown,
): DependencyEffectEvaluationResult {
  const registryErrors = validateDependencyEffectRegistry(registry);
  if (registryErrors.length > 0) {
    return {
      ok: false,
      error: {
        code: "invalid-registry",
        message: registryErrors.join("; "),
      },
    };
  }
  if (!isRecord(input)) {
    return {
      ok: false,
      error: {
        code: "unknown-role",
        message: "Unknown Dependency role: undefined",
      },
    };
  }
  if (!isDependencyRole(input.role)) {
    return {
      ok: false,
      error: {
        code: "unknown-role",
        message: `Unknown Dependency role: ${input.role}`,
      },
    };
  }
  if (!isNarrativeConsumerKind(input.consumerKind)) {
    return {
      ok: false,
      error: {
        code: "unknown-consumer-kind",
        message: `Unknown Consumer kind: ${input.consumerKind}`,
      },
    };
  }
  if (!isSourceChangeClass(input.changeClass)) {
    return {
      ok: false,
      error: {
        code: "unknown-change-class",
        message: `Unknown Source Change Class: ${input.changeClass}`,
      },
    };
  }
  const matchingRules = registry.effectRules.filter(
    (rule) =>
      rule.role === input.role &&
      rule.consumerKind === input.consumerKind &&
      rule.changeClass === input.changeClass,
  );
  if (matchingRules.length !== 1) {
    return {
      ok: false,
      error: {
        code: "missing-effect-rule",
        message:
          matchingRules.length === 0
            ? `No effect rule for ${input.role}|${input.consumerKind}|${input.changeClass}`
            : `Multiple effect rules for ${input.role}|${input.consumerKind}|${input.changeClass}`,
      },
    };
  }
  const rule = matchingRules[0]!;
  if (
    !isDependencyFreshness(rule.freshness) ||
    !isDependencyReasonCode(rule.reasonCode) ||
    !isDependencyBuildAction(rule.buildAction) ||
    !isDependencyActionRequirement(rule.actionRequirement)
  ) {
    return {
      ok: false,
      error: {
        code: "invalid-effect",
        message: `Effect rule ${rule.id} contains an unknown output value`,
      },
    };
  }
  return {
    ok: true,
    effect: {
      freshness: rule.freshness,
      reasonCode: rule.reasonCode,
      buildAction: rule.buildAction,
      actionRequirement: rule.actionRequirement,
    },
  };
}

function assertDependencyEffect(effect: DependencyEffect): void {
  if (
    !isDependencyFreshness(effect.freshness) ||
    !isDependencyReasonCode(effect.reasonCode) ||
    !isDependencyBuildAction(effect.buildAction) ||
    !isDependencyActionRequirement(effect.actionRequirement)
  ) {
    throw new TypeError("unknown Dependency effect input");
  }
}

export function aggregateDependencyBuildActions(
  effects: readonly unknown[] | undefined,
): ConsumerBuildSummary {
  if (!Array.isArray(effects)) {
    throw new TypeError("Dependency effects must be an array");
  }
  const required = new Set<RequiredBuildAction>();
  const advisory = new Set<"refresh-available">();
  for (const candidate of effects) {
    if (!isRecord(candidate)) {
      throw new TypeError("unknown Dependency effect input");
    }
    const effect = candidate as Partial<DependencyEffect>;
    assertDependencyEffect(effect as DependencyEffect);
    if (
      effect.actionRequirement === "required" &&
      REQUIRED_BUILD_ACTION_IDS.includes(
        effect.buildAction as RequiredBuildAction,
      )
    ) {
      required.add(effect.buildAction as RequiredBuildAction);
    } else if (
      effect.actionRequirement === "advisory" &&
      effect.buildAction === "refresh-available"
    ) {
      advisory.add(effect.buildAction);
    } else if (
      effect.actionRequirement !== "none" ||
      effect.buildAction !== "none"
    ) {
      throw new TypeError("Dependency effect action channel is inconsistent");
    }
  }
  const requiredActions = REQUIRED_BUILD_ACTION_IDS.filter((action) =>
    required.has(action),
  );
  const advisoryActions = ADVISORY_BUILD_ACTION_IDS.filter((action) =>
    advisory.has(action),
  );
  const compatibilityPrimaryAction =
    requiredActions.at(-1) ?? advisoryActions.at(-1) ?? "none";
  return {
    requiredActions,
    advisoryActions,
    compatibilityPrimaryAction,
  };
}
