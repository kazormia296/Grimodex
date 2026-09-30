import {
  ASSERTION_SUPPORT_CLASSES,
  NARRATIVE_PRODUCER_KINDS,
  type AssertionSupportClass,
  type NarrativeProducerKind,
} from "./evidencePolicy";
import {
  SCOPE_V2_REGISTRY_VERSION,
  SCOPE_V2_SCHEMA_VERSION,
  SCOPE_UNRESOLVED_REASONS,
  validateNarrativeScopeV2,
  type NarrativeScopeV2,
} from "./scopeV2";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";
import {
  DEFAULT_DEPENDENCY_EFFECT_REGISTRY,
  SOURCE_CHANGE_CLASS_IDS,
  canonicalizeDependencySelector,
  evaluateDependencyEffect,
  isDependencyRole,
  validateDependencySelector,
} from "./dependencyRole";
import type { DependencyRole, DependencySelector } from "./dependencyRole";
import { isContractNonEmptyString } from "./contractString";

export type { NarrativeScopeV2 } from "./scopeV2";

export {
  ASSERTION_SUPPORT_CLASSES,
  NARRATIVE_PRODUCER_KINDS,
  type AssertionSupportClass,
  type NarrativeProducerKind,
};

export const NARRATIVE_IR_CONTRACT_VERSION = "narrative-ir/2" as const;
export const NARRATIVE_IR_ENVELOPE_SCHEMA_VERSION = 2 as const;

export const NARRATIVE_ASSERTION_KINDS = ["scene-event@1"] as const;
export type NarrativeAssertionKind = (typeof NARRATIVE_ASSERTION_KINDS)[number];

export const ASSERTION_MODALITIES = [
  "modality-explicit-text",
  "modality-narrator-claim",
  "modality-hearsay",
  "modality-character-belief",
  "modality-inference",
  "modality-hypothesis",
  "modality-author-declaration",
  "modality-imported-assertion",
] as const;
export type AssertionModality = (typeof ASSERTION_MODALITIES)[number];

export const ASSERTION_POLARITIES = [
  "affirmative",
  "negative",
  "uncertain",
] as const;
export type AssertionPolarity = (typeof ASSERTION_POLARITIES)[number];

export const NARRATIVE_CHANGE_KINDS = [
  "add",
  "revise",
  "retract",
  "merge",
  "split",
] as const;
export type NarrativeChangeKind = (typeof NARRATIVE_CHANGE_KINDS)[number];

export const CONTEXT_EXPOSURES = [
  "deterministic-stage",
  "author-supplied",
  "model-visible",
] as const;
export type ContextExposure = (typeof CONTEXT_EXPOSURES)[number];

export const NARRATIVE_IR_REGISTRY = Object.freeze({
  contractVersion: NARRATIVE_IR_CONTRACT_VERSION,
  envelopeSchemaVersion: NARRATIVE_IR_ENVELOPE_SCHEMA_VERSION,
  scopeSchemaVersion: SCOPE_V2_SCHEMA_VERSION,
  scopeRegistryVersion: SCOPE_V2_REGISTRY_VERSION,
  assertionKinds: NARRATIVE_ASSERTION_KINDS,
  assertionModalities: ASSERTION_MODALITIES,
  assertionPolarities: ASSERTION_POLARITIES,
  // Producer Kind and Support Class are imported from their existing policy
  // contract; this registry deliberately does not redefine those vocabularies.
  producerKinds: NARRATIVE_PRODUCER_KINDS,
  supportClasses: ASSERTION_SUPPORT_CLASSES,
  changeKinds: NARRATIVE_CHANGE_KINDS,
  contextExposures: CONTEXT_EXPOSURES,
  adapter: { id: "chronicle.scene-event", version: "1" },
} as const);

export interface NarrativePayloadSchemaRef {
  readonly id: string;
  readonly version: string;
}

export interface NarrativeAssertionProducer {
  readonly kind: NarrativeProducerKind;
  readonly id: string;
  readonly version: string;
}

export interface NarrativeAssertion<TPayload> {
  readonly assertionId: string | null;
  readonly assertionKind: NarrativeAssertionKind;
  readonly payloadSchemaRef: NarrativePayloadSchemaRef;
  readonly payload: TPayload;
  readonly scope: NarrativeScopeV2;
  readonly modality: AssertionModality;
  readonly polarity: AssertionPolarity;
  readonly supportClass: AssertionSupportClass;
  readonly producer: NarrativeAssertionProducer;
  readonly producerConfidence?: number;
}

export interface NarrativeAssertionDigests {
  readonly assertionCoreDigest: Sha256Digest;
  readonly scopeDigest: Sha256Digest;
  readonly assertionDigest: Sha256Digest;
}

export interface NarrativeChangeIntent {
  readonly changeKind: NarrativeChangeKind;
  readonly targetProjectionRef?: string;
}

