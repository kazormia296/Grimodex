import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useTreeStore, type TreeNodeData } from "./treeStore";

const { mockHistoryPush, mockHistoryGetState } = vi.hoisted(() => {
  const mockHistoryPush = vi.fn();
  const mockHistoryGetState = vi.fn(() => ({
    isReplaying: false,
    push: mockHistoryPush,
  }));
  return { mockHistoryPush, mockHistoryGetState };
});

vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi.fn().mockImplementation((node) => Promise.resolve(node)),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: { getState: () => ({ recomputeSceneOrder: vi.fn() }) },
}));

vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: { getState: mockHistoryGetState },
}));

const SCENE: TreeNodeData = {
  id: "scene-1",
  projectId: "p",
  parentId: "ch-1",
  nodeType: "scene" as const,
  title: "Scene 1",
  synopsis: null,
  sortOrder: "a1",
  status: null,
  intent: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  chronicleStartTime: 100,
  chronicleStartMinute: null,
  chronicleStartGranularity: "day",
  chronicleEndTime: null,
  chronicleEndMinute: null,
  chronicleEndGranularity: "none",
  chroniclePrecision: "exact",
  charCount: 0,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function reset(over: Partial<TreeNodeData> = {}) {
  useTreeStore.setState({
    nodes: [{ ...SCENE, ...over }],
    selectedIds: [],
    activeSceneId: "",
    filterQuery: "",
    expandedIds: [],
  });
  mockHistoryPush.mockClear();
  mockHistoryGetState.mockClear();
}

describe("updateChronicleDate (tracked)", () => {
  beforeEach(() => reset());
  afterEach(() => vi.clearAllMocks());

  it("日付を反映し history に push する（作中日付クリアも undo 可能）", async () => {
    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: null });
    const node = useTreeStore.getState().nodes.find((n) => n.id === "scene-1");
    expect(node?.chronicleStartTime).toBeNull();
    expect(mockHistoryPush).toHaveBeenCalledOnce();
  });

  it("undo で旧値(=クリア前の日付)へ戻す", async () => {
    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: null });
    const { undo } = mockHistoryPush.mock.calls[0][0];
    await undo();
    const node = useTreeStore.getState().nodes.find((n) => n.id === "scene-1");
    expect(node?.chronicleStartTime).toBe(100); // 元の日付へ復元
  });

  it("開始/終了の変更も undo/redo できる", async () => {
    await useTreeStore.getState().updateChronicleDate("scene-1", {
      chronicleStartTime: 200,
      chronicleEndTime: 300,
    });
    const { undo, redo } = mockHistoryPush.mock.calls[0][0];
    await undo();
    let n = useTreeStore.getState().nodes.find((x) => x.id === "scene-1");
    expect(n?.chronicleStartTime).toBe(100);
    expect(n?.chronicleEndTime).toBeNull();
    await redo();
    n = useTreeStore.getState().nodes.find((x) => x.id === "scene-1");
    expect(n?.chronicleStartTime).toBe(200);
    expect(n?.chronicleEndTime).toBe(300);
  });

  it("実変更が無ければ no-op（history を汚さない）", async () => {
    const { updateNode } = await import("./api");
    (updateNode as ReturnType<typeof vi.fn>).mockClear();
    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: 100 }); // 同値
    expect(mockHistoryPush).not.toHaveBeenCalled();
    expect(updateNode).not.toHaveBeenCalled();
  });

  it("isReplaying 中は push しない", async () => {
    mockHistoryGetState.mockReturnValueOnce({
      isReplaying: true,
      push: mockHistoryPush,
    });
    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: 999 });
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });
});

describe("updatePovCharacter / updateLocation (tracked)", () => {
  beforeEach(() => reset());
  afterEach(() => vi.clearAllMocks());

  it("POV 変更を push し、undo で戻す", async () => {
    await useTreeStore.getState().updatePovCharacter("scene-1", "c1");
    expect(mockHistoryPush).toHaveBeenCalledOnce();
    const { undo } = mockHistoryPush.mock.calls[0][0];
    await undo();
    expect(
      useTreeStore.getState().nodes.find((n) => n.id === "scene-1")
        ?.povCharacterId,
    ).toBeNull();
  });

  it("POV 同値は no-op（ドラッグの空振りで履歴を汚さない）", async () => {
    reset({ povCharacterId: "c1" });
    await useTreeStore.getState().updatePovCharacter("scene-1", "c1");
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });

  it("場所変更を push し、undo で戻す", async () => {
    reset({ locationId: "loc0" });
    await useTreeStore.getState().updateLocation("scene-1", "loc1");
    expect(mockHistoryPush).toHaveBeenCalledOnce();
    const { undo } = mockHistoryPush.mock.calls[0][0];
    await undo();
    expect(
      useTreeStore.getState().nodes.find((n) => n.id === "scene-1")?.locationId,
    ).toBe("loc0");
  });
});
