import { describe, expect, it } from "vitest";
import fixture from "../../../../evals/narrative/contracts/chronicle-v2/actual-gate-collapse.json";
import { digestStableJson } from "../source/digest";
import {
  CHRONICLE_V2_ALIGNMENT_VERSION,
  alignChronicleV2Claims,
  type ChronicleV2AlignmentResult,
} from "./chronicleV2Alignment";
import {
  CHRONICLE_V2_DIMENSIONS,
  CHRONICLE_V2_EVALUATOR_VERSION,
  type ChronicleV2DimensionScore,
  type ChronicleV2ProductionEvaluation,
} from "./chronicleV2Evaluator";
import {
  loadChronicleV2Contract,
  normalizeChronicleV2Actual,
  type ChronicleV2EvidenceCandidate,
  type ChronicleV2Contract,
  type ChronicleV2RawActualClaim,
} from "./chronicleV2Contract";
import {
  buildChronicleV2Diagnostics,
  validateChronicleV2Diagnostics,
  type ChronicleV2DiagnosticsProjection,
} from "./chronicleV2Diagnostics";
import {
  CHRONICLE_V2_TEMPORAL_VERSION,
  evaluateChronicleV2Temporal,
  type ChronicleV2TemporalEvaluation,
} from "./chronicleV2Temporal";

const loadedContract = loadChronicleV2Contract(fixture);
if (!loadedContract.ok) {
  throw new Error(
    "The v2 diagnostic fixture must load in its own focused tests",
  );
}
const contract = loadedContract.value;

function rawClaim(
  id: string,
  predicate: string,
  participants: readonly { entity: string; role: string }[],
  evidenceRef: string,
  overrides: Partial<ChronicleV2RawActualClaim> = {},
): ChronicleV2RawActualClaim {
  return {
    id,
    predicate,
    participants,
    actuality: "actual",
    attribution: "narrator",
    narrativeFrame: "story-world",
    evidenceRefs: [evidenceRef],
    ...overrides,
  };
}

const rawClaims: readonly ChronicleV2RawActualClaim[] = [
  rawClaim(
    "actual-chain-break",
    "鎖が切れた",
    [{ entity: "北門の鎖", role: "theme" }],
    "citation-chain",
  ),
  rawClaim(
    "actual-gate-fall",
    "門扉が倒れた",
    [
      { entity: "門扉", role: "theme" },
      { entity: "街路へ", role: "destination" },
    ],
    "citation-gate",
  ),
  rawClaim(
    "actual-ring-bell",
    "鐘を鳴らした",
    [
      { entity: "衛兵", role: "agent" },
      { entity: "鐘", role: "theme" },
    ],
    "citation-bell",
  ),
  rawClaim(
    "actual-evacuate",
    "退避させた",
    [
      { entity: "衛兵", role: "agent" },
      { entity: "通行人を", role: "patient" },
      { entity: "広場へ", role: "destination" },
    ],
    "citation-evacuate",
  ),
];

function matchingAlignment(
  actuals: ReturnType<typeof normalizeChronicleV2Actual>[],
  sourceContract: ChronicleV2Contract = contract,
): ChronicleV2AlignmentResult {
  const assignments = actuals.map((actual, index) => ({
    actualRef: actual.actualRef,
    goldRef: sourceContract.observationGold.claims[index]!.id,
    status: "match" as const,
  }));
  const candidates = assignments.map((assignment) => ({
    actualRef: assignment.actualRef,
    goldRef: assignment.goldRef,
    evidenceValid: true,
    overlap: true,
    directSupport: true,
    contextSupport: true,
  }));
  return {
    version: CHRONICLE_V2_ALIGNMENT_VERSION,
    candidates,
    assignments,
    matchedCount: assignments.length,
    mismatchCount: 0,
    extraCount: 0,
    duplicateCount: 0,
    unscoredCount: 0,
    missingCount: 0,
    unobservableCount: 0,
    matchedGoldRefs: assignments.map((assignment) => assignment.goldRef!),
    undeterminedGoldRefs: [],
    undeterminedGoldCount: 0,
    missingGoldRefs: [],
    unknownMatchCapacity: 0,
    missingCountLowerBound: 0,
    cardinalityExcessLowerBound: 0,
    falsePositiveCount: 0,
    falseNegativeCount: 0,
    passed: true,
  };
}

function sourceDocumentBindings(sourceContract: ChronicleV2Contract) {
  return [
    {
      contractDocumentId: sourceContract.sourceDocuments[0]!.id,
      preparedDocumentId: "prepared-scene-north-gate",
      sourceRef: "source-north-gate",
      evidenceSourceRefs: ["source-north-gate"],
    },
  ] as const;
}

function baseTemporalEvaluation(
  sourceContract: ChronicleV2Contract,
  raw: readonly ChronicleV2RawActualClaim[],
  alignment: ChronicleV2AlignmentResult,
): ChronicleV2TemporalEvaluation {
  const rawRows = raw.map((claim) => ({
    actualRef: claim.id,
    expressions:
      claim.id === "actual-chain-break" || claim.id === "actual-gate-fall"
        ? ["夜半"]
        : [],
    evidenceRefs: [...claim.evidenceRefs],
  }));
  const temporalGold = {
    ...sourceContract.temporalGold,
    relations: sourceContract.temporalGold.relations.map((relation) => ({
      ...relation,
      requiredRegion: {
        ...relation.requiredRegion,
        documentId: "prepared-scene-north-gate",
      },
    })),
  };
  return evaluateChronicleV2Temporal({
    temporalGold,
    rawRows,
    exactEventAssignments: alignment.assignments,
    evidenceByActual: raw.map((claim) => ({
      actualRef: claim.id,
      valid: true,
      ranges: [
        {
          documentId: "prepared-scene-north-gate",
          start: 0,
          end: 2,
        },
      ],
    })),
  });
}

