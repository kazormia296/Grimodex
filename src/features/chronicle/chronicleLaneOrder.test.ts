import { describe, expect, it } from "vitest";
import {
  orderIndexMap,
  compareByLaneOrder,
  reorderLaneOrder,
  dropAfter,
} from "./chronicleLaneOrder";

const sortBy = (
  items: { id: string; name: string }[],
  order: string[],
): string[] => {
  const oi = orderIndexMap(order);
  return [...items]
    .sort((a, b) => compareByLaneOrder(a, b, oi))
    .map((x) => x.id);
};

describe("compareByLaneOrder", () => {
  const items = [
    { id: "c1", name: "Alpha" },
    { id: "c2", name: "Bravo" },
    { id: "c3", name: "Charlie" },
  ];

  it("order 無しは name 昇順", () => {
    expect(sortBy(items, [])).toEqual(["c1", "c2", "c3"]);
  });

  it("order にある id は order 順で先頭、残りは name 昇順", () => {
    // c3,c1 を明示順 → 先頭に c3,c1、その後 name 順で c2。
    expect(sortBy(items, ["c3", "c1"])).toEqual(["c3", "c1", "c2"]);
  });

  it("全 id を order に並べればその通り", () => {
    expect(sortBy(items, ["c2", "c3", "c1"])).toEqual(["c2", "c3", "c1"]);
  });

  it("order 中の stale id は present の相対順を壊さない", () => {
    // "ghost" は items に無いが、c2 と c1 の相対順は維持される。
    expect(sortBy(items, ["c2", "ghost", "c1"])).toEqual(["c2", "c1", "c3"]);
  });
});

describe("reorderLaneOrder", () => {
  const cur = ["a", "b", "c", "d"];

  it("target の前へ挿入", () => {
    expect(reorderLaneOrder(cur, "d", "b", false)).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  it("target の後へ挿入", () => {
    expect(reorderLaneOrder(cur, "a", "c", true)).toEqual(["b", "c", "a", "d"]);
  });

  it("target=null は末尾へ", () => {
    expect(reorderLaneOrder(cur, "a", null, false)).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
  });

  it("同一 target は末尾扱い（no-op に近い）", () => {
    expect(reorderLaneOrder(cur, "b", "b", false)).toEqual([
      "a",
      "c",
      "d",
      "b",
    ]);
  });

  it("dragged が無ければそのまま", () => {
    expect(reorderLaneOrder(cur, "z", "b", false)).toBe(cur);
  });

  it("先頭へ挿入（insertAt=0）", () => {
    expect(reorderLaneOrder(["a", "b", "c"], "c", "a", false)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("隣接スワップ（after で1つ後ろへ）", () => {
    expect(reorderLaneOrder(["a", "b", "c"], "a", "b", true)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("target 不在は末尾へ", () => {
    expect(reorderLaneOrder(["a", "b"], "a", "ghost", false)).toEqual([
      "b",
      "a",
    ]);
  });
});

describe("dropAfter", () => {
  const rect = { top: 100, height: 40 }; // 中点 120
  it("上半分は前（false）", () => {
    expect(dropAfter(110, rect)).toBe(false);
  });
  it("下半分は後（true）", () => {
    expect(dropAfter(130, rect)).toBe(true);
  });
  it("ちょうど中点は前（境界は前寄せ）", () => {
    expect(dropAfter(120, rect)).toBe(false);
  });
});
