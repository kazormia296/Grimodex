// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createNewBindCodexPhaseProposal } from "@/features/narrative-extraction/proposals/bindCodexPhaseProposal";
import { createSetCodexBaseDetailProposal } from "@/features/narrative-extraction/proposals/setCodexBaseDetailProposal";
import {
  buildCodexBaseDetailProposalSafetyFlags,
  buildCodexPhaseProposalSafetyFlags,
  type CodexBaseDetailReviewProposal,
  type CodexPhaseReviewProposal,
} from "../codexStructureExtractionStore";
import { EntityStateTimeline, groupStatePhaseTimeline } from "./EntityStateTimeline";
import { PhaseProposalCard } from "./PhaseProposalCard";

function phaseReview(): CodexPhaseReviewProposal {
  const proposal = createNewBindCodexPhaseProposal(
    {
      narrativeEntityId: "ne-1",
      anchorDocumentRef: "S0001",
      labelSuggestion: "負傷後",
      detailOverrides: [
        {
          definitionRef: "D0001",
          write: { kind: "set", value: { kind: "text", text: "右腕負傷" } },
        },
      ],
      binding: {
        kind: "create-new",
        phase: { label: "負傷後", anchorDocumentRef: "S0001" },
      },
    },
    { proposalId: "phase-1" },
  );
  return {
    proposalId: "phase-1",
    revisionId: "rev-1",
    proposalKey: "key-1",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: "負傷後",
    proposal,
    evidence: [
      {
        anchorId: "a1",
        quote: "右腕を負傷した",
        documentRef: "S0001",
        method: "exact",
      },
    ],
    safety: buildCodexPhaseProposalSafetyFlags({
      summaryOverrideKind: "leave",
      bindingKind: "create-new",
      hasConflict: false,
      bound: true,
      hasClearWrite: false,
    }),
    entityLabel: "ライカ",
    persistence: { kind: "proposal", reason: "major-durable" },
    valueDeltas: [
      {
        definitionRef: "D0001",
        facetKey: "injury.severe.arm",
        previousDisplay: "(empty)",
        nextDisplay: "右腕負傷",
        writeKind: "set",
      },
    ],
    existingPhaseCandidates: [],
  };
}

function baseReview(): CodexBaseDetailReviewProposal {
  const proposal = createSetCodexBaseDetailProposal({
    narrativeEntityId: "ne-1",
    definitionRef: "D0001",
    facetKey: "role.current",
    value: { kind: "text", text: "騎士" },
    temporalEligibility: "timeless",
    createId: () => "base-1",
  });
  if (!proposal) throw new Error("expected base");
  return {
    proposalId: "base-1",
    revisionId: "rev-b",
    proposalKey: "bk",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: "ライカ · role.current",
    proposal,
    evidence: [],
    safety: buildCodexBaseDetailProposalSafetyFlags({
      temporalEligibility: "timeless",
      existingValue: null,
      evidenceMethods: ["exact"],
      bound: true,
      valueKind: "text",
    }),
    entityLabel: "ライカ",
    facetKey: "role.current",
    existingValue: null,
  };
}

describe("PhaseProposalCard", () => {
  it("renders label, anchor, value delta, and supports approve", () => {
    const decisions: string[] = [];
    render(
      <PhaseProposalCard
        proposal={phaseReview()}
        selected
        onDecide={(status) => decisions.push(status)}
      />,
    );
    expect(screen.getByTestId("phase-proposal-card-phase-1")).toBeInTheDocument();
    expect(screen.getByText("負傷後")).toBeInTheDocument();
    expect(screen.getByText(/anchor S0001/)).toBeInTheDocument();
    expect(screen.getByText(/右腕負傷/)).toBeInTheDocument();
    expect(screen.getByTestId("persistence-evidence")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("phase-approve-phase-1"));
    expect(decisions).toEqual(["approved"]);
  });
});

describe("EntityStateTimeline", () => {
  it("renders Base + Phase rows per entity", () => {
    const entities = groupStatePhaseTimeline([baseReview()], [phaseReview()]);
    render(
      <EntityStateTimeline
        entities={entities}
        selectedProposalId="phase-1"
      />,
    );
    expect(screen.getByTestId("entity-state-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("entity-state-timeline-ne-1")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-base-base-1")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-phase-phase-1")).toBeInTheDocument();
    expect(screen.getByText(/Base/)).toBeInTheDocument();
    expect(screen.getByText(/Phase/)).toBeInTheDocument();
  });
});
