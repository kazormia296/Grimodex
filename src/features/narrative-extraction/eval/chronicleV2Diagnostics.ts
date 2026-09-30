import { digestStableJson, stableJsonStringify } from "../source/digest";
import { freezeDeep } from "../source/immutability";
import type { Sha256Digest } from "../source/types";
import {
  CHRONICLE_V2_ALIGNMENT_VERSION,
  type ChronicleV2AlignmentResult,
} from "./chronicleV2Alignment";
import {
  CHRONICLE_V2_CONTRACT_VERSION,
  CHRONICLE_V2_EVALUATION_SCOPES,
  chronicleV2EvaluationScopeFor,
  type ChronicleV2Contract,
  type ChronicleV2CoverageMode,
  type ChronicleV2EvaluationScope,
  type ChronicleV2NormalizedActualClaim,
} from "./chronicleV2Contract";
import {
  CHRONICLE_V2_TEMPORAL_VERSION,
  evaluateChronicleV2Temporal,
  remapChronicleV2TemporalGoldDocumentIds,
  validateChronicleV2EvidenceDocumentBindings,
  validateChronicleV2SourceDocumentBindings,
  type ChronicleV2TemporalEvidence,
  type ChronicleV2TemporalEvaluation,
} from "./chronicleV2Temporal";
import {
  CHRONICLE_V2_DIMENSIONS,
  CHRONICLE_V2_EVALUATOR_VERSION,
  type ChronicleV2Dimension,
  type ChronicleV2DimensionScore,
  type ChronicleV2ProductionEvaluation,
} from "./chronicleV2Evaluator";

/** Version of the source-authored Gold projection used by this diagnostic. */
export const CHRONICLE_V2_GOLD_VERSION =
  "chronicle-evaluation-v2-gold/3" as const;
/** Version of the finite actual normalizer used by this diagnostic. */
export const CHRONICLE_V2_NORMALIZER_VERSION =
  "chronicle-evaluation-v2-normalizer/1" as const;
/** Version of the numeric-only persisted diagnostic projection. */
export const CHRONICLE_V2_DIAGNOSTICS_VERSION =
  "chronicle-evaluation-v2-diagnostics/4" as const;
export const CHRONICLE_V2_DIAGNOSTICS_SCHEMA_VERSION = 4 as const;
export const CHRONICLE_V2_DIAGNOSTICS_MAX_COUNT = 10_000 as const;

export interface ChronicleV2DiagnosticsVersionBinding {
  readonly contractVersion: string;
  readonly goldVersion: string;
  readonly normalizerVersion: string;
  readonly alignmentVersion: string;
  readonly scorerVersion: string;
  readonly temporalVersion: string;
  readonly diagnosticVersion: string;
}

export const DEFAULT_CHRONICLE_V2_DIAGNOSTICS_VERSIONS = Object.freeze({
  contractVersion: CHRONICLE_V2_CONTRACT_VERSION,
  goldVersion: CHRONICLE_V2_GOLD_VERSION,
  normalizerVersion: CHRONICLE_V2_NORMALIZER_VERSION,
  alignmentVersion: CHRONICLE_V2_ALIGNMENT_VERSION,
  scorerVersion: CHRONICLE_V2_EVALUATOR_VERSION,
  temporalVersion: CHRONICLE_V2_TEMPORAL_VERSION,
  diagnosticVersion: CHRONICLE_V2_DIAGNOSTICS_VERSION,
} satisfies ChronicleV2DiagnosticsVersionBinding);

export interface ChronicleV2EvidenceDiagnosticProjection {
  readonly observedCount: number;
  readonly validObservationCount: number;
  readonly invalidObservationCount: number;
  readonly resolvedReferenceCount: number;
  readonly unresolvedReferenceCount: number;
  readonly candidatePairCount: number;
}

export interface ChronicleV2ObservationDiagnosticProjection {
  readonly coverage: ChronicleV2CoverageMode;
  readonly goldCount: number;
  readonly actualCount: number;
  /** Exact semantic one-to-one matches. */
  readonly matchedCount: number;
  /** Actual rows paired with a Gold row but with meaning mismatch. */
  readonly mismatchCount: number;
  /** Distinct Gold rows consumed by semantic mismatch assignments. */
  readonly mismatchedGoldCount: number;
  readonly missingCount: number;
  /** Conservative lower bound; it is independent of Gold ID partitions. */
  readonly missingCountLowerBound: number;
  /** Maximum Gold identities representable by compatible unknown actuals. */
  readonly unknownMatchCapacity: number;
  /** Exhaustive-only lower bound for actual rows beyond atomic Gold cardinality. */
  readonly cardinalityExcessLowerBound: number;
  /** Extra actual rows with a valid, scoreable evidence boundary. */
  readonly extraCount: number;
  readonly duplicateCount: number;
  /** Valid targeted actual rows outside the annotated Gold set. */
  readonly unscoredActualCount: number;
  readonly unobservableCount: number;
  readonly undeterminedGoldCount: number;
  readonly goldJudgedCount: number;
  readonly actualJudgedCount: number;
  readonly judgedCount: number;
  readonly denominator: number;
}

export interface ChronicleV2DimensionDiagnosticProjection {
  readonly truePositive: number;
  readonly falsePositive: number;
  readonly falseNegative: number;
  readonly unobservable: number;
  readonly pairedComparisonDenominator: number;
  readonly status: "scored" | "unobservable" | "not-scored";
}

export interface ChronicleV2ClusteringDiagnosticProjection {
  readonly status: "not-scored";
  readonly clusterCount: number;
  readonly hypothesisCount: number;
}

export interface ChronicleV2ProposalDiagnosticProjection {
  readonly coverage: ChronicleV2CoverageMode;
  readonly mode: "unscored" | "scored";
  readonly status: "unscored" | "pass" | "fail" | "undetermined";
  /** False for unscored policy; unscored is a neutral state. */
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

export interface ChronicleV2TemporalDiagnosticProjection {
  readonly requiredRelationCount: number;
  readonly matchedCount: number;
  readonly missingCount: number;
  readonly invalidEvidenceCount: number;
  readonly unobservableCount: number;
  readonly blockedByEventIdentityCount: number;
  readonly unscoredGoldCount: number;
  readonly judgedCount: number;
  readonly denominator: number;
  readonly status: "PASS" | "FAIL" | "UNDETERMINED";
  readonly passed: boolean;
}

export interface ChronicleV2DiagnosticsProjection {
  readonly schemaVersion: typeof CHRONICLE_V2_DIAGNOSTICS_SCHEMA_VERSION;
  readonly contractVersion: string;
  readonly goldVersion: string;
  readonly normalizerVersion: string;
  readonly alignmentVersion: string;
  readonly scorerVersion: string;
  readonly temporalVersion: string;
  readonly diagnosticVersion: string;
  readonly caseIdDigest: Sha256Digest;
  readonly goldDigest: Sha256Digest;
  readonly rawActualDigest: Sha256Digest;
  readonly normalizedActualDigest: Sha256Digest;
  readonly evidenceGraphDigest: Sha256Digest;
  readonly assignmentDigest: Sha256Digest;
  readonly temporalInputDigest: Sha256Digest;
  readonly temporalNormalizedDigest: Sha256Digest;
  readonly temporalRelationsDigest: Sha256Digest;
  readonly layersDigest: Sha256Digest;
  readonly projectionDigest: Sha256Digest;
  readonly evidence: ChronicleV2EvidenceDiagnosticProjection;
  readonly observation: ChronicleV2ObservationDiagnosticProjection;
  readonly dimensions: Readonly<
    Record<ChronicleV2Dimension, ChronicleV2DimensionDiagnosticProjection>
  >;
  readonly clustering: ChronicleV2ClusteringDiagnosticProjection;
  readonly proposal: ChronicleV2ProposalDiagnosticProjection;
  readonly temporal: ChronicleV2TemporalDiagnosticProjection;
  readonly semanticStatus: "PASS" | "FAIL" | "UNDETERMINED";
  readonly evaluationScope: ChronicleV2EvaluationScope;
  readonly observationPassed: boolean;
  /** False for an unscored Proposal policy; the status remains neutral. */
  readonly proposalPassed: boolean;
  readonly semanticPassed: boolean;
  /** Formal acceptance additionally requires independent human approval. */
  readonly accepted: boolean;
  readonly authorshipReady: boolean;
}

export interface ChronicleV2DiagnosticsBuildInput {
  readonly evaluation: ChronicleV2ProductionEvaluation;
  readonly contract: ChronicleV2Contract;
  readonly versionBinding?: ChronicleV2DiagnosticsVersionBinding;
}

export interface ChronicleV2DiagnosticsValidationContext {
  readonly evaluation: ChronicleV2ProductionEvaluation;
  readonly contract: ChronicleV2Contract;
  readonly versionBinding?: ChronicleV2DiagnosticsVersionBinding;
}

export const CHRONICLE_V2_DIAGNOSTICS_VALIDATION_CODES = [
  "V2_DIAGNOSTICS_INVALID",
  "V2_DIAGNOSTICS_UNKNOWN_FIELD",
  "V2_DIAGNOSTICS_ENUM_INVALID",
  "V2_DIAGNOSTICS_BOOLEAN_INVALID",
  "V2_DIAGNOSTICS_COUNT_INVALID",
  "V2_DIAGNOSTICS_DIGEST_INVALID",
  "V2_DIAGNOSTICS_PARITY_INVALID",
  "V2_DIAGNOSTICS_VERSION_MISMATCH",
  "V2_DIAGNOSTICS_DIGEST_STALE",
  "V2_DIAGNOSTICS_CONTEXT_MISMATCH",
] as const;

export type ChronicleV2DiagnosticsValidationCode =
  (typeof CHRONICLE_V2_DIAGNOSTICS_VALIDATION_CODES)[number];

export interface ChronicleV2DiagnosticsValidationDiagnostic {
  readonly code: ChronicleV2DiagnosticsValidationCode;
  readonly path?: string;
  readonly message: string;
}

export type ChronicleV2DiagnosticsValidationResult =
  | { readonly ok: true; readonly value: ChronicleV2DiagnosticsProjection }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ChronicleV2DiagnosticsValidationDiagnostic[];
    };

