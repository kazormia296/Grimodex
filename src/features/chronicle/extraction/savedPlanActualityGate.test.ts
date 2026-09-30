import { describe, expect, it } from "vitest";
import { assertSavedPlanActualitySupport } from "./savedPlanActualityGate";

function supportedPlan(): Parameters<
  typeof assertSavedPlanActualitySupport
>[0] {
  const proposal = {
    eventId: "event",
    title: "Event",
    note: null,
    actuality: "actual" as const,
    significance: "major" as const,
    evidenceAnchorIds: ["anchor"] as [string],
    evidenceDocumentRefs: ["document"] as [string],
    disclosure: { secret: true, revealDocumentRef: "document" },
    unresolvedMetadata: {
      participantSurfaces: [],
      locationSurface: null,
      temporalExpressions: [],
    },
  };
  return {
    proposalPayloads: [proposal],
    planned: [{ hypothesisId: "hyp", proposal }],
    hypotheses: [
      {
        hypothesisId: "hyp",
        clusterRef: "cluster",
        observationRefs: ["obs"],
        titleSuggestion: "Event",
        summary: "Event",
        actuality: "actual",
        significance: "major",
      },
    ],
    observations: [
      {
        localId: "obs",
        evidence: [{ sourceRef: "S1", quote: "Event" }],
        assertion: { attribution: "narrator", narrativeFrame: "story-world" },
        payload: {
          predicate: "Event",
          actuality: "actual",
          participants: [],
          temporalExpressions: [],
          durationKind: "unknown",
        },
      },
    ],
    currentProposals: [
      { ...proposal, title: "Human revision", note: "Edited" },
    ],
  };
}

describe("assertSavedPlanActualitySupport", () => {
  it.each([false, true])(
    "validates already-satisfied support with coexistence=%s before returning saved results",
    (withProposal) => {
      const base = supportedPlan();
      const actualInput = {
        ...base,
        alreadySatisfied: [{ hypothesisId: "hyp-satisfied" }],
        proposalPayloads: withProposal ? base.proposalPayloads : [],
        planned: withProposal ? base.planned : [],
        currentProposals: withProposal ? base.currentProposals : [],
        hypotheses: [
          ...base.hypotheses!,
          {
            ...base.hypotheses![0]!,
            hypothesisId: "hyp-satisfied",
            observationRefs: ["obs-satisfied"],
          },
        ],
        observations: [
          ...base.observations!,
          { ...base.observations![0]!, localId: "obs-satisfied" },
        ],
      };
      expect(() => assertSavedPlanActualitySupport(actualInput)).not.toThrow();
      for (const actuality of ["rumored", "planned", "dreamed"] as const) {
        const invalidInput = {
          ...actualInput,
          observations: actualInput.observations.map((observation) =>
            observation.localId === "obs-satisfied"
              ? {
                  ...observation,
                  payload: { ...observation.payload, actuality },
                }
              : observation,
          ),
        };
        const before = structuredClone(invalidInput);
        expect(() => assertSavedPlanActualitySupport(invalidInput)).toThrow(
          "NEX_CHRONICLE_REANALYSIS_REQUIRED",
        );
        expect(invalidInput).toEqual(before);
      }
      expect(() =>
        assertSavedPlanActualitySupport({
          ...actualInput,
          alreadySatisfied: [{ hypothesisId: "missing" }],
        }),
      ).toThrow("NEX_CHRONICLE_REANALYSIS_REQUIRED");
    },
  );

  it("accepts supported human title revisions without modifying any saved row", () => {
    const input = supportedPlan();
    const before = structuredClone(input);
    expect(() => assertSavedPlanActualitySupport(input)).not.toThrow();
    expect(input).toEqual(before);
  });

  it.each(["rumored", "planned", "dreamed"] as const)(
    "requires reanalysis for saved %s promotion",
    (actuality) => {
      const input = supportedPlan();
      const observations = input.observations!.map((row) => ({
        ...row,
        payload: { ...row.payload, actuality },
      }));
      expect(() =>
        assertSavedPlanActualitySupport({ ...input, observations }),
      ).toThrow("NEX_CHRONICLE_REANALYSIS_REQUIRED");
    },
  );

  it("requires reanalysis when old saved proposals have no support artifacts", () => {
    expect(() =>
      assertSavedPlanActualitySupport({
        currentProposals: supportedPlan().currentProposals,
      }),
    ).toThrow("NEX_CHRONICLE_REANALYSIS_REQUIRED");
  });

  it("uses the same explicit error for malformed saved artifact shapes", () => {
    const input = supportedPlan();
    for (const malformed of [
      { ...input, observations: {} },
      {
        ...input,
        hypotheses: [{ ...input.hypotheses![0], observationRefs: null }],
      },
      { ...input, observations: [{ localId: "obs" }] },
    ]) {
      expect(() =>
        assertSavedPlanActualitySupport(malformed as unknown as typeof input),
      ).toThrow("NEX_CHRONICLE_REANALYSIS_REQUIRED");
    }
  });

  it("requires reanalysis for duplicate hypothesis ids or mismatched terminal rosters", () => {
    const input = supportedPlan();
    for (const invalid of [
      { ...input, hypotheses: [...input.hypotheses!, ...input.hypotheses!] },
      { ...input, planned: [], currentProposals: [] },
      { ...input, proposalPayloads: [] },
      {
        ...input,
        currentProposals: [
          ...input.currentProposals,
          ...input.currentProposals,
        ],
      },
    ]) {
      expect(() => assertSavedPlanActualitySupport(invalid)).toThrow(
        "NEX_CHRONICLE_REANALYSIS_REQUIRED",
      );
    }
  });
});
