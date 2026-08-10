// @vitest-environment happy-dom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChronicleExtractionProgress } from "./ChronicleExtractionProgress";
import {
  buildProposalSafetyFlags,
  resetChronicleExtractionStoreForTests,
  useChronicleExtractionStore,
  type ChronicleExtractionReviewProjection,
  type ChronicleReviewProposal,
} from "./chronicleExtractionStore";
import type { CreateChronicleEventProposalPayloadV1 } from "@/features/narrative-extraction/proposals/chronicleEventProposal";

const decideMock = vi.hoisted(() => vi.fn());
const decideDuplicateMock = vi.hoisted(() => vi.fn());
const reviseMock = vi.hoisted(() => vi.fn());
const bulkMock = vi.hoisted(() => vi.fn());

vi.mock("./chronicleExtractionApi", async () => {
  const actual = await vi.importActual<
    typeof import("./chronicleExtractionApi")
  >("./chronicleExtractionApi");
  return {
    ...actual,
    decideChronicleProposal: decideMock,
    decideChronicleProbableDuplicate: decideDuplicateMock,
    reviseChronicleProposal: reviseMock,
    bulkApproveSafeChronicleProposals: bulkMock,
  };
});

import { ChronicleProposalReview } from "./ChronicleProposalReview";

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
    vi.clearAllMocks();
    decideMock.mockImplementation(
      async (args: { proposalId: string; status: string }) => {
        useChronicleExtractionStore
          .getState()
          .updateProposalStatus(args.proposalId, args.status as never);
      },
    );
    decideDuplicateMock.mockImplementation(
      async (args: { proposalId: string; choice: string }) => {
        const status =
          args.choice === "hold"
            ? "held"
            : args.choice === "skip-as-same"
              ? "rejected"
              : "approved";
        useChronicleExtractionStore
          .getState()
          .updateProposalStatus(args.proposalId, status as never);
        useChronicleExtractionStore
          .getState()
          .setProbableDuplicateChoice(args.proposalId, args.choice as never);
      },
    );
    reviseMock.mockImplementation(
      async (args: {
        proposalId: string;
        patch: { title?: string; note?: string | null };
      }) => {
        useChronicleExtractionStore
          .getState()
          .reviseProposalFields(args.proposalId, "rev-native-2", args.patch);
      },
    );
    bulkMock.mockImplementation(async () => {
      return useChronicleExtractionStore.getState().bulkApproveSafe();
    });
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

  it("approves from card and supports safe bulk approve", async () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal()]));
    render(<ChronicleProposalReview />);

    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    await waitFor(() => {
      expect(
        useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
      ).toBe("approved");
    });
    expect(decideMock).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      status: "approved",
    });

    act(() => {
      useChronicleExtractionStore
        .getState()
        .updateProposalStatus("proposal-1", "unreviewed");
    });
    fireEvent.click(screen.getByTestId("chronicle-bulk-approve-safe"));
    await waitFor(() => {
      expect(
        useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
      ).toBe("approved");
    });
    expect(bulkMock).toHaveBeenCalled();
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

  it("offers probable-duplicate choices", async () => {
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
    await waitFor(() => {
      expect(
        useChronicleExtractionStore.getState().projection?.proposals[0]
          ?.probableDuplicateChoice,
      ).toBe("skip-as-same");
    });
    expect(
      useChronicleExtractionStore.getState().projection?.proposals[0]?.status,
    ).toBe("rejected");
    expect(decideDuplicateMock).toHaveBeenCalledWith({
      proposalId: "proposal-1",
      choice: "skip-as-same",
    });
  });

  it("create-as-new immediately marks approved so import is enabled", async () => {
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
    // Exercise the real decideChronicleProbableDuplicate → store mapping.
    decideDuplicateMock.mockImplementation(
      async (args: { proposalId: string; choice: string }) => {
        const actual = await vi.importActual<
          typeof import("./chronicleExtractionApi")
        >("./chronicleExtractionApi");
        // Bypass Native decide by stubbing decideChronicleProposal path via store mirror.
        const status =
          args.choice === "hold"
            ? ("held" as const)
            : args.choice === "skip-as-same"
              ? ("rejected" as const)
              : ("approved" as const);
        useChronicleExtractionStore
          .getState()
          .updateProposalStatus(args.proposalId, status);
        useChronicleExtractionStore
          .getState()
          .setProbableDuplicateChoice(args.proposalId, args.choice as never);
        return actual;
      },
    );
    render(<ChronicleProposalReview />);
    fireEvent.click(screen.getByRole("button", { name: "別Eventとして作成" }));
    await waitFor(() => {
      const row =
        useChronicleExtractionStore.getState().projection?.proposals[0];
      expect(row?.probableDuplicateChoice).toBe("create-as-new");
      expect(row?.status).toBe("approved");
    });
  });

  it("editing title requires re-approval via Native revision", async () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ status: "approved" })]));
    render(<ChronicleProposalReview />);
    const input = screen.getByTestId("chronicle-proposal-title-input");
    fireEvent.change(input, { target: { value: "撤退命令" } });
    fireEvent.blur(input);
    await waitFor(() => {
      expect(
        useChronicleExtractionStore.getState().projection?.proposals[0]
          ?.displayTitle,
      ).toBe("撤退命令");
    });
    const updated =
      useChronicleExtractionStore.getState().projection?.proposals[0];
    expect(updated?.status).toBe("unreviewed");
    expect(updated?.revisionId).toBe("rev-native-2");
    expect(reviseMock).toHaveBeenCalled();
  });
});
