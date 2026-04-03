import { describe, it, expect } from "vitest";
import { computeBreadcrumbPath } from "./Breadcrumb";
import type { TreeNodeData } from "@/features/tree/treeStore";

const NODES: TreeNodeData[] = [
  {
    id: "part-1",
    projectId: "p",
    parentId: null,
    nodeType: "part",
    title: "第一部",
    synopsis: null,
    sortOrder: 1,
    status: null,
  },
  {
    id: "chapter-1",
    projectId: "p",
    parentId: "part-1",
    nodeType: "chapter",
    title: "第1章",
    synopsis: null,
    sortOrder: 1,
    status: null,
  },
  {
    id: "scene-1",
    projectId: "p",
    parentId: "chapter-1",
    nodeType: "scene",
    title: "塔の麓",
    synopsis: null,
    sortOrder: 1,
    status: null,
  },
  {
    id: "chapter-2",
    projectId: "p",
    parentId: null,
    nodeType: "chapter",
    title: "第2章",
    synopsis: null,
    sortOrder: 2,
    status: null,
  },
  {
    id: "scene-2",
    projectId: "p",
    parentId: "chapter-2",
    nodeType: "scene",
    title: "市場にて",
    synopsis: null,
    sortOrder: 1,
    status: null,
  },
  {
    id: "folder-1",
    projectId: "p",
    parentId: null,
    nodeType: "folder",
    title: "資料",
    synopsis: null,
    sortOrder: 3,
    status: null,
  },
  {
    id: "sub-folder",
    projectId: "p",
    parentId: "folder-1",
    nodeType: "folder",
    title: "キャラクター設定",
    synopsis: null,
    sortOrder: 1,
    status: null,
  },
  {
    id: "note-1",
    projectId: "p",
    parentId: "sub-folder",
    nodeType: "note",
    title: "エララ設定",
    synopsis: null,
    sortOrder: 1,
    status: null,
  },
];

const nodeMap = Object.fromEntries(NODES.map((n) => [n.id, n]));

describe("computeBreadcrumbPath", () => {
  it("returns full Part/Chapter/Scene path", () => {
    const path = computeBreadcrumbPath("scene-1", nodeMap);
    expect(path).toEqual([
      { id: "part-1", title: "第一部", nodeType: "part" },
      { id: "chapter-1", title: "第1章", nodeType: "chapter" },
      { id: "scene-1", title: "塔の麓", nodeType: "scene" },
    ]);
  });

  it("returns Chapter/Scene path when no Part", () => {
    const path = computeBreadcrumbPath("scene-2", nodeMap);
    expect(path).toEqual([
      { id: "chapter-2", title: "第2章", nodeType: "chapter" },
      { id: "scene-2", title: "市場にて", nodeType: "scene" },
    ]);
  });

  it("returns Folder/SubFolder/Note path for note nodes", () => {
    const path = computeBreadcrumbPath("note-1", nodeMap);
    expect(path).toEqual([
      { id: "folder-1", title: "資料", nodeType: "folder" },
      { id: "sub-folder", title: "キャラクター設定", nodeType: "folder" },
      { id: "note-1", title: "エララ設定", nodeType: "note" },
    ]);
  });

  it("returns empty array for unknown node id", () => {
    const path = computeBreadcrumbPath("non-existent", nodeMap);
    expect(path).toEqual([]);
  });

  it("returns single-element array for a root-level node", () => {
    const path = computeBreadcrumbPath("folder-1", nodeMap);
    expect(path).toEqual([
      { id: "folder-1", title: "資料", nodeType: "folder" },
    ]);
  });
});
