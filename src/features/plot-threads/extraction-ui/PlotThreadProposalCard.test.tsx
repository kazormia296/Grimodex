// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import type { PlannedPlotThreadProposal } from "@/features/plot-threads/extraction/proposalPlanner";
import { PlotThreadProposalCard } from "./PlotThreadProposalCard";

function proposal(
  overrides: Partial<PlannedPlotThreadProposal> = {},
): PlannedPlotThreadProposal {
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
        description: { kind: "set-on-create", value: "王位を巡る対立" },
        prominence: "supporting",
        core: {
          kind: "conflict",
          sides: [{ entityIds: ["E001"], position: "王位を守る" }],
          contestedProposition: "誰が王位を継ぐか",
          stakes: null,
        },
      },
      dependencies: [],
    },
    markerProposals: [
      {
        proposalId: "marker-1",
        kind: "plot.marker.place",
        target: { kind: "plot-marker", logicalRef: "marker-ref-1" },
        payload: {
          threadHypothesisId: "plot-thread:cluster-1",
          documentRef: "doc:s1",
          phaseType: "introduce",
          note: null,
          developmentInferenceIds: ["dev-1"],
          evidenceAnchorIds: ["anchor-1"],
          existing: { status: "absent" },
        },
        dependencies: [],
      },
    ],
    ...overrides,
  };
}

describe("PlotThreadProposalCard", () => {
  it("renders name, binding, prominence, core kind, and marker count", () => {
    const { getByTestId, getByText } = render(
      <PlotThreadProposalCard proposal={proposal()} />,
    );
    const card = getByTestId("plot-thread-proposal-card-plot-thread:cluster-1");
    expect(card).toBeTruthy();
    expect(getByText("王位継承の陰謀")).toBeTruthy();
    expect(getByText("王位を巡る対立")).toBeTruthy();
    expect(getByText("conflict")).toBeTruthy();
  });

  it("shows blocked reason when the proposal is blocked", () => {
    const { getByText } = render(
      <PlotThreadProposalCard
        proposal={proposal({
          blocked: true,
          blockedReason:
            "既存プロットスレッド候補が複数あり、Binding が未解決です",
        })}
      />,
    );
    expect(
      getByText("既存プロットスレッド候補が複数あり、Binding が未解決です"),
    ).toBeTruthy();
  });

  it("uses documentLabel/phaseLabel resolvers for marker chips", () => {
    const { getByText } = render(
      <PlotThreadProposalCard
        proposal={proposal()}
        documentLabel={() => "第1章"}
        phaseLabel={() => "セットアップ"}
      />,
    );
    expect(getByText("第1章")).toBeTruthy();
    expect(getByText("セットアップ")).toBeTruthy();
  });

  it("falls back to raw refs without resolvers", () => {
    const { getByText } = render(
      <PlotThreadProposalCard proposal={proposal()} />,
    );
    expect(getByText("doc:s1")).toBeTruthy();
    expect(getByText("introduce")).toBeTruthy();
  });
});
