// @vitest-environment happy-dom
//
// useScenesDnd.onDragEnd の複数選択 drag sequencing を gate。
// 合成 DragEndEvent + over.rect(dnd-kit が渡す値で getBoundingClientRect を呼ばない)で、
// 「選択ノードを sortOrder 昇順に並べ、prevAfterId を連鎖させて moveNode する」純配線を検証。
// pointerY は ref 初期値 0 のまま、over.rect.top を負にして "after" ゾーンに落とす
// （onDragMove / PointerEvent への依存を避ける）。
// スコープ: ゾーン閾値そのものは treeDropZone.test.ts、dnd-kit の over 解決は非対象。
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { DragEndEvent } from "@dnd-kit/core";
import { useScenesDnd } from "./useScenesDnd";
import { useTreeStore } from "./treeStore";
import type { TreeNodeData } from "./treeStore";

function node(id: string, sortOrder: string): TreeNodeData {
  return {
    id,
    parentId: null,
    nodeType: "scene",
    sortOrder,
  } as unknown as TreeNodeData;
}

// top=-30, height=40 → relY = pointerY(0) - (-30) = 30 ≥ h/2(20) → leaf "after"
const afterRect = {
  top: -30,
  left: 0,
  right: 100,
  bottom: 10,
  width: 100,
  height: 40,
};

function dropEnd(activeId: string, overId: string): DragEndEvent {
  return {
    active: { id: activeId },
    over: { id: `drop-${overId}`, rect: afterRect },
  } as unknown as DragEndEvent;
}

beforeEach(() => {
  useTreeStore.setState({ selectedIds: [] });
});

describe("useScenesDnd 複数選択 drag sequencing", () => {
  it("選択ノードを sortOrder 昇順で prevAfterId を連鎖させて moveNode する", () => {
    const moveNode = vi.fn().mockResolvedValue(undefined);
    const nodeMap = {
      a: node("a", "a2"),
      b: node("b", "a1"),
      t: node("t", "a5"),
    };
    useTreeStore.setState({ selectedIds: ["a", "b"] });

    const { result } = renderHook(() =>
      useScenesDnd({
        nodeMap,
        childMap: {},
        flatNodes: [nodeMap.b, nodeMap.a, nodeMap.t],
        moveNode,
      }),
    );

    act(() => {
      result.current.onDragEnd(dropEnd("a", "t"));
    });

    // scene "t" の after。selected を sortOrder 昇順([b=a1, a=a2])で連鎖配置。
    expect(moveNode.mock.calls).toEqual([
      ["b", null, "t"],
      ["a", null, "b"],
    ]);
  });

  it("単一選択は moveNode を1回だけ呼ぶ", () => {
    const moveNode = vi.fn().mockResolvedValue(undefined);
    const nodeMap = { a: node("a", "a2"), t: node("t", "a5") };
    useTreeStore.setState({ selectedIds: ["a"] }); // length 1 → 非 multiselect

    const { result } = renderHook(() =>
      useScenesDnd({
        nodeMap,
        childMap: {},
        flatNodes: [nodeMap.a, nodeMap.t],
        moveNode,
      }),
    );

    act(() => {
      result.current.onDragEnd(dropEnd("a", "t"));
    });

    expect(moveNode.mock.calls).toEqual([["a", null, "t"]]);
  });
});
