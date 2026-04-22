import { describe, it, expect } from "vitest";
import { autoArrange } from "./autoArrange";
import type { MapNodePositionRecord } from "../types";

function makeScene(
  id: string,
  sortOrder = "a",
  storyTimeOrder: string | null = null,
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
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    createdAt: "",
  };
}

function makePos(treeNodeId: string, pinned = 0): MapNodePositionRecord {
  return {
    id: `pos-${treeNodeId}`,
    boardId: "b1",
    nodeRefType: "scene",
    treeNodeId,
    codexEntryId: null,
    aiNodeId: null,
    x: 0,
    y: 0,
    pinned,
    hidden: 0,
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
      variant: "compact",
    });

    expect(result.size).toBe(8);

    // 行1: 5個 → row=0
    for (let i = 0; i < 5; i++) {
      const pos = result.get(`scene:s${i}`)!;
      expect(pos.y).toBe(40); // row 0
      expect(pos.x).toBe(i * 280 + 40);
    }

    // 行2: 3個 → row=1
    for (let i = 5; i < 8; i++) {
      const pos = result.get(`scene:s${i}`)!;
      expect(pos.y).toBe(220 + 40); // row 1
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
      variant: "compact",
    });

    expect(result.has("scene:s1")).toBe(false);
    expect(result.has("scene:s0")).toBe(true);
    expect(result.has("scene:s2")).toBe(true);
    // s0 and s2 fill col 0 and col 1
    expect(result.get("scene:s0")!.x).toBe(40);
    expect(result.get("scene:s2")!.x).toBe(280 + 40);
  });

  it("story-time順でnull(unscheduled)は末尾に並ぶ", () => {
    const scenes = [
      makeScene("s1", "a", "b"),
      makeScene("s_null", "b", null),
      makeScene("s2", "c", "a"),
    ];
    const result = autoArrange({
      type: "story-time",
      allTreeNodes: scenes,
      scenes,
      positions: [],
      variant: "compact",
    });

    // Sorted order: s2(a) → s1(b) → s_null(null)
    expect(result.get("scene:s2")!.x).toBeLessThan(result.get("scene:s1")!.x);
    expect(result.get("scene:s1")!.x).toBeLessThan(
      result.get("scene:s_null")!.x,
    );
  });

  it("Compact variant のセルは 280x220", () => {
    const scenes = [makeScene("s0", "a"), makeScene("s1", "b")];
    const result = autoArrange({
      type: "reading-order",
      allTreeNodes: scenes,
      scenes,
      positions: [],
      variant: "compact",
    });
    expect(result.get("scene:s1")!.x - result.get("scene:s0")!.x).toBe(280);
  });

  it("Card variant のセルは 320x240", () => {
    const scenes = [makeScene("s0", "a"), makeScene("s1", "b")];
    const result = autoArrange({
      type: "reading-order",
      allTreeNodes: scenes,
      scenes,
      positions: [],
      variant: "card",
    });
    expect(result.get("scene:s1")!.x - result.get("scene:s0")!.x).toBe(320);
  });
});