interface DerivedPartitions {
  readonly matchedCount: number;
  readonly mismatchCount: number;
  readonly mismatchedGoldCount: number;
  readonly missingCount: number;
  readonly missingCountLowerBound: number;
  readonly unknownMatchCapacity: number;
  readonly cardinalityExcessLowerBound: number;
  readonly extraCount: number;
  readonly duplicateCount: number;
  readonly unscoredActualCount: number;
  readonly unobservableCount: number;
  readonly undeterminedGoldCount: number;
  readonly goldJudgedCount: number;
  readonly actualJudgedCount: number;
  readonly judgedCount: number;
  readonly denominator: number;
}

type DimensionCapacityObservation = Pick<
  DerivedPartitions,
  "matchedCount" | "mismatchCount"
> & {
  readonly actualCount: number;
};

interface DerivedProjection {
  readonly projectionWithoutDigest: Omit<
    ChronicleV2DiagnosticsProjection,
    "projectionDigest"
  >;
  readonly projection: ChronicleV2DiagnosticsProjection;
}

type UnscoredObservationEvaluation =
  ChronicleV2ProductionEvaluation["observation"] & {
    readonly unscoredCount?: number;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSha256Digest(value: unknown): value is Sha256Digest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}

function isFiniteVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[a-z0-9-]+\/[0-9]+$/.test(value)
  );
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function assertCount(value: number, label: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > CHRONICLE_V2_DIAGNOSTICS_MAX_COUNT
  ) {
    throw new Error(
      `Chronicle v2 diagnostic ${label} must be an integer between 0 and ${CHRONICLE_V2_DIAGNOSTICS_MAX_COUNT}`,
    );
  }
  return value;
}

function assertEqual(actual: number, expected: number, label: string): void {
  assertCount(actual, label);
  if (actual !== expected) {
    throw new Error(
      `Chronicle v2 diagnostic ${label} is inconsistent: expected ${expected}, got ${actual}`,
    );
  }
}

function resolveVersions(
  contract: ChronicleV2Contract,
  requested?: ChronicleV2DiagnosticsVersionBinding,
): ChronicleV2DiagnosticsVersionBinding {
  const versions = requested ?? DEFAULT_CHRONICLE_V2_DIAGNOSTICS_VERSIONS;
  if (
    contract.contractVersion !== CHRONICLE_V2_CONTRACT_VERSION ||
    versions.contractVersion !== CHRONICLE_V2_CONTRACT_VERSION
  ) {
    throw new Error(
      "Chronicle v2 diagnostic contract version binding is stale",
    );
  }
  if (
    versions.goldVersion !== CHRONICLE_V2_GOLD_VERSION ||
    versions.normalizerVersion !== CHRONICLE_V2_NORMALIZER_VERSION ||
    versions.alignmentVersion !== CHRONICLE_V2_ALIGNMENT_VERSION ||
    versions.scorerVersion !== CHRONICLE_V2_EVALUATOR_VERSION ||
    versions.temporalVersion !== CHRONICLE_V2_TEMPORAL_VERSION ||
    versions.diagnosticVersion !== CHRONICLE_V2_DIAGNOSTICS_VERSION
  ) {
    throw new Error("Chronicle v2 diagnostic version binding is unsupported");
  }
  return {
    contractVersion: versions.contractVersion,
    goldVersion: versions.goldVersion,
    normalizerVersion: versions.normalizerVersion,
    alignmentVersion: versions.alignmentVersion,
    scorerVersion: versions.scorerVersion,
    temporalVersion: versions.temporalVersion,
    diagnosticVersion: versions.diagnosticVersion,
  };
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[],
): boolean {
  const expectedSet = new Set(expected);
  const actual = Object.keys(value);
  let valid = actual.length === expected.length;
  for (const key of actual) {
    if (!expectedSet.has(key)) {
      diagnostics.push({
        code: "V2_DIAGNOSTICS_UNKNOWN_FIELD",
        path: `${path}.${key}`,
        message: `Unknown Chronicle v2 diagnostics field: ${key}`,
      });
      valid = false;
    }
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      diagnostics.push({
        code: "V2_DIAGNOSTICS_INVALID",
        path: `${path}.${key}`,
        message: `Missing Chronicle v2 diagnostics field: ${key}`,
      });
      valid = false;
    }
  }
  return valid;
}

function pushDiagnostic(
  diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[],
  code: ChronicleV2DiagnosticsValidationCode,
  path: string,
  message: string,
): void {
  diagnostics.push({ code, path, message });
}

function validateCount(
  value: unknown,
  path: string,
  diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[],
): value is number {
  if (
    !isNonNegativeSafeInteger(value) ||
    value > CHRONICLE_V2_DIAGNOSTICS_MAX_COUNT
  ) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_COUNT_INVALID",
      path,
      `Count must be an integer between 0 and ${CHRONICLE_V2_DIAGNOSTICS_MAX_COUNT}`,
    );
    return false;
  }
  return true;
}

function validateBoolean(
  value: unknown,
  path: string,
  diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[],
): value is boolean {
  if (!isBoolean(value)) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_BOOLEAN_INVALID",
      path,
      "Diagnostic flag must be boolean",
    );
    return false;
  }
  return true;
}

function validateEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  path: string,
  diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[],
): value is T {
  if (typeof value !== "string" || !values.includes(value as T)) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_ENUM_INVALID",
      path,
      "Diagnostic enum value is outside the fixed vocabulary",
    );
    return false;
  }
  return true;
}

function validateDigest(
  value: unknown,
  path: string,
  diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[],
): value is Sha256Digest {
  if (!isSha256Digest(value)) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_DIGEST_INVALID",
      path,
      "Diagnostic digest must be sha256 followed by 64 lowercase hex characters",
    );
    return false;
  }
  return true;
}

function readCount(
  value: unknown,
  path: string,
  diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[],
): number {
  return validateCount(value, path, diagnostics) ? value : 0;
}

function validateDimensions(
  value: unknown,
  diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[],
): void {
  if (!isRecord(value)) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_INVALID",
      "dimensions",
      "Dimensions must be an object",
    );
    return;
  }
  exactKeys(value, CHRONICLE_V2_DIMENSIONS, "dimensions", diagnostics);
  for (const dimension of CHRONICLE_V2_DIMENSIONS) {
    const row: unknown = value[dimension];
    const path = `dimensions.${dimension}`;
    if (!isRecord(row)) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_INVALID",
        path,
        "Dimension row must be an object",
      );
      continue;
    }
    exactKeys(
      row,
      [
        "truePositive",
        "falsePositive",
        "falseNegative",
        "unobservable",
        "pairedComparisonDenominator",
        "status",
      ],
      path,
      diagnostics,
    );
    for (const key of [
      "truePositive",
      "falsePositive",
      "falseNegative",
      "unobservable",
      "pairedComparisonDenominator",
    ]) {
      readCount(row[key], `${path}.${key}`, diagnostics);
    }
    validateEnum(
      row.status,
      ["scored", "unobservable", "not-scored"],
      `${path}.status`,
      diagnostics,
    );
    const tp = readCount(row.truePositive, `${path}.truePositive`, diagnostics);
    const fp = readCount(
      row.falsePositive,
      `${path}.falsePositive`,
      diagnostics,
    );
    const fn = readCount(
      row.falseNegative,
      `${path}.falseNegative`,
      diagnostics,
    );
    const unobservable = readCount(
      row.unobservable,
      `${path}.unobservable`,
      diagnostics,
    );
    const denominator = readCount(
      row.pairedComparisonDenominator,
      `${path}.pairedComparisonDenominator`,
      diagnostics,
    );
    if (denominator !== tp + fp || denominator !== tp + fn) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_PARITY_INVALID",
        path,
        "Dimension TP/FP/FN counts do not match the paired comparison denominator",
      );
    }
    const status = row.status;
    if (
      (status === "scored" && denominator === 0) ||
      (status === "unobservable" &&
        (denominator !== 0 || unobservable === 0)) ||
      (status === "not-scored" && (denominator !== 0 || unobservable !== 0))
    ) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_PARITY_INVALID",
        `${path}.status`,
        "Dimension status does not agree with its fixed counters",
      );
    }
  }
}