export interface NarrativeSourceBasisEntry {
  readonly sourceKind: string;
  readonly sourceKey: string;
  readonly revisionToken: string;
  readonly revisionObservedAt?: string;
}

export interface NarrativeEvidenceSetEntry {
  readonly evidenceRef: string;
  readonly documentRef?: string;
  readonly quote?: string;
  readonly quoteDigest?: Sha256Digest;
  readonly sourceKey?: string;
  readonly revisionToken?: string;
}

export interface NarrativeContextSetEntry {
  readonly contextId: string;
  readonly inputRef: string;
  readonly stageId: string;
  readonly exposure: ContextExposure;
  readonly selector: DependencySelector;
  /**
   * Human-derivation lineage marker: present only on entries copied verbatim
   * from the immediate parent revision's Context Set. Inherited entries keep
   * their original exposure (including `model-visible`) as audit provenance.
   */
  readonly inheritedFromRevisionId?: string;
}

export interface NarrativeDependencySetEntry {
  readonly dependencyId: string;
  readonly inputRef: string;
  readonly contextIds: readonly string[];
  readonly role: DependencyRole;
  readonly selector: DependencySelector;
}

// Contract names used by ADR 010/011 remain available without creating a
// second runtime vocabulary or persistence model.
export type SourceBasisEntry = NarrativeSourceBasisEntry;
export type EvidenceSetEntry = NarrativeEvidenceSetEntry;
export type ContextSetEntry = NarrativeContextSetEntry;
export type DependencySetEntry = NarrativeDependencySetEntry;

export interface NarrativeEffectiveMaterialBasis {
  readonly sourceBasis: readonly NarrativeSourceBasisEntry[];
  readonly evidenceSet: readonly NarrativeEvidenceSetEntry[];
  readonly dependencySet: readonly NarrativeDependencySetEntry[];
  readonly dependencySetDigest: Sha256Digest;
  readonly materialBasisDigest: Sha256Digest;
}

export interface InterpretationRevisionBasisV2 {
  readonly kind: "interpretation";
  readonly runId: string;
  readonly taskId: string;
  readonly producer: NarrativeAssertionProducer;
  readonly contextSet: readonly NarrativeContextSetEntry[];
  readonly contextSetDigest: Sha256Digest;
  readonly componentContractDigest: Sha256Digest;
  readonly finalRequestDigest: Sha256Digest;
}

export type HumanDerivationKind = "projection-only" | "scope-override";

export interface HumanDerivedRevisionBasisV2 {
  readonly kind: "human-derived";
  readonly parentRevisionId: string;
  readonly expectedParentEnvelopeDigest: Sha256Digest;
  readonly parentAssertionDigest: Sha256Digest;
  readonly rootInterpretationRevisionId: string;
  readonly derivation: {
    readonly adapterId: string;
    readonly adapterVersion: string;
    readonly kind: HumanDerivationKind;
    readonly proposalPayloadChangedPaths: readonly string[];
  };
  readonly revisionActor: {
    readonly kind: "human";
    readonly surfaceId: string;
  };
  readonly derivationContextSet: readonly NarrativeContextSetEntry[];
  readonly derivationContextSetDigest: Sha256Digest;
}

export type NarrativeRevisionBasisV2 =
  | InterpretationRevisionBasisV2
  | HumanDerivedRevisionBasisV2;

export interface NarrativeProjectionBinding {
  readonly proposalKind: string;
  readonly proposalSchemaRef: NarrativePayloadSchemaRef;
  readonly proposalPayloadDigest: Sha256Digest;
  readonly adapterContractId: string;
  readonly adapterContractVersion: string;
}

export interface NarrativeRevisionEnvelopeV2<TPayload> {
  readonly schemaVersion: typeof NARRATIVE_IR_ENVELOPE_SCHEMA_VERSION;
  readonly assertion: NarrativeAssertion<TPayload>;
  readonly assertionDigests: NarrativeAssertionDigests;
  readonly changeIntent: NarrativeChangeIntent;
  readonly effectiveMaterialBasis: NarrativeEffectiveMaterialBasis;
  readonly revisionBasis: NarrativeRevisionBasisV2;
  readonly projectionBinding: NarrativeProjectionBinding;
}

export type NarrativeIrValidationFailureReason =
  | "envelope-must-be-object"
  | "unsupported-schema-version"
  | "missing-field"
  | "unknown-field"
  | "unsupported-assertion-kind"
  | "unsupported-modality"
  | "unsupported-polarity"
  | "unsupported-support-class"
  | "unsupported-producer-kind"
  | "invalid-identifier"
  | "invalid-producer-confidence"
  | "invalid-payload-schema-ref"
  | "invalid-scope"
  | "invalid-digest"
  | "unsupported-change-kind"
  | "target-projection-forbidden"
  | "target-projection-required"
  | "invalid-material-basis"
  | "invalid-revision-basis"
  | "model-visible-context-forbidden"
  | "unsupported-adapter"
  | "invalid-projection-binding";

