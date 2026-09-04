import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useTreeStore, type TreeNodeData } from "./treeStore";
import * as api from "./api";
import { useProjectStore } from "@/features/project/projectStore";
import { setCurrentWorkspaceIdentity } from "@/runtime/workspaceIdentity";
import { publishTreeNodeMutation } from "@/lib/treeNodeMutationRegistry";
import { awaitPendingSceneContentWrite } from "./pendingSceneWrites";

const { mockHistoryPush, mockHistoryGetState } = vi.hoisted(() => {
  const mockHistoryPush = vi.fn();
  const mockHistoryGetState = vi.fn(() => ({
    isReplaying: false,
    push: mockHistoryPush,
  }));
  return { mockHistoryPush, mockHistoryGetState };
});

vi.mock("./api", () => ({
  listNodes: vi.fn().mockResolvedValue([]),
  createNode: vi.fn().mockImplementation((node) => Promise.resolve(node)),
  updateNode: vi.fn().mockResolvedValue(undefined),
  deleteNode: vi.fn().mockResolvedValue(undefined),
  treeWriteReceipt: vi.fn(() => ({
    changeEventUid: "tree-test-event",
    maintenanceTransactionId: "tree-test-maintenance",
    undoJournalId: "tree-test-journal",
  })),
  historyWriteContext: vi.fn((origin: "undo" | "redo") => ({
    requestId: `tree-test-${origin}`,
    sessionId: "tree-test-session",
    eventUid: `tree-test-${origin}-event`,
    origin,
    originalTransactionId: "tree-test-maintenance",
    undoJournalId: "tree-test-journal",
  })),
}));

vi.mock("@/features/codex/phaseStore", () => ({
  usePhaseStore: { getState: () => ({ recomputeSceneOrder: vi.fn() }) },
}));

vi.mock("@/store/globalHistoryStore", () => ({
  useGlobalHistoryStore: { getState: mockHistoryGetState },
}));

const SCENE: TreeNodeData = {
  id: "scene-1",
  projectId: "p",
  parentId: "ch-1",
  nodeType: "scene" as const,
  title: "Scene 1",
  synopsis: null,
  sortOrder: "a1",
  status: null,
  intent: null,
  storyTimeOrder: null,
  storyTimeLabel: null,
  povCharacterId: null,
  locationId: null,
  chronicleStartTime: 100,
  chronicleStartMinute: null,
  chronicleStartGranularity: "day",
  chronicleEndTime: null,
  chronicleEndMinute: null,
  chronicleEndGranularity: "none",
  chroniclePrecision: "exact",
  charCount: 0,
  createdAt: "2024-01-01T00:00:00Z",
  updatedAt: "2024-01-01T00:00:00Z",
};

function reset(over: Partial<TreeNodeData> = {}) {
  vi.mocked(api.updateNode).mockReset().mockResolvedValue(undefined);
  useProjectStore.setState({ currentProjectId: "p" });
  setCurrentWorkspaceIdentity({ path: "/workspace-a", openRevision: 1 });
  useTreeStore.setState({
    nodes: [{ ...SCENE, ...over }],
    selectedIds: [],
    activeSceneId: "",
    filterQuery: "",
    expandedIds: [],
  });
  mockHistoryPush.mockClear();
  mockHistoryGetState.mockClear();
}

