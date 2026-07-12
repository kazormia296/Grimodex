import { describe, it, expect, beforeEach, vi } from "vitest";
import * as api from "./api";
import { useTreeStore } from "./treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";

const { mockRecomputeSceneOrder } = vi.hoisted(() => ({
  mockRecomputeSceneOrder: vi.fn(),
}));

vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi.fn().mockResolvedValue(undefined),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: {
    getState: () => ({ recomputeSceneOrder: mockRecomputeSceneOrder }),
  },
}));

const updateNode = vi.mocked(api.updateNode);

const DEFAULTS = {
  synopsis: null,

  intent: null,
  status: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  charCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  useGlobalHistoryStore.setState({
    past: [],
    future: [],
    canUndo: false,
    canRedo: false,
    isReplaying: false,
  });
  useTreeStore.setState({
    nodes: [
      {
        id: "P",
        projectId: "proj-1",
        parentId: null,
        nodeType: "folder",
        title: "Part",
        sortOrder: "a0",
        ...DEFAULTS,
      },
      {
        id: "ch1",
        projectId: "proj-1",
        parentId: "P",
        nodeType: "folder",
        title: "Chapter 1",
        sortOrder: "a0",
        ...DEFAULTS,
      },
      {
        id: "ch2",
        projectId: "proj-1",
        parentId: null,
        nodeType: "folder",
        title: "Chapter 2",
        sortOrder: "a1",
        ...DEFAULTS,
      },
    ],
    projectId: "proj-1",
    selectedIds: [],
    activeSceneId: "",
    expandedIds: [],
  });
});

describe("moveNode parentId persistence", () => {
  it("passes parentId=null to api.updateNode when moving a folder out to root", async () => {
    // Regression: previously `parentId: newParentId ?? undefined` coerced null
    // to undefined; Drizzle then dropped the column from the SET clause and
    // the move-to-root never reached the DB, so a restart "lost" the move.
    await useTreeStore.getState().moveNode("ch1", null, "P");

    expect(updateNode).toHaveBeenCalledTimes(1);
    const [id, data] = updateNode.mock.calls[0]!;
    expect(id).toBe("ch1");
    expect(data.parentId).toBeNull();
    expect("parentId" in data).toBe(true);
  });

  it("passes parentId=<folderId> to api.updateNode when moving into another folder", async () => {
    await useTreeStore.getState().moveNode("ch2", "P", undefined);

    expect(updateNode).toHaveBeenCalledTimes(1);
    const [id, data] = updateNode.mock.calls[0]!;
    expect(id).toBe("ch2");
    expect(data.parentId).toBe("P");
  });

  it("undo of move-to-root restores parentId to the original folder (not undefined)", async () => {
    await useTreeStore.getState().moveNode("ch1", null, "P");
    updateNode.mockClear();

    const top = useGlobalHistoryStore.getState().past.at(-1);
    expect(top?.kind).toBe("scenes");
    await top!.undo();

    expect(updateNode).toHaveBeenCalledTimes(1);
    const [, data] = updateNode.mock.calls[0]!;
    expect(data.parentId).toBe("P");
  });

  it("undo of move-into-folder restores parentId=null (not undefined) when original was root", async () => {
    await useTreeStore.getState().moveNode("ch2", "P", undefined);
    updateNode.mockClear();

    const top = useGlobalHistoryStore.getState().past.at(-1);
    await top!.undo();

    expect(updateNode).toHaveBeenCalledTimes(1);
    const [, data] = updateNode.mock.calls[0]!;
    expect(data.parentId).toBeNull();
    expect("parentId" in data).toBe(true);
  });

  it("recomputes Phase scene time after move undo and redo", async () => {
    await useTreeStore.getState().moveNode("ch1", null, "P");
    const command = useGlobalHistoryStore.getState().past.at(-1);
    expect(command).toBeDefined();

    mockRecomputeSceneOrder.mockClear();
    await command!.undo();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledTimes(1);
    expect(mockRecomputeSceneOrder).toHaveBeenLastCalledWith(
      useTreeStore.getState().nodes,
    );

    await command!.redo();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledTimes(2);
    expect(mockRecomputeSceneOrder).toHaveBeenLastCalledWith(
      useTreeStore.getState().nodes,
    );
  });
});