function validateTemporal(
  value: unknown,
  contract: ChronicleV2Contract | undefined,
  diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[],
): void {
  if (!isRecord(value)) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_INVALID",
      "temporal",
      "Temporal projection must be an object",
    );
    return;
  }
  exactKeys(
    value,
    [
      "requiredRelationCount",
      "matchedCount",
      "missingCount",
      "invalidEvidenceCount",
      "unobservableCount",
      "blockedByEventIdentityCount",
      "unscoredGoldCount",
      "judgedCount",
      "denominator",
      "status",
      "passed",
    ],
    "temporal",
    diagnostics,
  );
  for (const key of [
    "requiredRelationCount",
    "matchedCount",
    "missingCount",
    "invalidEvidenceCount",
    "unobservableCount",
    "blockedByEventIdentityCount",
    "unscoredGoldCount",
    "judgedCount",
    "denominator",
  ]) {
    readCount(value[key], `temporal.${key}`, diagnostics);
  }
  validateEnum(
    value.status,
    ["PASS", "FAIL", "UNDETERMINED"],
    "temporal.status",
    diagnostics,
  );
  validateBoolean(value.passed, "temporal.passed", diagnostics);

  const required = readCount(
    value.requiredRelationCount,
    "temporal.requiredRelationCount",
    diagnostics,
  );
  const matched = readCount(
    value.matchedCount,
    "temporal.matchedCount",
    diagnostics,
  );
  const missing = readCount(
    value.missingCount,
    "temporal.missingCount",
    diagnostics,
  );
  const invalidEvidence = readCount(
    value.invalidEvidenceCount,
    "temporal.invalidEvidenceCount",
    diagnostics,
  );
  const unobservable = readCount(
    value.unobservableCount,
    "temporal.unobservableCount",
    diagnostics,
  );
  const blocked = readCount(
    value.blockedByEventIdentityCount,
    "temporal.blockedByEventIdentityCount",
    diagnostics,
  );
  const unscored = readCount(
    value.unscoredGoldCount,
    "temporal.unscoredGoldCount",
    diagnostics,
  );
  const judged = readCount(
    value.judgedCount,
    "temporal.judgedCount",
    diagnostics,
  );
  const denominator = readCount(
    value.denominator,
    "temporal.denominator",
    diagnostics,
  );
  if (
    matched + missing + invalidEvidence + unobservable !== required ||
    blocked > unobservable ||
    judged !== required - unobservable ||
    denominator !== required ||
    (contract && required !== contract.temporalGold.relations.length) ||
    (contract && unscored !== contract.temporalGold.unscoredClaimIds.length)
  ) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "temporal",
      "Temporal counters do not partition the required relation denominator",
    );
  }
  const expectedStatus =
    invalidEvidence > 0 || missing > 0
      ? "FAIL"
      : unobservable > 0
        ? "UNDETERMINED"
        : "PASS";
  if (
    value.status !== expectedStatus ||
    value.passed !== (value.status === "PASS")
  ) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "temporal.status",
      "Temporal status does not agree with its fixed counters",
    );
  }
}

function validateShape(
  candidate: unknown,
  versions: ChronicleV2DiagnosticsVersionBinding,
): ChronicleV2DiagnosticsValidationDiagnostic[] {
  const diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[] = [];
  if (!isRecord(candidate)) {
    return [
      {
        code: "V2_DIAGNOSTICS_INVALID",
        message: "Chronicle v2 diagnostics projection must be an object",
      },
    ];
  }
  exactKeys(
    candidate,
    [
      "schemaVersion",
      "contractVersion",
      "goldVersion",
      "normalizerVersion",
      "alignmentVersion",
      "scorerVersion",
      "temporalVersion",
      "diagnosticVersion",
      "caseIdDigest",
      "goldDigest",
      "rawActualDigest",
      "normalizedActualDigest",
      "evidenceGraphDigest",
      "assignmentDigest",
      "temporalInputDigest",
      "temporalNormalizedDigest",
      "temporalRelationsDigest",
      "layersDigest",
      "projectionDigest",
      "evidence",
      "observation",
      "dimensions",
      "clustering",
      "proposal",
      "temporal",
      "semanticStatus",
      "evaluationScope",
      "observationPassed",
      "proposalPassed",
      "semanticPassed",
      "accepted",
      "authorshipReady",
    ],
    "projection",
    diagnostics,
  );
  if (candidate.schemaVersion !== CHRONICLE_V2_DIAGNOSTICS_SCHEMA_VERSION) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_VERSION_MISMATCH",
      "schemaVersion",
      "Unsupported diagnostics schema version",
    );
  }
  const versionFields: readonly [string, string][] = [
    ["contractVersion", versions.contractVersion],
    ["goldVersion", versions.goldVersion],
    ["normalizerVersion", versions.normalizerVersion],
    ["alignmentVersion", versions.alignmentVersion],
    ["scorerVersion", versions.scorerVersion],
    ["temporalVersion", versions.temporalVersion],
    ["diagnosticVersion", versions.diagnosticVersion],
  ];
  for (const [field, expected] of versionFields) {
    const formatValid =
      field === "contractVersion"
        ? typeof candidate[field] === "string" && candidate[field].length > 0
        : isFiniteVersion(candidate[field]);
    if (!formatValid || candidate[field] !== expected) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_VERSION_MISMATCH",
        field,
        "Diagnostic version binding is stale or unsupported",
      );
    }
  }
  for (const field of [
    "caseIdDigest",
    "goldDigest",
    "rawActualDigest",
    "normalizedActualDigest",
    "evidenceGraphDigest",
    "assignmentDigest",
    "temporalInputDigest",
    "temporalNormalizedDigest",
    "temporalRelationsDigest",
    "layersDigest",
    "projectionDigest",
  ]) {
    validateDigest(candidate[field], `projection.${field}`, diagnostics);
  }

  const evidence = candidate.evidence;
  if (!isRecord(evidence)) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_INVALID",
      "evidence",
      "Evidence projection must be an object",
    );
  } else {
    exactKeys(
      evidence,
      [
        "observedCount",
        "validObservationCount",
        "invalidObservationCount",
        "resolvedReferenceCount",
        "unresolvedReferenceCount",
        "candidatePairCount",
      ],
      "evidence",
      diagnostics,
    );
    for (const key of [
      "observedCount",
      "validObservationCount",
      "invalidObservationCount",
      "resolvedReferenceCount",
      "unresolvedReferenceCount",
      "candidatePairCount",
    ]) {
      readCount(evidence[key], `evidence.${key}`, diagnostics);
    }
    const observed = readCount(
      evidence.observedCount,
      "evidence.observedCount",
      diagnostics,
    );
    const valid = readCount(
      evidence.validObservationCount,
      "evidence.validObservationCount",
      diagnostics,
    );
    const invalid = readCount(
      evidence.invalidObservationCount,
      "evidence.invalidObservationCount",
      diagnostics,
    );
    if (valid + invalid !== observed) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_PARITY_INVALID",
        "evidence",
        "Evidence validity partition does not sum to observed rows",
      );
    }
  }

  const observation = candidate.observation;
  if (!isRecord(observation)) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_INVALID",
      "observation",
      "Observation projection must be an object",
    );
  } else {
    exactKeys(
      observation,
      [
        "coverage",
        "goldCount",
        "actualCount",
        "matchedCount",
        "mismatchCount",
        "mismatchedGoldCount",
        "missingCount",
        "missingCountLowerBound",
        "unknownMatchCapacity",
        "cardinalityExcessLowerBound",
        "extraCount",
        "duplicateCount",
        "unscoredActualCount",
        "unobservableCount",
        "undeterminedGoldCount",
        "goldJudgedCount",
        "actualJudgedCount",
        "judgedCount",
        "denominator",
      ],
      "observation",
      diagnostics,
    );
    validateEnum(
      observation.coverage,
      ["exhaustive", "targeted"],
      "observation.coverage",
      diagnostics,
    );
    for (const key of [
      "goldCount",
      "actualCount",
      "matchedCount",
      "mismatchCount",
      "mismatchedGoldCount",
      "missingCount",
      "missingCountLowerBound",
      "unknownMatchCapacity",
      "cardinalityExcessLowerBound",
      "extraCount",
      "duplicateCount",
      "unscoredActualCount",
      "unobservableCount",
      "undeterminedGoldCount",
      "goldJudgedCount",
      "actualJudgedCount",
      "judgedCount",
      "denominator",
    ]) {
      readCount(observation[key], `observation.${key}`, diagnostics);
    }
    const gold = readCount(
      observation.goldCount,
      "observation.goldCount",
      diagnostics,
    );
    const actual = readCount(
      observation.actualCount,
      "observation.actualCount",
      diagnostics,
    );
    const matched = readCount(
      observation.matchedCount,
      "observation.matchedCount",
      diagnostics,
    );
    const mismatch = readCount(
      observation.mismatchCount,
      "observation.mismatchCount",
      diagnostics,
    );
    const mismatchedGold = readCount(
      observation.mismatchedGoldCount,
      "observation.mismatchedGoldCount",
      diagnostics,
    );
    const missing = readCount(
      observation.missingCount,
      "observation.missingCount",
      diagnostics,
    );
    const missingLowerBound = readCount(
      observation.missingCountLowerBound,
      "observation.missingCountLowerBound",
      diagnostics,
    );
    const unknownCapacity = readCount(
      observation.unknownMatchCapacity,
      "observation.unknownMatchCapacity",
      diagnostics,
    );
    const cardinalityExcess = readCount(
      observation.cardinalityExcessLowerBound,
      "observation.cardinalityExcessLowerBound",
      diagnostics,
    );
    const extra = readCount(
      observation.extraCount,
      "observation.extraCount",
      diagnostics,
    );
    const duplicate = readCount(
      observation.duplicateCount,
      "observation.duplicateCount",
      diagnostics,
    );
    const unscored = readCount(
      observation.unscoredActualCount,
      "observation.unscoredActualCount",
      diagnostics,
    );
    const unobservable = readCount(
      observation.unobservableCount,
      "observation.unobservableCount",
      diagnostics,
    );
    const undetermined = readCount(
      observation.undeterminedGoldCount,
      "observation.undeterminedGoldCount",
      diagnostics,
    );
    const goldJudged = readCount(
      observation.goldJudgedCount,
      "observation.goldJudgedCount",
      diagnostics,
    );
    const actualJudged = readCount(
      observation.actualJudgedCount,
      "observation.actualJudgedCount",
      diagnostics,
    );
    const judged = readCount(
      observation.judgedCount,
      "observation.judgedCount",
      diagnostics,
    );
    const denominator = readCount(
      observation.denominator,
      "observation.denominator",
      diagnostics,
    );
    const expectedCardinalityExcess =
      observation.coverage === "exhaustive" ? Math.max(0, actual - gold) : 0;
    if (
      mismatchedGold > mismatch ||
      gold !== matched + missing + undetermined ||
      actual !==
        matched + mismatch + extra + duplicate + unscored + unobservable ||
      goldJudged !== gold - undetermined ||
      actualJudged !== actual - unobservable - unscored ||
      judged !== goldJudged + actualJudged ||
      denominator !== gold + actual ||
      missingLowerBound > gold ||
      unknownCapacity > gold ||
      cardinalityExcess !== expectedCardinalityExcess
    ) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_PARITY_INVALID",
        "observation",
        "Observation partitions do not sum to their denominators",
      );
    }
  }

  validateDimensions(candidate.dimensions, diagnostics);

  const clustering = candidate.clustering;
  if (!isRecord(clustering)) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_INVALID",
      "clustering",
      "Clustering projection must be an object",
    );
  } else {
    exactKeys(
      clustering,
      ["status", "clusterCount", "hypothesisCount"],
      "clustering",
      diagnostics,
    );
    validateEnum(
      clustering.status,
      ["not-scored"],
      "clustering.status",
      diagnostics,
    );
    readCount(clustering.clusterCount, "clustering.clusterCount", diagnostics);
    readCount(
      clustering.hypothesisCount,
      "clustering.hypothesisCount",
      diagnostics,
    );
  }

  const proposal = candidate.proposal;
  if (!isRecord(proposal)) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_INVALID",
      "proposal",
      "Proposal projection must be an object",
    );
  } else {
    exactKeys(
      proposal,
      [
        "coverage",
        "mode",
        "status",
        "passed",
        "eligibleGoldCount",
        "proposedCorrectCount",
        "proposedIncorrectCount",
        "suppressedCorrectCount",
        "suppressedIncorrectCount",
        "unobservableCount",
        "judgedCount",
        "denominator",
      ],
      "proposal",
      diagnostics,
    );
    validateEnum(
      proposal.coverage,
      ["exhaustive", "targeted"],
      "proposal.coverage",
      diagnostics,
    );
    validateEnum(
      proposal.mode,
      ["unscored", "scored"],
      "proposal.mode",
      diagnostics,
    );
    validateEnum(
      proposal.status,
      ["unscored", "pass", "fail", "undetermined"],
      "proposal.status",
      diagnostics,
    );
    validateBoolean(proposal.passed, "proposal.passed", diagnostics);
    for (const key of [
      "eligibleGoldCount",
      "proposedCorrectCount",
      "proposedIncorrectCount",
      "suppressedCorrectCount",
      "suppressedIncorrectCount",
      "unobservableCount",
      "judgedCount",
      "denominator",
    ]) {
      readCount(proposal[key], `proposal.${key}`, diagnostics);
    }
    const eligible = readCount(
      proposal.eligibleGoldCount,
      "proposal.eligibleGoldCount",
      diagnostics,
    );
    const proposedCorrect = readCount(
      proposal.proposedCorrectCount,
      "proposal.proposedCorrectCount",
      diagnostics,
    );
    const proposedIncorrect = readCount(
      proposal.proposedIncorrectCount,
      "proposal.proposedIncorrectCount",
      diagnostics,
    );
    const suppressedCorrect = readCount(
      proposal.suppressedCorrectCount,
      "proposal.suppressedCorrectCount",
      diagnostics,
    );
    const suppressedIncorrect = readCount(
      proposal.suppressedIncorrectCount,
      "proposal.suppressedIncorrectCount",
      diagnostics,
    );
    const unobservable = readCount(
      proposal.unobservableCount,
      "proposal.unobservableCount",
      diagnostics,
    );
    const judged = readCount(
      proposal.judgedCount,
      "proposal.judgedCount",
      diagnostics,
    );
    const denominator = readCount(
      proposal.denominator,
      "proposal.denominator",
      diagnostics,
    );
    if (proposal.mode === "unscored") {
      if (
        proposal.status !== "unscored" ||
        proposal.passed !== false ||
        eligible !== 0 ||
        proposedCorrect !== 0 ||
        proposedIncorrect !== 0 ||
        suppressedCorrect !== 0 ||
        suppressedIncorrect !== 0 ||
        unobservable !== 0 ||
        judged !== 0 ||
        denominator !== 0
      ) {
        pushDiagnostic(
          diagnostics,
          "V2_DIAGNOSTICS_PARITY_INVALID",
          "proposal",
          "Unscored proposal must remain neutral with zero scored counts",
        );
      }
    } else if (
      judged !== eligible - unobservable ||
      denominator !== eligible ||
      proposedCorrect +
        proposedIncorrect +
        suppressedCorrect +
        suppressedIncorrect +
        unobservable !==
        eligible ||
      proposal.status !==
        (unobservable > 0
          ? "undetermined"
          : proposedIncorrect + suppressedIncorrect > 0
            ? "fail"
            : "pass") ||
      proposal.passed !== (proposal.status === "pass")
    ) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_PARITY_INVALID",
        "proposal",
        "Scored proposal counts or status are inconsistent",
      );
    }
  }

  validateTemporal(candidate.temporal, undefined, diagnostics);

  for (const [field, values] of [
    ["semanticStatus", ["PASS", "FAIL", "UNDETERMINED"] as const],
  ] as const) {
    validateEnum(candidate[field], values, `projection.${field}`, diagnostics);
  }
  validateEnum(
    candidate.evaluationScope,
    CHRONICLE_V2_EVALUATION_SCOPES,
    "projection.evaluationScope",
    diagnostics,
  );
  for (const field of [
    "observationPassed",
    "proposalPassed",
    "semanticPassed",
    "accepted",
    "authorshipReady",
  ]) {
    validateBoolean(candidate[field], `projection.${field}`, diagnostics);
  }
  if (candidate.semanticPassed !== (candidate.semanticStatus === "PASS")) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.semanticPassed",
      "semanticPassed must equal semanticStatus PASS",
    );
  }
  if (isRecord(proposal) && candidate.proposalPassed !== proposal.passed) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.proposalPassed",
      "proposalPassed must equal the normalized proposal result",
    );
  }
  if (
    isRecord(proposal) &&
    (proposal.mode === "unscored" || proposal.mode === "scored") &&
    candidate.evaluationScope !== chronicleV2EvaluationScopeFor(proposal.mode)
  ) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.evaluationScope",
      "evaluationScope must agree with the Proposal scoring mode",
    );
  }
  if (candidate.accepted && !candidate.semanticPassed) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.accepted",
      "accepted cannot be true without semantic PASS",
    );
  }
  return diagnostics;
}

