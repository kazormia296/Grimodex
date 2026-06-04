import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useTreeStore } from "./treeStore";

const { mockRecomputeSceneOrder, mockHistoryPush, mockHistoryGetState } =
  vi.hoisted(() => {
    const mockHistoryPush = vi.fn();
    const mockHistoryGetState = vi.fn(() => ({
      isReplaying: false,
      push: mockHistoryPush,
    }));
    return {
      mockRecomputeSceneOrder: vi.fn(),
      mockHistoryPush,
      mockHistoryGetState,
    };
  });

vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi.fn().mockImplementation((node) => Promise.resolve(node)),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: {
    getState: () => ({ recomputeSceneOrder: mockRecomputeSceneOrder }),
  },
}));

vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: {
    getState: mockHistoryGetState,
  },
}));

const NODE_DEFAULTS = {
  intent: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  createdAt: "2024-01-01T00:00:00Z",

  charCount: 0,
  updatedAt: "2024-01-01T00:00:00Z",
} as const;

const SCENE = {
  id: "scene-1",
  projectId: "p",
  parentId: "ch-1",
  nodeType: "scene" as const,
  title: "Scene 1",
  synopsis: null,
  sortOrder: "a1",
  status: null,
  ...NODE_DEFAULTS,
};

function resetStore() {
  useTreeStore.setState({
    nodes: [SCENE],
    selectedIds: [],
    activeSceneId: "",
    filterQuery: "",
    expandedIds: [],
  });
  mockRecomputeSceneOrder.mockClear();
  mockHistoryPush.mockClear();
  mockHistoryGetState.mockClear();
}

describe("updateStoryTime", () => {
  beforeEach(resetStore);
  afterEach(() => vi.clearAllMocks());

  it("storyTimeOrder と storyTimeLabel をノードに反映する", async () => {
    await useTreeStore
      .getState()
      .updateStoryTime("scene-1", "a0V", "帝国暦1000年");
    const node = useTreeStore.getState().nodes.find((n) => n.id === "scene-1");
    expect(node?.storyTimeOrder).toBe("a0V");
    expect(node?.storyTimeLabel).toBe("帝国暦1000年");
  });

  it("label が undefined のとき既存 label を保持する", async () => {
    useTreeStore.setState({
      nodes: [{ ...SCENE, storyTimeLabel: "既存ラベル" }],
    });
    await useTreeStore.getState().updateStoryTime("scene-1", "a1");
    const node = useTreeStore.getState().nodes.find((n) => n.id === "scene-1");
    expect(node?.storyTimeLabel).toBe("既存ラベル");
  });

  it("order=null で Unscheduled にクリアする", async () => {
    useTreeStore.setState({
      nodes: [{ ...SCENE, storyTimeOrder: "a0V", storyTimeLabel: "旧ラベル" }],
    });
    await useTreeStore.getState().updateStoryTime("scene-1", null);
    const node = useTreeStore.getState().nodes.find((n) => n.id === "scene-1");
    expect(node?.storyTimeOrder).toBeNull();
    // label は null クリア時も保持される（設計書 L288）
    expect(node?.storyTimeLabel).toBe("旧ラベル");
  });

  it("recomputeSceneOrder を呼び出す", async () => {
    await useTreeStore.getState().updateStoryTime("scene-1", "a0V");
    expect(mockRecomputeSceneOrder).toHaveBeenCalledOnce();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledWith(
      useTreeStore.getState().nodes,
    );
  });

  it("history に push する", async () => {
    await useTreeStore.getState().updateStoryTime("scene-1", "a0V", "Day 1");
    expect(mockHistoryPush).toHaveBeenCalledOnce();
    const entry = mockHistoryPush.mock.calls[0][0];
    expect(entry).toHaveProperty("undo");
    expect(entry).toHaveProperty("redo");
  });

  it("isReplaying=true のとき history に push しない", async () => {
    mockHistoryGetState.mockReturnValueOnce({
      isReplaying: true,
      push: mockHistoryPush,
    });
    await useTreeStore.getState().updateStoryTime("scene-1", "a0V");
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });

  it("undo で旧値に戻り recomputeSceneOrder が再度呼ばれる", async () => {
    const { updateNode } = await import("./api");
    await useTreeStore.getState().updateStoryTime("scene-1", "a0V", "Day 1");

    const { undo } = mockHistoryPush.mock.calls[0][0];
    mockRecomputeSceneOrder.mockClear();
    await undo();

    const node = useTreeStore.getState().nodes.find((n) => n.id === "scene-1");
    expect(node?.storyTimeOrder).toBeNull();
    expect(node?.storyTimeLabel).toBeNull();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledOnce();
    expect(updateNode).toHaveBeenCalledWith("scene-1", {
      storyTimeOrder: undefined,
      storyTimeLabel: undefined,
    });
  });

  it("redo で新値を再適用し recomputeSceneOrder が再度呼ばれる", async () => {
    const { updateNode } = await import("./api");
    await useTreeStore.getState().updateStoryTime("scene-1", "a0V", "Day 1");

    const { redo } = mockHistoryPush.mock.calls[0][0];
    // undo してからの状態を模倣
    useTreeStore.setState({
      nodes: [{ ...SCENE, storyTimeOrder: null, storyTimeLabel: null }],
    });
    mockRecomputeSceneOrder.mockClear();
    await redo();

    const node = useTreeStore.getState().nodes.find((n) => n.id === "scene-1");
    expect(node?.storyTimeOrder).toBe("a0V");
    expect(node?.storyTimeLabel).toBe("Day 1");
    expect(mockRecomputeSceneOrder).toHaveBeenCalledOnce();
    expect(updateNode).toHaveBeenCalledWith("scene-1", {
      storyTimeOrder: "a0V",
      storyTimeLabel: "Day 1",
    });
  });

  it("存在しない id の場合は何もしない", async () => {
    const { updateNode } = await import("./api");
    await useTreeStore.getState().updateStoryTime("non-existent", "a0V");
    expect(updateNode).not.toHaveBeenCalled();
    expect(mockRecomputeSceneOrder).not.toHaveBeenCalled();
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });
});
