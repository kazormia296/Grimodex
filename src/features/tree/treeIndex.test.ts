import { describe, expect, it } from "vitest";
import { makeNodeData } from "@/test-utils/nodeFixture";
import {
  buildTreeIndex,
  flattenSceneNodes,
  getLiveFolderCharCount,
  getTreeIndex,
} from "./treeIndex";

describe("treeIndex", () => {
  it("sorts children once and builds folder aggregates in post-order", () => {
    const root = makeNodeData({
      id: "root",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a0",
    });
    const nested = makeNodeData({
      id: "nested",
      nodeType: "folder",
      parentId: "root",
      sortOrder: "a2",
    });
    const first = makeNodeData({
      id: "first",
      nodeType: "scene",
      parentId: "root",
      sortOrder: "a1",
      charCount: 10,
    });
    const second = makeNodeData({
      id: "second",
      nodeType: "scene",
      parentId: "nested",
      sortOrder: "a0",
      charCount: 20,
    });
    const note = makeNodeData({
      id: "note",
      nodeType: "note",
      parentId: "nested",
      sortOrder: "a1",
      charCount: 5,
    });

    const index = buildTreeIndex([note, second, nested, first, root]);
    expect(index.childrenByParent.get("root")?.map((node) => node.id)).toEqual([
      "first",
      "nested",
    ]);
    expect(index.descendantSceneCount.get("root")).toBe(2);
    expect(index.descendantCharCount.get("root")).toBe(35);
    expect(index.subtreeSceneIds.get("root")).toEqual(["first", "second"]);
    expect(index.leafDescendantIds.get("root")).toEqual([
      "first",
      "second",
      "note",
    ]);
  });

  it("shares one live post-order total snapshot across folder selectors", () => {
    const root = makeNodeData({
      id: "root",
      nodeType: "folder",
      parentId: null,
    });
    const nested = makeNodeData({
      id: "nested",
      nodeType: "folder",
      parentId: "root",
    });
    const scene = makeNodeData({
      id: "scene",
      nodeType: "scene",
      parentId: "nested",
    });
    const nodes = [root, nested, scene];
    const counts = { scene: 42 };
    expect(getLiveFolderCharCount(nodes, counts, "nested")).toBe(42);
    expect(getLiveFolderCharCount(nodes, counts, "root")).toBe(42);
  });

  it("flattens scenes in DFS order and appends unreachable scenes", () => {
    const folder = makeNodeData({
      id: "folder",
      nodeType: "folder",
      parentId: null,
      sortOrder: "a0",
    });
    const child = makeNodeData({
      id: "child",
      nodeType: "scene",
      parentId: "folder",
      sortOrder: "a0",
    });
    const orphan = makeNodeData({
      id: "orphan",
      nodeType: "scene",
      parentId: "missing",
      sortOrder: "a1",
    });
    expect(
      flattenSceneNodes(getTreeIndex([orphan, child, folder])).map(
        (node) => node.id,
      ),
    ).toEqual(["child", "orphan"]);
  });
});
