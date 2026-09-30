// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TemporalConflictCard } from "./TemporalConflictCard";
import type { TemporalConflict } from "@/features/narrative-extraction/temporal/conflict";
import type { TemporalNodeId } from "@/features/narrative-extraction/temporal/nodes";

describe("TemporalConflictCard", () => {
  it("renders explanation, node badges, cycle steps, and related constraints", () => {
    const conflict: TemporalConflict = {
      conflictId: "conflict:negative-cycle",
      constraintIds: ["c1", "c2"],
      nodeIds: ["tn:a" as TemporalNodeId, "tn:b" as TemporalNodeId],
      explanation: "constraints c1 and c2 conflict",
      cycle: [
        {
          from: { nodeId: "tn:a" as TemporalNodeId, endpoint: "start" },
          to: { nodeId: "tn:b" as TemporalNodeId, endpoint: "end" },
          constraintId: "c1",
        },
      ],
    };

    render(
      <TemporalConflictCard
        conflict={conflict}
        nodeLabel={(id) => (id === "tn:a" ? "出発" : "到着")}
      />,
    );

    expect(
      screen.getByText("constraints c1 and c2 conflict"),
    ).toBeInTheDocument();
    expect(screen.getAllByText("出発").length).toBeGreaterThan(0);
    expect(screen.getAllByText("到着").length).toBeGreaterThan(0);
    expect(screen.getByTestId("temporal-conflict-cycle")).toBeInTheDocument();
    expect(screen.getByText(/関連条件: c1, c2/)).toBeInTheDocument();
  });

  it("falls back to raw node ids when no label resolver is given", () => {
    const conflict: TemporalConflict = {
      conflictId: "conflict:empty-domain",
      constraintIds: [],
      nodeIds: ["tn:x" as TemporalNodeId],
      explanation: "empty domain",
      cycle: [],
    };
    render(<TemporalConflictCard conflict={conflict} />);
    expect(screen.getByText("tn:x")).toBeInTheDocument();
  });
});
