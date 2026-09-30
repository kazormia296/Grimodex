import { describe, expect, it } from "vitest";
import type {
  ChronicleV2AlignmentInput,
  ChronicleV2EvidenceCandidate,
  ChronicleV2GoldClaim,
  ChronicleV2NormalizedActualClaim,
  ChronicleV2Predicate,
  ChronicleV2Entity,
  ChronicleV2Role,
} from "./chronicleV2Contract";
import {
  alignChronicleV2Claims,
  compareChronicleV2Claim,
} from "./chronicleV2Alignment";

const EVIDENCE = {
  documentId: "scene-north-gate",
  start: 0,
  end: 36,
} as const;

function gold(
  goldId: string,
  predicate: string,
  participants: readonly { entity: string; role: string }[] = [],
): ChronicleV2GoldClaim {
  return {
    id: goldId,
    predicate: predicate as ChronicleV2GoldClaim["predicate"],
    participants: participants as readonly {
      entity: ChronicleV2Entity;
      role: ChronicleV2Role;
    }[],
    actuality: "actual",
    attribution: "narrator",
    narrativeFrame: "story-world",
    requiredDirectRegions: [EVIDENCE],
    allowedContextRegions: [],
    granularity: "atomic",
  };
}

function actual(
  actualRef: string,
  predicate: string,
  participants: readonly { entity: string; role: string }[] = [],
  overrides: Partial<ChronicleV2NormalizedActualClaim> = {},
): ChronicleV2NormalizedActualClaim {
  return {
    actualRef,
    predicate: { status: "known", value: predicate as ChronicleV2Predicate },
    participants: participants.map((participant) => ({
      entity: { status: "known", value: participant.entity },
      role: { status: "known", value: participant.role },
    })) as ChronicleV2NormalizedActualClaim["participants"],
    actuality: { status: "known", value: "actual" },
    attribution: { status: "known", value: "narrator" },
    narrativeFrame: { status: "known", value: "story-world" },
    evidenceRefs: ["citation-v2-north-gate"],
    ...overrides,
  };
}

function input(
  goldClaims: readonly ChronicleV2GoldClaim[],
  normalizedActualClaims: readonly ChronicleV2NormalizedActualClaim[],
  reverseCandidates = false,
): ChronicleV2AlignmentInput {
  const evidenceCandidates = normalizedActualClaims.flatMap((claim) =>
    goldClaims.map((target) => ({
      actualRef: claim.actualRef,
      goldRef: target.id,
      evidenceValid: true,
      overlap: true,
      directSupport: true,
      contextSupport: true,
    })),
  );
  return {
    goldClaims,
    normalizedActualClaims,
    evidenceCandidates: reverseCandidates
      ? [...evidenceCandidates].reverse()
      : evidenceCandidates,
    coverage: { observation: "exhaustive", proposal: "targeted" },
    proposalPolicy: {
      mode: "unscored",
      scoredClaimIds: [],
      reason: "importance-not-annotated",
    },
  };
}

function inputWithCandidates(
  goldClaims: readonly ChronicleV2GoldClaim[],
  normalizedActualClaims: readonly ChronicleV2NormalizedActualClaim[],
  evidenceCandidates: readonly ChronicleV2EvidenceCandidate[],
  observation: "exhaustive" | "targeted" = "exhaustive",
): ChronicleV2AlignmentInput {
  return {
    goldClaims,
    normalizedActualClaims,
    evidenceCandidates,
    coverage: { observation, proposal: "targeted" },
    proposalPolicy: {
      mode: "unscored",
      scoredClaimIds: [],
      reason: "importance-not-annotated",
    },
  };
}

function edge(
  actualRef: string,
  goldRef: string,
  overrides: Partial<ChronicleV2EvidenceCandidate> = {},
): ChronicleV2EvidenceCandidate {
  return {
    actualRef,
    goldRef,
    evidenceValid: true,
    overlap: true,
    directSupport: true,
    contextSupport: true,
    ...overrides,
  };
}

