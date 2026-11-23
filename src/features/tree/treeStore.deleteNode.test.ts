import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "./api";
import { useTreeStore } from "./treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import {
  __resetChatNavigationGuardForTests,
  setChatNavigationBlocker,
  tryAcquireChatTurnAdmissionLease,
} from "@/lib/chatNavigationGuard";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

const { mockRecomputeSceneOrder } = vi.hoisted(() => ({
  mockRecomputeSceneOrder: vi.fn(),
}));

vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi
    .fn()
    .mockImplementation((node: Record<string, unknown>) =>
      Promise.resolve(node),
    ),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn(),
  treeWriteReceipt: vi.fn((result: unknown) => result),
  historyWriteContext: vi.fn((origin: "undo" | "redo") => ({
    requestId: `${origin}-request`,
    sessionId: "tree-delete-test-session",
    eventUid: `${origin}-event`,
    origin,
    originalTransactionId: "tree-delete-test-transaction",
    undoJournalId: "tree-delete-test-journal",
  })),
  loadSceneContent: vi.fn().mockResolvedValue(""),
  loadTreeNodeRestoreSnapshot: vi.fn().mockResolvedValue(null),
  saveSceneContent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

vi.mock("@/features/attribution/api", () => ({
  loadBatchAiRatio: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: { getState: () => ({}) },
}));

vi.mock("@/features/editor/tabStore", () => ({
  useTabStore: {
    getState: () => ({
      closeTab: vi.fn(),
      closeSecondaryTab: vi.fn(),
    }),
  },
}));

vi.mock("./codexQuickPinApi", () => ({
  listPinnedCodexIds: vi.fn().mockResolvedValue([]),
  addPinnedCodex: vi.fn(),
  removePinnedCodex: vi.fn(),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: {
    getState: () => ({ recomputeSceneOrder: mockRecomputeSceneOrder }),
  },
}));

const baseNode = {
  projectId: "proj-1",
  parentId: null as string | null,
  nodeType: "folder" as const,
  title: "F",
  sortOrder: "a0",
  synopsis: null,

  intent: null,
  status: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  charCount: 0,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatNavigationGuardForTests();
  _resetQuiescenceLeasesForTests();
  vi.mocked(api.deleteNode).mockReset().mockResolvedValue({
    changeEventUid: "tree-delete-test-event",
    maintenanceTransactionId: "tree-delete-test-transaction",
    undoJournalId: "tree-delete-test-journal",
  });
  useTreeStore.setState({
    nodes: [],
    projectId: "proj-1",
    selectedIds: [],
    activeSceneId: "",
    expandedIds: [],
  });
  useGlobalHistoryStore.getState().clear();
});

afterEach(() => {
  __resetChatNavigationGuardForTests();
  _resetQuiescenceLeasesForTests();
});