function persistedAt(updatedAt: string) {
  return { updatedAt } as Awaited<ReturnType<typeof api.updateNode>>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("patchNode", () => {
  beforeEach(() => reset());

  it("persists first and applies the returned revision to the Tree projection", async () => {
    vi.mocked(api.updateNode).mockResolvedValueOnce(
      persistedAt("2024-01-01T00:00:01Z"),
    );

    await useTreeStore.getState().patchNode("scene-1", {
      contextMode: "all",
      aliases: '["hero"]',
    });

    expect(api.updateNode).toHaveBeenCalledWith("scene-1", {
      contextMode: "all",
      aliases: '["hero"]',
    });
    expect(useTreeStore.getState().nodes[0]).toMatchObject({
      contextMode: "all",
      aliases: '["hero"]',
      updatedAt: "2024-01-01T00:00:01Z",
    });
  });

  it("does not mutate the projection when persistence fails", async () => {
    vi.mocked(api.updateNode).mockRejectedValueOnce(new Error("disk full"));

    await expect(
      useTreeStore.getState().patchNode("scene-1", { title: "New title" }),
    ).rejects.toThrow("disk full");
    expect(useTreeStore.getState().nodes[0].title).toBe("Scene 1");
  });
});

describe("updateChronicleDate (tracked)", () => {
  beforeEach(() => reset());
  afterEach(() => {
    vi.clearAllMocks();
    setCurrentWorkspaceIdentity(null);
    useProjectStore.setState({ currentProjectId: null });
  });

  it("日付を反映し history に push する（作中日付クリアも undo 可能）", async () => {
    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: null });
    const node = useTreeStore.getState().nodes.find((n) => n.id === "scene-1");
    expect(node?.chronicleStartTime).toBeNull();
    expect(mockHistoryPush).toHaveBeenCalledOnce();
  });

  it("undo で旧値(=クリア前の日付)へ戻す", async () => {
    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: null });
    const { undo } = mockHistoryPush.mock.calls[0][0];
    await undo();
    const node = useTreeStore.getState().nodes.find((n) => n.id === "scene-1");
    expect(node?.chronicleStartTime).toBe(100); // 元の日付へ復元
  });

  it("開始/終了の変更も undo/redo できる", async () => {
    vi.mocked(api.updateNode)
      .mockResolvedValueOnce(persistedAt("2024-01-01T00:00:01Z"))
      .mockResolvedValueOnce(persistedAt("2024-01-01T00:00:02Z"))
      .mockResolvedValueOnce(persistedAt("2024-01-01T00:00:03Z"));
    await useTreeStore.getState().updateChronicleDate("scene-1", {
      chronicleStartTime: 200,
      chronicleEndTime: 300,
    });
    expect(
      useTreeStore.getState().nodes.find((x) => x.id === "scene-1")?.updatedAt,
    ).toBe("2024-01-01T00:00:01Z");
    const { undo, redo } = mockHistoryPush.mock.calls[0][0];
    await undo();
    let n = useTreeStore.getState().nodes.find((x) => x.id === "scene-1");
    expect(n?.chronicleStartTime).toBe(100);
    expect(n?.chronicleEndTime).toBeNull();
    expect(n?.updatedAt).toBe("2024-01-01T00:00:02Z");
    await redo();
    n = useTreeStore.getState().nodes.find((x) => x.id === "scene-1");
    expect(n?.chronicleStartTime).toBe(200);
    expect(n?.chronicleEndTime).toBe(300);
    expect(n?.updatedAt).toBe("2024-01-01T00:00:03Z");
  });

  it("実変更が無ければ no-op（history を汚さない）", async () => {
    const { updateNode } = await import("./api");
    (updateNode as ReturnType<typeof vi.fn>).mockClear();
    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: 100 }); // 同値
    expect(mockHistoryPush).not.toHaveBeenCalled();
    expect(updateNode).not.toHaveBeenCalled();
  });

  it("isReplaying 中は push しない", async () => {
    mockHistoryGetState.mockReturnValueOnce({
      isReplaying: true,
      push: mockHistoryPush,
    });
    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: 999 });
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });

  it("同一project/sceneの重なったendpoint更新を直列化し、staleな逆転rangeを永続化しない", async () => {
    reset({
      chronicleStartTime: 100,
      chronicleStartGranularity: "day",
      chronicleEndTime: 200,
      chronicleEndGranularity: "day",
    });
    const firstWrite = deferred<Awaited<ReturnType<typeof api.updateNode>>>();
    vi.mocked(api.updateNode)
      .mockImplementationOnce(() => firstWrite.promise)
      .mockResolvedValue(persistedAt("2024-01-01T00:00:02Z"));

    const moveStart = useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: 190 });
    const moveEnd = useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleEndTime: 110 });

    expect(api.updateNode).toHaveBeenCalledOnce();
    firstWrite.resolve(persistedAt("2024-01-01T00:00:01Z"));
    await moveStart;
    await expect(moveEnd).rejects.toThrow(
      "Chronicle end must not precede start",
    );

    expect(api.updateNode).toHaveBeenCalledOnce();
    expect(
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1"),
    ).toMatchObject({
      chronicleStartTime: 190,
      chronicleEndTime: 200,
      updatedAt: "2024-01-01T00:00:01Z",
    });
  });

  it("read barrierはdispatch前のqueued date writeも最後まで待つ", async () => {
    reset({
      chronicleStartTime: 100,
      chronicleStartGranularity: "day",
      chronicleEndTime: 200,
      chronicleEndGranularity: "day",
    });
    const firstWrite = deferred<Awaited<ReturnType<typeof api.updateNode>>>();
    const secondWrite = deferred<Awaited<ReturnType<typeof api.updateNode>>>();
    vi.mocked(api.updateNode)
      .mockImplementationOnce(() => firstWrite.promise)
      .mockImplementationOnce(() => secondWrite.promise);

    const first = useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: 110 });
    const second = useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleEndTime: 210 });
    let readerSettled = false;
    const reader = awaitPendingSceneContentWrite("scene-1").then(() => {
      readerSettled = true;
    });

    await Promise.resolve();
    expect(readerSettled).toBe(false);
    firstWrite.resolve(persistedAt("2024-01-01T00:00:01Z"));
    await first;
    await vi.waitFor(() => expect(api.updateNode).toHaveBeenCalledTimes(2));
    expect(readerSettled).toBe(false);

    secondWrite.resolve(persistedAt("2024-01-01T00:00:02Z"));
    await second;
    await reader;
    expect(readerSettled).toBe(true);
  });

  it("date-touchはlegacy coarse minuteを正規化し、一回のfull date patchで保存する", async () => {
    reset({
      chronicleStartTime: 100,
      chronicleStartMinute: 600,
      chronicleStartGranularity: "day",
    });
    vi.mocked(api.updateNode).mockResolvedValue(
      persistedAt("2024-01-01T00:00:01Z"),
    );

    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: 101 });

    expect(api.updateNode).toHaveBeenCalledWith("scene-1", {
      chronicleStartTime: 101,
      chronicleStartMinute: null,
      chronicleStartGranularity: "day",
      chronicleEndTime: null,
      chronicleEndMinute: null,
      chronicleEndGranularity: "none",
    });
  });

  it("day-only更新はlegacy noneのminute残骸をtimeとして復活させない", async () => {
    reset({
      chronicleStartTime: null,
      chronicleStartMinute: 600,
      chronicleStartGranularity: "none",
    });

    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: 101 });

    expect(api.updateNode).toHaveBeenCalledWith("scene-1", {
      chronicleStartTime: 101,
      chronicleStartMinute: null,
      chronicleStartGranularity: "day",
      chronicleEndTime: null,
      chronicleEndMinute: null,
      chronicleEndGranularity: "none",
    });
    expect(
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1"),
    ).toMatchObject({
      chronicleStartTime: 101,
      chronicleStartMinute: null,
      chronicleStartGranularity: "day",
    });
  });

  it("precision-only更新はlegacy date rangeを検証も書換えもしない", async () => {
    reset({
      chronicleStartTime: 200,
      chronicleStartMinute: 600,
      chronicleStartGranularity: "day",
      chronicleEndTime: 100,
      chronicleEndMinute: 700,
      chronicleEndGranularity: "day",
    });

    await useTreeStore.getState().updateChronicleDate("scene-1", {
      chroniclePrecision: "approx",
    });

    expect(api.updateNode).toHaveBeenCalledWith("scene-1", {
      chroniclePrecision: "approx",
    });
    expect(
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1"),
    ).toMatchObject({
      chronicleStartTime: 200,
      chronicleStartMinute: 600,
      chronicleEndTime: 100,
      chronicleEndMinute: 700,
      chroniclePrecision: "approx",
    });
  });

  it("event-preferred copy相当のraw full tupleもscene境界でcanonicalizeする", async () => {
    reset({
      chronicleStartTime: null,
      chronicleStartGranularity: "none",
    });

    await useTreeStore.getState().updateChronicleDate("scene-1", {
      chronicleStartTime: 300,
      chronicleStartMinute: 540,
      chronicleStartGranularity: "day",
      chronicleEndTime: 301,
      chronicleEndMinute: 720,
      chronicleEndGranularity: "month",
    });

    expect(api.updateNode).toHaveBeenCalledWith(
      "scene-1",
      expect.objectContaining({
        chronicleStartTime: 300,
        chronicleStartMinute: null,
        chronicleStartGranularity: "day",
        chronicleEndTime: 301,
        chronicleEndMinute: null,
        chronicleEndGranularity: "month",
      }),
    );
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
    "非整数/非有限day %sをDrizzleへ渡さない",
    async (day) => {
      await expect(
        useTreeStore.getState().updateChronicleDate("scene-1", {
          chronicleStartTime: day,
        }),
      ).rejects.toThrow("Chronicle start day must be a safe integer");
      expect(api.updateNode).not.toHaveBeenCalled();
    },
  );

  it("single writeのupdatedAtを次のbulk scene OCC tokenとして使える", async () => {
    vi.mocked(api.updateNode).mockResolvedValue(
      persistedAt("2024-01-01T00:00:01Z"),
    );
    await useTreeStore
      .getState()
      .updateChronicleDate("scene-1", { chronicleStartTime: 101 });

    const baseUpdatedAt =
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1")
        ?.updatedAt ?? "";
    useTreeStore
      .getState()
      .applyChronicleBulkSceneProjection(
        "p",
        [{ kind: "sceneClearDate", sceneId: "scene-1", baseUpdatedAt }],
        [{ sceneId: "scene-1", updatedAt: "2024-01-01T00:00:02Z" }],
      );

    expect(baseUpdatedAt).toBe("2024-01-01T00:00:01Z");
    expect(
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1"),
    ).toMatchObject({
      chronicleStartTime: null,
      chronicleStartMinute: null,
      chronicleStartGranularity: "none",
      updatedAt: "2024-01-01T00:00:02Z",
    });
  });

  it("treeStore外のupdateNode publicationもexact scopeのOCC tokenだけ同期する", () => {
    publishTreeNodeMutation({
      workspacePath: "/workspace-a",
      workspaceOpenRevision: 2,
      projectId: "p",
      nodeId: "scene-1",
      updatedAt: "2024-01-01T00:00:09Z",
    });
    expect(
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1")
        ?.updatedAt,
    ).toBe("2024-01-01T00:00:00Z");

    publishTreeNodeMutation({
      workspacePath: "/workspace-b",
      workspaceOpenRevision: 1,
      projectId: "p",
      nodeId: "scene-1",
      updatedAt: "2024-01-01T00:00:08Z",
    });
    publishTreeNodeMutation({
      workspacePath: "/workspace-a",
      workspaceOpenRevision: 1,
      projectId: "other-project",
      nodeId: "scene-1",
      updatedAt: "2024-01-01T00:00:07Z",
    });
    expect(
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1")
        ?.updatedAt,
    ).toBe("2024-01-01T00:00:00Z");

    publishTreeNodeMutation({
      workspacePath: "/workspace-a",
      workspaceOpenRevision: 1,
      projectId: "p",
      nodeId: "scene-1",
      updatedAt: "2024-01-01T00:00:01Z",
    });
    expect(
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1")
        ?.updatedAt,
    ).toBe("2024-01-01T00:00:01Z");
  });
});

