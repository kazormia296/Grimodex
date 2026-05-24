import { describe, it, expect, beforeEach, vi } from "vitest";
import { useTreeStore } from "./treeStore";

vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi
    .fn()
    .mockImplementation((node: Record<string, unknown>) =>
      Promise.resolve(node),
    ),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn().mockResolvedValue(undefined),
}));

const DEFAULTS = {
  synopsis: null,
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
  useTreeStore.setState({
    nodes: [],
    projectId: "proj-1",
    selectedIds: [],
    activeSceneId: "",
    expandedIds: [],
    pendingRevealId: null,
  });
});

describe("createNode with invalid fractional-indexing siblings", () => {
  it("creates a new folder even when an existing sibling has an invalid sort_order", async () => {
    // 古いシードで挿入された不正キー (z 始まりは 27 文字必要なのに "z0" は 2 文字)
    useTreeStore.setState({
      nodes: [
        {
          id: "part1",
          projectId: "proj-1",
          parentId: null,
          nodeType: "folder",
          title: "Part 1",
          sortOrder: "a0",
          ...DEFAULTS,
        },
        {
          id: "part2",
          projectId: "proj-1",
          parentId: null,
          nodeType: "folder",
          title: "Part 2",
          sortOrder: "a1",
          ...DEFAULTS,
        },
        {
          id: "notes",
          projectId: "proj-1",
          parentId: null,
          nodeType: "folder",
          title: "覚書",
          sortOrder: "z0", // ← invalid
          ...DEFAULTS,
        },
      ],
    });

    await expect(
      useTreeStore
        .getState()
        .createNode({ nodeType: "folder", parentId: null }),
    ).resolves.toBeDefined();

    const rootFolders = useTreeStore
      .getState()
      .nodes.filter((n) => n.parentId === null && n.nodeType === "folder");
    expect(rootFolders).toHaveLength(4);

    const created = rootFolders.find(
      (n) => !["part1", "part2", "notes"].includes(n.id),
    );
    expect(created).toBeDefined();
    // 新規キーは "a1" の次（"a2" 系）になるはず。少なくとも有効な fractional-
    // indexing キーで、無効な "z0" を兄弟リストから除外していることを確認。
    expect(created!.sortOrder).not.toBe("z0");
    expect(created!.sortOrder.startsWith("a")).toBe(true);
  });
});

describe("createNode pendingRevealId (scroll trigger)", () => {
  // Folders don't open a tab, so activeSceneId never changes for them and the
  // ScenesPanel auto-reveal effect doesn't fire. createNode sets
  // pendingRevealId to compensate; scenes/notes still rely on the existing
  // activeSceneId path.
  it("sets pendingRevealId to the new folder id so the panel scrolls to it", async () => {
    const created = await useTreeStore
      .getState()
      .createNode({ nodeType: "folder", parentId: null });

    expect(useTreeStore.getState().pendingRevealId).toBe(created.id);
  });

  it("does not set pendingRevealId when creating a scene (activeSceneId path handles it)", async () => {
    await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });

    expect(useTreeStore.getState().pendingRevealId).toBeNull();
  });

  it("does not set pendingRevealId when creating a note (tab-open path handles it)", async () => {
    await useTreeStore
      .getState()
      .createNode({ nodeType: "note", parentId: null });

    expect(useTreeStore.getState().pendingRevealId).toBeNull();
  });

  it("does not set pendingRevealId for a new folder when autoRevealActiveScene is off", async () => {
    // パリティ: ユーザーが auto-reveal を切っていたら scene/note と同じく
    // folder もスクロールさせない。
    useTreeStore.setState({ autoRevealActiveScene: false });

    await useTreeStore
      .getState()
      .createNode({ nodeType: "folder", parentId: null });

    expect(useTreeStore.getState().pendingRevealId).toBeNull();
  });
});
