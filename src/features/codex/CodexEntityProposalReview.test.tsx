// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { createNewBindCodexEntityProposal } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import { CodexEntityProposalReview } from "./CodexEntityProposalReview";
import { CodexStructureExtractionProgress } from "./CodexStructureExtractionProgress";
import {
  buildCodexEntityProposalSafetyFlags,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
  type CodexEntityReviewProposal,
  type CodexStructureExtractionReviewProjection,
} from "./codexStructureExtractionStore";

function reviewProposal(
  overrides: Partial<CodexEntityReviewProposal> = {},
): CodexEntityReviewProposal {
  const proposal = createNewBindCodexEntityProposal(
    {
      narrativeEntityId: "ne-1",
      canonicalName: "ライカ",
      aliases: [{ surface: "灰の目", status: "explicit" }],
      coarseClass: "person",
      typeResolution: { status: "resolved", typeRef: "T0001" },
      binding: {
        kind: "create-new",
        entry: {
          name: "ライカ",
          aliases: ["灰の目"],
          summary: "騎士見習い",
        },
      },
    },
    { proposalId: "proposal-1" },
  );
  return {
    proposalId: "proposal-1",
    revisionId: "rev-1",
    proposalKey: "key-1",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: "ライカ",
    proposal,
    evidence: [
      {
        anchorId: "anchor-1",
        quote: "ライカは槍を構えた",
        documentRef: "D000001",
        sceneId: "scene-1",
        sceneTitle: "教会籠城",
        method: "exact",
      },
    ],
    safety: buildCodexEntityProposalSafetyFlags({
      bindingKind: "create-new",
      typeStatus: "resolved",
      evidenceMethods: ["exact"],
      hasExistingCandidates: false,
      hasProperNameMention: true,
      aliasesAllExplicit: true,
    }),
    ...overrides,
  };
}

function projection(
  proposals: CodexEntityReviewProposal[],
): CodexStructureExtractionReviewProjection {
  return {
    runId: "run-1",
    projectId: "project-a",
    workspacePath: "/workspace-a",
    openRevision: 1,
    proposalSetId: "ps-1",
    status: "completed",
    coverage: {
      mode: "partial",
      windowCount: 4,
      completedWindows: 3,
      gaps: [{ sourceRef: "src-a", reason: "Window 失敗" }],
    },
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 3,
      failed: 1,
      cancelled: 0,
    },
    proposals,
    relationProposals: [],
    entityCount: proposals.length,
    relationCount: 0,
    unresolvedCount: 1,
    approvedCount: 0,
    catalog: null,
  };
}

describe("CodexStructureExtractionProgress", () => {
  it("shows window progress, entity counts, and gaps", () => {
    render(
      <CodexStructureExtractionProgress
        coverage={{
          windowCount: 4,
          completedWindows: 3,
          gaps: [{ reason: "Window 失敗", sourceRef: "src-a" }],
        }}
        taskCounts={{
          queued: 0,
          running: 0,
          completed: 3,
          failed: 1,
          cancelled: 0,
        }}
        entityCount={8}
        relationCount={2}
        unresolvedCount={1}
      />,
    );
    expect(screen.getByText(/解析 3\/4 Window/)).toBeInTheDocument();
    expect(screen.getByText(/1件の範囲欠落/)).toBeInTheDocument();
    expect(
      screen.getByText(/Entity 8 \/ Relation 2 \/ 未解決 1/),
    ).toBeInTheDocument();
  });
});

describe("CodexEntityProposalReview", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
  });

  it("renders list + detail with evidence and supports safe bulk approve", () => {
    useCodexStructureExtractionStore
      .getState()
      .setProjection(projection([reviewProposal()]));
    render(<CodexEntityProposalReview />);

    expect(
      screen.getByTestId("codex-entity-proposal-review"),
    ).toBeInTheDocument();
    expect(screen.getByText("Entity Proposal")).toBeInTheDocument();
    expect(screen.getByDisplayValue("ライカ")).toBeInTheDocument();
    expect(screen.getByText(/「ライカは槍を構えた」/)).toBeInTheDocument();
    expect(screen.getByText(/Alias: 灰の目/)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("codex-bulk-approve-safe"));
    expect(
      useCodexStructureExtractionStore.getState().projection?.proposals[0]
        ?.status,
    ).toBe("approved");
  });
});
