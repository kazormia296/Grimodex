// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { partitionDeletableNodes } from "./MapCanvas";
import type { Node } from "@xyflow/react";

function node(id: string, type?: string): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} } as Node;
}

describe("partitionDeletableNodes", () => {
  it("フレームのみ → frameNodes に入り他は空", () => {
    const { frameNodes, immediateNodes, removeFromBoardNodes } =
      partitionDeletableNodes([node("frame:f1", "frame"), node("frame:f2")]);
    expect(frameNodes).toHaveLength(2);
    expect(immediateNodes).toHaveLength(0);
    expect(removeFromBoardNodes).toHaveLength(0);
  });

  it("sticky/ai_branchのみ → immediateNodes に入る", () => {
    const { frameNodes, immediateNodes, removeFromBoardNodes } =
      partitionDeletableNodes([node("sticky:s1"), node("ai_branch:a1")]);
    expect(frameNodes).toHaveLength(0);
    expect(immediateNodes).toHaveLength(2);
    expect(removeFromBoardNodes).toHaveLength(0);
  });

  it("scene/note/codex/snippet → removeFromBoardNodes に入り本体削除はされない", () => {
    const { immediateNodes, removeFromBoardNodes } = partitionDeletableNodes([
      node("scene:s1"),
      node("note:n1"),
      node("codex:c1"),
      node("snippet:sn1"),
    ]);
    expect(removeFromBoardNodes).toHaveLength(4);
    expect(immediateNodes).toHaveLength(0);
  });

  it("sticky + scene → sticky は immediateNodes、scene は removeFromBoardNodes", () => {
    const { immediateNodes, removeFromBoardNodes } = partitionDeletableNodes([
      node("scene:s1"),
      node("sticky:st1"),
    ]);
    expect(removeFromBoardNodes).toHaveLength(1);
    expect(removeFromBoardNodes[0].id).toBe("scene:s1");
    expect(immediateNodes).toHaveLength(1);
    expect(immediateNodes[0].id).toBe("sticky:st1");
  });

  it("frame + scene + sticky → 各カテゴリに分類される", () => {
    const { frameNodes, immediateNodes, removeFromBoardNodes } =
      partitionDeletableNodes([
        node("frame:f1", "frame"),
        node("scene:s1"),
        node("sticky:st1"),
      ]);
    expect(frameNodes).toHaveLength(1);
    expect(immediateNodes).toHaveLength(1);
    expect(removeFromBoardNodes).toHaveLength(1);
    expect(removeFromBoardNodes[0].id).toBe("scene:s1");
  });
});