describe("updatePovCharacter / updateLocation (tracked)", () => {
  beforeEach(() => reset());
  afterEach(() => {
    vi.clearAllMocks();
    setCurrentWorkspaceIdentity(null);
    useProjectStore.setState({ currentProjectId: null });
  });

  it("POV 変更を push し、undo で戻す", async () => {
    vi.mocked(api.updateNode).mockResolvedValueOnce(
      persistedAt("2024-01-01T00:00:01Z"),
    );
    await useTreeStore.getState().updatePovCharacter("scene-1", "c1");
    expect(mockHistoryPush).toHaveBeenCalledOnce();
    expect(
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1")
        ?.updatedAt,
    ).toBe("2024-01-01T00:00:01Z");
    const { undo } = mockHistoryPush.mock.calls[0][0];
    await undo();
    expect(
      useTreeStore.getState().nodes.find((n) => n.id === "scene-1")
        ?.povCharacterId,
    ).toBeNull();
  });

  it("POV 同値は no-op（ドラッグの空振りで履歴を汚さない）", async () => {
    reset({ povCharacterId: "c1" });
    await useTreeStore.getState().updatePovCharacter("scene-1", "c1");
    expect(mockHistoryPush).not.toHaveBeenCalled();
  });

  it("場所変更を push し、undo で戻す", async () => {
    reset({ locationId: "loc0" });
    await useTreeStore.getState().updateLocation("scene-1", "loc1");
    expect(mockHistoryPush).toHaveBeenCalledOnce();
    const { undo } = mockHistoryPush.mock.calls[0][0];
    await undo();
    expect(
      useTreeStore.getState().nodes.find((n) => n.id === "scene-1")?.locationId,
    ).toBe("loc0");
  });
});

