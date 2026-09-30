import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTreeStore } from "./treeStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import { useTabStore } from "@/features/editor/tabStore";
import { useProjectStore } from "@/features/project/projectStore";
import {
  setCurrentWorkspaceIdentity,
  type WorkspaceIdentity,
} from "@/runtime/workspaceIdentity";
import {
  __resetChatNavigationGuardForTests,
  isTreeNavigationLeaseActive,
  setChatNavigationBlocker,
  setChatSceneTransitionBlocker,
  tryAcquireChatTurnAdmissionLease,
} from "@/lib/chatNavigationGuard";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";
import { registerSceneAuthorityCommitSink } from "@/application/tree/sceneAuthorityRegistry";

const { mockRecomputeSceneOrder, mockRecordChangeEvent } = vi.hoisted(() => ({
  mockRecomputeSceneOrder: vi.fn(),
  mockRecordChangeEvent: vi.fn(),
}));

vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi
    .fn()
    .mockImplementation((node: Record<string, unknown>) =>
      Promise.resolve(node),
    ),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn().mockResolvedValue(undefined),
  treeWriteReceipt: vi.fn(() => ({
    changeEventUid: "tree-test-event",
    maintenanceTransactionId: "tree-test-transaction",
    undoJournalId: "tree-test-journal",
  })),
  historyWriteContext: vi.fn((origin: "undo" | "redo") => ({
    requestId: `${origin}-request`,
    sessionId: "tree-test-session",
    eventUid: `${origin}-event`,
    origin,
    originalTransactionId: "tree-test-transaction",
    undoJournalId: "tree-test-journal",
  })),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: {
    getState: () => ({ recomputeSceneOrder: mockRecomputeSceneOrder }),
  },
}));

vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: mockRecordChangeEvent,
  getRecorderSessionId: () => "tree-test-session",
}));

import {
  createNode as createPersistedNode,
  deleteNode as deletePersistedNode,
} from "./api";

const mockCreatePersistedNode = vi.mocked(createPersistedNode);
const mockDeletePersistedNode = vi.mocked(deletePersistedNode);

const DEFAULTS = {
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
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  __resetChatNavigationGuardForTests();
  registerSceneAuthorityCommitSink(null);
  _resetQuiescenceLeasesForTests();
  useGlobalHistoryStore.getState().clear();
  useProjectStore.setState({ currentProjectId: "proj-1" });
  setCurrentWorkspaceIdentity({
    path: "/workspace/project-a.sqlite",
    openRevision: 1,
  });
  useTreeStore.setState({
    nodes: [],
    projectId: "proj-1",
    selectedIds: [],
    activeSceneId: "",
    expandedIds: [],
    pendingRenameId: null,
    pendingRevealId: null,
  });
  useTabStore.setState({
    tabs: [],
    activeTabId: null,
    secondaryTabs: [],
    secondaryActiveTabId: null,
    secondaryGroupOpen: false,
    activeGroupIndex: 0,
  });
});

afterEach(() => {
  __resetChatNavigationGuardForTests();
  registerSceneAuthorityCommitSink(null);
  _resetQuiescenceLeasesForTests();
  useProjectStore.setState({ currentProjectId: null });
  setCurrentWorkspaceIdentity(null);
});

describe("createNode Phase scene-time invalidation", () => {
  it("recomputes the index through the backward-compatible createScene path", async () => {
    await useTreeStore.getState().createScene();

    expect(mockRecomputeSceneOrder).toHaveBeenCalledTimes(1);
    expect(mockRecomputeSceneOrder).toHaveBeenLastCalledWith(
      useTreeStore.getState().nodes,
    );
  });

  it("recomputes the index after create undo and redo", async () => {
    const created = await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });
    const command = useGlobalHistoryStore.getState().past.at(-1);
    expect(command).toBeDefined();

    mockRecomputeSceneOrder.mockClear();
    await command!.undo();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledTimes(1);
    expect(useTreeStore.getState().nodes).not.toContainEqual(
      expect.objectContaining({ id: created!.id }),
    );
    expect(mockRecomputeSceneOrder).toHaveBeenLastCalledWith(
      useTreeStore.getState().nodes,
    );

    await command!.redo();
    expect(mockRecomputeSceneOrder).toHaveBeenCalledTimes(2);
    expect(useTreeStore.getState().nodes).toContainEqual(
      expect.objectContaining({ id: created!.id }),
    );
    expect(mockRecomputeSceneOrder).toHaveBeenLastCalledWith(
      useTreeStore.getState().nodes,
    );
  });
});

