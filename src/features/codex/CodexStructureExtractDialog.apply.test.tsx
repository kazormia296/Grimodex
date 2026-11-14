// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNewBindCodexEntityProposal } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

const applyMock = vi.hoisted(() => vi.fn());
const readEntriesMock = vi.hoisted(() => vi.fn());
vi.mock("./codexStructureExtractionApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./codexStructureExtractionApi")>();
  return {
    ...actual,
    applyCodexStructureExtractionReview: applyMock,
    readCurrentCodexEntries: readEntriesMock,
    restoreCodexStructureExtractionReview: vi.fn(async () => null),
  };
});
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
}));

import { CodexStructureExtractDialog } from "./CodexStructureExtractDialog";
import {
  buildCodexEntityProposalSafetyFlags,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
} from "./codexStructureExtractionStore";
import { useCodexStore } from "./codexStore";
import { useWorkspaceStore } from "@/features/workspace/store";

function publishApprovedProjection() {
  useWorkspaceStore.setState({
    activeWorkspacePath: "/w",
    workspaceOpenRevision: 1,
  } as never);
  const proposal = createNewBindCodexEntityProposal(
    {
      narrativeEntityId: "ne-1",
      canonicalName: "ミナ",
      aliases: [],
      coarseClass: "person",
      typeResolution: { status: "resolved", typeRef: "T0001" },
      binding: {
        kind: "create-new",
        entry: { name: "ミナ", aliases: [], summary: null },
      },
    },
    { proposalId: "c1" },
  );
  useCodexStructureExtractionStore.getState().setProjection({
    runId: "run-1",
    projectId: "p1",
    workspacePath: "/w",
    openRevision: 1,
    proposalSetId: "ps-1",
    folderId: "f1",
    status: "completed",
    coverage: {},
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
    },
    proposals: [
      {
        proposalId: "c1",
        revisionId: "rev-c1",
        proposalKey: "key-c1",
        status: "approved",
        applicability: "applicable",
        displayTitle: "ミナ",
        proposal,
        evidence: [],
        safety: buildCodexEntityProposalSafetyFlags({
          bindingKind: "create-new",
          typeStatus: "resolved",
          evidenceMethods: ["exact"],
          hasExistingCandidates: false,
          hasProperNameMention: true,
          aliasesAllExplicit: true,
        }),
      },
    ],
    relationProposals: [],
    baseDetailProposals: [],
    phaseProposals: [],
    entityCount: 1,
    relationCount: 0,
    baseDetailCount: 0,
    phaseCount: 0,
    unresolvedCount: 0,
    approvedCount: 1,
    catalog: null,
  });
}

describe("CodexStructureExtractDialog の適用", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    applyMock.mockReset();
    readEntriesMock.mockReset();
    // 画面の store は絞り込まれうるので、Apply には DB から読んだ全体を渡す。
    readEntriesMock.mockResolvedValue([
      {
        id: "entry-riku",
        name: "リク",
        aliases: null,
        type: "character",
        version: 7,
      },
      {
        id: "entry-sora",
        name: "ソラ",
        aliases: null,
        type: "character",
        version: 2,
      },
    ]);
    toastMocks.warning.mockClear();
    toastMocks.success.mockClear();
    useCodexStore.setState({
      entries: [
        {
          id: "entry-riku",
          name: "リク",
          aliases: null,
          type: "character",
          version: 7,
        },
      ],
    } as never);
  });

  it("今の Codex の Entry（名前つき）を渡し、全部が外れて 0 件のときは報告して review を残す", async () => {
    publishApprovedProjection();
    const onOpenChange = vi.fn();
    applyMock.mockImplementation(
      async (input: {
        onEntityApprovalsExcluded?: (
          excluded: readonly {
            proposalId: string;
            displayTitle: string;
            reason: string;
          }[],
        ) => void;
      }) => {
        input.onEntityApprovalsExcluded?.([
          { proposalId: "b1", displayTitle: "リク", reason: "stale-version" },
        ]);
        return 0;
      },
    );
    render(
      <CodexStructureExtractDialog
        open
        onOpenChange={onOpenChange}
        folderId="f1"
      />,
    );
    fireEvent.click(screen.getByTestId("codex-structure-apply"));
    await waitFor(() => expect(applyMock).toHaveBeenCalledTimes(1));
    expect(readEntriesMock).toHaveBeenCalledWith("p1");
    // store（リクだけ）でなく、DB から読んだ全体（ソラも）を名前つきで渡す。
    expect(
      applyMock.mock.calls[0]?.[0].entries.map(
        (entry: { id: string }) => entry.id,
      ),
    ).toEqual(["entry-riku", "entry-sora"]);
    expect(applyMock.mock.calls[0]?.[0].entries[0]).toMatchObject({
      name: "リク",
      version: 7,
    });
    await waitFor(() => expect(toastMocks.warning).toHaveBeenCalledTimes(1));
    expect(toastMocks.warning.mock.calls[0]?.[0]).toContain("承認し直せ");
    expect(toastMocks.success).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(
      useCodexStructureExtractionStore.getState().projection,
    ).not.toBeNull();
  });

  it("一部が取り込めたときは報告した上で閉じる", async () => {
    publishApprovedProjection();
    const onOpenChange = vi.fn();
    applyMock.mockImplementation(
      async (input: {
        onEntityApprovalsExcluded?: (
          excluded: readonly {
            proposalId: string;
            displayTitle: string;
            reason: string;
          }[],
        ) => void;
      }) => {
        input.onEntityApprovalsExcluded?.([
          { proposalId: "b1", displayTitle: "リク", reason: "stale-version" },
        ]);
        return 2;
      },
    );
    render(
      <CodexStructureExtractDialog
        open
        onOpenChange={onOpenChange}
        folderId="f1"
      />,
    );
    fireEvent.click(screen.getByTestId("codex-structure-apply"));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(toastMocks.warning).toHaveBeenCalledTimes(1);
    // 外れた提案名と、開き直せば承認し直せることを伝える（review は閉じる）。
    expect(toastMocks.warning.mock.calls[0]?.[0]).toContain("リク");
    expect(toastMocks.warning.mock.calls[0]?.[0]).toContain("開き直す");
    expect(toastMocks.success).toHaveBeenCalledTimes(1);
  });
});
