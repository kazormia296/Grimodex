// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bindExistingCodexEntityProposal,
  createNewBindCodexEntityProposal,
} from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import { CodexEntityProposalReview } from "./CodexEntityProposalReview";
import { CodexStructureExtractionProgress } from "./CodexStructureExtractionProgress";
import {
  bulkApproveSafeCodexStructureProposals,
  decideCodexStructureProposal,
} from "./codexStructureExtractionApi";
import {
  buildCodexEntityProposalSafetyFlags,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
  type CodexEntityReviewProposal,
  type CodexStructureExtractionReviewProjection,
} from "./codexStructureExtractionStore";

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

// The bulk-approve button now calls the async persistence-aware API instead of
// a synchronous store method. Keep the rest of the module real (importOriginal)
// and stub only the bulk approve so it resolves after flipping the safe
// proposals to "approved" in the shared store — no Native backend needed.
vi.mock("./codexStructureExtractionApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./codexStructureExtractionApi")>();
  return {
    ...actual,
    decideCodexStructureProposal: vi.fn(async () => {}),
    bulkApproveSafeCodexStructureProposals: vi.fn(async () => {
      const { useCodexStructureExtractionStore } =
        await import("./codexStructureExtractionStore");
      const state = useCodexStructureExtractionStore.getState();
      const projection = state.projection;
      if (!projection) {
        return {
          approved: 0,
          approvedCreateNew: 0,
          approvedBindExisting: 0,
          failed: [],
          excluded: [],
        };
      }
      state.setProjection({
        ...projection,
        proposals: projection.proposals.map((proposal) => ({
          ...proposal,
          status: "approved" as const,
        })),
      });
      return {
        approved: projection.proposals.length,
        approvedCreateNew: projection.proposals.length,
        approvedBindExisting: 0,
        failed: [],
        excluded: [],
      };
    }),
  };
});

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
    baseDetailProposals: [],
    phaseProposals: [],
    entityCount: proposals.length,
    relationCount: 0,
    baseDetailCount: 0,
    phaseCount: 0,
    unresolvedCount: 1,
    approvedCount: 0,
    catalog: null,
    existingRelations: [],
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

  it("renders list + detail with evidence and supports safe bulk approve", async () => {
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
    expect(bulkApproveSafeCodexStructureProposals).toHaveBeenCalled();
    await waitFor(() => {
      expect(
        useCodexStructureExtractionStore.getState().projection?.proposals[0]
          ?.status,
      ).toBe("approved");
    });
  });
});

