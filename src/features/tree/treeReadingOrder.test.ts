import { describe, expect, it } from "vitest";
import { orderNodesInReadingOrder } from "./treeReadingOrder";

const n = (
  id: string,
  parentId: string | null,
  nodeType: "folder" | "scene" | "note",
  sortOrder: string,
) => ({ id, parentId, nodeType, sortOrder });

describe("orderNodesInReadingOrder", () => {
  it("兄弟ごとの sortOrder で DFS の pre-order に並べ、全体を 1 回の sortOrder で並べない", () => {
    const nodes = [
      n("s-b2", "ch-b", "scene", "a1"),
      n("ch-b", "part", "folder", "a1"),
      n("s-a1", "ch-a", "scene", "a0"),
      n("part", null, "folder", "a0"),
      n("ch-a", "part", "folder", "a0"),
      n("s-b1", "ch-b", "scene", "a0"),
      n("memo", null, "note", "a1"),
    ];
    const ordered = orderNodesInReadingOrder(nodes);
    expect(ordered.map((e) => e.node.id)).toEqual([
      "part",
      "ch-a",
      "s-a1",
      "ch-b",
      "s-b1",
      "s-b2",
      "memo",
    ]);
    expect(ordered.map((e) => e.depth)).toEqual([0, 1, 2, 1, 2, 2, 0]);
  });

  it("同順位は id で決める（入力の順に依存しない）", () => {
    const a = orderNodesInReadingOrder([
      n("b", null, "scene", "a0"),
      n("a", null, "scene", "a0"),
    ]);
    const b = orderNodesInReadingOrder([
      n("a", null, "scene", "a0"),
      n("b", null, "scene", "a0"),
    ]);
    expect(a.map((e) => e.node.id)).toEqual(["a", "b"]);
    expect(b.map((e) => e.node.id)).toEqual(["a", "b"]);
  });

  it("root から届かない node（親が入力に無い・循環）は捨てずに末尾へ足す", () => {
    const nodes = [
      n("root-s", null, "scene", "a0"),
      n("orphan-folder", "gone", "folder", "a0"),
      n("orphan-s", "orphan-folder", "scene", "a0"),
      n("loop-a", "loop-b", "folder", "a0"),
      n("loop-b", "loop-a", "folder", "a0"),
    ];
    const ids = orderNodesInReadingOrder(nodes).map((e) => e.node.id);
    expect(ids).toEqual([
      "root-s",
      "orphan-folder",
      "orphan-s",
      "loop-a",
      "loop-b",
    ]);
    expect(new Set(ids).size).toBe(nodes.length);
  });
});
