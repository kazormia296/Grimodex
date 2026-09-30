import { describe, expect, it } from "vitest";
import type { PlotThreadHypothesisPayload } from "@/features/narrative-extraction/ir/inferences/plotThreadHypothesis";
import { planPlotThreadProposals } from "./proposalPlanner";

let seq = 0;
function createId(): string {
  seq += 1;
  return `id-${seq}`;
}

function hypothesis(
  overrides: Partial<PlotThreadHypothesisPayload> = {},
): PlotThreadHypothesisPayload {
  return {
    threadId: "plot-thread:cluster-1",
    core: {
      kind: "conflict",
      sides: [{ entityIds: ["E001"], position: "王位を守る" }],
      contestedProposition: "誰が王位を継ぐか",
      stakes: "王国の未来",
    },
    nameSuggestion: "王位継承の陰謀",
    descriptionSuggestion: "王位を巡る対立",
    prominence: "supporting",
    participantEntityIds: ["E001"],
    developmentInferenceIds: ["dev-1", "dev-2"],
    markerCandidates: [
      {
        documentRef: "doc:s1",
        developmentInferenceIds: ["dev-1"],
        primaryPhase: "introduce",
        secondaryPhase: null,
        noteSuggestion: null,
        roleSupport: [
          { reason: "first-reader-establishment", sourceIds: ["dev-1"] },
        ],
        evidenceAnchorIds: ["anchor-1"],
      },
      {
        documentRef: "doc:s2",
        developmentInferenceIds: ["dev-2"],
        primaryPhase: "develop",
        secondaryPhase: null,
        noteSuggestion: null,
        roleSupport: [{ reason: "incremental-progress", sourceIds: ["dev-2"] }],
        evidenceAnchorIds: ["anchor-2"],
      },
    ],
    lifecycle: "open",
    coverage: "complete",
    existingResolution: { status: "none" },
    scopeEntry: "introduced-in-scope",
    ...overrides,
  };
}

describe("planPlotThreadProposals", () => {
  it("creates a new thread + marker proposals when the minimum gate passes", () => {
    const planned = planPlotThreadProposals({
      hypotheses: [hypothesis()],
      createId,
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.blocked).toBe(false);
    expect(planned[0]?.threadProposal.payload.binding).toEqual({
      kind: "create-new",
    });
    expect(planned[0]?.threadProposal.payload.name).toBe("王位継承の陰謀");
    expect(planned[0]?.markerProposals).toHaveLength(2);
    expect(planned[0]?.markerProposals[0]?.payload.existing).toEqual({
      status: "absent",
    });
  });

  it("drops hypotheses from a single scene (minimum gate rejects)", () => {
    const single = hypothesis({
      markerCandidates: [hypothesis().markerCandidates[0]!],
      developmentInferenceIds: ["dev-1"],
    });
    const planned = planPlotThreadProposals({
      hypotheses: [single],
      createId,
    });
    expect(planned).toHaveLength(0);
  });

  it("binds to an existing thread and fills description only if empty", () => {
    const planned = planPlotThreadProposals({
      hypotheses: [
        hypothesis({
          existingResolution: {
            status: "resolved",
            ref: "PT0001",
            method: "core-and-marker-overlap",
          },
        }),
      ],
      createId,
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.blocked).toBe(false);
    expect(planned[0]?.threadProposal.payload.binding).toEqual({
      kind: "bind-existing",
      threadRef: "PT0001",
    });
    expect(planned[0]?.threadProposal.payload.description).toEqual({
      kind: "fill-if-empty",
      value: "王位を巡る対立",
    });
  });

  it("marks ambiguous existing resolution as blocked with candidate refs", () => {
    const planned = planPlotThreadProposals({
      hypotheses: [
        hypothesis({
          existingResolution: {
            status: "ambiguous",
            candidates: [
              { ref: "PT0001", score: 0.6, reasons: ["name-only"] },
              { ref: "PT0002", score: 0.4, reasons: ["name-only"] },
            ],
          },
        }),
      ],
      createId,
    });
    expect(planned).toHaveLength(1);
    expect(planned[0]?.blocked).toBe(true);
    expect(planned[0]?.threadProposal.payload.binding).toEqual({
      kind: "unresolved",
      candidateThreadRefs: ["PT0001", "PT0002"],
    });
    expect(planned[0]?.markerProposals).toHaveLength(0);
  });

  it("uses resolveExistingMarker to fill the marker existing status", () => {
    const planned = planPlotThreadProposals({
      hypotheses: [hypothesis()],
      createId,
      resolveExistingMarker: (_hypothesis, candidate) =>
        candidate.documentRef === "doc:s1"
          ? { status: "same", markerRef: "marker-1" }
          : { status: "absent" },
    });
    expect(planned[0]?.markerProposals[0]?.payload.existing).toEqual({
      status: "same",
      markerRef: "marker-1",
    });
    expect(planned[0]?.markerProposals[1]?.payload.existing).toEqual({
      status: "absent",
    });
  });
});