function assignmentIds(alignment: ChronicleV2AlignmentResult): {
  readonly actualRefs: ReadonlySet<string>;
  readonly goldRefs: ReadonlySet<string>;
} {
  const actualRefs = new Set<string>();
  const goldRefs = new Set<string>();
  for (const assignment of alignment.assignments) {
    if (actualRefs.has(assignment.actualRef)) {
      throw new Error(
        `Chronicle v2 alignment repeats actualRef: ${assignment.actualRef}`,
      );
    }
    actualRefs.add(assignment.actualRef);
    if (assignment.goldRef !== null) goldRefs.add(assignment.goldRef);
  }
  return { actualRefs, goldRefs };
}

function evidenceByActual(
  evaluation: ChronicleV2ProductionEvaluation,
): ReadonlyMap<string, ChronicleV2ProductionEvaluation["evidence"][number]> {
  const result = new Map<
    string,
    ChronicleV2ProductionEvaluation["evidence"][number]
  >();
  for (const evidence of evaluation.evidence) {
    if (result.has(evidence.actualRef)) {
      throw new Error(
        `Chronicle v2 evidence repeats actualRef: ${evidence.actualRef}`,
      );
    }
    result.set(evidence.actualRef, evidence);
  }
  return result;
}

function derivePartitions(
  evaluation: ChronicleV2ProductionEvaluation,
  contract: ChronicleV2Contract,
): DerivedPartitions {
  const actualRefs = new Set(
    evaluation.normalizedActualClaims.map((claim) => claim.actualRef),
  );
  if (actualRefs.size !== evaluation.normalizedActualClaims.length) {
    throw new Error("Chronicle v2 normalized actual refs must be unique");
  }
  const { actualRefs: assignedActualRefs } = assignmentIds(
    evaluation.alignment,
  );
  if (
    assignedActualRefs.size !== actualRefs.size ||
    [...actualRefs].some((ref) => !assignedActualRefs.has(ref))
  ) {
    throw new Error(
      "Chronicle v2 assignments must cover every normalized actual exactly once",
    );
  }
  const evidence = evidenceByActual(evaluation);
  if (
    evidence.size !== actualRefs.size ||
    [...actualRefs].some((ref) => !evidence.has(ref))
  ) {
    throw new Error(
      "Chronicle v2 evidence validation must cover every normalized actual exactly once",
    );
  }

  let matchedCount = 0;
  let mismatchCount = 0;
  let extraCount = 0;
  let duplicateCount = 0;
  let unscoredActualCount = 0;
  let unobservableCount = 0;
  const matchedGold = new Set<string>();
  const mismatchedGold = new Set<string>();
  for (const assignment of evaluation.alignment.assignments) {
    const validation = evidence.get(assignment.actualRef);
    if (!validation)
      throw new Error("Chronicle v2 assignment has no evidence validation");
    if (assignment.status === "match") {
      if (assignment.goldRef === null)
        throw new Error("A Chronicle v2 match requires a Gold ref");
      matchedCount += 1;
      matchedGold.add(assignment.goldRef);
      continue;
    }
    if (assignment.status === "unobservable") {
      if (assignment.goldRef !== null)
        throw new Error(
          "An unobservable Chronicle v2 actual cannot consume Gold",
        );
      unobservableCount += 1;
      continue;
    }
    if (assignment.status === "unscored") {
      if (
        assignment.goldRef !== null ||
        contract.coverage.observation !== "targeted"
      ) {
        throw new Error(
          "An unscored Chronicle v2 actual must be outside targeted Gold",
        );
      }
      if (!validation.valid)
        throw new Error(
          "An unscored Chronicle v2 actual requires valid evidence",
        );
      unscoredActualCount += 1;
      continue;
    }
    if (assignment.reason === "duplicate-claim") {
      if (assignment.goldRef === null)
        throw new Error("A duplicate Chronicle v2 actual requires a Gold ref");
      duplicateCount += 1;
      continue;
    }
    if (assignment.goldRef === null) {
      if (
        assignment.reason !== "evidence-invalid" &&
        assignment.reason !== "evidence-no-candidate" &&
        assignment.reason !== "extra-claim"
      ) {
        throw new Error(
          "An extra Chronicle v2 actual has an unsupported reason",
        );
      }
      extraCount += 1;
      continue;
    }
    mismatchCount += 1;
    mismatchedGold.add(assignment.goldRef);
  }

  const goldIds = new Set(
    contract.observationGold.claims.map((claim) => claim.id),
  );
  const undeterminedGold = new Set(evaluation.alignment.undeterminedGoldRefs);
  for (const goldId of matchedGold) undeterminedGold.delete(goldId);
  for (const goldId of undeterminedGold) {
    if (!goldIds.has(goldId))
      throw new Error(`Unknown undetermined Gold ref: ${goldId}`);
  }
  for (const goldId of matchedGold) {
    if (!goldIds.has(goldId))
      throw new Error(`Unknown matched Gold ref: ${goldId}`);
  }
  const mismatchedGoldCount = mismatchedGold.size;
  const missingGold = new Set(
    [...evaluation.alignment.missingGoldRefs, ...mismatchedGold].filter(
      (goldId) => !matchedGold.has(goldId) && !undeterminedGold.has(goldId),
    ),
  );
  for (const goldId of [
    ...missingGold,
    ...mismatchedGold,
    ...undeterminedGold,
  ]) {
    if (!goldIds.has(goldId))
      throw new Error(`Unknown Gold ref in alignment partition: ${goldId}`);
  }
  const partitionedGold = new Set([
    ...matchedGold,
    ...missingGold,
    ...undeterminedGold,
  ]);
  if (partitionedGold.size !== goldIds.size) {
    throw new Error("Chronicle v2 Gold partitions do not cover the contract");
  }
  const alignmentMatchedGold = new Set(evaluation.alignment.matchedGoldRefs);
  if (
    alignmentMatchedGold.size !== matchedGold.size ||
    [...alignmentMatchedGold].some((goldId) => !matchedGold.has(goldId))
  ) {
    throw new Error(
      "Chronicle v2 matched Gold identity set disagrees with alignment",
    );
  }
  const unknownMatchCapacity = evaluation.alignment.unknownMatchCapacity;
  const missingCountLowerBound = evaluation.alignment.missingCountLowerBound;
  const cardinalityExcessLowerBound =
    evaluation.alignment.cardinalityExcessLowerBound;
  assertCount(unknownMatchCapacity, "alignment.unknownMatchCapacity");
  assertCount(missingCountLowerBound, "alignment.missingCountLowerBound");
  assertCount(
    cardinalityExcessLowerBound,
    "alignment.cardinalityExcessLowerBound",
  );
  assertEqual(
    missingCountLowerBound,
    Math.max(0, goldIds.size - matchedGold.size - unknownMatchCapacity),
    "alignment.missingCountLowerBound",
  );
  assertEqual(
    cardinalityExcessLowerBound,
    contract.coverage.observation === "exhaustive"
      ? Math.max(0, actualRefs.size - goldIds.size)
      : 0,
    "alignment.cardinalityExcessLowerBound",
  );
  if (
    missingGold.size > missingCountLowerBound ||
    missingCountLowerBound > missingGold.size + undeterminedGold.size ||
    unknownMatchCapacity > unobservableCount ||
    unknownMatchCapacity > undeterminedGold.size ||
    unobservableCount > actualRefs.size
  ) {
    throw new Error(
      "Chronicle v2 unknown-match capacity and missing lower-bound counters are inconsistent",
    );
  }
  const observation = evaluation.observation as UnscoredObservationEvaluation;
  assertEqual(
    evaluation.alignment.matchedCount,
    matchedCount,
    "alignment.matchedCount",
  );
  assertEqual(
    evaluation.alignment.mismatchCount,
    mismatchCount,
    "alignment.mismatchCount",
  );
  assertEqual(
    evaluation.alignment.extraCount,
    extraCount,
    "alignment.extraCount",
  );
  assertEqual(
    evaluation.alignment.duplicateCount,
    duplicateCount,
    "alignment.duplicateCount",
  );
  assertEqual(
    evaluation.alignment.unscoredCount,
    unscoredActualCount,
    "alignment.unscoredCount",
  );
  assertEqual(
    evaluation.alignment.unobservableCount,
    unobservableCount,
    "alignment.unobservableCount",
  );
  assertEqual(
    evaluation.alignment.missingCount,
    missingGold.size,
    "alignment.missingCount",
  );
  assertEqual(
    evaluation.alignment.undeterminedGoldCount,
    undeterminedGold.size,
    "alignment.undeterminedGoldCount",
  );
  assertEqual(observation.goldCount, goldIds.size, "observation.goldCount");
  assertEqual(
    observation.actualCount,
    actualRefs.size,
    "observation.actualCount",
  );
  assertEqual(
    observation.matchedCount,
    matchedCount,
    "observation.matchedCount",
  );
  assertEqual(
    observation.mismatchCount,
    mismatchCount,
    "observation.mismatchCount",
  );
  assertEqual(observation.extraCount, extraCount, "observation.extraCount");
  assertEqual(
    observation.duplicateCount,
    duplicateCount,
    "observation.duplicateCount",
  );
  assertEqual(
    observation.unscoredCount ?? unscoredActualCount,
    unscoredActualCount,
    "observation.unscoredCount",
  );
  assertEqual(
    observation.unobservableCount,
    unobservableCount,
    "observation.unobservableCount",
  );
  assertEqual(
    observation.missingCount,
    missingGold.size,
    "observation.missingCount",
  );
  assertEqual(
    observation.missingCountLowerBound,
    missingCountLowerBound,
    "observation.missingCountLowerBound",
  );
  assertEqual(
    observation.unknownMatchCapacity,
    unknownMatchCapacity,
    "observation.unknownMatchCapacity",
  );
  assertEqual(
    observation.cardinalityExcessLowerBound,
    cardinalityExcessLowerBound,
    "observation.cardinalityExcessLowerBound",
  );
  assertEqual(
    observation.undeterminedGoldCount,
    undeterminedGold.size,
    "observation.undeterminedGoldCount",
  );

  const goldJudgedCount = goldIds.size - undeterminedGold.size;
  const actualJudgedCount =
    actualRefs.size - unobservableCount - unscoredActualCount;
  const judgedCount = goldJudgedCount + actualJudgedCount;
  const denominator = goldIds.size + actualRefs.size;
  assertEqual(
    observation.goldJudgedCount,
    goldJudgedCount,
    "observation.goldJudgedCount",
  );
  assertEqual(
    observation.actualJudgedCount,
    actualJudgedCount,
    "observation.actualJudgedCount",
  );
  assertEqual(observation.judgedCount, judgedCount, "observation.judgedCount");
  assertEqual(observation.denominator, denominator, "observation.denominator");

  return {
    matchedCount,
    mismatchCount,
    mismatchedGoldCount,
    missingCount: missingGold.size,
    missingCountLowerBound,
    unknownMatchCapacity,
    cardinalityExcessLowerBound,
    extraCount,
    duplicateCount,
    unscoredActualCount,
    unobservableCount,
    undeterminedGoldCount: undeterminedGold.size,
    goldJudgedCount,
    actualJudgedCount,
    judgedCount,
    denominator,
  };
}

