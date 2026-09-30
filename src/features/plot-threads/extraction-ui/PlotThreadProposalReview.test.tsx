// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { PlannedPlotThreadProposal } from "@/features/plot-threads/extraction/proposalPlanner";
import { PlotThreadProposalReview } from "./PlotThreadProposalReview";

function proposal(
  id: `plot-thread:${string}`,
  name: string,
): PlannedPlotThreadProposal {
  return {
    hypothesisId: id,
    blocked: false,
    threadProposal: {
      proposalId: `${id}-proposal`,
      kind: "plot.thread.bind",
      target: { kind: "plot-thread", logicalRef: id },
      payload: {
        threadHypothesisId: id,
        binding: { kind: "create-new" },
        name,
        description: { kind: "leave" },
        prominence: "minor",
        core: {
          kind: "open-question",
          question: "誰が裏切ったのか",
          relatedEntityIds: [],
          answerCondition: null,
        },
      },
      dependencies: [],
    },
    markerProposals: [],
  };
}

describe("PlotThreadProposalReview", () => {
  it("shows an empty state when there are no proposals", () => {
    const { getByTestId } = render(<PlotThreadProposalReview proposals={[]} />);
    expect(getByTestId("plot-thread-proposal-review-empty")).toBeTruthy();
  });

  it("renders one card per proposal", () => {
    const { getByTestId, getByText } = render(
      <PlotThreadProposalReview
        proposals={[
          proposal("plot-thread:a", "陰謀"),
          proposal("plot-thread:b", "追跡"),
        ]}
      />,
    );
    expect(getByTestId("plot-thread-proposal-review-list")).toBeTruthy();
    expect(getByText("陰謀")).toBeTruthy();
    expect(getByText("追跡")).toBeTruthy();
  });
});
