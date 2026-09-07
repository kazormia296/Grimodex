import { describe, expect, it } from "vitest";
import type { RawChronicleEventObservation } from "@/features/narrative-extraction/ir/observations/eventOccurrence";
import type { ChronicleV2TemporalGold } from "./chronicleV2Contract";
import {
  CHRONICLE_V2_TEMPORAL_VERSION,
  buildChronicleV2TemporalRawRows,
  evaluateChronicleV2Temporal,
  normalizeChronicleV2TemporalRows,
  remapChronicleV2TemporalGoldDocumentIds,
  validateChronicleV2EvidenceDocumentBindings,
  validateChronicleV2SourceDocumentBindings,
  type ChronicleV2TemporalEventAssignment,
  type ChronicleV2TemporalEvidence,
  type ChronicleV2TemporalRawRow,
} from "./chronicleV2Temporal";

const TEMPORAL_GOLD: ChronicleV2TemporalGold = {
  coverage: "targeted",
  relations: [
    {
      id: "night-half-chain-break",
      targetClaimId: "chain-break",
      relation: "occurs-at",
      expression: "夜半",
      requiredRegion: {
        documentId: "scene-north-gate",
        start: 0,
        end: 2,
      },
    },
    {
      id: "night-half-gate-fall",
      targetClaimId: "gate-fall",
      relation: "occurs-at",
      expression: "夜半",
      requiredRegion: {
        documentId: "scene-north-gate",
        start: 0,
        end: 2,
      },
    },
  ],
  unscoredClaimIds: ["guards-ring-bell", "guards-evacuate-passersby"],
};

const EXACT_ASSIGNMENTS: readonly ChronicleV2TemporalEventAssignment[] = [
  { actualRef: "actual-chain", goldRef: "chain-break", status: "match" },
  { actualRef: "actual-gate", goldRef: "gate-fall", status: "match" },
];

function rawRow(
  actualRef: string,
  expressions: readonly string[],
): ChronicleV2TemporalRawRow {
  return {
    actualRef,
    expressions,
    evidenceRefs: [`citation-${actualRef}`],
  };
}

function evidence(
  actualRef: string,
  ranges: readonly ChronicleV2TemporalEvidence["ranges"][number][],
  valid = true,
): ChronicleV2TemporalEvidence {
  return { actualRef, valid, ranges };
}

const SUPPORTED_RANGES = [
  { documentId: "scene-north-gate", start: 0, end: 2 },
] as const;

const SOURCE_DOCUMENTS = [
  { id: "scene-north-gate" },
  { id: "scene-south-gate" },
] as const;

const SOURCE_DOCUMENT_BINDINGS = [
  {
    contractDocumentId: "scene-north-gate",
    preparedDocumentId: "prepared-doc-001",
    sourceRef: "source-view-001",
    evidenceSourceRefs: ["source-view-001", "citation-north-a"],
  },
  {
    contractDocumentId: "scene-south-gate",
    preparedDocumentId: "prepared-doc-002",
    sourceRef: "source-view-002",
    evidenceSourceRefs: ["source-view-002", "citation-south-a"],
  },
] as const;

function evaluate(
  rawRows: readonly ChronicleV2TemporalRawRow[],
  assignments: readonly ChronicleV2TemporalEventAssignment[] = EXACT_ASSIGNMENTS,
  evidenceByActual: readonly ChronicleV2TemporalEvidence[] = rawRows.map(
    (row) => evidence(row.actualRef, SUPPORTED_RANGES),
  ),
) {
  return evaluateChronicleV2Temporal({
    temporalGold: TEMPORAL_GOLD,
    rawRows,
    exactEventAssignments: assignments,
    evidenceByActual,
  });
}

