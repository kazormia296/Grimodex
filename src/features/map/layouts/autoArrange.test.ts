import { describe, it, expect } from "vitest";
import { autoArrange } from "./autoArrange";
import type { MapNodePositionRecord } from "../types";

function makeScene(
  id: string,
  sortOrder = "a",
  parentId: string | null = null,
): Parameters<typeof autoArrange>[0]["scenes"][0] {
  return {
    id,
    projectId: "p1",
    parentId,
    nodeType: "scene",
    title: "Scene",
    synopsis: null,
    sortOrder,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "",
    charCount: 0,
    updatedAt: "",
  };
}

function makePos(treeNodeId: string, pinned = 0): MapNodePositionRecord {
  return {
    id: `pos-${treeNodeId}`,
    boardId: "b1",
    nodeRefType: "scene",
    treeNodeId,
    codexEntryId: null,
    snippetId: null,
    stickyId: null,
    aiBranchId: null,
    x: 0,
    y: 0,
    pinned,
    zIndex: 0,
    createdAt: "",
    updatedAt: "",
  };
}

describe("autoArrange", () => {
  it("8シーンが5列グリッドに配置される（行1: 5個, 行2: 3個）", () => {
    const scenes = Array.from({ length: 8 }, (_, i) =>
      makeScene(`s${i}`, String.fromCharCode(97 + i)),
    );
    const result = autoArrange({
      type: "reading-order",
      allTreeNodes: scenes,
      scenes,
      positions: [],
    });

    expect(result.size).toBe(8);

    for (let i = 0; i < 5; i++) {
      const pos = result.get(`scene:s${i}`)!;
      expect(pos.y).toBe(40); // row 0
      expect(pos.x).toBe(i * 280 + 40);
    }

    for (let i = 5; i < 8; i++) {
      const pos = result.get(`scene:s${i}`)!;
      expect(pos.y).toBe(100 + 40); // row 1
    }
  });

  it("ピン留め済みノードはスキップされる", () => {
    const scenes = Array.from({ length: 3 }, (_, i) =>
      makeScene(`s${i}`, String.fromCharCode(97 + i)),
    );
    const positions = [makePos("s1", 1)]; // s1 is pinned

    const result = autoArrange({
      type: "reading-order",
      allTreeNodes: scenes,
      scenes,
      positions,
    });

    expect(result.has("scene:s1")).toBe(false);
    expect(result.has("scene:s0")).toBe(true);
    expect(result.has("scene:s2")).toBe(true);
    expect(result.get("scene:s0")!.x).toBe(40);
    expect(result.get("scene:s2")!.x).toBe(280 + 40);
  });
});