describe("treeStore.deleteNode Phase scene-time invalidation", () => {
  it("does not delete or replace the active Scene while Chat navigation is blocked", async () => {
    const active = {
      ...baseNode,
      id: "active-scene",
      nodeType: "scene" as const,
    };
    useTreeStore.setState({
      nodes: [active],
      scenes: [active],
      activeSceneId: active.id,
    });
    setChatNavigationBlocker(() => true);

    await useTreeStore.getState().deleteNode(active.id);

    expect(api.deleteNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().nodes).toContainEqual(active);
    expect(useTreeStore.getState().activeSceneId).toBe(active.id);
  });

  it("keeps Chat turn admission closed across an awaited Tree delete", async () => {
    let releaseLoad!: () => void;
    vi.mocked(api.loadSceneContent).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          releaseLoad = () => resolve("");
        }),
    );
    const active = {
      ...baseNode,
      id: "active-scene",
      nodeType: "scene" as const,
    };
    useTreeStore.setState({
      nodes: [active],
      scenes: [active],
      activeSceneId: active.id,
    });

    const deletion = useTreeStore.getState().deleteNode(active.id);
    await vi.waitFor(() =>
      expect(api.loadSceneContent).toHaveBeenCalledWith(active.id),
    );

    expect(tryAcquireChatTurnAdmissionLease()).toBeNull();

    releaseLoad();
    await deletion;
    const chatAdmission = tryAcquireChatTurnAdmissionLease();
    expect(chatAdmission).not.toBeNull();
    chatAdmission?.release();
  });

  it("guards captured delete undo and redo before repository mutation", async () => {
    const active = {
      ...baseNode,
      id: "active-scene",
      nodeType: "scene" as const,
    };
    const fallback = {
      ...baseNode,
      id: "fallback-scene",
      nodeType: "scene" as const,
      sortOrder: "a1",
    };
    useTreeStore.setState({
      nodes: [active, fallback],
      scenes: [active, fallback],
      activeSceneId: active.id,
    });
    await useTreeStore.getState().deleteNode(active.id);
    const command = useGlobalHistoryStore.getState().past.at(-1);
    expect(command).toBeDefined();
    expect(useTreeStore.getState().activeSceneId).toBe(fallback.id);
    vi.mocked(api.createNode).mockClear();
    vi.mocked(api.deleteNode).mockClear();

    setChatNavigationBlocker(() => true);
    await command!.undo();

    expect(api.createNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().activeSceneId).toBe(fallback.id);
    expect(useTreeStore.getState().nodes).not.toContainEqual(
      expect.objectContaining({ id: active.id }),
    );

    setChatNavigationBlocker(null);
    await command!.undo();
    expect(api.createNode).toHaveBeenCalled();
    expect(useTreeStore.getState().activeSceneId).toBe(active.id);
    expect(useTreeStore.getState().nodes).toContainEqual(
      expect.objectContaining({ id: active.id }),
    );

    vi.mocked(api.deleteNode).mockClear();
    setChatNavigationBlocker(() => true);
    await command!.redo();
    expect(api.deleteNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().activeSceneId).toBe(active.id);
  });

  it("keeps the legacy active-Scene delete path as a no-op while Chat owns authority", async () => {
    const active = {
      ...baseNode,
      id: "active-scene",
      nodeType: "scene" as const,
    };
    useTreeStore.setState({
      nodes: [active],
      scenes: [active],
      activeSceneId: active.id,
    });
    setChatNavigationBlocker(() => true);

    await useTreeStore.getState().deleteScene(active.id);

    expect(api.deleteNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().activeSceneId).toBe(active.id);
  });

  it("does not call the delete repository while data deletion owns lifecycle admission", async () => {
    const active = {
      ...baseNode,
      id: "active-scene",
      nodeType: "scene" as const,
    };
    useTreeStore.setState({
      nodes: [active],
      scenes: [active],
      activeSceneId: active.id,
    });
    const lifecycle = acquireQuiescenceLease("data-delete");

    await useTreeStore.getState().deleteNode(active.id);
    await useTreeStore.getState().deleteScene(active.id);

    expect(api.deleteNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().activeSceneId).toBe(active.id);
    lifecycle.release();
  });

  it("recomputes the index after delete undo and redo", async () => {
    useTreeStore.setState({ nodes: [{ ...baseNode, id: "folder" }] });

    await useTreeStore.getState().deleteNode("folder");
    const command = useGlobalHistoryStore.getState().past.at(-1);
    expect(command).toBeDefined();

    mockRecomputeSceneOrder.mockClear();
    await command!.undo();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledTimes(1);
    expect(useTreeStore.getState().nodes).toContainEqual(
      expect.objectContaining({ id: "folder" }),
    );
    expect(mockRecomputeSceneOrder).toHaveBeenLastCalledWith(
      useTreeStore.getState().nodes,
    );

    await command!.redo();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledTimes(2);
    expect(useTreeStore.getState().nodes).not.toContainEqual(
      expect.objectContaining({ id: "folder" }),
    );
    expect(mockRecomputeSceneOrder).toHaveBeenLastCalledWith(
      useTreeStore.getState().nodes,
    );
  });
});

describe("treeStore.deleteNode atomic failure", () => {
  it("keeps the complete subtree and skips history when the native delete fails", async () => {
    // Tree:  parent -> [childA, childB]
    useTreeStore.setState({
      nodes: [
        { ...baseNode, id: "parent" },
        { ...baseNode, id: "childA", parentId: "parent" },
        { ...baseNode, id: "childB", parentId: "parent" },
      ],
    });

    let callCount = 0;
    vi.mocked(api.deleteNode).mockImplementation(async (id: string) => {
      callCount++;
      if (id === "parent") throw new Error("forced atomic failure");
      return {
        changeEventUid: "unexpected",
        maintenanceTransactionId: "unexpected",
        undoJournalId: "unexpected",
      };
    });

    await useTreeStore.getState().deleteNode("parent");

    const remaining = useTreeStore.getState().nodes.map((n) => n.id);
    expect(remaining).toEqual(["parent", "childA", "childB"]);

    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
    expect(callCount).toBe(1);
  });
});