export type NarrativeIrValidationResult =
  | { readonly valid: true }
  | {
      readonly valid: false;
      readonly reason: NarrativeIrValidationFailureReason;
      readonly path?: string;
    };

interface Invalid {
  readonly valid: false;
  readonly reason: NarrativeIrValidationFailureReason;
  readonly path?: string;
}

const MODALITY_SET = new Set<string>(ASSERTION_MODALITIES);
const POLARITY_SET = new Set<string>(ASSERTION_POLARITIES);
const ASSERTION_KIND_SET = new Set<string>(NARRATIVE_ASSERTION_KINDS);
const CHANGE_KIND_SET = new Set<string>(NARRATIVE_CHANGE_KINDS);
const PRODUCER_KIND_SET = new Set<string>(NARRATIVE_PRODUCER_KINDS);
const SUPPORT_CLASS_SET = new Set<string>(ASSERTION_SUPPORT_CLASSES);
const CONTEXT_EXPOSURE_SET = new Set<string>(CONTEXT_EXPOSURES);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const isNonEmptyString = isContractNonEmptyString;

function isDigest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function invalid(
  reason: NarrativeIrValidationFailureReason,
  path?: string,
): Invalid {
  return { valid: false, reason, path };
}

function requireFields(
  value: Record<string, unknown>,
  fields: readonly string[],
): Invalid | undefined {
  const missing = fields.find((field) => !hasOwn(value, field));
  return missing ? invalid("missing-field", missing) : undefined;
}

function rejectUnknownFields(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
): Invalid | undefined {
  const unknown = Object.keys(value).find((key) => !fields.has(key));
  return unknown ? invalid("unknown-field", unknown) : undefined;
}

function validateSchemaRef(value: unknown, path: string): Invalid | undefined {
  if (!isRecord(value)) return invalid("invalid-payload-schema-ref", path);
  const unknown = rejectUnknownFields(value, new Set(["id", "version"]));
  if (unknown) return invalid(unknown.reason, `${path}.${unknown.path}`);
  return isContractNonEmptyString(value.id) &&
    isContractNonEmptyString(value.version)
    ? undefined
    : invalid("invalid-payload-schema-ref", path);
}

function validateProducer(value: unknown, path: string): Invalid | undefined {
  if (!isRecord(value)) return invalid("invalid-identifier", path);
  const unknown = rejectUnknownFields(
    value,
    new Set(["kind", "id", "version"]),
  );
  if (unknown) return invalid(unknown.reason, `${path}.${unknown.path}`);
  if (!PRODUCER_KIND_SET.has(value.kind as string)) {
    return invalid("unsupported-producer-kind", `${path}.kind`);
  }
  return isContractNonEmptyString(value.id) &&
    isContractNonEmptyString(value.version)
    ? undefined
    : invalid("invalid-identifier", path);
}

function validateContextEntry(
  value: unknown,
  path: string,
  allowInherited: boolean,
): Invalid | undefined {
  if (!isRecord(value)) return invalid("invalid-revision-basis", path);
  const required = requireFields(value, [
    "contextId",
    "inputRef",
    "stageId",
    "exposure",
    "selector",
  ]);
  if (required) return invalid(required.reason, `${path}.${required.path}`);
  const allowed = allowInherited
    ? new Set([
        "contextId",
        "inputRef",
        "stageId",
        "exposure",
        "selector",
        "inheritedFromRevisionId",
      ])
    : new Set(["contextId", "inputRef", "stageId", "exposure", "selector"]);
  const unknown = rejectUnknownFields(value, allowed);
  if (unknown) return invalid(unknown.reason, `${path}.${unknown.path}`);
  if (
    "inheritedFromRevisionId" in value &&
    !isNonEmptyString(value.inheritedFromRevisionId)
  ) {
    return invalid("invalid-revision-basis", `${path}.inheritedFromRevisionId`);
  }
  if (
    !isNonEmptyString(value.contextId) ||
    !isNonEmptyString(value.inputRef) ||
    !isNonEmptyString(value.stageId) ||
    !CONTEXT_EXPOSURE_SET.has(value.exposure as string) ||
    !isRecord(value.selector) ||
    !validateDependencySelector(value.selector).valid
  ) {
    return invalid("invalid-revision-basis", path);
  }
  return undefined;
}