describe("createNode interaction intent", () => {
  it("mirrors created Scene authority before releasing the creation lease", async () => {
    const mirroredSceneIds: string[] = [];
    registerSceneAuthorityCommitSink((sceneId) => {
      expect(isTreeNavigationLeaseActive()).toBe(true);
      mirroredSceneIds.push(sceneId);
    });

    const created = await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });

    expect(created).not.toBeNull();
    expect(mirroredSceneIds).toEqual([created!.id]);
    expect(isTreeNavigationLeaseActive()).toBe(false);
  });

  it("allows non-destructive creation after Chat publishes turn authority", async () => {
    const current = {
      id: "scene-current",
      projectId: "proj-1",
      parentId: null,
      nodeType: "scene" as const,
      title: "Current",
      sortOrder: "a0",
      ...DEFAULTS,
    };
    useTreeStore.setState({
      nodes: [current],
      scenes: [current],
      activeSceneId: current.id,
    });
    setChatNavigationBlocker(() => true);

    const created = await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });

    expect(created).not.toBeNull();
    expect(mockCreatePersistedNode).toHaveBeenCalledOnce();
    expect(useTreeStore.getState().nodes).toContainEqual(
      expect.objectContaining({ id: created!.id }),
    );
    expect(useTreeStore.getState().activeSceneId).toBe(created!.id);
  });

  it("does not persist or move Tree authority during Chat preflight", async () => {
    const current = {
      id: "scene-current",
      projectId: "proj-1",
      parentId: null,
      nodeType: "scene" as const,
      title: "Current",
      sortOrder: "a0",
      ...DEFAULTS,
    };
    useTreeStore.setState({
      nodes: [current],
      scenes: [current],
      activeSceneId: current.id,
    });
    const chatAdmission = tryAcquireChatTurnAdmissionLease();
    expect(chatAdmission).not.toBeNull();

    try {
      const created = await useTreeStore
        .getState()
        .createNode({ nodeType: "scene", parentId: null });

      expect(created).toBeNull();
      expect(mockCreatePersistedNode).not.toHaveBeenCalled();
      expect(useTreeStore.getState().nodes).toEqual([current]);
      expect(useTreeStore.getState().activeSceneId).toBe(current.id);
    } finally {
      chatAdmission?.release();
    }
  });

  it("does not create a new Scene while completed-turn persistence is sticky", async () => {
    setChatSceneTransitionBlocker(() => true);

    const created = await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });

    expect(created).toBeNull();
    expect(mockCreatePersistedNode).not.toHaveBeenCalled();
  });

  it("does not activate a created Scene when persistence becomes sticky in flight", async () => {
    const current = {
      id: "scene-current",
      projectId: "proj-1",
      parentId: null,
      nodeType: "scene" as const,
      title: "Current",
      sortOrder: "a0",
      ...DEFAULTS,
    };
    useTreeStore.setState({
      nodes: [current],
      scenes: [current],
      activeSceneId: current.id,
    });
    let persistencePending = false;
    setChatSceneTransitionBlocker(() => persistencePending);
    let resolveCreate:
      | ((node: Awaited<ReturnType<typeof createPersistedNode>>) => void)
      | undefined;
    mockCreatePersistedNode.mockImplementationOnce(
      (_record) =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const creation = useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });
    await vi.waitFor(() =>
      expect(mockCreatePersistedNode).toHaveBeenCalledOnce(),
    );
    persistencePending = true;
    const persistedInput = mockCreatePersistedNode.mock.calls[0]![0];
    resolveCreate?.({
      ...persistedInput,
      parentId: persistedInput.parentId ?? null,
      ...DEFAULTS,
    } as Awaited<ReturnType<typeof createPersistedNode>>);

    await expect(creation).resolves.toEqual(
      expect.objectContaining({ id: persistedInput.id }),
    );
    expect(useTreeStore.getState().nodes).toContainEqual(
      expect.objectContaining({ id: persistedInput.id }),
    );
    expect(useTreeStore.getState().activeSceneId).toBe(current.id);
  });

  it("keeps Chat turn admission closed across an awaited Tree create", async () => {
    let resolveCreate:
      | ((node: Awaited<ReturnType<typeof createPersistedNode>>) => void)
      | undefined;
    mockCreatePersistedNode.mockImplementationOnce(
      (_record) =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const creation = useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });
    await vi.waitFor(() =>
      expect(mockCreatePersistedNode).toHaveBeenCalledOnce(),
    );

    expect(tryAcquireChatTurnAdmissionLease()).toBeNull();

    const persistedInput = mockCreatePersistedNode.mock.calls[0]![0];
    resolveCreate?.({
      ...persistedInput,
      parentId: persistedInput.parentId ?? null,
      ...DEFAULTS,
    } as Awaited<ReturnType<typeof createPersistedNode>>);
    await expect(creation).resolves.toEqual(
      expect.objectContaining({ id: persistedInput.id }),
    );

    const chatAdmission = tryAcquireChatTurnAdmissionLease();
    expect(chatAdmission).not.toBeNull();
    chatAdmission?.release();
  });

  it("guards captured create undo and redo before repository mutation", async () => {
    const created = await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });
    const command = useGlobalHistoryStore.getState().past.at(-1);
    expect(created).not.toBeNull();
    expect(command).toBeDefined();
    mockCreatePersistedNode.mockClear();
    mockDeletePersistedNode.mockClear();

    setChatNavigationBlocker(() => true);
    await command!.undo();

    expect(mockDeletePersistedNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().nodes).toContainEqual(
      expect.objectContaining({ id: created!.id }),
    );

    setChatNavigationBlocker(null);
    await command!.undo();
    expect(mockDeletePersistedNode).toHaveBeenCalledWith(
      created!.id,
      "proj-1",
      {
        writeContext: expect.objectContaining({
          origin: "undo",
          originalTransactionId: "tree-test-transaction",
          undoJournalId: "tree-test-journal",
        }),
      },
    );
    expect(useTreeStore.getState().nodes).not.toContainEqual(
      expect.objectContaining({ id: created!.id }),
    );

    setChatNavigationBlocker(() => true);
    await command!.redo();
    expect(mockCreatePersistedNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().nodes).not.toContainEqual(
      expect.objectContaining({ id: created!.id }),
    );
  });

  it("keeps legacy create paths as explicit no-ops during Chat preflight", async () => {
    const chatAdmission = tryAcquireChatTurnAdmissionLease();
    expect(chatAdmission).not.toBeNull();

    try {
      await expect(useTreeStore.getState().createScene()).resolves.toBeNull();
      await expect(useTreeStore.getState().createNote()).resolves.toBeNull();

      expect(mockCreatePersistedNode).not.toHaveBeenCalled();
      expect(useTreeStore.getState().nodes).toEqual([]);
    } finally {
      chatAdmission?.release();
    }
  });

  it("does not persist or navigate through direct Tree paths during data deletion", async () => {
    const current = {
      id: "scene-current",
      projectId: "proj-1",
      parentId: null,
      nodeType: "scene" as const,
      title: "Current",
      sortOrder: "a0",
      ...DEFAULTS,
    };
    const other = { ...current, id: "scene-other", sortOrder: "a1" };
    useTreeStore.setState({
      nodes: [current, other],
      scenes: [current, other],
      activeSceneId: current.id,
      selectedIds: [current.id],
    });
    const lifecycle = acquireQuiescenceLease("data-delete");

    await expect(
      useTreeStore.getState().createNode({ nodeType: "scene", parentId: null }),
    ).resolves.toBeNull();
    await expect(useTreeStore.getState().createScene()).resolves.toBeNull();
    useTreeStore.getState().setActiveScene(other.id);
    useTreeStore.getState().selectNode(other.id, false);

    expect(mockCreatePersistedNode).not.toHaveBeenCalled();
    expect(useTreeStore.getState().activeSceneId).toBe(current.id);
    expect(useTreeStore.getState().selectedIds).toEqual([current.id]);
    lifecycle.release();
  });

  it("keeps the default interactive history and rename behavior", async () => {
    const created = await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });

    expect(useTreeStore.getState().pendingRenameId).toBe(created!.id);
    expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
  });

  it("tags create, rename, and status history with the scene identity", async () => {
    const created = await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });

    await useTreeStore.getState().updateNodeTitle(created!.id, created!.title);
    await useTreeStore.getState().setStatus(created!.id, "draft");

    expect(useGlobalHistoryStore.getState().past).toEqual([
      expect.objectContaining({ kind: "scenes", entityId: created!.id }),
      expect.objectContaining({ kind: "scenes", entityId: created!.id }),
      expect.objectContaining({ kind: "scenes", entityId: created!.id }),
    ]);
  });

  it("suppresses history and pending rename for an implicit bootstrap scene", async () => {
    const created = await useTreeStore.getState().createNode({
      nodeType: "scene",
      parentId: null,
      interaction: "implicit",
    });

    expect(useTreeStore.getState().activeSceneId).toBe(created!.id);
    expect(useTreeStore.getState().pendingRenameId).toBeNull();
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
  });

  it("does not apply a delayed implicit scene after project/workspace authority switches", async () => {
    let resolveCreate:
      | ((node: Awaited<ReturnType<typeof createPersistedNode>>) => void)
      | undefined;
    mockCreatePersistedNode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );

    const creation = useTreeStore.getState().createNode({
      nodeType: "scene",
      parentId: null,
      interaction: "implicit",
    });
    await vi.waitFor(() =>
      expect(mockCreatePersistedNode).toHaveBeenCalledOnce(),
    );
    const persistedInput = mockCreatePersistedNode.mock.calls[0]![0];
    const projectBScene = {
      id: "project-b-scene",
      projectId: "proj-2",
      parentId: null,
      nodeType: "scene" as const,
      title: "Project B Scene",
      sortOrder: "a0",
      ...DEFAULTS,
    };

    useProjectStore.setState({ currentProjectId: "proj-2" });
    setCurrentWorkspaceIdentity({
      path: "/workspace/project-b.sqlite",
      openRevision: 2,
    } satisfies WorkspaceIdentity);
    useTreeStore.setState({
      projectId: "proj-2",
      nodes: [projectBScene],
      scenes: [projectBScene],
      activeSceneId: projectBScene.id,
    });
    resolveCreate?.({
      ...persistedInput,
      parentId: persistedInput.parentId ?? null,
      ...DEFAULTS,
    } as Awaited<ReturnType<typeof createPersistedNode>>);

    await expect(creation).resolves.toEqual(
      expect.objectContaining({ projectId: "proj-1" }),
    );
    expect(useTreeStore.getState().nodes).toEqual([projectBScene]);
    expect(useTreeStore.getState().scenes).toEqual([projectBScene]);
    expect(useTreeStore.getState().activeSceneId).toBe(projectBScene.id);
    expect(mockRecomputeSceneOrder).not.toHaveBeenCalled();
    expect(mockRecordChangeEvent).not.toHaveBeenCalled();
    expect(useGlobalHistoryStore.getState().past).toEqual([]);
  });

  it("keeps mobile creation undoable without rename or hidden desktop tabs", async () => {
    const created = await useTreeStore.getState().createNode({
      nodeType: "scene",
      parentId: null,
      interaction: "mobile",
    });
    const command = useGlobalHistoryStore.getState().past.at(-1);

    expect(command).toBeDefined();
    expect(useTreeStore.getState().pendingRenameId).toBeNull();
    expect(useTabStore.getState().tabs).toEqual([]);

    await command!.undo();
    await command!.redo();

    expect(useTreeStore.getState().activeSceneId).toBe(created!.id);
    expect(useTabStore.getState().tabs).toEqual([]);
    expect(useTabStore.getState().secondaryTabs).toEqual([]);
  });
});

