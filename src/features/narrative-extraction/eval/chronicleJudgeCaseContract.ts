import { sha256Digest } from "../source/digest";
import { freezeDeep } from "../source/immutability";

export const CHRONICLE_JUDGE_CASE_SCHEMA_VERSION = 1 as const;
export const CHRONICLE_JUDGE_CASE_CONTRACT_VERSION =
  "chronicle-judge-case-contract/1" as const;

export const CHRONICLE_JUDGE_CASE_COVERAGE_MODES = [
  "exhaustive",
  "targeted",
] as const;
export type ChronicleJudgeCaseCoverageMode =
  (typeof CHRONICLE_JUDGE_CASE_COVERAGE_MODES)[number];

export type ChronicleJudgeCaseRuntimeCapability =
  | "supported"
  | "representation-gap";

export interface ChronicleJudgeCaseEvidenceRegion {
  readonly documentId: string;
  /** UTF-16 code-unit offset, inclusive. */
  readonly start: number;
  /** UTF-16 code-unit offset, exclusive. */
  readonly end: number;
}

export interface ChronicleJudgeCaseSourceDocument {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  /** Lowercase SHA-256 hex of text encoded as UTF-8, without a prefix. */
  readonly textSha256: string;
}

export interface ChronicleJudgeCaseGoldParticipant {
  readonly entity: string;
  readonly role: string;
}

export interface ChronicleJudgeCaseGoldClaim {
  readonly id: string;
  readonly predicate: string;
  readonly participants: readonly ChronicleJudgeCaseGoldParticipant[];
  readonly actuality: string;
  readonly attribution: string;
  readonly narrativeFrame: string;
  readonly requiredDirectRegions: readonly ChronicleJudgeCaseEvidenceRegion[];
  readonly allowedContextRegions: readonly ChronicleJudgeCaseEvidenceRegion[];
  readonly granularity: "atomic";
}

export interface ChronicleJudgeCaseTemporalGold {
  readonly coverage: "targeted";
  readonly relations: readonly [];
  readonly unscoredClaimIds: readonly string[];
}

export interface ChronicleJudgeCaseProposalPolicy {
  readonly mode: "unscored";
  readonly scoredClaimIds: readonly [];
  readonly reason: "importance-not-annotated";
}

export interface ChronicleJudgeCaseScopeExclusion {
  readonly id: string;
  /** Human-readable meaning of the pre-declared out-of-scope item. */
  readonly meaning: string;
  readonly requiredDirectRegions: readonly ChronicleJudgeCaseEvidenceRegion[];
  readonly allowedContextRegions: readonly ChronicleJudgeCaseEvidenceRegion[];
  readonly reason?: string;
}

export interface ChronicleJudgeCaseReviewScope {
  readonly sourceAndGoldReviewed: true;
  readonly eventObservationPolicy: "case-atomic-claims-user-approved";
  readonly atomicObservationClaimIds: readonly string[];
  readonly temporalScope: "all-relations-unscored";
  readonly temporalRelationIds: readonly [];
  readonly excludedTemporalScopes: readonly string[];
  readonly scopeExclusionIds: readonly string[];
}

export interface ChronicleJudgeCaseAuthorship {
  readonly status: "draft-for-human-review";
  readonly derivation: "source-text-only";
  readonly independentSourceAnnotation: true;
  readonly candidateOutputContamination: false;
  readonly reviewRequired: true;
  readonly formalCertification: false;
  readonly semanticGoldStatus: "user-approved";
  readonly runtimeCapability: ChronicleJudgeCaseRuntimeCapability;
  readonly ordinaryQualityRun: "enabled" | "disabled";
  readonly reviewScope: ChronicleJudgeCaseReviewScope;
  readonly excludedInputs: readonly [
    "deleted-provider-response",
    "candidate-observation-wording",
    "v1-scorer-decision",
  ];
}

export interface ChronicleJudgeCaseCoverage {
  readonly observation: ChronicleJudgeCaseCoverageMode;
  readonly temporal: "targeted";
  readonly proposal: "targeted";
}

export interface ChronicleJudgeCaseContract {
  readonly schemaVersion: typeof CHRONICLE_JUDGE_CASE_SCHEMA_VERSION;
  readonly contractVersion: typeof CHRONICLE_JUDGE_CASE_CONTRACT_VERSION;
  readonly caseId: string;
  readonly authorship: ChronicleJudgeCaseAuthorship;
  readonly coverage: ChronicleJudgeCaseCoverage;
  readonly sourceDocuments: readonly ChronicleJudgeCaseSourceDocument[];
  readonly observationGold: {
    readonly claims: readonly ChronicleJudgeCaseGoldClaim[];
  };
  readonly temporalGold: ChronicleJudgeCaseTemporalGold;
  readonly proposalPolicy: ChronicleJudgeCaseProposalPolicy;
  readonly scopeExclusions: readonly ChronicleJudgeCaseScopeExclusion[];
}

export interface ChronicleJudgeCaseManifestEntry {
  readonly caseId: string;
  readonly file: string;
}

