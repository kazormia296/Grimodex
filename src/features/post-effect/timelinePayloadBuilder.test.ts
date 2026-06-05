import { describe, it, expect } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  getPlacedScenesForScope,
  buildTimelineContext,
} from "./timelinePayloadBuilder";

function node(id: string, overrides: Partial<TreeNodeData> = {}): TreeNodeData {
  return {
    id,
    nodeType: "scene",
    parentId: null,
    title: `Scene ${id}`,
    synopsis: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    ...overrides,
  } as unknown as TreeNodeData;
}

describe("getPlacedScenesForScope", () => {
  it("keeps only story-time-placed scenes, sorted ascending by key", () => {
    const nodes = [
      node("a", { storyTimeOrder: "b0" }),
      node("b", { storyTimeOrder: "a0" }),
      node("c", { storyTimeOrder: null }), // unplaced -> excluded
      node("d", { storyTimeOrder: "a5" }),
    ];
    const placed = getPlacedScenesForScope(nodes, "project", null);
    expect(placed.map((n) => n.id)).toEqual(["b", "d", "a"]);
  });

  it("excludes folders and notes", () => {
    const nodes = [
      node("f", { nodeType: "folder", storyTimeOrder: "a0" }),
      node("s", { nodeType: "scene", storyTimeOrder: "a1" }),
    ];
    expect(
      getPlacedScenesForScope(nodes, "project", null).map((n) => n.id),
    ).toEqual(["s"]);
  });

  it("scopes to a folder subtree (recursively) for folder scope", () => {
    const nodes = [
      node("ch", { nodeType: "folder", parentId: null }),
      node("s1", { parentId: "ch", storyTimeOrder: "a0" }),
      node("sub", { nodeType: "folder", parentId: "ch" }),
      node("s2", { parentId: "sub", storyTimeOrder: "a1" }),
      node("outside", { parentId: null, storyTimeOrder: "a2" }),
    ];
    const placed = getPlacedScenesForScope(nodes, "folder", "ch");
    expect(placed.map((n) => n.id).sort()).toEqual(["s1", "s2"]);
  });

  it("treats empty/whitespace story_time_order as unplaced", () => {
    const nodes = [
      node("a", { storyTimeOrder: "" }),
      node("b", { storyTimeOrder: "   " }),
      node("c", { storyTimeOrder: "a0" }),
    ];
    expect(
      getPlacedScenesForScope(nodes, "project", null).map((n) => n.id),
    ).toEqual(["c"]);
  });
});

describe("buildTimelineContext", () => {
  it("prefers synopsis, falls back to body excerpt, then placeholder", () => {
    const ctx = buildTimelineContext([
      {
        title: "出会い",
        synopsis: "二人が初めて会う",
        storyTimeLabel: "一日目",
        bodyExcerptSource: "本文……",
      },
      {
        title: "再会",
        synopsis: null,
        storyTimeLabel: null,
        bodyExcerptSource: "三日後、二人は再び会った。",
      },
      {
        title: "空シーン",
        synopsis: "   ",
        storyTimeLabel: "",
        bodyExcerptSource: "",
      },
    ]);
    const lines = ctx.split("\n");
    expect(lines[0]).toBe("1. [一日目] 出会い — 二人が初めて会う");
    // label fallback T{idx}, body excerpt used
    expect(lines[1]).toBe("2. [T2] 再会 — 三日後、二人は再び会った。");
    // empty everything -> placeholder
    expect(lines[2]).toBe("3. [T3] 空シーン — (本文なし)");
  });

  it("truncates long body excerpts", () => {
    const long = "あ".repeat(200);
    const ctx = buildTimelineContext([
      {
        title: "長い",
        synopsis: null,
        storyTimeLabel: "x",
        bodyExcerptSource: long,
      },
    ]);
    expect(ctx).toContain("…");
    expect(ctx.length).toBeLessThan(long.length);
  });
});
