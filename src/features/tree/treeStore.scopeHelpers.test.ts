import { describe, it, expect } from "vitest";
import {
  getAncestorFolders,
  getAllProjectScenesInOrder,
  getDescendantScenesInOrder,
  type TreeNodeData,
} from "./treeStore";

function makeNode(
  overrides: Partial<TreeNodeData> & {
    id: string;
    parentId: string | null;
    nodeType: TreeNodeData["nodeType"];
    title: string;
    sortOrder: string;
  },
): TreeNodeData {
  return {
    projectId: "p",
    synopsis: null,
    intent: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "",
    updatedAt: "",
    ...overrides,
  };
}

describe("getAncestorFolders", () => {
  it("returns folder ancestors from nearest to root", () => {
    const nodes: TreeNodeData[] = [
      makeNode({
        id: "act1",
        parentId: null,
        nodeType: "folder",
        title: "Act 1",
        sortOrder: "a0",
      }),
      makeNode({
        id: "ch1",
        parentId: "act1",
        nodeType: "folder",
        title: "Ch 1",
        sortOrder: "a0",
      }),
      makeNode({
        id: "scene1",
        parentId: "ch1",
        nodeType: "scene",
        title: "Sc 1",
        sortOrder: "a0",
      }),
    ];
    const ancestors = getAncestorFolders(nodes, "scene1");
    expect(ancestors.map((n) => n.id)).toEqual(["ch1", "act1"]);
  });

  it("returns empty array when id is missing or no folder ancestors", () => {
    expect(getAncestorFolders([], null)).toEqual([]);
    expect(getAncestorFolders([], undefined)).toEqual([]);
    expect(getAncestorFolders([], "missing")).toEqual([]);
  });

  it("does not loop on cyclic parentId", () => {
    const nodes: TreeNodeData[] = [
      makeNode({
        id: "a",
        parentId: "b",
        nodeType: "folder",
        title: "A",
        sortOrder: "a0",
      }),
      makeNode({
        id: "b",
        parentId: "a",
        nodeType: "folder",
        title: "B",
        sortOrder: "a0",
      }),
    ];
    const ancestors = getAncestorFolders(nodes, "a");
    expect(ancestors.length).toBeLessThanOrEqual(2);
  });
});

describe("getDescendantScenesInOrder", () => {
  it("returns descendant scenes in DFS pre-order by sortOrder", () => {
    const nodes: TreeNodeData[] = [
      makeNode({
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Ch 1",
        sortOrder: "a0",
      }),
      makeNode({
        id: "s1",
        parentId: "ch1",
        nodeType: "scene",
        title: "S1",
        sortOrder: "a0",
      }),
      makeNode({
        id: "sub",
        parentId: "ch1",
        nodeType: "folder",
        title: "Sub",
        sortOrder: "a1",
      }),
      makeNode({
        id: "s2",
        parentId: "sub",
        nodeType: "scene",
        title: "S2",
        sortOrder: "a0",
      }),
      makeNode({
        id: "s3",
        parentId: "ch1",
        nodeType: "scene",
        title: "S3",
        sortOrder: "a2",
      }),
    ];
    const result = getDescendantScenesInOrder(nodes, "ch1");
    expect(result.map((n) => n.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("returns empty array for missing or undefined folder id", () => {
    expect(getDescendantScenesInOrder([], null)).toEqual([]);
    expect(getDescendantScenesInOrder([], undefined)).toEqual([]);
    expect(getDescendantScenesInOrder([], "missing")).toEqual([]);
  });

  it("returns empty array when folder has no scene descendants", () => {
    const nodes: TreeNodeData[] = [
      makeNode({
        id: "empty",
        parentId: null,
        nodeType: "folder",
        title: "Empty",
        sortOrder: "a0",
      }),
    ];
    expect(getDescendantScenesInOrder(nodes, "empty")).toEqual([]);
  });
});

describe("getAllProjectScenesInOrder", () => {
  it("returns empty array for empty nodes", () => {
    expect(getAllProjectScenesInOrder([])).toEqual([]);
  });

  it("returns top-level scenes in sortOrder", () => {
    const nodes: TreeNodeData[] = [
      makeNode({
        id: "s2",
        parentId: null,
        nodeType: "scene",
        title: "S2",
        sortOrder: "a1",
      }),
      makeNode({
        id: "s1",
        parentId: null,
        nodeType: "scene",
        title: "S1",
        sortOrder: "a0",
      }),
    ];
    expect(getAllProjectScenesInOrder(nodes).map((n) => n.id)).toEqual([
      "s1",
      "s2",
    ]);
  });

  it("returns scenes from nested folders in DFS pre-order by sortOrder", () => {
    const nodes: TreeNodeData[] = [
      makeNode({
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Ch 1",
        sortOrder: "a0",
      }),
      makeNode({
        id: "s1",
        parentId: "ch1",
        nodeType: "scene",
        title: "S1",
        sortOrder: "a0",
      }),
      makeNode({
        id: "sub",
        parentId: "ch1",
        nodeType: "folder",
        title: "Sub",
        sortOrder: "a1",
      }),
      makeNode({
        id: "s2",
        parentId: "sub",
        nodeType: "scene",
        title: "S2",
        sortOrder: "a0",
      }),
      makeNode({
        id: "s3",
        parentId: "ch1",
        nodeType: "scene",
        title: "S3",
        sortOrder: "a2",
      }),
    ];
    expect(getAllProjectScenesInOrder(nodes).map((n) => n.id)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
  });

  it("interleaves top-level scenes and folder descendants by top-level sortOrder", () => {
    const nodes: TreeNodeData[] = [
      makeNode({
        id: "rootScene",
        parentId: null,
        nodeType: "scene",
        title: "Root Scene",
        sortOrder: "a0",
      }),
      makeNode({
        id: "ch1",
        parentId: null,
        nodeType: "folder",
        title: "Ch 1",
        sortOrder: "a1",
      }),
      makeNode({
        id: "s1",
        parentId: "ch1",
        nodeType: "scene",
        title: "S1",
        sortOrder: "a0",
      }),
    ];
    expect(getAllProjectScenesInOrder(nodes).map((n) => n.id)).toEqual([
      "rootScene",
      "s1",
    ]);
  });

  it("does not loop on cyclic folder parentId", () => {
    const nodes: TreeNodeData[] = [
      makeNode({
        id: "a",
        parentId: "b",
        nodeType: "folder",
        title: "A",
        sortOrder: "a0",
      }),
      makeNode({
        id: "b",
        parentId: "a",
        nodeType: "folder",
        title: "B",
        sortOrder: "a1",
      }),
      makeNode({
        id: "s1",
        parentId: "a",
        nodeType: "scene",
        title: "S1",
        sortOrder: "a0",
      }),
    ];
    // 全ノードが循環 (a↔b) または循環内側 (s1 in a) で、parentId=null の root が無い。
    // root 起点で DFS する getAllProjectScenesInOrder は何も拾わず [] を返すのが正。
    const result = getAllProjectScenesInOrder(nodes);
    expect(result).toEqual([]);
  });
});
