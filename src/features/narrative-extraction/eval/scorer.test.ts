import { describe, expect, it } from "vitest";
import { scoreNarrativeEvalCase } from "./scorer";
import type { NarrativeEvalCaseV1 } from "./types";

const REQUIRED_DIMENSIONS = {
  eventDetection: true,
  actuality: "actual",
  attribution: "narrator",
  narrativeFrame: "story-world",
  evidence: [{ documentId: "scene-001", quote: "鐘が三度鳴った" }],
  clustering: "bell-rang",
  significance: "minor",
  proposalGate: "propose",
};

function evalCase(): NarrativeEvalCaseV1 {
  return {
    schemaVersion: 1 as const,
    id: "chronicle.micro.rumor-vs-fact-001",
    scope: { slice: "chronicle", tier: "micro" },
    locale: "ja-JP",
    timezone: "Asia/Tokyo",
    frozenTime: "2026-08-10T00:00:00.000Z",
    coverage: {
      mode: "complete" as const,
      includedDocumentIds: ["scene-001"],
      omittedDocumentIds: [],
    },
    documents: [
      {
        id: "scene-001",
        title: "鐘楼",
        text: "鐘が三度鳴った。旅人は『王が死んだらしい』と噂した。",
      },
    ],
    expected: {
      observations: {
        required: [
          {
            id: "required-bell-rang",
            semanticKey: "bell-rang",
            dimensions: REQUIRED_DIMENSIONS,
          },
        ],
        forbidden: [
          {
            id: "forbidden-rumor-promoted-to-fact",
            semanticKey: "king-died-rumor",
            dimensions: { actuality: "actual" },
          },
        ],
      },
    },
    criticalViolationClasses: [
      {
        id: "rumor-as-actual",
        description: "A reported rumor must not become story-world fact.",
        match: {
          semanticKey: "king-died-rumor",
          dimension: "actuality",
          value: "actual",
        },
      },
    ],
  };
}

function observed(value: unknown) {
  return { status: "observed" as const, value };
}

function unobservable(reason: string) {
  return { status: "unobservable" as const, reason };
}

function exactObservation() {
  return {
    id: "actual-bell-rang",
    semanticKey: "bell-rang",
    dimensions: {
      eventDetection: observed(true),
      actuality: observed("actual"),
      attribution: observed("narrator"),
      narrativeFrame: observed("story-world"),
      evidence: observed([
        { documentId: "scene-001", quote: "鐘が三度鳴った" },
      ]),
      clustering: observed("bell-rang"),
      significance: observed("minor"),
      proposalGate: observed("propose"),
    },
  };
}

describe("scoreNarrativeEvalCase", () => {
  it("reports a true positive for every exactly matched semantic dimension", () => {
    const report = scoreNarrativeEvalCase(evalCase(), {
      observations: [exactObservation()],
    });

    expect(report.passed).toBe(true);
    expect(report.criticalViolations).toEqual([]);
    expect(report.dimensions).toEqual({
      eventDetection: {
        truePositive: 1,
        falsePositive: 0,
        falseNegative: 0,
        unobservable: 0,
      },
      actuality: {
        truePositive: 1,
        falsePositive: 0,
        falseNegative: 0,
        unobservable: 0,
      },
      attribution: {
        truePositive: 1,
        falsePositive: 0,
        falseNegative: 0,
        unobservable: 0,
      },
      narrativeFrame: {
        truePositive: 1,
        falsePositive: 0,
        falseNegative: 0,
        unobservable: 0,
      },
      evidence: {
        truePositive: 1,
        falsePositive: 0,
        falseNegative: 0,
        unobservable: 0,
      },
      clustering: {
        truePositive: 1,
        falsePositive: 0,
        falseNegative: 0,
        unobservable: 0,
      },
      significance: {
        truePositive: 1,
        falsePositive: 0,
        falseNegative: 0,
        unobservable: 0,
      },
      proposalGate: {
        truePositive: 1,
        falsePositive: 0,
        falseNegative: 0,
        unobservable: 0,
      },
    });
  });

  it("counts a wrong observed value as both FP and FN, and an unavailable value as FN only", () => {
    const actual = exactObservation();
    actual.dimensions.actuality = observed("attempted");
    actual.dimensions.attribution = unobservable(
      "provider output omitted attribution",
    ) as never;

    const report = scoreNarrativeEvalCase(evalCase(), {
      observations: [actual],
    });

    expect(report.passed).toBe(false);
    expect(report.dimensions.actuality).toEqual({
      truePositive: 0,
      falsePositive: 1,
      falseNegative: 1,
      unobservable: 0,
    });
    expect(report.dimensions.attribution).toEqual({
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 1,
      unobservable: 1,
    });
  });

  it("counts an unmatched extra observation as a false positive in each supplied dimension", () => {
    const extra = {
      id: "actual-extra-door-opened",
      semanticKey: "door-opened",
      dimensions: {
        eventDetection: observed(true),
        actuality: observed("actual"),
      },
    };

    const report = scoreNarrativeEvalCase(evalCase(), {
      observations: [exactObservation(), extra],
    });

    expect(report.passed).toBe(false);
    expect(report.dimensions.eventDetection.falsePositive).toBe(1);
    expect(report.dimensions.actuality.falsePositive).toBe(1);
    expect(report.dimensions.evidence.falsePositive).toBe(0);
  });

  it("fails the case when any declared critical violation class matches", () => {
    const rumorPromotedToFact = {
      id: "actual-rumor-promoted",
      semanticKey: "king-died-rumor",
      dimensions: {
        eventDetection: observed(true),
        actuality: observed("actual"),
      },
    };

    const report = scoreNarrativeEvalCase(evalCase(), {
      observations: [exactObservation(), rumorPromotedToFact],
    });

    expect(report.passed).toBe(false);
    expect(report.criticalViolations).toEqual([
      expect.objectContaining({
        classId: "rumor-as-actual",
        actualObservationId: "actual-rumor-promoted",
      }),
    ]);
  });

  it("represents legacy Chronicle fields as unobservable instead of awarding unsupported passes", () => {
    const legacyChronicleObservation = {
      id: "legacy-event-0",
      semanticKey: "bell-rang",
      dimensions: {
        eventDetection: observed(true),
        actuality: unobservable("legacy schema has no actuality field"),
        attribution: unobservable("legacy schema has no attribution field"),
        narrativeFrame: unobservable(
          "legacy schema has no narrative-frame field",
        ),
        evidence: unobservable(
          "legacy evidenceSceneIds do not contain an exact quote",
        ),
        clustering: unobservable("legacy schema has no cluster identity"),
        significance: unobservable("legacy schema has no significance field"),
        proposalGate: unobservable("legacy output bypasses Proposal review"),
      },
    };

    const report = scoreNarrativeEvalCase(evalCase(), {
      observations: [legacyChronicleObservation],
    });

    expect(report.passed).toBe(false);
    expect(report.dimensions.eventDetection.truePositive).toBe(1);
    expect(report.dimensions.actuality).toMatchObject({
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 1,
      unobservable: 1,
    });
    expect(report.dimensions.evidence).toMatchObject({
      truePositive: 0,
      falsePositive: 0,
      falseNegative: 1,
      unobservable: 1,
    });
    expect(report.unobservableDimensions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actualObservationId: "legacy-event-0",
          dimension: "actuality",
        }),
        expect.objectContaining({
          actualObservationId: "legacy-event-0",
          dimension: "evidence",
        }),
      ]),
    );
  });
});
