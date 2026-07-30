import { describe, expect, it, vi } from "vitest";
import {
  deleteTreeSubtree,
  type DeleteTreeSubtreePorts,
} from "./deleteTreeSubtree";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { HistoryCommand } from "@/store/globalHistoryStore";

function node(
  id: string,
  parentId: string | null,
  nodeType: "folder" | "scene" = "scene",
): TreeNodeData {
  return {
    id,
    projectId: "project-a",
    parentId,
    nodeType,
    title: id,
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

function ports(nodes: TreeNodeData[]): DeleteTreeSubtreePorts & {
  current: TreeNodeData[];
  history: HistoryCommand[];
} {
  const state = { nodes: [...nodes], active: "scene" };
  const history: HistoryCommand[] = [];
  return {
    get current() {
      return state.nodes;
    },
    history,
    guardPending: () => false,
    tryAcquireNavigationAuthority: () => ({ release: vi.fn() }),
    getNodes: () => state.nodes,
    getActiveSceneId: () => state.active,
    loadSceneContent: vi.fn().mockResolvedValue("content"),
    deletePersisted: vi.fn().mockResolvedValue(undefined),
    restorePersisted: vi.fn().mockResolvedValue(undefined),
    saveSceneContent: vi.fn().mockResolvedValue(undefined),
    applyNodes: (next, active) => {
      state.nodes = next;
      state.active = active;
    },
    recomputeSceneOrder: vi.fn(),
    isReplaying: () => false,
    pushHistory: (command) => history.push(command),
    closeTabs: vi.fn(),
    captureTrash: vi.fn(),
    cancelTrash: vi.fn(),
    makeTrashTempId: (entry) => `trash-${entry.id}`,
    recordChange: vi.fn(),
    notifyDeleteFailure: vi.fn(),
    deletedLabel: "deleted",
  };
}

describe("deleteTreeSubtree", () => {
  it("deletes leaf-first and restores parent-first", async () => {
    const testPorts = ports([
      node("folder", null, "folder"),
      node("scene", "folder"),
    ]);

    await deleteTreeSubtree("folder", testPorts);

    expect(testPorts.deletePersisted).toHaveBeenNthCalledWith(1, "scene");
    expect(testPorts.deletePersisted).toHaveBeenNthCalledWith(2, "folder");
    expect(testPorts.history).toHaveLength(1);
    expect(testPorts.history[0]).toMatchObject({
      kind: "scenes",
      entityId: "folder",
      affectedEntities: [
        { kind: "scenes", entityId: "folder" },
        { kind: "scenes", entityId: "scene" },
      ],
    });
    await testPorts.history[0]!.undo();
    expect(testPorts.restorePersisted).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "folder" }),
    );
    expect(testPorts.restorePersisted).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "scene" }),
    );
  });

  it("does not create history after a partial deletion failure", async () => {
    const testPorts = ports([
      node("folder", null, "folder"),
      node("scene", "folder"),
    ]);
    vi.mocked(testPorts.deletePersisted).mockRejectedValueOnce(
      new Error("failed"),
    );

    await deleteTreeSubtree("folder", testPorts);

    expect(testPorts.history).toHaveLength(0);
    expect(testPorts.notifyDeleteFailure).toHaveBeenCalledOnce();
  });
});
