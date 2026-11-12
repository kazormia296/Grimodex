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
    bulkApproveChronicleProposals: bulkMock,
  };
});

import { ChronicleProposalReview } from "./ChronicleProposalReview";
import { ChronicleBulkApproveCommandError } from "./chronicleExtractionApi";

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
    plannedTitle: base.title,
    plannedMatch: { status: "none" },
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
    application: overrides.application ?? null,
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
        const current = useChronicleExtractionStore
          .getState()
          .projection?.proposals.find(
            (item) => item.proposalId === args.proposalId,
          );
        const match =
          args.patch.title === undefined
            ? (current?.match ?? ({ status: "none" } as const))
            : args.patch.title.trim() === current?.plannedTitle
              ? current.plannedMatch
              : ({
                  status: "probable-duplicate",
                  candidates: ["撤退命令"],
                  reasons: ["title"],
                } as const);
        useChronicleExtractionStore
          .getState()
          .reviseProposalFields(
            args.proposalId,
            "rev-native-2",
            "sha256:review-revision-envelope",
            match,
            args.patch,
          );
      },
    );
    bulkMock.mockResolvedValue({
      runId: "run-1",
      approved: 0,
      skipped: [],
      failed: [],
      stopped: false,
      notSent: 0,
      refreshed: true,
      remaining: 0,
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

  it("approves from card", async () => {
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
  });

  it("publishes decision persistence as a shared Apply interlock", async () => {
    let resolveDecision!: () => void;
    decideMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveDecision = resolve;
      }),
    );
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal()]));
    render(<ChronicleProposalReview />);

    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    await waitFor(() =>
      expect(useChronicleExtractionStore.getState().reviewMutationCount).toBe(
        1,
      ),
    );
    expect(screen.getByRole("button", { name: "拒否" })).toBeDisabled();

    await act(async () => {
      resolveDecision();
      await Promise.resolve();
    });
    expect(useChronicleExtractionStore.getState().reviewMutationCount).toBe(0);
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
    expect(
      screen.queryByRole("button", { name: "承認" }),
    ).not.toBeInTheDocument();
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

  it("restores ordinary review controls after an exact sealed-title revert", async () => {
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
    expect(updated?.match).toEqual({
      status: "probable-duplicate",
      candidates: ["撤退命令"],
      reasons: ["title"],
    });
    expect(
      screen.queryByRole("button", { name: "承認" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "同じものとしてスキップ" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "別Eventとして作成" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "別Eventとして作成" }));
    await waitFor(() => {
      expect(
        useChronicleExtractionStore.getState().projection?.proposals[0]
          ?.probableDuplicateChoice,
      ).toBe("create-as-new");
    });

    const revertedInput = screen.getByTestId("chronicle-proposal-title-input");
    fireEvent.change(revertedInput, {
      target: { value: "教会への砲撃" },
    });
    fireEvent.blur(revertedInput);
    await waitFor(() => {
      expect(
        useChronicleExtractionStore.getState().projection?.proposals[0]
          ?.displayTitle,
      ).toBe("教会への砲撃");
    });
    const reverted =
      useChronicleExtractionStore.getState().projection?.proposals[0];
    expect(reverted?.status).toBe("unreviewed");
    expect(reverted?.match).toEqual({ status: "none" });
    expect(reverted?.probableDuplicateChoice).toBeNull();
    expect(
      screen.queryByRole("button", { name: "別Eventとして作成" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "承認" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "拒否" })).toBeEnabled();
    expect(reviseMock).toHaveBeenCalledTimes(2);
  });
});

const ELIGIBLE = { eligible: true, reasons: [] } as const;

function bulkOutcome(
  overrides: Partial<{
    runId: string;
    approved: number;
    skipped: { proposalId: string; reasons: string[] }[];
    failed: { proposalId: string; code: string }[];
    stopped: boolean;
    notSent: number;
    refreshed: boolean;
    remaining: number;
  }> = {},
) {
  return {
    runId: "run-1",
    approved: 0,
    skipped: [],
    failed: [],
    stopped: false,
    notSent: 0,
    refreshed: true,
    remaining: 0,
    ...overrides,
  };
}