function projectDimensions(
  evaluation: ChronicleV2ProductionEvaluation,
): Record<ChronicleV2Dimension, ChronicleV2DimensionDiagnosticProjection> {
  return Object.fromEntries(
    CHRONICLE_V2_DIMENSIONS.map((dimension) => {
      const score: ChronicleV2DimensionScore | undefined =
        evaluation.dimensions[dimension];
      if (!score)
        throw new Error(
          `Chronicle v2 evaluation has no ${dimension} dimension`,
        );
      for (const [key, value] of Object.entries(score)) {
        if (key === "status") continue;
        assertCount(value as number, `dimensions.${dimension}.${key}`);
      }
      if (
        score.pairedComparisonDenominator !==
          score.truePositive + score.falsePositive ||
        score.pairedComparisonDenominator !==
          score.truePositive + score.falseNegative
      ) {
        throw new Error(
          `Chronicle v2 dimension ${dimension} has inconsistent paired counts`,
        );
      }
      return [
        dimension,
        {
          truePositive: score.truePositive,
          falsePositive: score.falsePositive,
          falseNegative: score.falseNegative,
          unobservable: score.unobservable,
          pairedComparisonDenominator: score.pairedComparisonDenominator,
          status: score.status,
        },
      ];
    }),
  ) as Record<ChronicleV2Dimension, ChronicleV2DimensionDiagnosticProjection>;
}

