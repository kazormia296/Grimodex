import { freezeDeep } from "../source/immutability";

export const CHRONICLE_V2_SCHEMA_VERSION = 2 as const;
export const CHRONICLE_V2_CONTRACT_VERSION =
  "chronicle-evaluation-v2/3" as const;

export const CHRONICLE_V2_EVALUATION_SCOPES = [
  "observation-and-temporal",
  "observation-temporal-and-proposal",
] as const;
export type ChronicleV2EvaluationScope =
  (typeof CHRONICLE_V2_EVALUATION_SCOPES)[number];

export function chronicleV2EvaluationScopeFor(
  proposalMode: ChronicleV2ProposalPolicy["mode"],
): ChronicleV2EvaluationScope {
  return proposalMode === "unscored"
    ? "observation-and-temporal"
    : "observation-temporal-and-proposal";
}

export const CHRONICLE_V2_PREDICATES = [
  "chain-break",
  "gate-fall",
  "ring-bell",
  "evacuate",
  "gate-repair",
  "bell-break",
] as const;
export type ChronicleV2Predicate = (typeof CHRONICLE_V2_PREDICATES)[number];
export const CHRONICLE_V2_GOLD_PREDICATES = [
  "chain-break",
  "gate-fall",
  "ring-bell",
  "evacuate",
] as const;
export const CHRONICLE_V2_EXPECTED_CLAIM_COUNT = 4 as const;
export type ChronicleV2GoldPredicate =
  (typeof CHRONICLE_V2_GOLD_PREDICATES)[number];

export const CHRONICLE_V2_ENTITIES = [
  "north-gate-chain",
  "gate-leaf",
  "guard",
  "bell",
  "passerby",
  "street",
  "square",
] as const;
export type ChronicleV2Entity = (typeof CHRONICLE_V2_ENTITIES)[number];

export const CHRONICLE_V2_ROLES = [
  "agent",
  "causer",
  "destination",
  "theme",
] as const;
export type ChronicleV2Role = (typeof CHRONICLE_V2_ROLES)[number];

export const CHRONICLE_V2_ACTUALITIES = [
  "actual",
  "attempted",
  "dreamed",
  "hypothetical",
  "negated",
  "planned",
  "rumored",
] as const;
export type ChronicleV2Actuality = (typeof CHRONICLE_V2_ACTUALITIES)[number];

export const CHRONICLE_V2_ATTRIBUTIONS = [
  "character",
  "narrator",
  "reported",
  "unknown",
] as const;
export type ChronicleV2Attribution = (typeof CHRONICLE_V2_ATTRIBUTIONS)[number];

export const CHRONICLE_V2_NARRATIVE_FRAMES = [
  "dream",
  "flashback",
  "hypothetical",
  "plan",
  "reported-speech",
  "story-world",
] as const;
export type ChronicleV2NarrativeFrame =
  (typeof CHRONICLE_V2_NARRATIVE_FRAMES)[number];

export const CHRONICLE_V2_COVERAGE_MODES = ["exhaustive", "targeted"] as const;
export type ChronicleV2CoverageMode =
  (typeof CHRONICLE_V2_COVERAGE_MODES)[number];

export const CHRONICLE_V2_UNKNOWN_REASONS = [
  "actuality-out-of-vocabulary",
  "attribution-out-of-vocabulary",
  "entity-out-of-vocabulary",
  "malformed-actual",
  "narrative-frame-out-of-vocabulary",
  "predicate-out-of-vocabulary",
  "role-out-of-vocabulary",
] as const;
export type ChronicleV2UnknownReason =
  (typeof CHRONICLE_V2_UNKNOWN_REASONS)[number];

export type ChronicleV2Normalized<T> =
  | { readonly status: "known"; readonly value: T }
  | { readonly status: "unknown"; readonly reason: ChronicleV2UnknownReason };

export interface ChronicleV2GoldParticipant {
  readonly entity: ChronicleV2Entity;
  readonly role: ChronicleV2Role;
}

export interface ChronicleV2EvidenceRegion {
  readonly documentId: string;
  readonly start: number;
  readonly end: number;
}

export interface ChronicleV2GoldClaim {
  readonly id: string;
  readonly predicate: ChronicleV2GoldPredicate;
  readonly participants: readonly ChronicleV2GoldParticipant[];
  readonly actuality: ChronicleV2Actuality;
  readonly attribution: ChronicleV2Attribution;
  readonly narrativeFrame: ChronicleV2NarrativeFrame;
  /** Every required direct region must be covered by the actual citation union. */
  readonly requiredDirectRegions: readonly ChronicleV2EvidenceRegion[];
  /** Context that must be visible in the same request window, but is not
   * supplied by Gold to complete an actual claim. */
  readonly allowedContextRegions: readonly ChronicleV2EvidenceRegion[];
  readonly granularity: "atomic";
}

export interface ChronicleV2SourceDocument {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}

export interface ChronicleV2TemporalGoldRelation {
  readonly id: string;
  readonly targetClaimId: string;
  readonly relation: "occurs-at";
  readonly expression: "夜半";
  readonly requiredRegion: ChronicleV2EvidenceRegion;
}

export interface ChronicleV2TemporalGold {
  readonly coverage: "targeted";
  readonly relations: readonly ChronicleV2TemporalGoldRelation[];
  readonly unscoredClaimIds: readonly string[];
}