export interface ChronicleJudgeCaseManifest {
  readonly schemaVersion: typeof CHRONICLE_JUDGE_CASE_SCHEMA_VERSION;
  readonly contractVersion: typeof CHRONICLE_JUDGE_CASE_CONTRACT_VERSION;
  readonly suiteId: string;
  readonly fixtures: readonly ChronicleJudgeCaseManifestEntry[];
}

export interface ChronicleJudgeCaseContractDiagnostic {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
}

export type ChronicleJudgeCaseContractLoadResult =
  | { readonly ok: true; readonly value: ChronicleJudgeCaseContract }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ChronicleJudgeCaseContractDiagnostic[];
    };

export type ChronicleJudgeCaseManifestLoadResult =
  | { readonly ok: true; readonly value: ChronicleJudgeCaseManifest }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ChronicleJudgeCaseContractDiagnostic[];
    };

export type ChronicleJudgeCaseSourceDigestResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ChronicleJudgeCaseContractDiagnostic[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function isSha256Hex(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): boolean {
  const allowedSet = new Set(allowed);
  let valid = true;
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      diagnostics.push({
        code: "CASE_UNKNOWN_FIELD",
        path: `${path}.${key}`,
        message: `Unknown Chronicle judge case field: ${key}`,
      });
      valid = false;
    }
  }
  return valid;
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((item, index) => item === expected[index])
  );
}

function validateRegion(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, ChronicleJudgeCaseSourceDocument>,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): ChronicleJudgeCaseEvidenceRegion | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "CASE_REGION_INVALID",
      path,
      message: "Evidence region must be an object",
    });
    return null;
  }
  let valid = hasOnlyKeys(
    value,
    ["documentId", "start", "end"],
    path,
    diagnostics,
  );
  const document = documents.get(value.documentId as string);
  if (!isNonEmptyString(value.documentId) || !document) {
    diagnostics.push({
      code: "CASE_REGION_DOCUMENT_UNKNOWN",
      path: `${path}.documentId`,
      message: "Evidence region must identify a source document",
    });
    valid = false;
  }
  if (
    !Number.isInteger(value.start) ||
    !Number.isInteger(value.end) ||
    (value.start as number) < 0 ||
    (value.end as number) <= (value.start as number)
  ) {
    diagnostics.push({
      code: "CASE_REGION_RANGE_INVALID",
      path,
      message: "Evidence region requires integer start < end",
    });
    valid = false;
  } else if (document && (value.end as number) > document.text.length) {
    diagnostics.push({
      code: "CASE_REGION_OUT_OF_BOUNDS",
      path,
      message: "Evidence region must stay within UTF-16 source bounds",
    });
    valid = false;
  }
  if (!valid || !document) return null;
  return {
    documentId: value.documentId as string,
    start: value.start as number,
    end: value.end as number,
  };
}

function validateRegions(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, ChronicleJudgeCaseSourceDocument>,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
  requireOne: boolean,
): ChronicleJudgeCaseEvidenceRegion[] | null {
  if (!Array.isArray(value) || (requireOne && value.length === 0)) {
    diagnostics.push({
      code: "CASE_REGIONS_INVALID",
      path,
      message: requireOne
        ? "At least one evidence region is required"
        : "Evidence regions must be an array",
    });
    return null;
  }
  const regions: ChronicleJudgeCaseEvidenceRegion[] = [];
  let valid = true;
  for (const [index, regionValue] of value.entries()) {
    const region = validateRegion(
      regionValue,
      `${path}[${index}]`,
      documents,
      diagnostics,
    );
    if (region) regions.push(region);
    else valid = false;
  }
  return valid ? regions : null;
}

