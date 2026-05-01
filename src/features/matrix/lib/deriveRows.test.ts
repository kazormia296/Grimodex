import { describe, it, expect } from "vitest";
import { deriveRows, type MatrixRow } from "./deriveRows";
import type { TreeNodeData } from "@/features/tree/treeStore";

const BASE: Omit<
  TreeNodeData,
  "id" | "parentId" | "nodeType" | "title" | "sortOrder"
> = {
  projectId: "default-project",
  synopsis: null,
  storyTimeOrder: null,
  charCount: 0,
  status: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  unplacedBeatPreview: null,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function makeFolder(
  id: string,
  parentId: string | null,
  sortOrder: string,
): TreeNodeData {
  return {
    ...BASE,
    id,
    parentId,
    nodeType: "folder",
    title: `Folder ${id}`,
    sortOrder,
  };
}
function makeScene(
  id: string,
  parentId: string | null,
  sortOrder: string,
): TreeNodeData {
  return {
    ...BASE,
    id,
    parentId,
    nodeType: "scene",
    title: `Scene ${id}`,
    sortOrder,
  };
}

describe("deriveRows", () => {
  it("returns empty array for empty nodes", () => {
    expect(deriveRows([], new Set(), null)).toEqual([]);
  });

  it("includes root-level folders and scenes in sortOrder", () => {
    const nodes: TreeNodeData[] = [
      makeScene("s1", null, "a"),
      makeFolder("f1", null, "b"),
    ];
    const rows = deriveRows(nodes, new Set(), null);
    expect(rows.map((r) => r.node.id)).toEqual(["s1", "f1"]);
  });

  it("includes children of expanded folders", () => {
    const nodes: TreeNodeData[] = [
      makeFolder("f1", null, "a"),
      makeScene("s1", "f1", "a"),
      makeScene("s2", "f1", "b"),
    ];
    const rows = deriveRows(nodes, new Set(), null);
    expect(rows.map((r) => r.node.id)).toEqual(["f1", "s1", "s2"]);
  });

  it("excludes children of collapsed folders", () => {
    const nodes: TreeNodeData[] = [
      makeFolder("f1", null, "a"),
      makeScene("s1", "f1", "a"),
    ];
    const rows = deriveRows(nodes, new Set(["f1"]), null);
    const ids = rows.map((r) => r.node.id);
    expect(ids).toContain("f1");
    expect(ids).not.toContain("s1");
  });

  it("marks folder rows with isFolder=true, scene rows with isFolder=false", () => {
    const nodes: TreeNodeData[] = [
      makeFolder("f1", null, "a"),
      makeScene("s1", "f1", "a"),
    ];
    const rows = deriveRows(nodes, new Set(), null);
    expect(rows.find((r) => r.node.id === "f1")?.isFolder).toBe(true);
    expect(rows.find((r) => r.node.id === "s1")?.isFolder).toBe(false);
  });

  it("assigns correct depth for nested rows", () => {
    const nodes: TreeNodeData[] = [
      makeFolder("part", null, "a"),
      makeFolder("chap", "part", "a"),
      makeScene("s1", "chap", "a"),
    ];
    const rows = deriveRows(nodes, new Set(), null);
    const byId = Object.fromEntries(rows.map((r) => [r.node.id, r]));
    expect(byId["part"].depth).toBe(0);
    expect(byId["chap"].depth).toBe(1);
    expect(byId["s1"].depth).toBe(2);
  });

  it("filters rows by searchQuery matching node title", () => {
    const nodes: TreeNodeData[] = [
      makeFolder("f1", null, "a"),
      { ...makeScene("s1", "f1", "a"), title: "魔法シーン" },
      makeScene("s2", "f1", "b"),
    ];
    const rows = deriveRows(nodes, new Set(), "魔法");
    const ids = rows.map((r) => r.node.id);
    expect(ids).toContain("s1");
    expect(ids).toContain("f1");
    expect(ids).not.toContain("s2");
  });

  it("returns MatrixRow with expected shape", () => {
    const nodes: TreeNodeData[] = [makeScene("s1", null, "a")];
    const rows = deriveRows(nodes, new Set(), null);
    const row: MatrixRow = rows[0];
    expect(row).toMatchObject({
      node: expect.objectContaining({ id: "s1" }),
      depth: 0,
      isFolder: false,
    });
  });
});