export interface ChronicleV2AuthorshipReviewScope {
  readonly sourceAndGoldReviewed: true;
  readonly eventObservationPolicy: "four-atomic-claims-user-approved";
  readonly atomicObservationClaimIds: readonly [
    "chain-break",
    "gate-fall",
    "guards-ring-bell",
    "guards-evacuate-passersby",
  ];
  readonly temporalRelationScope: "night-half-to-first-two-claims-user-approved";
  readonly temporalRelationIds: readonly [
    "night-half-chain-break",
    "night-half-gate-fall",
  ];
  readonly temporalUnscoredClaimIds: readonly [
    "guards-ring-bell",
    "guards-evacuate-passersby",
  ];
  readonly excludedTemporalScopes: readonly [
    "absolute-date-conversion",
    "downstream-sentence-time-inheritance",
    "structured-entity-properties",
    "proposal-importance",
  ];
}

export interface ChronicleV2AuthorshipRecord {
  readonly status: "draft-for-human-review";
  readonly derivation: "source-text-only";
  readonly independentSourceAnnotation: true;
  readonly candidateOutputContamination: false;
  readonly reviewRequired: true;
  readonly formalCertification: false;
  readonly reviewScope: ChronicleV2AuthorshipReviewScope;
  readonly excludedInputs: readonly [
    "deleted-provider-response",
    "candidate-observation-wording",
    "v1-scorer-decision",
  ];
}

export interface ChronicleV2Coverage {
  readonly observation: ChronicleV2CoverageMode;
  readonly proposal: ChronicleV2CoverageMode;
}

export type ChronicleV2ProposalDecision = "propose" | "suppress";

export type ChronicleV2ProposalPolicy =
  | {
      readonly mode: "unscored";
      readonly scoredClaimIds: readonly [];
      readonly reason: "importance-not-annotated";
    }
  | {
      readonly mode: "scored";
      readonly scoredClaimIds: readonly string[];
      readonly expectedDecisions: Readonly<
        Record<string, ChronicleV2ProposalDecision>
      >;
      readonly reason: "explicit-fixture-policy";
    };

export interface ChronicleV2Contract {
  readonly schemaVersion: typeof CHRONICLE_V2_SCHEMA_VERSION;
  readonly contractVersion: typeof CHRONICLE_V2_CONTRACT_VERSION;
  readonly caseId: string;
  readonly authorship: ChronicleV2AuthorshipRecord;
  readonly coverage: ChronicleV2Coverage;
  readonly sourceDocuments: readonly ChronicleV2SourceDocument[];
  readonly observationGold: {
    readonly claims: readonly ChronicleV2GoldClaim[];
  };
  readonly temporalGold: ChronicleV2TemporalGold;
  readonly proposalPolicy: ChronicleV2ProposalPolicy;
}

export interface ChronicleV2RawActualParticipant {
  readonly entity: string;
  readonly role: string;
}

export interface ChronicleV2RawActualClaim {
  readonly id: string;
  readonly predicate: string;
  readonly participants: readonly ChronicleV2RawActualParticipant[];
  readonly actuality: string;
  readonly attribution: string;
  readonly narrativeFrame: string;
  readonly evidenceRefs: readonly string[];
}

export interface ChronicleV2NormalizedParticipant {
  readonly entity: ChronicleV2Normalized<ChronicleV2Entity>;
  readonly role: ChronicleV2Normalized<ChronicleV2Role>;
}

export interface ChronicleV2NormalizedActualClaim {
  readonly actualRef: string;
  readonly predicate: ChronicleV2Normalized<ChronicleV2Predicate>;
  readonly participants: readonly ChronicleV2NormalizedParticipant[];
  readonly actuality: ChronicleV2Normalized<ChronicleV2Actuality>;
  readonly attribution: ChronicleV2Normalized<ChronicleV2Attribution>;
  readonly narrativeFrame: ChronicleV2Normalized<ChronicleV2NarrativeFrame>;
  readonly evidenceRefs: readonly string[];
}

/** Ephemeral graph edge: B derives it from the canonical resolver and coordinates. */
export interface ChronicleV2EvidenceCandidate {
  readonly actualRef: string;
  readonly goldRef: string | null;
  readonly evidenceValid: boolean;
  readonly overlap: boolean;
  /** The actual citation range union covers every required direct region. */
  readonly directSupport: boolean;
  /** The same request window exposes every allowed context region. */
  readonly contextSupport: boolean;
}

/** Stable boundary consumed by the independent alignment and diagnostics lane. */
export interface ChronicleV2AlignmentInput {
  readonly goldClaims: readonly ChronicleV2GoldClaim[];
  readonly normalizedActualClaims: readonly ChronicleV2NormalizedActualClaim[];
  readonly evidenceCandidates: readonly ChronicleV2EvidenceCandidate[];
  readonly coverage: ChronicleV2Coverage;
  readonly proposalPolicy: ChronicleV2ProposalPolicy;
}

export interface ChronicleV2ContractDiagnostic {
  readonly code: string;
  readonly path?: string;
  readonly message: string;
}

export type ChronicleV2ContractLoadResult =
  | { readonly ok: true; readonly value: ChronicleV2Contract }
  | {
      readonly ok: false;
      readonly diagnostics: readonly ChronicleV2ContractDiagnostic[];
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  diagnostics: ChronicleV2ContractDiagnostic[],
): boolean {
  const allowedSet = new Set(allowed);
  let valid = true;
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      diagnostics.push({
        code: "V2_UNKNOWN_FIELD",
        path: `${path}.${key}`,
        message: `Unknown Chronicle v2 field: ${key}`,
      });
      valid = false;
    }
  }
  return valid;
}

