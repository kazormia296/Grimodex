import { describe, expect, it } from "vitest";
import {
  orderIndexMap,
  compareByLaneOrder,
  dropIndexByMidpoints,
  moveToIndex,
  mergeLaneOrder,
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

describe("dropIndexByMidpoints", () => {
  // active 除く兄弟の midpoint（表示順）。例: 3 兄弟が 20/60/100。
  const mids = [20, 60, 100];
  it("全 midpoint より上 → index 0", () => {
    expect(dropIndexByMidpoints(10, mids)).toBe(0);
  });
  it("1つ越える → index 1", () => {
    expect(dropIndexByMidpoints(40, mids)).toBe(1);
  });
  it("2つ越える → index 2", () => {
    expect(dropIndexByMidpoints(80, mids)).toBe(2);
  });
  it("全部越える → index 3（末尾）", () => {
    expect(dropIndexByMidpoints(120, mids)).toBe(3);
  });
  it("ちょうど midpoint は越えない（> 判定）", () => {
    expect(dropIndexByMidpoints(60, mids)).toBe(1);
  });
});

describe("mergeLaneOrder", () => {
  const allExist = () => true;

  it("不可視 codex は絶対位置を維持し可視だけ並べ替わる", () => {
    // prev: A(可視) X(不可視) B(可視)。可視を [B,A] に → [B, X, A]（X 中央維持）。
    expect(mergeLaneOrder(["A", "X", "B"], ["B", "A"], allExist)).toEqual([
      "B",
      "X",
      "A",
    ]);
  });

  it("可視のみなら newOrder と一致", () => {
    expect(mergeLaneOrder(["A", "B"], ["B", "A"], allExist)).toEqual([
      "B",
      "A",
    ]);
  });

  it("prev に無い新規可視は後置", () => {
    expect(mergeLaneOrder(["A", "B"], ["C", "B", "A"], allExist)).toEqual([
      "C",
      "B",
      "A",
    ]);
  });

  it("削除済み（非存在）の不可視 id は捨てる", () => {
    // X は存在しない → ドロップ。
    const exists = (id: string) => id !== "X";
    expect(mergeLaneOrder(["A", "X", "B"], ["B", "A"], exists)).toEqual([
      "B",
      "A",
    ]);
  });
});

describe("moveToIndex", () => {
  const order = ["a", "b", "c", "d"];
  it("index 0 へ", () => {
    expect(moveToIndex(order, "c", 0)).toEqual(["c", "a", "b", "d"]);
  });
  it("中間へ（除去後の index）", () => {
    expect(moveToIndex(order, "a", 2)).toEqual(["b", "c", "a", "d"]);
  });
  it("末尾へ（クランプ）", () => {
    expect(moveToIndex(order, "a", 99)).toEqual(["b", "c", "d", "a"]);
  });
  it("同位置は実質 no-op", () => {
    expect(moveToIndex(order, "b", 1)).toEqual(["a", "b", "c", "d"]);
  });
  it("id が無ければそのまま", () => {
    expect(moveToIndex(order, "z", 0)).toBe(order);
  });
});
