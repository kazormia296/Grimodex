import { describe, it, expect } from "vitest";
import { computeBreadcrumbPath } from "./Breadcrumb";
import type { TreeNodeData } from "@/features/tree/treeStore";

const NODE_DEFAULTS = {
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  charCount: 0,
  unplacedBeatPreview: null,
  placedBeatPreview: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
} as const;

const NODES: TreeNodeData[] = [
  {
    id: "part-1",
    projectId: "p",
    parentId: null,
    nodeType: "folder",
    title: "第一部",
    synopsis: null,
    sortOrder: "a1",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "chapter-1",
    projectId: "p",
    parentId: "part-1",
    nodeType: "folder",
    title: "第1章",
    synopsis: null,
    sortOrder: "a1",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "scene-1",
    projectId: "p",
    parentId: "chapter-1",
    nodeType: "scene",
    title: "塔の麓",
    synopsis: null,
    sortOrder: "a1",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "chapter-2",
    projectId: "p",
    parentId: null,
    nodeType: "folder",
    title: "第2章",
    synopsis: null,
    sortOrder: "a2",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "scene-2",
    projectId: "p",
    parentId: "chapter-2",
    nodeType: "scene",
    title: "市場にて",
    synopsis: null,
    sortOrder: "a1",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "folder-1",
    projectId: "p",
    parentId: null,
    nodeType: "folder",
    title: "資料",
    synopsis: null,
    sortOrder: "a3",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "sub-folder",
    projectId: "p",
    parentId: "folder-1",
    nodeType: "folder",
    title: "キャラクター設定",
    synopsis: null,
    sortOrder: "a1",
    status: null,
    ...NODE_DEFAULTS,
  },
  {
    id: "note-1",
    projectId: "p",
    parentId: "sub-folder",
    nodeType: "note",
    title: "エララ設定",
    synopsis: null,
    sortOrder: "a1",
    status: null,
    ...NODE_DEFAULTS,
  },
];

const nodeMap = Object.fromEntries(NODES.map((n) => [n.id, n]));

describe("computeBreadcrumbPath", () => {
  it("returns full Folder/Folder/Scene path", () => {
    const path = computeBreadcrumbPath("scene-1", nodeMap);
    expect(path).toEqual([
      { id: "part-1", title: "第一部", nodeType: "folder" },
      { id: "chapter-1", title: "第1章", nodeType: "folder" },
      { id: "scene-1", title: "塔の麓", nodeType: "scene" },
    ]);
  });

  it("returns Folder/Scene path when no parent folder", () => {
    const path = computeBreadcrumbPath("scene-2", nodeMap);
    expect(path).toEqual([
      { id: "chapter-2", title: "第2章", nodeType: "folder" },
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
