import { describe, expect, it, vi } from "vitest";
import { createTreeNode, type CreateTreeNodePorts } from "./createTreeNode";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { HistoryCommand } from "@/store/globalHistoryStore";

function makeNode(id: string, title: string): TreeNodeData {
  return {
    id,
    projectId: "project-a",
    parentId: null,
    nodeType: "scene",
    title,
    synopsis: null,
    intent: null,
    sortOrder: "a0",
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

function ports(nodes: TreeNodeData[]): CreateTreeNodePorts & {
  current: TreeNodeData[];
  history: HistoryCommand[];
} {
  const state = { nodes: [...nodes] };
  const history: HistoryCommand[] = [];
  return {
    current: state.nodes,
    history,
    ensureWritable: vi.fn(),
    getProjectId: () => "project-a",
    getNodes: () => state.nodes,
    isCurrentAuthority: () => true,
    getSetting: (_key, fallback) => fallback,
    createPersisted: vi.fn(async (record) => makeNode(record.id, record.title)),
    deletePersisted: vi.fn().mockResolvedValue(undefined),
    recreatePersisted: vi.fn(async (node) => node),
    tryAcquireNavigationAuthority: () => ({ release: vi.fn() }),
    applyCreated: (node) => {
      state.nodes = [...state.nodes, node];
    },
    applyRemoved: (id) => {
      state.nodes = state.nodes.filter((node) => node.id !== id);
    },
    recomputeSceneOrder: vi.fn(),
    closeTabs: vi.fn(),
    revealEditorDocument: vi.fn(),
    isReplaying: () => false,
    pushHistory: (command) => history.push(command),
    recordChange: vi.fn(),
  };
}

describe("createTreeNode", () => {
  it("creates a named node and composes undo/redo through ports", async () => {
    const testPorts = ports([]);
    const created = await createTreeNode(
      { nodeType: "scene", parentId: null },
      testPorts,
    );

    expect(created).not.toBeNull();
    expect(created!.title).toBe("シーン 1");
    expect(testPorts.history).toHaveLength(1);
    expect(testPorts.history[0]).toMatchObject({
      kind: "scenes",
      entityId: created!.id,
    });
    await testPorts.history[0]!.undo();
    expect(testPorts.closeTabs).toHaveBeenCalledWith(created!.id);
    await testPorts.history[0]!.redo();
    expect(testPorts.revealEditorDocument).toHaveBeenCalledWith(created!.id);
  });

  it("keeps mobile creation undoable without revealing a desktop tab on redo", async () => {
    const testPorts = ports([]);
    const created = await createTreeNode(
      {
        nodeType: "scene",
        parentId: null,
        interaction: "mobile",
      },
      testPorts,
    );

    expect(testPorts.history).toHaveLength(1);
    await testPorts.history[0]!.undo();
    await testPorts.history[0]!.redo();

    expect(testPorts.recreatePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ id: created!.id }),
    );
    expect(testPorts.revealEditorDocument).not.toHaveBeenCalled();
  });
});