describe("createNode with invalid fractional-indexing siblings", () => {
  it("creates a new folder even when an existing sibling has an invalid sort_order", async () => {
    // 古いシードで挿入された不正キー (z 始まりは 27 文字必要なのに "z0" は 2 文字)
    useTreeStore.setState({
      nodes: [
        {
          id: "part1",
          projectId: "proj-1",
          parentId: null,
          nodeType: "folder",
          title: "Part 1",
          sortOrder: "a0",
          ...DEFAULTS,
        },
        {
          id: "part2",
          projectId: "proj-1",
          parentId: null,
          nodeType: "folder",
          title: "Part 2",
          sortOrder: "a1",
          ...DEFAULTS,
        },
        {
          id: "notes",
          projectId: "proj-1",
          parentId: null,
          nodeType: "folder",
          title: "覚書",
          sortOrder: "z0", // ← invalid
          ...DEFAULTS,
        },
      ],
    });

    await expect(
      useTreeStore
        .getState()
        .createNode({ nodeType: "folder", parentId: null }),
    ).resolves.toBeDefined();

    const rootFolders = useTreeStore
      .getState()
      .nodes.filter((n) => n.parentId === null && n.nodeType === "folder");
    expect(rootFolders).toHaveLength(4);

    const created = rootFolders.find(
      (n) => !["part1", "part2", "notes"].includes(n.id),
    );
    expect(created).toBeDefined();
    // 新規キーは "a1" の次（"a2" 系）になるはず。少なくとも有効な fractional-
    // indexing キーで、無効な "z0" を兄弟リストから除外していることを確認。
    expect(created!.sortOrder).not.toBe("z0");
    expect(created!.sortOrder.startsWith("a")).toBe(true);
  });
});

