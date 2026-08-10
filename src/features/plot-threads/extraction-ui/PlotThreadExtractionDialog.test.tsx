// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { PlannedPlotThreadProposal } from "@/features/plot-threads/extraction/proposalPlanner";
import { PlotThreadExtractionDialog } from "./PlotThreadExtractionDialog";

function proposal(): PlannedPlotThreadProposal {
  return {
    hypothesisId: "plot-thread:cluster-1",
    blocked: false,
    threadProposal: {
      proposalId: "proposal-1",
      kind: "plot.thread.bind",
      target: { kind: "plot-thread", logicalRef: "plot-thread:cluster-1" },
      payload: {
        threadHypothesisId: "plot-thread:cluster-1",
        binding: { kind: "create-new" },
        name: "王位継承の陰謀",
        description: { kind: "leave" },
        prominence: "primary",
        core: {
          kind: "process",
          subject: "内乱",
          processType: "war",
          expectedEndpoint: null,
        },
      },
      dependencies: [],
    },
    markerProposals: [],
  };
}

describe("PlotThreadExtractionDialog", () => {
  it("does not render dialog content while closed", () => {
    render(<PlotThreadExtractionDialog open={false} onOpenChange={() => {}} />);
    expect(screen.queryByText("プロットスレッド候補レビュー")).toBeNull();
  });

  it("shows the empty state when no proposals are provided", () => {
    render(<PlotThreadExtractionDialog open onOpenChange={() => {}} />);
    expect(screen.getByText("プロットスレッド候補レビュー")).toBeTruthy();
    expect(
      screen.getByTestId("plot-thread-proposal-review-empty"),
    ).toBeTruthy();
  });

  it("renders provided proposals", () => {
    render(
      <PlotThreadExtractionDialog
        open
        onOpenChange={() => {}}
        proposals={[proposal()]}
      />,
    );
    expect(screen.getByText("王位継承の陰謀")).toBeTruthy();
  });

  it("calls onOpenChange(false) when the close button is clicked", () => {
    const onOpenChange = vi.fn();
    render(<PlotThreadExtractionDialog open onOpenChange={onOpenChange} />);
    fireEvent.click(screen.getByText("閉じる"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
