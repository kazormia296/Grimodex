// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CodexEntityRelationRevisionReviewPanel,
  type CodexEntityRelationReviewDecision,
} from "./CodexEntityRelationRevisionReviewPanel";
import type { Nir1EntityRelationRevisionReadResult } from "@/features/narrative-semantic-core/nir1EntityRelationRevisionApi";

function sampleResult(): Nir1EntityRelationRevisionReadResult {
  return {
    projectId: "project-1",
    runId: "run-1",
    proposalSetId: "set-1",
    proposalId: "proposal-1",
    revisionId: "revision-1",
    sceneId: "scene-1",
    entities: [
      {
        entityId: "entity-1",
        entityType: "character",
        label: "ライカ",
        evidence: [
          {
            evidenceId: "evidence-1",
            sourceRef: "codex:entity-1",
            quote: "灰の目の騎士見習い",
            startUtf16: 0,
            endUtf16: 10,
          },
        ],
      },
      {
        entityId: "entity-2",
        entityType: "character",
        label: "ベルカ",
        evidence: [
          {
            evidenceId: "evidence-2",
            sourceRef: "codex:entity-2",
            quote: "王都の案内人",
            startUtf16: 0,
            endUtf16: 7,
          },
        ],
      },
    ],
    relations: [
      {
        edgeId: "relation-1",
        fromEntityId: "entity-1",
        toEntityId: "entity-2",
        relationType: "friend_of",
        directionality: "symmetric",
        evidenceIds: ["evidence-1", "evidence-2"],
      },
    ],
  };
}

describe("CodexEntityRelationRevisionReviewPanel", () => {
  it("shows the typed Entity/Relation evidence without exposing scope tokens", () => {
    render(
      <CodexEntityRelationRevisionReviewPanel
        status="draft"
        runId="run-1"
        result={sampleResult()}
        decision={null}
        onDecision={vi.fn()}
      />,
    );

    expect(
      screen.getByTestId("nir1-entity-relation-review-panel"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("nir1-entity-relation-review-panel").dataset.runId,
    ).toBe("run-1");
    expect(screen.getByText("ライカ")).toBeInTheDocument();
    expect(screen.getByText("ベルカ")).toBeInTheDocument();
    expect(screen.getByText(/灰の目の騎士見習い/)).toBeInTheDocument();
    expect(screen.getByText(/未承認/)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^nir1-typed-entity-row-/)).toHaveLength(2);
    expect(screen.getAllByTestId(/^nir1-typed-relation-row-/)).toHaveLength(1);
    expect(screen.queryByText("scope-rev-1")).not.toBeInTheDocument();
    expect(screen.queryByText("codex:entity-1@1")).not.toBeInTheDocument();
  });

  it.each([
    ["approved", "nir1-typed-approve"],
    ["rejected", "nir1-typed-reject"],
    ["deferred", "nir1-typed-defer"],
  ] as const)("passes an explicit %s decision", (decision, testId) => {
    const onDecision =
      vi.fn<(decision: CodexEntityRelationReviewDecision) => void>();
    render(
      <CodexEntityRelationRevisionReviewPanel
        status="draft"
        runId="run-1"
        result={sampleResult()}
        decision={null}
        onDecision={onDecision}
      />,
    );

    fireEvent.click(screen.getByTestId(testId));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith(decision);
  });

  it("does not offer approval for an already unavailable or available review", () => {
    const { rerender } = render(
      <CodexEntityRelationRevisionReviewPanel
        status="unavailable"
        runId="run-1"
        result={null}
        unavailableReason="revision-stale"
        decision={null}
      />,
    );
    expect(screen.getByText(/利用不可/)).toBeInTheDocument();
    expect(screen.queryByTestId("nir1-typed-approve")).not.toBeInTheDocument();

    rerender(
      <CodexEntityRelationRevisionReviewPanel
        status="available"
        runId="run-1"
        result={sampleResult()}
        decision="approved"
      />,
    );
    expect(screen.getByText("利用可能")).toBeInTheDocument();
    expect(screen.queryByTestId("nir1-typed-approve")).not.toBeInTheDocument();
  });

  it("offers cancellation for an available Revision and replacement for an invalidated one", () => {
    const onDecision = vi.fn();
    const onReplace = vi.fn();
    const { rerender } = render(
      <CodexEntityRelationRevisionReviewPanel
        status="available"
        runId="run-1"
        result={sampleResult()}
        decision="approved"
        onDecision={onDecision}
        onReplace={onReplace}
      />,
    );

    fireEvent.click(screen.getByTestId("nir1-typed-cancel"));
    expect(onDecision).toHaveBeenCalledExactlyOnceWith("rejected");

    rerender(
      <CodexEntityRelationRevisionReviewPanel
        status="unavailable"
        runId="run-1"
        result={sampleResult()}
        decision="rejected"
        onReplace={onReplace}
      />,
    );
    fireEvent.click(screen.getByTestId("nir1-typed-replace"));
    expect(onReplace).toHaveBeenCalledTimes(1);
  });
});