// `humanDerived` switches the Context Set into the human-derivation lineage
// mode: an entry may carry `inheritedFromRevisionId` and, when it does, it is
// a verbatim copy of a parent Context whose original exposure (including
// `model-visible`) is preserved as audit provenance. Entries WITHOUT the
// lineage marker are this derivation's own dynamic inputs and must never be
// `model-visible` — a human derivation presents nothing to a model.
function validateContextSet(
  value: unknown,
  path: string,
  humanDerived: boolean,
): Invalid | undefined {
  if (!Array.isArray(value)) return invalid("invalid-revision-basis", path);
  for (const [index, entry] of value.entries()) {
    const result = validateContextEntry(
      entry,
      `${path}[${index}]`,
      humanDerived,
    );
    if (result) return result;
    if (
      humanDerived &&
      isRecord(entry) &&
      !("inheritedFromRevisionId" in entry) &&
      entry.exposure === "model-visible"
    ) {
      return invalid(
        "model-visible-context-forbidden",
        `${path}[${index}].exposure`,
      );
    }
  }
  return undefined;
}

function validateSourceBasis(
  value: unknown,
  path: string,
): Invalid | undefined {
  if (!Array.isArray(value)) return invalid("invalid-material-basis", path);
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry))
      return invalid("invalid-material-basis", `${path}[${index}]`);
    const unknown = rejectUnknownFields(
      entry,
      new Set([
        "sourceKind",
        "sourceKey",
        "revisionToken",
        "revisionObservedAt",
      ]),
    );
    if (unknown)
      return invalid(unknown.reason, `${path}[${index}].${unknown.path}`);
    if (
      !isNonEmptyString(entry.sourceKind) ||
      !isNonEmptyString(entry.sourceKey) ||
      !isNonEmptyString(entry.revisionToken)
    ) {
      return invalid("invalid-material-basis", `${path}[${index}]`);
    }
    if (
      hasOwn(entry, "revisionObservedAt") &&
      !isNonEmptyString(entry.revisionObservedAt)
    ) {
      return invalid(
        "invalid-material-basis",
        `${path}[${index}].revisionObservedAt`,
      );
    }
  }
  return undefined;
}

function validateEvidenceSet(
  value: unknown,
  path: string,
): Invalid | undefined {
  if (!Array.isArray(value)) return invalid("invalid-material-basis", path);
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry) || !isNonEmptyString(entry.evidenceRef)) {
      return invalid("invalid-material-basis", `${path}[${index}]`);
    }
    const unknown = rejectUnknownFields(
      entry,
      new Set([
        "evidenceRef",
        "documentRef",
        "quote",
        "quoteDigest",
        "sourceKey",
        "revisionToken",
      ]),
    );
    if (unknown)
      return invalid(unknown.reason, `${path}[${index}].${unknown.path}`);
    if (hasOwn(entry, "quoteDigest") && !isDigest(entry.quoteDigest)) {
      return invalid("invalid-digest", `${path}[${index}].quoteDigest`);
    }
    for (const field of [
      "documentRef",
      "quote",
      "sourceKey",
      "revisionToken",
    ] as const) {
      if (hasOwn(entry, field) && !isNonEmptyString(entry[field])) {
        return invalid("invalid-material-basis", `${path}[${index}].${field}`);
      }
    }
  }
  return undefined;
}

function validateDependencySet(
  value: unknown,
  path: string,
): Invalid | undefined {
  if (!Array.isArray(value)) return invalid("invalid-material-basis", path);
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry))
      return invalid("invalid-material-basis", `${path}[${index}]`);
    const unknown = rejectUnknownFields(
      entry,
      new Set(["dependencyId", "inputRef", "contextIds", "role", "selector"]),
    );
    if (unknown)
      return invalid(unknown.reason, `${path}[${index}].${unknown.path}`);
    if (
      !isNonEmptyString(entry.dependencyId) ||
      !isNonEmptyString(entry.inputRef) ||
      !Array.isArray(entry.contextIds) ||
      entry.contextIds.some((id) => !isNonEmptyString(id)) ||
      !isNonEmptyString(entry.role) ||
      !isDependencyRole(entry.role) ||
      !validateDependencySelector(entry.selector).valid
    ) {
      return invalid("invalid-material-basis", `${path}[${index}]`);
    }
    if (!hasProposalRevisionEffect(entry.role as DependencyRole)) {
      return invalid("invalid-material-basis", `${path}[${index}].role`);
    }
  }
  return undefined;
}

function dependencyInputRefForEvidence(
  evidence: Record<string, unknown>,
): string | undefined {
  return isNonEmptyString(evidence.sourceKey)
    ? evidence.sourceKey
    : isNonEmptyString(evidence.evidenceRef)
      ? evidence.evidenceRef
      : undefined;
}

function canonicalDependencySelector(value: unknown): string | undefined {
  const result = validateDependencySelector(value);
  if (!result.valid) return undefined;
  try {
    return canonicalizeDependencySelector(result.selector);
  } catch {
    return undefined;
  }
}

