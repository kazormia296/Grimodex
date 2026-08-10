import { describe, expect, it } from "vitest";
import {
  evaluateRelationDomainGate,
  normalizeRelationSynthesis,
} from "./relationSynthesis";
import type { CodexRelationHypothesis } from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";

function hypothesis(
  overrides: {
    readonly hypothesisId?: string;
    readonly observationRefs?: readonly string[];
    readonly subjectResolved?: boolean;
    readonly objectResolved?: boolean;
    readonly payload?: Partial<CodexRelationHypothesis["payload"]>;
    readonly epistemic?: Partial<CodexRelationHypothesis["epistemic"]>;
  } = {},
): CodexRelationHypothesis {
  return {
    hypothesisId: overrides.hypothesisId ?? "h1",
    observationRefs: overrides.observationRefs ?? ["obs-1"],
    subjectResolved: overrides.subjectResolved ?? true,
    objectResolved: overrides.objectResolved ?? true,
    payload: {
      subjectEntityId: "e1",
      objectEntityId: "e2",
      predicate: "弟子",
      family: "social",
      validity: "current",
      directionality: "directed",
      forwardLabelSuggestion: "弟子",
      inverseLabelSuggestion: "師匠",
      ...overrides.payload,
    },
    epistemic: {
      polarity: "affirmed",
      commitment: "story-fact",
      support: "direct",
      narrativeFrame: "primary",
      ...overrides.epistemic,
    },
  };
}

describe("evaluateRelationDomainGate", () => {
  it("allows timeless/current affirmed story-facts as proposals", () => {
    expect(evaluateRelationDomainGate(hypothesis()).kind).toBe("proposal");
    expect(
      evaluateRelationDomainGate(
        hypothesis({ payload: { validity: "timeless" } }),
      ).kind,
    ).toBe("proposal");
  });

  it("marks historical/ended/rumor relations as report-only", () => {
    expect(
      evaluateRelationDomainGate(
        hypothesis({ payload: { validity: "historical" } }),
      ).kind,
    ).toBe("report-only");
    expect(
      evaluateRelationDomainGate(hypothesis({ payload: { validity: "ended" } }))
        .kind,
    ).toBe("report-only");
    expect(
      evaluateRelationDomainGate(
        hypothesis({ epistemic: { commitment: "rumor" } }),
      ).kind,
    ).toBe("report-only");
  });

  it("blocks self relations, unresolved ends, and ambiguous directionality", () => {
    expect(
      evaluateRelationDomainGate(
        hypothesis({
          payload: { subjectEntityId: "e1", objectEntityId: "e1" },
        }),
      ).kind,
    ).toBe("blocked");
    expect(
      evaluateRelationDomainGate(hypothesis({ subjectResolved: false })).kind,
    ).toBe("blocked");
    expect(
      evaluateRelationDomainGate(
        hypothesis({ payload: { directionality: "ambiguous" } }),
      ).kind,
    ).toBe("blocked");
  });

  it("does not save negated relations as proposals", () => {
    expect(
      evaluateRelationDomainGate(
        hypothesis({ epistemic: { polarity: "negated" } }),
      ).kind,
    ).toBe("report-only");
  });
});

describe("normalizeRelationSynthesis", () => {
  it("keeps only known observation refs and rejects wrong candidate refs", () => {
    const result = normalizeRelationSynthesis(
      {
        candidateRef: "c1",
        relations: [
          {
            observationRefs: ["obs-1", "ghost"],
            subjectEntityId: "e1",
            objectEntityId: "e2",
            predicate: "友人",
            family: "social",
            validity: "current",
            directionality: "symmetric",
            forwardLabelSuggestion: "友人",
            inverseLabelSuggestion: "友人",
            polarity: "affirmed",
            commitment: "story-fact",
            support: "direct",
            narrativeFrame: "primary",
          },
        ],
      },
      {
        candidateRef: "c1",
        allowedObservationRefs: new Set(["obs-1"]),
        resolvedEntityIds: new Set(["e1", "e2"]),
        createId: () => "hyp-1",
      },
    );
    expect(result).toHaveLength(1);
    expect(result[0]?.observationRefs).toEqual(["obs-1"]);
    expect(result[0]?.payload.directionality).toBe("symmetric");
  });
});