function isOneOf<T extends string>(
  value: unknown,
  values: readonly T[],
): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function validateRegion(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, ChronicleV2SourceDocument>,
  diagnostics: ChronicleV2ContractDiagnostic[],
): ChronicleV2EvidenceRegion | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "V2_EVIDENCE_REGION_INVALID",
      path,
      message: "Evidence region must be an object",
    });
    return null;
  }
  hasOnlyKeys(value, ["documentId", "start", "end"], path, diagnostics);
  const document = documents.get(value.documentId as string);
  let valid = true;
  if (!isNonEmptyString(value.documentId) || !document) {
    diagnostics.push({
      code: "V2_EVIDENCE_DOCUMENT_UNKNOWN",
      path: `${path}.documentId`,
      message: "Evidence region documentId must identify a source document",
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
      code: "V2_EVIDENCE_REGION_RANGE_INVALID",
      path,
      message: "Evidence region requires integer start < end",
    });
    valid = false;
  } else if (document && (value.end as number) > document.text.length) {
    diagnostics.push({
      code: "V2_EVIDENCE_REGION_OUT_OF_BOUNDS",
      path,
      message: "Evidence region must stay within the source document",
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

function validateClaim(
  value: unknown,
  path: string,
  documents: ReadonlyMap<string, ChronicleV2SourceDocument>,
  diagnostics: ChronicleV2ContractDiagnostic[],
): ChronicleV2GoldClaim | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "V2_CLAIM_INVALID",
      path,
      message: "Gold claim must be an object",
    });
    return null;
  }
  hasOnlyKeys(
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
  let valid = true;
  if (!isNonEmptyString(value.id)) {
    diagnostics.push({
      code: "V2_CLAIM_ID_INVALID",
      path: `${path}.id`,
      message: "Gold claim id is required",
    });
    valid = false;
  }
  if (!isOneOf(value.predicate, CHRONICLE_V2_GOLD_PREDICATES)) {
    diagnostics.push({
      code: "V2_PREDICATE_INVALID",
      path: `${path}.predicate`,
      message: "Gold claim predicate is outside the v2 fixture vocabulary",
    });
    valid = false;
  }
  if (!isOneOf(value.actuality, CHRONICLE_V2_ACTUALITIES)) {
    diagnostics.push({
      code: "V2_ACTUALITY_INVALID",
      path: `${path}.actuality`,
      message: "Gold claim actuality is outside the v2 fixture vocabulary",
    });
    valid = false;
  }
  if (!isOneOf(value.attribution, CHRONICLE_V2_ATTRIBUTIONS)) {
    diagnostics.push({
      code: "V2_ATTRIBUTION_INVALID",
      path: `${path}.attribution`,
      message: "Gold claim attribution is outside the v2 fixture vocabulary",
    });
    valid = false;
  }
  if (!isOneOf(value.narrativeFrame, CHRONICLE_V2_NARRATIVE_FRAMES)) {
    diagnostics.push({
      code: "V2_NARRATIVE_FRAME_INVALID",
      path: `${path}.narrativeFrame`,
      message: "Gold claim narrative frame is outside the v2 vocabulary",
    });
    valid = false;
  }
  if (value.granularity !== "atomic") {
    diagnostics.push({
      code: "V2_GRANULARITY_INVALID",
      path: `${path}.granularity`,
      message: "v2 Gold claims must declare atomic granularity",
    });
    valid = false;
  }

  const participants: ChronicleV2GoldParticipant[] = [];
  if (!Array.isArray(value.participants) || value.participants.length === 0) {
    diagnostics.push({
      code: "V2_PARTICIPANTS_INVALID",
      path: `${path}.participants`,
      message: "Each Gold claim requires at least one participant",
    });
    valid = false;
  } else {
    for (const [index, participantValue] of value.participants.entries()) {
      const participantPath = `${path}.participants[${index}]`;
      if (!isRecord(participantValue)) {
        diagnostics.push({
          code: "V2_PARTICIPANT_INVALID",
          path: participantPath,
          message: "Gold participant must be an object",
        });
        valid = false;
        continue;
      }
      hasOnlyKeys(
        participantValue,
        ["entity", "role"],
        participantPath,
        diagnostics,
      );
      if (!isOneOf(participantValue.entity, CHRONICLE_V2_ENTITIES)) {
        diagnostics.push({
          code: "V2_ENTITY_INVALID",
          path: `${participantPath}.entity`,
          message: "Gold participant entity is outside the v2 vocabulary",
        });
        valid = false;
      }
      if (!isOneOf(participantValue.role, CHRONICLE_V2_ROLES)) {
        diagnostics.push({
          code: "V2_ROLE_INVALID",
          path: `${participantPath}.role`,
          message: "Gold participant role is outside the v2 vocabulary",
        });
        valid = false;
      }
      if (
        isOneOf(participantValue.entity, CHRONICLE_V2_ENTITIES) &&
        isOneOf(participantValue.role, CHRONICLE_V2_ROLES)
      ) {
        participants.push({
          entity: participantValue.entity,
          role: participantValue.role,
        });
      }
    }
  }

  const requiredDirectRegions: ChronicleV2EvidenceRegion[] = [];
  if (
    !Array.isArray(value.requiredDirectRegions) ||
    value.requiredDirectRegions.length === 0
  ) {
    diagnostics.push({
      code: "V2_DIRECT_REGIONS_INVALID",
      path: `${path}.requiredDirectRegions`,
      message: "Each Gold claim requires at least one required direct region",
    });
    valid = false;
  } else {
    for (const [index, regionValue] of value.requiredDirectRegions.entries()) {
      const region = validateRegion(
        regionValue,
        `${path}.requiredDirectRegions[${index}]`,
        documents,
        diagnostics,
      );
      if (region) requiredDirectRegions.push(region);
      else valid = false;
    }
  }

  const allowedContextRegions: ChronicleV2EvidenceRegion[] = [];
  if (!Array.isArray(value.allowedContextRegions)) {
    diagnostics.push({
      code: "V2_CONTEXT_REGIONS_INVALID",
      path: `${path}.allowedContextRegions`,
      message: "Each Gold claim requires an allowed context region array",
    });
    valid = false;
  } else {
    for (const [index, regionValue] of value.allowedContextRegions.entries()) {
      const region = validateRegion(
        regionValue,
        `${path}.allowedContextRegions[${index}]`,
        documents,
        diagnostics,
      );
      if (region) allowedContextRegions.push(region);
      else valid = false;
    }
  }

  if (
    !valid ||
    !isNonEmptyString(value.id) ||
    !isOneOf(value.predicate, CHRONICLE_V2_GOLD_PREDICATES) ||
    !isOneOf(value.actuality, CHRONICLE_V2_ACTUALITIES) ||
    !isOneOf(value.attribution, CHRONICLE_V2_ATTRIBUTIONS) ||
    !isOneOf(value.narrativeFrame, CHRONICLE_V2_NARRATIVE_FRAMES)
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

function validateProposalPolicy(
  value: unknown,
  claimIds: ReadonlySet<string>,
  path: string,
  diagnostics: ChronicleV2ContractDiagnostic[],
): ChronicleV2ProposalPolicy | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "V2_PROPOSAL_POLICY_INVALID",
      path,
      message: "Proposal policy must be an object",
    });
    return null;
  }
  if (value.mode === "unscored") {
    hasOnlyKeys(value, ["mode", "scoredClaimIds", "reason"], path, diagnostics);
    if (
      !Array.isArray(value.scoredClaimIds) ||
      value.scoredClaimIds.length !== 0 ||
      value.reason !== "importance-not-annotated"
    ) {
      diagnostics.push({
        code: "V2_PROPOSAL_POLICY_UNSCORED_INVALID",
        path,
        message:
          "Unscored proposal policy must carry no claim IDs and an explicit reason",
      });
      return null;
    }
    return {
      mode: "unscored",
      scoredClaimIds: [],
      reason: "importance-not-annotated",
    };
  }
  if (value.mode !== "scored") {
    diagnostics.push({
      code: "V2_PROPOSAL_POLICY_MODE_INVALID",
      path: `${path}.mode`,
      message: "Proposal policy mode must be scored or unscored",
    });
    return null;
  }
  hasOnlyKeys(
    value,
    ["mode", "scoredClaimIds", "expectedDecisions", "reason"],
    path,
    diagnostics,
  );
  if (
    value.reason !== "explicit-fixture-policy" ||
    !Array.isArray(value.scoredClaimIds) ||
    !isRecord(value.expectedDecisions)
  ) {
    diagnostics.push({
      code: "V2_PROPOSAL_POLICY_SCORED_INVALID",
      path,
      message:
        "Scored proposal policy requires explicit claim IDs and decisions",
    });
    return null;
  }
  const ids = value.scoredClaimIds.filter(isNonEmptyString);
  if (
    ids.length !== value.scoredClaimIds.length ||
    ids.some((id) => !claimIds.has(id))
  ) {
    diagnostics.push({
      code: "V2_PROPOSAL_CLAIM_UNKNOWN",
      path: `${path}.scoredClaimIds`,
      message: "Proposal policy references an unknown claim",
    });
  }
  const expectedDecisions: Record<string, ChronicleV2ProposalDecision> = {};
  for (const [id, decision] of Object.entries(value.expectedDecisions)) {
    if (
      !claimIds.has(id) ||
      !ids.includes(id) ||
      !isOneOf(decision, ["propose", "suppress"])
    ) {
      diagnostics.push({
        code: "V2_PROPOSAL_DECISION_INVALID",
        path: `${path}.expectedDecisions.${id}`,
        message:
          "Proposal decision must target a scored claim and use a finite value",
      });
      continue;
    }
    expectedDecisions[id] = decision;
  }
  if (
    Object.keys(expectedDecisions).length !== ids.length ||
    new Set(ids).size !== ids.length
  ) {
    diagnostics.push({
      code: "V2_PROPOSAL_DECISION_PARTITION_INVALID",
      path,
      message:
        "Every scored proposal claim needs exactly one expected decision",
    });
  }
  if (diagnostics.some((diagnostic) => diagnostic.path?.startsWith(path)))
    return null;
  return {
    mode: "scored",
    scoredClaimIds: ids,
    expectedDecisions,
    reason: "explicit-fixture-policy",
  };
}

