// @vitest-environment happy-dom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  listEvents: vi.fn(),
}));
vi.mock("./api", () => apiMocks);

const extractionMocks = vi.hoisted(() => ({
  proposeEvents: vi.fn(),
  importExtractedEvents: vi.fn(),
}));
vi.mock("./extractEventsApi", () => extractionMocks);

const editorMocks = vi.hoisted(() => ({
  saveScene: vi.fn(),
}));
vi.mock("@/features/editor/editorSaveRegistry", () => editorMocks);

const treeApiMocks = vi.hoisted(() => ({
  loadSceneContents: vi.fn(),
}));
vi.mock("@/features/tree/api", () => treeApiMocks);

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
vi.mock("sonner", () => ({ toast: toastMocks }));

import { ChronicleExtractDialog } from "./ChronicleExtractDialog";
import type { ChronicleScope } from "./chronicleScope";
import { useTreeStore, type TreeNodeData } from "@/features/tree/treeStore";
import { useProjectStore } from "@/features/project/projectStore";
import { useWorkspaceStore } from "@/features/workspace/store";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { _resetMutationAuthorityForTests } from "@/features/concurrency/mutationAuthority";

const SCOPE_A: ChronicleScope = {
  workspacePath: "/workspace-a",
  openRevision: 1,
  projectId: "project-a",
};
const SCOPE_B: ChronicleScope = {
  workspacePath: "/workspace-b",
  openRevision: 2,
  projectId: "project-b",
};

function node(
  id: string,
  nodeType: "folder" | "scene",
  parentId: string | null,
): TreeNodeData {
  return {
    id,
    projectId: "project-a",
    parentId,
    nodeType,
    title: id,
    synopsis: null,
    intent: null,
    sortOrder: id,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-07-29T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}

function publishScope(scope: ChronicleScope): void {
  useProjectStore.setState({ currentProjectId: scope.projectId });
  useWorkspaceStore.setState({
    activeWorkspaceId:
      scope.projectId === "project-a" ? "workspace-a-id" : "workspace-b-id",
    activeWorkspacePath: scope.workspacePath,
    workspaceOpenRevision: scope.openRevision,
    workspaceSwitchInProgress: false,
    workspaceHydrated: true,
  });
  setCurrentWorkspaceIdentity({
    path: scope.workspacePath,
    openRevision: scope.openRevision,
  });
}

async function analyze(): Promise<void> {
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: "folder-a" },
  });
  fireEvent.click(screen.getByRole("button", { name: "解析" }));
  await waitFor(() => expect(extractionMocks.proposeEvents).toHaveBeenCalled());
}

describe("ChronicleExtractDialog scope authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetMutationAuthorityForTests();
    publishScope(SCOPE_A);
    useTreeStore.setState({
      activeSceneId: "",
      nodes: [
        node("folder-a", "folder", null),
        node("scene-a", "scene", "folder-a"),
      ],
    });
    apiMocks.listEvents.mockResolvedValue([]);
    treeApiMocks.loadSceneContents.mockResolvedValue(
      new Map([
        [
          "scene-a",
          JSON.stringify({
            type: "doc",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "本文" }],
              },
            ],
          }),
        ],
      ]),
    );
    extractionMocks.proposeEvents.mockResolvedValue([
      {
        title: "抽出候補",
        evidenceSceneIds: ["scene-a"],
      },
    ]);
    extractionMocks.importExtractedEvents.mockResolvedValue(1);
  });

  it("分析時に固定したProjectへ取り込み、現在Projectを取り直さない", async () => {
    const onOpenChange = vi.fn();
    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    await analyze();
    expect(await screen.findByText("抽出候補")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));

    await waitFor(() =>
      expect(extractionMocks.importExtractedEvents).toHaveBeenCalledWith(
        "project-a",
        [{ title: "抽出候補", evidenceSceneIds: ["scene-a"] }],
      ),
    );
    expect(toastMocks.success).toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("候補表示後にProject authorityが変わるとimport直前に拒否する", async () => {
    const onOpenChange = vi.fn();
    render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    await analyze();
    expect(await screen.findByText("抽出候補")).toBeTruthy();
    publishScope(SCOPE_B);
    fireEvent.click(screen.getByRole("button", { name: "取り込む" }));

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(extractionMocks.importExtractedEvents).not.toHaveBeenCalled();
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it("LLM待機中にscopeが変わると候補を破棄してDialogを閉じる", async () => {
    let resolveProposal!: (
      value: Array<{ title: string; evidenceSceneIds: string[] }>,
    ) => void;
    extractionMocks.proposeEvents.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveProposal = resolve;
      }),
    );
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    await analyze();
    publishScope(SCOPE_B);
    rerender(
      <ChronicleExtractDialog
        open
        scope={SCOPE_B}
        isActive
        onOpenChange={onOpenChange}
      />,
    );
    await act(async () => {
      resolveProposal([{ title: "古い候補", evidenceSceneIds: ["scene-a"] }]);
      await Promise.resolve();
    });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(screen.queryByText("古い候補")).toBeNull();
    expect(extractionMocks.importExtractedEvents).not.toHaveBeenCalled();
  });

  it("非アクティブ化するとPortal上のDialogも閉じる", async () => {
    const onOpenChange = vi.fn();
    const { rerender } = render(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive
        onOpenChange={onOpenChange}
      />,
    );

    rerender(
      <ChronicleExtractDialog
        open
        scope={SCOPE_A}
        isActive={false}
        onOpenChange={onOpenChange}
      />,
    );

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
