import { describe, it, expect } from "vitest";
import {
  centerOutRows,
  rankThreadsBySubwayImportance,
  orderThreadsBySubwayImportance,
} from "./plotThreadOrder";

function t(id: string, sortOrder: string) {
  return { id, sortOrder };
}
const imp =
  (map: Record<string, number>) =>
  (id: string): number =>
    map[id] ?? 0;

describe("centerOutRows", () => {
  it("rank 順を中央から外へ配置（rows[rank]=行 index）", () => {
    expect(centerOutRows(1)).toEqual([0]);
    expect(centerOutRows(3)).toEqual([1, 2, 0]); // rank0→中央, rank1→下, rank2→上
    expect(centerOutRows(4)).toEqual([2, 1, 3, 0]);
  });
});

describe("rankThreadsBySubwayImportance", () => {
  it("重要度降順 → sortOrder → id", () => {
    const ths = [t("t1", "a0"), t("t2", "a1"), t("t3", "a2")];
    const r = rankThreadsBySubwayImportance(ths, imp({ t1: 1, t2: 3, t3: 2 }));
    expect(r.map((x) => x.id)).toEqual(["t2", "t3", "t1"]);
  });

  it("同重要度は sortOrder で安定", () => {
    const ths = [t("b", "a2"), t("a", "a0"), t("c", "a1")];
    const r = rankThreadsBySubwayImportance(ths, imp({ a: 2, b: 2, c: 2 }));
    expect(r.map((x) => x.id)).toEqual(["a", "c", "b"]);
  });
});

describe("orderThreadsBySubwayImportance", () => {
  it("最重要を中央に置く視覚順（Timeline の行と一致）", () => {
    const ths = [t("t1", "a0"), t("t2", "a1"), t("t3", "a2")];
    // 重要度 t2>t3>t1 → rank [t2,t3,t1] → center-out 行 [1,2,0] → 視覚順 [t1,t2,t3]
    const o = orderThreadsBySubwayImportance(ths, imp({ t1: 1, t2: 3, t3: 2 }));
    expect(o.map((x) => x.id)).toEqual(["t1", "t2", "t3"]);
  });
});
