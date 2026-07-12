import { describe, it, expect, beforeEach, vi } from "vitest";
import * as api from "./api";
import { useTreeStore } from "./treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";

const { mockRecomputeSceneOrder } = vi.hoisted(() => ({
  mockRecomputeSceneOrder: vi.fn(),
}));

vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi
    .fn()
    .mockImplementation((node: Record<string, unknown>) =>
      Promise.resolve(node),
    ),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn(),
  loadSceneContent: vi.fn().mockResolvedValue(""),
  saveSceneContent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/features/attribution/api", () => ({
  loadBatchAiRatio: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: { getState: () => ({}) },
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({
      closeTab: vi.fn(),
      closeSecondaryTab: vi.fn(),
    }),
  },
}));

vi.mock("./codexQuickPinApi", () => ({
  listPinnedCodexIds: vi.fn().mockResolvedValue([]),
  addPinnedCodex: vi.fn(),
  removePinnedCodex: vi.fn(),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: {
    getState: () => ({ recomputeSceneOrder: mockRecomputeSceneOrder }),
  },
}));

const baseNode = {
  projectId: "proj-1",
  parentId: null as string | null,
  nodeType: "folder" as const,
  title: "F",
  sortOrder: "a0",
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
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.deleteNode).mockReset().mockResolvedValue(undefined);
  useTreeStore.setState({
    nodes: [],
    projectId: "proj-1",
    selectedIds: [],
    activeSceneId: "",
    expandedIds: [],
  });
  useGlobalHistoryStore.getState().clear();
});

describe("treeStore.deleteNode Phase scene-time invalidation", () => {
  it("recomputes the index after delete undo and redo", async () => {
    useTreeStore.setState({ nodes: [{ ...baseNode, id: "folder" }] });

    await useTreeStore.getState().deleteNode("folder");
    const command = useGlobalHistoryStore.getState().past.at(-1);
    expect(command).toBeDefined();

    mockRecomputeSceneOrder.mockClear();
    await command!.undo();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledTimes(1);
    expect(useTreeStore.getState().nodes).toContainEqual(
      expect.objectContaining({ id: "folder" }),
    );
    expect(mockRecomputeSceneOrder).toHaveBeenLastCalledWith(
      useTreeStore.getState().nodes,
    );

    await command!.redo();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledTimes(2);
    expect(useTreeStore.getState().nodes).not.toContainEqual(
      expect.objectContaining({ id: "folder" }),
    );
    expect(mockRecomputeSceneOrder).toHaveBeenLastCalledWith(
      useTreeStore.getState().nodes,
    );
  });
});

describe("treeStore.deleteNode partial failure", () => {
  it("on partial failure, syncs only successfully-deleted ids and skips history push", async () => {
    // Tree:  parent -> [childA, childB]
    useTreeStore.setState({
      nodes: [
        { ...baseNode, id: "parent" },
        { ...baseNode, id: "childA", parentId: "parent" },
        { ...baseNode, id: "childB", parentId: "parent" },
      ],
    });

    // Leaf-first reverse iteration: childB, childA, parent.
    // Make childA fail. childB should be deleted; childA + parent retained.
    let callCount = 0;
    vi.mocked(api.deleteNode).mockImplementation(async (id: string) => {
      callCount++;
      if (id === "childA") throw new Error("FK violation");
      return undefined;
    });

    await useTreeStore.getState().deleteNode("parent");

    const remaining = useTreeStore.getState().nodes.map((n) => n.id);
    // childB succeeded; childA + parent remain in state because deletion broke
    expect(remaining).toEqual(expect.arrayContaining(["parent", "childA"]));
    expect(remaining).not.toContain("childB");

    // No history entry was pushed because the delete is half-completed
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);

    // Sanity: api.deleteNode was attempted at least up through the failure
    expect(callCount).toBeGreaterThanOrEqual(2);
  });
});