function dimensionExceedsObservationCapacity(
  dimension: ChronicleV2Dimension,
  score: ChronicleV2DimensionDiagnosticProjection | ChronicleV2DimensionScore,
  observation: DimensionCapacityObservation,
): boolean {
  const baseViolation =
    score.truePositive < observation.matchedCount ||
    score.truePositive + score.unobservable > observation.actualCount ||
    score.falsePositive > observation.mismatchCount ||
    score.falseNegative > observation.mismatchCount ||
    score.pairedComparisonDenominator >
      observation.matchedCount + observation.mismatchCount;
  if (baseViolation) return true;
  const primitiveDimension = [
    "predicate",
    "actuality",
    "attribution",
    "narrativeFrame",
  ].includes(dimension);
  return (
    primitiveDimension &&
    score.pairedComparisonDenominator + score.unobservable >
      observation.actualCount
  );
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

function expectedDimensionUnobservable(
  evaluation: ChronicleV2ProductionEvaluation,
): Record<ChronicleV2Dimension, number> {
  const result = Object.fromEntries(
    CHRONICLE_V2_DIMENSIONS.map((dimension) => [dimension, 0]),
  ) as Record<ChronicleV2Dimension, number>;
  for (const actual of evaluation.normalizedActualClaims) {
    for (const dimension of CHRONICLE_V2_DIMENSIONS) {
      if (!dimensionObservable(actual, dimension)) result[dimension] += 1;
    }
  }
  return result;
}

function projectProposal(
  evaluation: ChronicleV2ProductionEvaluation,
  contract: ChronicleV2Contract,
): ChronicleV2ProposalDiagnosticProjection {
  const source = evaluation.proposal;
  const passed = source.mode === "scored" && source.passed;
  const proposal: ChronicleV2ProposalDiagnosticProjection = {
    coverage: contract.coverage.proposal,
    mode: source.mode,
    status: source.status,
    passed,
    eligibleGoldCount: source.eligibleGoldCount,
    proposedCorrectCount: source.proposedCorrectCount,
    proposedIncorrectCount: source.proposedIncorrectCount,
    suppressedCorrectCount: source.suppressedCorrectCount,
    suppressedIncorrectCount: source.suppressedIncorrectCount,
    unobservableCount: source.unobservableCount,
    judgedCount: source.judgedCount,
    denominator: source.denominator,
  };
  for (const [key, value] of Object.entries(proposal)) {
    if (typeof value === "number") assertCount(value, `proposal.${key}`);
  }
  return proposal;
}

function projectTemporal(
  evaluation: ChronicleV2TemporalEvaluation,
  contract: ChronicleV2Contract,
): ChronicleV2TemporalDiagnosticProjection {
  const temporal: ChronicleV2TemporalDiagnosticProjection = {
    requiredRelationCount: evaluation.requiredRelationCount,
    matchedCount: evaluation.matchedCount,
    missingCount: evaluation.missingCount,
    invalidEvidenceCount: evaluation.invalidEvidenceCount,
    unobservableCount: evaluation.unobservableCount,
    blockedByEventIdentityCount: evaluation.blockedByEventIdentityCount,
    unscoredGoldCount: evaluation.unscoredGoldCount,
    judgedCount: evaluation.judgedCount,
    denominator: evaluation.denominator,
    status: evaluation.status,
    passed: evaluation.passed,
  };
  for (const [key, value] of Object.entries(temporal)) {
    if (typeof value === "number") assertCount(value, `temporal.${key}`);
  }
  const requiredRelationCount = contract.temporalGold.relations.length;
  const expectedJudgedCount =
    requiredRelationCount - temporal.unobservableCount;
  const expectedStatus =
    temporal.invalidEvidenceCount > 0 || temporal.missingCount > 0
      ? "FAIL"
      : temporal.unobservableCount > 0
        ? "UNDETERMINED"
        : "PASS";
  if (
    temporal.requiredRelationCount !== requiredRelationCount ||
    temporal.matchedCount +
      temporal.missingCount +
      temporal.invalidEvidenceCount +
      temporal.unobservableCount !==
      temporal.requiredRelationCount ||
    temporal.blockedByEventIdentityCount > temporal.unobservableCount ||
    temporal.unscoredGoldCount !==
      contract.temporalGold.unscoredClaimIds.length ||
    temporal.judgedCount !== expectedJudgedCount ||
    temporal.denominator !== temporal.requiredRelationCount ||
    temporal.status !== expectedStatus ||
    temporal.passed !== (temporal.status === "PASS")
  ) {
    throw new Error(
      "Chronicle v2 temporal counters or status are inconsistent",
    );
  }
  return temporal;
}

function projectEvidence(
  evaluation: ChronicleV2ProductionEvaluation,
): ChronicleV2EvidenceDiagnosticProjection {
  let resolvedReferenceCount = 0;
  let unresolvedReferenceCount = 0;
  let validObservationCount = 0;
  for (const entry of evaluation.evidence) {
    assertCount(
      entry.resolvedCount,
      `evidence.${entry.actualRef}.resolvedCount`,
    );
    assertCount(entry.invalidCount, `evidence.${entry.actualRef}.invalidCount`);
    if (entry.valid !== (entry.invalidCount === 0 && entry.resolvedCount > 0)) {
      throw new Error(
        `Chronicle v2 evidence validity is inconsistent for ${entry.actualRef}`,
      );
    }
    if (entry.valid) validObservationCount += 1;
    resolvedReferenceCount += entry.resolvedCount;
    unresolvedReferenceCount += entry.invalidCount;
  }
  return {
    observedCount: evaluation.evidence.length,
    validObservationCount,
    invalidObservationCount: evaluation.evidence.length - validObservationCount,
    resolvedReferenceCount,
    unresolvedReferenceCount,
    candidatePairCount: evaluation.evidenceCandidates.length,
  };
}

function expectedSemanticStatus(
  partitions: DerivedPartitions,
  evidence: ChronicleV2EvidenceDiagnosticProjection,
  proposal: ChronicleV2ProposalDiagnosticProjection,
  temporal: ChronicleV2TemporalDiagnosticProjection,
): "PASS" | "FAIL" | "UNDETERMINED" {
  const knownFailure =
    partitions.mismatchCount > 0 ||
    partitions.extraCount > 0 ||
    partitions.duplicateCount > 0 ||
    partitions.missingCount > 0 ||
    partitions.missingCountLowerBound > 0 ||
    partitions.cardinalityExcessLowerBound > 0 ||
    evidence.invalidObservationCount > 0 ||
    evidence.unresolvedReferenceCount > 0 ||
    temporal.status === "FAIL" ||
    proposal.status === "fail";
  const uncertain =
    partitions.unobservableCount > 0 ||
    partitions.undeterminedGoldCount > 0 ||
    partitions.unscoredActualCount > 0 ||
    temporal.status === "UNDETERMINED" ||
    proposal.status === "undetermined";
  return knownFailure ? "FAIL" : uncertain ? "UNDETERMINED" : "PASS";
}

function projectionPartitions(
  observation: ChronicleV2ObservationDiagnosticProjection,
): DerivedPartitions {
  return {
    matchedCount: observation.matchedCount,
    mismatchCount: observation.mismatchCount,
    mismatchedGoldCount: observation.mismatchedGoldCount,
    missingCount: observation.missingCount,
    missingCountLowerBound: observation.missingCountLowerBound,
    unknownMatchCapacity: observation.unknownMatchCapacity,
    cardinalityExcessLowerBound: observation.cardinalityExcessLowerBound,
    extraCount: observation.extraCount,
    duplicateCount: observation.duplicateCount,
    unscoredActualCount: observation.unscoredActualCount,
    unobservableCount: observation.unobservableCount,
    undeterminedGoldCount: observation.undeterminedGoldCount,
    goldJudgedCount: observation.goldJudgedCount,
    actualJudgedCount: observation.actualJudgedCount,
    judgedCount: observation.judgedCount,
    denominator: observation.denominator,
  };
}

interface RebuiltTemporalEvaluation {
  readonly bindings: ReturnType<
    typeof validateChronicleV2SourceDocumentBindings
  >;
  readonly temporalGold: ChronicleV2Contract["temporalGold"];
  readonly evaluation: ChronicleV2TemporalEvaluation;
}

function rebuildTemporalEvaluation(
  evaluation: ChronicleV2ProductionEvaluation,
  contract: ChronicleV2Contract,
): RebuiltTemporalEvaluation {
  const bindings = validateChronicleV2SourceDocumentBindings(
    evaluation.sourceDocumentBindings,
    contract.sourceDocuments,
  );
  const temporalGold = remapChronicleV2TemporalGoldDocumentIds(
    contract.temporalGold,
    bindings,
    contract.sourceDocuments,
  );
  const evidenceByActual: ChronicleV2TemporalEvidence[] =
    evaluation.evidence.map((entry) => ({
      actualRef: entry.actualRef,
      valid: entry.valid,
      ranges: entry.ranges.map((range) => ({
        documentId: range.documentId,
        start: range.start,
        end: range.end,
      })),
    }));
  validateChronicleV2EvidenceDocumentBindings(
    evaluation.evidence.flatMap((entry) =>
      entry.ranges.map((range) => ({
        sourceRef: range.sourceRef,
        documentId: range.documentId,
      })),
    ),
    bindings,
  );
  const rawRowsByActual = new Map(
    evaluation.temporal.rawRows.map((row) => [row.actualRef, row] as const),
  );
  const rawActualIds = new Set(
    evaluation.rawActualClaims.map((claim) => claim.id),
  );
  if (
    rawRowsByActual.size !== evaluation.temporal.rawRows.length ||
    rawRowsByActual.size !== rawActualIds.size ||
    [...rawActualIds].some((actualRef) => !rawRowsByActual.has(actualRef)) ||
    [...rawRowsByActual.keys()].some(
      (actualRef) => !rawActualIds.has(actualRef),
    )
  ) {
    throw new Error(
      "Chronicle v2 temporal raw rows must cover every raw actual exactly once",
    );
  }
  for (const rawActual of evaluation.rawActualClaims) {
    const temporalRow = rawRowsByActual.get(rawActual.id);
    if (
      !temporalRow ||
      stableJsonStringify(temporalRow.evidenceRefs) !==
        stableJsonStringify(rawActual.evidenceRefs)
    ) {
      throw new Error(
        `Chronicle v2 temporal evidence refs disagree for ${rawActual.id}`,
      );
    }
  }
  if (evaluation.temporal.version !== CHRONICLE_V2_TEMPORAL_VERSION) {
    throw new Error("Chronicle v2 temporal evaluation version is unsupported");
  }
  const rebuilt = evaluateChronicleV2Temporal({
    temporalGold,
    rawRows: evaluation.temporal.rawRows,
    exactEventAssignments: evaluation.alignment.assignments,
    evidenceByActual,
  });
  const suppliedTemporal = evaluation.temporal;
  try {
    if (
      stableJsonStringify(rebuilt.rawRows) !==
      stableJsonStringify(suppliedTemporal.rawRows)
    ) {
      throw new Error("temporal raw rows are not canonical");
    }
    if (
      stableJsonStringify(rebuilt.normalizedRows) !==
      stableJsonStringify(suppliedTemporal.normalizedRows)
    ) {
      throw new Error("temporal normalized rows disagree with raw rows");
    }
    if (
      stableJsonStringify(rebuilt.relationRows) !==
      stableJsonStringify(suppliedTemporal.relationRows)
    ) {
      throw new Error("temporal relation rows disagree with verified inputs");
    }
    const rebuiltCounters = {
      requiredRelationCount: rebuilt.requiredRelationCount,
      matchedCount: rebuilt.matchedCount,
      missingCount: rebuilt.missingCount,
      invalidEvidenceCount: rebuilt.invalidEvidenceCount,
      unobservableCount: rebuilt.unobservableCount,
      blockedByEventIdentityCount: rebuilt.blockedByEventIdentityCount,
      unscoredGoldCount: rebuilt.unscoredGoldCount,
      judgedCount: rebuilt.judgedCount,
      denominator: rebuilt.denominator,
      status: rebuilt.status,
      passed: rebuilt.passed,
    };
    const suppliedCounters = {
      requiredRelationCount: suppliedTemporal.requiredRelationCount,
      matchedCount: suppliedTemporal.matchedCount,
      missingCount: suppliedTemporal.missingCount,
      invalidEvidenceCount: suppliedTemporal.invalidEvidenceCount,
      unobservableCount: suppliedTemporal.unobservableCount,
      blockedByEventIdentityCount: suppliedTemporal.blockedByEventIdentityCount,
      unscoredGoldCount: suppliedTemporal.unscoredGoldCount,
      judgedCount: suppliedTemporal.judgedCount,
      denominator: suppliedTemporal.denominator,
      status: suppliedTemporal.status,
      passed: suppliedTemporal.passed,
    };
    if (
      stableJsonStringify(rebuiltCounters) !==
      stableJsonStringify(suppliedCounters)
    ) {
      throw new Error("temporal counters disagree with verified inputs");
    }
  } catch (error) {
    throw new Error(
      error instanceof Error
        ? `Chronicle v2 temporal evaluation is inconsistent: ${error.message}`
        : "Chronicle v2 temporal evaluation is inconsistent",
      { cause: error },
    );
  }
  return { bindings, temporalGold, evaluation: rebuilt };
}

async function validateFixedProjection(
  candidate: ChronicleV2DiagnosticsProjection,
): Promise<ChronicleV2DiagnosticsValidationDiagnostic[]> {
  const diagnostics: ChronicleV2DiagnosticsValidationDiagnostic[] = [];
  const { evidence, observation, proposal, temporal } = candidate;
  if (evidence.observedCount !== observation.actualCount) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.evidence.observedCount",
      "Evidence rows must cover every normalized actual row exactly once",
    );
  }

  const partitions = projectionPartitions(observation);
  const expectedMissingLowerBound = Math.max(
    0,
    observation.goldCount -
      observation.matchedCount -
      observation.unknownMatchCapacity,
  );
  const expectedCardinalityExcess =
    observation.coverage === "exhaustive"
      ? Math.max(0, observation.actualCount - observation.goldCount)
      : 0;
  if (
    observation.missingCountLowerBound !== expectedMissingLowerBound ||
    observation.cardinalityExcessLowerBound !== expectedCardinalityExcess ||
    observation.missingCount > observation.missingCountLowerBound ||
    observation.missingCountLowerBound >
      observation.missingCount + observation.undeterminedGoldCount ||
    observation.unknownMatchCapacity > observation.unobservableCount ||
    observation.unknownMatchCapacity > observation.undeterminedGoldCount ||
    observation.unobservableCount > observation.actualCount
  ) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.observation",
      "Unknown-match capacity and missing lower-bound counters are inconsistent",
    );
  }
  for (const dimension of CHRONICLE_V2_DIMENSIONS) {
    const score = candidate.dimensions[dimension];
    if (dimensionExceedsObservationCapacity(dimension, score, observation)) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_PARITY_INVALID",
        `projection.dimensions.${dimension}`,
        "Dimension counters exceed the observable Observation assignment capacity",
      );
    }
  }
  const expectedStatus = expectedSemanticStatus(
    partitions,
    evidence,
    proposal,
    temporal,
  );
  const expectedObservationPassed =
    partitions.mismatchCount === 0 &&
    partitions.extraCount === 0 &&
    partitions.duplicateCount === 0 &&
    partitions.unscoredActualCount === 0 &&
    partitions.missingCount === 0 &&
    partitions.missingCountLowerBound === 0 &&
    partitions.cardinalityExcessLowerBound === 0 &&
    partitions.undeterminedGoldCount === 0 &&
    partitions.unobservableCount === 0 &&
    evidence.invalidObservationCount === 0 &&
    evidence.unresolvedReferenceCount === 0;
  if (candidate.observationPassed !== expectedObservationPassed) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.observationPassed",
      "observationPassed does not agree with the fixed Observation and evidence counts",
    );
  }
  if (candidate.semanticStatus !== expectedStatus) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.semanticStatus",
      "semanticStatus does not agree with the fixed Observation, evidence, and Proposal counts",
    );
  }
  if (candidate.semanticPassed !== (expectedStatus === "PASS")) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.semanticPassed",
      "semanticPassed must equal the derived semantic PASS state",
    );
  }
  if (candidate.proposalPassed !== proposal.passed) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.proposalPassed",
      "proposalPassed must equal the persisted Proposal result",
    );
  }
  if (
    candidate.evaluationScope !== chronicleV2EvaluationScopeFor(proposal.mode)
  ) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.evaluationScope",
      "evaluationScope must agree with the Proposal scoring mode",
    );
  }
  if (candidate.authorshipReady !== false) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.authorshipReady",
      "Draft v2 Gold cannot be authorship-ready",
    );
  }
  if (candidate.accepted !== false) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_PARITY_INVALID",
      "projection.accepted",
      "Draft v2 Gold cannot be formally accepted",
    );
  }

  try {
    const layersWithoutDigest = {
      evidence: candidate.evidence,
      observation: candidate.observation,
      dimensions: candidate.dimensions,
      clustering: candidate.clustering,
      proposal: candidate.proposal,
      temporal: candidate.temporal,
      semanticStatus: candidate.semanticStatus,
      evaluationScope: candidate.evaluationScope,
      observationPassed: candidate.observationPassed,
      proposalPassed: candidate.proposalPassed,
      semanticPassed: candidate.semanticPassed,
      accepted: candidate.accepted,
      authorshipReady: candidate.authorshipReady,
    };
    const expectedLayersDigest = await digestStableJson(layersWithoutDigest);
    if (candidate.layersDigest !== expectedLayersDigest) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_DIGEST_STALE",
        "projection.layersDigest",
        "layersDigest does not match the persisted diagnostic layers",
      );
    }
    const projectionWithoutDigest = Object.fromEntries(
      Object.entries(candidate).filter(([key]) => key !== "projectionDigest"),
    );
    const expectedProjectionDigest = await digestStableJson(
      projectionWithoutDigest,
    );
    if (candidate.projectionDigest !== expectedProjectionDigest) {
      pushDiagnostic(
        diagnostics,
        "V2_DIAGNOSTICS_DIGEST_STALE",
        "projection.projectionDigest",
        "projectionDigest does not match the persisted diagnostic projection",
      );
    }
  } catch (error) {
    pushDiagnostic(
      diagnostics,
      "V2_DIAGNOSTICS_INVALID",
      "projection",
      error instanceof Error
        ? `Projection digest computation failed: ${error.message}`
        : "Projection digest computation failed",
    );
  }
  return diagnostics;
}