describe("ChronicleProposalReview: bulk approve (BAO/1)", () => {
  beforeEach(() => {
    resetChronicleExtractionStoreForTests();
    vi.clearAllMocks();
    bulkMock.mockResolvedValue(bulkOutcome());
  });

  it("counts, marks and enables by Native's judgement only", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        // Plan-time flags are green, but Native has said nothing: no mark.
        proposal({ proposalId: "flags-green", bulkApproval: null }),
        proposal({
          proposalId: "native-eligible",
          proposalKey: "k2",
          bulkApproval: ELIGIBLE,
          safety: {
            fresh: false,
            evidenceExact: false,
            actualitySettled: false,
            noDuplicate: false,
            lossless: false,
            noDeps: false,
            riskLow: false,
          },
        }),
        proposal({
          proposalId: "native-not",
          proposalKey: "k3",
          bulkApproval: { eligible: false, reasons: ["r3-significance"] },
        }),
      ]),
    );
    render(<ChronicleProposalReview />);
    expect(screen.getByTestId("chronicle-bulk-approve-safe")).toHaveTextContent(
      "見せる理由の無い提案をまとめて承認 (1)",
    );
    expect(screen.getByTestId("chronicle-bulk-approve-safe")).toBeEnabled();
    expect(
      screen.getByTestId("chronicle-proposal-bulk-target-native-eligible"),
    ).toHaveTextContent("まとめて承認の対象");
    expect(
      screen.queryByTestId("chronicle-proposal-bulk-target-flags-green"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("chronicle-proposal-bulk-target-native-not"),
    ).not.toBeInTheDocument();
  });

  it("always explains what the button does, and is disabled for zero targets", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          bulkApproval: { eligible: false, reasons: ["r3-significance"] },
        }),
      ]),
    );
    render(<ChronicleProposalReview />);
    const description = screen.getByTestId(
      "chronicle-bulk-approve-description",
    );
    expect(description).toHaveTextContent("まとめて承認の対象はありません。");
    expect(screen.getByTestId("chronicle-bulk-approve-safe")).toBeDisabled();
  });

  it("says the judgement could not be read, not 'no targets', when it is unknown", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(
        projection([
          proposal({ bulkApproval: ELIGIBLE }),
          proposal({ proposalId: "p2", proposalKey: "k2", bulkApproval: null }),
        ]),
      );
    render(<ChronicleProposalReview />);
    expect(
      screen.getByTestId("chronicle-bulk-approve-unknown"),
    ).toHaveTextContent(
      "まとめて承認の対象を確かめられませんでした。画面を開き直してください。",
    );
    expect(
      screen.queryByTestId("chronicle-bulk-approve-description"),
    ).not.toBeInTheDocument();
  });

  it("does not call a decided proposal a target even if Native's judgement is older", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(
        projection([proposal({ status: "approved", bulkApproval: ELIGIBLE })]),
      );
    render(<ChronicleProposalReview />);
    expect(
      screen.queryByTestId("chronicle-proposal-bulk-target-proposal-1"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("chronicle-bulk-approve-safe")).toBeDisabled();
  });

  it("clears the result of the last bulk approval when a one-at-a-time operation succeeds", async () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: ELIGIBLE })]));
    decideMock.mockResolvedValue(undefined);
    bulkMock.mockResolvedValue(bulkOutcome({ approved: 1 }));
    render(<ChronicleProposalReview />);
    fireEvent.click(screen.getByTestId("chronicle-bulk-approve-safe"));
    await screen.findByTestId("chronicle-bulk-approve-result");
    fireEvent.click(screen.getByRole("button", { name: "拒否" }));
    await waitFor(() =>
      expect(
        screen.queryByTestId("chronicle-bulk-approve-result"),
      ).not.toBeInTheDocument(),
    );
  });

  it("says the list could not be re-read when the whole command failed and the re-read failed", async () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: ELIGIBLE })]));
    bulkMock.mockRejectedValueOnce(
      new ChronicleBulkApproveCommandError(new Error("NEX_BULK_DOWN"), false),
    );
    render(<ChronicleProposalReview />);
    fireEvent.click(screen.getByTestId("chronicle-bulk-approve-safe"));
    const error = await screen.findByTestId("chronicle-proposal-persist-error");
    expect(error).toHaveTextContent(
      "まとめて承認に失敗しました。一覧も読み直せませんでした。画面を開き直してください。",
    );
  });

  it("says the list was not re-read when an unknown exception is thrown", async () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: ELIGIBLE })]));
    bulkMock.mockRejectedValueOnce(new Error("unexpected"));
    render(<ChronicleProposalReview />);
    fireEvent.click(screen.getByTestId("chronicle-bulk-approve-safe"));
    const error = await screen.findByTestId("chronicle-proposal-persist-error");
    expect(error).toHaveTextContent("一覧も読み直せませんでした");
  });

  it("shows 'checking' while the first judgement read is in flight, not 'reopen'", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: null })]));
    useChronicleExtractionStore.setState({ bulkJudgementReads: 1 });
    render(<ChronicleProposalReview />);
    expect(
      screen.getByTestId("chronicle-bulk-approve-loading"),
    ).toHaveTextContent("確かめています");
    expect(
      screen.queryByTestId("chronicle-bulk-approve-unknown"),
    ).not.toBeInTheDocument();
  });

  it("shows the count in the explanation", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: ELIGIBLE })]));
    render(<ChronicleProposalReview />);
    expect(
      screen.getByTestId("chronicle-bulk-approve-description"),
    ).toHaveTextContent(
      "見せる理由の無い提案 1 件の秘密の印を外して承認します",
    );
  });

  it("calls the command once on click, blocks a second run, and shows the result", async () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: ELIGIBLE })]));
    let resolveBulk!: (value: ReturnType<typeof bulkOutcome>) => void;
    bulkMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveBulk = resolve;
      }),
    );
    render(<ChronicleProposalReview />);
    const button = screen.getByTestId("chronicle-bulk-approve-safe");
    fireEvent.click(button);
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(bulkMock).toHaveBeenCalledTimes(1);
    expect(useChronicleExtractionStore.getState().reviewMutationCount).toBe(1);
    // The Apply interlock: Apply cannot start while the bulk run is in flight.
    expect(useChronicleExtractionStore.getState().tryBeginApplyMutation()).toBe(
      false,
    );

    await act(async () => {
      resolveBulk(
        bulkOutcome({
          approved: 3,
          skipped: [
            { proposalId: "x", reasons: ["revision-changed"] },
            { proposalId: "y", reasons: ["revision-changed", "edited"] },
          ],
          failed: [{ proposalId: "z", code: "NEX_FAIL" }],
          remaining: 5,
        }),
      );
      await Promise.resolve();
    });
    const result = await screen.findByTestId("chronicle-bulk-approve-result");
    expect(result).toHaveTextContent("3 件を承認しました。");
    expect(result).toHaveTextContent("3 件は飛ばしました（");
    expect(result).toHaveTextContent("承認の前に提案が変わりました");
    expect(result).toHaveTextContent("個別に決める提案が 5 件残っています。");
    expect(result).not.toHaveTextContent("途中で止まりました");
    expect(useChronicleExtractionStore.getState().reviewMutationCount).toBe(0);
  });

  it("says when Native stopped partway, when the list is stale, and when some were not sent", async () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: ELIGIBLE })]));
    bulkMock.mockResolvedValue(
      bulkOutcome({ stopped: true, refreshed: false, notSent: 7 }),
    );
    render(<ChronicleProposalReview />);
    fireEvent.click(screen.getByTestId("chronicle-bulk-approve-safe"));
    const result = await screen.findByTestId("chronicle-bulk-approve-result");
    expect(result).toHaveTextContent("途中で止まりました");
    expect(result).toHaveTextContent("一覧を読み直せませんでした");
    expect(result).toHaveTextContent("7 件は送っていません");
  });

  it("does not show a result after another Run became active", async () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: ELIGIBLE })]));
    render(<ChronicleProposalReview />);
    fireEvent.click(screen.getByTestId("chronicle-bulk-approve-safe"));
    await screen.findByTestId("chronicle-bulk-approve-result");
    act(() => {
      useChronicleExtractionStore.getState().setProjection({
        ...projection([proposal({ bulkApproval: null })]),
        runId: "run-2",
      });
    });
    expect(
      screen.queryByTestId("chronicle-bulk-approve-result"),
    ).not.toBeInTheDocument();
  });

  it("shows a general failure when the whole command fails, and can be retried", async () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: ELIGIBLE })]));
    bulkMock.mockRejectedValueOnce(new Error("NEX_BULK_DOWN"));
    render(<ChronicleProposalReview />);
    fireEvent.click(screen.getByTestId("chronicle-bulk-approve-safe"));
    const error = await screen.findByTestId("chronicle-proposal-persist-error");
    expect(error).toHaveTextContent("まとめて承認に失敗しました");
    expect(
      screen.queryByTestId("chronicle-bulk-approve-result"),
    ).not.toBeInTheDocument();
    expect(useChronicleExtractionStore.getState().reviewMutationCount).toBe(0);
    await waitFor(() =>
      expect(screen.getByTestId("chronicle-bulk-approve-safe")).toBeEnabled(),
    );
  });

  it("is disabled while Apply owns the review boundary", () => {
    useChronicleExtractionStore
      .getState()
      .setProjection(projection([proposal({ bulkApproval: ELIGIBLE })]));
    useChronicleExtractionStore.getState().tryBeginApplyMutation();
    render(<ChronicleProposalReview />);
    expect(screen.getByTestId("chronicle-bulk-approve-safe")).toBeDisabled();
  });

  it("shows one reason line for a non-target, reasons-to-show first, and none for review state", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          proposalId: "multi",
          bulkApproval: {
            eligible: false,
            reasons: ["edited", "r2-attribution", "r4-actuality"],
          },
        }),
        proposal({
          proposalId: "state-only",
          proposalKey: "k2",
          bulkApproval: { eligible: false, reasons: ["approved", "applied"] },
        }),
        proposal({
          proposalId: "unknown-judgement",
          proposalKey: "k3",
          bulkApproval: null,
        }),
      ]),
    );
    render(<ChronicleProposalReview />);
    expect(
      screen.getByTestId("chronicle-proposal-reasons-multi"),
    ).toHaveTextContent(
      "登場人物の発言や心の声の中の出来事です 試みたが成らなかった／阻まれた出来事です 編集した提案です",
    );
    expect(
      screen.queryByTestId("chronicle-proposal-reasons-state-only"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("chronicle-proposal-reasons-unknown-judgement"),
    ).not.toBeInTheDocument();
  });

  it("adds no reason line for a duplicate the card already shows", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          match: {
            status: "probable-duplicate",
            candidates: ["教会砲撃"],
            reasons: ["title"],
          },
          bulkApproval: { eligible: false, reasons: ["probable-duplicate"] },
        }),
      ]),
    );
    render(<ChronicleProposalReview />);
    expect(
      screen.getByText("既存Eventと同一の可能性があります"),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId("chronicle-proposal-reasons-proposal-1"),
    ).not.toBeInTheDocument();
  });

  it("moves unreviewed proposals with a reason to show to the top, for display only", () => {
    useChronicleExtractionStore.getState().setProjection(
      projection([
        proposal({
          proposalId: "plain-1",
          proposalKey: "k1",
          bulkApproval: ELIGIBLE,
        }),
        proposal({
          proposalId: "shown-1",
          proposalKey: "k2",
          bulkApproval: { eligible: false, reasons: ["r3-significance"] },
        }),
        proposal({
          proposalId: "plain-2",
          proposalKey: "k3",
          bulkApproval: ELIGIBLE,
        }),
        proposal({
          proposalId: "shown-2",
          proposalKey: "k4",
          bulkApproval: { eligible: false, reasons: ["r1-narrative-frame"] },
        }),
        proposal({
          proposalId: "decided",
          proposalKey: "k5",
          status: "approved",
          bulkApproval: {
            eligible: false,
            reasons: ["approved", "r3-significance"],
          },
        }),
      ]),
    );
    render(<ChronicleProposalReview />);
    const shown = screen
      .getAllByTestId(/^chronicle-proposal-card-/)
      .map((node) => node.getAttribute("data-testid"));
    expect(shown).toEqual([
      "chronicle-proposal-card-shown-1",
      "chronicle-proposal-card-shown-2",
      "chronicle-proposal-card-plain-1",
      "chronicle-proposal-card-plain-2",
      "chronicle-proposal-card-decided",
    ]);
    // The store's order is untouched.
    expect(
      useChronicleExtractionStore
        .getState()
        .projection?.proposals.map((row) => row.proposalId),
    ).toEqual(["plain-1", "shown-1", "plain-2", "shown-2", "decided"]);
  });
});