describe("Chronicle evaluation contract v2 alignment", () => {
  it("matches two claims on the same evidence with deterministic one-to-one identity", () => {
    const goldClaims = [
      gold("claim-chain-break", "chain-break", [
        { entity: "north-gate-chain", role: "theme" },
      ]),
      gold("claim-gate-fall", "gate-fall", [
        { entity: "gate-leaf", role: "theme" },
        { entity: "street", role: "destination" },
      ]),
    ];
    const normalizedActualClaims = [
      actual("actual-gate-fall", "gate-fall", [
        { entity: "gate-leaf", role: "theme" },
        { entity: "street", role: "destination" },
      ]),
      actual("actual-chain-break", "chain-break", [
        { entity: "north-gate-chain", role: "theme" },
      ]),
    ];

    const result = alignChronicleV2Claims(
      input(goldClaims, normalizedActualClaims),
    );
    const reversed = alignChronicleV2Claims(
      input(
        [...goldClaims].reverse(),
        [...normalizedActualClaims].reverse(),
        true,
      ),
    );

    expect(
      result.assignments.map((assignment) => [
        assignment.actualRef,
        assignment.goldRef,
        assignment.status,
      ]),
    ).toEqual([
      ["actual-chain-break", "claim-chain-break", "match"],
      ["actual-gate-fall", "claim-gate-fall", "match"],
    ]);
    expect(result.matchedCount).toBe(2);
    expect(result.matchedGoldRefs).toEqual([
      "claim-chain-break",
      "claim-gate-fall",
    ]);
    expect(result.duplicateCount).toBe(0);
    expect(reversed.assignments).toEqual(result.assignments);
    expect(reversed.candidates).toEqual(result.candidates);
  });

  it("keeps evidence overlap as a candidate while rejecting predicate and role meaning changes", () => {
    const target = gold("claim-gate-fall", "gate-fall", [
      { entity: "gate-leaf", role: "theme" },
      { entity: "street", role: "destination" },
    ]);
    const wrongPredicate = actual("wrong-predicate", "gate-repair", [
      { entity: "gate-leaf", role: "theme" },
      { entity: "street", role: "destination" },
    ]);
    const wrongRole = actual("wrong-role", "gate-fall", [
      { entity: "street", role: "theme" },
      { entity: "gate-leaf", role: "destination" },
    ]);

    for (const candidate of [wrongPredicate, wrongRole]) {
      const result = alignChronicleV2Claims(input([target], [candidate]));
      expect(result.candidates).toEqual([
        expect.objectContaining({
          actualRef: candidate.actualRef,
          goldRef: target.id,
          evidenceValid: true,
          overlap: true,
        }),
      ]);
      expect(result.assignments[0]).toEqual(
        expect.objectContaining({
          actualRef: candidate.actualRef,
          goldRef: target.id,
          status: "mismatch",
        }),
      );
      expect(result.assignments[0]?.reason).toMatch(
        /predicate-mismatch|role-mismatch/,
      );
      expect(result.matchedCount).toBe(0);
    }
  });

  it("does not turn unknown free text into a definite false positive or a pass", () => {
    const target = gold("claim-chain-break", "chain-break", [
      { entity: "north-gate-chain", role: "theme" },
    ]);
    const unknown = actual(
      "unknown",
      "自由記述の出来事",
      [{ entity: "north-gate-chain", role: "theme" }],
      {
        predicate: {
          status: "unknown",
          reason: "predicate-out-of-vocabulary",
        },
      },
    );

    const result = alignChronicleV2Claims(input([target], [unknown]));

    expect(result.assignments[0]).toEqual(
      expect.objectContaining({
        actualRef: "unknown",
        goldRef: null,
        status: "unobservable",
      }),
    );
    expect(result.assignments[0]?.reason).toBe("meaning-out-of-vocabulary");
    expect(result.falsePositiveCount).toBe(0);
    expect(result.undeterminedGoldCount).toBe(1);
    expect(result.passed).toBe(false);
  });

  it("marks every plausible Gold claim uncertain for an unknown broad-span actual", () => {
    const goldClaims = [
      gold("claim-chain-break", "chain-break", [
        { entity: "north-gate-chain", role: "theme" },
      ]),
      gold("claim-gate-fall", "gate-fall", [
        { entity: "gate-leaf", role: "theme" },
      ]),
    ];
    const unknown = actual("unknown-broad-span", "不明な出来事", [], {
      predicate: {
        status: "unknown",
        reason: "predicate-out-of-vocabulary",
      },
      participants: [
        {
          entity: { status: "unknown", reason: "entity-out-of-vocabulary" },
          role: { status: "unknown", reason: "role-out-of-vocabulary" },
        },
      ],
    });

    const result = alignChronicleV2Claims(input(goldClaims, [unknown]));

    expect(result.undeterminedGoldRefs).toEqual([
      "claim-chain-break",
      "claim-gate-fall",
    ]);
    expect(result.undeterminedGoldCount).toBe(2);
    expect(result.unknownMatchCapacity).toBe(1);
    expect(result.missingCountLowerBound).toBe(1);
    expect(result.cardinalityExcessLowerBound).toBe(0);
    expect(result.missingCount).toBe(0);
    expect(result.falsePositiveCount).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("keeps a fixed four-Gold wildcard at capacity one with a lower bound of three", () => {
    const goldClaims = [
      gold("claim-chain", "chain-break"),
      gold("claim-gate", "gate-fall"),
      gold("claim-bell", "bell-ring"),
      gold("claim-evacuation", "evacuate"),
    ];
    const unknown = actual("unknown", "自由記述の出来事", [], {
      predicate: {
        status: "unknown",
        reason: "predicate-out-of-vocabulary",
      },
    });

    const result = alignChronicleV2Claims(input(goldClaims, [unknown]));

    expect(result.undeterminedGoldRefs).toEqual([
      "claim-bell",
      "claim-chain",
      "claim-evacuation",
      "claim-gate",
    ]);
    expect(result.undeterminedGoldCount).toBe(4);
    expect(result.unknownMatchCapacity).toBe(1);
    expect(result.missingCountLowerBound).toBe(3);
    expect(result.cardinalityExcessLowerBound).toBe(0);
    expect(result.missingCount).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("keeps two partially unknown actuals uncertain under a reversed input-order variant", () => {
    const goldClaims = [
      gold("chain-break", "chain-break", [
        { entity: "north-gate-chain", role: "theme" },
      ]),
      gold("gate-fall", "gate-fall", [
        { entity: "gate-leaf", role: "theme" },
        { entity: "street", role: "destination" },
      ]),
      gold("guards-ring-bell", "ring-bell", [
        { entity: "guard", role: "agent" },
        { entity: "bell", role: "theme" },
      ]),
      gold("guards-evacuate-passersby", "evacuate", [
        { entity: "guard", role: "agent" },
        { entity: "passerby", role: "theme" },
        { entity: "square", role: "destination" },
      ]),
    ];
    const unknownA1 = actual(
      "actual-a1",
      "unrecognized-event",
      [
        { entity: "guard", role: "unrecognized-role-a" },
        { entity: "unrecognized-entity-a", role: "unrecognized-role-a" },
      ],
      {
        predicate: {
          status: "unknown",
          reason: "predicate-out-of-vocabulary",
        },
        participants: [
          {
            entity: { status: "known", value: "guard" },
            role: { status: "unknown", reason: "role-out-of-vocabulary" },
          },
          {
            entity: { status: "unknown", reason: "entity-out-of-vocabulary" },
            role: { status: "unknown", reason: "role-out-of-vocabulary" },
          },
        ],
      },
    );
    const unknownA2 = actual(
      "actual-a2",
      "unrecognized-event",
      [
        { entity: "gate-leaf", role: "theme" },
        { entity: "unrecognized-entity-b", role: "unrecognized-role-b" },
      ],
      {
        predicate: {
          status: "unknown",
          reason: "predicate-out-of-vocabulary",
        },
        participants: [
          {
            entity: { status: "known", value: "gate-leaf" },
            role: { status: "unknown", reason: "role-out-of-vocabulary" },
          },
          {
            entity: { status: "unknown", reason: "entity-out-of-vocabulary" },
            role: { status: "unknown", reason: "role-out-of-vocabulary" },
          },
        ],
      },
    );
    const exactChain = actual("actual-chain", "chain-break", [
      { entity: "north-gate-chain", role: "theme" },
    ]);
    const exactEvacuation = actual("actual-evac", "evacuate", [
      { entity: "guard", role: "agent" },
      { entity: "passerby", role: "theme" },
      { entity: "square", role: "destination" },
    ]);
    const normalizedActualClaims = [
      unknownA1,
      unknownA2,
      exactChain,
      exactEvacuation,
    ];
    const evidenceCandidates = normalizedActualClaims.flatMap((claim) =>
      goldClaims.map((target) => edge(claim.actualRef, target.id)),
    );

    const result = alignChronicleV2Claims(
      inputWithCandidates(
        goldClaims,
        normalizedActualClaims,
        evidenceCandidates,
      ),
    );
    const permuted = alignChronicleV2Claims(
      inputWithCandidates(
        [...goldClaims].reverse(),
        [...normalizedActualClaims].reverse(),
        [...evidenceCandidates].reverse(),
      ),
    );

    expect(result.assignments).toEqual([
      {
        actualRef: "actual-a1",
        goldRef: null,
        status: "unobservable",
        reason: "meaning-out-of-vocabulary",
      },
      {
        actualRef: "actual-a2",
        goldRef: null,
        status: "unobservable",
        reason: "meaning-out-of-vocabulary",
      },
      {
        actualRef: "actual-chain",
        goldRef: "chain-break",
        status: "match",
      },
      {
        actualRef: "actual-evac",
        goldRef: "guards-evacuate-passersby",
        status: "match",
      },
    ]);
    expect(result.matchedGoldRefs).toEqual([
      "chain-break",
      "guards-evacuate-passersby",
    ]);
    expect(result.undeterminedGoldRefs).toEqual([
      "gate-fall",
      "guards-ring-bell",
    ]);
    expect(result.undeterminedGoldCount).toBe(2);
    expect(result.unknownMatchCapacity).toBe(2);
    expect(result.missingCountLowerBound).toBe(0);
    expect(result.missingCount).toBe(0);
    expect(result.mismatchCount).toBe(0);
    expect(result.extraCount).toBe(0);
    expect(result.cardinalityExcessLowerBound).toBe(0);
    expect(result.passed).toBe(false);
    expect(permuted.assignments).toEqual(result.assignments);
    expect(permuted.undeterminedGoldRefs).toEqual(result.undeterminedGoldRefs);
    expect(permuted.unknownMatchCapacity).toBe(result.unknownMatchCapacity);
    expect(permuted.missingCountLowerBound).toBe(result.missingCountLowerBound);
  });

  it("keeps three exact claims plus one compatible unknown at zero cardinality excess", () => {
    const goldClaims = [
      gold("chain-break", "chain-break", [
        { entity: "north-gate-chain", role: "theme" },
      ]),
      gold("gate-fall", "gate-fall", [
        { entity: "gate-leaf", role: "theme" },
        { entity: "street", role: "destination" },
      ]),
      gold("guards-ring-bell", "ring-bell", [
        { entity: "guard", role: "agent" },
        { entity: "bell", role: "theme" },
      ]),
      gold("guards-evacuate-passersby", "evacuate", [
        { entity: "guard", role: "agent" },
        { entity: "passerby", role: "theme" },
        { entity: "square", role: "destination" },
      ]),
    ];
    const exactClaims = [
      actual("actual-chain", "chain-break", [
        { entity: "north-gate-chain", role: "theme" },
      ]),
      actual("actual-gate", "gate-fall", [
        { entity: "gate-leaf", role: "theme" },
        { entity: "street", role: "destination" },
      ]),
      actual("actual-bell", "ring-bell", [
        { entity: "guard", role: "agent" },
        { entity: "bell", role: "theme" },
      ]),
    ];
    const unknownEvacuation = actual(
      "actual-unknown-evac",
      "unrecognized-event",
      [
        { entity: "guard", role: "agent" },
        { entity: "passerby", role: "theme" },
        { entity: "square", role: "destination" },
      ],
      {
        predicate: {
          status: "unknown",
          reason: "predicate-out-of-vocabulary",
        },
      },
    );
    const normalizedActualClaims = [...exactClaims, unknownEvacuation];
    const evidenceCandidates = normalizedActualClaims.flatMap((claim) =>
      goldClaims.map((target) => edge(claim.actualRef, target.id)),
    );
    const result = alignChronicleV2Claims(
      inputWithCandidates(
        goldClaims,
        normalizedActualClaims,
        evidenceCandidates,
      ),
    );

    expect(result.matchedGoldRefs).toEqual([
      "chain-break",
      "gate-fall",
      "guards-ring-bell",
    ]);
    expect(result.undeterminedGoldRefs).toEqual(["guards-evacuate-passersby"]);
    expect(result.matchedCount).toBe(3);
    expect(result.unobservableCount).toBe(1);
    expect(result.unknownMatchCapacity).toBe(1);
    expect(result.missingCountLowerBound).toBe(0);
    expect(result.cardinalityExcessLowerBound).toBe(0);
    expect(result.mismatchCount).toBe(0);
    expect(result.extraCount).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("consumes one Gold claim once and reports a duplicate separately", () => {
    const target = gold("claim-bell", "bell-ring", [
      { entity: "guards", role: "agent" },
      { entity: "bell", role: "theme" },
    ]);
    const claims = [
      actual("first", "bell-ring", [
        { entity: "guards", role: "agent" },
        { entity: "bell", role: "theme" },
      ]),
      actual("duplicate", "bell-ring", [
        { entity: "guards", role: "agent" },
        { entity: "bell", role: "theme" },
      ]),
    ];

    const result = alignChronicleV2Claims(input([target], claims));

    expect(result.matchedCount).toBe(1);
    expect(result.duplicateCount).toBe(1);
    expect(
      result.assignments.filter((entry) => entry.status === "match"),
    ).toHaveLength(1);
    expect(
      result.assignments.filter((entry) => entry.reason === "duplicate-claim"),
    ).toHaveLength(1);
    expect(result.mismatchCount).toBe(0);
    expect(result.falsePositiveCount).toBe(1);
    expect(result.falseNegativeCount).toBe(0);
    expect(result.cardinalityExcessLowerBound).toBe(1);
  });

  it("keeps a known wrong claim overlapping a used Gold span as an extra", () => {
    const target = gold("claim-chain", "chain-break");
    const correct = actual("correct", "chain-break");
    const fabricated = actual("fabricated", "gate-repair");

    const result = alignChronicleV2Claims(
      input([target], [correct, fabricated]),
    );

    expect(result.matchedCount).toBe(1);
    expect(result.mismatchCount).toBe(0);
    expect(result.extraCount).toBe(1);
    expect(result.duplicateCount).toBe(0);
    expect(result.cardinalityExcessLowerBound).toBe(1);
    expect(result.falsePositiveCount).toBe(1);
    expect(result.falseNegativeCount).toBe(0);
    expect(
      result.assignments.find((entry) => entry.actualRef === "fabricated"),
    ).toEqual({
      actualRef: "fabricated",
      goldRef: null,
      status: "mismatch",
      reason: "extra-claim",
    });
  });

  it("leaves targeted known claims outside the Gold annotation unscored", () => {
    const target = gold("claim-chain", "chain-break");
    const correct = actual("correct", "chain-break");
    const outside = actual("outside", "gate-repair");
    const targetedInput = {
      ...input([target], [correct, outside]),
      coverage: {
        observation: "targeted" as const,
        proposal: "targeted" as const,
      },
    };

    const result = alignChronicleV2Claims(targetedInput);

    expect(result.matchedCount).toBe(1);
    expect(result.extraCount).toBe(0);
    expect(result.unscoredCount).toBe(1);
    expect(result.falsePositiveCount).toBe(0);
    expect(result.missingCount).toBe(0);
    expect(result.cardinalityExcessLowerBound).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("reserves globally available exact matches before classifying an early mismatch", () => {
    const run = (chainId: string, otherId: string) => {
      const goldClaims = [
        gold(chainId, "chain-break"),
        gold(otherId, "gate-fall"),
      ];
      const normalizedActualClaims = [
        actual("early-mismatch", "gate-repair"),
        actual("later-exact", "chain-break"),
      ];
      return alignChronicleV2Claims(input(goldClaims, normalizedActualClaims));
    };

    const first = run("z-chain", "a-other");
    const renamed = run("a-chain", "z-other");

    for (const result of [first, renamed]) {
      expect(result.matchedCount).toBe(1);
      expect(result.mismatchCount).toBe(1);
      expect(result.duplicateCount).toBe(0);
      expect(result.missingCount).toBe(1);
      expect(result.falseNegativeCount).toBe(1);
      expect(result.falsePositiveCount).toBe(1);
    }
    expect(first.assignments).toEqual([
      {
        actualRef: "early-mismatch",
        goldRef: "a-other",
        status: "mismatch",
        reason: "predicate-mismatch",
      },
      {
        actualRef: "later-exact",
        goldRef: "z-chain",
        status: "match",
      },
    ]);
    expect(renamed.assignments).toEqual([
      {
        actualRef: "early-mismatch",
        goldRef: "z-other",
        status: "mismatch",
        reason: "predicate-mismatch",
      },
      {
        actualRef: "later-exact",
        goldRef: "a-chain",
        status: "match",
      },
    ]);
  });

  it("partitions a broad unknown span from later exact matches", () => {
    const goldClaims = [
      gold("claim-chain-break", "chain-break"),
      gold("claim-gate-fall", "gate-fall"),
    ];
    const unknown = actual("unknown-broad-span", "自由記述の出来事", [], {
      predicate: {
        status: "unknown",
        reason: "predicate-out-of-vocabulary",
      },
    });
    const correctChain = actual("correct-chain", "chain-break");
    const correctGate = actual("correct-gate", "gate-fall");

    const result = alignChronicleV2Claims(
      input(goldClaims, [unknown, correctChain, correctGate]),
    );

    expect(result.matchedCount).toBe(2);
    expect(result.unobservableCount).toBe(1);
    expect(result.undeterminedGoldRefs).toEqual([]);
    expect(result.missingGoldRefs).toEqual([]);
    expect(result.missingCount).toBe(0);
    expect(result.falsePositiveCount).toBe(0);
    expect(result.cardinalityExcessLowerBound).toBe(1);
    expect(result.passed).toBe(false);
  });

  it("compares duplicate participant rows with multiplicity", () => {
    const target = gold("claim-duplicate-participant", "ring-bell", [
      { entity: "guard", role: "agent" },
      { entity: "guard", role: "agent" },
    ]);
    const candidate = actual("candidate", "ring-bell", [
      { entity: "guard", role: "agent" },
    ]);

    const result = alignChronicleV2Claims(input([target], [candidate]));

    expect(result.assignments[0]).toEqual({
      actualRef: "candidate",
      goldRef: target.id,
      status: "mismatch",
      reason: "participant-missing",
    });
    expect(result.matchedCount).toBe(0);
    expect(result.mismatchCount).toBe(1);
    expect(result.missingGoldRefs).toEqual([target.id]);
    expect(result.missingCount).toBe(1);
    expect(result.falseNegativeCount).toBe(1);
  });

  it("requires all four evidence gates before creating a semantic edge", () => {
    const target = gold("claim-chain-break", "chain-break");
    const candidate = actual("actual", "chain-break");
    const result = alignChronicleV2Claims(
      inputWithCandidates(
        [target],
        [candidate],
        [
          edge("actual", target.id, {
            directSupport: false,
          }),
        ],
      ),
    );

    expect(result.assignments).toEqual([
      {
        actualRef: "actual",
        goldRef: null,
        status: "mismatch",
        reason: "evidence-no-candidate",
      },
    ]);
    expect(result.matchedCount).toBe(0);
    expect(result.extraCount).toBe(1);
    expect(result.missingGoldRefs).toEqual([target.id]);
  });

  it("chooses the most similar Gold when mismatch cardinality ties", () => {
    const chain = gold("claim-chain-break", "chain-break", [
      { entity: "north-gate-chain", role: "theme" },
    ]);
    const gate = gold("claim-gate-fall", "gate-fall", [
      { entity: "gate-leaf", role: "theme" },
      { entity: "street", role: "destination" },
    ]);
    const wrong = actual("wrong", "gate-repair", [
      { entity: "gate-leaf", role: "theme" },
      { entity: "street", role: "destination" },
    ]);

    const result = alignChronicleV2Claims(
      inputWithCandidates(
        [chain, gate],
        [wrong],
        [edge("wrong", chain.id), edge("wrong", gate.id)],
      ),
    );

    expect(result.assignments).toEqual([
      {
        actualRef: "wrong",
        goldRef: gate.id,
        status: "mismatch",
        reason: "predicate-mismatch",
      },
    ]);
    expect(result.mismatchCount).toBe(1);
    expect(result.missingGoldRefs).toEqual([chain.id, gate.id]);
  });

  it("maximizes mismatch pair count before choosing similarity", () => {
    const firstGold = gold("a-gold", "chain-break");
    const secondGold = gold("b-gold", "gate-fall");
    const firstActual = actual("a-actual", "gate-repair");
    const secondActual = actual("b-actual", "bell-break");

    const result = alignChronicleV2Claims(
      inputWithCandidates(
        [firstGold, secondGold],
        [firstActual, secondActual],
        [
          edge(firstActual.actualRef, firstGold.id),
          edge(firstActual.actualRef, secondGold.id),
          edge(secondActual.actualRef, firstGold.id),
        ],
      ),
    );

    expect(result.assignments.map((assignment) => assignment.goldRef)).toEqual([
      secondGold.id,
      firstGold.id,
    ]);
    expect(result.mismatchCount).toBe(2);
    expect(result.missingCount).toBe(2);
  });

  it("keeps a diagnostic conflict graph stable under Gold, actual, and edge permutations", () => {
    const firstGold = gold("a-gold", "chain-break");
    const secondGold = gold("b-gold", "gate-fall");
    const firstActual = actual("a-actual", "gate-repair");
    const secondActual = actual("b-actual", "bell-break");
    const candidates = [
      edge(firstActual.actualRef, firstGold.id),
      edge(firstActual.actualRef, secondGold.id),
      edge(secondActual.actualRef, firstGold.id),
    ];

    const forward = alignChronicleV2Claims(
      inputWithCandidates(
        [firstGold, secondGold],
        [firstActual, secondActual],
        candidates,
      ),
    );
    const reversed = alignChronicleV2Claims(
      inputWithCandidates(
        [secondGold, firstGold],
        [secondActual, firstActual],
        [...candidates].reverse(),
      ),
    );

    expect(forward.assignments).toEqual([
      {
        actualRef: firstActual.actualRef,
        goldRef: secondGold.id,
        status: "mismatch",
        reason: "predicate-mismatch",
      },
      {
        actualRef: secondActual.actualRef,
        goldRef: firstGold.id,
        status: "mismatch",
        reason: "predicate-mismatch",
      },
    ]);
    expect(reversed.assignments).toEqual(forward.assignments);
    expect(reversed.candidates).toEqual(forward.candidates);
    expect(reversed.matchedCount).toBe(forward.matchedCount);
    expect(reversed.mismatchCount).toBe(forward.mismatchCount);
    expect(reversed.missingGoldRefs).toEqual(forward.missingGoldRefs);
  });

  it("uses canonical actual and Gold IDs for an equal-cardinality equal-similarity tie", () => {
    const firstGold = gold("a-gold", "chain-break");
    const secondGold = gold("b-gold", "gate-fall");
    const firstActual = actual("a-actual", "gate-repair");
    const secondActual = actual("b-actual", "bell-break");
    const candidates = [
      edge(firstActual.actualRef, firstGold.id),
      edge(firstActual.actualRef, secondGold.id),
      edge(secondActual.actualRef, firstGold.id),
      edge(secondActual.actualRef, secondGold.id),
    ];

    const result = alignChronicleV2Claims(
      inputWithCandidates(
        [firstGold, secondGold],
        [firstActual, secondActual],
        candidates,
      ),
    );
    const permuted = alignChronicleV2Claims(
      inputWithCandidates(
        [secondGold, firstGold],
        [secondActual, firstActual],
        [...candidates].reverse(),
      ),
    );

    expect(result.assignments).toEqual([
      {
        actualRef: firstActual.actualRef,
        goldRef: firstGold.id,
        status: "mismatch",
        reason: "predicate-mismatch",
      },
      {
        actualRef: secondActual.actualRef,
        goldRef: secondGold.id,
        status: "mismatch",
        reason: "predicate-mismatch",
      },
    ]);
    expect(permuted.assignments).toEqual(result.assignments);
    expect(result.mismatchCount).toBe(2);
    expect(result.missingCount).toBe(2);
  });

  it("keeps a partially unknown compatible claim unobservable with one-to-one capacity", () => {
    const target = gold("claim-bell", "ring-bell", [
      { entity: "guard", role: "agent" },
      { entity: "bell", role: "theme" },
    ]);
    const unknown = actual(
      "unknown",
      "ring-bell",
      [
        { entity: "guard", role: "agent" },
        { entity: "bell", role: "theme" },
      ],
      {
        attribution: {
          status: "unknown",
          reason: "attribution-out-of-vocabulary",
        },
      },
    );
    const result = alignChronicleV2Claims(
      inputWithCandidates(
        [target],
        [unknown],
        [edge(unknown.actualRef, target.id)],
      ),
    );

    expect(result.assignments).toEqual([
      {
        actualRef: unknown.actualRef,
        goldRef: null,
        status: "unobservable",
        reason: "attribution-out-of-vocabulary",
      },
    ]);
    expect(result.matchedGoldRefs).toEqual([]);
    expect(result.undeterminedGoldRefs).toEqual([target.id]);
    expect(result.unknownMatchCapacity).toBe(1);
    expect(result.missingCountLowerBound).toBe(0);
    expect(result.missingCount).toBe(0);
  });

  it("does not make a contradictory unknown row pass as unobservable", () => {
    const target = gold("claim-gate-fall", "gate-fall", [
      { entity: "gate-leaf", role: "theme" },
      { entity: "street", role: "destination" },
    ]);
    const contradictory = actual(
      "contradictory",
      "gate-repair",
      [
        { entity: "gate-leaf", role: "theme" },
        { entity: "street", role: "destination" },
      ],
      {
        attribution: {
          status: "unknown",
          reason: "attribution-out-of-vocabulary",
        },
      },
    );
    const result = alignChronicleV2Claims(
      inputWithCandidates(
        [target],
        [contradictory],
        [edge(contradictory.actualRef, target.id)],
      ),
    );

    expect(result.assignments).toEqual([
      {
        actualRef: contradictory.actualRef,
        goldRef: target.id,
        status: "mismatch",
        reason: "predicate-mismatch",
      },
    ]);
    expect(result.unobservableCount).toBe(0);
    expect(result.mismatchCount).toBe(1);
    expect(result.unknownMatchCapacity).toBe(0);
  });

  it("reports unknown participant contradictions while retaining unknown dimensions", () => {
    const target = gold("claim-chain-break", "chain-break", [
      { entity: "north-gate-chain", role: "theme" },
    ]);
    const partial = actual(
      "partial",
      "chain-break",
      [{ entity: "gate-leaf", role: "theme" }],
      {
        participants: [
          {
            entity: { status: "unknown", reason: "entity-out-of-vocabulary" },
            role: { status: "known", value: "destination" },
          },
        ],
      },
    );
    const comparison = compareChronicleV2Claim(partial, target);

    expect(comparison.compatible).toBe(false);
    expect(comparison.exact).toBe(false);
    expect(comparison.dimensions.participants).toBe("unknown");
    expect(comparison.dimensions.roles).toBe("mismatch");
    expect(comparison.reason).toBe("role-mismatch");
  });

  it("uses only supported unknown edges for the Gold uncertainty union", () => {
    const target = gold("claim-chain-break", "chain-break", [
      { entity: "north-gate-chain", role: "theme" },
    ]);
    const unknown = actual(
      "unknown",
      "自由記述",
      [{ entity: "north-gate-chain", role: "theme" }],
      {
        predicate: {
          status: "unknown",
          reason: "predicate-out-of-vocabulary",
        },
      },
    );
    const result = alignChronicleV2Claims(
      inputWithCandidates(
        [target],
        [unknown],
        [
          edge(unknown.actualRef, target.id, {
            contextSupport: false,
          }),
        ],
      ),
    );

    expect(result.assignments[0]?.status).toBe("unobservable");
    expect(result.undeterminedGoldRefs).toEqual([]);
    expect(result.unknownMatchCapacity).toBe(0);
    expect(result.missingGoldRefs).toEqual([target.id]);
  });

  it("keeps an unknown row when its only compatible Gold is exact-consumed", () => {
    const exactGold = gold("a-exact", "chain-break", [
      { entity: "north-gate-chain", role: "theme" },
    ]);
    const otherGold = gold("b-other", "gate-fall", [
      { entity: "gate-leaf", role: "theme" },
    ]);
    const exactActual = actual("exact", "chain-break", [
      { entity: "north-gate-chain", role: "theme" },
    ]);
    const unknown = actual(
      "unknown",
      "自由記述",
      [{ entity: "north-gate-chain", role: "theme" }],
      {
        predicate: {
          status: "unknown",
          reason: "predicate-out-of-vocabulary",
        },
      },
    );
    const result = alignChronicleV2Claims(
      inputWithCandidates(
        [exactGold, otherGold],
        [exactActual, unknown],
        [
          edge(exactActual.actualRef, exactGold.id),
          edge(exactActual.actualRef, otherGold.id),
          edge(unknown.actualRef, exactGold.id),
          edge(unknown.actualRef, otherGold.id),
        ],
      ),
    );

    expect(result.matchedGoldRefs).toEqual([exactGold.id]);
    expect(result.assignments).toEqual([
      {
        actualRef: exactActual.actualRef,
        goldRef: exactGold.id,
        status: "match",
      },
      {
        actualRef: unknown.actualRef,
        goldRef: null,
        status: "unobservable",
        reason: "meaning-out-of-vocabulary",
      },
    ]);
    expect(result.undeterminedGoldRefs).toEqual([]);
    expect(result.unknownMatchCapacity).toBe(0);
    expect(result.mismatchCount).toBe(0);
    expect(result.extraCount).toBe(0);
    expect(result.missingGoldRefs).toEqual([otherGold.id]);
    expect(result.missingCountLowerBound).toBe(1);
    expect(result.cardinalityExcessLowerBound).toBe(0);
    expect(result.passed).toBe(false);
  });

  it("is independent of input order and does not copy Gold meaning into actual claims", () => {
    const target = gold("claim-chain-break", "chain-break", [
      { entity: "north-gate-chain", role: "theme" },
    ]);
    const candidate = actual("actual", "chain-break", [
      { entity: "north-gate-chain", role: "theme" },
    ]);
    const original = JSON.parse(JSON.stringify(candidate)) as unknown;

    const forward = alignChronicleV2Claims(input([target], [candidate]));
    const reverse = alignChronicleV2Claims(input([target], [candidate], true));

    expect(reverse.assignments).toEqual(forward.assignments);
    expect(candidate).toEqual(original);
    expect(candidate).not.toHaveProperty("goldId");
    expect(candidate).not.toHaveProperty("semanticKey", target.id);
  });

  it("rejects duplicate Gold and actual IDs before constructing lookup maps", () => {
    const target = gold("claim-chain-break", "chain-break");
    const candidate = actual("actual-chain-break", "chain-break");

    expect(() =>
      alignChronicleV2Claims(input([target, { ...target }], [candidate])),
    ).toThrow(/Gold claim IDs must be unique/);
    expect(() =>
      alignChronicleV2Claims(input([target], [candidate, { ...candidate }])),
    ).toThrow(/actual claim IDs must be unique/);
  });
});