function validateReviewScope(
  value: unknown,
  path: string,
  claimIds: ReadonlySet<string>,
  diagnostics: ChronicleV2ContractDiagnostic[],
): ChronicleV2AuthorshipReviewScope | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "V2_AUTHORSHIP_REVIEW_SCOPE_INVALID",
      path,
      message: "Scoped review record is required",
    });
    return null;
  }
  hasOnlyKeys(
    value,
    [
      "sourceAndGoldReviewed",
      "eventObservationPolicy",
      "atomicObservationClaimIds",
      "temporalRelationScope",
      "temporalRelationIds",
      "temporalUnscoredClaimIds",
      "excludedTemporalScopes",
    ],
    path,
    diagnostics,
  );
  const atomicObservationClaimIds = value.atomicObservationClaimIds;
  const temporalRelationIds = value.temporalRelationIds;
  const temporalUnscoredClaimIds = value.temporalUnscoredClaimIds;
  const excludedTemporalScopes = value.excludedTemporalScopes;
  const expectedAtomicClaimIds = [
    "chain-break",
    "gate-fall",
    "guards-ring-bell",
    "guards-evacuate-passersby",
  ] as const;
  const expectedTemporalRelationIds = [
    "night-half-chain-break",
    "night-half-gate-fall",
  ] as const;
  const expectedTemporalUnscoredClaimIds = [
    "guards-ring-bell",
    "guards-evacuate-passersby",
  ] as const;
  const expectedExcludedTemporalScopes = [
    "absolute-date-conversion",
    "downstream-sentence-time-inheritance",
    "structured-entity-properties",
    "proposal-importance",
  ] as const;
  const isExactArray = (
    actual: unknown,
    expected: readonly string[],
  ): actual is readonly string[] =>
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((item, index) => item === expected[index]);
  const valid =
    value.sourceAndGoldReviewed === true &&
    value.eventObservationPolicy === "four-atomic-claims-user-approved" &&
    isExactArray(atomicObservationClaimIds, expectedAtomicClaimIds) &&
    isExactArray(temporalRelationIds, expectedTemporalRelationIds) &&
    value.temporalRelationScope ===
      "night-half-to-first-two-claims-user-approved" &&
    isExactArray(temporalUnscoredClaimIds, expectedTemporalUnscoredClaimIds) &&
    isExactArray(excludedTemporalScopes, expectedExcludedTemporalScopes) &&
    expectedAtomicClaimIds.every((claimId) => claimIds.has(claimId));
  if (!valid) {
    diagnostics.push({
      code: "V2_AUTHORSHIP_REVIEW_SCOPE_INVALID",
      path,
      message:
        "Scoped review must record the approved four-event and two-relation boundaries",
    });
    return null;
  }
  return {
    sourceAndGoldReviewed: true,
    eventObservationPolicy: "four-atomic-claims-user-approved",
    atomicObservationClaimIds: expectedAtomicClaimIds,
    temporalRelationScope: "night-half-to-first-two-claims-user-approved",
    temporalRelationIds: expectedTemporalRelationIds,
    temporalUnscoredClaimIds: expectedTemporalUnscoredClaimIds,
    excludedTemporalScopes: expectedExcludedTemporalScopes,
  };
}

