// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridStore } from "../gridStore";
import { useGridDerivedData } from "../gridSelectors";
import { makeNodeData } from "@/test-utils/nodeFixture";

function resetTree(...nodes: ReturnType<typeof makeNodeData>[]) {
  useTreeStore.setState((s) => ({ ...s, nodes }));
}

function setCollapsed(...ids: string[]) {
  useGridStore.setState((s) => ({
    ...s,
    collapsedFolderIds: new Set<string>(ids),
  }));
}

describe("useGridDerivedData", () => {
  beforeEach(() => {
    useTreeStore.setState((s) => ({ ...s, nodes: [] }));
    useGridStore.setState((s) => ({
      ...s,
      collapsedFolderIds: new Set<string>(),
    }));
  });

  it("returns empty when no nodes", () => {
    const { result } = renderHook(() => useGridDerivedData(null));
    expect(result.current.chapters).toEqual([]);
    expect(result.current.looseScenes).toEqual([]);
    expect(result.current.totalScenes).toBe(0);
    expect(result.current.totalChapters).toBe(0);
  });

  it("groups scenes by chapter folders under containerId", () => {
    const root = makeNodeData({
      id: "root",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a0",
    });
    const ch1 = makeNodeData({
      id: "ch1",
      nodeType: "folder",
      parentId: "root",
      sortOrder: "a1",
    });
    const ch2 = makeNodeData({
      id: "ch2",
      nodeType: "folder",
      parentId: "root",
      sortOrder: "a2",
    });
    const s1 = makeNodeData({
      id: "s1",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a1",
    });
    const s2 = makeNodeData({
      id: "s2",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a2",
    });
    const s3 = makeNodeData({
      id: "s3",
      nodeType: "scene",
      parentId: "ch2",
      sortOrder: "a1",
    });
    resetTree(root, ch1, ch2, s1, s2, s3);

    const { result } = renderHook(() => useGridDerivedData("root"));
    expect(result.current.chapters).toHaveLength(2);
    expect(result.current.chapters[0].folder.id).toBe("ch1");
    expect(
      result.current.chapters[0].descendants.map((d) => d.node.id),
    ).toEqual(["s1", "s2"]);
    expect(result.current.chapters[1].folder.id).toBe("ch2");
    expect(
      result.current.chapters[1].descendants.map((d) => d.node.id),
    ).toEqual(["s3"]);
    expect(result.current.looseScenes).toEqual([]);
    expect(result.current.totalScenes).toBe(3);
    expect(result.current.totalChapters).toBe(2);
  });

  it("separates loose scenes (scenes directly under containerId)", () => {
    const ch1 = makeNodeData({
      id: "ch1",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
    });
    const loose = makeNodeData({
      id: "ls1",
      nodeType: "scene",
      parentId: null,
      sortOrder: "a2",
    });
    const s1 = makeNodeData({
      id: "s1",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a1",
    });
    resetTree(ch1, loose, s1);

    const { result } = renderHook(() => useGridDerivedData(null));
    expect(result.current.looseScenes.map((s) => s.id)).toEqual(["ls1"]);
    expect(result.current.chapters).toHaveLength(1);
    expect(result.current.totalScenes).toBe(2);
  });

  it("returns empty when containerId points to non-existing node", () => {
    const s1 = makeNodeData({
      id: "s1",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a1",
    });
    resetTree(s1);

    const { result } = renderHook(() => useGridDerivedData("non-existent"));
    expect(result.current.chapters).toEqual([]);
    expect(result.current.looseScenes).toEqual([]);
  });

  it("sorts chapters and scenes by sortOrder", () => {
    const ch1 = makeNodeData({
      id: "ch1",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a2",
    });
    const ch2 = makeNodeData({
      id: "ch2",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
    });
    const s1 = makeNodeData({
      id: "s1",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a2",
    });
    const s2 = makeNodeData({
      id: "s2",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a1",
    });
    resetTree(ch1, ch2, s1, s2);

    const { result } = renderHook(() => useGridDerivedData(null));
    expect(result.current.chapters[0].folder.id).toBe("ch2");
    expect(result.current.chapters[1].folder.id).toBe("ch1");
    expect(
      result.current.chapters[1].descendants.map((d) => d.node.id),
    ).toEqual(["s2", "s1"]);
  });

  it("orderedColumns interleaves loose group with chapters by sortOrder", () => {
    // Tree under root: scene_a (a1), chapter_x (a2), scene_b (a3)
    // Expected order: loose (first loose sortOrder = a1) → chapter_x (a2)
    // (loose group is a single column, slotted at the FIRST loose's sortOrder)
    const sa = makeNodeData({
      id: "sa",
      nodeType: "scene",
      parentId: null,
      sortOrder: "a1",
    });
    const ch = makeNodeData({
      id: "chx",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a2",
    });
    const sb = makeNodeData({
      id: "sb",
      nodeType: "scene",
      parentId: null,
      sortOrder: "a3",
    });
    resetTree(sa, ch, sb);

    const { result } = renderHook(() => useGridDerivedData(null));
    const cols = result.current.orderedColumns;
    expect(cols.map((c) => c.kind)).toEqual(["loose", "chapter"]);
    if (cols[0].kind !== "loose") throw new Error("expected loose first");
    expect(cols[0].scenes.map((s) => s.id)).toEqual(["sa", "sb"]);
    if (cols[1].kind !== "chapter") throw new Error("expected chapter");
    expect(cols[1].data.folder.id).toBe("chx");
  });

  it("orderedColumns places loose group AFTER chapters when first loose's sortOrder follows them", () => {
    // chapter_x (a1), scene_a (a2)
    const ch = makeNodeData({
      id: "chx",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
    });
    const sa = makeNodeData({
      id: "sa",
      nodeType: "scene",
      parentId: null,
      sortOrder: "a2",
    });
    resetTree(ch, sa);

    const { result } = renderHook(() => useGridDerivedData(null));
    expect(result.current.orderedColumns.map((c) => c.kind)).toEqual([
      "chapter",
      "loose",
    ]);
  });

  it("Phase 4 後続: dive-in 中の folder 直下シーンは container kind になり folder を担う", () => {
    // act1 folder dive-in: 直下は scene 1 件のみ（chapter sub-folder 無し）
    const act1 = makeNodeData({
      id: "act1",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
    });
    const sa = makeNodeData({
      id: "sa",
      nodeType: "scene",
      parentId: "act1",
      sortOrder: "a1",
    });
    resetTree(act1, sa);

    const { result } = renderHook(() => useGridDerivedData("act1"));
    const cols = result.current.orderedColumns;
    expect(cols.map((c) => c.kind)).toEqual(["container"]);
    if (cols[0].kind !== "container")
      throw new Error("expected container kind");
    expect(cols[0].folder.id).toBe("act1");
    expect(cols[0].scenes.map((s) => s.id)).toEqual(["sa"]);
  });

  it("Phase 4 後続: container folder が空でも空 container 列を 1 つ出す", () => {
    const beat = makeNodeData({
      id: "beat",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
    });
    resetTree(beat);

    const { result } = renderHook(() => useGridDerivedData("beat"));
    expect(result.current.orderedColumns.map((c) => c.kind)).toEqual([
      "container",
    ]);
  });

  it("Phase 4 後続: container 内に chapter folder と直下シーン両方あれば chapter + container を出す", () => {
    // mixed: container has both chapter sub-folder and direct scenes
    const root = makeNodeData({
      id: "root",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a0",
    });
    const ch = makeNodeData({
      id: "ch",
      nodeType: "folder",
      parentId: "root",
      sortOrder: "a1",
    });
    const direct = makeNodeData({
      id: "direct",
      nodeType: "scene",
      parentId: "root",
      sortOrder: "a2",
    });
    resetTree(root, ch, direct);

    const { result } = renderHook(() => useGridDerivedData("root"));
    expect(result.current.orderedColumns.map((c) => c.kind)).toEqual([
      "chapter",
      "container",
    ]);
  });

  it("Phase 4 後続: project root で chapter のみ・orphan 無ければ loose 列は出ない", () => {
    const ch = makeNodeData({
      id: "ch",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
    });
    resetTree(ch);

    const { result } = renderHook(() => useGridDerivedData(null));
    expect(result.current.orderedColumns.map((c) => c.kind)).toEqual([
      "chapter",
    ]);
  });

  it("expands all nested folders by default (collapsed set empty)", () => {
    const ch1 = makeNodeData({
      id: "ch1",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
    });
    const s1 = makeNodeData({
      id: "s1",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a1",
    });
    const subA = makeNodeData({
      id: "subA",
      nodeType: "folder",
      parentId: "ch1",
      sortOrder: "a2",
    });
    const s2 = makeNodeData({
      id: "s2",
      nodeType: "scene",
      parentId: "subA",
      sortOrder: "a1",
    });
    resetTree(ch1, s1, subA, s2);

    const { result } = renderHook(() => useGridDerivedData(null));
    // subA is expanded by default → its child s2 IS included
    expect(
      result.current.chapters[0].descendants.map((d) => d.node.id),
    ).toEqual(["s1", "subA", "s2"]);
    expect(result.current.totalScenes).toBe(2);
  });

  it("hides nested-folder children when their IDs are in collapsedFolderIds", () => {
    const ch1 = makeNodeData({
      id: "ch1",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
    });
    const subA = makeNodeData({
      id: "subA",
      nodeType: "folder",
      parentId: "ch1",
      sortOrder: "a1",
    });
    const s1 = makeNodeData({
      id: "s1",
      nodeType: "scene",
      parentId: "subA",
      sortOrder: "a1",
    });
    resetTree(ch1, subA, s1);
    setCollapsed("subA");

    const { result } = renderHook(() => useGridDerivedData(null));
    // subA collapsed → s1 omitted from descendants but still counted in totalScenes
    expect(
      result.current.chapters[0].descendants.map((d) => d.node.id),
    ).toEqual(["subA"]);
    expect(result.current.totalScenes).toBe(1);
  });

  it("flattens nested folder descendants depth-first by default", () => {
    // ch1
    //   ├ s1 (depth 0)
    //   ├ subA (depth 0)
    //   │   ├ s2 (depth 1)
    //   │   └ subB (depth 1)
    //   │       └ s3 (depth 2)
    //   └ s4 (depth 0)
    const ch1 = makeNodeData({
      id: "ch1",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a1",
    });
    const s1 = makeNodeData({
      id: "s1",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a1",
    });
    const subA = makeNodeData({
      id: "subA",
      nodeType: "folder",
      parentId: "ch1",
      sortOrder: "a2",
    });
    const s2 = makeNodeData({
      id: "s2",
      nodeType: "scene",
      parentId: "subA",
      sortOrder: "a1",
    });
    const subB = makeNodeData({
      id: "subB",
      nodeType: "folder",
      parentId: "subA",
      sortOrder: "a2",
    });
    const s3 = makeNodeData({
      id: "s3",
      nodeType: "scene",
      parentId: "subB",
      sortOrder: "a1",
    });
    const s4 = makeNodeData({
      id: "s4",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a3",
    });
    resetTree(ch1, s1, subA, s2, subB, s3, s4);
    // No setCollapsed call → all expanded by default

    const { result } = renderHook(() => useGridDerivedData(null));
    expect(result.current.chapters).toHaveLength(1);
    const ds = result.current.chapters[0].descendants;
    expect(ds.map((d) => [d.node.id, d.depth])).toEqual([
      ["s1", 0],
      ["subA", 0],
      ["s2", 1],
      ["subB", 1],
      ["s3", 2],
      ["s4", 0],
    ]);
    // totalScenes counts all scene descendants recursively
    expect(result.current.totalScenes).toBe(4);
  });
});