async function deriveProjection(
  input: ChronicleV2DiagnosticsBuildInput,
): Promise<DerivedProjection> {
  const { evaluation, contract } = input;
  const versions = resolveVersions(contract, input.versionBinding);
  const formalCertification: boolean = contract.authorship.formalCertification;
  if (!evaluation.authorshipReady && formalCertification) {
    throw new Error(
      "Chronicle v2 evaluator and Gold authorship eligibility disagree",
    );
  }
  const rebuiltTemporal = rebuildTemporalEvaluation(evaluation, contract);
  const temporal = projectTemporal(rebuiltTemporal.evaluation, contract);
  const partitions = derivePartitions(evaluation, contract);
  const evidence = projectEvidence(evaluation);
  const dimensions = projectDimensions(evaluation);
  const expectedUnobservable = expectedDimensionUnobservable(evaluation);
  for (const dimension of CHRONICLE_V2_DIMENSIONS) {
    if (
      dimensions[dimension].unobservable !== expectedUnobservable[dimension]
    ) {
      throw new Error(
        `Chronicle v2 dimension ${dimension} unobservable count disagrees with normalized actual fields`,
      );
    }
    if (
      dimensionExceedsObservationCapacity(dimension, dimensions[dimension], {
        matchedCount: partitions.matchedCount,
        mismatchCount: partitions.mismatchCount,
        actualCount: evaluation.normalizedActualClaims.length,
      })
    ) {
      throw new Error(
        `Chronicle v2 dimension ${dimension} counters exceed the observable Observation assignment capacity`,
      );
    }
  }
  const proposal = projectProposal(evaluation, contract);
  const expectedEvaluationScope = chronicleV2EvaluationScopeFor(
    contract.proposalPolicy.mode,
  );
  if (evaluation.evaluationScope !== expectedEvaluationScope) {
    throw new Error(
      "Chronicle v2 evaluationScope disagrees with the Proposal policy",
    );
  }
  const semanticStatus = expectedSemanticStatus(
    partitions,
    evidence,
    proposal,
    temporal,
  );
  const observationPassed =
    partitions.mismatchCount === 0 &&
    partitions.extraCount === 0 &&
    partitions.duplicateCount === 0 &&
    partitions.unscoredActualCount === 0 &&
    partitions.missingCount === 0 &&
    partitions.missingCountLowerBound === 0 &&
    partitions.cardinalityExcessLowerBound === 0 &&
    partitions.undeterminedGoldCount === 0 &&
    partitions.unobservableCount === 0 &&
    evidence.invalidObservationCount === 0 &&
    evidence.unresolvedReferenceCount === 0;
  if (evaluation.observationPassed !== observationPassed) {
    throw new Error(
      "Chronicle v2 observationPassed disagrees with its partitions",
    );
  }
  if (evaluation.semanticStatus !== semanticStatus) {
    throw new Error(
      "Chronicle v2 semanticStatus disagrees with its partitions",
    );
  }
  if (evaluation.semanticPassed !== (semanticStatus === "PASS")) {
    throw new Error(
      "Chronicle v2 semanticPassed disagrees with semanticStatus",
    );
  }
  const authorshipReady = evaluation.authorshipReady && formalCertification;
  const proposalPassed = proposal.passed;
  const accepted =
    semanticStatus === "PASS" && proposalPassed && authorshipReady;

  const observation: ChronicleV2ObservationDiagnosticProjection = {
    coverage: contract.coverage.observation,
    goldCount: contract.observationGold.claims.length,
    actualCount: evaluation.normalizedActualClaims.length,
    matchedCount: partitions.matchedCount,
    mismatchCount: partitions.mismatchCount,
    mismatchedGoldCount: partitions.mismatchedGoldCount,
    missingCount: partitions.missingCount,
    missingCountLowerBound: partitions.missingCountLowerBound,
    unknownMatchCapacity: partitions.unknownMatchCapacity,
    cardinalityExcessLowerBound: partitions.cardinalityExcessLowerBound,
    extraCount: partitions.extraCount,
    duplicateCount: partitions.duplicateCount,
    unscoredActualCount: partitions.unscoredActualCount,
    unobservableCount: partitions.unobservableCount,
    undeterminedGoldCount: partitions.undeterminedGoldCount,
    goldJudgedCount: partitions.goldJudgedCount,
    actualJudgedCount: partitions.actualJudgedCount,
    judgedCount: partitions.judgedCount,
    denominator: partitions.denominator,
  };
  const clustering = {
    status: evaluation.clustering.status,
    clusterCount: evaluation.clustering.clusterCount,
    hypothesisCount: evaluation.clustering.hypothesisCount,
  } satisfies ChronicleV2ClusteringDiagnosticProjection;
  assertCount(clustering.clusterCount, "clustering.clusterCount");
  assertCount(clustering.hypothesisCount, "clustering.hypothesisCount");

  const [
    caseIdDigest,
    goldDigest,
    rawActualDigest,
    normalizedActualDigest,
    evidenceGraphDigest,
    assignmentDigest,
    temporalInputDigest,
    temporalNormalizedDigest,
    temporalRelationsDigest,
  ] = await Promise.all([
    digestStableJson(contract.caseId),
    digestStableJson({
      schemaVersion: contract.schemaVersion,
      contractVersion: contract.contractVersion,
      caseId: contract.caseId,
      authorship: contract.authorship,
      coverage: contract.coverage,
      sourceDocuments: contract.sourceDocuments,
      observationGold: contract.observationGold,
      temporalGold: contract.temporalGold,
      proposalPolicy: contract.proposalPolicy,
    }),
    digestStableJson(evaluation.rawActualClaims),
    digestStableJson(evaluation.normalizedActualClaims),
    digestStableJson({
      evidence: evaluation.evidence,
      candidates: evaluation.evidenceCandidates,
      sourceDocumentBindings: rebuiltTemporal.bindings,
    }),
    digestStableJson({
      version: evaluation.alignment.version,
      candidates: evaluation.alignment.candidates,
      assignments: evaluation.alignment.assignments,
    }),
    digestStableJson({
      sourceDocumentBindings: rebuiltTemporal.bindings,
      temporalGold: rebuiltTemporal.temporalGold,
      rawRows: rebuiltTemporal.evaluation.rawRows,
      evidence: evaluation.evidence,
    }),
    digestStableJson(rebuiltTemporal.evaluation.normalizedRows),
    digestStableJson(rebuiltTemporal.evaluation.relationRows),
  ]);
  const layersWithoutDigests = {
    evidence,
    observation,
    dimensions,
    clustering,
    proposal,
    temporal,
    semanticStatus,
    evaluationScope: evaluation.evaluationScope,
    observationPassed,
    proposalPassed,
    semanticPassed: semanticStatus === "PASS",
    accepted,
    authorshipReady,
  };
  const layersDigest = await digestStableJson(layersWithoutDigests);
  const projectionWithoutDigest = {
    schemaVersion: CHRONICLE_V2_DIAGNOSTICS_SCHEMA_VERSION,
    contractVersion: versions.contractVersion,
    goldVersion: versions.goldVersion,
    normalizerVersion: versions.normalizerVersion,
    alignmentVersion: versions.alignmentVersion,
    scorerVersion: versions.scorerVersion,
    temporalVersion: versions.temporalVersion,
    diagnosticVersion: versions.diagnosticVersion,
    caseIdDigest,
    goldDigest,
    rawActualDigest,
    normalizedActualDigest,
    evidenceGraphDigest,
    assignmentDigest,
    temporalInputDigest,
    temporalNormalizedDigest,
    temporalRelationsDigest,
    layersDigest,
    evidence,
    observation,
    dimensions,
    clustering,
    proposal,
    temporal,
    semanticStatus,
    evaluationScope: evaluation.evaluationScope,
    observationPassed,
    proposalPassed,
    semanticPassed: semanticStatus === "PASS",
    accepted,
    authorshipReady,
  } satisfies Omit<ChronicleV2DiagnosticsProjection, "projectionDigest">;
  const projectionDigest = await digestStableJson(projectionWithoutDigest);
  const projection = freezeDeep({
    ...projectionWithoutDigest,
    projectionDigest,
  });
  return { projectionWithoutDigest, projection };
}