function baseEvaluation(
  sourceContract: ChronicleV2Contract = contract,
  raw: readonly ChronicleV2RawActualClaim[] = rawClaims,
): ChronicleV2ProductionEvaluation {
  const normalized = raw.map(normalizeChronicleV2Actual);
  const alignment = matchingAlignment(normalized, sourceContract);
  const temporal = baseTemporalEvaluation(sourceContract, raw, alignment);
  const evidence = normalized.map((actual) => ({
    actualRef: actual.actualRef,
    valid: true,
    resolvedCount: 1,
    invalidCount: 0,
    ranges: [
      {
        sourceRef: "source-north-gate",
        documentId: "prepared-scene-north-gate",
        start: 0,
        end: 2,
      },
    ],
  }));
  const dimensions = Object.fromEntries(
    CHRONICLE_V2_DIMENSIONS.map((dimension) => [
      dimension,
      {
        truePositive: normalized.length === 4 ? 4 : 0,
        falsePositive: 0,
        falseNegative: 0,
        unobservable: 0,
        pairedComparisonDenominator: normalized.length === 4 ? 4 : 0,
        status: normalized.length === 4 ? "scored" : "not-scored",
      },
    ]),
  ) as ChronicleV2ProductionEvaluation["dimensions"];
  return {
    version: CHRONICLE_V2_EVALUATOR_VERSION,
    caseId: sourceContract.caseId,
    rawActualClaims: raw,
    normalizedActualClaims: normalized,
    evidence,
    evidenceCandidates: alignment.candidates,
    sourceDocumentBindings: sourceDocumentBindings(sourceContract),
    alignment,
    temporal,
    observation: {
      passed: true,
      goldCount: sourceContract.observationGold.claims.length,
      actualCount: normalized.length,
      matchedCount: normalized.length,
      mismatchCount: 0,
      missingCount: 0,
      missingCountLowerBound: 0,
      unknownMatchCapacity: 0,
      cardinalityExcessLowerBound: 0,
      extraCount: 0,
      duplicateCount: 0,
      unscoredCount: 0,
      unobservableCount: 0,
      undeterminedGoldCount: 0,
      goldJudgedCount: sourceContract.observationGold.claims.length,
      actualJudgedCount: normalized.length,
      judgedCount:
        sourceContract.observationGold.claims.length + normalized.length,
      denominator:
        sourceContract.observationGold.claims.length + normalized.length,
    },
    proposal: {
      mode: "unscored",
      status: "unscored",
      passed: false,
      eligibleGoldCount: 0,
      proposedCorrectCount: 0,
      proposedIncorrectCount: 0,
      suppressedCorrectCount: 0,
      suppressedIncorrectCount: 0,
      unobservableCount: 0,
      judgedCount: 0,
      denominator: 0,
    },
    clustering: {
      status: "not-scored",
      clusterCount: normalized.length,
      hypothesisCount: normalized.length,
    },
    dimensions,
    semanticStatus: "PASS",
    evaluationScope:
      sourceContract.proposalPolicy.mode === "unscored"
        ? "observation-and-temporal"
        : "observation-temporal-and-proposal",
    observationPassed: true,
    proposalPassed: false,
    semanticPassed: true,
    accepted: false,
    authorshipReady: false,
  };
}

function evaluationFromAlignment(
  sourceContract: ChronicleV2Contract,
  raw: readonly ChronicleV2RawActualClaim[],
  alignment: ChronicleV2AlignmentResult,
  evidenceCandidates: readonly ChronicleV2EvidenceCandidate[] = alignment.candidates,
  proposal: ChronicleV2ProductionEvaluation["proposal"] = {
    mode: "unscored",
    status: "unscored",
    passed: false,
    eligibleGoldCount: 0,
    proposedCorrectCount: 0,
    proposedIncorrectCount: 0,
    suppressedCorrectCount: 0,
    suppressedIncorrectCount: 0,
    unobservableCount: 0,
    judgedCount: 0,
    denominator: 0,
  },
): ChronicleV2ProductionEvaluation {
  const normalizedActualClaims = raw.map(normalizeChronicleV2Actual);
  const dimensionUnobservable = (
    dimension: (typeof CHRONICLE_V2_DIMENSIONS)[number],
  ): number =>
    normalizedActualClaims.filter((actual) => {
      switch (dimension) {
        case "predicate":
          return actual.predicate.status !== "known";
        case "participants":
          return actual.participants.some(
            (participant) => participant.entity.status !== "known",
          );
        case "roles":
          return actual.participants.some(
            (participant) =>
              participant.entity.status !== "known" ||
              participant.role.status !== "known",
          );
        case "actuality":
          return actual.actuality.status !== "known";
        case "attribution":
          return actual.attribution.status !== "known";
        case "narrativeFrame":
          return actual.narrativeFrame.status !== "known";
      }
    }).length;
  const evidence = normalizedActualClaims.map((actual) => ({
    actualRef: actual.actualRef,
    valid: true,
    resolvedCount: 1,
    invalidCount: 0,
    ranges: [
      {
        sourceRef: "source-north-gate",
        documentId: "prepared-scene-north-gate",
        start: 0,
        end: 2,
      },
    ],
  }));
  const dimensions = Object.fromEntries(
    CHRONICLE_V2_DIMENSIONS.map((dimension) => [
      dimension,
      {
        truePositive: alignment.matchedCount,
        falsePositive: alignment.mismatchCount,
        falseNegative: alignment.mismatchCount,
        unobservable: dimensionUnobservable(dimension),
        pairedComparisonDenominator:
          alignment.matchedCount + alignment.mismatchCount,
        status:
          alignment.matchedCount + alignment.mismatchCount > 0
            ? "scored"
            : dimensionUnobservable(dimension) > 0
              ? "unobservable"
              : "not-scored",
      } satisfies ChronicleV2DimensionScore,
    ]),
  ) as ChronicleV2ProductionEvaluation["dimensions"];
  const observationPassed =
    alignment.passed &&
    alignment.missingCountLowerBound === 0 &&
    alignment.cardinalityExcessLowerBound === 0 &&
    evidence.every((entry) => entry.valid);
  const temporal = baseTemporalEvaluation(sourceContract, raw, alignment);
  const knownFailure =
    alignment.mismatchCount > 0 ||
    alignment.extraCount > 0 ||
    alignment.duplicateCount > 0 ||
    alignment.missingCount > 0 ||
    alignment.missingCountLowerBound > 0 ||
    alignment.cardinalityExcessLowerBound > 0 ||
    temporal.status === "FAIL" ||
    proposal.status === "fail";
  const uncertain =
    alignment.unobservableCount > 0 ||
    alignment.undeterminedGoldCount > 0 ||
    alignment.unscoredCount > 0 ||
    temporal.status === "UNDETERMINED" ||
    proposal.status === "undetermined";
  const semanticStatus = knownFailure
    ? "FAIL"
    : uncertain
      ? "UNDETERMINED"
      : "PASS";
  return {
    version: CHRONICLE_V2_EVALUATOR_VERSION,
    caseId: sourceContract.caseId,
    rawActualClaims: raw,
    normalizedActualClaims,
    evidence,
    evidenceCandidates,
    sourceDocumentBindings: sourceDocumentBindings(sourceContract),
    alignment,
    temporal,
    observation: {
      passed: observationPassed,
      goldCount: sourceContract.observationGold.claims.length,
      actualCount: normalizedActualClaims.length,
      matchedCount: alignment.matchedCount,
      mismatchCount: alignment.mismatchCount,
      missingCount: alignment.missingCount,
      missingCountLowerBound: alignment.missingCountLowerBound,
      unknownMatchCapacity: alignment.unknownMatchCapacity,
      cardinalityExcessLowerBound: alignment.cardinalityExcessLowerBound,
      extraCount: alignment.extraCount,
      duplicateCount: alignment.duplicateCount,
      unscoredCount: alignment.unscoredCount,
      unobservableCount: alignment.unobservableCount,
      undeterminedGoldCount: alignment.undeterminedGoldCount,
      goldJudgedCount:
        sourceContract.observationGold.claims.length -
        alignment.undeterminedGoldCount,
      actualJudgedCount:
        normalizedActualClaims.length -
        alignment.unobservableCount -
        alignment.unscoredCount,
      judgedCount:
        sourceContract.observationGold.claims.length -
        alignment.undeterminedGoldCount +
        normalizedActualClaims.length -
        alignment.unobservableCount -
        alignment.unscoredCount,
      denominator:
        sourceContract.observationGold.claims.length +
        normalizedActualClaims.length,
    },
    proposal,
    clustering: {
      status: "not-scored",
      clusterCount: normalizedActualClaims.length,
      hypothesisCount: normalizedActualClaims.length,
    },
    dimensions,
    semanticStatus,
    evaluationScope:
      sourceContract.proposalPolicy.mode === "unscored"
        ? "observation-and-temporal"
        : "observation-temporal-and-proposal",
    observationPassed,
    proposalPassed: proposal.passed,
    semanticPassed: semanticStatus === "PASS",
    accepted: false,
    authorshipReady: false,
  };
}

