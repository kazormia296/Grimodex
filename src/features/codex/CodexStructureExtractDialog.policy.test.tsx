// @vitest-environment happy-dom
import { act, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createNewBindCodexEntityProposal } from "@/features/narrative-extraction/proposals/bindCodexEntityProposal";

const getPolicyMock = vi.hoisted(() => vi.fn());
vi.mock(
  "@/features/narrative-extraction/runtime/narrativeRuntimePolicyApi",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@/features/narrative-extraction/runtime/narrativeRuntimePolicyApi")
    >()),
    getNarrativeRuntimePolicy: getPolicyMock,
  }),
);
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("./codexStructureExtractionApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codexStructureExtractionApi")>()),
  restoreCodexStructureExtractionReview: vi.fn(async () => null),
}));

import { CodexStructureExtractDialog } from "./CodexStructureExtractDialog";
import {
  buildCodexEntityProposalSafetyFlags,
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
} from "./codexStructureExtractionStore";
import { useWorkspaceStore } from "@/features/workspace/store";

function policy(effectiveMode: "review-only" | "manual-apply" | "disabled") {
  return {
    runtimeMode: "review-only",
    effectiveMode,
    maintenanceEnabled: false,
    maintenancePreviewAllowed: false,
    genericImportEnabled: false,
    backgroundAiEnabled: false,
  };
}

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
  } as never);
}

describe("CodexStructureExtractDialog policy gating", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    getPolicyMock.mockReset();
    publishApprovedProjection();
  });

  const renderDialog = () =>
    render(
      <CodexStructureExtractDialog open onOpenChange={vi.fn()} folderId="f1" />,
    );

  it("review-only blocks apply using the effective mode, while analysis stays enabled", async () => {
    getPolicyMock.mockResolvedValue(policy("review-only"));
    renderDialog();

    expect(
      await screen.findByTestId("codex-structure-apply-blocked"),
    ).toHaveTextContent(
      "この作品では、Codex への取り込みはまだ使えません。承認・拒否は記録されます。",
    );
    expect(screen.getByTestId("codex-structure-apply")).toBeDisabled();
    expect(screen.getByTestId("codex-structure-analyze")).toBeEnabled();
  });

  it("manual-apply leaves apply enabled without a reason", async () => {
    getPolicyMock.mockResolvedValue(policy("manual-apply"));
    renderDialog();

    await waitFor(() => expect(getPolicyMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("codex-structure-apply")).toBeEnabled();
    expect(screen.queryByTestId("codex-structure-apply-blocked")).toBeNull();
  });

  it("disabled blocks analysis and apply with the engine-disabled reason", async () => {
    getPolicyMock.mockResolvedValue(policy("disabled"));
    renderDialog();

    expect(
      await screen.findByTestId("codex-structure-apply-blocked"),
    ).toHaveTextContent("構造抽出は、アプリの設定で止められています。");
    expect(screen.getByTestId("codex-structure-apply")).toBeDisabled();
    expect(screen.getByTestId("codex-structure-analyze")).toBeDisabled();
  });

  it("keeps controls available and hides the reason when policy lookup rejects", async () => {
    getPolicyMock.mockRejectedValue(new Error("policy unavailable"));
    renderDialog();

    await waitFor(() => expect(getPolicyMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("codex-structure-apply")).toBeEnabled();
    expect(screen.getByTestId("codex-structure-analyze")).toBeEnabled();
    expect(screen.queryByTestId("codex-structure-apply-blocked")).toBeNull();
  });
});
