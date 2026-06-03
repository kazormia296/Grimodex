// @vitest-environment happy-dom
//
// Grid の gridCollisionDetection（GridPanel から抽出した純ロジック）を合成 args で gate。
// gate しているのは「pointerWithin/rectIntersection の結果に対する snap/fallback の選別」だけ。
// 実 DOM rect の計測や dnd-kit の登録から over が解決されるか（live-rect glue）は別層
// （browser・drivability 未証明）で、ここでは対象外。← useBeatDragDrop の collision seam と同じ honest scope。
import { describe, it, expect } from "vitest";
import type { CollisionDetection } from "@dnd-kit/core";
import { gridCollisionDetection } from "./gridCollisionDetection";

function args(
  pointer: { x: number; y: number } | null,
  collisionRect: DOMRect,
  rects: Record<string, DOMRect>,
): Parameters<CollisionDetection>[0] {
  const droppableRects = new Map(Object.entries(rects));
  const droppableContainers = Object.keys(rects).map((id) => ({ id }));
  return {
    active: { id: "drag", data: { current: {} } },
    collisionRect,
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointer,
  } as unknown as Parameters<CollisionDetection>[0];
}

const ids = (out: ReturnType<CollisionDetection>) =>
  out.map((c) => String(c.id));

const R = (left: number, top: number, width: number, height: number) =>
  new DOMRect(left, top, width, height);

describe("gridCollisionDetection", () => {
  it("カード間ギャップでは最近接 scene-drop に snap する (20px 以内)", () => {
    // pointer(50,95) は column-slot 内・両 card の外（gap）。最近接は scene-drop-1(yDist=5)。
    const out = gridCollisionDetection(
      args({ x: 50, y: 95 }, R(0, 0, 1, 1), {
        "column-slot-A": R(0, 0, 100, 200),
        "scene-drop-1": R(0, 0, 100, 90),
        "scene-drop-2": R(0, 110, 100, 90),
      }),
    );
    expect(ids(out)).toEqual(["scene-drop-1"]);
  });

  it("最近接でも 20px を超えると snap せず column-slot のまま", () => {
    // gap 中央(y=150)で sd1/sd2 まで各 100px → 閾値超え → unsnapped pointerWithin
    const out = gridCollisionDetection(
      args({ x: 50, y: 150 }, R(0, 0, 1, 1), {
        "column-slot-A": R(0, 0, 100, 300),
        "scene-drop-1": R(0, 0, 100, 50),
        "scene-drop-2": R(0, 250, 100, 50),
      }),
    );
    expect(ids(out)).toEqual(["column-slot-A"]);
  });

  it("別カラムの scene-drop は同列ガードで除外（Y が近くても snap しない）", () => {
    const out = gridCollisionDetection(
      args({ x: 50, y: 95 }, R(0, 0, 1, 1), {
        "column-slot-A": R(0, 0, 100, 200),
        "scene-drop-other": R(200, 80, 100, 30), // 別カラム（X が slot の外）
      }),
    );
    expect(ids(out)).toEqual(["column-slot-A"]);
  });

  it("カード左右パディング(X 範囲外)では snap せず column reorder 領域を残す", () => {
    const out = gridCollisionDetection(
      args({ x: 10, y: 95 }, R(0, 0, 1, 1), {
        "column-slot-A": R(0, 0, 120, 200),
        "scene-drop-1": R(20, 0, 80, 90), // 左 20px はパディング
      }),
    );
    expect(ids(out)).toEqual(["column-slot-A"]);
  });

  it("pointer が全 droppable の外なら rectIntersection に fallback する", () => {
    // pointer 外・しかし collisionRect が droppable と重なる
    const out = gridCollisionDetection(
      args({ x: 500, y: 500 }, R(10, 10, 50, 50), {
        "column-slot-A": R(0, 0, 100, 100),
      }),
    );
    expect(ids(out)).toContain("column-slot-A");
  });
});
