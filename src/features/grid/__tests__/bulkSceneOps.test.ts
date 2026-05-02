import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: vi.fn(),
  },
}));

import { useTreeStore } from "@/features/tree/treeStore";
import { moveScenesToChapter, deleteScenes } from "../bulkSceneOps";

const mockGetState = vi.mocked(useTreeStore.getState);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("moveScenesToChapter", () => {
  it("Grid 表示順を保ったまま各シーンを章末尾に移動する", async () => {
    const moveNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      moveNode,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await moveScenesToChapter(["s1", "s2", "s3"], "ch-target");

    expect(moveNode).toHaveBeenCalledTimes(3);
    expect(moveNode).toHaveBeenNthCalledWith(1, "s1", "ch-target", undefined);
    expect(moveNode).toHaveBeenNthCalledWith(2, "s2", "ch-target", undefined);
    expect(moveNode).toHaveBeenNthCalledWith(3, "s3", "ch-target", undefined);
  });

  it("空配列を渡した場合は何もしない", async () => {
    const moveNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      moveNode,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await moveScenesToChapter([], "ch-target");

    expect(moveNode).not.toHaveBeenCalled();
  });
});

describe("deleteScenes", () => {
  it("各シーンを順番に削除する", async () => {
    const deleteNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      deleteNode,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await deleteScenes(["s1", "s2"]);

    expect(deleteNode).toHaveBeenCalledTimes(2);
    expect(deleteNode).toHaveBeenNthCalledWith(1, "s1");
    expect(deleteNode).toHaveBeenNthCalledWith(2, "s2");
  });

  it("空配列を渡した場合は何もしない", async () => {
    const deleteNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      deleteNode,
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await deleteScenes([]);

    expect(deleteNode).not.toHaveBeenCalled();
  });
});