function validateClaim(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, ChronicleJudgeCaseSourceDocument>,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): ChronicleJudgeCaseGoldClaim | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "CASE_CLAIM_INVALID",
      path,
      message: "Gold claim must be an object",
    });
    return null;
  }
  let valid = hasOnlyKeys(
    value,
    [
      "id",
      "predicate",
      "participants",
      "actuality",
      "attribution",
      "narrativeFrame",
      "requiredDirectRegions",
      "allowedContextRegions",
      "granularity",
    ],
    path,
    diagnostics,
  );
  for (const field of [
    "id",
    "predicate",
    "actuality",
    "attribution",
    "narrativeFrame",
  ] as const) {
    if (!isNonEmptyString(value[field])) {
      diagnostics.push({
        code: "CASE_CLAIM_FIELD_INVALID",
        path: `${path}.${field}`,
        message: `Gold claim ${field} must be a non-empty string`,
      });
      valid = false;
    }
  }
  if (value.granularity !== "atomic") {
    diagnostics.push({
      code: "CASE_CLAIM_GRANULARITY_INVALID",
      path: `${path}.granularity`,
      message: "Gold claims must declare atomic granularity",
    });
    valid = false;
  }

  const participants: ChronicleJudgeCaseGoldParticipant[] = [];
  if (!Array.isArray(value.participants) || value.participants.length === 0) {
    diagnostics.push({
      code: "CASE_PARTICIPANTS_INVALID",
      path: `${path}.participants`,
      message: "Each Gold claim requires at least one participant",
    });
    valid = false;
  } else {
    for (const [index, participantValue] of value.participants.entries()) {
      const participantPath = `${path}.participants[${index}]`;
      if (!isRecord(participantValue)) {
        diagnostics.push({
          code: "CASE_PARTICIPANT_INVALID",
          path: participantPath,
          message: "Gold participant must be an object",
        });
        valid = false;
        continue;
      }
      valid =
        hasOnlyKeys(
          participantValue,
          ["entity", "role"],
          participantPath,
          diagnostics,
        ) && valid;
      if (!isNonEmptyString(participantValue.entity)) {
        diagnostics.push({
          code: "CASE_PARTICIPANT_ENTITY_INVALID",
          path: `${participantPath}.entity`,
          message: "Gold participant entity must be a non-empty string",
        });
        valid = false;
      }
      if (!isNonEmptyString(participantValue.role)) {
        diagnostics.push({
          code: "CASE_PARTICIPANT_ROLE_INVALID",
          path: `${participantPath}.role`,
          message: "Gold participant role must be a non-empty string",
        });
        valid = false;
      }
      if (
        isNonEmptyString(participantValue.entity) &&
        isNonEmptyString(participantValue.role)
      ) {
        participants.push({
          entity: participantValue.entity,
          role: participantValue.role,
        });
      }
    }
  }

  const requiredDirectRegions = validateRegions(
    value.requiredDirectRegions,
    `${path}.requiredDirectRegions`,
    documents,
    diagnostics,
    true,
  );
  const allowedContextRegions = validateRegions(
    value.allowedContextRegions,
    `${path}.allowedContextRegions`,
    documents,
    diagnostics,
    false,
  );
  if (!requiredDirectRegions || !allowedContextRegions) valid = false;
  if (
    !valid ||
    !isNonEmptyString(value.id) ||
    !isNonEmptyString(value.predicate) ||
    !isNonEmptyString(value.actuality) ||
    !isNonEmptyString(value.attribution) ||
    !isNonEmptyString(value.narrativeFrame) ||
    !requiredDirectRegions ||
    !allowedContextRegions
  ) {
    return null;
  }
  return {
    id: value.id,
    predicate: value.predicate,
    participants,
    actuality: value.actuality,
    attribution: value.attribution,
    narrativeFrame: value.narrativeFrame,
    requiredDirectRegions,
    allowedContextRegions,
    granularity: "atomic",
  };
}

function validateReviewScope(
  value: unknown,
  path: string,
  claimIds: ReadonlySet<string>,
  exclusionIds: ReadonlySet<string>,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): ChronicleJudgeCaseReviewScope | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "CASE_REVIEW_SCOPE_INVALID",
      path,
      message: "Authorship review scope is required",
    });
    return null;
  }
  let valid = hasOnlyKeys(
    value,
    [
      "sourceAndGoldReviewed",
      "eventObservationPolicy",
      "atomicObservationClaimIds",
      "temporalScope",
      "temporalRelationIds",
      "excludedTemporalScopes",
      "scopeExclusionIds",
    ],
    path,
    diagnostics,
  );
  if (
    value.sourceAndGoldReviewed !== true ||
    value.eventObservationPolicy !== "case-atomic-claims-user-approved" ||
    value.temporalScope !== "all-relations-unscored"
  ) {
    diagnostics.push({
      code: "CASE_REVIEW_SCOPE_INVALID",
      path,
      message: "Review scope must record the source-approved case boundaries",
    });
    valid = false;
  }
  const claimIdValues = value.atomicObservationClaimIds;
  if (
    !Array.isArray(claimIdValues) ||
    claimIdValues.length === 0 ||
    claimIdValues.length !== claimIds.size ||
    claimIdValues.some((claimId) => !isNonEmptyString(claimId)) ||
    new Set(claimIdValues).size !== claimIdValues.length ||
    claimIdValues.some((claimId) => !claimIds.has(claimId as string))
  ) {
    diagnostics.push({
      code: "CASE_REVIEW_CLAIMS_INVALID",
      path: `${path}.atomicObservationClaimIds`,
      message: "Review scope must name each known atomic Gold claim once",
    });
    valid = false;
  }
  if (
    !Array.isArray(value.temporalRelationIds) ||
    value.temporalRelationIds.length !== 0
  ) {
    diagnostics.push({
      code: "CASE_TEMPORAL_RELATIONS_INVALID",
      path: `${path}.temporalRelationIds`,
      message: "This transfer contract has no targeted temporal relations",
    });
    valid = false;
  }
  const excludedTemporalScopes = value.excludedTemporalScopes;
  if (
    !Array.isArray(excludedTemporalScopes) ||
    excludedTemporalScopes.length === 0 ||
    excludedTemporalScopes.some((scope) => !isNonEmptyString(scope)) ||
    new Set(excludedTemporalScopes).size !== excludedTemporalScopes.length
  ) {
    diagnostics.push({
      code: "CASE_TEMPORAL_SCOPE_INVALID",
      path: `${path}.excludedTemporalScopes`,
      message: "Excluded temporal scopes must be unique non-empty strings",
    });
    valid = false;
  }
  const scopeExclusionIdValues = value.scopeExclusionIds;
  if (
    !Array.isArray(scopeExclusionIdValues) ||
    scopeExclusionIdValues.length === 0 ||
    scopeExclusionIdValues.length !== exclusionIds.size ||
    scopeExclusionIdValues.some((id) => !isNonEmptyString(id)) ||
    new Set(scopeExclusionIdValues).size !== scopeExclusionIdValues.length ||
    scopeExclusionIdValues.some((id) => !exclusionIds.has(id as string))
  ) {
    diagnostics.push({
      code: "CASE_SCOPE_EXCLUSION_IDS_INVALID",
      path: `${path}.scopeExclusionIds`,
      message: "Review scope must name each scope exclusion once",
    });
    valid = false;
  }
  if (!valid) return null;
  const atomicObservationClaimIds = claimIdValues as readonly string[];
  const excludedTemporalScopeIds = excludedTemporalScopes as readonly string[];
  const scopeExclusionIds = scopeExclusionIdValues as readonly string[];
  return {
    sourceAndGoldReviewed: true,
    eventObservationPolicy: "case-atomic-claims-user-approved",
    atomicObservationClaimIds: [...atomicObservationClaimIds],
    temporalScope: "all-relations-unscored",
    temporalRelationIds: [],
    excludedTemporalScopes: [...excludedTemporalScopeIds],
    scopeExclusionIds: [...scopeExclusionIds],
  };
}

