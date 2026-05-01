// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTreeStore } from "@/features/tree/treeStore";
import { useGridDerivedData } from "../gridSelectors";
import { makeNodeData } from "@/test-utils/nodeFixture";

function resetTree(...nodes: ReturnType<typeof makeNodeData>[]) {
  useTreeStore.setState((s) => ({ ...s, nodes }));
}

describe("useGridDerivedData", () => {
  beforeEach(() => {
    useTreeStore.setState((s) => ({ ...s, nodes: [] }));
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
      result.current.chapters[0].children.map((s: { id: string }) => s.id),
    ).toEqual(["s1", "s2"]);
    expect(result.current.chapters[1].folder.id).toBe("ch2");
    expect(
      result.current.chapters[1].children.map((s: { id: string }) => s.id),
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
      result.current.chapters[1].children.map((s: { id: string }) => s.id),
    ).toEqual(["s2", "s1"]);
  });
});
