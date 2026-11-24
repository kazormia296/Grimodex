// @vitest-environment happy-dom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  language: "ja",
  restore: vi.fn(),
  openEditor: vi.fn(),
  onEvidenceClick: vi.fn(),
  evidence: {
    anchorId: "a1",
    quote: "その夜、彼は戻った。",
    documentRef: "scene:s1",
    sceneId: "s1",
    sceneTitle: "第一章",
    method: "exact" as const,
  },
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
  getCurrentProjectLanguage: () => state.language || "ja",
}));
vi.mock("@/application/editor/openEditorDocument", () => ({
  openEditorDocument: state.openEditor,
}));
vi.mock("@/features/editor/editorNavigationPorts", () => ({
  defaultEditorNavigationPorts: {},
}));
vi.mock(
  "@/features/narrative-extraction/runtime/narrativeRuntimePolicyApi",
  () => ({
    getNarrativeRuntimePolicy: vi.fn(async () => ({
      runtimeMode: "review-only",
      effectiveMode: "review-only",
      maintenanceEnabled: false,
      maintenancePreviewAllowed: false,
      genericImportEnabled: false,
      backgroundAiEnabled: false,
    })),
  }),
);
vi.mock("./codexStructureExtractionApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./codexStructureExtractionApi")>()),
  restoreCodexStructureExtractionReview: state.restore,
}));
vi.mock("./CodexEntityProposalReview", async () => {
  const { createElement } = await import("react");
  return {
    CodexEntityProposalReview: ({
      onEvidenceClick,
    }: {
      onEvidenceClick?: typeof state.onEvidenceClick;
    }) =>
      createElement(
        "button",
        { onClick: () => onEvidenceClick?.(state.evidence) },
        "Entity evidence",
      ),
  };
});
vi.mock("./CodexRelationProposalReview", async () => {
  const { createElement } = await import("react");
  return {
    CodexRelationProposalReview: ({
      onEvidenceClick,
    }: {
      onEvidenceClick?: typeof state.onEvidenceClick;
    }) =>
      createElement(
        "button",
        { onClick: () => onEvidenceClick?.(state.evidence) },
        "Relation evidence",
      ),
  };
});

import { CodexExtractionEvidencePane } from "./CodexExtractionEvidencePane";
import { CodexStructureExtractDialog } from "./CodexStructureExtractDialog";
import {
  resetCodexStructureExtractionStoreForTests,
  useCodexStructureExtractionStore,
  type CodexStructureExtractionReviewProjection,
} from "./codexStructureExtractionStore";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";

function projection(
  folderId: string,
  counts: { phases?: number; details?: number } = {},
): CodexStructureExtractionReviewProjection {
  return {
    runId: `run-${folderId}`,
    projectId: "p1",
    workspacePath: "/w",
    openRevision: 1,
    proposalSetId: "ps-1",
    folderId,
    status: "completed",
    coverage: {},
    taskCounts: {
      queued: 0,
      running: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    },
    proposals: [],
    relationProposals: [],
    baseDetailProposals: [],
    phaseProposals: [],
    entityCount: 3,
    relationCount: 0,
    baseDetailCount: counts.details ?? 0,
    phaseCount: counts.phases ?? 0,
    unresolvedCount: 0,
    approvedCount: 0,
    catalog: null,
  };
}

function setup() {
  useWorkspaceStore.setState({
    activeWorkspacePath: "/w",
    workspaceOpenRevision: 1,
  } as never);
  useTreeStore.setState({
    nodes: [
      {
        id: "f1",
        parentId: null,
        nodeType: "folder",
        title: "章1",
        sortOrder: "a",
      },
      {
        id: "f2",
        parentId: null,
        nodeType: "folder",
        title: "章2",
        sortOrder: "b",
      },
    ],
  } as never);
}