function hasProposalRevisionEffect(role: DependencyRole): boolean {
  let effectFound = false;
  for (const changeClass of SOURCE_CHANGE_CLASS_IDS) {
    const result = evaluateDependencyEffect(
      DEFAULT_DEPENDENCY_EFFECT_REGISTRY,
      {
        role,
        consumerKind: "proposal-revision",
        changeClass,
      },
    );
    if (result.ok) {
      effectFound = true;
      continue;
    }
    // A role may cover only the source changes relevant to this Consumer.
    // Registry/effect failures other than an absent triple are unsafe.
    if (result.error.code !== "missing-effect-rule") return false;
  }
  return effectFound;
}

function validateMaterialConsistency(
  material: Record<string, unknown>,
  contextSet: unknown,
  contextPath: string,
): Invalid | undefined {
  if (!Array.isArray(material.evidenceSet)) {
    return invalid(
      "invalid-material-basis",
      "effectiveMaterialBasis.evidenceSet",
    );
  }
  if (!Array.isArray(material.dependencySet)) {
    return invalid(
      "invalid-material-basis",
      "effectiveMaterialBasis.dependencySet",
    );
  }
  const evidenceSet = material.evidenceSet.filter(isRecord);
  const dependencies = material.dependencySet.filter(isRecord);

  for (const [index, evidence] of evidenceSet.entries()) {
    const expectedInputRef = dependencyInputRefForEvidence(evidence);
    if (
      expectedInputRef === undefined ||
      !dependencies.some(
        (dependency) =>
          dependency.role === "direct-evidence" &&
          dependency.inputRef === expectedInputRef,
      )
    ) {
      return invalid(
        "invalid-material-basis",
        `effectiveMaterialBasis.evidenceSet[${index}]`,
      );
    }
  }

  if (!Array.isArray(contextSet)) {
    return invalid("invalid-revision-basis", contextPath);
  }
  const availableContextIds = new Set(
    contextSet
      .filter(isRecord)
      .map((context) => context.contextId)
      .filter(isNonEmptyString),
  );
  for (const [index, dependency] of material.dependencySet.entries()) {
    if (!isRecord(dependency)) continue;
    const contextIds = dependency.contextIds;
    if (
      !Array.isArray(contextIds) ||
      contextIds.some(
        (contextId) =>
          !isNonEmptyString(contextId) || !availableContextIds.has(contextId),
      )
    ) {
      return invalid(
        "invalid-material-basis",
        `effectiveMaterialBasis.dependencySet[${index}].contextIds`,
      );
    }
  }
  for (const [index, context] of contextSet.entries()) {
    if (!isRecord(context) || context.exposure !== "model-visible") continue;
    const contextSelector = canonicalDependencySelector(context.selector);
    const covered = dependencies.filter(
      (dependency) =>
        dependency.inputRef === context.inputRef &&
        Array.isArray(dependency.contextIds) &&
        dependency.contextIds.includes(context.contextId) &&
        contextSelector !== undefined &&
        canonicalDependencySelector(dependency.selector) === contextSelector,
    );
    if (covered.length === 0) {
      return invalid("invalid-material-basis", `${contextPath}[${index}]`);
    }
  }
  return undefined;
}

function validateMaterialBasis(value: unknown): Invalid | undefined {
  if (!isRecord(value))
    return invalid("invalid-material-basis", "effectiveMaterialBasis");
  const required = requireFields(value, [
    "sourceBasis",
    "evidenceSet",
    "dependencySet",
    "dependencySetDigest",
    "materialBasisDigest",
  ]);
  if (required)
    return invalid(required.reason, `effectiveMaterialBasis.${required.path}`);
  const unknown = rejectUnknownFields(
    value,
    new Set([
      "sourceBasis",
      "evidenceSet",
      "dependencySet",
      "dependencySetDigest",
      "materialBasisDigest",
    ]),
  );
  if (unknown)
    return invalid(unknown.reason, `effectiveMaterialBasis.${unknown.path}`);
  const sourceResult = validateSourceBasis(
    value.sourceBasis,
    "effectiveMaterialBasis.sourceBasis",
  );
  if (sourceResult) return sourceResult;
  const evidenceResult = validateEvidenceSet(
    value.evidenceSet,
    "effectiveMaterialBasis.evidenceSet",
  );
  if (evidenceResult) return evidenceResult;
  const dependencyResult = validateDependencySet(
    value.dependencySet,
    "effectiveMaterialBasis.dependencySet",
  );
  if (dependencyResult) return dependencyResult;
  if (
    !isDigest(value.dependencySetDigest) ||
    !isDigest(value.materialBasisDigest)
  ) {
    return invalid("invalid-digest", "effectiveMaterialBasis");
  }
  return undefined;
}

