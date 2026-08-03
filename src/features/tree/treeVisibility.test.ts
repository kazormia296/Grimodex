import { describe, it, expect } from "vitest";
import {
  deriveVisibleTreeRows,
  isNodeVisible,
  flattenVisible,
} from "./treeVisibility";
import { getTreeIndex } from "./treeIndex";
import type { TreeNodeData } from "./treeStore";
import { endPerfSession, startPerfSession } from "@/lib/perfLog";

function node(over: Partial<TreeNodeData> & { id: string }): TreeNodeData {
  return {
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: over.id,
    synopsis: null,
    intent: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "t",
    updatedAt: "t",
    ...over,
  };
}

/**
 * Tree:
 *   folderA
 *     s1 (thread t1)
 *     s2 (thread t2)
 *   folderB
 *     s3 (thread t2)
 *   s4 (no thread)
 */
const folderA = node({ id: "folderA", nodeType: "folder" });
const folderB = node({ id: "folderB", nodeType: "folder" });
const s1 = node({ id: "s1", parentId: "folderA" });
const s2 = node({ id: "s2", parentId: "folderA" });
const s3 = node({ id: "s3", parentId: "folderB" });
const s4 = node({ id: "s4" });

const nodeMap: Record<string, TreeNodeData> = {
  folderA,
  folderB,
  s1,
  s2,
  s3,
  s4,
};
const childMap: Record<string, string[]> = {
  root: ["folderA", "folderB", "s4"],
  folderA: ["s1", "s2"],
  folderB: ["s3"],
};
const nodeThreadIds: Record<string, string[]> = {
  s1: ["t1"],
  s2: ["t2"],
  s3: ["t2"],
};

describe("treeVisibility threadFilter", () => {
  it("shows a scene whose thread is in the filter (OR semantics)", () => {
    expect(
      isNodeVisible(
        s1,
        childMap,
        nodeMap,
        "",
        null,
        [],
        {},
        ["t1"],
        nodeThreadIds,
      ),
    ).toBe(true);
    expect(
      isNodeVisible(
        s2,
        childMap,
        nodeMap,
        "",
        null,
        [],
        {},
        ["t1", "t2"],
        nodeThreadIds,
      ),
    ).toBe(true);
  });

  it("hides a scene whose thread is not in the filter", () => {
    expect(
      isNodeVisible(
        s2,
        childMap,
        nodeMap,
        "",
        null,
        [],
        {},
        ["t1"],
        nodeThreadIds,
      ),
    ).toBe(false);
    // scene with no thread membership at all
    expect(
      isNodeVisible(
        s4,
        childMap,
        nodeMap,
        "",
        null,
        [],
        {},
        ["t1"],
        nodeThreadIds,
      ),
    ).toBe(false);
  });

  it("empty threadFilter shows everything", () => {
    expect(
      isNodeVisible(s4, childMap, nodeMap, "", null, [], {}, [], nodeThreadIds),
    ).toBe(true);
  });

  it("keeps a folder that has a matching-thread descendant", () => {
    expect(
      isNodeVisible(
        folderA,
        childMap,
        nodeMap,
        "",
        null,
        [],
        {},
        ["t1"],
        nodeThreadIds,
      ),
    ).toBe(true);
  });

  it("hides a folder with no matching-thread descendant (no empty folders)", () => {
    // folderB only contains s3 (t2); filtering by t1 should hide folderB
    expect(
      isNodeVisible(
        folderB,
        childMap,
        nodeMap,
        "",
        null,
        [],
        {},
        ["t1"],
        nodeThreadIds,
      ),
    ).toBe(false);
  });

  it("combines with labelFilter via AND", () => {
    const nodeLabels = { s1: ["L1"] };
    // s1 is in thread t1 but does NOT carry label L2 → hidden
    expect(
      isNodeVisible(
        s1,
        childMap,
        nodeMap,
        "",
        null,
        ["L2"],
        nodeLabels,
        ["t1"],
        nodeThreadIds,
      ),
    ).toBe(false);
    // s1 carries L1 and is in t1 → visible
    expect(
      isNodeVisible(
        s1,
        childMap,
        nodeMap,
        "",
        null,
        ["L1"],
        nodeLabels,
        ["t1"],
        nodeThreadIds,
      ),
    ).toBe(true);
  });

  it("flattenVisible returns matching scenes and their containing folders only", () => {
    const flat = flattenVisible(
      null,
      childMap,
      nodeMap,
      ["folderA", "folderB"], // expanded
      "",
      null,
      [],
      {},
      ["t1"],
      nodeThreadIds,
    );
    const ids = flat.map((n) => n.id);
    expect(ids).toContain("folderA");
    expect(ids).toContain("s1");
    expect(ids).not.toContain("s2"); // t2, filtered out
    expect(ids).not.toContain("folderB"); // no t1 descendant
    expect(ids).not.toContain("s3");
    expect(ids).not.toContain("s4");
  });

  it("auto-expands matching folders even when collapsed (reveals subplot scenes)", () => {
    const flat = flattenVisible(
      null,
      childMap,
      nodeMap,
      [], // nothing expanded
      "",
      null,
      [],
      {},
      ["t2"],
      nodeThreadIds,
    );
    const ids = flat.map((n) => n.id);
    // folderA(s2) and folderB(s3) both contain t2; collapsed but auto-expanded
    expect(ids).toEqual(["folderA", "s2", "folderB", "s3"]);
  });

  it("indexed derivation propagates search/thread matches once and preserves depth", () => {
    const rows = deriveVisibleTreeRows(
      getTreeIndex([folderA, folderB, s1, s2, s3, s4]),
      {
        expandedIds: [],
        query: "",
        threadFilter: ["t2"],
        nodeThreadIds,
      },
    );
    expect(rows.map(({ node: item, depth }) => [item.id, depth])).toEqual([
      ["folderA", 0],
      ["s2", 1],
      ["folderB", 0],
      ["s3", 1],
    ]);
  });

  it("records a linear visit bound for a 10k-node search without timing assertions", () => {
    const folder = node({
      id: "large-folder",
      nodeType: "folder",
      sortOrder: "a0",
    });
    const scenes = Array.from({ length: 10_000 }, (_, index) =>
      node({
        id: `large-scene-${index}`,
        parentId: folder.id,
        title: index === 9_999 ? "unique search target" : `scene ${index}`,
        sortOrder: `a${String(index).padStart(5, "0")}`,
      }),
    );
    const totalNodes = scenes.length + 1;

    startPerfSession();
    const rows = deriveVisibleTreeRows(getTreeIndex([folder, ...scenes]), {
      expandedIds: [],
      query: "unique search target",
    });
    const result = endPerfSession();

    expect(rows.map((row) => row.node.id)).toEqual([
      folder.id,
      "large-scene-9999",
    ]);
    expect(result?.counters).toMatchObject({
      "tree.visibility.derive.count": 1,
      "tree.visibility.nodesVisited": totalNodes * 2,
      "tree.visibility.maxNodesVisited": totalNodes * 2,
      "tree.visibility.visibleRows": 2,
    });
  });
});
