import {
  NARRATIVE_EVAL_DIMENSIONS,
  type NarrativeEvalCaseV1,
  type NarrativeEvalDimension,
  type NarrativeEvalExpectedObservation,
} from "./types";
import {
  parseRawChronicleEventObservation,
  parseRawEventSynthesisResult,
} from "@/features/chronicle/extraction/schemas";
import { planChronicleEventProposals } from "@/features/chronicle/extraction/proposalPlanner";
import type { ChronicleExistingMatch } from "@/features/chronicle/extraction/existingEventMatcher";
import type { EventHypothesis } from "@/features/narrative-extraction/ir/inferences/eventHypothesis";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { ResolvedEvidenceAnchor } from "@/features/narrative-extraction/evidence/types";
import type { Sha256Digest } from "@/features/narrative-extraction/source/types";

/** Version of the additive production-capability sidecar contract. */
export const PRODUCTION_CHRONICLE_CAPABILITY_REPORT_VERSION = 1 as const;

export type ProductionChronicleCapabilityReportStatus = "PASS" | "BLOCKED";

export type ProductionChronicleContractCompatibilityStatus =
  | "compatible"
  | "partially-compatible"
  | "incompatible";

export type ProductionChronicleDimensionCompatibilityStatus =
  | "supported"
  | "partially-supported"
  | "blocked"
  | "not-observed";

export type ProductionChronicleCapabilityScope =
  | "observation-schema"
  | "synthesis-schema"
  | "proposal-planner"
  | "evaluation-adapter";

export type ProductionChronicleCapabilityGapCode =
  | "event-detection-negative-unrepresentable"
  | "actuality-rumored-unrepresentable"
  | "actuality-value-unrepresentable"
  | "significance-none-unrepresentable"
  | "significance-value-unrepresentable"
  | "suppressed-eligible-proposal-unrepresentable";

export type ProductionChronicleCapabilityLimitationCode =
  | "forbidden-direct-scoring-unimplemented"
  | "predicate-content-aware-alignment-unimplemented";

export type ProductionChronicleEvidenceResolution =
  | "resolved"
  | "unresolved"
  | "unknown";

export type ProductionChronicleExistingMatchStatus =
  | "not-already-satisfied"
  | "already-satisfied"
  | "unknown";

/**
 * Runtime facts that matter to the planner combination check. The canonical
 * eval adapter uses resolved fixture Evidence and an empty existing-event
 * catalog, which yields a not-already-satisfied match; callers inspecting
 * another context must say so explicitly.
 */
export interface ProductionChronicleCapabilityContext {
  readonly evidenceResolution: ProductionChronicleEvidenceResolution;
  readonly existingMatch: ProductionChronicleExistingMatchStatus;
}

export const PRODUCTION_CHRONICLE_EVAL_CONTEXT = {
  evidenceResolution: "resolved",
  existingMatch: "not-already-satisfied",
} as const satisfies ProductionChronicleCapabilityContext;

export interface ProductionChronicleCapabilityIssue {
  readonly code: ProductionChronicleCapabilityGapCode;
  readonly dimension: NarrativeEvalDimension;
  readonly scope: ProductionChronicleCapabilityScope;
  readonly message: string;
}

export interface ProductionChronicleCapabilityGap extends ProductionChronicleCapabilityIssue {
  readonly caseIds: readonly string[];
  readonly expectationIds: readonly string[];
}

export interface ProductionChronicleCapabilityLimitation {
  readonly code: ProductionChronicleCapabilityLimitationCode;
  readonly caseIds: readonly string[];
  readonly message: string;
}

export interface ProductionChronicleCapabilityConstraint {
  readonly id: string;
  readonly status: "supported" | "restricted" | "unsupported";
  readonly scope: ProductionChronicleCapabilityScope;
  readonly dimensions: readonly NarrativeEvalDimension[];
  readonly message: string;
}

export interface ProductionChronicleDimensionCompatibility {
  readonly status: ProductionChronicleDimensionCompatibilityStatus;
  readonly requiredExpectationCount: number;
  readonly blockedExpectationCount: number;
  readonly caseCount: number;
  readonly blockedCaseCount: number;
  readonly gapCodes: readonly ProductionChronicleCapabilityGapCode[];
}

