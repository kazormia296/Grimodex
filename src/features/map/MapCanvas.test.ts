// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { partitionDeletableNodes } from "./MapCanvas";
import type { Node } from "@xyflow/react";

function node(id: string, type?: string): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} } as Node;
}

describe("partitionDeletableNodes", () => {
  it("フレームのみ → frameNodes に入り他は空", () => {
    const { frameNodes, showDialog, immediateNodes } = partitionDeletableNodes([
      node("frame:f1", "frame"),
      node("frame:f2"),
    ]);
    expect(frameNodes).toHaveLength(2);
    expect(showDialog).toHaveLength(0);
    expect(immediateNodes).toHaveLength(0);
  });

  it("sticky/ai_branchのみ → immediateNodes に入り showDialog は空", () => {
    const { frameNodes, showDialog, immediateNodes } = partitionDeletableNodes([
      node("sticky:s1"),
      node("ai_branch:a1"),
    ]);
    expect(frameNodes).toHaveLength(0);
    expect(showDialog).toHaveLength(0);
    expect(immediateNodes).toHaveLength(2);
  });

  it("scene/note/codexのみ → showDialog に入り immediateNodes は空", () => {
    const { showDialog, immediateNodes } = partitionDeletableNodes([
      node("scene:s1"),
      node("note:n1"),
      node("codex:c1"),
    ]);
    expect(showDialog).toHaveLength(3);
    expect(immediateNodes).toHaveLength(0);
  });

  it("sticky + scene → sticky は immediateNodes、scene は showDialog", () => {
    const { showDialog, immediateNodes } = partitionDeletableNodes([
      node("scene:s1"),
      node("sticky:st1"),
    ]);
    expect(showDialog).toHaveLength(1);
    expect(showDialog[0].id).toBe("scene:s1");
    expect(immediateNodes).toHaveLength(1);
    expect(immediateNodes[0].id).toBe("sticky:st1");
  });

  it("frame + scene + sticky → 各カテゴリに分類される", () => {
    const { frameNodes, showDialog, immediateNodes } = partitionDeletableNodes([
      node("frame:f1", "frame"),
      node("scene:s1"),
      node("sticky:st1"),
    ]);
    expect(frameNodes).toHaveLength(1);
    expect(showDialog).toHaveLength(1);
    expect(immediateNodes).toHaveLength(1);
  });

  it("snippet → snippetNodes に入り他には影響しない", () => {
    const { snippetNodes, showDialog, immediateNodes } =
      partitionDeletableNodes([node("snippet:sn1")]);
    expect(snippetNodes).toHaveLength(1);
    expect(showDialog).toHaveLength(0);
    expect(immediateNodes).toHaveLength(0);
  });
});
