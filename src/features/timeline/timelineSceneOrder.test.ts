import { describe, it, expect } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  computeTimelineSceneOrder,
  sceneIndexById,
} from "./timelineSceneOrder";

function node(o: Partial<TreeNodeData> & { id: string }): TreeNodeData {
  return {
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: o.id,
    synopsis: null,
    intent: null,
    sortOrder: "a0",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...o,
  };
}

describe("computeTimelineSceneOrder", () => {
  it("reading: DFS sortOrder 順（フォルダは index を消費せず子を辿る）", () => {
    const nodes = [
      node({ id: "f1", nodeType: "folder", sortOrder: "a0" }),
      node({ id: "s2", parentId: "f1", sortOrder: "a1" }),
      node({ id: "s1", parentId: "f1", sortOrder: "a0" }),
      node({ id: "s3", parentId: null, sortOrder: "a1" }),
    ];
    const { scenes, weights } = computeTimelineSceneOrder(
      nodes,
      "reading",
      "uniform",
    );
    expect(scenes.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
    expect(weights).toBeNull();
  });

  it("story: storyTimeOrder を cmpKeys で並べ未設定は reading 順で後置 + scheduledCount", () => {
    const nodes = [
      node({ id: "s1", sortOrder: "a0", storyTimeOrder: "a2" }),
      node({ id: "s2", sortOrder: "a1", storyTimeOrder: "a0" }),
      node({ id: "u1", sortOrder: "a2", storyTimeOrder: null }),
    ];
    const { scenes, scheduledCount } = computeTimelineSceneOrder(
      nodes,
      "story",
      "uniform",
    );
    expect(scenes.map((s) => s.id)).toEqual(["s2", "s1", "u1"]);
    expect(scheduledCount).toBe(2);
  });

  it("story proportional: scheduled を 0..1 へ正規化した weights", () => {
    const nodes = [
      node({ id: "s1", storyTimeOrder: "a0" }),
      node({ id: "s2", storyTimeOrder: "a1" }),
      node({ id: "s3", storyTimeOrder: "a2" }),
    ];
    const { weights } = computeTimelineSceneOrder(
      nodes,
      "story",
      "proportional",
    );
    expect(weights).toEqual([0, 0.5, 1]);
  });

  it("write: createdAt 昇順", () => {
    const nodes = [
      node({ id: "b", createdAt: "2024-03-01T00:00:00Z" }),
      node({ id: "a", createdAt: "2024-01-01T00:00:00Z" }),
      node({ id: "c", createdAt: "2024-02-01T00:00:00Z" }),
    ];
    const { scenes } = computeTimelineSceneOrder(nodes, "write", "uniform");
    expect(scenes.map((s) => s.id)).toEqual(["a", "c", "b"]);
  });

  it("非 scene ノードは除外", () => {
    const nodes = [
      node({ id: "s1" }),
      node({ id: "n1", nodeType: "note" }),
      node({ id: "f1", nodeType: "folder" }),
    ];
    const { scenes } = computeTimelineSceneOrder(nodes, "reading", "uniform");
    expect(scenes.map((s) => s.id)).toEqual(["s1"]);
  });
});

describe("sceneIndexById", () => {
  it("配列順を 0-based index Map に変換", () => {
    const m = sceneIndexById([node({ id: "x" }), node({ id: "y" })]);
    expect(m.get("x")).toBe(0);
    expect(m.get("y")).toBe(1);
    expect(m.has("z")).toBe(false);
  });
});