export interface ProductionChronicleCapabilityReport {
  readonly version: typeof PRODUCTION_CHRONICLE_CAPABILITY_REPORT_VERSION;
  /** Semantic assessment status; BLOCKED is never rewritten to PASS. */
  readonly status: ProductionChronicleCapabilityReportStatus;
  readonly input: {
    readonly caseCount: number;
    readonly caseIds: readonly string[];
    readonly requiredObservationCount: number;
    readonly forbiddenObservationCount: number;
    readonly blockedCaseIds: readonly string[];
  };
  /** Structural representability, intentionally separate from semantic quality. */
  readonly contractCompatibility: {
    readonly status: ProductionChronicleContractCompatibilityStatus;
    readonly dimensions: Record<
      NarrativeEvalDimension,
      ProductionChronicleDimensionCompatibility
    >;
  };
  /** Semantic qualification remains blocked while structural gaps or limitations exist. */
  readonly semanticAssessment: {
    readonly status: ProductionChronicleCapabilityReportStatus;
    readonly supported: readonly NarrativeEvalDimension[];
    readonly blocked: readonly NarrativeEvalDimension[];
    readonly blockers: readonly ProductionChronicleCapabilityGap[];
    readonly limitations: readonly ProductionChronicleCapabilityLimitation[];
  };
  readonly constraints: readonly ProductionChronicleCapabilityConstraint[];
  readonly gaps: readonly ProductionChronicleCapabilityGap[];
  readonly limitations: readonly ProductionChronicleCapabilityLimitation[];
}

function productionObservationActualityAccepted(value: string): boolean {
  return parseRawChronicleEventObservation({
    localId: "capability-probe-observation",
    evidence: [{ sourceRef: "S0001", quote: "capability probe" }],
    assertion: { attribution: "narrator", narrativeFrame: "story-world" },
    payload: {
      predicate: "capability probe",
      actuality: value,
      participants: [],
      temporalExpressions: [],
      durationKind: "instant",
    },
  }).ok;
}

function productionHypothesisActualityAccepted(value: string): boolean {
  return parseRawEventSynthesisResult({
    clusterRef: "capability-probe-cluster",
    resolution: "single-event",
    events: [
      {
        observationRefs: ["capability-probe-observation"],
        titleSuggestion: "capability probe",
        summary: "capability probe",
        actuality: value,
        significance: "major",
      },
    ],
  }).ok;
}

function productionHypothesisSignificanceAccepted(value: string): boolean {
  return parseRawEventSynthesisResult({
    clusterRef: "capability-probe-cluster",
    resolution: "single-event",
    events: [
      {
        observationRefs: ["capability-probe-observation"],
        titleSuggestion: "capability probe",
        summary: "capability probe",
        actuality: "actual",
        significance: value,
      },
    ],
  }).ok;
}

// The planner-boundary proof needs one valid hypothesis actuality.  Probe the
// canonical parser rather than copying its allowlist into this sidecar.
const PRODUCTION_CAN_SYNTHESIZE_ELIGIBLE_HYPOTHESIS =
  productionHypothesisActualityAccepted("actual");

const PRODUCTION_CAPABILITY_PROBE_DIGEST =
  `sha256:${"0".repeat(64)}` as Sha256Digest;

const PRODUCTION_CAPABILITY_PROBE_OBSERVATION: RawChronicleEventObservation = {
  localId: "capability-probe-observation",
  evidence: [{ sourceRef: "S0001", quote: "capability probe" }],
  assertion: { attribution: "narrator", narrativeFrame: "story-world" },
  payload: {
    predicate: "capability probe",
    actuality: "actual",
    participants: [],
    temporalExpressions: [],
    durationKind: "instant",
  },
};

const PRODUCTION_CAPABILITY_PROBE_ANCHOR: ResolvedEvidenceAnchor = {
  id: "capability-probe-anchor",
  sourceRef: "S0001",
  documentRef: "D0001",
  quote: "capability probe",
  canonicalRange: { start: 0, end: 16 },
  sourceRange: { start: 0, end: 16 },
  projection: {
    status: "exact",
    fragments: [
      { canonicalStart: 0, canonicalEnd: 16, from: 0, to: 16, kind: "linear" },
    ],
  },
  context: { prefix: "", suffix: "" },
  method: "exact",
  initialMatchCount: 1,
  quoteDigest: PRODUCTION_CAPABILITY_PROBE_DIGEST,
  snapshotDigest: PRODUCTION_CAPABILITY_PROBE_DIGEST,
  contentDigest: PRODUCTION_CAPABILITY_PROBE_DIGEST,
  documentDigest: PRODUCTION_CAPABILITY_PROBE_DIGEST,
  documentArtifactDigest: PRODUCTION_CAPABILITY_PROBE_DIGEST,
  sourceDigest: PRODUCTION_CAPABILITY_PROBE_DIGEST,
};

