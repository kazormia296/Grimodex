// @vitest-environment happy-dom
//
// Trash Bin ドロップ先レジストリの hitTest 幾何判定を gate する。
// hitTest は target.rect() を引数化した純ロジック（containment + z-order 優先）なので、
// 合成 DOMRect を渡せば実ブラウザ無しで決定的に検証できる。これが TrashBin pickup の
// 「pointer 直下のどの target に落ちるか」を決める load-bearing な判定。
//
// スコープ注記: TrashBinPhysicsView の pointer ジェスチャ本体（setPointerCapture +
// DRAG_THRESHOLD + finishDrag→onDrop + rAF 物理）は実ブラウザでしか駆動できず、かつ
// programmatic には flaky なので、ここでは gate しない（監査でも bug 履歴は drop 座標/
// クランプ側で、hitTest の containment/z-order 自体の回帰履歴は無い）。hitTest 単体を
// 押さえるのが最も決定的で ROI が高い。
import { describe, it, expect, beforeEach } from "vitest";
import { useDropTargetRegistry } from "./dropTargetRegistry";
import type { DropTarget, DropTargetKind } from "./dropTargetRegistry";

function makeTarget(
  id: string,
  kind: DropTargetKind,
  rect: DOMRect | null,
  accepts: DropTarget["accepts"] = () => true,
): DropTarget {
  return {
    id,
    kind,
    rect: () => rect,
    accepts,
    onDrop: async () => {},
  };
}

const reg = () => useDropTargetRegistry.getState();

beforeEach(() => {
  useDropTargetRegistry.setState({ targets: new Map() });
});

describe("dropTargetRegistry.hitTest", () => {
  it("pointer が rect 内なら該当 target を返す（境界 inclusive）", () => {
    reg().register(
      makeTarget("a", "scene-editor", new DOMRect(0, 0, 100, 100)),
    );
    expect(reg().hitTest({ x: 50, y: 50 })?.id).toBe("a");
    // 端 (left/top/right/bottom) は inclusive
    expect(reg().hitTest({ x: 0, y: 0 })?.id).toBe("a");
    expect(reg().hitTest({ x: 100, y: 100 })?.id).toBe("a");
  });

  it("pointer が全 target の外なら null", () => {
    reg().register(
      makeTarget("a", "scene-editor", new DOMRect(0, 0, 100, 100)),
    );
    expect(reg().hitTest({ x: 101, y: 50 })).toBeNull();
    expect(reg().hitTest({ x: 50, y: 200 })).toBeNull();
  });

  it("重なった target は後に register した front-most が勝つ (z-order)", () => {
    reg().register(
      makeTarget("back", "scene-editor", new DOMRect(0, 0, 100, 100)),
    );
    reg().register(
      makeTarget("front", "codex-panel", new DOMRect(0, 0, 100, 100)),
    );
    expect(reg().hitTest({ x: 50, y: 50 })?.id).toBe("front");
  });

  it("rect()===null の target はスキップする", () => {
    reg().register(makeTarget("ghost", "map-panel", null));
    reg().register(
      makeTarget("real", "scene-editor", new DOMRect(0, 0, 100, 100)),
    );
    expect(reg().hitTest({ x: 50, y: 50 })?.id).toBe("real");
  });
});

describe("dropTargetRegistry register/unregister/findAccepting", () => {
  it("register が返す関数で unregister される", () => {
    const unregister = reg().register(
      makeTarget("a", "scene-editor", new DOMRect(0, 0, 100, 100)),
    );
    expect(reg().hitTest({ x: 50, y: 50 })?.id).toBe("a");
    unregister();
    expect(reg().hitTest({ x: 50, y: 50 })).toBeNull();
  });

  it("findAccepting は accepts(subKind) で絞り込む", () => {
    reg().register(
      makeTarget(
        "yes",
        "scene-editor",
        new DOMRect(0, 0, 1, 1),
        (s) => s === "text-fragment",
      ),
    );
    reg().register(
      makeTarget("no", "map-panel", new DOMRect(0, 0, 1, 1), () => false),
    );
    expect(
      reg()
        .findAccepting("text-fragment")
        .map((t) => t.id),
    ).toEqual(["yes"]);
  });
});
