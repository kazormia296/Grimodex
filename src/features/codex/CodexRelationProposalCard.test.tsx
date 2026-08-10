// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createCodexRelationProposalFromHypothesis } from "@/features/narrative-extraction/proposals/createCodexRelationProposal";
import type { CodexRelationHypothesis } from "@/features/narrative-extraction/ir/inferences/codexRelationHypothesis";
import { CodexRelationProposalCard } from "./CodexRelationProposalCard";
import { CodexRelationProposalReview } from "./CodexRelationProposalReview";
import type { CodexRelationReviewProposal } from "./codexStructureExtractionStore";

const hypothesis: CodexRelationHypothesis = {
  hypothesisId: "h-rel-1",
  observationRefs: ["obs-1"],
  subjectResolved: true,
  objectResolved: true,
  payload: {
    subjectEntityId: "ne-1",
    objectEntityId: "ne-2",
    predicate: "師匠",
    family: "social",
    validity: "current",
    directionality: "directed",
    forwardLabelSuggestion: "師匠",
    inverseLabelSuggestion: "弟子",
  },
  epistemic: {
    polarity: "affirmed",
    commitment: "story-fact",
    support: "direct",
    narrativeFrame: "primary",
  },
};

function relationReview(): CodexRelationReviewProposal {
  const proposal = createCodexRelationProposalFromHypothesis({
    hypothesis,
    gate: { kind: "proposal", validity: "current" },
    logicalRef: "rel-1",
    relation: {
      relationType: "師匠",
      directionality: "directed",
      forwardLabel: "師匠",
      inverseLabel: "弟子",
    },
    dependencyProposalIds: [],
    createId: () => "rel-proposal-1",
  });
  if (!proposal) throw new Error("expected relation proposal");
  return {
    proposalId: proposal.proposalId,
    revisionId: "rev-rel-1",
    proposalKey: "key-rel-1",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: "ライカ → 師匠 → ベルカ",
    proposal,
    evidence: [
      {
        anchorId: "ra1",
        quote: "ライカはベルカの師匠として振る舞った",
        documentRef: "R000001",
        method: "exact",
      },
    ],
    subjectLabel: "ライカ",
    objectLabel: "ベルカ",
  };
}

describe("CodexRelationProposalCard", () => {
  it("renders subject/label/object and supports approve without bulk control", () => {
    const decisions: string[] = [];
    render(
      <CodexRelationProposalCard
        proposal={relationReview()}
        selected
        onDecide={(status) => decisions.push(status)}
      />,
    );
    expect(
      screen.getByTestId("codex-relation-proposal-card-rel-proposal-1"),
    ).toBeInTheDocument();
    expect(screen.getByText("ライカ → 師匠 → ベルカ")).toBeInTheDocument();
    expect(screen.getByText(/directed/)).toBeInTheDocument();
    fireEvent.click(
      screen.getByTestId("codex-relation-approve-rel-proposal-1"),
    );
    expect(decisions).toEqual(["approved"]);
  });
});

describe("CodexRelationProposalReview", () => {
  it("shows bulk-approve disabled marker and editor fields", () => {
    render(
      <CodexRelationProposalReview
        boundToStore={false}
        proposals={[relationReview()]}
        selectedProposalId="rel-proposal-1"
      />,
    );
    expect(
      screen.getByTestId("codex-relation-proposal-review"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("codex-relation-bulk-approve-disabled"),
    ).toBeInTheDocument();
    expect(screen.getByText("一括承認なし")).toBeInTheDocument();
  });
});