describe("treeStore.deleteNode undo restores the row the database held (DR-UND-1)", () => {
  const sceneNode = {
    ...baseNode,
    id: "scene-a",
    nodeType: "scene" as const,
    storyTimeOrder: "stale-in-store",
    povCharacterId: null as string | null,
    updatedAt: "2026-01-01T00:00:00Z",
  };
  const noteNode = {
    ...baseNode,
    id: "note-a",
    nodeType: "note" as const,
    content: '{"stale":true}',
  };
  const snapshots: Record<string, api.TreeNodeRestoreSnapshot> = {
    "scene-a": {
      content: "scene-body",
      sourceUri: "external-root://r/a.md",
      sourceMtime: "2026-01-02T00:00:00Z",
      restoreState: {
        intent: "goal",
        storyTimeOrder: "b3",
        unplacedBeatsDoc: '[{"id":"b1"}]',
        createdAt: "2025-12-01T00:00:00Z",
      },
    },
    "note-a": {
      content: '{"type":"doc","edited":true}',
      sourceUri: null,
      sourceMtime: null,
      restoreState: { contextMode: "hidden", aliases: '["x"]' },
    },
  };

  beforeEach(() => {
    vi.mocked(api.createNode).mockImplementation((node) =>
      Promise.resolve(node as never),
    );
    vi.mocked(api.loadTreeNodeRestoreSnapshot).mockImplementation(
      async (id: string) => snapshots[id] ?? null,
    );
  });

  async function deleteAndUndo(nodes: (typeof sceneNode | typeof noteNode)[]) {
    useTreeStore.setState({ nodes });
    for (const node of nodes) await useTreeStore.getState().deleteNode(node.id);
    const commands = useGlobalHistoryStore.getState().past.slice(-nodes.length);
    vi.mocked(api.createNode).mockClear();
    for (const command of commands.reverse()) await command.undo();
  }

  it("passes the database row's columns, the source link and the note body to createNode", async () => {
    await deleteAndUndo([sceneNode, noteNode]);
    const calls = vi.mocked(api.createNode).mock.calls;
    const byId = Object.fromEntries(
      calls.map((call) => [(call[0] as { id: string }).id, call]),
    );
    const sceneCall = byId["scene-a"]!;
    expect(sceneCall[0]).toMatchObject({
      content: "scene-body",
      sourceUri: "external-root://r/a.md",
      sourceMtime: "2026-01-02T00:00:00Z",
    });
    expect(sceneCall[1]).toMatchObject({
      restoreState: snapshots["scene-a"]!.restoreState,
    });
    const noteCall = byId["note-a"]!;
    // The note body is the database's (edited) one, not the store's stale copy.
    expect(noteCall[0]).toMatchObject({
      content: '{"type":"doc","edited":true}',
    });
    expect(noteCall[0]).not.toHaveProperty("sourceUri");
    expect(noteCall[1]).toMatchObject({
      restoreState: snapshots["note-a"]!.restoreState,
    });
  });

  it("falls back to the create fields when the snapshot cannot be read", async () => {
    vi.mocked(api.loadTreeNodeRestoreSnapshot).mockRejectedValue(
      new Error("db unavailable"),
    );
    vi.mocked(api.loadSceneContent).mockResolvedValue("scene-body");
    await deleteAndUndo([sceneNode, noteNode]);
    const calls = vi.mocked(api.createNode).mock.calls;
    for (const call of calls) {
      expect(call[1]).not.toHaveProperty("restoreState");
    }
    const sceneCall = calls.find(
      (c) => (c[0] as { id: string }).id === "scene-a",
    )!;
    expect(sceneCall[0]).toMatchObject({ content: "scene-body" });
  });

  it("takes version, updatedAt and a nulled Codex reference from the re-created row", async () => {
    vi.mocked(api.createNode).mockImplementation((node) =>
      Promise.resolve({
        ...node,
        version: 0,
        updatedAt: "2026-11-24T00:00:00Z",
        povCharacterId: null,
        locationId: "place-1",
      } as never),
    );
    await deleteAndUndo([{ ...sceneNode, povCharacterId: "pov-gone" }]);
    expect(useTreeStore.getState().nodes).toContainEqual(
      expect.objectContaining({
        id: "scene-a",
        version: 0,
        updatedAt: "2026-11-24T00:00:00Z",
        povCharacterId: null,
        locationId: "place-1",
        // everything else is the store's node
        storyTimeOrder: "stale-in-store",
      }),
    );
  });

  it("does not put undefined into the store when the response lacks a token", async () => {
    await deleteAndUndo([sceneNode]);
    const restored = useTreeStore
      .getState()
      .nodes.find((node) => node.id === "scene-a")!;
    expect(restored.updatedAt).toBe("2026-01-01T00:00:00Z");
  });

  it("reads the row again before a redo, so an edit between undo and redo survives the next undo", async () => {
    useTreeStore.setState({ nodes: [noteNode] });
    await useTreeStore.getState().deleteNode(noteNode.id);
    const command = useGlobalHistoryStore.getState().past.at(-1)!;
    await command.undo();
    snapshots["note-a"] = {
      ...snapshots["note-a"]!,
      content: '{"type":"doc","edited":"again"}',
    };
    await command.redo();
    vi.mocked(api.createNode).mockClear();
    await command.undo();
    expect(vi.mocked(api.createNode).mock.calls[0]![0]).toMatchObject({
      content: '{"type":"doc","edited":"again"}',
    });
  });
});
