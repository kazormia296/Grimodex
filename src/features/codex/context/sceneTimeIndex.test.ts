import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  buildSceneTimeIndex,
  compareSceneTime,
  isAutoStoryReady,
  linearizeSceneTimeIndex,
} from "./sceneTimeIndex";

function node(
  id: string,
  sortOrder: string,
  storyTimeOrder: string | null = null,
  overrides: Partial<TreeNodeData> = {},
): TreeNodeData {
  return {
    id,
    projectId: "p1",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function entries<K, V>(map: Map<K, V>): [K, V][] {
  return [...map.entries()].sort(([a], [b]) =>
    String(a).localeCompare(String(b)),
  );
}

describe("buildSceneTimeIndex", () => {
  it("builds reading, explicit story, and forward-filled inherited indexes", () => {
    const index = buildSceneTimeIndex([
      node("leading", "a0"),
      node("first", "a1", "b0"),
      node("inherited", "a2"),
      node("second", "a3", "c0"),
      node("trailing", "a4"),
    ]);

    expect(entries(index.readingOrder)).toEqual([
      ["first", 1],
      ["inherited", 2],
      ["leading", 0],
      ["second", 3],
      ["trailing", 4],
    ]);
    expect(entries(index.explicitStoryOrder)).toEqual([
      ["first", "b0"],
      ["second", "c0"],
    ]);
    expect(index.inheritedStoryOrder.has("leading")).toBe(false);
    expect(index.inheritedStoryOrder.get("first")).toBe("b0");
    expect(index.inheritedStoryOrder.get("inherited")).toBe("b0");
    expect(index.inheritedStoryOrder.get("second")).toBe("c0");
    expect(index.inheritedStoryOrder.get("trailing")).toBe("c0");
    expect(index.liveSceneCount).toBe(5);
    expect(index.scheduledSceneCount).toBe(2);
  });

  it("treats empty and whitespace-only story keys as unscheduled", () => {
    const index = buildSceneTimeIndex([
      node("empty", "a0", ""),
      node("spaces", "a1", "   "),
      node("set", "a2", "  b0  "),
    ]);

    expect(entries(index.explicitStoryOrder)).toEqual([["set", "b0"]]);
    expect(index.scheduledSceneCount).toBe(1);
    expect(isAutoStoryReady(index)).toBe(false);
  });

  it("counts only live scene nodes for auto coverage", () => {
    const index = buildSceneTimeIndex([
      node("live", "a0", "a0"),
      node("note", "a1", null, { nodeType: "note" }),
      node("archived", "a2", null, {
        archivedAt: "2026-01-02T00:00:00.000Z",
      }),
    ]);

    expect(index.liveSceneCount).toBe(1);
    expect(index.scheduledSceneCount).toBe(1);
    expect(isAutoStoryReady(index)).toBe(true);
    expect(index.readingOrder.has("archived")).toBe(false);
  });

  it("is independent of input node permutation", () => {
    const nodes = [
      node("same-b", "a1", "k0"),
      node("same-a", "a0", "k0"),
      node("later", "a2", "z0"),
    ];
    const a = buildSceneTimeIndex(nodes);
    const b = buildSceneTimeIndex([...nodes].reverse());

    expect(entries(a.readingOrder)).toEqual(entries(b.readingOrder));
    expect(entries(a.explicitStoryOrder)).toEqual(
      entries(b.explicitStoryOrder),
    );
    expect(entries(a.inheritedStoryOrder)).toEqual(
      entries(b.inheritedStoryOrder),
    );
  });
});

describe("linearizeSceneTimeIndex", () => {
  it("keeps auto on reading order until every live scene is explicitly scheduled", () => {
    const partial = buildSceneTimeIndex([
      node("chapter-1", "a0"),
      node("chapter-8", "a1", "a0"),
    ]);
    expect(entries(linearizeSceneTimeIndex(partial, "auto"))).toEqual([
      ["chapter-1", 0],
      ["chapter-8", 1],
    ]);

    const complete = buildSceneTimeIndex([
      node("chapter-1", "a0", "z0"),
      node("chapter-8", "a1", "a0"),
    ]);
    expect(entries(linearizeSceneTimeIndex(complete, "auto"))).toEqual([
      ["chapter-1", 1],
      ["chapter-8", 0],
    ]);
  });

  it("uses inherited story order when every scene has a story bucket", () => {
    const index = buildSceneTimeIndex([
      node("present", "a0", "z0"),
      node("same-time", "a1"),
      node("flashback", "a2", "a0"),
    ]);

    expect(entries(linearizeSceneTimeIndex(index, "story"))).toEqual([
      ["flashback", 0],
      ["present", 1],
      ["same-time", 2],
    ]);
  });

  it("uses a project-wide reading compatibility map when story has a leading gap", () => {
    const index = buildSceneTimeIndex([
      node("leading", "a0"),
      node("scheduled", "a1", "a0"),
    ]);
    expect(entries(linearizeSceneTimeIndex(index, "story"))).toEqual([
      ["leading", 0],
      ["scheduled", 1],
    ]);
  });
});

describe("compareSceneTime", () => {
  it("story は unrelated な leading gap を無視して valid pair を story 軸で比較する", () => {
    const index = buildSceneTimeIndex([
      node("unrelated", "a0"),
      node("payoff", "a1", "z0"),
      node("current", "a2", "a0"),
    ]);

    expect(compareSceneTime(index, "story", "payoff", "current")).toBe(1);
    expect(compareSceneTime(index, "auto", "payoff", "current")).toBe(-1);
  });

  it("story key 同値は reading order で決定し、不明 scene は null を返す", () => {
    const index = buildSceneTimeIndex([
      node("first", "a0", "k0"),
      node("second", "a1"),
    ]);

    expect(compareSceneTime(index, "story", "first", "second")).toBe(-1);
    expect(compareSceneTime(index, "story", "missing", "second")).toBeNull();
  });
});
