import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/features/tree/treeStore", () => ({
  useTreeStore: {
    getState: vi.fn(),
  },
}));

import { useTreeStore } from "@/features/tree/treeStore";
import {
  consolidateLooseIntoChapter,
  convertLooseToChapter,
} from "../looseBatchOps";

const mockGetState = vi.mocked(useTreeStore.getState);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("consolidateLooseIntoChapter", () => {
  it("各シーンを対象章に移動する", async () => {
    const moveNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({ moveNode } as unknown as ReturnType<
      typeof useTreeStore.getState
    >);

    await consolidateLooseIntoChapter(["s1", "s2", "s3"], "ch1");

    expect(moveNode).toHaveBeenCalledTimes(3);
    expect(moveNode).toHaveBeenCalledWith("s1", "ch1", null);
    expect(moveNode).toHaveBeenCalledWith("s2", "ch1", null);
    expect(moveNode).toHaveBeenCalledWith("s3", "ch1", null);
  });

  it("空配列を渡した場合は何もしない", async () => {
    const moveNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({ moveNode } as unknown as ReturnType<
      typeof useTreeStore.getState
    >);

    await consolidateLooseIntoChapter([], "ch1");

    expect(moveNode).not.toHaveBeenCalled();
  });
});

describe("convertLooseToChapter", () => {
  it("新しい folder を作成してシーンを移動する", async () => {
    const newFolderId = "folder-new";
    const createNode = vi.fn().mockResolvedValue({ id: newFolderId });
    const moveNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      createNode,
      moveNode,
      nodes: [],
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    const result = await convertLooseToChapter("container1", ["s1", "s2"]);

    expect(createNode).toHaveBeenCalledWith({
      nodeType: "folder",
      parentId: "container1",
      title: "Chapter 1",
    });
    expect(moveNode).toHaveBeenCalledTimes(2);
    expect(moveNode).toHaveBeenCalledWith("s1", newFolderId, null);
    expect(moveNode).toHaveBeenCalledWith("s2", newFolderId, null);
    expect(result).toBe(newFolderId);
  });

  it("既存の folder 数に応じて章番号を自動採番する", async () => {
    const createNode = vi.fn().mockResolvedValue({ id: "new-ch" });
    const moveNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      createNode,
      moveNode,
      nodes: [
        { nodeType: "folder", parentId: "container1", id: "ch1" },
        { nodeType: "folder", parentId: "container1", id: "ch2" },
        { nodeType: "scene", parentId: "container1", id: "s-loose" },
      ],
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await convertLooseToChapter("container1", ["s-loose"]);

    expect(createNode).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Chapter 3" }),
    );
  });

  it("任意タイトルが指定された場合は採番をスキップする", async () => {
    const createNode = vi.fn().mockResolvedValue({ id: "custom-ch" });
    const moveNode = vi.fn().mockResolvedValue(undefined);
    mockGetState.mockReturnValue({
      createNode,
      moveNode,
      nodes: [],
    } as unknown as ReturnType<typeof useTreeStore.getState>);

    await convertLooseToChapter(null, ["s1"], "プロローグ");

    expect(createNode).toHaveBeenCalledWith(
      expect.objectContaining({ title: "プロローグ", parentId: null }),
    );
  });
});
