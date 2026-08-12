// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TemporalReviewPanel } from "./TemporalReviewPanel";
import type { ResolvedTemporalNode } from "@/features/narrative-extraction/temporal/resolution";
import type { TemporalConflict } from "@/features/narrative-extraction/temporal/conflict";
import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";

// Radix Tabs のトリガは click ではなく mousedown で選択される。
function clickTab(el: HTMLElement) {
  fireEvent.mouseDown(el, { button: 0 });
  fireEvent.click(el);
}

function resolvedNode(id: string): ResolvedTemporalNode {
  return {
    nodeId: id as TemporalNodeId,
    resolution: "exact",
    actualStart: { earliest: 0, latest: 0 },
    actualEnd: null,
    duration: null,
    uncertaintyReason: [],
    derivationConstraintIds: [],
  };
}

describe("TemporalReviewPanel", () => {
  it("renders all five review tabs", () => {
    render(<TemporalReviewPanel resolvedNodes={[]} />);
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(
      expect.arrayContaining([
        expect.stringContaining("解決済み日時"),
        expect.stringContaining("相対関係"),
        expect.stringContaining("作中順"),
        expect.stringContaining("矛盾"),
        expect.stringContaining("未解決表現"),
      ]),
    );
  });

  it("shows an empty state on the resolved tab with no data", () => {
    render(<TemporalReviewPanel resolvedNodes={[]} />);
    expect(
      screen.getByText("解決済みの日時はまだありません。"),
    ).toBeInTheDocument();
  });

  it("lists resolved nodes and switches to the conflicts tab showing a badge count", () => {
    const conflicts: TemporalConflict[] = [
      {
        conflictId: "conflict:1",
        constraintIds: ["c1"],
        nodeIds: ["tn:a" as TemporalNodeId],
        explanation: "衝突しています",
        cycle: [],
      },
    ];
    render(
      <TemporalReviewPanel
        resolvedNodes={[resolvedNode("tn:a")]}
        conflicts={conflicts}
      />,
    );

    expect(
      screen.getByTestId("temporal-resolved-card-tn:a"),
    ).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument(); // conflict badge count

    clickTab(screen.getByTestId("temporal-review-tab-conflicts"));
    expect(screen.getByText("衝突しています")).toBeInTheDocument();
  });

  it("renders story order layers and unresolved expressions on their own tabs", () => {
    render(
      <TemporalReviewPanel
        resolvedNodes={[]}
        storyOrder={[
          { rank: 0, nodeIds: ["tn:a" as TemporalNodeId] },
          {
            rank: 1,
            nodeIds: ["tn:b" as TemporalNodeId, "tn:c" as TemporalNodeId],
          },
        ]}
        unresolvedExpressions={[
          {
            observationId: "o1",
            surface: "しばらくして",
            reason: "曖昧な相対表現",
          },
        ]}
        nodeLabel={(id) => `label:${id}`}
      />,
    );

    clickTab(screen.getByTestId("temporal-review-tab-storyOrder"));
    expect(
      screen.getByTestId("temporal-story-order-layer-0"),
    ).toHaveTextContent("label:tn:a");
    expect(
      screen.getByTestId("temporal-story-order-layer-1"),
    ).toHaveTextContent("label:tn:b");

    clickTab(screen.getByTestId("temporal-review-tab-unresolved"));
    expect(screen.getByText("「しばらくして」")).toBeInTheDocument();
    expect(screen.getByText("曖昧な相対表現")).toBeInTheDocument();
  });
});