function validateAuthorship(
  value: unknown,
  path: string,
  claimIds: ReadonlySet<string>,
  exclusionIds: ReadonlySet<string>,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): ChronicleJudgeCaseAuthorship | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "CASE_AUTHORSHIP_INVALID",
      path,
      message: "Authorship record is required",
    });
    return null;
  }
  let valid = hasOnlyKeys(
    value,
    [
      "status",
      "derivation",
      "independentSourceAnnotation",
      "candidateOutputContamination",
      "reviewRequired",
      "formalCertification",
      "semanticGoldStatus",
      "runtimeCapability",
      "ordinaryQualityRun",
      "reviewScope",
      "excludedInputs",
    ],
    path,
    diagnostics,
  );
  if (
    value.status !== "draft-for-human-review" ||
    value.derivation !== "source-text-only" ||
    value.independentSourceAnnotation !== true ||
    value.candidateOutputContamination !== false ||
    value.reviewRequired !== true ||
    value.formalCertification !== false ||
    value.semanticGoldStatus !== "user-approved"
  ) {
    diagnostics.push({
      code:
        value.candidateOutputContamination === true
          ? "CASE_AUTHORSHIP_CONTAMINATED"
          : "CASE_AUTHORSHIP_POLICY_INVALID",
      path,
      message: "Gold authorship must remain source-only and draft for review",
    });
    valid = false;
  }
  if (!isOneOf(value.runtimeCapability, ["supported", "representation-gap"])) {
    diagnostics.push({
      code: "CASE_RUNTIME_CAPABILITY_INVALID",
      path: `${path}.runtimeCapability`,
      message: "Runtime capability must be supported or representation-gap",
    });
    valid = false;
  }
  if (!isOneOf(value.ordinaryQualityRun, ["enabled", "disabled"])) {
    diagnostics.push({
      code: "CASE_RUNTIME_POLICY_INVALID",
      path: `${path}.ordinaryQualityRun`,
      message: "Ordinary quality run policy must be enabled or disabled",
    });
    valid = false;
  } else if (
    (value.runtimeCapability === "representation-gap" &&
      value.ordinaryQualityRun !== "disabled") ||
    (value.runtimeCapability === "supported" &&
      value.ordinaryQualityRun !== "enabled")
  ) {
    diagnostics.push({
      code: "CASE_RUNTIME_POLICY_INVALID",
      path: path,
      message:
        "A representation gap disables ordinary quality runs; supported cases enable them",
    });
    valid = false;
  }
  const excludedInputs = value.excludedInputs;
  const expectedExcludedInputs = [
    "deleted-provider-response",
    "candidate-observation-wording",
    "v1-scorer-decision",
  ] as const;
  if (!exactStringArray(excludedInputs, expectedExcludedInputs)) {
    diagnostics.push({
      code: "CASE_AUTHORSHIP_INPUTS_INVALID",
      path: `${path}.excludedInputs`,
      message: "Excluded input sources must preserve the source-only boundary",
    });
    valid = false;
  }
  const reviewScope = validateReviewScope(
    value.reviewScope,
    `${path}.reviewScope`,
    claimIds,
    exclusionIds,
    diagnostics,
  );
  if (!reviewScope) valid = false;
  if (
    !valid ||
    !reviewScope ||
    !isOneOf(value.runtimeCapability, ["supported", "representation-gap"]) ||
    !isOneOf(value.ordinaryQualityRun, ["enabled", "disabled"])
  ) {
    return null;
  }
  return {
    status: "draft-for-human-review",
    derivation: "source-text-only",
    independentSourceAnnotation: true,
    candidateOutputContamination: false,
    reviewRequired: true,
    formalCertification: false,
    semanticGoldStatus: "user-approved",
    runtimeCapability: value.runtimeCapability,
    ordinaryQualityRun: value.ordinaryQualityRun,
    reviewScope,
    excludedInputs: expectedExcludedInputs,
  };
}

