// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockListNodes = vi.fn();
const mockListNoteContents = vi.fn();
const mockListPinnedCodexIds = vi.fn();
const mockLoadBatchAiRatio = vi.hoisted(() => vi.fn());

vi.mock("./api", () => ({
  listNodes: (...args: unknown[]) => mockListNodes(...args),
  listNoteContents: (...args: unknown[]) => mockListNoteContents(...args),
}));

vi.mock("@/application/project/currentProjectAuthority", () => ({
  getCurrentProjectId: () => "p1",
}));

vi.mock("@/features/settings/api", () => ({
  getProjectSetting: vi.fn(),
}));

vi.mock("@/features/attribution/api", () => ({
  loadBatchAiRatio: (...args: unknown[]) => mockLoadBatchAiRatio(...args),
}));

vi.mock("./codexQuickPinApi", () => ({
  listPinnedCodexIds: (...args: unknown[]) => mockListPinnedCodexIds(...args),
  addPinnedCodex: vi.fn(),
  removePinnedCodex: vi.fn(),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: {
    getState: () => ({
      recomputeSceneOrder: vi.fn(),
    }),
  },
}));

import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { useTreeStore } from "./treeStore";

// listNodes は H4 projection で content / unplacedBeatsDoc を返さない
// (TreeNodeLite 相当の行)。note 本文は listNoteContents の別クエリで来る。
function sceneNode(id: string, sortOrder: string) {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene" as const,
    title: id,
    synopsis: null,
    sortOrder,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    status: "outline",
    charCount: 0,
    unplacedBeatPreview: null,
    placedBeatPreview: null,
    sourceUri: null,
    sourceMtime: null,
    archivedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("loadTree activeSceneId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setCurrentWorkspaceIdentity(null);
    mockListNoteContents.mockResolvedValue(new Map<string, string>());
    mockListPinnedCodexIds.mockResolvedValue([]);
    mockLoadBatchAiRatio.mockResolvedValue({});
    useTreeStore.setState({
      activeSceneId: "scene-b",
      nodes: [],
      scenes: [],
      isLoading: false,
      hydratedProjectId: null,
      hydratedWorkspaceOpenRevision: null,
      showAiAttribution: false,
      aiRatios: {},
    });
  });

  it("preserves activeSceneId when the active node still exists after reload", async () => {
    mockListNodes.mockResolvedValue([
      sceneNode("scene-a", "a0"),
      sceneNode("scene-b", "a1"),
    ]);

    await useTreeStore.getState().loadTree("p1");

    expect(useTreeStore.getState().activeSceneId).toBe("scene-b");
    expect(mockLoadBatchAiRatio).toHaveBeenCalledExactlyOnceWith(["scene-b"]);
  });

  it("keeps scene bodies out of store but loads note content", async () => {
    mockListNodes.mockResolvedValue([
      sceneNode("scene-a", "a0"),
      {
        ...sceneNode("note-a", "a1"),
        nodeType: "note" as const,
        title: "Note",
        contextMode: "mentioned",
        aliases: "[]",
        excludedAliases: "[]",
      },
    ]);
    // note 本文は 2 段目クエリ (listNoteContents) から来る。scene id が
    // 混入しても nodeType ゲートで store には載らないこと (不変条件) も見る。
    mockListNoteContents.mockResolvedValue(
      new Map([
        [
          "note-a",
          '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"note body"}]}]}',
        ],
        [
          "scene-a",
          '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"scene body"}]}]}',
        ],
      ]),
    );

    await useTreeStore.getState().loadTree("p1");

    expect(mockListNoteContents).toHaveBeenCalledWith("p1");
    const scene = useTreeStore.getState().nodes.find((n) => n.id === "scene-a");
    const note = useTreeStore.getState().nodes.find((n) => n.id === "note-a");
    expect(scene?.content).toBeUndefined();
    expect(note?.content).toContain("note body");
  });

  it("falls back to the first scene when the previous active node is gone", async () => {
    mockListNodes.mockResolvedValue([sceneNode("scene-a", "a0")]);

    await useTreeStore.getState().loadTree("p1");

    expect(useTreeStore.getState().activeSceneId).toBe("scene-a");
  });

  it("records the project and workspace revision of a successful hydration", async () => {
    mockListNodes.mockResolvedValue([]);

    await useTreeStore.getState().loadTree("p1", 27);

    expect(useTreeStore.getState()).toMatchObject({
      hydratedProjectId: "p1",
      hydratedWorkspaceOpenRevision: 27,
      isLoading: false,
    });
  });

  it("publishes target-revision sidecars before Workspace identity publication", async () => {
    mockListNodes.mockResolvedValue([sceneNode("scene-a", "a0")]);
    mockLoadBatchAiRatio.mockResolvedValue({ "scene-a": 72 });
    mockListPinnedCodexIds.mockResolvedValue(["codex-1"]);

    await useTreeStore.getState().loadTree("p1", 27);

    expect(mockLoadBatchAiRatio).toHaveBeenCalledWith(["scene-a"]);
    expect(useTreeStore.getState()).toMatchObject({
      hydratedProjectId: "p1",
      hydratedWorkspaceOpenRevision: 27,
      aiRatios: { "scene-a": 72 },
      pinnedCodexIds: ["codex-1"],
    });
  });

  it("preserves the previous hydration identity when a two-phase load fails", async () => {
    useTreeStore.setState({
      hydratedProjectId: "p1",
      hydratedWorkspaceOpenRevision: 26,
    });
    mockListNodes.mockRejectedValue(new Error("tree unavailable"));

    await useTreeStore.getState().loadTree("p1", 27);

    expect(useTreeStore.getState()).toMatchObject({
      hydratedProjectId: "p1",
      hydratedWorkspaceOpenRevision: 26,
      isLoading: false,
    });
  });

  it("does not publish pinned Codex IDs from a stale hydration", async () => {
    let resolvePins!: (ids: string[]) => void;
    mockListPinnedCodexIds.mockReturnValueOnce(
      new Promise<string[]>((resolve) => {
        resolvePins = resolve;
      }),
    );
    useTreeStore.setState({
      hydratedProjectId: "p1",
      hydratedWorkspaceOpenRevision: null,
      pinnedCodexIds: [],
    });

    const staleLoad = useTreeStore.getState().loadPinnedCodexIds();
    useTreeStore.setState({
      hydratedProjectId: "p2",
      hydratedWorkspaceOpenRevision: null,
      pinnedCodexIds: ["p2-pin"],
    });
    resolvePins(["p1-pin"]);
    await staleLoad;

    expect(useTreeStore.getState().pinnedCodexIds).toEqual(["p2-pin"]);
  });

  it("loads all Scene attribution ratios only when the badge is enabled", async () => {
    mockListNodes.mockResolvedValue([
      sceneNode("scene-a", "a0"),
      sceneNode("scene-b", "a1"),
    ]);
    mockLoadBatchAiRatio
      .mockResolvedValueOnce({ "scene-b": 12 })
      .mockResolvedValueOnce({ "scene-a": 25, "scene-b": 12 });

    await useTreeStore.getState().loadTree("p1");
    mockLoadBatchAiRatio.mockClear();
    useTreeStore.getState().setShowAiAttribution(true);

    await vi.waitFor(() =>
      expect(useTreeStore.getState().aiRatios).toEqual({
        "scene-a": 25,
        "scene-b": 12,
      }),
    );
    expect(mockLoadBatchAiRatio).toHaveBeenCalledExactlyOnceWith([
      "scene-a",
      "scene-b",
    ]);
  });
});
