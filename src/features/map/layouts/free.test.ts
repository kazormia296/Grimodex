import { describe, it, expect } from "vitest";
import { layoutFree } from "./free";
import type { MapNodePositionRecord } from "../types";

function makeScene(id: string): Parameters<typeof layoutFree>[0]["scenes"][0] {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: "Scene",
    synopsis: null,
    sortOrder: "a",
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "",

    charCount: 0,
    unplacedBeatPreview: null,
    updatedAt: "",
  };
}

function makePos(
  id: string,
  treeNodeId: string,
  x: number,
  y: number,
): MapNodePositionRecord {
  return {
    id,
    boardId: "b1",
    nodeRefType: "scene",
    treeNodeId,
    codexEntryId: null,
    aiNodeId: null,
    x,
    y,
    pinned: 0,
    hidden: 0,
    zIndex: 0,
    createdAt: "",
    updatedAt: "",
  };
}

describe("layoutFree", () => {
  it("保存座標があるノードはその座標を返す", () => {
    const result = layoutFree({
      scenes: [makeScene("s1")],
      codexEntries: [],
      positions: [makePos("p1", "s1", 300, 400)],
    });
    expect(result.get("scene:s1")).toEqual({ x: 300, y: 400 });
  });

  it("保存座標がないノードはデフォルトグリッド座標を返す", () => {
    const result = layoutFree({
      scenes: [makeScene("s1"), makeScene("s2")],
      codexEntries: [],
      positions: [],
    });
    expect(result.get("scene:s1")).toEqual({ x: 40, y: 40 });
    expect(result.get("scene:s2")).toEqual({ x: 320, y: 40 }); // idx=1: x = 1*280+40
  });

  it("5列目を超えると次の行に折り返す", () => {
    const scenes = Array.from({ length: 6 }, (_, i) => makeScene(`s${i}`));
    const result = layoutFree({ scenes, codexEntries: [], positions: [] });
    // idx=5: col=0, row=1 → x=40, y=260
    expect(result.get("scene:s5")).toEqual({ x: 40, y: 260 });
  });

  it("保存座標があるノードとないノードが混在しても正しく動作する", () => {
    const result = layoutFree({
      scenes: [makeScene("s1"), makeScene("s2")],
      codexEntries: [],
      positions: [makePos("p1", "s1", 500, 600)],
    });
    expect(result.get("scene:s1")).toEqual({ x: 500, y: 600 });
    expect(result.get("scene:s2")).toEqual({ x: 320, y: 40 }); // idx=1 default
  });
});