/**
 * Ask the canonical planner whether a candidate with this parser value would
 * emit a proposal. The string is deliberately not checked against a copied
 * significance allowlist; planner behavior is the source of truth.
 */
function plannerEmitsCapabilityProbe(
  significance: string,
  match: ChronicleExistingMatch,
): boolean {
  const hypothesis: EventHypothesis = {
    hypothesisId: "capability-probe-hypothesis",
    clusterRef: "capability-probe-cluster",
    observationRefs: [PRODUCTION_CAPABILITY_PROBE_OBSERVATION.localId],
    titleSuggestion: "capability probe",
    summary: "capability probe",
    actuality: "actual",
    significance: significance as EventHypothesis["significance"],
  };
  return (
    planChronicleEventProposals({
      hypotheses: [hypothesis],
      observations: [PRODUCTION_CAPABILITY_PROBE_OBSERVATION],
      anchors: [PRODUCTION_CAPABILITY_PROBE_ANCHOR],
      matchesByHypothesisId: new Map([[hypothesis.hypothesisId, match]]),
      createId: () => "capability-probe-event",
    }).length > 0
  );
}

function plannerCanRepresentCandidate(significance: string): boolean {
  return (
    plannerEmitsCapabilityProbe(significance, { status: "none" }) &&
    !plannerEmitsCapabilityProbe(significance, {
      status: "already-satisfied",
      existingRef: "capability-probe-existing-event",
    })
  );
}

function issue(
  code: ProductionChronicleCapabilityGapCode,
  dimension: NarrativeEvalDimension,
  scope: ProductionChronicleCapabilityScope,
  message: string,
): ProductionChronicleCapabilityIssue {
  return { code, dimension, scope, message };
}

/**
 * Classify one Human-Gold requirement against the current production
 * contracts.  This is pure and intentionally never invents a value when a
 * Gold dimension is absent.
 */
export function classifyProductionChronicleExpectation(
  expectation: NarrativeEvalExpectedObservation,
  context: ProductionChronicleCapabilityContext = PRODUCTION_CHRONICLE_EVAL_CONTEXT,
): readonly ProductionChronicleCapabilityIssue[] {
  const dimensions = expectation.dimensions;
  const issues: ProductionChronicleCapabilityIssue[] = [];

  if (dimensions.eventDetection === false) {
    issues.push(
      issue(
        "event-detection-negative-unrepresentable",
        "eventDetection",
        "evaluation-adapter",
        "Production scoring assigns eventDetection=true to every observation row; a required negative eventDetection value cannot be projected.",
      ),
    );
  }

  if (
    dimensions.actuality !== undefined &&
    !productionObservationActualityAccepted(dimensions.actuality)
  ) {
    if (dimensions.actuality === "rumored") {
      issues.push(
        issue(
          "actuality-rumored-unrepresentable",
          "actuality",
          "observation-schema",
          "The production observation actuality schema has no rumored value, so Gold actuality=rumored cannot be projected through the observation contract.",
        ),
      );
    } else {
      issues.push(
        issue(
          "actuality-value-unrepresentable",
          "actuality",
          "observation-schema",
          `The production observation actuality schema does not contain the required value '${dimensions.actuality}'.`,
        ),
      );
    }
  }

  if (
    dimensions.significance !== undefined &&
    !productionHypothesisSignificanceAccepted(dimensions.significance)
  ) {
    if (dimensions.significance === "none") {
      issues.push(
        issue(
          "significance-none-unrepresentable",
          "significance",
          "synthesis-schema",
          "The canonical production event-synthesis parser rejects significance=none; when no hypothesis is synthesized the adapter reports not-synthesized rather than Gold none.",
        ),
      );
    } else {
      issues.push(
        issue(
          "significance-value-unrepresentable",
          "significance",
          "synthesis-schema",
          `The canonical production event-synthesis parser does not contain the required significance value '${dimensions.significance}'.`,
        ),
      );
    }
  }

  const hasResolvedEvidence =
    context.evidenceResolution === "resolved" &&
    (dimensions.evidence?.length ?? 0) > 0;
  const plannerCanEmitEligibleHypothesis =
    dimensions.significance !== undefined &&
    plannerCanRepresentCandidate(dimensions.significance);
  if (
    dimensions.proposalGate === "suppress" &&
    plannerCanEmitEligibleHypothesis &&
    hasResolvedEvidence &&
    context.existingMatch === "not-already-satisfied" &&
    PRODUCTION_CAN_SYNTHESIZE_ELIGIBLE_HYPOTHESIS
  ) {
    issues.push(
      issue(
        "suppressed-eligible-proposal-unrepresentable",
        "proposalGate",
        "proposal-planner",
        "For a planner-eligible significance=major or scene-level hypothesis with resolved Evidence and a not-already-satisfied match, the production planner emits a proposal; it cannot preserve Gold proposalGate=suppress for this eligible combination.",
      ),
    );
  }

  return issues;
}