/** Build a numeric-only, digest-bound projection without persisting raw inputs. */
export async function buildChronicleV2Diagnostics(
  input: ChronicleV2DiagnosticsBuildInput,
): Promise<ChronicleV2DiagnosticsProjection> {
  const derived = await deriveProjection(input);
  return derived.projection;
}

/**
 * Strictly validate a persisted v2 diagnostic. When context is supplied,
 * every digest and fixed field is recomputed from ephemeral inputs as well.
 */
export async function validateChronicleV2Diagnostics(
  candidate: unknown,
  context?: ChronicleV2DiagnosticsValidationContext,
): Promise<ChronicleV2DiagnosticsValidationResult> {
  let versions: ChronicleV2DiagnosticsVersionBinding =
    DEFAULT_CHRONICLE_V2_DIAGNOSTICS_VERSIONS;
  if (context) {
    try {
      versions = resolveVersions(context.contract, context.versionBinding);
    } catch (error) {
      return {
        ok: false,
        diagnostics: [
          {
            code: "V2_DIAGNOSTICS_VERSION_MISMATCH",
            message:
              error instanceof Error
                ? error.message
                : "Invalid v2 version binding",
          },
        ],
      };
    }
  }
  const diagnostics = validateShape(candidate, versions);
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const fixedDiagnostics = await validateFixedProjection(
    candidate as ChronicleV2DiagnosticsProjection,
  );
  if (fixedDiagnostics.length > 0) {
    return { ok: false, diagnostics: fixedDiagnostics };
  }
  if (!context) {
    return { ok: true, value: candidate as ChronicleV2DiagnosticsProjection };
  }
  let expected: ChronicleV2DiagnosticsProjection;
  try {
    expected = (
      await deriveProjection({
        evaluation: context.evaluation,
        contract: context.contract,
        versionBinding: versions,
      })
    ).projection;
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "V2_DIAGNOSTICS_CONTEXT_MISMATCH",
          message:
            error instanceof Error
              ? error.message
              : "v2 evaluator context is inconsistent",
        },
      ],
    };
  }
  let candidateJson: string;
  let expectedJson: string;
  try {
    candidateJson = stableJsonStringify(candidate);
    expectedJson = stableJsonStringify(expected);
  } catch (error) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "V2_DIAGNOSTICS_INVALID",
          message:
            error instanceof Error
              ? error.message
              : "Projection is not stable JSON",
        },
      ],
    };
  }
  if (candidateJson !== expectedJson) {
    const candidateProjection = candidate as Record<string, unknown>;
    const digestFields = [
      "caseIdDigest",
      "goldDigest",
      "rawActualDigest",
      "normalizedActualDigest",
      "evidenceGraphDigest",
      "assignmentDigest",
      "temporalInputDigest",
      "temporalNormalizedDigest",
      "temporalRelationsDigest",
      "layersDigest",
      "projectionDigest",
    ];
    const staleDigest = digestFields.some(
      (field) =>
        candidateProjection[field] !==
        expected[field as keyof ChronicleV2DiagnosticsProjection],
    );
    return {
      ok: false,
      diagnostics: [
        {
          code: staleDigest
            ? "V2_DIAGNOSTICS_DIGEST_STALE"
            : "V2_DIAGNOSTICS_CONTEXT_MISMATCH",
          message: staleDigest
            ? "Diagnostic digest does not match the supplied evaluator context"
            : "Diagnostic fixed fields do not match the supplied evaluator context",
        },
      ],
    };
  }
  return { ok: true, value: candidate as ChronicleV2DiagnosticsProjection };
}