describe("Chronicle draft permit propagation", () => {
  beforeEach(() => reset());

  it("passes an explicit preexisting-draft permit through scene synopsis writes", async () => {
    await useTreeStore.getState().updateSynopsis("scene-1", "queued synopsis", {
      preexistingDraft: true,
    });

    expect(api.updateNode).toHaveBeenCalledWith(
      "scene-1",
      { synopsis: "queued synopsis" },
      { preexistingDraft: true },
    );
  });

  it("does not add a lifecycle permit to ordinary scene synopsis writes", async () => {
    await useTreeStore
      .getState()
      .updateSynopsis("scene-1", "ordinary synopsis");

    expect(api.updateNode).toHaveBeenCalledWith("scene-1", {
      synopsis: "ordinary synopsis",
    });
  });
});

describe("nullable metadata undo", () => {
  beforeEach(() => reset());

  async function expectNullRestored(
    field: "synopsis" | "intent" | "status",
    value: string,
    update: () => Promise<void>,
  ) {
    vi.mocked(api.updateNode)
      .mockResolvedValueOnce(persistedAt("2024-01-01T00:00:01Z"))
      .mockResolvedValueOnce(persistedAt("2024-01-01T00:00:02Z"));

    await update();
    const command = mockHistoryPush.mock.calls.at(-1)?.[0];
    expect(command).toBeDefined();
    await command.undo();

    expect(vi.mocked(api.updateNode).mock.calls).toEqual([
      ["scene-1", { [field]: value }],
      [
        "scene-1",
        { [field]: null },
        expect.objectContaining({ writeContext: expect.any(Object) }),
      ],
    ]);
    expect(
      useTreeStore.getState().nodes.find((node) => node.id === "scene-1"),
    ).toMatchObject({
      [field]: null,
      updatedAt: "2024-01-01T00:00:02Z",
    });
  }

  it("synopsis undoはDBへ明示nullを保存して返却tokenを反映する", async () => {
    await expectNullRestored("synopsis", "summary", () =>
      useTreeStore.getState().updateSynopsis("scene-1", "summary"),
    );
  });

  it("intent undoはDBへ明示nullを保存して返却tokenを反映する", async () => {
    await expectNullRestored("intent", "intent", () =>
      useTreeStore.getState().updateIntent("scene-1", "intent"),
    );
  });

  it("status undoはDBへ明示nullを保存して返却tokenを反映する", async () => {
    await expectNullRestored("status", "draft", () =>
      useTreeStore.getState().setStatus("scene-1", "draft"),
    );
  });
});