function createDimensionAccumulator() {
  return {
    requiredExpectationCount: 0,
    blockedExpectationCount: 0,
    caseIds: new Set<string>(),
    blockedCaseIds: new Set<string>(),
    gapCodes: new Set<ProductionChronicleCapabilityGapCode>(),
  };
}

function buildConstraints(): readonly ProductionChronicleCapabilityConstraint[] {
  return [
    {
      id: "observation-event-detection",
      status: "restricted",
      scope: "evaluation-adapter",
      dimensions: ["eventDetection"],
      message:
        "Every normalized production observation is treated as eventDetection=true; false is not a representable observation value.",
    },
    {
      id: "observation-actuality-allowlist",
      status: "restricted",
      scope: "observation-schema",
      dimensions: ["actuality"],
      message:
        "The canonical observation parser determines the actuality values that can be projected. It excludes rumored; values accepted here remain observation-stage values and are not implicitly hypothesis values.",
    },
    {
      id: "synthesis-actuality-allowlist",
      status: "restricted",
      scope: "synthesis-schema",
      dimensions: ["actuality"],
      message:
        "The canonical event-synthesis parser has a narrower actuality contract than observation parsing. This report records that stage separation without converting an observation actuality into a different value.",
    },
    {
      id: "synthesis-significance-allowlist",
      status: "restricted",
      scope: "synthesis-schema",
      dimensions: ["significance"],
      message:
        "The canonical event-synthesis parser has no significance=none; a missing hypothesis is not a semantic none.",
    },
    {
      id: "proposal-planner-eligibility",
      status: "restricted",
      scope: "proposal-planner",
      dimensions: ["actuality", "significance", "evidence", "proposalGate"],
      message:
        "Proposal planning requires actual, attempted, or prevented, major or scene-level, and at least one resolved Evidence anchor. Ineligible hypotheses are suppressed by omission.",
    },
    {
      id: "proposal-planner-suppress-boundary",
      status: "restricted",
      scope: "proposal-planner",
      dimensions: ["significance", "evidence", "proposalGate"],
      message:
        "proposalGate=suppress is representable for ineligible or already-satisfied candidates, but not for a planner-eligible major/scene-level candidate with resolved Evidence and a not-already-satisfied match.",
    },
    {
      id: "evidence-exact-resolution",
      status: "supported",
      scope: "evaluation-adapter",
      dimensions: ["evidence"],
      message:
        "Production Evidence remains exact-source resolved; this capability report does not waive unresolved, ambiguous, or transformed quotes.",
    },
  ];
}

function buildLimitations(
  cases: readonly NarrativeEvalCaseV1[],
): readonly ProductionChronicleCapabilityLimitation[] {
  const caseIds = cases.map((evalCase) => evalCase.id);
  const casesWithForbidden = cases
    .filter((evalCase) => evalCase.expected.observations.forbidden.length > 0)
    .map((evalCase) => evalCase.id);
  return [
    {
      code: "forbidden-direct-scoring-unimplemented",
      caseIds: casesWithForbidden,
      message:
        "Current scorer-v1 does not directly score expected.observations.forbidden. Forbidden Gold remains canonical documentation, but a forbidden entry alone cannot produce a direct score or critical violation.",
    },
    {
      code: "predicate-content-aware-alignment-unimplemented",
      caseIds: caseIds,
      message:
        "Production adapter alignment is evidence-overlap based; predicate/content-aware matching is not implemented. A response using the right Evidence for a different proposition can therefore evade semantic alignment.",
    },
  ];
}

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

/**
 * Build a manifest-driven, additive report of what the current production
 * Chronicle path can express.  It never invokes a model, mutates Gold, or
 * changes scorer/certification decisions.
 */