function validateCoverage(
  value: unknown,
  path: string,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): ChronicleJudgeCaseCoverage | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "CASE_COVERAGE_INVALID",
      path,
      message: "Coverage object is required",
    });
    return null;
  }
  const valid = hasOnlyKeys(
    value,
    ["observation", "temporal", "proposal"],
    path,
    diagnostics,
  );
  if (
    !valid ||
    !isOneOf(value.observation, CHRONICLE_JUDGE_CASE_COVERAGE_MODES) ||
    value.temporal !== "targeted" ||
    value.proposal !== "targeted"
  ) {
    diagnostics.push({
      code: "CASE_COVERAGE_INVALID",
      path,
      message:
        "Coverage requires observation mode and targeted temporal/proposal",
    });
    return null;
  }
  return {
    observation: value.observation,
    temporal: "targeted",
    proposal: "targeted",
  };
}

function validateTemporalGold(
  value: unknown,
  path: string,
  claimIds: readonly string[],
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): ChronicleJudgeCaseTemporalGold | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "CASE_TEMPORAL_GOLD_INVALID",
      path,
      message: "Temporal Gold object is required",
    });
    return null;
  }
  let valid = hasOnlyKeys(
    value,
    ["coverage", "relations", "unscoredClaimIds"],
    path,
    diagnostics,
  );
  if (value.coverage !== "targeted") valid = false;
  if (!Array.isArray(value.relations) || value.relations.length !== 0) {
    diagnostics.push({
      code: "CASE_TEMPORAL_RELATIONS_INVALID",
      path: `${path}.relations`,
      message: "Transfer cases have no targeted temporal relations",
    });
    valid = false;
  }
  if (!exactStringArray(value.unscoredClaimIds, claimIds)) {
    diagnostics.push({
      code: "CASE_TEMPORAL_UNSCORED_CLAIMS_INVALID",
      path: `${path}.unscoredClaimIds`,
      message:
        "Every observation Gold claim must remain explicitly unscored for time",
    });
    valid = false;
  }
  if (!valid) {
    diagnostics.push({
      code: "CASE_TEMPORAL_GOLD_INVALID",
      path,
      message: "Temporal Gold must use the targeted empty-relation policy",
    });
    return null;
  }
  return {
    coverage: "targeted",
    relations: [],
    unscoredClaimIds: [...claimIds],
  };
}

function validateProposalPolicy(
  value: unknown,
  path: string,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): ChronicleJudgeCaseProposalPolicy | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "CASE_PROPOSAL_POLICY_INVALID",
      path,
      message: "Proposal policy object is required",
    });
    return null;
  }
  const valid =
    hasOnlyKeys(
      value,
      ["mode", "scoredClaimIds", "reason"],
      path,
      diagnostics,
    ) &&
    value.mode === "unscored" &&
    Array.isArray(value.scoredClaimIds) &&
    value.scoredClaimIds.length === 0 &&
    value.reason === "importance-not-annotated";
  if (!valid) {
    diagnostics.push({
      code: "CASE_PROPOSAL_POLICY_INVALID",
      path,
      message: "Transfer cases leave Proposal importance unscored",
    });
    return null;
  }
  return {
    mode: "unscored",
    scoredClaimIds: [],
    reason: "importance-not-annotated",
  };
}

function validateSourceDocuments(
  value: unknown,
  path: string,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): {
  readonly sourceDocuments: ChronicleJudgeCaseSourceDocument[];
  readonly documents: ReadonlyMap<string, ChronicleJudgeCaseSourceDocument>;
} {
  const sourceDocuments: ChronicleJudgeCaseSourceDocument[] = [];
  const documents = new Map<string, ChronicleJudgeCaseSourceDocument>();
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push({
      code: "CASE_SOURCE_DOCUMENTS_INVALID",
      path,
      message: "At least one source document is required",
    });
    return { sourceDocuments, documents };
  }
  for (const [index, sourceValue] of value.entries()) {
    const sourcePath = `${path}[${index}]`;
    if (!isRecord(sourceValue)) {
      diagnostics.push({
        code: "CASE_SOURCE_DOCUMENT_INVALID",
        path: sourcePath,
        message: "Source document must be an object",
      });
      continue;
    }
    let valid = hasOnlyKeys(
      sourceValue,
      ["id", "title", "text", "textSha256"],
      sourcePath,
      diagnostics,
    );
    if (
      !isNonEmptyString(sourceValue.id) ||
      !isNonEmptyString(sourceValue.title) ||
      typeof sourceValue.text !== "string"
    ) {
      diagnostics.push({
        code: "CASE_SOURCE_DOCUMENT_INVALID",
        path: sourcePath,
        message: "Source document requires id, title, and text",
      });
      valid = false;
    }
    if (!isSha256Hex(sourceValue.textSha256)) {
      diagnostics.push({
        code: "CASE_SOURCE_HASH_INVALID",
        path: `${sourcePath}.textSha256`,
        message: "Source textSha256 must be lowercase 64-character SHA-256 hex",
      });
      valid = false;
    }
    if (!valid) continue;
    const sourceId = sourceValue.id as string;
    const sourceTitle = sourceValue.title as string;
    const sourceText = sourceValue.text as string;
    const sourceTextSha256 = sourceValue.textSha256 as string;
    if (documents.has(sourceId)) {
      diagnostics.push({
        code: "CASE_SOURCE_DOCUMENT_ID_DUPLICATE",
        path: `${sourcePath}.id`,
        message: `Duplicate source document id: ${sourceId}`,
      });
      continue;
    }
    const document: ChronicleJudgeCaseSourceDocument = {
      id: sourceId,
      title: sourceTitle,
      text: sourceText,
      textSha256: sourceTextSha256,
    };
    sourceDocuments.push(document);
    documents.set(document.id, document);
  }
  return { sourceDocuments, documents };
}