describe("createNode pendingRevealId (scroll trigger)", () => {
  // Folders don't open a tab, so activeSceneId never changes for them and the
  // ScenesPanel auto-reveal effect doesn't fire. createNode sets
  // pendingRevealId to compensate; scenes/notes still rely on the existing
  // activeSceneId path.
  it("sets pendingRevealId to the new folder id so the panel scrolls to it", async () => {
    const created = await useTreeStore
      .getState()
      .createNode({ nodeType: "folder", parentId: null });

    expect(useTreeStore.getState().pendingRevealId).toBe(created!.id);
  });

  it("does not set pendingRevealId when creating a scene (activeSceneId path handles it)", async () => {
    await useTreeStore
      .getState()
      .createNode({ nodeType: "scene", parentId: null });

    expect(useTreeStore.getState().pendingRevealId).toBeNull();
  });

  it("does not set pendingRevealId when creating a note (tab-open path handles it)", async () => {
    await useTreeStore
      .getState()
      .createNode({ nodeType: "note", parentId: null });

    expect(useTreeStore.getState().pendingRevealId).toBeNull();
  });

  it("does not set pendingRevealId for a new folder when autoRevealActiveScene is off", async () => {
    // パリティ: ユーザーが auto-reveal を切っていたら scene/note と同じく
    // folder もスクロールさせない。
    useTreeStore.setState({ autoRevealActiveScene: false });

    await useTreeStore
      .getState()
      .createNode({ nodeType: "folder", parentId: null });

    expect(useTreeStore.getState().pendingRevealId).toBeNull();
  });
});