describe("CodexEntityProposalReview: 完全一致の既存への結び付け", () => {
  const catalog = {
    entities: [
      {
        ref: "K0003",
        sourceKey: "entry-riku",
        name: "リク",
        typeRef: "T0001",
        expectedVersion: 1,
        aliases: [] as string[],
      },
    ],
    types: [
      {
        ref: "T0001",
        sourceKey: "character",
        slug: "character",
        label: "人物",
      },
    ],
  };

  function bindProposal(
    overrides: Partial<CodexEntityReviewProposal> = {},
  ): CodexEntityReviewProposal {
    return reviewProposal({
      proposalId: "bind-1",
      displayTitle: "リク",
      proposal: bindExistingCodexEntityProposal(
        {
          narrativeEntityId: "ne-bind",
          canonicalName: "リク",
          aliases: [],
          coarseClass: "person",
          typeResolution: { status: "resolved", typeRef: "T0001" },
          binding: {
            kind: "bind-existing",
            entityRef: "K0003",
            enrichment: { aliasesToAdd: [], summary: { kind: "leave" } },
          },
        },
        { proposalId: "bind-1" },
      ),
      safety: buildCodexEntityProposalSafetyFlags({
        bindingKind: "bind-existing",
        typeStatus: "resolved",
        evidenceMethods: ["exact"],
        hasExistingCandidates: true,
        hasProperNameMention: true,
        aliasesAllExplicit: true,
      }),
      ...overrides,
    });
  }

  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    toastMocks.warning.mockClear();
    toastMocks.success.mockClear();
    vi.mocked(bulkApproveSafeCodexStructureProposals).mockClear();
  });

  function publish(proposals: CodexEntityReviewProposal[]) {
    useCodexStructureExtractionStore
      .getState()
      .setProjection({ ...projection(proposals), catalog });
  }

  it("カードに不透明な ref でなく結び先の名前を出し、一括の件数を新規作成と結び付けに分けて出す", () => {
    publish([reviewProposal(), bindProposal()]);
    render(<CodexEntityProposalReview />);
    expect(screen.getByText("既存 · リク")).toBeInTheDocument();
    expect(screen.queryByText(/K0003/)).not.toBeInTheDocument();
    expect(
      screen.getByTestId("codex-bulk-approve-breakdown"),
    ).toHaveTextContent("新規作成 1 件・既存への結び付け 1 件");
    expect(screen.getByTestId("codex-bulk-approve-safe")).toHaveTextContent(
      "(2)",
    );
    expect(
      screen.getByText(
        "完全一致の既存への結び付け（一括承認の対象の見込み。承認の直前に今の Codex で確かめ直します）",
      ),
    ).toBeInTheDocument();
  });

  it("結び付けが一括の対象でない（別名の追加がある）ときは件数に数えない", () => {
    publish([
      bindProposal({
        proposal: bindExistingCodexEntityProposal(
          {
            narrativeEntityId: "ne-bind",
            canonicalName: "リク",
            aliases: [],
            coarseClass: "person",
            typeResolution: { status: "resolved", typeRef: "T0001" },
            binding: {
              kind: "bind-existing",
              entityRef: "K0003",
              enrichment: {
                aliasesToAdd: ["りっくん"],
                summary: { kind: "leave" },
              },
            },
          },
          { proposalId: "bind-1" },
        ),
      }),
    ]);
    render(<CodexEntityProposalReview />);
    expect(
      screen.queryByTestId("codex-bulk-approve-breakdown"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("codex-bulk-approve-safe")).toBeDisabled();
  });

  it("一括で通した結び付けを、取り込み前の見返す一覧に「表記 → 結び先の名前」で出す", () => {
    publish([
      bindProposal({ status: "approved", bulkApprovedExactBind: true }),
      reviewProposal({
        proposalId: "manual-1",
        status: "approved",
      }),
    ]);
    render(<CodexEntityProposalReview />);
    const list = screen.getByTestId("codex-bulk-bound-list");
    expect(list).toHaveTextContent("一括で通した結び付け（1）");
    expect(
      screen.getByTestId("codex-bulk-bound-item-bind-1"),
    ).toHaveTextContent("リク → リク");
    fireEvent.click(screen.getByTestId("codex-bulk-bound-item-bind-1"));
    expect(useCodexStructureExtractionStore.getState().selectedProposalId).toBe(
      "bind-1",
    );
  });

  it("一括で通した結び付けが無ければ一覧を出さない（手で承認したものは出さない）", () => {
    publish([
      bindProposal({ status: "approved", bulkApprovedExactBind: false }),
    ]);
    render(<CodexEntityProposalReview />);
    expect(
      screen.queryByTestId("codex-bulk-bound-list"),
    ).not.toBeInTheDocument();
  });

  it("承認前へ戻された（結び先が古くなった）結び付けに、承認し直しが要る旨を出す", () => {
    publish([bindProposal({ status: "deferred", staleBind: true })]);
    render(<CodexEntityProposalReview />);
    expect(
      screen.getByTestId("codex-entity-stale-bind-note"),
    ).toHaveTextContent("結び先が編集されたため");
  });

  it("結び先が見つからないために戻された結び付けは、承認し直しでなく選び直し・却下へ誘導する", () => {
    publish([
      bindProposal({
        status: "deferred",
        staleBind: true,
        staleBindCause: "target-missing",
      }),
    ]);
    render(<CodexEntityProposalReview />);
    expect(
      screen.getByTestId("codex-entity-stale-bind-note"),
    ).toHaveTextContent("結び先の Entry が見つかりません");
  });

  it("一括承認に今の Codex の読み出しを渡し、外した件数を報告する", async () => {
    vi.mocked(bulkApproveSafeCodexStructureProposals).mockResolvedValueOnce({
      approved: 1,
      approvedCreateNew: 0,
      approvedBindExisting: 1,
      failed: [],
      excluded: [
        { proposalId: "b2", reason: "multiple-exact" },
        { proposalId: "b3", reason: "codex-unreadable" },
      ],
    });
    publish([bindProposal()]);
    const readEntries = vi.fn(async () => []);
    render(<CodexEntityProposalReview readEntries={readEntries} />);
    fireEvent.click(screen.getByTestId("codex-bulk-approve-safe"));
    expect(bulkApproveSafeCodexStructureProposals).toHaveBeenCalledWith({
      readEntries,
    });
    await waitFor(() => {
      expect(toastMocks.success).toHaveBeenCalled();
      expect(toastMocks.warning).toHaveBeenCalledTimes(2);
    });
    expect(toastMocks.warning.mock.calls.map(([message]) => message)).toEqual([
      "今の Codex を読めなかったため、結び付け 1 件は一括から外しました",
      "1 件の結び付けは、今の Codex では一括の条件を満たさないため、1 件ずつの確認に残しました",
    ]);
  });

  it("既存 Entry への結び付けを手で承認するときは、今の Codex を読んで今の版で承認する（読めなければ run 時点の版のまま）", async () => {
    publish([bindProposal({ status: "deferred", staleBind: true })]);
    const entries = [
      {
        id: "entry-riku",
        name: "リク",
        aliases: null,
        type: "character",
        version: 9,
      },
    ];
    const readEntries = vi
      .fn()
      .mockResolvedValueOnce(entries)
      .mockRejectedValueOnce(new Error("db down"));
    render(<CodexEntityProposalReview readEntries={readEntries} />);
    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    await waitFor(() =>
      expect(decideCodexStructureProposal).toHaveBeenCalledWith({
        proposalId: "bind-1",
        status: "approved",
        entries,
      }),
    );
    expect(readEntries).toHaveBeenCalledWith("project-a");

    vi.mocked(decideCodexStructureProposal).mockClear();
    fireEvent.click(screen.getByRole("button", { name: "承認" }));
    await waitFor(() =>
      expect(decideCodexStructureProposal).toHaveBeenCalledWith({
        proposalId: "bind-1",
        status: "approved",
      }),
    );
  });
});