function validateScopeExclusions(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, ChronicleJudgeCaseSourceDocument>,
  diagnostics: ChronicleJudgeCaseContractDiagnostic[],
): ChronicleJudgeCaseScopeExclusion[] {
  const exclusions: ChronicleJudgeCaseScopeExclusion[] = [];
  const ids = new Set<string>();
  if (!Array.isArray(value) || value.length === 0) {
    diagnostics.push({
      code: "CASE_SCOPE_EXCLUSIONS_INVALID",
      path,
      message: "At least one explicit scope exclusion is required",
    });
    return exclusions;
  }
  for (const [index, exclusionValue] of value.entries()) {
    const exclusionPath = `${path}[${index}]`;
    if (!isRecord(exclusionValue)) {
      diagnostics.push({
        code: "CASE_SCOPE_EXCLUSION_INVALID",
        path: exclusionPath,
        message: "Scope exclusion must be an object",
      });
      continue;
    }
    let valid = hasOnlyKeys(
      exclusionValue,
      [
        "id",
        "meaning",
        "requiredDirectRegions",
        "allowedContextRegions",
        "reason",
      ],
      exclusionPath,
      diagnostics,
    );
    if (!isNonEmptyString(exclusionValue.id)) {
      diagnostics.push({
        code: "CASE_SCOPE_EXCLUSION_ID_INVALID",
        path: `${exclusionPath}.id`,
        message: "Scope exclusion id is required",
      });
      valid = false;
    }
    if (!isNonEmptyString(exclusionValue.meaning)) {
      diagnostics.push({
        code: "CASE_SCOPE_EXCLUSION_MEANING_INVALID",
        path: `${exclusionPath}.meaning`,
        message: "Scope exclusion meaning must be non-empty",
      });
      valid = false;
    }
    if (
      exclusionValue.reason !== undefined &&
      !isNonEmptyString(exclusionValue.reason)
    ) {
      diagnostics.push({
        code: "CASE_SCOPE_EXCLUSION_REASON_INVALID",
        path: `${exclusionPath}.reason`,
        message: "Scope exclusion reason must be non-empty when present",
      });
      valid = false;
    }
    const requiredDirectRegions = validateRegions(
      exclusionValue.requiredDirectRegions,
      `${exclusionPath}.requiredDirectRegions`,
      documents,
      diagnostics,
      true,
    );
    const allowedContextRegions = validateRegions(
      exclusionValue.allowedContextRegions,
      `${exclusionPath}.allowedContextRegions`,
      documents,
      diagnostics,
      false,
    );
    if (!requiredDirectRegions || !allowedContextRegions) valid = false;
    if (
      !valid ||
      !isNonEmptyString(exclusionValue.id) ||
      !isNonEmptyString(exclusionValue.meaning) ||
      !requiredDirectRegions ||
      !allowedContextRegions
    ) {
      continue;
    }
    if (ids.has(exclusionValue.id)) {
      diagnostics.push({
        code: "CASE_SCOPE_EXCLUSION_ID_DUPLICATE",
        path: `${exclusionPath}.id`,
        message: `Duplicate scope exclusion id: ${exclusionValue.id}`,
      });
      continue;
    }
    ids.add(exclusionValue.id);
    exclusions.push({
      id: exclusionValue.id,
      meaning: exclusionValue.meaning,
      requiredDirectRegions,
      allowedContextRegions,
      ...(isNonEmptyString(exclusionValue.reason)
        ? { reason: exclusionValue.reason }
        : {}),
    });
  }
  return exclusions;
}

