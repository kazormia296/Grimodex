import { describe, it, expect } from "vitest";
import { assignNodePlacements } from "./placement";
import { cmpKeys } from "../fractionalIndex";
import type { TreeNodeData, NodeType } from "../treeStore";
import type { AiTreePlan } from "./types";

function mkNode(p: {
  id: string;
  nodeType: NodeType;
  parentId: string | null;
  sortOrder: string;
}): TreeNodeData {
  return {
    projectId: "proj-1",
    title: p.id,
    synopsis: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    sourceUri: null,
    sourceMtime: null,
    archivedAt: null,
    contextMode: null,
    aliases: null,
    excludedAliases: null,
    createdAt: "t",
    updatedAt: "t",
    ...p,
  };
}

const FOLDER = [
  mkNode({ id: "F", nodeType: "folder", parentId: null, sortOrder: "a0" }),
  mkNode({ id: "s1", nodeType: "scene", parentId: "F", sortOrder: "a0" }),
  mkNode({ id: "s2", nodeType: "scene", parentId: "F", sortOrder: "a1" }),
];

describe("assignNodePlacements", () => {
  it("appends a create after the last sibling", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:n",
          parentRef: "F",
          nodeType: "scene",
          title: "n",
        },
      ],
    };
    const p = assignNodePlacements(plan, FOLDER, new Map([["tmp:n", "N"]]));
    expect(p.get("N")?.parentId).toBe("F");
    expect(cmpKeys(p.get("N")!.sortOrder, "a1")).toBeGreaterThan(0);
  });

  it("prepends when afterRef is null", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:n",
          parentRef: "F",
          nodeType: "scene",
          title: "n",
          pos: { afterRef: null },
        },
      ],
    };
    const p = assignNodePlacements(plan, FOLDER, new Map([["tmp:n", "N"]]));
    expect(cmpKeys(p.get("N")!.sortOrder, "a0")).toBeLessThan(0);
  });

  it("inserts into the gap after a named anchor", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:n",
          parentRef: "F",
          nodeType: "scene",
          title: "n",
          pos: { afterRef: "s1" },
        },
      ],
    };
    const p = assignNodePlacements(plan, FOLDER, new Map([["tmp:n", "N"]]));
    const k = p.get("N")!.sortOrder;
    expect(cmpKeys(k, "a0")).toBeGreaterThan(0);
    expect(cmpKeys(k, "a1")).toBeLessThan(0);
  });

  it("assigns sequential keys to multiple inserts in the same gap (plan order)", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:a",
          parentRef: "F",
          nodeType: "scene",
          title: "a",
          pos: { afterRef: "s1" },
        },
        {
          op: "create",
          tempId: "tmp:b",
          parentRef: "F",
          nodeType: "scene",
          title: "b",
          pos: { afterRef: "s1" },
        },
      ],
    };
    const p = assignNodePlacements(
      plan,
      FOLDER,
      new Map([
        ["tmp:a", "A"],
        ["tmp:b", "B"],
      ]),
    );
    const ka = p.get("A")!.sortOrder;
    const kb = p.get("B")!.sortOrder;
    // both between s1(a0) and s2(a1), A before B
    expect(cmpKeys("a0", ka)).toBeLessThan(0);
    expect(cmpKeys(ka, kb)).toBeLessThan(0);
    expect(cmpKeys(kb, "a1")).toBeLessThan(0);
  });

  it("orders inserted-after-inserted correctly", () => {
    const plan: AiTreePlan = {
      kind: "scaffold",
      ops: [
        {
          op: "create",
          tempId: "tmp:a",
          parentRef: "F",
          nodeType: "scene",
          title: "a",
          pos: { afterRef: "s1" },
        },
        {
          op: "create",
          tempId: "tmp:b",
          parentRef: "F",
          nodeType: "scene",
          title: "b",
          pos: { afterRef: "tmp:a" },
        },
      ],
    };
    const p = assignNodePlacements(
      plan,
      FOLDER,
      new Map([
        ["tmp:a", "A"],
        ["tmp:b", "B"],
      ]),
    );
    expect(cmpKeys(p.get("A")!.sortOrder, p.get("B")!.sortOrder)).toBeLessThan(
      0,
    );
  });

  it("places existing nodes under a newly created folder (group)", () => {
    const tree = [
      mkNode({ id: "x1", nodeType: "scene", parentId: null, sortOrder: "a0" }),
      mkNode({ id: "x2", nodeType: "scene", parentId: null, sortOrder: "a1" }),
    ];
    const plan: AiTreePlan = {
      kind: "reorganize",
      ops: [
        {
          op: "create",
          tempId: "tmp:g",
          parentRef: null,
          nodeType: "folder",
          title: "G",
        },
        { op: "move", nodeId: "x1", newParentRef: "tmp:g" },
        { op: "move", nodeId: "x2", newParentRef: "tmp:g" },
      ],
    };
    const p = assignNodePlacements(plan, tree, new Map([["tmp:g", "G"]]));
    expect(p.get("G")?.parentId).toBe(null);
    expect(p.get("x1")?.parentId).toBe("G");
    expect(p.get("x2")?.parentId).toBe("G");
    // x1 before x2 inside the new folder
    expect(
      cmpKeys(p.get("x1")!.sortOrder, p.get("x2")!.sortOrder),
    ).toBeLessThan(0);
  });
});