describe("Codex structure review dialog", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    state.language = "ja";
    state.restore.mockReset().mockResolvedValue(null);
    state.openEditor.mockReset();
    setup();
  });

  it("hides the empty States & Phases tab and shows it when either count is nonzero", () => {
    const { rerender } = render(
      <CodexStructureExtractDialog open onOpenChange={vi.fn()} folderId="f1" />,
    );
    act(() =>
      useCodexStructureExtractionStore.setState({
        projection: projection("f1"),
      }),
    );
    expect(screen.queryByTestId("codex-structure-tab-states")).toBeNull();

    act(() =>
      useCodexStructureExtractionStore.setState({
        projection: projection("f1", { phases: 1 }),
      }),
    );
    expect(screen.getByTestId("codex-structure-tab-states")).toHaveTextContent(
      "1",
    );
    rerender(
      <CodexStructureExtractDialog open onOpenChange={vi.fn()} folderId="f1" />,
    );
  });

  it("renders quotes as buttons only when a scene and click handler exist", () => {
    const quote = state.evidence;
    const { rerender } = render(
      <CodexExtractionEvidencePane
        proposal={{ evidence: [quote], blockedReason: undefined }}
      />,
    );
    expect(screen.getByTestId("codex-evidence-quote-a1").tagName).toBe("DIV");
    rerender(
      <CodexExtractionEvidencePane
        proposal={{ evidence: [quote], blockedReason: undefined }}
        onEvidenceClick={state.onEvidenceClick}
      />,
    );
    expect(screen.getByTestId("codex-evidence-quote-a1").tagName).toBe(
      "BUTTON",
    );
    rerender(
      <CodexExtractionEvidencePane
        proposal={{
          evidence: [{ ...quote, sceneId: undefined }],
          blockedReason: undefined,
        }}
        onEvidenceClick={state.onEvidenceClick}
      />,
    );
    expect(screen.getByTestId("codex-evidence-quote-a1").tagName).toBe("DIV");
  });

  it.each(["entity", "relation"] as const)(
    "opens evidence scene and closes the modal from the %s review",
    (tab) => {
      useCodexStructureExtractionStore
        .getState()
        .setProjection(projection("f1"));
      const onOpenChange = vi.fn();
      render(
        <CodexStructureExtractDialog
          open
          onOpenChange={onOpenChange}
          folderId="f1"
        />,
      );
      if (tab === "relation") {
        fireEvent.click(screen.getByTestId("codex-structure-tab-relation"));
      }
      fireEvent.click(
        screen.getByRole("button", {
          name: `${tab === "entity" ? "Entity" : "Relation"} evidence`,
        }),
      );
      expect(state.openEditor).toHaveBeenCalledWith(
        expect.objectContaining({
          target: { kind: "scene", documentId: "s1" },
        }),
        expect.anything(),
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    },
  );

  it.each([
    ["en", true],
    ["ja", false],
    ["", false],
  ])("gates analysis for project language %s", (language, unsupported) => {
    state.language = language;
    render(
      <CodexStructureExtractDialog open onOpenChange={vi.fn()} folderId="f1" />,
    );
    expect(
      screen.getByTestId("codex-structure-analyze").hasAttribute("disabled"),
    ).toBe(unsupported);
    expect(
      screen.queryByTestId("codex-structure-unsupported-language") !== null,
    ).toBe(unsupported);
  });

  it("restores a selected folder; ignores missing, failed, and stale responses", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <CodexStructureExtractDialog open onOpenChange={onOpenChange} />,
    );
    const selectFolder = (folderId: string) =>
      fireEvent.change(screen.getByTestId("codex-structure-folder-select"), {
        target: { value: folderId },
      });

    state.restore.mockResolvedValueOnce(projection("f1"));
    selectFolder("f1");
    await waitFor(() =>
      expect(state.restore).toHaveBeenCalledWith({
        projectId: "p1",
        workspacePath: "/w",
        openRevision: 1,
        folderId: "f1",
      }),
    );
    await waitFor(() =>
      expect(
        useCodexStructureExtractionStore.getState().projection?.runId,
      ).toBe("run-f1"),
    );

    resetCodexStructureExtractionStoreForTests();
    state.restore.mockResolvedValueOnce(null);
    selectFolder("f2");
    await waitFor(() =>
      expect(state.restore).toHaveBeenLastCalledWith(
        expect.objectContaining({ folderId: "f2" }),
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    state.restore.mockRejectedValueOnce(new Error("restore failed"));
    selectFolder("f1");
    await waitFor(() =>
      expect(state.restore).toHaveBeenLastCalledWith(
        expect.objectContaining({ folderId: "f1" }),
      ),
    );
    expect(screen.queryByRole("alert")).toBeNull();

    let resolveOld!: (value: CodexStructureExtractionReviewProjection) => void;
    state.restore
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveOld = resolve;
          }),
      )
      .mockResolvedValueOnce(projection("f2"));
    selectFolder("f1");
    selectFolder("f2");
    await waitFor(() =>
      expect(
        useCodexStructureExtractionStore.getState().projection?.folderId,
      ).toBe("f2"),
    );
    resolveOld(projection("f1"));
    await waitFor(() =>
      expect(
        useCodexStructureExtractionStore.getState().projection?.folderId,
      ).toBe("f2"),
    );
    rerender(<CodexStructureExtractDialog open onOpenChange={onOpenChange} />);
  });
});