/** Validate and detach a source-authored transfer case before an evaluation run. */
export function loadChronicleJudgeCaseContract(
  candidate: unknown,
): ChronicleJudgeCaseContractLoadResult {
  const diagnostics: ChronicleJudgeCaseContractDiagnostic[] = [];
  if (!isRecord(candidate)) {
    return {
      ok: false,
      diagnostics: [
        {
          code: "CASE_INVALID",
          message: "Chronicle judge case must be an object",
        },
      ],
    };
  }
  hasOnlyKeys(
    candidate,
    [
      "schemaVersion",
      "contractVersion",
      "caseId",
      "authorship",
      "coverage",
      "sourceDocuments",
      "observationGold",
      "temporalGold",
      "proposalPolicy",
      "scopeExclusions",
    ],
    "contract",
    diagnostics,
  );
  if (candidate.schemaVersion !== CHRONICLE_JUDGE_CASE_SCHEMA_VERSION) {
    diagnostics.push({
      code: "CASE_SCHEMA_VERSION_UNSUPPORTED",
      path: "schemaVersion",
      message: "Unsupported Chronicle judge case schema version",
    });
  }
  if (candidate.contractVersion !== CHRONICLE_JUDGE_CASE_CONTRACT_VERSION) {
    diagnostics.push({
      code: "CASE_CONTRACT_VERSION_UNSUPPORTED",
      path: "contractVersion",
      message: "Unsupported Chronicle judge case contract version",
    });
  }
  if (!isNonEmptyString(candidate.caseId)) {
    diagnostics.push({
      code: "CASE_ID_INVALID",
      path: "caseId",
      message: "Case id is required",
    });
  }

  const { sourceDocuments, documents } = validateSourceDocuments(
    candidate.sourceDocuments,
    "sourceDocuments",
    diagnostics,
  );

  const claims: ChronicleJudgeCaseGoldClaim[] = [];
  const claimIds = new Set<string>();
  if (!isRecord(candidate.observationGold)) {
    diagnostics.push({
      code: "CASE_OBSERVATION_GOLD_INVALID",
      path: "observationGold",
      message: "Observation Gold object is required",
    });
  } else {
    hasOnlyKeys(
      candidate.observationGold,
      ["claims"],
      "observationGold",
      diagnostics,
    );
    if (
      !Array.isArray(candidate.observationGold.claims) ||
      candidate.observationGold.claims.length === 0
    ) {
      diagnostics.push({
        code: "CASE_CLAIMS_INVALID",
        path: "observationGold.claims",
        message: "At least one atomic Gold claim is required",
      });
    } else {
      for (const [
        index,
        claimValue,
      ] of candidate.observationGold.claims.entries()) {
        const claim = validateClaim(
          claimValue,
          `observationGold.claims[${index}]`,
          documents,
          diagnostics,
        );
        if (!claim) continue;
        if (claimIds.has(claim.id)) {
          diagnostics.push({
            code: "CASE_CLAIM_ID_DUPLICATE",
            path: `observationGold.claims[${index}].id`,
            message: `Duplicate Gold claim id: ${claim.id}`,
          });
          continue;
        }
        claimIds.add(claim.id);
        claims.push(claim);
      }
    }
  }
  if (claims.length === 0) {
    diagnostics.push({
      code: "CASE_CLAIMS_EMPTY",
      path: "observationGold.claims",
      message: "The transfer contract requires at least one atomic claim",
    });
  }

  const scopeExclusions = validateScopeExclusions(
    candidate.scopeExclusions,
    "scopeExclusions",
    documents,
    diagnostics,
  );
  const exclusionIds = new Set(
    scopeExclusions.map((exclusion) => exclusion.id),
  );
  const authorship = validateAuthorship(
    candidate.authorship,
    "authorship",
    claimIds,
    exclusionIds,
    diagnostics,
  );
  const coverage = validateCoverage(
    candidate.coverage,
    "coverage",
    diagnostics,
  );
  const temporalGold = validateTemporalGold(
    candidate.temporalGold,
    "temporalGold",
    claims.map((claim) => claim.id),
    diagnostics,
  );
  const proposalPolicy = validateProposalPolicy(
    candidate.proposalPolicy,
    "proposalPolicy",
    diagnostics,
  );
  if (
    diagnostics.length > 0 ||
    !authorship ||
    !coverage ||
    !temporalGold ||
    !proposalPolicy ||
    !isNonEmptyString(candidate.caseId)
  ) {
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    value: freezeDeep({
      schemaVersion: CHRONICLE_JUDGE_CASE_SCHEMA_VERSION,
      contractVersion: CHRONICLE_JUDGE_CASE_CONTRACT_VERSION,
      caseId: candidate.caseId,
      authorship,
      coverage,
      sourceDocuments,
      observationGold: { claims },
      temporalGold,
      proposalPolicy,
      scopeExclusions,
    }),
  };
}

