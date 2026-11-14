// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { bindExistingCodexEntityProposal } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";
import { CodexEntityProposalReview } from "./CodexEntityProposalReview";
import {
  CodexSurfaceAliasNotAllowedError,
  reviseCodexStructureProposal,
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

vi.mock("./codexStructureExtractionApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./codexStructureExtractionApi")>();
  return {
    ...actual,
    decideCodexStructureProposal: vi.fn(async () => {}),
    reviseCodexStructureProposal: vi.fn(async () => {}),
  };
});

type Summary = { kind: "leave" } | { kind: "fill-if-empty"; value: string };

function bindProposal(args: {
  proposalId: string;
  surface: string;
  entityRef?: string;
  aliasesToAdd?: string[];
  summary?: Summary;
  application?: CodexEntityReviewProposal["application"];
}): CodexEntityReviewProposal {
  return {
    proposalId: args.proposalId,
    revisionId: `rev-${args.proposalId}`,
    proposalKey: `key-${args.proposalId}`,
    status: "unreviewed",
    applicability: "applicable",
    displayTitle: args.surface,
    application: args.application,
    proposal: bindExistingCodexEntityProposal(
      {
        narrativeEntityId: `ne-${args.proposalId}`,
        canonicalName: args.surface,
        aliases: [],
        coarseClass: "person",
        typeResolution: { status: "resolved", typeRef: "T0001" },
        binding: {
          kind: "bind-existing",
          entityRef: args.entityRef ?? "K0003",
          enrichment: {
            aliasesToAdd: args.aliasesToAdd ?? [],
            summary: args.summary ?? { kind: "leave" },
          },
        },
      },
      { proposalId: args.proposalId },
    ),
    evidence: [
      {
        anchorId: `anchor-${args.proposalId}`,
        quote: "リクは扉を開けた",
        documentRef: "D000001",
        sceneId: "scene-1",
        sceneTitle: "扉の前",
        method: "exact",
      },
    ],
    safety: buildCodexEntityProposalSafetyFlags({
      bindingKind: "bind-existing",
      typeStatus: "resolved",
      evidenceMethods: ["exact"],
      hasExistingCandidates: true,
      hasProperNameMention: true,
      aliasesAllExplicit: true,
    }),
  };
}

