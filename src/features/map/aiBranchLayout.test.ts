import { describe, it, expect } from "vitest";
import { computeAiBranchLayout } from "./aiBranchLayout";

describe("computeAiBranchLayout", () => {
  it("count=0 のとき branch のみ返す", () => {
    const { branch, cards } = computeAiBranchLayout(0, 0, 0, []);
    expect(branch).toEqual({ x: 0, y: 0 });
    expect(cards).toEqual([]);
  });

  it("branch アンカーは spawn 位置のまま動かさない", () => {
    const { branch } = computeAiBranchLayout(150, -200, 5, []);
    expect(branch).toEqual({ x: 150, y: -200 });
  });

  it("count に対して cols×rows のグリッドを生成する", () => {
    // count=8 → cols=ceil(sqrt(8))=3, rows=ceil(8/3)=3
    const { cards } = computeAiBranchLayout(0, 0, 8, []);
    expect(cards).toHaveLength(8);
    // 3列なので i=3 (2 行目最初) の y が i=0..2 と異なる。
    expect(cards[0].y).toBe(cards[1].y);
    expect(cards[0].y).toBe(cards[2].y);
    expect(cards[3].y).not.toBe(cards[0].y);
    // 同一行内の x は単調増加
    expect(cards[1].x).toBeGreaterThan(cards[0].x);
    expect(cards[2].x).toBeGreaterThan(cards[1].x);
  });

  it("既存ノードが密な方向を避けてクラスタを置く", () => {
    // spawn の右側 (+x, y≈0) に密集帯。クラスタはここを避けて配置される。
    const existing = Array.from({ length: 20 }, (_, i) => ({
      x: 400 + (i % 5) * 60,
      y: -100 + Math.floor(i / 5) * 60,
    }));
    const { cards } = computeAiBranchLayout(0, 0, 5, existing);
    // どのカードも密集帯 (x≈400..640, y≈-100..80) の中に置かれていない
    for (const c of cards) {
      const insideCluster =
        c.x >= 340 && c.x <= 700 && c.y >= -160 && c.y <= 140;
      expect(insideCluster).toBe(false);
    }
  });

  it("空間が完全に空のときも spawn から最小オフセット以上離す", () => {
    const { cards } = computeAiBranchLayout(0, 0, 3, []);
    // 全カードの中心からの距離はクラスタの中心オフセット (≥320) を反映している
    const minDistFromSpawn = Math.min(
      ...cards.map((c) => Math.hypot(c.x, c.y)),
    );
    // クラスタ中心からの内側カードでも、spawn からそれなりに離れていること
    expect(minDistFromSpawn).toBeGreaterThan(100);
  });

  it("座標は整数に丸められている (React Flow 用)", () => {
    const { cards } = computeAiBranchLayout(0, 0, 5, []);
    for (const c of cards) {
      expect(Number.isInteger(c.x)).toBe(true);
      expect(Number.isInteger(c.y)).toBe(true);
    }
  });
});
