import { describe, it, expect } from "vitest";
import { Position } from "@xyflow/react";
import {
  bezierAt,
  bezierTangent,
  getBezierControlPoints,
  getLabelPos,
  halfExtent,
} from "./labelGeometry";

describe("labelGeometry — bezier primitives", () => {
  it("bezierAt(t=0) と t=1 で端点を返す", () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 10, y: 0 };
    const p2 = { x: 20, y: 0 };
    const p3 = { x: 30, y: 0 };
    expect(bezierAt(p0, p1, p2, p3, 0)).toEqual({ x: 0, y: 0 });
    expect(bezierAt(p0, p1, p2, p3, 1)).toEqual({ x: 30, y: 0 });
  });

  it("水平な直線では bezierTangent が x 方向を向く", () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 10, y: 0 };
    const p2 = { x: 20, y: 0 };
    const p3 = { x: 30, y: 0 };
    const t = bezierTangent(p0, p1, p2, p3, 0.5);
    expect(Math.abs(t.y)).toBeLessThan(1e-9);
    expect(t.x).toBeGreaterThan(0);
  });
});

describe("labelGeometry — halfExtent", () => {
  it("水平方向の支持長は W/2", () => {
    expect(halfExtent(1, 0, 40, 20)).toBeCloseTo(20);
  });
  it("垂直方向の支持長は H/2", () => {
    expect(halfExtent(0, 1, 40, 20)).toBeCloseTo(10);
  });
  it("45 度斜め方向は (W+H)/(2√2) に等しい", () => {
    const s = 1 / Math.sqrt(2);
    expect(halfExtent(s, s, 40, 20)).toBeCloseTo(
      (40 + 20) / (2 * Math.sqrt(2)),
    );
  });
});

describe("labelGeometry — getBezierControlPoints", () => {
  it("Right→Left 構成で制御点が source/target の中間 x を取る", () => {
    const cps = getBezierControlPoints(
      0,
      0,
      Position.Right,
      100,
      0,
      Position.Left,
    );
    expect(cps.p0).toEqual({ x: 0, y: 0 });
    expect(cps.p3).toEqual({ x: 100, y: 0 });
    // distance = 100 (>=0) → 0.5*100 = 50
    expect(cps.p1).toEqual({ x: 50, y: 0 });
    expect(cps.p2).toEqual({ x: 50, y: 0 });
  });
});

describe("labelGeometry — getLabelPos", () => {
  const W = 40;
  const H = 20;

  it("水平な辺ではラベルが垂直方向に halfExtent+padding 押し出される", () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 50, y: 0 };
    const p2 = { x: 50, y: 0 };
    const p3 = { x: 100, y: 0 };
    const above = getLabelPos(p0, p1, p2, p3, W, H, { x: 0, y: -1 }, 6);
    // 水平 chord (tangent ≈ x 方向) で N=(0,±1) の場合、halfExtent = H/2 = 10
    // 期待値: y = 0 - (10+6) = -16, x = 50 (中点)
    expect(above.x).toBeCloseTo(50);
    expect(above.y).toBeCloseTo(-16);
  });

  it("垂直な辺ではラベルが水平方向に halfExtent+padding 押し出される", () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 0, y: 50 };
    const p2 = { x: 0, y: 50 };
    const p3 = { x: 0, y: 100 };
    const right = getLabelPos(p0, p1, p2, p3, W, H, { x: 1, y: 0 }, 6);
    // 垂直 chord で N=(±1,0) → halfExtent = W/2 = 20、右側は x = 0+(20+6) = 26
    expect(right.x).toBeCloseTo(26);
    expect(right.y).toBeCloseTo(50);
  });

  it("反対側の outwardHint を渡すと符号が反転する", () => {
    const p0 = { x: 0, y: 0 };
    const p1 = { x: 50, y: 0 };
    const p2 = { x: 50, y: 0 };
    const p3 = { x: 100, y: 0 };
    const above = getLabelPos(p0, p1, p2, p3, W, H, { x: 0, y: -1 }, 6);
    const below = getLabelPos(p0, p1, p2, p3, W, H, { x: 0, y: 1 }, 6);
    expect(above.y).toBeCloseTo(-below.y);
    expect(above.x).toBeCloseTo(below.x);
  });

  it("曲率が straight→curved→straight と推移してもラベル側が反転しない", () => {
    // R→L フローティング辺で source と target を少しずつずらすと、曲率がほぼ
    // 直線になる瞬間に bezier tangent normal の符号が反転する可能性がある。
    // chord normal を sign 基準にしているおかげで連続変化のはずなのを確認。
    const W = 40;
    const H = 20;
    const positions = [];
    for (let i = -5; i <= 5; i++) {
      const sx = 0;
      const sy = i; // 上下に少しずつずらす
      const tx = 100;
      const ty = 0;
      const cps = getBezierControlPoints(
        sx,
        sy,
        Position.Right,
        tx,
        ty,
        Position.Left,
      );
      // outwardHint は固定 (常に「上」)
      const pos = getLabelPos(
        cps.p0,
        cps.p1,
        cps.p2,
        cps.p3,
        W,
        H,
        { x: 0, y: -1 },
        6,
      );
      positions.push(pos);
    }
    // すべての y が中点より「上」(画面座標で y が小さい) 側にあること
    for (let i = 0; i < positions.length; i++) {
      const midY = positions[i].y;
      // chord y midpoint ≈ (sy + ty) / 2 = i/2
      const expectedMidY = (i - 5) / 2; // ループ変数 = i-5
      expect(midY).toBeLessThan(expectedMidY);
    }
    // 隣り合うラベル位置が大きくジャンプしていないこと (連続性)
    for (let i = 1; i < positions.length; i++) {
      const dy = Math.abs(positions[i].y - positions[i - 1].y);
      expect(dy).toBeLessThan(5);
    }
  });
});
