import { describe, expect, it } from "vitest";
import type { TreeNodeData } from "@/features/tree/treeStore";
import {
  buildSceneTimeIndex,
  compareSceneTime,
  isAutoStoryReady,
  linearizeSceneTimeIndex,
  listScenesBeforeInReadingOrder,
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

describe("listScenesBeforeInReadingOrder", () => {
  const folder = (
    id: string,
    sortOrder: string,
    parentId: string | null = null,
    overrides: Partial<TreeNodeData> = {},
  ) =>
    node(id, sortOrder, null, {
      nodeType: "folder",
      parentId,
      ...overrides,
    });
  const scene = (id: string, sortOrder: string, parentId: string | null) =>
    node(id, sortOrder, null, { parentId });
  const ids = (nodes: TreeNodeData[]) => nodes.map((n) => n.id);

  it("章をまたぐときは sortOrder でなく木の DFS 順で前後を決める", () => {
    const nodes = [
      folder("ch1", "a0"),
      folder("ch2", "a1"),
      scene("c2s1", "a0", "ch2"),
      scene("c1s2", "a1", "ch1"),
      scene("c1s1", "a0", "ch1"),
    ];

    // 章 2 の 1 場面目は sortOrder（a0）では c1s2（a1）より小さいが、読む順では後
    expect(ids(listScenesBeforeInReadingOrder(nodes, "c1s2"))).toEqual([
      "c1s1",
    ]);
    expect(ids(listScenesBeforeInReadingOrder(nodes, "c2s1"))).toEqual([
      "c1s1",
      "c1s2",
    ]);
    expect(listScenesBeforeInReadingOrder(nodes, "c1s1")).toEqual([]);
  });

  it("入れ子の folder（part と chapter）も深さ優先で辿る", () => {
    const nodes = [
      folder("part1", "a0"),
      folder("part2", "a1"),
      folder("p1ch1", "a0", "part1"),
      folder("p1ch2", "a1", "part1"),
      folder("p2ch1", "a0", "part2"),
      scene("p1c1s1", "a0", "p1ch1"),
      scene("p1c2s1", "a0", "p1ch2"),
      scene("p2c1s1", "a0", "p2ch1"),
      scene("part2-direct", "b0", "part2"),
    ];

    expect(ids(listScenesBeforeInReadingOrder(nodes, "p2c1s1"))).toEqual([
      "p1c1s1",
      "p1c2s1",
    ]);
    expect(ids(listScenesBeforeInReadingOrder(nodes, "part2-direct"))).toEqual([
      "p1c1s1",
      "p1c2s1",
      "p2c1s1",
    ]);
    expect(ids(listScenesBeforeInReadingOrder(nodes, "p1c2s1"))).toEqual([
      "p1c1s1",
    ]);
  });

  it("archived の folder の配下の場面は前にも現在にも数えない", () => {
    const nodes = [
      folder("ch1", "a0", null, { archivedAt: "2026-01-02T00:00:00.000Z" }),
      folder("ch2", "a1"),
      scene("archived-child", "a0", "ch1"),
      scene("c2s1", "a0", "ch2"),
      scene("c2s2", "a1", "ch2"),
    ];

    expect(ids(listScenesBeforeInReadingOrder(nodes, "c2s2"))).toEqual([
      "c2s1",
    ]);
    expect(listScenesBeforeInReadingOrder(nodes, "archived-child")).toEqual([]);
  });

  it("archived の場面は前に含めない", () => {
    const nodes = [
      node("a", "a0", null, { archivedAt: "2026-01-02T00:00:00.000Z" }),
      node("b", "a1"),
      node("c", "a2"),
    ];

    expect(ids(listScenesBeforeInReadingOrder(nodes, "c"))).toEqual(["b"]);
  });

  it("現在の場面が孤児・archived・存在しないときは空配列を返す", () => {
    const nodes = [
      folder("ch1", "a0"),
      scene("c1s1", "a0", "ch1"),
      scene("orphan", "a1", "missing-parent"),
      node("gone", "a2", null, { archivedAt: "2026-01-02T00:00:00.000Z" }),
    ];

    expect(listScenesBeforeInReadingOrder(nodes, "orphan")).toEqual([]);
    expect(listScenesBeforeInReadingOrder(nodes, "gone")).toEqual([]);
    expect(listScenesBeforeInReadingOrder(nodes, "unknown")).toEqual([]);
    // 孤児は他の場面の「前」にも出ない
    expect(ids(listScenesBeforeInReadingOrder(nodes, "c1s1"))).toEqual([]);
  });

  it("sortOrder が衝突しても id で決定的に並ぶ", () => {
    const nodes = [
      scene("z", "a0", null),
      scene("m", "a0", null),
      scene("cur", "a1", null),
    ];

    expect(ids(listScenesBeforeInReadingOrder(nodes, "cur"))).toEqual([
      "m",
      "z",
    ]);
  });
});