function validateInterpretationBasis(
  value: Record<string, unknown>,
): Invalid | undefined {
  const required = requireFields(value, [
    "kind",
    "runId",
    "taskId",
    "producer",
    "contextSet",
    "contextSetDigest",
    "componentContractDigest",
    "finalRequestDigest",
  ]);
  if (required)
    return invalid(required.reason, `revisionBasis.${required.path}`);
  const unknown = rejectUnknownFields(
    value,
    new Set([
      "kind",
      "runId",
      "taskId",
      "producer",
      "contextSet",
      "contextSetDigest",
      "componentContractDigest",
      "finalRequestDigest",
    ]),
  );
  if (unknown) return invalid(unknown.reason, `revisionBasis.${unknown.path}`);
  if (value.kind !== "interpretation")
    return invalid("invalid-revision-basis", "revisionBasis.kind");
  const producerResult = validateProducer(
    value.producer,
    "revisionBasis.producer",
  );
  if (producerResult) return producerResult;
  const contextResult = validateContextSet(
    value.contextSet,
    "revisionBasis.contextSet",
    false,
  );
  if (contextResult) return contextResult;
  if (
    !isNonEmptyString(value.runId) ||
    !isNonEmptyString(value.taskId) ||
    !isDigest(value.contextSetDigest) ||
    !isDigest(value.componentContractDigest) ||
    !isDigest(value.finalRequestDigest)
  ) {
    return invalid("invalid-revision-basis", "revisionBasis");
  }
  return undefined;
}

function validateHumanBasis(
  value: Record<string, unknown>,
): Invalid | undefined {
  const required = requireFields(value, [
    "kind",
    "parentRevisionId",
    "expectedParentEnvelopeDigest",
    "parentAssertionDigest",
    "rootInterpretationRevisionId",
    "derivation",
    "revisionActor",
    "derivationContextSet",
    "derivationContextSetDigest",
  ]);
  if (required)
    return invalid(required.reason, `revisionBasis.${required.path}`);
  const unknown = rejectUnknownFields(
    value,
    new Set([
      "kind",
      "parentRevisionId",
      "expectedParentEnvelopeDigest",
      "parentAssertionDigest",
      "rootInterpretationRevisionId",
      "derivation",
      "revisionActor",
      "derivationContextSet",
      "derivationContextSetDigest",
    ]),
  );
  if (unknown) return invalid(unknown.reason, `revisionBasis.${unknown.path}`);
  if (value.kind !== "human-derived")
    return invalid("invalid-revision-basis", "revisionBasis.kind");
  if (
    !isNonEmptyString(value.parentRevisionId) ||
    !isDigest(value.expectedParentEnvelopeDigest) ||
    !isDigest(value.parentAssertionDigest) ||
    !isNonEmptyString(value.rootInterpretationRevisionId) ||
    !isDigest(value.derivationContextSetDigest)
  ) {
    return invalid("invalid-revision-basis", "revisionBasis");
  }
  if (!isRecord(value.derivation) || !isRecord(value.revisionActor)) {
    return invalid("invalid-revision-basis", "revisionBasis");
  }
  const derivationUnknown = rejectUnknownFields(
    value.derivation,
    new Set([
      "adapterId",
      "adapterVersion",
      "kind",
      "proposalPayloadChangedPaths",
    ]),
  );
  if (derivationUnknown) {
    return invalid(
      derivationUnknown.reason,
      `revisionBasis.derivation.${derivationUnknown.path}`,
    );
  }
  const actorUnknown = rejectUnknownFields(
    value.revisionActor,
    new Set(["kind", "surfaceId"]),
  );
  if (actorUnknown) {
    return invalid(
      actorUnknown.reason,
      `revisionBasis.revisionActor.${actorUnknown.path}`,
    );
  }
  if (
    !isNonEmptyString(value.derivation.adapterId) ||
    !isNonEmptyString(value.derivation.adapterVersion) ||
    (value.derivation.kind !== "projection-only" &&
      value.derivation.kind !== "scope-override") ||
    !Array.isArray(value.derivation.proposalPayloadChangedPaths) ||
    value.derivation.proposalPayloadChangedPaths.some(
      (path) => !isNonEmptyString(path),
    )
  ) {
    return invalid("invalid-revision-basis", "revisionBasis.derivation");
  }
  if (
    value.revisionActor.kind !== "human" ||
    !isNonEmptyString(value.revisionActor.surfaceId)
  ) {
    return invalid("invalid-revision-basis", "revisionBasis.revisionActor");
  }
  const contextResult = validateContextSet(
    value.derivationContextSet,
    "revisionBasis.derivationContextSet",
    true,
  );
  if (contextResult) return contextResult;
  // Lineage must point at the immediate parent: an inherited entry that names
  // any other revision would fabricate a Context closure this basis cannot
  // prove.
  if (Array.isArray(value.derivationContextSet)) {
    for (const [index, entry] of value.derivationContextSet.entries()) {
      if (
        isRecord(entry) &&
        "inheritedFromRevisionId" in entry &&
        entry.inheritedFromRevisionId !== value.parentRevisionId
      ) {
        return invalid(
          "invalid-revision-basis",
          `revisionBasis.derivationContextSet[${index}].inheritedFromRevisionId`,
        );
      }
    }
  }
  return undefined;
}