async function buildBase(): Promise<ChronicleV2DiagnosticsProjection> {
  return buildChronicleV2Diagnostics({
    contract,
    evaluation: baseEvaluation(),
  });
}

async function recomputeSelfDigests(
  candidate: ChronicleV2DiagnosticsProjection,
): Promise<ChronicleV2DiagnosticsProjection> {
  const withoutOldDigest = structuredClone(candidate) as unknown as Record<
    string,
    unknown
  >;
  withoutOldDigest.layersDigest = await digestStableJson({
    evidence: withoutOldDigest.evidence,
    observation: withoutOldDigest.observation,
    dimensions: withoutOldDigest.dimensions,
    clustering: withoutOldDigest.clustering,
    proposal: withoutOldDigest.proposal,
    temporal: withoutOldDigest.temporal,
    semanticStatus: withoutOldDigest.semanticStatus,
    evaluationScope: withoutOldDigest.evaluationScope,
    observationPassed: withoutOldDigest.observationPassed,
    proposalPassed: withoutOldDigest.proposalPassed,
    semanticPassed: withoutOldDigest.semanticPassed,
    accepted: withoutOldDigest.accepted,
    authorshipReady: withoutOldDigest.authorshipReady,
  });
  const withoutProjectionDigest = Object.fromEntries(
    Object.entries(withoutOldDigest).filter(
      ([key]) => key !== "projectionDigest",
    ),
  );
  return {
    ...withoutProjectionDigest,
    projectionDigest: await digestStableJson(withoutProjectionDigest),
  } as unknown as ChronicleV2DiagnosticsProjection;
}

