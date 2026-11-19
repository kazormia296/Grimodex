import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import { buildStorySoFar } from "./contextBuilder";

const NOW = "2026-01-01T00:00:00.000Z";

function node(
  overrides: Partial<TreeNodeData> &
    Pick<TreeNodeData, "id" | "nodeType" | "sortOrder">,
): TreeNodeData {
  return {
    projectId: "project-1",
    parentId: null,
    title: overrides.id,
    synopsis: null,
    intent: null,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * sortOrder は親ごとの fractional index。章 2 の 1 場面目（a0）は、
 * 章 1 の 2 場面目（a1）より sortOrder の文字列比較では小さいが、読む順では後。
 */
function twoChapterTree(): TreeNodeData[] {
  return [
    node({ id: "ch1", nodeType: "folder", sortOrder: "a0" }),
    node({ id: "ch2", nodeType: "folder", sortOrder: "a1" }),
    node({
      id: "c1s1",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a0",
      synopsis: "chapter-1-scene-1-synopsis",
    }),
    node({
      id: "c1s2",
      nodeType: "scene",
      parentId: "ch1",
      sortOrder: "a1",
      synopsis: "chapter-1-scene-2-synopsis",
    }),
    node({
      id: "c2s1",
      nodeType: "scene",
      parentId: "ch2",
      sortOrder: "a0",
      synopsis: "chapter-2-scene-1-synopsis",
    }),
    node({
      id: "c2s2",
      nodeType: "scene",
      parentId: "ch2",
      sortOrder: "a1",
      synopsis: "chapter-2-scene-2-synopsis",
    }),
  ];
}

describe("buildStorySoFar reading order", () => {
  it("does not include a later chapter's scene as 'so far' for an earlier chapter's scene", () => {
    const result = buildStorySoFar("c1s2", twoChapterTree(), 10_000, "ja");

    expect(result).toContain("chapter-1-scene-1-synopsis");
    expect(result).not.toContain("chapter-2-scene-1-synopsis");
    expect(result).not.toContain("chapter-2-scene-2-synopsis");
  });

  it("lists scenes of earlier chapters first, in tree reading order", () => {
    const result = buildStorySoFar("c2s2", twoChapterTree(), 10_000, "ja");

    const indices = [
      "chapter-1-scene-1-synopsis",
      "chapter-1-scene-2-synopsis",
      "chapter-2-scene-1-synopsis",
    ].map((text) => result.indexOf(text));
    expect(indices.every((i) => i >= 0)).toBe(true);
    expect([...indices].sort((a, b) => a - b)).toEqual(indices);
  });

  it("returns an empty string when the current scene is not in the reading order", () => {
    const nodes = twoChapterTree().map((n) =>
      n.id === "c1s2" ? { ...n, archivedAt: NOW } : n,
    );
    expect(buildStorySoFar("c1s2", nodes, 10_000, "ja")).toBe("");
  });
});