/** Validate and detach the manifest that enumerates transfer case fixtures. */
export function loadChronicleJudgeCaseManifest(
  candidate: unknown,
): ChronicleJudgeCaseManifestLoadResult {
  const diagnostics: ChronicleJudgeCaseContractDiagnostic[] = [];
  if (!isRecord(candidate)) {
    return {
      ok: false,
      diagnostics: [
        { code: "MANIFEST_INVALID", message: "Manifest must be an object" },
      ],
    };
  }
  let valid = hasOnlyKeys(
    candidate,
    ["schemaVersion", "contractVersion", "suiteId", "fixtures"],
    "manifest",
    diagnostics,
  );
  if (candidate.schemaVersion !== CHRONICLE_JUDGE_CASE_SCHEMA_VERSION) {
    diagnostics.push({
      code: "MANIFEST_SCHEMA_VERSION_UNSUPPORTED",
      path: "manifest.schemaVersion",
      message: "Manifest schemaVersion must match the case contract",
    });
    valid = false;
  }
  if (candidate.contractVersion !== CHRONICLE_JUDGE_CASE_CONTRACT_VERSION) {
    diagnostics.push({
      code: "MANIFEST_CONTRACT_VERSION_UNSUPPORTED",
      path: "manifest.contractVersion",
      message: "Manifest contractVersion must match the case contract",
    });
    valid = false;
  }
  if (!isNonEmptyString(candidate.suiteId)) {
    diagnostics.push({
      code: "MANIFEST_SUITE_ID_INVALID",
      path: "manifest.suiteId",
      message: "Manifest suiteId is required",
    });
    valid = false;
  }
  const fixtures: ChronicleJudgeCaseManifestEntry[] = [];
  const caseIds = new Set<string>();
  const files = new Set<string>();
  if (!Array.isArray(candidate.fixtures) || candidate.fixtures.length === 0) {
    diagnostics.push({
      code: "MANIFEST_FIXTURES_INVALID",
      path: "manifest.fixtures",
      message: "Manifest requires at least one fixture",
    });
    valid = false;
  } else {
    for (const [index, fixtureValue] of candidate.fixtures.entries()) {
      const fixturePath = `manifest.fixtures[${index}]`;
      if (!isRecord(fixtureValue)) {
        diagnostics.push({
          code: "MANIFEST_FIXTURE_INVALID",
          path: fixturePath,
          message: "Manifest fixture entry must be an object",
        });
        valid = false;
        continue;
      }
      let fixtureValid = hasOnlyKeys(
        fixtureValue,
        ["caseId", "file"],
        fixturePath,
        diagnostics,
      );
      if (!isNonEmptyString(fixtureValue.caseId)) {
        diagnostics.push({
          code: "MANIFEST_CASE_ID_INVALID",
          path: `${fixturePath}.caseId`,
          message: "Manifest fixture caseId is required",
        });
        fixtureValid = false;
      }
      if (
        !isNonEmptyString(fixtureValue.file) ||
        !/^[^/\\]+\.json$/.test(String(fixtureValue.file))
      ) {
        diagnostics.push({
          code: "MANIFEST_FILE_INVALID",
          path: `${fixturePath}.file`,
          message: "Manifest fixture file must be a relative JSON filename",
        });
        fixtureValid = false;
      }
      if (
        isNonEmptyString(fixtureValue.caseId) &&
        caseIds.has(fixtureValue.caseId)
      ) {
        diagnostics.push({
          code: "MANIFEST_CASE_ID_DUPLICATE",
          path: `${fixturePath}.caseId`,
          message: `Duplicate manifest caseId: ${fixtureValue.caseId}`,
        });
        fixtureValid = false;
      }
      if (isNonEmptyString(fixtureValue.file) && files.has(fixtureValue.file)) {
        diagnostics.push({
          code: "MANIFEST_FILE_DUPLICATE",
          path: `${fixturePath}.file`,
          message: `Duplicate manifest file: ${fixtureValue.file}`,
        });
        fixtureValid = false;
      }
      if (!fixtureValid) {
        valid = false;
        continue;
      }
      const caseId = fixtureValue.caseId as string;
      const file = fixtureValue.file as string;
      caseIds.add(caseId);
      files.add(file);
      fixtures.push({ caseId, file });
    }
  }
  if (!valid || !isNonEmptyString(candidate.suiteId)) {
    return { ok: false, diagnostics };
  }
  return {
    ok: true,
    value: freezeDeep({
      schemaVersion: CHRONICLE_JUDGE_CASE_SCHEMA_VERSION,
      contractVersion: CHRONICLE_JUDGE_CASE_CONTRACT_VERSION,
      suiteId: candidate.suiteId,
      fixtures,
    }),
  };
}

/** Verify source text digests after structural loading, without changing the case. */
export async function verifyChronicleJudgeCaseSourceDigest(
  contract: ChronicleJudgeCaseContract,
): Promise<ChronicleJudgeCaseSourceDigestResult> {
  const diagnostics: ChronicleJudgeCaseContractDiagnostic[] = [];
  for (const [index, source] of contract.sourceDocuments.entries()) {
    try {
      const digest = await sha256Digest(source.text);
      const actualHex = digest.slice("sha256:".length);
      if (actualHex !== source.textSha256) {
        diagnostics.push({
          code: "CASE_SOURCE_DIGEST_MISMATCH",
          path: `sourceDocuments[${index}].textSha256`,
          message: "Source text does not match its declared SHA-256 digest",
        });
      }
    } catch (error) {
      diagnostics.push({
        code: "CASE_SOURCE_DIGEST_INVALID",
        path: `sourceDocuments[${index}].text`,
        message:
          error instanceof Error
            ? error.message
            : "Source text could not be hashed",
      });
    }
  }
  return diagnostics.length === 0 ? { ok: true } : { ok: false, diagnostics };
}