function validateTemporalGold(
  value: unknown,
  path: string,
  claimIds: ReadonlySet<string>,
  documents: ReadonlyMap<string, ChronicleV2SourceDocument>,
  diagnostics: ChronicleV2ContractDiagnostic[],
): ChronicleV2TemporalGold | null {
  if (!isRecord(value)) {
    diagnostics.push({
      code: "V2_TEMPORAL_GOLD_INVALID",
      path,
      message: "Temporal Gold object is required",
    });
    return null;
  }
  hasOnlyKeys(
    value,
    ["coverage", "relations", "unscoredClaimIds"],
    path,
    diagnostics,
  );
  let valid = value.coverage === "targeted";
  if (!valid) {
    diagnostics.push({
      code: "V2_TEMPORAL_COVERAGE_INVALID",
      path: `${path}.coverage`,
      message: "Temporal Gold coverage must be targeted",
    });
  }

  const relations: ChronicleV2TemporalGoldRelation[] = [];
  const expected = [
    { id: "night-half-chain-break", targetClaimId: "chain-break" },
    { id: "night-half-gate-fall", targetClaimId: "gate-fall" },
  ] as const;
  if (!Array.isArray(value.relations) || value.relations.length !== 2) {
    diagnostics.push({
      code: "V2_TEMPORAL_RELATION_COUNT_INVALID",
      path: `${path}.relations`,
      message: "Temporal Gold requires exactly two targeted relations",
    });
    valid = false;
  } else {
    for (const [index, relationValue] of value.relations.entries()) {
      const relationPath = `${path}.relations[${index}]`;
      if (!isRecord(relationValue)) {
        diagnostics.push({
          code: "V2_TEMPORAL_RELATION_INVALID",
          path: relationPath,
          message: "Temporal Gold relation must be an object",
        });
        valid = false;
        continue;
      }
      hasOnlyKeys(
        relationValue,
        ["id", "targetClaimId", "relation", "expression", "requiredRegion"],
        relationPath,
        diagnostics,
      );
      const expectedRelation = expected[index];
      if (
        !expectedRelation ||
        relationValue.id !== expectedRelation.id ||
        relationValue.targetClaimId !== expectedRelation.targetClaimId
      ) {
        if (
          relationValue.targetClaimId === "guards-ring-bell" ||
          relationValue.targetClaimId === "guards-evacuate-passersby"
        ) {
          diagnostics.push({
            code: "V2_TEMPORAL_TARGET_UNSCORED",
            path: `${relationPath}.targetClaimId`,
            message: "Temporal Gold cannot score an explicitly unscored event",
          });
        } else {
          diagnostics.push({
            code: "V2_TEMPORAL_TARGET_INVALID",
            path: `${relationPath}.targetClaimId`,
            message:
              "Temporal Gold target must be one of the first two event claims",
          });
        }
        valid = false;
      }
      if (relationValue.relation !== "occurs-at") {
        diagnostics.push({
          code: "V2_TEMPORAL_RELATION_KIND_INVALID",
          path: `${relationPath}.relation`,
          message: "Temporal relation must use occurs-at",
        });
        valid = false;
      }
      if (relationValue.expression !== "夜半") {
        diagnostics.push({
          code: "V2_TEMPORAL_EXPRESSION_INVALID",
          path: `${relationPath}.expression`,
          message: "This bounded temporal fixture only annotates 夜半",
        });
        valid = false;
      }
      const region = validateRegion(
        relationValue.requiredRegion,
        `${relationPath}.requiredRegion`,
        documents,
        diagnostics,
      );
      if (
        !region ||
        region.documentId !== "scene-north-gate" ||
        region.start !== 0 ||
        region.end !== 2
      ) {
        diagnostics.push({
          code: "V2_TEMPORAL_REGION_INVALID",
          path: `${relationPath}.requiredRegion`,
          message: "夜半 must use scene-north-gate UTF-16 region [0,2)",
        });
        valid = false;
      }
      if (
        isNonEmptyString(relationValue.id) &&
        isNonEmptyString(relationValue.targetClaimId) &&
        relationValue.relation === "occurs-at" &&
        relationValue.expression === "夜半" &&
        region &&
        relationValue.id === expectedRelation?.id &&
        relationValue.targetClaimId === expectedRelation.targetClaimId &&
        claimIds.has(relationValue.targetClaimId)
      ) {
        relations.push({
          id: relationValue.id,
          targetClaimId: relationValue.targetClaimId,
          relation: "occurs-at",
          expression: "夜半",
          requiredRegion: region,
        });
      }
    }
  }

  const expectedUnscoredClaimIds = [
    "guards-ring-bell",
    "guards-evacuate-passersby",
  ] as const;
  if (
    !Array.isArray(value.unscoredClaimIds) ||
    value.unscoredClaimIds.length !== expectedUnscoredClaimIds.length ||
    !value.unscoredClaimIds.every(
      (claimId, index) => claimId === expectedUnscoredClaimIds[index],
    )
  ) {
    diagnostics.push({
      code: "V2_TEMPORAL_UNSCORED_CLAIMS_INVALID",
      path: `${path}.unscoredClaimIds`,
      message: "Temporal Gold must leave the two later event claims unscored",
    });
    valid = false;
  }
  if (
    !expectedUnscoredClaimIds.every((claimId) => claimIds.has(claimId)) ||
    relations.length !== expected.length
  ) {
    valid = false;
  }
  return valid
    ? {
        coverage: "targeted",
        relations,
        unscoredClaimIds: expectedUnscoredClaimIds,
      }
    : null;
}

