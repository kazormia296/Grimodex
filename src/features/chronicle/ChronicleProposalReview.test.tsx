// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { ChronicleExtractionProgress } from "./ChronicleExtractionProgress";
import { ChronicleProposalReview } from "./ChronicleProposalReview";
import {
  buildProposalSafetyFlags,
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
  type ChronicleExtractionReviewProjection,
  type ChronicleReviewProposal,
} from "./chronicleExtractionStore";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";

function payload(
  overrides: Partial<CreateChronicleEventProposalPayloadV1> = {},
): CreateChronicleEventProposalPayloadV1 {
  return {
    eventId: "event-1",
    title: "教会への砲撃",
    note: "補足メモ",
    actuality: "actual",
    significance: "scene-level",
    evidenceAnchorIds: ["anchor-1"],
    evidenceDocumentRefs: ["doc-1"],
    disclosure: { secret: true, revealDocumentRef: "doc-1" },
    unresolvedMetadata: {
      participantSurfaces: ["マルフーシャ", "ライカ"],
      locationSurface: "教会",
      temporalExpressions: ["翌朝"],
    },
    ...overrides,
  };
}

function proposal(
  overrides: Partial<ChronicleReviewProposal> = {},
): ChronicleReviewProposal {
  const base = payload();
  return {
    proposalId: "proposal-1",
    revisionId: "rev-1",
    proposalKey: "key-1",
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: base.title,
    payload: base,
    match: { status: "none" },
    evidence: [
      {
        anchorId: "anchor-1",
        quote: "教会の尖塔が砲撃で崩れ落ちた",
        documentRef: "doc-1",
        sceneId: "scene-1",
        sceneTitle: "教会籠城",
        method: "exact",
      },
    ],
    safety: buildProposalSafetyFlags({
      match: { status: "none" },
      actuality: "actual",
      evidenceMethods: ["exact"],
    }),
    probableDuplicateChoice: null,
    ...overrides,
  };
}

function projection(
  proposals: ChronicleReviewProposal[],
): ChronicleExtractionReviewProjection {
  return {
    runId: "run-1",
    projectId: "project-a",
    workspacePath: "/workspace-a",
    openRevision: 1,
    proposalSetId: "proposal-set-1",
    status: "completed",
    coverage: {
      mode: "partial",
      windowCount: 14,
      completedWindows: 12,
      gaps: [{ sourceRef: "src-a", reason: "Window 失敗" }],
    },
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 8,
      failed: 1,
      cancelled: 0,
    },
    proposals,
  };
}

describe("ChronicleExtractionProgress", () => {
  it("shows window progress, gaps, and proposal count", () => {
    render(
      <ChronicleExtractionProgress
        coverage={{
          windowCount: 14,
          completedWindows: 12,
          gaps: [{ reason: "Window 失敗", sourceRef: "src-a" }],
        }}
        taskCounts={{
          queued: 0,
          running: 0,
          completed: 8,
          failed: 1,
          cancelled: 0,
        }}
        proposalCount={8}
      />,
    );
    expect(screen.getByText(/解析 12\/14 Window/)).toBeInTheDocument();
    expect(screen.getByText(/1件の範囲欠落/)).toBeInTheDocument();
    expect(screen.getByText(/8件の提案/)).toBeInTheDocument();
    expect(screen.getByTestId("chronicle-extraction-gaps")).toHaveTextContent(
      "Window 失敗",
    );
  });
});

describe("ChronicleProposalReview", () => {
  beforeEach(() => {
    resetChronicleExtractionStoreForTests();
  });

  it("renders list + detail split with evidence and unresolved metadata", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal()]));
    render(<ChronicleProposalReview />);

    expect(screen.getByTestId("chronicle-proposal-review")).toBeInTheDocument();
    expect(screen.getByText("Proposal一覧")).toBeInTheDocument();
    expect(screen.getByText("詳細")).toBeInTheDocument();
    expect(screen.getByDisplayValue("教会への砲撃")).toBeInTheDocument();
    expect(
      screen.getByText(/「教会の尖塔が砲撃で崩れ落ちた」/),
    ).toBeInTheDocument();
    expect(screen.getByText(/実際に発生 \/ scene-level/)).toBeInTheDocument();
    expect(
      screen.getByText(/参加者: マルフーシャ、ライカ/),
    ).toBeInTheDocument();
    expect(screen.getByText(/場所: 教会/)).toBeInTheDocument();
  });

  it("approves from card and supports safe bulk approve", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal()]));
    render(<ChronicleProposalReview />);

    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("approved");

    act(() => {
      useChronicleExtractionStore
        .getState()
        .updateProposalStatus("proposal-1", "unreviewed");
    });
    fireEvent.click(screen.getByTestId("chronicle-bulk-approve-safe"));
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("approved");
  });

  it("shows already-satisfied as completed / not applicable", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          applicability: "already-satisfied",
          payload: null,
          match: { status: "already-satisfied", existingRef: "ev-old" },
          displayTitle: "既存登録済み",
        }),
      ]),
    );
    render(<ChronicleProposalReview />);
    expect(
      screen.getByText(/既に同じEventが登録されています。適用不要/),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("chronicle-proposal-title-input"),
    ).not.toBeInTheDocument();
  });

  it("offers probable-duplicate choices", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          match: {
            status: "probable-duplicate",
            candidates: ["教会砲撃"],
            reasons: ["title"],
          },
          safety: buildProposalSafetyFlags({
            match: {
              status: "probable-duplicate",
              candidates: ["教会砲撃"],
              reasons: ["title"],
            },
            actuality: "actual",
            evidenceMethods: ["exact"],
          }),
        }),
      ]),
    );
    render(<ChronicleProposalReview />);
    fireEvent.click(
      screen.getByRole("button", { name: "同じものとしてスキップ" }),
    );
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]
        ?.probableDuplicateChoice,
    ).toBe("skip-as-same");
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("rejected");
  });

  it("editing title requires re-approval", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ status: "approved" })]));
    render(<ChronicleProposalReview />);
    const input = screen.getByTestId("chronicle-proposal-title-input");
    fireEvent.change(input, { target: { value: "撤退命令" } });
    fireEvent.blur(input);
    const updated =
      useChronicleExtractionStore.getState().projection?.proposals[0];
    expect(updated?.displayTitle).toBe("撤退命令");
    expect(updated?.status).toBe("unreviewed");
  });
});