describe("Chronicle v2 temporal projection", () => {
  it("requires and canonicalizes an explicit source-to-prepared binding", () => {
    const canonical = validateChronicleV2SourceDocumentBindings(
      [...SOURCE_DOCUMENT_BINDINGS].reverse(),
      SOURCE_DOCUMENTS,
    );

    expect(canonical).toEqual([
      {
        ...SOURCE_DOCUMENT_BINDINGS[0],
        evidenceSourceRefs: ["citation-north-a", "source-view-001"],
      },
      {
        ...SOURCE_DOCUMENT_BINDINGS[1],
        evidenceSourceRefs: ["citation-south-a", "source-view-002"],
      },
    ]);
    expect(() =>
      validateChronicleV2SourceDocumentBindings(
        [SOURCE_DOCUMENT_BINDINGS[0]],
        SOURCE_DOCUMENTS,
      ),
    ).toThrow(/missing contract document/);
    expect(() =>
      validateChronicleV2SourceDocumentBindings(
        [
          SOURCE_DOCUMENT_BINDINGS[0],
          {
            ...SOURCE_DOCUMENT_BINDINGS[1],
            preparedDocumentId: SOURCE_DOCUMENT_BINDINGS[0].preparedDocumentId,
          },
        ],
        SOURCE_DOCUMENTS,
      ),
    ).toThrow(/repeats prepared document/);
  });

  it.each([
    {
      name: "duplicate contract document ID",
      bindings: [
        SOURCE_DOCUMENT_BINDINGS[0],
        {
          ...SOURCE_DOCUMENT_BINDINGS[1],
          contractDocumentId: SOURCE_DOCUMENT_BINDINGS[0].contractDocumentId,
          sourceRef: "source-view-003",
          evidenceSourceRefs: ["source-view-003", "citation-south-b"],
        },
      ],
    },
    {
      name: "duplicate Source View ref",
      bindings: [
        SOURCE_DOCUMENT_BINDINGS[0],
        {
          ...SOURCE_DOCUMENT_BINDINGS[1],
          sourceRef: SOURCE_DOCUMENT_BINDINGS[0].sourceRef,
          evidenceSourceRefs: [
            SOURCE_DOCUMENT_BINDINGS[0].sourceRef,
            "citation-south-b",
          ],
        },
      ],
    },
    {
      name: "duplicate evidence ref within one binding",
      bindings: [
        {
          ...SOURCE_DOCUMENT_BINDINGS[0],
          evidenceSourceRefs: [
            SOURCE_DOCUMENT_BINDINGS[0].sourceRef,
            "citation-north-a",
            "citation-north-a",
          ],
        },
        SOURCE_DOCUMENT_BINDINGS[1],
      ],
    },
    {
      name: "duplicate evidence ref across bindings",
      bindings: [
        SOURCE_DOCUMENT_BINDINGS[0],
        {
          ...SOURCE_DOCUMENT_BINDINGS[1],
          sourceRef: "source-view-003",
          evidenceSourceRefs: [
            "source-view-003",
            SOURCE_DOCUMENT_BINDINGS[0].evidenceSourceRefs[1],
          ],
        },
      ],
    },
  ])("rejects $name", ({ bindings }) => {
    expect(() =>
      validateChronicleV2SourceDocumentBindings(bindings, SOURCE_DOCUMENTS),
    ).toThrow();
  });

  it("remaps temporal Gold through the explicit binding without ID fallback", () => {
    const remapped = remapChronicleV2TemporalGoldDocumentIds(
      TEMPORAL_GOLD,
      SOURCE_DOCUMENT_BINDINGS,
      SOURCE_DOCUMENTS,
    );

    expect(remapped.relations[0]?.requiredRegion.documentId).toBe(
      "prepared-doc-001",
    );
    expect(remapped.relations[1]?.requiredRegion.documentId).toBe(
      "prepared-doc-001",
    );
    expect(() =>
      remapChronicleV2TemporalGoldDocumentIds(
        TEMPORAL_GOLD,
        SOURCE_DOCUMENT_BINDINGS.map((binding) => ({
          ...binding,
          contractDocumentId:
            binding.contractDocumentId === "scene-north-gate"
              ? "unknown-contract-document"
              : binding.contractDocumentId,
        })),
        SOURCE_DOCUMENTS,
      ),
    ).toThrow(/unknown contract document/);
  });

  it("rejects an evidence range whose prepared document disagrees with its source ref", () => {
    expect(() =>
      validateChronicleV2EvidenceDocumentBindings(
        [
          {
            sourceRef: "citation-north-a",
            documentId: "prepared-doc-001",
          },
          {
            sourceRef: "source-view-001",
            documentId: "prepared-doc-001",
          },
        ],
        SOURCE_DOCUMENT_BINDINGS,
      ),
    ).not.toThrow();
    expect(() =>
      validateChronicleV2EvidenceDocumentBindings(
        [
          {
            sourceRef: "citation-north-a",
            documentId: "prepared-doc-002",
          },
        ],
        SOURCE_DOCUMENT_BINDINGS,
      ),
    ).toThrow(/document binding disagrees/);
  });

  it("builds raw rows from materialized production observations", () => {
    const observation = {
      localId: "eval-window-001:obs-001",
      evidence: [
        {
          sourceRef: "citation-a",
          quote: "夜半、北門の鎖が切れた。",
        },
      ],
      assertion: {
        attribution: "narrator",
        narrativeFrame: "story-world",
      },
      payload: {
        predicate: "鎖が切れた",
        actuality: "actual",
        participants: [{ surface: "north-gate-chain", role: "theme" }],
        temporalExpressions: ["夜半"],
        durationKind: "instant",
      },
    } satisfies RawChronicleEventObservation;

    expect(buildChronicleV2TemporalRawRows([observation])).toEqual([
      {
        actualRef: "eval-window-001:obs-001",
        expressions: ["夜半"],
        evidenceRefs: ["citation-a"],
      },
    ]);
  });

  it("normalizes only the finite symbolic vocabulary and preserves unknowns", () => {
    const normalized = normalizeChronicleV2TemporalRows([
      rawRow("actual-chain", ["夜半", "朝", "2026年9月", "見知らぬ時間"]),
      rawRow("actual-empty", []),
    ]);

    expect(normalized).toEqual([
      {
        actualRef: "actual-chain",
        expressions: [
          { status: "known", value: "夜半" },
          { status: "known", value: "朝" },
          {
            status: "unknown",
            reason: "temporal-expression-out-of-vocabulary",
          },
          {
            status: "unknown",
            reason: "temporal-expression-out-of-vocabulary",
          },
        ],
        evidenceRefs: ["citation-actual-chain"],
      },
      {
        actualRef: "actual-empty",
        expressions: [],
        evidenceRefs: ["citation-actual-empty"],
      },
    ]);
  });

  it("matches both targeted relations using the same verified night-half range", () => {
    const evaluation = evaluate([
      rawRow("actual-chain", ["夜半"]),
      rawRow("actual-gate", ["夜半"]),
    ]);

    expect(evaluation.version).toBe(CHRONICLE_V2_TEMPORAL_VERSION);
    expect(evaluation.relationRows).toEqual([
      expect.objectContaining({
        relationId: "night-half-chain-break",
        actualRef: "actual-chain",
        metadataStatus: "known",
        result: "matched",
        evidenceSupported: true,
      }),
      expect.objectContaining({
        relationId: "night-half-gate-fall",
        actualRef: "actual-gate",
        metadataStatus: "known",
        result: "matched",
        evidenceSupported: true,
      }),
    ]);
    expect(evaluation).toMatchObject({
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
  });

  it("marks known morning-only metadata missing without creating a temporal FP", () => {
    const evaluation = evaluate([
      rawRow("actual-chain", ["朝"]),
      rawRow("actual-gate", ["朝"]),
    ]);

    expect(evaluation.relationRows).toEqual([
      expect.objectContaining({
        metadataStatus: "missing",
        result: "missing",
        evidenceSupported: true,
      }),
      expect.objectContaining({
        metadataStatus: "missing",
        result: "missing",
        evidenceSupported: true,
      }),
    ]);
    expect(evaluation).toMatchObject({
      requiredRelationCount: 2,
      matchedCount: 0,
      missingCount: 2,
      invalidEvidenceCount: 0,
      unobservableCount: 0,
      status: "FAIL",
      passed: false,
    });
  });

  it("keeps unknown-only metadata undetermined rather than treating it as missing", () => {
    const evaluation = evaluate([
      rawRow("actual-chain", ["見知らぬ時間"]),
      rawRow("actual-gate", ["見知らぬ時間"]),
    ]);

    expect(evaluation.relationRows).toEqual([
      expect.objectContaining({
        metadataStatus: "unknown",
        result: "unobservable",
        reason: "temporal-expression-unknown",
      }),
      expect.objectContaining({
        metadataStatus: "unknown",
        result: "unobservable",
        reason: "temporal-expression-unknown",
      }),
    ]);
    expect(evaluation).toMatchObject({
      matchedCount: 0,
      missingCount: 0,
      invalidEvidenceCount: 0,
      unobservableCount: 2,
      blockedByEventIdentityCount: 0,
      judgedCount: 0,
      status: "UNDETERMINED",
      passed: false,
    });
  });

  it.each([
    {
      name: "known morning plus unknown",
      chainExpressions: ["朝", "見知らぬ時間"],
      gateExpressions: ["夜半", "見知らぬ時間"],
      status: "UNDETERMINED",
      missingCount: 0,
      unobservableCount: 1,
    },
    {
      name: "one missing plus one unknown",
      chainExpressions: [],
      gateExpressions: ["見知らぬ時間"],
      status: "FAIL",
      missingCount: 1,
      unobservableCount: 1,
    },
    {
      name: "invalid evidence plus one unknown",
      chainExpressions: ["見知らぬ時間"],
      gateExpressions: ["夜半"],
      status: "FAIL",
      missingCount: 0,
      unobservableCount: 1,
    },
  ])(
    "keeps combined temporal failure and uncertainty precedence for $name",
    ({
      chainExpressions,
      gateExpressions,
      status,
      missingCount,
      unobservableCount,
      name,
    }) => {
      const evaluation = evaluate(
        name === "invalid evidence plus one unknown"
          ? [
              rawRow("actual-chain", ["夜半"]),
              rawRow("actual-gate", ["見知らぬ時間"]),
            ]
          : [
              rawRow("actual-chain", chainExpressions),
              rawRow("actual-gate", gateExpressions),
            ],
        EXACT_ASSIGNMENTS,
        name === "invalid evidence plus one unknown"
          ? [
              evidence("actual-chain", SUPPORTED_RANGES, false),
              evidence("actual-gate", SUPPORTED_RANGES),
            ]
          : undefined,
      );
      expect(evaluation).toMatchObject({
        status,
        missingCount,
        unobservableCount,
        passed: false,
      });
    },
  );

  it("matches night-half when non-target metadata is added to the same actual", () => {
    const evaluation = evaluate([
      rawRow("actual-chain", ["朝", "夜半", "見知らぬ時間"]),
      rawRow("actual-gate", ["夜半", "2026年9月6日"]),
    ]);

    expect(evaluation).toMatchObject({
      matchedCount: 2,
      missingCount: 0,
      invalidEvidenceCount: 0,
      unobservableCount: 0,
      status: "PASS",
      passed: true,
    });
  });

  it("fails a supported target when its own verified citation does not cover [0,2)", () => {
    const evaluation = evaluate(
      [rawRow("actual-chain", ["夜半"]), rawRow("actual-gate", ["夜半"])],
      EXACT_ASSIGNMENTS,
      [
        evidence("actual-chain", [
          { documentId: "scene-north-gate", start: 2, end: 10 },
        ]),
        evidence("actual-gate", SUPPORTED_RANGES, false),
      ],
    );

    expect(evaluation.relationRows).toEqual([
      expect.objectContaining({
        result: "invalid-evidence",
        reason: "temporal-evidence-invalid",
        evidenceSupported: false,
      }),
      expect.objectContaining({
        result: "invalid-evidence",
        reason: "temporal-evidence-invalid",
        evidenceSupported: false,
      }),
    ]);
    expect(evaluation).toMatchObject({
      matchedCount: 0,
      missingCount: 0,
      invalidEvidenceCount: 2,
      unobservableCount: 0,
      status: "FAIL",
      passed: false,
    });
  });

  it("requires each actual's own citation to cover the temporal span", () => {
    const evaluation = evaluate(
      [rawRow("actual-chain", ["夜半"]), rawRow("actual-gate", ["夜半"])],
      EXACT_ASSIGNMENTS,
      [
        evidence("actual-chain", [
          { documentId: "scene-north-gate", start: 0, end: 1 },
          { documentId: "scene-north-gate", start: 2, end: 10 },
        ]),
        evidence("actual-gate", [
          { documentId: "scene-north-gate", start: 2, end: 10 },
        ]),
      ],
    );

    expect(evaluation.invalidEvidenceCount).toBe(2);
    expect(evaluation.status).toBe("FAIL");
  });

  it("allows adjacent ranges from one actual to form a complete temporal cover", () => {
    const evaluation = evaluate(
      [rawRow("actual-chain", ["夜半"]), rawRow("actual-gate", ["夜半"])],
      EXACT_ASSIGNMENTS,
      [
        evidence("actual-chain", [
          { documentId: "scene-north-gate", start: 0, end: 1 },
          { documentId: "scene-north-gate", start: 1, end: 2 },
        ]),
        evidence("actual-gate", SUPPORTED_RANGES),
      ],
    );

    expect(evaluation).toMatchObject({
      matchedCount: 2,
      invalidEvidenceCount: 0,
      status: "PASS",
      passed: true,
    });
  });

  it("does not require disjoint citations when both actuals cite the same verified span", () => {
    const shared = evidence("actual-chain", SUPPORTED_RANGES);
    const evaluation = evaluate(
      [rawRow("actual-chain", ["夜半"]), rawRow("actual-gate", ["夜半"])],
      EXACT_ASSIGNMENTS,
      [shared, { ...shared, actualRef: "actual-gate" }],
    );

    expect(evaluation).toMatchObject({
      matchedCount: 2,
      invalidEvidenceCount: 0,
      status: "PASS",
      passed: true,
    });
  });

  it("fails when the night-half span is absent even if a wider window could expose it", () => {
    const evaluation = evaluate(
      [rawRow("actual-chain", ["夜半"]), rawRow("actual-gate", ["夜半"])],
      EXACT_ASSIGNMENTS,
      [
        evidence("actual-chain", [
          { documentId: "scene-north-gate", start: 2, end: 20 },
        ]),
        evidence("actual-gate", [
          { documentId: "scene-north-gate", start: 2, end: 20 },
        ]),
      ],
    );

    expect(evaluation.invalidEvidenceCount).toBe(2);
    expect(evaluation.status).toBe("FAIL");
  });

  it("blocks temporal scoring when event identity is unavailable even with matching time and evidence", () => {
    const evaluation = evaluate(
      [rawRow("actual-chain", ["夜半"]), rawRow("actual-gate", ["夜半"])],
      [
        {
          actualRef: "actual-chain",
          goldRef: null,
          status: "unobservable",
        },
        {
          actualRef: "actual-gate",
          goldRef: null,
          status: "unobservable",
        },
      ],
    );

    expect(evaluation.relationRows).toEqual([
      expect.objectContaining({
        actualRef: null,
        result: "unobservable",
        reason: "event-identity-unavailable",
        evidenceSupported: false,
      }),
      expect.objectContaining({
        actualRef: null,
        result: "unobservable",
        reason: "event-identity-unavailable",
        evidenceSupported: false,
      }),
    ]);
    expect(evaluation).toMatchObject({
      matchedCount: 0,
      missingCount: 0,
      invalidEvidenceCount: 0,
      unobservableCount: 2,
      blockedByEventIdentityCount: 2,
      judgedCount: 0,
      denominator: 2,
      status: "UNDETERMINED",
      passed: false,
    });
  });

  it("treats explicit empty metadata as missing and keeps excluded claims unscored", () => {
    const evaluation = evaluate([
      rawRow("actual-chain", []),
      rawRow("actual-gate", []),
      rawRow("actual-ring", ["朝"]),
      rawRow("actual-evacuation", ["見知らぬ時間"]),
    ]);

    expect(evaluation).toMatchObject({
      requiredRelationCount: 2,
      matchedCount: 0,
      missingCount: 2,
      invalidEvidenceCount: 0,
      unobservableCount: 0,
      blockedByEventIdentityCount: 0,
      unscoredGoldCount: 2,
      judgedCount: 2,
      denominator: 2,
      status: "FAIL",
      passed: false,
    });
  });

  it.each([
    { expressions: [] },
    { expressions: ["朝"] },
    { expressions: ["夜半"] },
    { expressions: ["見知らぬ時間"] },
  ])(
    "does not score later actual metadata when the later expression is %j",
    ({ expressions: laterExpressions }) => {
      const evaluation = evaluate([
        rawRow("actual-chain", ["夜半"]),
        rawRow("actual-gate", ["夜半"]),
        rawRow("actual-ring", laterExpressions),
        rawRow("actual-evacuation", laterExpressions),
      ]);

      expect(evaluation).toMatchObject({
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
      expect(evaluation.relationRows).toHaveLength(2);
    },
  );
});
