import { describe, it, expect } from "vitest";
import { resolveContainerForScene } from "../gridReveal";
import type { TreeNodeData } from "@/features/tree/treeStore";

function makeNode(
  id: string,
  nodeType: "scene" | "folder",
  parentId: string | null = null,
): TreeNodeData {
  return {
    id,
    nodeType,
    parentId,
    title: id,
    sortOrder: id,
    synopsis: null,
    status: "draft",
    charCount: 0,
    unplacedBeatPreview: null,
    storyTimeOrder: null,
    updatedAt: new Date().toISOString(),
    coverId: null,
  } as unknown as TreeNodeData;
}

describe("resolveContainerForScene", () => {
  it("通常: chapter 内シーン → chapter の parent を container として返す", () => {
    const part = makeNode("part1", "folder", null);
    const chapter = makeNode("ch1", "folder", "part1");
    const scene = makeNode("s1", "scene", "ch1");
    const map = { part1: part, ch1: chapter, s1: scene };

    expect(resolveContainerForScene("s1", map)).toEqual({
      type: "set",
      containerId: "part1",
    });
  });

  it("root 直下の chapter 内シーン → containerId = null (root)", () => {
    const chapter = makeNode("ch1", "folder", null);
    const scene = makeNode("s1", "scene", "ch1");
    const map = { ch1: chapter, s1: scene };

    expect(resolveContainerForScene("s1", map)).toEqual({
      type: "set",
      containerId: null,
    });
  });

  it("3階層ネスト: part > chapter > scene → chapter の parent = part", () => {
    const root = makeNode("root", "folder", null);
    const part = makeNode("part1", "folder", "root");
    const chapter = makeNode("ch1", "folder", "part1");
    const scene = makeNode("s1", "scene", "ch1");
    const map = { root, part1: part, ch1: chapter, s1: scene };

    expect(resolveContainerForScene("s1", map)).toEqual({
      type: "set",
      containerId: "part1",
    });
  });

  it("Loose シーン (parent なし) → keep_current", () => {
    const scene = makeNode("s1", "scene", null);
    const map = { s1: scene };

    expect(resolveContainerForScene("s1", map)).toEqual({
      type: "keep_current",
    });
  });

  it("存在しない ID → not_found", () => {
    expect(resolveContainerForScene("ghost", {})).toEqual({
      type: "not_found",
    });
  });

  it("folder を渡した場合 → not_found", () => {
    const folder = makeNode("f1", "folder", null);
    const map = { f1: folder };

    expect(resolveContainerForScene("f1", map)).toEqual({
      type: "not_found",
    });
  });
});
