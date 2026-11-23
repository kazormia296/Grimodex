import { describe, expect, it, vi } from "vitest";
import { debugLog } from "@/lib/debugLog";
import {
  deleteTreeSubtree,
  type DeleteTreeSubtreePorts,
} from "./deleteTreeSubtree";
import type { TreeNodeData } from "@/features/tree/treeStore";
import type { TreeNodeRestoreSnapshot } from "@/features/tree/api";
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
  it("deletes the subtree through one root writer and restores parent-first", async () => {
    const testPorts = ports([
      node("folder", null, "folder"),
      node("scene", "folder"),
    ]);

    await deleteTreeSubtree("folder", testPorts);

    expect(testPorts.deletePersisted).toHaveBeenCalledOnce();
    expect(testPorts.deletePersisted).toHaveBeenCalledWith("folder");
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
      undefined,
    );
    expect(testPorts.restorePersisted).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "scene" }),
      "content",
    );
  });

  it("does not change projection or history after an atomic deletion failure", async () => {
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

describe("deleteTreeSubtree restore snapshots (DR-UND-1)", () => {
  function snapshot(content: string): TreeNodeRestoreSnapshot {
    return {
      content,
      sourceUri: null,
      sourceMtime: null,
      restoreState: { intent: content },
    };
  }

  it("reads every node's row before the delete and hands it to the restore", async () => {
    const testPorts = ports([
      node("folder", null, "folder"),
      node("scene", "folder"),
    ]);
    testPorts.loadRestoreSnapshot = vi.fn(async (id: string) =>
      snapshot(`row-${id}`),
    );
    const order: string[] = [];
    vi.mocked(testPorts.loadRestoreSnapshot).mockImplementation(async (id) => {
      order.push(`load:${id}`);
      return snapshot(`row-${id}`);
    });
    vi.mocked(testPorts.deletePersisted).mockImplementation(async () => {
      order.push("delete");
    });

    await deleteTreeSubtree("folder", testPorts);
    expect(order).toEqual(["load:folder", "load:scene", "delete"]);
    await testPorts.history[0]!.undo();

    expect(testPorts.restorePersisted).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ id: "folder" }),
      undefined,
      snapshot("row-folder"),
    );
    // A scene's content is the snapshot's (the database's), not a second read.
    expect(testPorts.restorePersisted).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: "scene" }),
      "row-scene",
      snapshot("row-scene"),
    );
    expect(testPorts.loadSceneContent).not.toHaveBeenCalled();
  });

  it("falls back to the scene content read when the row cannot be read, and logs it", async () => {
    const testPorts = ports([node("scene", null)]);
    testPorts.loadRestoreSnapshot = vi.fn().mockRejectedValue(new Error("x"));
    const warn = vi.spyOn(debugLog, "warn").mockImplementation(() => {});

    await deleteTreeSubtree("scene", testPorts);
    await testPorts.history[0]!.undo();

    expect(testPorts.restorePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scene" }),
      "content",
    );
    expect(warn).toHaveBeenCalledWith(
      "tree",
      "undo snapshot unreadable",
      "scene: x",
    );
    warn.mockRestore();
  });

  it("puts the re-created row's token and references into the restored store nodes", async () => {
    const testPorts = ports([node("scene", null)]);
    testPorts.loadRestoreSnapshot = vi.fn(async () => snapshot("row"));
    vi.mocked(testPorts.restorePersisted).mockResolvedValue({
      version: 0,
      updatedAt: "2026-11-24T00:00:00.000Z",
      povCharacterId: null,
    });

    await deleteTreeSubtree("scene", testPorts);
    await testPorts.history[0]!.undo();

    expect(testPorts.current).toEqual([
      expect.objectContaining({
        id: "scene",
        version: 0,
        updatedAt: "2026-11-24T00:00:00.000Z",
        povCharacterId: null,
        title: "scene",
      }),
    ]);
  });

  it("reads the rows again before a redo and restores the newer ones on the next undo", async () => {
    const testPorts = ports([node("scene", null)]);
    let generation = 1;
    testPorts.loadRestoreSnapshot = vi.fn(async () =>
      snapshot(`generation-${generation}`),
    );

    await deleteTreeSubtree("scene", testPorts);
    const command = testPorts.history[0]!;
    await command.undo();
    generation = 2;
    await command.redo();
    vi.mocked(testPorts.restorePersisted).mockClear();
    await command.undo();

    expect(testPorts.restorePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scene" }),
      "generation-2",
      snapshot("generation-2"),
    );
  });

  it("keeps the older snapshot when the redo's re-read fails", async () => {
    const testPorts = ports([node("scene", null)]);
    testPorts.loadRestoreSnapshot = vi
      .fn<NonNullable<DeleteTreeSubtreePorts["loadRestoreSnapshot"]>>()
      .mockResolvedValueOnce(snapshot("first"))
      .mockRejectedValue(new Error("later read failed"));

    await deleteTreeSubtree("scene", testPorts);
    const command = testPorts.history[0]!;
    await command.undo();
    await command.redo();
    vi.mocked(testPorts.restorePersisted).mockClear();
    await command.undo();

    expect(testPorts.restorePersisted).toHaveBeenCalledWith(
      expect.objectContaining({ id: "scene" }),
      "first",
      snapshot("first"),
    );
  });
});
