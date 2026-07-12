import { describe, expect, it, vi } from "vitest";
import { moveTreeNode, type MoveTreeNodePorts } from "./moveTreeNode";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { HistoryCommand } from "@/store/globalHistoryStore";
import { cmpKeys } from "@/features/tree/fractionalIndex";

function node(id: string, sortOrder: string): TreeNodeData {
  return {
    id,
    projectId: "project-a",
    parentId: null,
    nodeType: "scene",
    title: id,
    synopsis: null,
    intent: null,
    sortOrder,
    status: null,
    storyTimeOrder: null,
    storyTimeLabel: null,
    povCharacterId: null,
    locationId: null,
    charCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

function harness(nodes: TreeNodeData[]): MoveTreeNodePorts & {
  currentNodes: TreeNodeData[];
  history: HistoryCommand[];
} {
  const state = { nodes: [...nodes] };
  const history: HistoryCommand[] = [];
  return {
    get currentNodes() {
      return state.nodes;
    },
    history,
    getNodes: () => state.nodes,
    applyNodes: (next) => {
      state.nodes = next;
    },
    persist: vi.fn().mockResolvedValue(undefined),
    recomputeSceneOrder: vi.fn(),
    isReplaying: () => false,
    pushHistory: (command) => history.push(command),
    recordChange: vi.fn(),
    movedLabel: "moved",
  };
}

describe("moveTreeNode", () => {
  it("applies an optimistic move and preserves undo/redo ordering", async () => {
    const ports = harness([node("a", "a0"), node("b", "a1")]);

    await moveTreeNode("b", null, null, ports);

    expect(
      cmpKeys(
        ports.currentNodes.find((entry) => entry.id === "b")!.sortOrder,
        "a0",
      ),
    ).toBe(-1);
    expect(ports.history).toHaveLength(1);
    await ports.history[0]!.undo();
    expect(
      ports.currentNodes.find((entry) => entry.id === "b")?.sortOrder,
    ).toBe("a1");
    await ports.history[0]!.redo();
    expect(
      cmpKeys(
        ports.currentNodes.find((entry) => entry.id === "b")!.sortOrder,
        "a0",
      ),
    ).toBe(-1);
  });

  it("passes null parent ids through to persistence", async () => {
    const ports = harness([{ ...node("a", "a0"), parentId: "folder" }]);

    await moveTreeNode("a", null, undefined, ports);

    expect(ports.persist).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({ parentId: null }),
    );
  });
});