function catalogWith(
  extra: Array<{ ref: string; name: string; aliases: string[] }> = [],
) {
  return {
    entities: [
      {
        ref: "K0003",
        sourceKey: "entry-riku",
        name: "リク",
        typeRef: "T0001",
        expectedVersion: 1,
        aliases: [] as string[],
      },
      ...extra.map((e) => ({
        ref: e.ref,
        sourceKey: `entry-${e.ref}`,
        name: e.name,
        typeRef: "T0001",
        expectedVersion: 1,
        aliases: e.aliases,
      })),
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
}

function publish(
  proposals: CodexEntityReviewProposal[],
  catalog = catalogWith(),
  selectedId: string = proposals[0]!.proposalId,
) {
  const projection: CodexStructureExtractionReviewProjection = {
    runId: "run-1",
    projectId: "project-a",
    workspacePath: "/workspace-a",
    openRevision: 1,
    proposalSetId: "ps-1",
    status: "completed",
    coverage: { mode: "full", windowCount: 1, completedWindows: 1, gaps: [] },
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
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
    unresolvedCount: 0,
    approvedCount: 0,
    catalog,
    existingRelations: [],
  };
  const store = useCodexStructureExtractionStore.getState();
  store.setProjection(projection);
  store.selectProposal(selectedId);
}

describe("CodexEntityProposalReview: 別名にも足す", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    toastMocks.error.mockClear();
    vi.mocked(reviseCodexStructureProposal).mockClear();
    vi.mocked(reviseCodexStructureProposal).mockResolvedValue(undefined);
  });

  it("敬称形の表記は、未チェックの行を出し、押すと addSurfaceAlias:true で保存する", () => {
    publish([bindProposal({ proposalId: "p1", surface: "リクさん" })]);
    render(<CodexEntityProposalReview />);
    expect(screen.getByTestId("codex-surface-alias")).toHaveTextContent(
      "「リクさん」を「リク」の別名にも足す",
    );
    const toggle = screen.getByTestId("codex-surface-alias-toggle");
    expect(toggle).not.toBeChecked();
    expect(
      screen.queryByTestId("codex-surface-alias-note"),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(reviseCodexStructureProposal).toHaveBeenCalledTimes(1);
    expect(reviseCodexStructureProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "p1",
        patch: { addSurfaceAlias: true },
      }),
    );
  });

  it("aliasesToAdd に表記が入っている提案はチェック済みで、外すと addSurfaceAlias:false で保存する", () => {
    publish([
      bindProposal({
        proposalId: "p1",
        surface: "リクさん",
        aliasesToAdd: ["リクさん"],
      }),
    ]);
    render(<CodexEntityProposalReview />);
    const toggle = screen.getByTestId("codex-surface-alias-toggle");
    expect(toggle).toBeChecked();
    expect(
      screen.queryByTestId("codex-surface-alias-warning"),
    ).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(reviseCodexStructureProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        proposalId: "p1",
        patch: { addSurfaceAlias: false },
      }),
    );
  });

  it("表記が結び先の名前と完全一致なら、行もメモも出さない", () => {
    publish([bindProposal({ proposalId: "p1", surface: "リク" })]);
    render(<CodexEntityProposalReview />);
    expect(screen.queryByTestId("codex-surface-alias")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("codex-surface-alias-note"),
    ).not.toBeInTheDocument();
  });

  it("敬称形でも別の Entry が同じ表記を別名に持つなら、チェックは出さずメモを出す", () => {
    publish(
      [bindProposal({ proposalId: "p1", surface: "リクさん" })],
      catalogWith([{ ref: "K0004", name: "アキラ", aliases: ["リクさん"] }]),
    );
    render(<CodexEntityProposalReview />);
    expect(screen.queryByTestId("codex-surface-alias")).not.toBeInTheDocument();
    expect(screen.getByTestId("codex-surface-alias-note")).toHaveTextContent(
      "この表記は別の項目の名前・別名と同じなので、別名に足せません",
    );
  });

  it("印が入っていても別の Entry と衝突するなら、チェック済みのまま警告を出す", () => {
    publish(
      [
        bindProposal({
          proposalId: "p1",
          surface: "リクさん",
          aliasesToAdd: ["リクさん"],
        }),
      ],
      catalogWith([{ ref: "K0004", name: "アキラ", aliases: ["リクさん"] }]),
    );
    render(<CodexEntityProposalReview />);
    expect(screen.getByTestId("codex-surface-alias-toggle")).toBeChecked();
    expect(screen.getByTestId("codex-surface-alias-warning")).toHaveTextContent(
      "別の項目の名前・別名と同じ",
    );
  });

  it("同じ Entry に要約の fill を持つ別の提案があれば、same-entry-patch のメモを出す", () => {
    publish([
      bindProposal({ proposalId: "p1", surface: "リクさん" }),
      bindProposal({
        proposalId: "p2",
        surface: "リク",
        summary: { kind: "fill-if-empty", value: "斥候の少年" },
      }),
    ]);
    render(<CodexEntityProposalReview />);
    expect(screen.queryByTestId("codex-surface-alias")).not.toBeInTheDocument();
    expect(screen.getByTestId("codex-surface-alias-note")).toHaveTextContent(
      "同じ項目に別名や要約を足す提案が他にある",
    );
  });

  it("取り込み済み（application あり）の提案では行もメモも出さない", () => {
    publish([
      bindProposal({
        proposalId: "p1",
        surface: "リクさん",
        application: {
          revisionId: "rev-p1",
          appliedEntityKind: "codex-entry",
          appliedEntityId: "entry-riku",
        },
      }),
    ]);
    render(<CodexEntityProposalReview />);
    expect(screen.queryByTestId("codex-surface-alias")).not.toBeInTheDocument();
    expect(
      screen.queryByTestId("codex-surface-alias-note"),
    ).not.toBeInTheDocument();
  });

  it("保存が CodexSurfaceAliasNotAllowedError で失敗したら、理由の文言で toast.error を出す", async () => {
    vi.mocked(reviseCodexStructureProposal).mockRejectedValueOnce(
      new CodexSurfaceAliasNotAllowedError("exact-other"),
    );
    publish([bindProposal({ proposalId: "p1", surface: "リクさん" })]);
    render(<CodexEntityProposalReview />);
    fireEvent.click(screen.getByTestId("codex-surface-alias-toggle"));
    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith(
        "この表記は別の項目の名前・別名と同じなので、別名に足せません",
      );
    });
  });

  it("その他の失敗は、エラーの文言（無ければ保存失敗の文言）で toast.error を出す", async () => {
    vi.mocked(reviseCodexStructureProposal).mockRejectedValueOnce(
      new Error("disk full"),
    );
    publish([bindProposal({ proposalId: "p1", surface: "リクさん" })]);
    render(<CodexEntityProposalReview />);
    fireEvent.click(screen.getByTestId("codex-surface-alias-toggle"));
    await waitFor(() => {
      expect(toastMocks.error).toHaveBeenCalledWith("disk full");
    });
  });
});
