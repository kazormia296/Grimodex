// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TemporalConstraintCard } from "./TemporalConstraintCard";
import type { ResolvedTemporalNode } from "@/features/narrative-extraction/temporal/resolution";
import type { IntervalRelationConstraint } from "@/features/narrative-extraction/temporal/constraints";
import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";

const nodeId = "tn:scene-1" as TemporalNodeId;

function resolvedNode(
  overrides: Partial<ResolvedTemporalNode> = {},
): ResolvedTemporalNode {
  return {
    nodeId,
    resolution: "exact",
    actualStart: { earliest: 0, latest: 0 },
    actualEnd: null,
    duration: null,
    uncertaintyReason: [],
    derivationConstraintIds: [],
    ...overrides,
  };
}

describe("TemporalConstraintCard", () => {
  it("renders a resolved node with a distinct 期間 row when duration is present", () => {
    render(
      <TemporalConstraintCard
        item={{
          variant: "resolved",
          node: resolvedNode({
            resolution: "bounded",
            actualEnd: { earliest: 60, latest: 120 },
            duration: { earliest: 60, latest: 120 },
          }),
          label: "夜の場面",
        }}
      />,
    );

    expect(screen.getByText("夜の場面")).toBeInTheDocument();
    expect(screen.getByText("範囲あり")).toBeInTheDocument();
    const durationRow = screen.getByTestId("temporal-duration-row");
    expect(durationRow).toHaveTextContent("期間");
    expect(durationRow).toHaveTextContent("60〜120分");
    // Two uncertainty bands (start + end), neither one labeled as duration.
    expect(screen.getAllByTestId("temporal-uncertainty-band")).toHaveLength(2);
  });

  it("omits the duration row entirely when the solver has no duration", () => {
    render(
      <TemporalConstraintCard
        item={{ variant: "resolved", node: resolvedNode() }}
      />,
    );
    expect(screen.queryByTestId("temporal-duration-row")).toBeNull();
  });

  it("renders a relation constraint with left/right labels and relation wording", () => {
    const constraint: IntervalRelationConstraint = {
      id: "c1",
      kind: "interval-relation",
      leftNodeId: "tn:a" as TemporalNodeId,
      relation: "before",
      rightNodeId: "tn:b" as TemporalNodeId,
      strictness: "hard",
      authority: "explicit-story-text",
      sourceIds: [],
      fingerprint: "sha256:0000",
    };
    render(
      <TemporalConstraintCard
        item={{
          variant: "relation",
          constraint,
          leftLabel: "出発",
          rightLabel: "到着",
        }}
      />,
    );
    expect(screen.getByText("出発")).toBeInTheDocument();
    expect(screen.getByText("到着")).toBeInTheDocument();
    expect(screen.getByText("より前")).toBeInTheDocument();
    expect(screen.getByText("確定条件")).toBeInTheDocument();
  });
});
