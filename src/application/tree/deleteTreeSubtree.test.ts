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

describe("deleteTreeSubtree: a folder with a subtree (DR-UND-2)", () => {
  function chapter(): TreeNodeData[] {
    return [
      node("folder", null, "folder"),
      node("scene-1", "folder"),
      node("inner", "folder", "folder"),
      node("scene-2", "inner"),
    ];
  }

  const ids = (nodes: readonly TreeNodeData[]) =>
    nodes.map((entry) => entry.id).sort();

  it("puts the whole subtree back, parents first, and shows it in the store", async () => {
    const testPorts = ports(chapter());
    await deleteTreeSubtree("folder", testPorts);
    expect(testPorts.current).toEqual([]);

    await testPorts.history[0]!.undo();

    const order = vi
      .mocked(testPorts.restorePersisted)
      .mock.calls.map(([restored]) => restored.id);
    expect(order.indexOf("folder")).toBe(0);
    expect(order.indexOf("inner")).toBeLessThan(order.indexOf("scene-2"));
    expect(ids(testPorts.current)).toEqual(
      ["folder", "inner", "scene-1", "scene-2"].sort(),
    );
  });

  it("re-creates only the recorded nodes after a redo, not one added while the folder was back", async () => {
    const testPorts = ports(chapter());
    await deleteTreeSubtree("folder", testPorts);
    const command = testPorts.history[0]!;
    await command.undo();
    // Added to the folder after the Undo (the delete's record does not hold it),
    // together with a child of its own.
    testPorts.applyNodes(
      [
        ...testPorts.current,
        node("added", "inner"),
        node("added-child", "added", "folder"),
      ],
      "scene-1",
    );
    await command.redo();
    expect(testPorts.current).toEqual([]);
    vi.mocked(testPorts.restorePersisted).mockClear();

    await command.undo();

    const restored = vi
      .mocked(testPorts.restorePersisted)
      .mock.calls.map(([entry]) => entry.id);
    expect(restored.sort()).toEqual(
      ["folder", "inner", "scene-1", "scene-2"].sort(),
    );
    expect(ids(testPorts.current)).toEqual(
      ["folder", "inner", "scene-1", "scene-2"].sort(),
    );
  });

  it("drops a recorded node whose parent is a node that was added after the Undo", async () => {
    const testPorts = ports(chapter());
    await deleteTreeSubtree("folder", testPorts);
    const command = testPorts.history[0]!;
    await command.undo();
    // scene-2 was moved under a folder made after the Undo.
    testPorts.applyNodes(
      [
        ...testPorts.current
          .filter((entry) => entry.id !== "scene-2")
          .map((entry) => entry),
        node("made-later", "folder", "folder"),
        node("scene-2", "made-later"),
      ],
      "scene-1",
    );
    await command.redo();
    vi.mocked(testPorts.restorePersisted).mockClear();

    await command.undo();

    // Its parent cannot be re-created (it is not in the record), and the
    // database would refuse it: it is not sent, so the Undo does not stop.
    const restored = vi
      .mocked(testPorts.restorePersisted)
      .mock.calls.map(([entry]) => entry.id);
    expect(restored.sort()).toEqual(["folder", "inner", "scene-1"].sort());
    expect(ids(testPorts.current)).toEqual(
      ["folder", "inner", "scene-1"].sort(),
    );
  });

  describe("when the Undo stops half way", () => {
    it("shows the nodes that came back, rethrows, and leaves the active Scene alone", async () => {
      const testPorts = ports(chapter());
      await deleteTreeSubtree("folder", testPorts);
      testPorts.applyNodes([node("other", null)], "other");
      vi.mocked(testPorts.restorePersisted).mockImplementation(
        async (entry) => {
          if (entry.id === "scene-2") throw new Error("stopped");
        },
      );

      await expect(testPorts.history[0]!.undo()).rejects.toThrow("stopped");

      expect(ids(testPorts.current)).toEqual(
        ["folder", "inner", "other", "scene-1"].sort(),
      );
      expect(testPorts.getActiveSceneId()).toBe("other");
    });

    it("changes nothing in the store when the very first node does not come back", async () => {
      const testPorts = ports(chapter());
      await deleteTreeSubtree("folder", testPorts);
      vi.mocked(testPorts.restorePersisted).mockRejectedValue(
        new Error("stopped"),
      );

      await expect(testPorts.history[0]!.undo()).rejects.toThrow("stopped");

      expect(testPorts.current).toEqual([]);
    });

    it("does not show a node twice when the retained Undo is retried", async () => {
      const testPorts = ports(chapter());
      await deleteTreeSubtree("folder", testPorts);
      let attempt = 0;
      vi.mocked(testPorts.restorePersisted).mockImplementation(
        async (entry) => {
          if (entry.id === "scene-2" && attempt++ === 0) {
            throw new Error("unknown outcome");
          }
        },
      );
      const command = testPorts.history[0]!;

      await expect(command.undo()).rejects.toThrow("unknown outcome");
      await command.undo();

      expect(ids(testPorts.current)).toEqual(
        ["folder", "inner", "scene-1", "scene-2"].sort(),
      );
      // Only the node that had not come back was sent again.
      const sent = vi
        .mocked(testPorts.restorePersisted)
        .mock.calls.map(([entry]) => entry.id);
      expect(sent.filter((entry) => entry === "folder")).toHaveLength(1);
      expect(sent.filter((entry) => entry === "scene-2")).toHaveLength(2);
    });

    it("gives the scenes that did not come back to the Trash again, not the ones that did", async () => {
      const testPorts = ports(chapter());
      let made = 0;
      testPorts.makeTrashTempId = (entry) => `trash-${entry.id}-${++made}`;
      const originalTempIds: string[] = [];
      vi.mocked(testPorts.cancelTrash).mockReturnValue(true);
      await deleteTreeSubtree("folder", testPorts);
      originalTempIds.push(
        ...vi
          .mocked(testPorts.captureTrash)
          .mock.calls.map(([capture]) => capture.tempId),
      );
      vi.mocked(testPorts.captureTrash).mockClear();
      vi.mocked(testPorts.restorePersisted).mockImplementation(
        async (entry) => {
          if (entry.id === "scene-2") throw new Error("stopped");
        },
      );

      await expect(testPorts.history[0]!.undo()).rejects.toThrow("stopped");

      const given = vi
        .mocked(testPorts.captureTrash)
        .mock.calls.map(([capture]) => capture);
      expect(given.map((capture) => capture.node.id)).toEqual(["scene-2"]);
      expect(given[0]).toMatchObject({
        projectId: "project-a",
        content: "content",
        folderHintName: "inner",
      });
      expect(originalTempIds).toHaveLength(2);
      expect(originalTempIds).not.toContain(given[0]!.tempId);
    });

    it("does not add a Trash item for a scene that was already written there", async () => {
      const testPorts = ports(chapter());
      // Past the delay: nothing was pending, so there is nothing to give back.
      vi.mocked(testPorts.cancelTrash).mockReturnValue(false);
      await deleteTreeSubtree("folder", testPorts);
      vi.mocked(testPorts.captureTrash).mockClear();
      vi.mocked(testPorts.restorePersisted).mockRejectedValue(
        new Error("stopped"),
      );

      await expect(testPorts.history[0]!.undo()).rejects.toThrow("stopped");

      expect(testPorts.captureTrash).not.toHaveBeenCalled();
    });

    it("cancels the retained captures again on a retry, with the new temporary ids", async () => {
      const testPorts = ports(chapter());
      let made = 0;
      testPorts.makeTrashTempId = (entry) => `trash-${entry.id}-${++made}`;
      vi.mocked(testPorts.cancelTrash).mockReturnValue(true);
      await deleteTreeSubtree("folder", testPorts);
      let attempt = 0;
      vi.mocked(testPorts.restorePersisted).mockImplementation(
        async (entry) => {
          if (entry.id === "scene-2" && attempt++ === 0) {
            throw new Error("unknown outcome");
          }
        },
      );
      const command = testPorts.history[0]!;
      await expect(command.undo()).rejects.toThrow("unknown outcome");
      const given = vi.mocked(testPorts.captureTrash).mock.calls.at(-1)![0]
        .tempId;
      vi.mocked(testPorts.cancelTrash).mockClear();

      await command.undo();

      expect(vi.mocked(testPorts.cancelTrash).mock.calls.flat()).toContain(
        given,
      );
    });
  });

  describe("a second Undo, after an Undo and a Redo", () => {
    function rig() {
      const testPorts = ports(chapter());
      let made = 0;
      testPorts.makeTrashTempId = (entry) => `trash-${entry.id}-${++made}`;
      let generation = 1;
      testPorts.loadRestoreSnapshot = vi.fn(async (nodeId: string) => ({
        content: `body-${generation}-${nodeId}`,
        sourceUri: null,
        sourceMtime: null,
        restoreState: {},
      }));
      return {
        testPorts,
        nextGeneration: () => {
          generation += 1;
        },
      };
    }

    it("gives a scene that never reached the Trash back to it, with the body as of the Redo, when the second Undo stops", async () => {
      const { testPorts, nextGeneration } = rig();
      // The first Undo is in time: the captures are pending and get cancelled.
      vi.mocked(testPorts.cancelTrash).mockReturnValue(true);
      await deleteTreeSubtree("folder", testPorts);
      const command = testPorts.history[0]!;
      await command.undo();
      nextGeneration();
      await command.redo();
      vi.mocked(testPorts.captureTrash).mockClear();
      vi.mocked(testPorts.cancelTrash).mockClear();
      vi.mocked(testPorts.restorePersisted).mockImplementation(
        async (entry) => {
          if (entry.id === "scene-2") throw new Error("stopped");
        },
      );

      await expect(command.undo()).rejects.toThrow("stopped");

      // Their captures were cancelled by the first Undo and are not asked
      // again; the scene that did not come back goes to the Trash.
      expect(testPorts.cancelTrash).not.toHaveBeenCalled();
      const given = vi
        .mocked(testPorts.captureTrash)
        .mock.calls.map(([capture]) => capture);
      expect(given.map((capture) => capture.node.id)).toEqual(["scene-2"]);
      expect(given[0]).toMatchObject({ content: "body-2-scene-2" });
    });

    it("gives nothing back for a scene the first Undo found already in the Trash", async () => {
      const { testPorts } = rig();
      vi.mocked(testPorts.cancelTrash).mockReturnValue(false);
      await deleteTreeSubtree("folder", testPorts);
      const command = testPorts.history[0]!;
      await command.undo();
      await command.redo();
      vi.mocked(testPorts.captureTrash).mockClear();
      vi.mocked(testPorts.restorePersisted).mockRejectedValue(
        new Error("stopped"),
      );

      await expect(command.undo()).rejects.toThrow("stopped");

      expect(testPorts.captureTrash).not.toHaveBeenCalled();
    });

    it("captures nothing when the second Undo completes", async () => {
      const { testPorts } = rig();
      vi.mocked(testPorts.cancelTrash).mockReturnValue(true);
      await deleteTreeSubtree("folder", testPorts);
      const command = testPorts.history[0]!;
      await command.undo();
      await command.redo();
      vi.mocked(testPorts.captureTrash).mockClear();

      await command.undo();

      expect(testPorts.captureTrash).not.toHaveBeenCalled();
    });
  });

  it("cancels the delayed Trash captures before the first node is restored, and gives none back on success", async () => {
    const testPorts = ports(chapter());
    const order: string[] = [];
    vi.mocked(testPorts.cancelTrash).mockImplementation((tempId) => {
      order.push(`cancel:${tempId}`);
      return true;
    });
    vi.mocked(testPorts.restorePersisted).mockImplementation(async (entry) => {
      order.push(`restore:${entry.id}`);
    });
    await deleteTreeSubtree("folder", testPorts);
    vi.mocked(testPorts.captureTrash).mockClear();

    await testPorts.history[0]!.undo();

    expect(order.slice(0, 2).sort()).toEqual([
      "cancel:trash-scene-1",
      "cancel:trash-scene-2",
    ]);
    expect(order[2]).toBe("restore:folder");
    expect(testPorts.captureTrash).not.toHaveBeenCalled();
  });
});