/** Validate and detach the source-authored v2 Gold contract before use. */
export function loadChronicleV2Contract(
  candidate: unknown,
): ChronicleV2ContractLoadResult {
  const diagnostics: ChronicleV2ContractDiagnostic[] = [];
  if (!isRecord(candidate)) {
    return {
      ok: false,
      diagnostics: [
        { code: "V2_CONTRACT_INVALID", message: "Contract must be an object" },
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
    ],
    "contract",
    diagnostics,
  );
  if (candidate.schemaVersion !== CHRONICLE_V2_SCHEMA_VERSION) {
    diagnostics.push({
      code: "V2_SCHEMA_VERSION_UNSUPPORTED",
      path: "schemaVersion",
      message: "Unsupported Chronicle v2 schema version",
    });
  }
  if (candidate.contractVersion !== CHRONICLE_V2_CONTRACT_VERSION) {
    diagnostics.push({
      code: "V2_CONTRACT_VERSION_UNSUPPORTED",
      path: "contractVersion",
      message: "Unsupported Chronicle v2 contract version",
    });
  }
  if (!isNonEmptyString(candidate.caseId)) {
    diagnostics.push({
      code: "V2_CASE_ID_INVALID",
      path: "caseId",
      message: "v2 caseId is required",
    });
  }

  let authorship: ChronicleV2AuthorshipRecord | null = null;
  if (!isRecord(candidate.authorship)) {
    diagnostics.push({
      code: "V2_AUTHORSHIP_INVALID",
      path: "authorship",
      message: "Authorship record is required",
    });
  } else {
    hasOnlyKeys(
      candidate.authorship,
      [
        "status",
        "derivation",
        "independentSourceAnnotation",
        "candidateOutputContamination",
        "reviewRequired",
        "formalCertification",
        "reviewScope",
        "excludedInputs",
      ],
      "authorship",
      diagnostics,
    );
    const excludedInputs = candidate.authorship.excludedInputs;
    if (
      candidate.authorship.status !== "draft-for-human-review" ||
      candidate.authorship.derivation !== "source-text-only" ||
      candidate.authorship.independentSourceAnnotation !== true ||
      candidate.authorship.candidateOutputContamination !== false ||
      candidate.authorship.reviewRequired !== true ||
      candidate.authorship.formalCertification !== false ||
      !Array.isArray(excludedInputs) ||
      excludedInputs.length !== 3 ||
      excludedInputs[0] !== "deleted-provider-response" ||
      excludedInputs[1] !== "candidate-observation-wording" ||
      excludedInputs[2] !== "v1-scorer-decision"
    ) {
      diagnostics.push({
        code:
          candidate.authorship.candidateOutputContamination === true
            ? "V2_AUTHORSHIP_CONTAMINATED"
            : "V2_AUTHORSHIP_POLICY_INVALID",
        path: "authorship",
        message:
          "v2 Gold authorship must remain source-only and draft for human review",
      });
    } else {
      const reviewScope = validateReviewScope(
        candidate.authorship.reviewScope,
        "authorship.reviewScope",
        new Set([
          "chain-break",
          "gate-fall",
          "guards-ring-bell",
          "guards-evacuate-passersby",
        ]),
        diagnostics,
      );
      if (reviewScope) {
        authorship = {
          status: "draft-for-human-review",
          derivation: "source-text-only",
          independentSourceAnnotation: true,
          candidateOutputContamination: false,
          reviewRequired: true,
          formalCertification: false,
          reviewScope,
          excludedInputs: [
            "deleted-provider-response",
            "candidate-observation-wording",
            "v1-scorer-decision",
          ],
        };
      }
    }
  }

  let coverage: ChronicleV2Coverage | null = null;
  if (!isRecord(candidate.coverage)) {
    diagnostics.push({
      code: "V2_COVERAGE_INVALID",
      path: "coverage",
      message: "Coverage modes are required",
    });
  } else {
    hasOnlyKeys(
      candidate.coverage,
      ["observation", "proposal"],
      "coverage",
      diagnostics,
    );
    if (
      !isOneOf(candidate.coverage.observation, CHRONICLE_V2_COVERAGE_MODES) ||
      !isOneOf(candidate.coverage.proposal, CHRONICLE_V2_COVERAGE_MODES)
    ) {
      diagnostics.push({
        code: "V2_COVERAGE_MODE_INVALID",
        path: "coverage",
        message: "Coverage modes must be exhaustive or targeted",
      });
    } else {
      coverage = {
        observation: candidate.coverage.observation,
        proposal: candidate.coverage.proposal,
      };
    }
  }

  const sourceDocuments: ChronicleV2SourceDocument[] = [];
  const documents = new Map<string, ChronicleV2SourceDocument>();
  if (
    !Array.isArray(candidate.sourceDocuments) ||
    candidate.sourceDocuments.length === 0
  ) {
    diagnostics.push({
      code: "V2_SOURCE_DOCUMENTS_INVALID",
      path: "sourceDocuments",
      message: "At least one source document is required",
    });
  } else {
    for (const [index, sourceValue] of candidate.sourceDocuments.entries()) {
      const path = `sourceDocuments[${index}]`;
      if (!isRecord(sourceValue)) {
        diagnostics.push({
          code: "V2_SOURCE_DOCUMENT_INVALID",
          path,
          message: "Source document must be an object",
        });
        continue;
      }
      hasOnlyKeys(sourceValue, ["id", "title", "text"], path, diagnostics);
      if (
        !isNonEmptyString(sourceValue.id) ||
        !isNonEmptyString(sourceValue.title) ||
        typeof sourceValue.text !== "string"
      ) {
        diagnostics.push({
          code: "V2_SOURCE_DOCUMENT_INVALID",
          path,
          message: "Source document requires id, title, and text",
        });
        continue;
      }
      if (documents.has(sourceValue.id)) {
        diagnostics.push({
          code: "V2_SOURCE_DOCUMENT_ID_DUPLICATE",
          path: `${path}.id`,
          message: `Duplicate source document id: ${sourceValue.id}`,
        });
        continue;
      }
      const document = {
        id: sourceValue.id,
        title: sourceValue.title,
        text: sourceValue.text,
      };
      sourceDocuments.push(document);
      documents.set(document.id, document);
    }
  }

  const claims: ChronicleV2GoldClaim[] = [];
  const claimIds = new Set<string>();
  if (!isRecord(candidate.observationGold)) {
    diagnostics.push({
      code: "V2_OBSERVATION_GOLD_INVALID",
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
    if (!Array.isArray(candidate.observationGold.claims)) {
      diagnostics.push({
        code: "V2_CLAIMS_INVALID",
        path: "observationGold.claims",
        message: "Observation Gold claims must be an array",
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
            code: "V2_CLAIM_ID_DUPLICATE",
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
      code: "V2_CLAIMS_EMPTY",
      path: "observationGold.claims",
      message: "The bounded v2 fixture requires at least one atomic claim",
    });
  }
  if (claims.length !== CHRONICLE_V2_EXPECTED_CLAIM_COUNT) {
    diagnostics.push({
      code: "V2_CLAIM_COUNT_INVALID",
      path: "observationGold.claims",
      message: `The bounded v2 fixture requires exactly ${CHRONICLE_V2_EXPECTED_CLAIM_COUNT} claims`,
    });
  }

  const temporalGold = validateTemporalGold(
    candidate.temporalGold,
    "temporalGold",
    claimIds,
    documents,
    diagnostics,
  );

  const proposalPolicy = validateProposalPolicy(
    candidate.proposalPolicy,
    claimIds,
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
      schemaVersion: CHRONICLE_V2_SCHEMA_VERSION,
      contractVersion: CHRONICLE_V2_CONTRACT_VERSION,
      caseId: candidate.caseId,
      authorship,
      coverage,
      sourceDocuments,
      observationGold: { claims },
      temporalGold,
      proposalPolicy,
    }),
  };
}

type AliasTable<T extends string> = Readonly<Record<string, T>>;

const PREDICATE_ALIASES: AliasTable<ChronicleV2Predicate> = Object.freeze({
  "chain break": "chain-break",
  "chain broke": "chain-break",
  "chain-breaking": "chain-break",
  鎖が切れ: "chain-break",
  鎖が切れた: "chain-break",
  鎖の切断: "chain-break",
  "gate fall": "gate-fall",
  "gate fell": "gate-fall",
  "gate leaf fell": "gate-fall",
  門扉が倒れ: "gate-fall",
  門扉が倒れた: "gate-fall",
  門扉の倒壊: "gate-fall",
  "gate repair": "gate-repair",
  "gate repaired": "gate-repair",
  門扉を修復: "gate-repair",
  門扉を修復した: "gate-repair",
  "bell break": "bell-break",
  "bell broke": "bell-break",
  鐘が壊れ: "bell-break",
  鐘が壊れた: "bell-break",
  "ring bell": "ring-bell",
  "bell rang": "ring-bell",
  "guards rang a bell": "ring-bell",
  鐘を鳴らし: "ring-bell",
  鐘を鳴らした: "ring-bell",
  evacuate: "evacuate",
  evacuation: "evacuate",
  "guards evacuated passersby": "evacuate",
  退避させ: "evacuate",
  退避させた: "evacuate",
  避難させた: "evacuate",
});

const ENTITY_ALIASES: AliasTable<ChronicleV2Entity> = Object.freeze({
  "north-gate-chain": "north-gate-chain",
  "north gate chain": "north-gate-chain",
  北門の鎖: "north-gate-chain",
  北門の鎖が: "north-gate-chain",
  "gate-leaf": "gate-leaf",
  "gate leaf": "gate-leaf",
  gate: "gate-leaf",
  門扉: "gate-leaf",
  門扉が: "gate-leaf",
  guard: "guard",
  guards: "guard",
  衛兵: "guard",
  衛兵は: "guard",
  bell: "bell",
  鐘: "bell",
  鐘を: "bell",
  passerby: "passerby",
  passersby: "passerby",
  通行人: "passerby",
  通行人を: "passerby",
  street: "street",
  街路: "street",
  街路へ: "street",
  square: "square",
  広場: "square",
  広場へ: "square",
});

const ROLE_ALIASES: AliasTable<ChronicleV2Role> = Object.freeze({
  agent: "agent",
  actor: "agent",
  行為者: "agent",
  causer: "causer",
  cause: "causer",
  使役者: "causer",
  destination: "destination",
  goal: "destination",
  到達先: "destination",
  object: "theme",
  対象: "theme",
  patient: "theme",
  theme: "theme",
  affected: "theme",
  "affected-entity": "theme",
  主体: "theme",
});

const ACTUALITY_ALIASES: AliasTable<ChronicleV2Actuality> = Object.freeze({
  actual: "actual",
  現実: "actual",
  attempted: "attempted",
  "attempted action": "attempted",
  試み: "attempted",
  dreamed: "dreamed",
  dream: "dreamed",
  夢: "dreamed",
  hypothetical: "hypothetical",
  仮定: "hypothetical",
  negated: "negated",
  否定: "negated",
  planned: "planned",
  plan: "planned",
  計画: "planned",
  rumored: "rumored",
  rumor: "rumored",
  噂: "rumored",
});

const ATTRIBUTION_ALIASES: AliasTable<ChronicleV2Attribution> = Object.freeze({
  character: "character",
  "character-said": "character",
  登場人物: "character",
  narrator: "narrator",
  "narrator-said": "narrator",
  語り手: "narrator",
  reported: "reported",
  report: "reported",
  伝聞: "reported",
});

const NARRATIVE_FRAME_ALIASES: AliasTable<ChronicleV2NarrativeFrame> =
  Object.freeze({
    dream: "dream",
    夢: "dream",
    flashback: "flashback",
    回想: "flashback",
    hypothetical: "hypothetical",
    仮定: "hypothetical",
    plan: "plan",
    計画: "plan",
    "reported-speech": "reported-speech",
    report: "reported-speech",
    伝聞: "reported-speech",
    "story-world": "story-world",
    actual: "story-world",
    物語世界: "story-world",
  });

function normalizeSurface<T extends string>(
  value: string,
  aliases: AliasTable<T>,
  reason: ChronicleV2UnknownReason,
): ChronicleV2Normalized<T> {
  const normalized = aliases[value.trim().toLowerCase()];
  return normalized
    ? { status: "known", value: normalized }
    : { status: "unknown", reason };
}

/** Normalize only raw actual values; this function accepts no Gold argument by design. */
export function normalizeChronicleV2Actual(
  actual: ChronicleV2RawActualClaim,
): ChronicleV2NormalizedActualClaim {
  return freezeDeep({
    actualRef: actual.id,
    predicate: normalizeSurface(
      actual.predicate,
      PREDICATE_ALIASES,
      "predicate-out-of-vocabulary",
    ),
    participants: actual.participants.map((participant) => ({
      entity: normalizeSurface(
        participant.entity,
        ENTITY_ALIASES,
        "entity-out-of-vocabulary",
      ),
      role: normalizeSurface(
        participant.role,
        ROLE_ALIASES,
        "role-out-of-vocabulary",
      ),
    })),
    actuality: normalizeSurface(
      actual.actuality,
      ACTUALITY_ALIASES,
      "actuality-out-of-vocabulary",
    ),
    attribution: normalizeSurface(
      actual.attribution,
      ATTRIBUTION_ALIASES,
      "attribution-out-of-vocabulary",
    ),
    narrativeFrame: normalizeSurface(
      actual.narrativeFrame,
      NARRATIVE_FRAME_ALIASES,
      "narrative-frame-out-of-vocabulary",
    ),
    evidenceRefs: [...actual.evidenceRefs],
  });
}