function validateRevisionBasis(value: unknown): Invalid | undefined {
  if (!isRecord(value))
    return invalid("invalid-revision-basis", "revisionBasis");
  if (value.kind === "interpretation")
    return validateInterpretationBasis(value);
  if (value.kind === "human-derived") return validateHumanBasis(value);
  return invalid("invalid-revision-basis", "revisionBasis.kind");
}

function validateProjectionBinding(value: unknown): Invalid | undefined {
  if (!isRecord(value))
    return invalid("invalid-projection-binding", "projectionBinding");
  const required = requireFields(value, [
    "proposalKind",
    "proposalSchemaRef",
    "proposalPayloadDigest",
    "adapterContractId",
    "adapterContractVersion",
  ]);
  if (required)
    return invalid(required.reason, `projectionBinding.${required.path}`);
  const unknown = rejectUnknownFields(
    value,
    new Set([
      "proposalKind",
      "proposalSchemaRef",
      "proposalPayloadDigest",
      "adapterContractId",
      "adapterContractVersion",
    ]),
  );
  if (unknown)
    return invalid(unknown.reason, `projectionBinding.${unknown.path}`);
  const schemaResult = validateSchemaRef(
    value.proposalSchemaRef,
    "projectionBinding.proposalSchemaRef",
  );
  if (schemaResult) return schemaResult;
  if (
    !isNonEmptyString(value.proposalKind) ||
    !isDigest(value.proposalPayloadDigest) ||
    value.adapterContractId !== NARRATIVE_IR_REGISTRY.adapter.id ||
    value.adapterContractVersion !== NARRATIVE_IR_REGISTRY.adapter.version
  ) {
    return value.adapterContractId !== NARRATIVE_IR_REGISTRY.adapter.id ||
      value.adapterContractVersion !== NARRATIVE_IR_REGISTRY.adapter.version
      ? invalid("unsupported-adapter", "projectionBinding.adapterContractId")
      : invalid("invalid-projection-binding", "projectionBinding");
  }
  return undefined;
}

/**
 * Fail-closed structural validation for an Envelope V2. Payload semantics are
 * owned by the assertion-kind adapter and are intentionally not interpreted
 * here.
 */