describe("Chronicle v2 numeric diagnostics", () => {
  it("projects fixed counts and digests without persisting actual or Gold strings", async () => {
    const projection = await buildBase();

    expect(Object.keys(projection)).toEqual([
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
      "projectionDigest",
    ]);
    expect(projection.observation).toMatchObject({
      goldCount: 4,
      actualCount: 4,
      matchedCount: 4,
      mismatchCount: 0,
      mismatchedGoldCount: 0,
      missingCount: 0,
      missingCountLowerBound: 0,
      unknownMatchCapacity: 0,
      cardinalityExcessLowerBound: 0,
      extraCount: 0,
      duplicateCount: 0,
      unscoredActualCount: 0,
      unobservableCount: 0,
      undeterminedGoldCount: 0,
      goldJudgedCount: 4,
      actualJudgedCount: 4,
      judgedCount: 8,
      denominator: 8,
    });
    expect(projection.proposal).toMatchObject({
      mode: "unscored",
      status: "unscored",
      passed: false,
    });
    expect(projection.semanticPassed).toBe(true);
    expect(projection.accepted).toBe(false);
    expect(JSON.stringify(projection)).not.toContain("北門");
    expect(JSON.stringify(projection)).not.toContain("chain-break");

    const validation = await validateChronicleV2Diagnostics(projection, {
      contract,
      evaluation: baseEvaluation(),
    });
    expect(validation).toMatchObject({ ok: true });
  });

  it("projects the scoped temporal layer as numeric counters with input and result bindings", async () => {
    const projection = await buildBase();

    expect(projection.temporalVersion).toBe(CHRONICLE_V2_TEMPORAL_VERSION);
    expect(projection.temporal).toEqual({
      requiredRelationCount: 2,
      matchedCount: 2,
      missingCount: 0,
      invalidEvidenceCount: 0,
      unobservableCount: 0,
      blockedByEventIdentityCount: 0,
      unscoredGoldCount: 2,
      judgedCount: 2,
      denominator: 2,
      status: "PASS",
      passed: true,
    });
    expect(projection.temporalInputDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(projection.temporalNormalizedDigest).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(projection.temporalRelationsDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(JSON.stringify(projection)).not.toContain("夜半");
    expect(JSON.stringify(projection)).not.toContain("citation-chain");
  });

  it("rejects tampered temporal inputs and derived rows before projection", async () => {
    const mutations: readonly {
      name: string;
      mutate: (evaluation: Record<string, unknown>) => void;
      error: RegExp;
    }[] = [
      {
        name: "temporal raw row omission",
        mutate: (evaluation) => {
          const temporal = evaluation.temporal as Record<string, unknown>;
          temporal.rawRows = (temporal.rawRows as unknown[]).slice(1);
        },
        error: /raw rows must cover every raw actual/,
      },
      {
        name: "foreign temporal raw row",
        mutate: (evaluation) => {
          const temporal = evaluation.temporal as Record<string, unknown>;
          const rawRows = temporal.rawRows as Array<Record<string, unknown>>;
          rawRows[0] = { ...rawRows[0], actualRef: "actual-foreign" };
        },
        error: /raw rows must cover every raw actual/,
      },
      {
        name: "temporal evidence refs mismatch",
        mutate: (evaluation) => {
          const temporal = evaluation.temporal as Record<string, unknown>;
          const rawRows = temporal.rawRows as Array<Record<string, unknown>>;
          rawRows[0] = { ...rawRows[0], evidenceRefs: ["citation-foreign"] };
        },
        error: /temporal evidence refs disagree/,
      },
      {
        name: "temporal normalized row tampering",
        mutate: (evaluation) => {
          const temporal = evaluation.temporal as Record<string, unknown>;
          const normalizedRows = temporal.normalizedRows as Array<
            Record<string, unknown>
          >;
          normalizedRows[0] = { ...normalizedRows[0], expressions: [] };
        },
        error: /temporal normalized rows disagree/,
      },
      {
        name: "temporal relation row tampering",
        mutate: (evaluation) => {
          const temporal = evaluation.temporal as Record<string, unknown>;
          const relationRows = temporal.relationRows as Array<
            Record<string, unknown>
          >;
          relationRows[0] = { ...relationRows[0], result: "missing" };
        },
        error: /temporal relation rows disagree/,
      },
      {
        name: "temporal counter tampering",
        mutate: (evaluation) => {
          const temporal = evaluation.temporal as Record<string, unknown>;
          temporal.matchedCount = 1;
        },
        error: /temporal counters disagree/,
      },
    ];

    for (const mutation of mutations) {
      const evaluation = structuredClone(baseEvaluation()) as unknown as Record<
        string,
        unknown
      >;
      mutation.mutate(evaluation);
      await expect(
        buildChronicleV2Diagnostics({
          contract,
          evaluation: evaluation as unknown as ChronicleV2ProductionEvaluation,
        }),
        mutation.name,
      ).rejects.toThrow(mutation.error);
    }
  });

  it("rejects missing, foreign, mismatched, and implicit source bindings", async () => {
    const mutations: readonly {
      name: string;
      mutate: (evaluation: Record<string, unknown>) => void;
      error: RegExp;
    }[] = [
      {
        name: "missing source binding",
        mutate: (evaluation) => {
          evaluation.sourceDocumentBindings = [];
        },
        error: /missing contract document/,
      },
      {
        name: "foreign source binding",
        mutate: (evaluation) => {
          const bindings = evaluation.sourceDocumentBindings as Array<
            Record<string, unknown>
          >;
          bindings[0] = {
            ...bindings[0],
            contractDocumentId: "foreign-contract-document",
          };
        },
        error: /unknown contract document/,
      },
      {
        name: "evidence source binding mismatch",
        mutate: (evaluation) => {
          const evidence = evaluation.evidence as Array<
            Record<string, unknown>
          >;
          const ranges = evidence[0]!.ranges as Array<Record<string, unknown>>;
          ranges[0] = { ...ranges[0], sourceRef: "foreign-evidence-ref" };
        },
        error: /evidence source ref is not bound/,
      },
    ];

    for (const mutation of mutations) {
      const evaluation = structuredClone(baseEvaluation()) as unknown as Record<
        string,
        unknown
      >;
      mutation.mutate(evaluation);
      await expect(
        buildChronicleV2Diagnostics({
          contract,
          evaluation: evaluation as unknown as ChronicleV2ProductionEvaluation,
        }),
        mutation.name,
      ).rejects.toThrow(mutation.error);
    }

    const identityFallbackContract: ChronicleV2Contract = {
      ...contract,
      temporalGold: {
        ...contract.temporalGold,
        relations: contract.temporalGold.relations.map((relation) => ({
          ...relation,
          requiredRegion: {
            ...relation.requiredRegion,
            documentId: "prepared-scene-north-gate",
          },
        })),
      },
    };
    await expect(
      buildChronicleV2Diagnostics({
        contract: identityFallbackContract,
        evaluation: baseEvaluation(identityFallbackContract),
      }),
    ).rejects.toThrow(/temporal Gold document is unmapped/);
  });

  it("requires contextual validation for changed evidence source bindings", async () => {
    const original = await buildBase();
    const changedEvaluation = structuredClone(
      baseEvaluation(),
    ) as unknown as Record<string, unknown>;
    const bindings = changedEvaluation.sourceDocumentBindings as Array<
      Record<string, unknown>
    >;
    bindings[0] = {
      ...bindings[0],
      evidenceSourceRefs: ["source-north-gate", "citation-chain"],
    };
    const changed =
      changedEvaluation as unknown as ChronicleV2ProductionEvaluation;

    const changedProjection = await buildChronicleV2Diagnostics({
      contract,
      evaluation: changed,
    });
    expect(changedProjection.evidenceGraphDigest).not.toBe(
      original.evidenceGraphDigest,
    );
    // A coherent replacement can self-validate without original-input context.
    expect(
      await validateChronicleV2Diagnostics(changedProjection),
    ).toMatchObject({ ok: true });

    const contextualResult = await validateChronicleV2Diagnostics(original, {
      contract,
      evaluation: changed,
    });
    expect(contextualResult.ok).toBe(false);
    if (!contextualResult.ok) {
      expect(
        contextualResult.diagnostics.map((diagnostic) => diagnostic.code),
      ).toContain("V2_DIAGNOSTICS_DIGEST_STALE");
    }
  });

  it("retains an exhaustive unknown actual but fails on cardinality overflow", async () => {
    const unknownRaw = [
      ...rawClaims,
      rawClaim(
        "actual-unknown-cardinality",
        "鎖が切れた",
        [{ entity: "北門の鎖", role: "theme" }],
        "citation-chain",
        { actuality: "probably-real" },
      ),
    ];
    const normalized = unknownRaw.map(normalizeChronicleV2Actual);
    const candidates = normalized.flatMap((actual) =>
      contract.observationGold.claims.map((gold) => ({
        actualRef: actual.actualRef,
        goldRef: gold.id,
        evidenceValid: true,
        overlap: true,
        directSupport: true,
        contextSupport: true,
      })),
    );
    const alignment = alignChronicleV2Claims({
      goldClaims: contract.observationGold.claims,
      normalizedActualClaims: normalized,
      evidenceCandidates: candidates,
      coverage: contract.coverage,
      proposalPolicy: contract.proposalPolicy,
    });
    expect(alignment.cardinalityExcessLowerBound).toBe(1);
    expect(alignment.unknownMatchCapacity).toBe(0);
    const evaluation = evaluationFromAlignment(
      contract,
      unknownRaw,
      alignment,
      candidates,
    );
    const projection = await buildChronicleV2Diagnostics({
      contract,
      evaluation,
    });

    expect(projection.observation).toMatchObject({
      goldCount: 4,
      actualCount: 5,
      matchedCount: 4,
      unobservableCount: 1,
      missingCount: 0,
      missingCountLowerBound: 0,
      unknownMatchCapacity: 0,
      cardinalityExcessLowerBound: 1,
      extraCount: 0,
      duplicateCount: 0,
    });
    expect(projection.semanticStatus).toBe("FAIL");
    expect(projection.observationPassed).toBe(false);
    expect(projection.semanticPassed).toBe(false);
    expect(projection.accepted).toBe(false);
    expect(await validateChronicleV2Diagnostics(projection)).toMatchObject({
      ok: true,
    });
  });

  it("derives exhaustive cardinality and rejects self-rehashed fake values", async () => {
    const unknownRaw = [
      ...rawClaims,
      rawClaim(
        "actual-unknown-cardinality-rehash",
        "鎖が切れた",
        [{ entity: "北門の鎖", role: "theme" }],
        "citation-chain",
        { actuality: "probably-real" },
      ),
    ];
    const normalized = unknownRaw.map(normalizeChronicleV2Actual);
    const candidates = normalized.flatMap((actual) =>
      contract.observationGold.claims.map((gold) => ({
        actualRef: actual.actualRef,
        goldRef: gold.id,
        evidenceValid: true,
        overlap: true,
        directSupport: true,
        contextSupport: true,
      })),
    );
    const alignment = alignChronicleV2Claims({
      goldClaims: contract.observationGold.claims,
      normalizedActualClaims: normalized,
      evidenceCandidates: candidates,
      coverage: contract.coverage,
      proposalPolicy: contract.proposalPolicy,
    });
    const evaluation = evaluationFromAlignment(
      contract,
      unknownRaw,
      alignment,
      candidates,
    );
    for (const fakeCardinality of [0, 2]) {
      const broken = structuredClone(evaluation) as unknown as Record<
        string,
        unknown
      >;
      (
        broken.alignment as Record<string, unknown>
      ).cardinalityExcessLowerBound = fakeCardinality;
      await expect(
        buildChronicleV2Diagnostics({
          contract,
          evaluation: broken as unknown as ChronicleV2ProductionEvaluation,
        }),
      ).rejects.toThrow(/alignment\.cardinalityExcessLowerBound/);
    }
    const projection = await buildChronicleV2Diagnostics({
      contract,
      evaluation,
    });
    const mutations = [
      { cardinalityExcessLowerBound: 0 },
      { cardinalityExcessLowerBound: 2 },
      { coverage: "targeted" as const },
    ];
    for (const mutation of mutations) {
      const candidate = structuredClone(projection) as unknown as Record<
        string,
        unknown
      >;
      Object.assign(candidate.observation as Record<string, unknown>, mutation);
      const rehashed = await recomputeSelfDigests(
        candidate as unknown as ChronicleV2DiagnosticsProjection,
      );
      const result = await validateChronicleV2Diagnostics(rehashed);
      expect(result.ok, JSON.stringify(mutation)).toBe(false);
      if (!result.ok) {
        expect(result.diagnostics).toContainEqual(
          expect.objectContaining({
            code: "V2_DIAGNOSTICS_PARITY_INVALID",
            path: "observation",
          }),
        );
      }
    }
  });

  it("rejects unknown fields, broken partitions, and stale digests", async () => {
    const projection = await buildBase();
    const unknownField = {
      ...projection,
      rawActualClaims: [],
    } as unknown;
    const unknownResult = await validateChronicleV2Diagnostics(unknownField);
    expect(unknownResult.ok).toBe(false);
    if (!unknownResult.ok) {
      expect(unknownResult.diagnostics.map((entry) => entry.code)).toContain(
        "V2_DIAGNOSTICS_UNKNOWN_FIELD",
      );
    }

    const broken = structuredClone(projection) as unknown as Record<
      string,
      unknown
    >;
    (broken.observation as Record<string, unknown>).actualCount = 5;
    const brokenResult = await validateChronicleV2Diagnostics(broken);
    expect(brokenResult.ok).toBe(false);
    if (!brokenResult.ok) {
      expect(brokenResult.diagnostics.map((entry) => entry.code)).toContain(
        "V2_DIAGNOSTICS_PARITY_INVALID",
      );
    }

    const stale = structuredClone(projection) as unknown as Record<
      string,
      unknown
    >;
    stale.goldDigest = projection.rawActualDigest;
    const staleResult = await validateChronicleV2Diagnostics(stale, {
      contract,
      evaluation: baseEvaluation(),
    });
    expect(staleResult.ok).toBe(false);
    if (!staleResult.ok) {
      expect(staleResult.diagnostics.map((entry) => entry.code)).toContain(
        "V2_DIAGNOSTICS_DIGEST_STALE",
      );
    }
  });

  it("rejects an evaluator count mismatch before any projection is persisted", async () => {
    const evaluation = baseEvaluation();
    const broken = {
      ...evaluation,
      observation: { ...evaluation.observation, actualCount: 9 },
    };
    await expect(
      buildChronicleV2Diagnostics({
        contract,
        evaluation: broken,
      }),
    ).rejects.toThrow(/observation\.actualCount/);
  });

  it("rejects impossible unknown-match capacity while building a projection", async () => {
    const broken = structuredClone(baseEvaluation()) as unknown as Record<
      string,
      unknown
    >;
    const alignment = broken.alignment as Record<string, unknown>;
    alignment.unknownMatchCapacity = 1;
    alignment.missingCountLowerBound = 0;
    const observation = broken.observation as Record<string, unknown>;
    observation.unknownMatchCapacity = 1;
    observation.missingCountLowerBound = 0;

    await expect(
      buildChronicleV2Diagnostics({
        contract,
        evaluation: broken as unknown as ChronicleV2ProductionEvaluation,
      }),
    ).rejects.toThrow(/unknown-match capacity/);
  });

  it("keeps formal acceptance separate from a semantic PASS under draft Gold", async () => {
    const projection = await buildBase();
    expect(projection.semanticStatus).toBe("PASS");
    expect(projection.semanticPassed).toBe(true);
    expect(projection.authorshipReady).toBe(false);
    expect(projection.accepted).toBe(false);
  });

  it("persists unknown actuals as undetermined Gold coverage", async () => {
    const unknownRaw = [
      rawClaim(
        "actual-unknown",
        "鎖が切れた",
        [{ entity: "北門の鎖", role: "theme" }],
        "citation-chain",
        { actuality: "probably-real" },
      ),
    ];
    const normalized = unknownRaw.map(normalizeChronicleV2Actual);
    const candidates = normalized.flatMap((actual) =>
      contract.observationGold.claims.map((gold) => ({
        actualRef: actual.actualRef,
        goldRef: gold.id,
        evidenceValid: true,
        overlap: true,
        directSupport: true,
        contextSupport: true,
      })),
    );
    const alignment = alignChronicleV2Claims({
      goldClaims: contract.observationGold.claims,
      normalizedActualClaims: normalized,
      evidenceCandidates: candidates,
      coverage: contract.coverage,
      proposalPolicy: contract.proposalPolicy,
    });
    const evaluation = evaluationFromAlignment(
      contract,
      unknownRaw,
      alignment,
      candidates,
    );
    const projection = await buildChronicleV2Diagnostics({
      contract,
      evaluation,
    });

    expect(projection.observation).toMatchObject({
      goldCount: 4,
      actualCount: 1,
      matchedCount: 0,
      mismatchCount: 0,
      missingCount: 3,
      missingCountLowerBound: 3,
      unknownMatchCapacity: 1,
      cardinalityExcessLowerBound: 0,
      undeterminedGoldCount: 1,
      goldJudgedCount: 3,
      actualJudgedCount: 0,
      judgedCount: 3,
      denominator: 5,
    });
    expect(projection.semanticStatus).toBe("FAIL");
    expect(projection.observationPassed).toBe(false);
    expect(projection.semanticPassed).toBe(false);
    expect(
      await validateChronicleV2Diagnostics(projection, {
        contract,
        evaluation,
      }),
    ).toMatchObject({
      ok: true,
    });
  });

  it("keeps a targeted outside-annotation actual unscored", async () => {
    const targetedContract: ChronicleV2Contract = {
      ...contract,
      coverage: { ...contract.coverage, observation: "targeted" },
    };
    const outside = rawClaim(
      "actual-targeted-outside",
      "門扉を修復した",
      [{ entity: "門扉", role: "theme" }],
      "citation-gate",
    );
    const targetedRaw = [...rawClaims, outside];
    const normalized = targetedRaw.map(normalizeChronicleV2Actual);
    const candidates = normalized.flatMap((actual) =>
      targetedContract.observationGold.claims.map((gold) => ({
        actualRef: actual.actualRef,
        goldRef: gold.id,
        evidenceValid: true,
        overlap: true,
        directSupport: true,
        contextSupport: true,
      })),
    );
    const alignment = alignChronicleV2Claims({
      goldClaims: targetedContract.observationGold.claims,
      normalizedActualClaims: normalized,
      evidenceCandidates: candidates,
      coverage: targetedContract.coverage,
      proposalPolicy: targetedContract.proposalPolicy,
    });
    const evaluation = evaluationFromAlignment(
      targetedContract,
      targetedRaw,
      alignment,
      candidates,
    );
    const projection = await buildChronicleV2Diagnostics({
      contract: targetedContract,
      evaluation,
    });

    expect(projection.observation).toMatchObject({
      goldCount: 4,
      actualCount: 5,
      matchedCount: 4,
      missingCount: 0,
      cardinalityExcessLowerBound: 0,
      unscoredActualCount: 1,
      undeterminedGoldCount: 0,
      actualJudgedCount: 4,
      judgedCount: 8,
      denominator: 9,
    });
    expect(projection.semanticStatus).toBe("UNDETERMINED");
    expect(projection.proposal).toMatchObject({
      mode: "unscored",
      status: "unscored",
      passed: false,
    });
  });

  it("reports a scored proposal failure while retaining its fixed denominator", async () => {
    const scoredContract: ChronicleV2Contract = {
      ...contract,
      proposalPolicy: {
        mode: "scored",
        scoredClaimIds: ["chain-break"],
        expectedDecisions: { "chain-break": "suppress" },
        reason: "explicit-fixture-policy",
      },
    };
    const normalized = rawClaims.map(normalizeChronicleV2Actual);
    const alignment = matchingAlignment(normalized, scoredContract);
    const proposal: ChronicleV2ProductionEvaluation["proposal"] = {
      mode: "scored",
      status: "fail",
      passed: false,
      eligibleGoldCount: 1,
      proposedCorrectCount: 0,
      proposedIncorrectCount: 1,
      suppressedCorrectCount: 0,
      suppressedIncorrectCount: 0,
      unobservableCount: 0,
      judgedCount: 1,
      denominator: 1,
    };
    const evaluation = evaluationFromAlignment(
      scoredContract,
      rawClaims,
      alignment,
      alignment.candidates,
      proposal,
    );
    const projection = await buildChronicleV2Diagnostics({
      contract: scoredContract,
      evaluation,
    });

    expect(projection.proposal).toMatchObject({
      mode: "scored",
      status: "fail",
      passed: false,
      eligibleGoldCount: 1,
      proposedIncorrectCount: 1,
      judgedCount: 1,
      denominator: 1,
    });
    expect(projection.proposalPassed).toBe(false);
    expect(projection.semanticStatus).toBe("FAIL");
    expect(projection.semanticPassed).toBe(false);
  });

  it("keeps a definite Proposal failure ahead of simultaneous unknown coverage", async () => {
    const scoredContract: ChronicleV2Contract = {
      ...contract,
      proposalPolicy: {
        mode: "scored",
        scoredClaimIds: ["chain-break"],
        expectedDecisions: { "chain-break": "suppress" },
        reason: "explicit-fixture-policy",
      },
    };
    const unknownRaw = [
      rawClaim(
        "actual-unknown-proposal",
        "鎖が切れた",
        [{ entity: "北門の鎖", role: "theme" }],
        "citation-chain",
        { actuality: "probably-real" },
      ),
    ];
    const normalized = unknownRaw.map(normalizeChronicleV2Actual);
    const candidates = normalized.flatMap((actual) =>
      scoredContract.observationGold.claims.map((gold) => ({
        actualRef: actual.actualRef,
        goldRef: gold.id,
        evidenceValid: true,
        overlap: true,
        directSupport: true,
        contextSupport: true,
      })),
    );
    const alignment = alignChronicleV2Claims({
      goldClaims: scoredContract.observationGold.claims,
      normalizedActualClaims: normalized,
      evidenceCandidates: candidates,
      coverage: scoredContract.coverage,
      proposalPolicy: scoredContract.proposalPolicy,
    });
    const evaluation = evaluationFromAlignment(
      scoredContract,
      unknownRaw,
      alignment,
      candidates,
      {
        mode: "scored",
        status: "fail",
        passed: false,
        eligibleGoldCount: 1,
        proposedCorrectCount: 0,
        proposedIncorrectCount: 1,
        suppressedCorrectCount: 0,
        suppressedIncorrectCount: 0,
        unobservableCount: 0,
        judgedCount: 1,
        denominator: 1,
      },
    );
    const projection = await buildChronicleV2Diagnostics({
      contract: scoredContract,
      evaluation,
    });

    expect(projection.observation.undeterminedGoldCount).toBe(1);
    expect(projection.observation.missingCountLowerBound).toBe(3);
    expect(projection.proposal.status).toBe("fail");
    expect(projection.semanticStatus).toBe("FAIL");
    expect(await validateChronicleV2Diagnostics(projection)).toMatchObject({
      ok: true,
    });
  });

  it("rejects non-finite flags and enums before context comparison", async () => {
    const projection = await buildBase();
    const malformed = structuredClone(projection) as unknown as Record<
      string,
      unknown
    >;
    malformed.semanticPassed = "true";
    (malformed.observation as Record<string, unknown>).coverage = "all";

    const result = await validateChronicleV2Diagnostics(malformed);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const codes = result.diagnostics.map((entry) => entry.code);
      expect(codes).toContain("V2_DIAGNOSTICS_BOOLEAN_INVALID");
      expect(codes).toContain("V2_DIAGNOSTICS_ENUM_INVALID");
    }
  });

  it("recomputes fixed parity and digests without evaluator context", async () => {
    const projection = await buildBase();
    const flipped = structuredClone(projection) as unknown as Record<
      string,
      unknown
    >;
    flipped.observationPassed = false;
    flipped.semanticStatus = "FAIL";
    flipped.semanticPassed = false;
    const selfConsistentFlip = await recomputeSelfDigests(
      flipped as unknown as ChronicleV2DiagnosticsProjection,
    );
    const flipResult = await validateChronicleV2Diagnostics(selfConsistentFlip);
    expect(flipResult.ok).toBe(false);
    if (!flipResult.ok) {
      expect(flipResult.diagnostics.map((entry) => entry.code)).toContain(
        "V2_DIAGNOSTICS_PARITY_INVALID",
      );
    }

    const evidenceMismatch = structuredClone(projection) as unknown as Record<
      string,
      unknown
    >;
    const evidence = evidenceMismatch.evidence as Record<string, unknown>;
    evidence.observedCount = 5;
    evidence.invalidObservationCount = 1;
    const selfConsistentEvidence = await recomputeSelfDigests(
      evidenceMismatch as unknown as ChronicleV2DiagnosticsProjection,
    );
    const evidenceResult = await validateChronicleV2Diagnostics(
      selfConsistentEvidence,
    );
    expect(evidenceResult.ok).toBe(false);
    if (!evidenceResult.ok) {
      expect(evidenceResult.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "V2_DIAGNOSTICS_PARITY_INVALID",
          path: "projection.evidence.observedCount",
        }),
      );
    }

    const impossibleDimension = structuredClone(
      projection,
    ) as unknown as Record<string, unknown>;
    const dimensionRows = impossibleDimension.dimensions as Record<
      string,
      Record<string, unknown>
    >;
    const predicate = dimensionRows.predicate;
    if (!predicate) throw new Error("Predicate dimension is missing");
    predicate.truePositive = 3;
    predicate.falseNegative = 0;
    predicate.pairedComparisonDenominator = 3;
    const selfConsistentDimension = await recomputeSelfDigests(
      impossibleDimension as unknown as ChronicleV2DiagnosticsProjection,
    );
    const dimensionResult = await validateChronicleV2Diagnostics(
      selfConsistentDimension,
    );
    expect(dimensionResult.ok).toBe(false);
    if (!dimensionResult.ok) {
      expect(dimensionResult.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "V2_DIAGNOSTICS_PARITY_INVALID",
          path: "projection.dimensions.predicate",
        }),
      );
    }

    const impossibleUnobservable = structuredClone(
      projection,
    ) as unknown as Record<string, unknown>;
    const role = (
      impossibleUnobservable.dimensions as Record<
        string,
        Record<string, unknown>
      >
    ).roles;
    if (!role) throw new Error("Role dimension is missing");
    role.truePositive = 4;
    role.falsePositive = 0;
    role.falseNegative = 0;
    role.unobservable = 1;
    role.pairedComparisonDenominator = 4;
    role.status = "scored";
    const selfConsistentUnobservable = await recomputeSelfDigests(
      impossibleUnobservable as unknown as ChronicleV2DiagnosticsProjection,
    );
    const unobservableResult = await validateChronicleV2Diagnostics(
      selfConsistentUnobservable,
    );
    expect(unobservableResult.ok).toBe(false);
    if (!unobservableResult.ok) {
      expect(unobservableResult.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "V2_DIAGNOSTICS_PARITY_INVALID",
          path: "projection.dimensions.roles",
        }),
      );
    }

    const partial = structuredClone(projection) as unknown as Record<
      string,
      unknown
    >;
    Object.assign(partial.observation as Record<string, unknown>, {
      goldCount: 1,
      actualCount: 1,
      matchedCount: 0,
      mismatchCount: 1,
      mismatchedGoldCount: 1,
      missingCount: 1,
      missingCountLowerBound: 1,
      unknownMatchCapacity: 0,
      cardinalityExcessLowerBound: 0,
      extraCount: 0,
      duplicateCount: 0,
      unscoredActualCount: 0,
      unobservableCount: 0,
      undeterminedGoldCount: 0,
      goldJudgedCount: 1,
      actualJudgedCount: 1,
      judgedCount: 2,
      denominator: 2,
    });
    Object.assign(partial.evidence as Record<string, unknown>, {
      observedCount: 1,
      validObservationCount: 1,
      invalidObservationCount: 0,
      resolvedReferenceCount: 1,
      unresolvedReferenceCount: 0,
      candidatePairCount: 1,
    });
    for (const dimension of CHRONICLE_V2_DIMENSIONS) {
      Object.assign(
        (partial.dimensions as Record<string, Record<string, unknown>>)[
          dimension
        ],
        {
          truePositive: 0,
          falsePositive: 1,
          falseNegative: 1,
          unobservable: 0,
          pairedComparisonDenominator: 1,
          status: "scored",
        },
      );
    }
    const partialRoles = (
      partial.dimensions as Record<string, Record<string, unknown>>
    ).roles;
    if (!partialRoles) throw new Error("Role dimension is missing");
    partialRoles.unobservable = 1;
    partial.observationPassed = false;
    partial.semanticStatus = "FAIL";
    partial.semanticPassed = false;
    const selfConsistentPartial = await recomputeSelfDigests(
      partial as unknown as ChronicleV2DiagnosticsProjection,
    );
    const partialResult = await validateChronicleV2Diagnostics(
      selfConsistentPartial,
    );
    expect(partialResult.ok).toBe(true);

    const impossiblePartial = structuredClone(
      selfConsistentPartial,
    ) as unknown as Record<string, unknown>;
    const impossibleRoles = (
      impossiblePartial.dimensions as Record<string, Record<string, unknown>>
    ).roles;
    if (!impossibleRoles) throw new Error("Role dimension is missing");
    impossibleRoles.truePositive = 1;
    impossibleRoles.falsePositive = 0;
    impossibleRoles.falseNegative = 0;
    impossibleRoles.pairedComparisonDenominator = 1;
    const impossiblePartialResult = await validateChronicleV2Diagnostics(
      await recomputeSelfDigests(
        impossiblePartial as unknown as ChronicleV2DiagnosticsProjection,
      ),
    );
    expect(impossiblePartialResult.ok).toBe(false);
    if (!impossiblePartialResult.ok) {
      expect(impossiblePartialResult.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "V2_DIAGNOSTICS_PARITY_INVALID",
          path: "projection.dimensions.roles",
        }),
      );
    }

    const primitiveImpossible = structuredClone(
      projection,
    ) as unknown as Record<string, unknown>;
    Object.assign(primitiveImpossible.observation as Record<string, unknown>, {
      goldCount: 2,
      actualCount: 2,
      matchedCount: 0,
      mismatchCount: 2,
      mismatchedGoldCount: 2,
      missingCount: 2,
      missingCountLowerBound: 2,
      unknownMatchCapacity: 0,
      cardinalityExcessLowerBound: 0,
      extraCount: 0,
      duplicateCount: 0,
      unscoredActualCount: 0,
      unobservableCount: 0,
      undeterminedGoldCount: 0,
      goldJudgedCount: 2,
      actualJudgedCount: 2,
      judgedCount: 4,
      denominator: 4,
    });
    Object.assign(primitiveImpossible.evidence as Record<string, unknown>, {
      observedCount: 2,
      validObservationCount: 2,
      invalidObservationCount: 0,
      resolvedReferenceCount: 2,
      unresolvedReferenceCount: 0,
      candidatePairCount: 2,
    });
    for (const dimension of CHRONICLE_V2_DIMENSIONS) {
      Object.assign(
        (
          primitiveImpossible.dimensions as Record<
            string,
            Record<string, unknown>
          >
        )[dimension],
        {
          truePositive: 0,
          falsePositive: 2,
          falseNegative: 2,
          unobservable: 0,
          pairedComparisonDenominator: 2,
          status: "scored",
        },
      );
    }
    const primitivePredicate = (
      primitiveImpossible.dimensions as Record<string, Record<string, unknown>>
    ).predicate;
    if (!primitivePredicate) throw new Error("Predicate dimension is missing");
    primitivePredicate.truePositive = 1;
    primitivePredicate.falsePositive = 1;
    primitivePredicate.falseNegative = 1;
    primitivePredicate.unobservable = 1;
    const primitiveResult = await validateChronicleV2Diagnostics(
      await recomputeSelfDigests(
        primitiveImpossible as unknown as ChronicleV2DiagnosticsProjection,
      ),
    );
    expect(primitiveResult.ok).toBe(false);
    if (!primitiveResult.ok) {
      expect(primitiveResult.diagnostics).toContainEqual(
        expect.objectContaining({
          code: "V2_DIAGNOSTICS_PARITY_INVALID",
          path: "projection.dimensions.predicate",
        }),
      );
    }

    const validDigestMutation = structuredClone(
      projection,
    ) as unknown as Record<string, unknown>;
    validDigestMutation.layersDigest = `sha256:${"0".repeat(64)}`;
    const digestResult =
      await validateChronicleV2Diagnostics(validDigestMutation);
    expect(digestResult.ok).toBe(false);
    if (!digestResult.ok) {
      expect(digestResult.diagnostics.map((entry) => entry.code)).toContain(
        "V2_DIAGNOSTICS_DIGEST_STALE",
      );
    }
  });

  it("binds Gold and actual digests to separate layers", async () => {
    const original = await buildBase();
    const changedContract = {
      ...contract,
      observationGold: {
        claims: contract.observationGold.claims.map((claim, index) =>
          index === 0 ? { ...claim, predicate: "gate-fall" as const } : claim,
        ),
      },
    } as ChronicleV2Contract;
    const changed = await buildChronicleV2Diagnostics({
      contract: changedContract,
      evaluation: baseEvaluation(changedContract),
    });

    expect(changed.goldDigest).not.toBe(original.goldDigest);
    expect(changed.normalizedActualDigest).toBe(
      original.normalizedActualDigest,
    );
    expect(changed.projectionDigest).not.toBe(original.projectionDigest);
    const stale = await validateChronicleV2Diagnostics(original, {
      contract: changedContract,
      evaluation: baseEvaluation(changedContract),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.diagnostics.map((entry) => entry.code)).toContain(
        "V2_DIAGNOSTICS_DIGEST_STALE",
      );
    }
  });
});