export function buildProductionChronicleCapabilityReport(
  cases: readonly NarrativeEvalCaseV1[],
  context: ProductionChronicleCapabilityContext = PRODUCTION_CHRONICLE_EVAL_CONTEXT,
): ProductionChronicleCapabilityReport {
  const gapsByCode = new Map<
    ProductionChronicleCapabilityGapCode,
    {
      readonly issue: ProductionChronicleCapabilityIssue;
      readonly caseIds: string[];
      readonly expectationIds: string[];
    }
  >();
  const accumulators = new Map(
    NARRATIVE_EVAL_DIMENSIONS.map(
      (dimension) => [dimension, createDimensionAccumulator()] as const,
    ),
  );

  let requiredObservationCount = 0;
  let forbiddenObservationCount = 0;
  for (const evalCase of cases) {
    const required = evalCase.expected.observations.required;
    requiredObservationCount += required.length;
    forbiddenObservationCount +=
      evalCase.expected.observations.forbidden.length;
    for (const expected of required) {
      const issues = classifyProductionChronicleExpectation(expected, context);
      const issueByDimension = new Map(
        issues.map((candidate) => [candidate.dimension, candidate] as const),
      );
      for (const dimension of NARRATIVE_EVAL_DIMENSIONS) {
        if (expected.dimensions[dimension] === undefined) continue;
        const accumulator = accumulators.get(dimension);
        if (!accumulator) continue;
        accumulator.requiredExpectationCount += 1;
        accumulator.caseIds.add(evalCase.id);
        const dimensionIssue = issueByDimension.get(dimension);
        if (!dimensionIssue) continue;
        accumulator.blockedExpectationCount += 1;
        accumulator.blockedCaseIds.add(evalCase.id);
        accumulator.gapCodes.add(dimensionIssue.code);
      }
      for (const candidate of issues) {
        const aggregate = gapsByCode.get(candidate.code) ?? {
          issue: candidate,
          caseIds: [],
          expectationIds: [],
        };
        addUnique(aggregate.caseIds, evalCase.id);
        addUnique(aggregate.expectationIds, expected.id);
        gapsByCode.set(candidate.code, aggregate);
      }
    }
  }

  const gaps: readonly ProductionChronicleCapabilityGap[] = [
    ...gapsByCode.values(),
  ].map(({ issue: candidate, caseIds, expectationIds }) => ({
    ...candidate,
    caseIds: [...caseIds],
    expectationIds: [...expectationIds],
  }));
  const dimensions = Object.fromEntries(
    NARRATIVE_EVAL_DIMENSIONS.map((dimension) => {
      const accumulator = accumulators.get(dimension);
      if (!accumulator) {
        throw new Error(`Missing capability accumulator for ${dimension}`);
      }
      const { requiredExpectationCount, blockedExpectationCount } = accumulator;
      const status: ProductionChronicleDimensionCompatibilityStatus =
        requiredExpectationCount === 0
          ? "not-observed"
          : blockedExpectationCount === 0
            ? "supported"
            : blockedExpectationCount >= requiredExpectationCount
              ? "blocked"
              : "partially-supported";
      return [
        dimension,
        {
          status,
          requiredExpectationCount,
          blockedExpectationCount,
          caseCount: accumulator.caseIds.size,
          blockedCaseCount: accumulator.blockedCaseIds.size,
          gapCodes: [...accumulator.gapCodes],
        },
      ];
    }),
  ) as unknown as Record<
    NarrativeEvalDimension,
    ProductionChronicleDimensionCompatibility
  >;

  const limitations = buildLimitations(cases);
  const blockedDimensions = NARRATIVE_EVAL_DIMENSIONS.filter((dimension) => {
    const status = dimensions[dimension].status;
    return status === "blocked" || status === "partially-supported";
  });
  const supportedDimensions = NARRATIVE_EVAL_DIMENSIONS.filter(
    (dimension) => dimensions[dimension].status === "supported",
  );
  const contractStatus: ProductionChronicleContractCompatibilityStatus =
    gaps.length === 0
      ? "compatible"
      : blockedDimensions.length === NARRATIVE_EVAL_DIMENSIONS.length
        ? "incompatible"
        : "partially-compatible";
  const blockedCaseIds = [...new Set(gaps.flatMap((gap) => gap.caseIds))];
  const semanticStatus: ProductionChronicleCapabilityReportStatus =
    gaps.length === 0 && limitations.length === 0 ? "PASS" : "BLOCKED";

  return {
    version: PRODUCTION_CHRONICLE_CAPABILITY_REPORT_VERSION,
    status: semanticStatus,
    input: {
      caseCount: cases.length,
      caseIds: cases.map((evalCase) => evalCase.id),
      requiredObservationCount,
      forbiddenObservationCount,
      blockedCaseIds,
    },
    contractCompatibility: {
      status: contractStatus,
      dimensions,
    },
    semanticAssessment: {
      status: semanticStatus,
      supported: supportedDimensions,
      blocked: blockedDimensions,
      blockers: gaps,
      limitations,
    },
    constraints: buildConstraints(),
    gaps,
    limitations,
  };
}