export function validateNarrativeRevisionEnvelopeV2(
  value: unknown,
): NarrativeIrValidationResult {
  if (!isRecord(value)) return invalid("envelope-must-be-object");
  if (value.schemaVersion !== NARRATIVE_IR_ENVELOPE_SCHEMA_VERSION) {
    return invalid("unsupported-schema-version", "schemaVersion");
  }
  const required = requireFields(value, [
    "schemaVersion",
    "assertion",
    "assertionDigests",
    "changeIntent",
    "effectiveMaterialBasis",
    "revisionBasis",
    "projectionBinding",
  ]);
  if (required) return invalid(required.reason, required.path);
  const unknown = rejectUnknownFields(
    value,
    new Set([
      "schemaVersion",
      "assertion",
      "assertionDigests",
      "changeIntent",
      "effectiveMaterialBasis",
      "revisionBasis",
      "projectionBinding",
    ]),
  );
  if (unknown) return unknown;

  if (!isRecord(value.assertion)) return invalid("missing-field", "assertion");
  const assertion = value.assertion;
  const assertionRequired = requireFields(assertion, [
    "assertionId",
    "assertionKind",
    "payloadSchemaRef",
    "payload",
    "scope",
    "modality",
    "polarity",
    "supportClass",
    "producer",
  ]);
  if (assertionRequired)
    return invalid(
      assertionRequired.reason,
      `assertion.${assertionRequired.path}`,
    );
  const assertionUnknown = rejectUnknownFields(
    assertion,
    new Set([
      "assertionId",
      "assertionKind",
      "payloadSchemaRef",
      "payload",
      "scope",
      "modality",
      "polarity",
      "supportClass",
      "producer",
      "producerConfidence",
    ]),
  );
  if (assertionUnknown) return assertionUnknown;
  if (
    assertion.assertionId !== null &&
    !isNonEmptyString(assertion.assertionId)
  ) {
    return invalid("invalid-identifier", "assertion.assertionId");
  }
  if (assertion.payload === undefined) {
    return invalid("missing-field", "assertion.payload");
  }
  if (!ASSERTION_KIND_SET.has(assertion.assertionKind as string)) {
    return invalid("unsupported-assertion-kind", "assertion.assertionKind");
  }
  const schemaResult = validateSchemaRef(
    assertion.payloadSchemaRef,
    "assertion.payloadSchemaRef",
  );
  if (schemaResult) return schemaResult;
  const scopeResult = validateNarrativeScopeV2(assertion.scope);
  if (!scopeResult.valid) return invalid("invalid-scope", "assertion.scope");
  if (!MODALITY_SET.has(assertion.modality as string)) {
    return invalid("unsupported-modality", "assertion.modality");
  }
  if (!POLARITY_SET.has(assertion.polarity as string)) {
    return invalid("unsupported-polarity", "assertion.polarity");
  }
  if (!SUPPORT_CLASS_SET.has(assertion.supportClass as string)) {
    return invalid("unsupported-support-class", "assertion.supportClass");
  }
  const producerResult = validateProducer(
    assertion.producer,
    "assertion.producer",
  );
  if (producerResult) return producerResult;
  if (
    hasOwn(assertion, "producerConfidence") &&
    (typeof assertion.producerConfidence !== "number" ||
      !Number.isFinite(assertion.producerConfidence) ||
      assertion.producerConfidence < 0 ||
      assertion.producerConfidence > 1)
  ) {
    return invalid(
      "invalid-producer-confidence",
      "assertion.producerConfidence",
    );
  }

  if (!isRecord(value.assertionDigests))
    return invalid("invalid-digest", "assertionDigests");
  const digestUnknown = rejectUnknownFields(
    value.assertionDigests,
    new Set(["assertionCoreDigest", "scopeDigest", "assertionDigest"]),
  );
  if (digestUnknown) return digestUnknown;
  for (const digest of [
    "assertionCoreDigest",
    "scopeDigest",
    "assertionDigest",
  ] as const) {
    if (!isDigest(value.assertionDigests[digest]))
      return invalid("invalid-digest", `assertionDigests.${digest}`);
  }

  if (!isRecord(value.changeIntent))
    return invalid("unsupported-change-kind", "changeIntent");
  const changeUnknown = rejectUnknownFields(
    value.changeIntent,
    new Set(["changeKind", "targetProjectionRef"]),
  );
  if (changeUnknown) return changeUnknown;
  if (!CHANGE_KIND_SET.has(value.changeIntent.changeKind as string)) {
    return invalid("unsupported-change-kind", "changeIntent.changeKind");
  }
  if (
    hasOwn(value.changeIntent, "targetProjectionRef") &&
    value.changeIntent.targetProjectionRef !== undefined &&
    !isNonEmptyString(value.changeIntent.targetProjectionRef)
  ) {
    return invalid("invalid-identifier", "changeIntent.targetProjectionRef");
  }
  const target = value.changeIntent.targetProjectionRef;
  if (value.changeIntent.changeKind === "add" && target !== undefined) {
    return invalid(
      "target-projection-forbidden",
      "changeIntent.targetProjectionRef",
    );
  }
  if (value.changeIntent.changeKind === "retract" && target === undefined) {
    return invalid(
      "target-projection-required",
      "changeIntent.targetProjectionRef",
    );
  }

  const materialResult = validateMaterialBasis(value.effectiveMaterialBasis);
  if (materialResult) return materialResult;
  const basisResult = validateRevisionBasis(value.revisionBasis);
  if (basisResult) return basisResult;
  if (
    !isRecord(value.effectiveMaterialBasis) ||
    !isRecord(value.revisionBasis)
  ) {
    return invalid("invalid-material-basis", "effectiveMaterialBasis");
  }
  const contextPath =
    value.revisionBasis.kind === "interpretation"
      ? "revisionBasis.contextSet"
      : "revisionBasis.derivationContextSet";
  const contextSet =
    value.revisionBasis.kind === "interpretation"
      ? value.revisionBasis.contextSet
      : value.revisionBasis.derivationContextSet;
  const consistencyResult = validateMaterialConsistency(
    value.effectiveMaterialBasis,
    contextSet,
    contextPath,
  );
  if (consistencyResult) return consistencyResult;
  return validateProjectionBinding(value.projectionBinding) ?? { valid: true };
}

export function assertNarrativeRevisionEnvelopeV2(
  envelope: NarrativeRevisionEnvelopeV2<unknown>,
): void {
  const result = validateNarrativeRevisionEnvelopeV2(envelope);
  if (!result.valid) {
    throw new TypeError(
      `Invalid Narrative Revision Envelope V2 at ${result.path ?? "envelope"}: ${result.reason}`,
    );
  }
}

export function isNarrativeAssertionKind(
  value: string,
): value is NarrativeAssertionKind {
  return ASSERTION_KIND_SET.has(value);
}

export function isNarrativeScopeUnresolvedReason(
  value: string,
): value is (typeof SCOPE_UNRESOLVED_REASONS)[number] {
  return SCOPE_UNRESOLVED_REASONS.includes(
    value as (typeof SCOPE_UNRESOLVED_REASONS)[number],
  );
}
