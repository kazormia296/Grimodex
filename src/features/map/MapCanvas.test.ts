// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { partitionDeletableNodes } from "./MapCanvas";
import type { Node } from "@xyflow/react";

function node(id: string, type?: string): Node {
  return { id, type, position: { x: 0, y: 0 }, data: {} } as Node;
}

describe("partitionDeletableNodes", () => {
  it("フレームのみ → frameNodes に入り showDialog/immediateAI は空", () => {
    const { frameNodes, showDialog, immediateAI } = partitionDeletableNodes([
      node("frame:f1", "frame"),
      node("frame:f2"),
    ]);
    expect(frameNodes).toHaveLength(2);
    expect(showDialog).toHaveLength(0);
    expect(immediateAI).toHaveLength(0);
  });

  it("AIのみ → immediateAI に入り showDialog は空", () => {
    const { frameNodes, showDialog, immediateAI } = partitionDeletableNodes([
      node("ai:a1"),
      node("ai:a2"),
    ]);
    expect(frameNodes).toHaveLength(0);
    expect(showDialog).toHaveLength(0);
    expect(immediateAI).toHaveLength(2);
  });

  it("scene/note/codexのみ → showDialog に入り immediateAI は空", () => {
    const { showDialog, immediateAI } = partitionDeletableNodes([
      node("scene:s1"),
      node("note:n1"),
      node("codex:c1"),
    ]);
    expect(showDialog).toHaveLength(3);
    expect(immediateAI).toHaveLength(0);
  });

  it("AI + scene → showDialog に両方含まれ immediateAI は空", () => {
    const { showDialog, immediateAI } = partitionDeletableNodes([
      node("scene:s1"),
      node("ai:a1"),
    ]);
    expect(showDialog).toHaveLength(2);
    expect(showDialog.map((n) => n.id)).toContain("scene:s1");
    expect(showDialog.map((n) => n.id)).toContain("ai:a1");
    expect(immediateAI).toHaveLength(0);
  });

  it("frame + AI + scene → frame は即削除、AI+scene は dialog", () => {
    const { frameNodes, showDialog, immediateAI } = partitionDeletableNodes([
      node("frame:f1", "frame"),
      node("scene:s1"),
      node("ai:a1"),
    ]);
    expect(frameNodes).toHaveLength(1);
    expect(showDialog).toHaveLength(2);
    expect(immediateAI).toHaveLength(0);
  });
});
