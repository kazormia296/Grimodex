import { describe, expect, it } from "vitest";
import type { NarrativeEvalCaseV1 } from "@/features/narrative-extraction/eval/types";
import { lenientAlignmentCounts } from "./lenientAlignment";

const evalCase = {
  expected: {
    observations: {
      required: [
        {
          id: "r1",
          semanticKey: "gate",
          dimensions: {
            actuality: "planned",
            proposalGate: "suppress",
            significance: "major",
            evidence: [{ documentId: "doc", quote: "門を開ける" }],
          },
        },
      ],
      forbidden: [
        { id: "f1", semanticKey: "gate", dimensions: { actuality: "actual" } },
      ],
    },
  },
} as unknown as NarrativeEvalCaseV1;

const base = {
  evalCase,
  hypotheses: [
    { hypothesisId: "h1", significance: "major", observationRefs: ["o1"] },
  ],
  documentIdBySourceRef: new Map([["S1", "doc"]]),
};

describe("lenientAlignmentCounts", () => {
  it("quote が包含関係なら対応づけ、actuality・採否が Gold と一致すれば数える", () => {
    const counts = lenientAlignmentCounts({
      ...base,
      observations: [
        {
          localId: "o1",
          evidence: [{ sourceRef: "S1", quote: "彼は門を開ける。" }],
          payload: { actuality: "planned" },
        },
      ],
      proposedHypothesisIds: new Set(),
    });
    expect(counts).toEqual({
      requiredCovered: 1,
      actualityMatch: 1,
      significanceMatch: 1,
      proposalGateMatch: 1,
      forbiddenClaimed: 0,
    });
  });

  it("forbidden の actuality を主張し、提案に上げれば不一致・forbidden として数える", () => {
    const counts = lenientAlignmentCounts({
      ...base,
      observations: [
        {
          localId: "o1",
          evidence: [{ sourceRef: "S1", quote: "門を開ける" }],
          payload: { actuality: "actual" },
        },
      ],
      proposedHypothesisIds: new Set(["h1"]),
    });
    expect(counts).toEqual({
      requiredCovered: 1,
      actualityMatch: 0,
      significanceMatch: 1,
      proposalGateMatch: 0,
      forbiddenClaimed: 1,
    });
  });

  it("forbidden が proposalGate を定めるときは、提案の有無も一致して初めて主張とみなす", () => {
    const withGate = {
      ...base,
      evalCase: {
        expected: {
          observations: {
            required: evalCase.expected.observations.required,
            forbidden: [
              {
                id: "f2",
                semanticKey: "gate",
                dimensions: { proposalGate: "propose" },
              },
            ],
          },
        },
      } as unknown as NarrativeEvalCaseV1,
      observations: [
        {
          localId: "o1",
          evidence: [{ sourceRef: "S1", quote: "門を開ける" }],
          payload: { actuality: "planned" },
        },
      ],
    };
    expect(
      lenientAlignmentCounts({ ...withGate, proposedHypothesisIds: new Set() })
        .forbiddenClaimed,
    ).toBe(0);
    expect(
      lenientAlignmentCounts({
        ...withGate,
        proposedHypothesisIds: new Set(["h1"]),
      }).forbiddenClaimed,
    ).toBe(1);
  });

  it("別 document・空の quote・対応なしは数えない", () => {
    const counts = lenientAlignmentCounts({
      ...base,
      documentIdBySourceRef: new Map([["S1", "other"]]),
      observations: [
        {
          localId: "o1",
          evidence: [{ sourceRef: "S1", quote: "門を開ける" }],
          payload: { actuality: "actual" },
        },
      ],
      proposedHypothesisIds: new Set(),
    });
    expect(counts.requiredCovered).toBe(0);
    expect(counts.forbiddenClaimed).toBe(0);
  });
});
