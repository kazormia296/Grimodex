// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dbEntries = vi.hoisted(() => [
  { id: "riku", name: "リク", aliases: null, type: "character", version: 7 },
  { id: "sora", name: "ソラ", aliases: null, type: "character", version: 2 },
  { id: "tokyo", name: "東京", aliases: null, type: "location", version: 1 },
]);
const readEntriesMock = vi.hoisted(() => vi.fn());
const startMock = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));
vi.mock("./typeApi", () => ({ listCodexTypes: vi.fn(async () => []) }));
vi.mock("./codexRelationApi", () => ({
  listCodexRelations: vi.fn(async () => []),
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
  getCurrentProjectLanguage: () => "ja",
}));
vi.mock("./codexStructureExtractionApi", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./codexStructureExtractionApi")>();
  return {
    ...actual,
    readCurrentCodexEntries: readEntriesMock,
    startCodexStructureExtraction: startMock,
    restoreCodexStructureExtractionReview: vi.fn(async () => null),
  };
});

import { useCodexStore } from "./codexStore";
import { CodexStructureExtractDialog } from "./CodexStructureExtractDialog";
import { useTreeStore } from "@/features/tree/treeStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { resetCodexStructureExtractionStoreForTests } from "./codexStructureExtractionStore";

describe("CodexStructureExtractDialog の解析", () => {
  beforeEach(() => {
    resetCodexStructureExtractionStoreForTests();
    readEntriesMock.mockReset().mockResolvedValue(dbEntries);
    startMock.mockReset().mockResolvedValue({
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
        completed: 0,
        failed: 0,
        cancelled: 0,
      },
      proposals: [],
      relationProposals: [],
      baseDetailProposals: [],
      phaseProposals: [],
      entityCount: 0,
      relationCount: 0,
      baseDetailCount: 0,
      phaseCount: 0,
      unresolvedCount: 0,
      approvedCount: 0,
    });
    setCurrentWorkspaceIdentity({ path: "/w", openRevision: 1 });
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
          title: "章",
          sortOrder: "a",
        },
        {
          id: "s1",
          parentId: "f1",
          nodeType: "scene",
          title: "場面",
          sortOrder: "a",
        },
      ],
    } as never);
    useCodexStore.setState({
      filterType: "character",
      entries: [dbEntries[0]],
    } as never);
  });

  it("絞り込み中も DB の全 Entry を解析材料にする", async () => {
    render(
      <CodexStructureExtractDialog open onOpenChange={vi.fn()} folderId="f1" />,
    );
    fireEvent.click(screen.getByTestId("codex-structure-analyze"));
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    expect(readEntriesMock).toHaveBeenCalledWith("p1");
    expect(
      startMock.mock.calls[0]?.[0].existingEntries.map(
        (entry: {
          sourceKey: string;
          name: string;
          expectedVersion: number;
        }) => [entry.sourceKey, entry.name, entry.expectedVersion],
      ),
    ).toEqual([
      ["riku", "リク", 7],
      ["sora", "ソラ", 2],
      ["tokyo", "東京", 1],
    ]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("解析中にフォルダを選び直しても、解析の操作は止まったままにならない", async () => {
    useTreeStore.setState({
      nodes: [
        {
          id: "f1",
          parentId: null,
          nodeType: "folder",
          title: "章",
          sortOrder: "a",
        },
        {
          id: "s1",
          parentId: "f1",
          nodeType: "scene",
          title: "場面",
          sortOrder: "a",
        },
        {
          id: "f2",
          parentId: null,
          nodeType: "folder",
          title: "章2",
          sortOrder: "b",
        },
        {
          id: "s2",
          parentId: "f2",
          nodeType: "scene",
          title: "場面2",
          sortOrder: "a",
        },
      ],
    } as never);
    let release: (value: unknown) => void = () => undefined;
    startMock.mockReset().mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    render(
      <CodexStructureExtractDialog open onOpenChange={vi.fn()} folderId="f1" />,
    );
    fireEvent.click(screen.getByTestId("codex-structure-analyze"));
    await waitFor(() => expect(startMock).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("codex-structure-analyze")).toBeDisabled();
    fireEvent.change(screen.getByTestId("codex-structure-folder-select"), {
      target: { value: "f2" },
    });
    // 古い解析が、フォルダを選び直した後に終わる。結果は捨てられ、解析の操作は戻る。
    release({ runId: "old" });
    await waitFor(() =>
      expect(screen.getByTestId("codex-structure-analyze")).toBeEnabled(),
    );
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
