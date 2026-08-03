import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  mockCodexIndexStatus,
  mockCodexReindexAll,
  mockEventsIndexStatus,
  mockEventsReindexAll,
  mockChatIndexStatus,
  mockChatReindexAll,
  mockDownloadSemanticModel,
  mockSemanticIndexStatus,
  mockSemanticReindexAll,
  mockInvoke,
  runtime,
} = vi.hoisted(() => ({
  mockCodexIndexStatus: vi.fn(),
  mockCodexReindexAll: vi.fn(),
  mockEventsIndexStatus: vi.fn(),
  mockEventsReindexAll: vi.fn(),
  mockChatIndexStatus: vi.fn(),
  mockChatReindexAll: vi.fn(),
  mockDownloadSemanticModel: vi.fn(),
  mockSemanticIndexStatus: vi.fn(),
  mockSemanticReindexAll: vi.fn(),
  mockInvoke: vi.fn(),
  runtime: {
    workspacePath: "/workspace/a",
    workspaceOpenRevision: 1,
    workspaceSwitchInProgress: false,
    workspaceHydrated: true,
    projectId: "p1" as string | null,
    panelWindow: false,
    performanceCapability: false,
  },
}));

vi.mock("./api", () => ({
  codexIndexStatus: mockCodexIndexStatus,
  codexReindexAll: mockCodexReindexAll,
  eventsIndexStatus: mockEventsIndexStatus,
  eventsReindexAll: mockEventsReindexAll,
  chatIndexStatus: mockChatIndexStatus,
  chatReindexAll: mockChatReindexAll,
  downloadSemanticModel: mockDownloadSemanticModel,
  semanticIndexStatus: mockSemanticIndexStatus,
  semanticReindexAll: mockSemanticReindexAll,
}));
vi.mock("@/lib/tauri", () => ({ invoke: mockInvoke }));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({
      activeWorkspacePath: runtime.workspacePath,
      workspaceOpenRevision: runtime.workspaceOpenRevision,
      workspaceSwitchInProgress: runtime.workspaceSwitchInProgress,
      workspaceHydrated: runtime.workspaceHydrated,
    }),
  },
}));
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectLanguage: () => "ja",
  useProjectStore: {
    getState: () => ({ currentProjectId: runtime.projectId }),
  },
}));
vi.mock("@/features/layout/multiwindow/panelWindow", () => ({
  isPanelWindow: () => runtime.panelWindow,
}));
vi.mock("@/lib/perfLog", () => ({
  hasRuntimePerformanceCapability: () => runtime.performanceCapability,
}));

import {
  ensureCodexIndexed,
  ensureEventsIndexed,
  ensureChatIndexed,
  ensureSceneIndexed,
  ensureSemanticModelForProject,
  ensureSemanticIndexesOnOpen,
  resetBackIndexGuards,
  resetIndexGuards,
  activateSemanticIndexScope,
  _resetAutoIndexForTests,
} from "./autoIndex";
import { useReindexProgressStore } from "./reindexProgressStore";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

function sceneStatus(over: Partial<Record<string, unknown>> = {}) {
  return {
    indexedChunkCount: 0,
    staleChunkCount: 0,
    indexedSceneCount: 0,
    nonemptySceneCount: 0,
    currentModelId: "m",
    currentEmbeddingDim: 256,
    currentChunkerVersion: "v1",
    ...over,
  };
}

beforeEach(() => {
  _resetQuiescenceLeasesForTests();
  _resetAutoIndexForTests();
  mockCodexIndexStatus.mockReset();
  mockCodexReindexAll.mockReset().mockResolvedValue(0);
  mockEventsIndexStatus.mockReset();
  mockEventsReindexAll.mockReset().mockResolvedValue(0);
  mockChatIndexStatus.mockReset();
  mockChatReindexAll.mockReset().mockResolvedValue(0);
  mockDownloadSemanticModel.mockReset().mockResolvedValue("installed");
  mockSemanticIndexStatus.mockReset();
  mockSemanticReindexAll.mockReset().mockResolvedValue(0);
  mockInvoke.mockReset().mockResolvedValue({ rows: [{ n: 0 }] });
  runtime.workspacePath = "/workspace/a";
  runtime.workspaceOpenRevision = 1;
  runtime.workspaceSwitchInProgress = false;
  runtime.workspaceHydrated = true;
  runtime.projectId = "p1";
  runtime.panelWindow = false;
  runtime.performanceCapability = false;
  useReindexProgressStore.getState().clear();
});

describe("ensureSemanticModelForProject", () => {
  it("does not download a model inside the deterministic runtime fixture", async () => {
    runtime.performanceCapability = true;

    await ensureSemanticModelForProject("p1", "/workspace/a");

    expect(mockDownloadSemanticModel).not.toHaveBeenCalled();
  });

  it("retries A after its result becomes stale during an A -> B -> A switch", async () => {
    runtime.projectId = "default-project";
    let finishA: (status: string) => void = () => {};
    mockDownloadSemanticModel.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishA = resolve;
      }),
    );

    const staleA = ensureSemanticModelForProject(
      "default-project",
      "/workspace/a",
    );
    runtime.workspacePath = "/workspace/b";
    finishA("installed");
    await staleA;

    runtime.workspacePath = "/workspace/a";
    await ensureSemanticModelForProject("default-project", "/workspace/a");
    expect(mockDownloadSemanticModel).toHaveBeenCalledTimes(2);
  });

  it("can release a downloading guard after a later event reports failure", async () => {
    mockDownloadSemanticModel.mockResolvedValue("downloading");
    await ensureSemanticModelForProject("p1", "/workspace/a");
    await ensureSemanticModelForProject("p1", "/workspace/a");
    expect(mockDownloadSemanticModel).toHaveBeenCalledTimes(1);

    resetIndexGuards("p1", "/workspace/a");
    await ensureSemanticModelForProject("p1", "/workspace/a");
    expect(mockDownloadSemanticModel).toHaveBeenCalledTimes(2);
  });
});

describe("ensureCodexIndexed", () => {
  it("reindexes when indexed < total", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 2,
      totalEntryCount: 5,
    });
    await ensureCodexIndexed("p1");
    expect(mockCodexReindexAll).toHaveBeenCalledWith("p1");
  });

  it("skips reindex when fully indexed", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 5,
      totalEntryCount: 5,
    });
    await ensureCodexIndexed("p1");
    expect(mockCodexReindexAll).not.toHaveBeenCalled();
  });

  it("runs at most once per project per session", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 0,
      totalEntryCount: 3,
    });
    await ensureCodexIndexed("p1");
    await ensureCodexIndexed("p1");
    expect(mockCodexIndexStatus).toHaveBeenCalledTimes(1);
    expect(mockCodexReindexAll).toHaveBeenCalledTimes(1);
  });

  it("retries A after its status becomes stale during an A -> B -> A switch", async () => {
    runtime.projectId = "default-project";
    let finishA: (status: {
      indexedEntryCount: number;
      totalEntryCount: number;
    }) => void = () => {};
    mockCodexIndexStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        finishA = resolve;
      }),
    );

    const staleA = ensureCodexIndexed("default-project", "/workspace/a");
    runtime.workspacePath = "/workspace/b";
    finishA({ indexedEntryCount: 0, totalEntryCount: 2 });
    await staleA;

    runtime.workspacePath = "/workspace/a";
    mockCodexIndexStatus.mockResolvedValueOnce({
      indexedEntryCount: 0,
      totalEntryCount: 2,
    });
    await ensureCodexIndexed("default-project", "/workspace/a");
    expect(mockCodexIndexStatus).toHaveBeenCalledTimes(2);
    expect(mockCodexReindexAll).toHaveBeenCalledTimes(1);
  });

  it("is silent and retriable when reindex fails", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 0,
      totalEntryCount: 3,
    });
    mockCodexReindexAll.mockRejectedValueOnce(new Error("no model"));
    await expect(ensureCodexIndexed("p1")).resolves.toBeUndefined();
    // ガードが外れ、次の open で再試行できる。
    mockCodexReindexAll.mockResolvedValueOnce(3);
    await ensureCodexIndexed("p1");
    expect(mockCodexReindexAll).toHaveBeenCalledTimes(2);
  });

  it("ignores empty projectId", async () => {
    await ensureCodexIndexed("");
    expect(mockCodexIndexStatus).not.toHaveBeenCalled();
  });
});

describe("ensureChatIndexed", () => {
  it("reindexes when indexed < total", async () => {
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 1,
      totalMessageCount: 8,
    });
    await ensureChatIndexed("p1");
    expect(mockChatReindexAll).toHaveBeenCalledWith("p1");
  });

  it("skips reindex when fully indexed", async () => {
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 8,
      totalMessageCount: 8,
    });
    await ensureChatIndexed("p1");
    expect(mockChatReindexAll).not.toHaveBeenCalled();
  });

  it("runs at most once per project per session", async () => {
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 0,
      totalMessageCount: 4,
    });
    await ensureChatIndexed("p1");
    await ensureChatIndexed("p1");
    expect(mockChatIndexStatus).toHaveBeenCalledTimes(1);
    expect(mockChatReindexAll).toHaveBeenCalledTimes(1);
  });

  it("is silent and retriable when reindex fails", async () => {
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 0,
      totalMessageCount: 4,
    });
    mockChatReindexAll.mockRejectedValueOnce(new Error("no model"));
    await expect(ensureChatIndexed("p1")).resolves.toBeUndefined();
    mockChatReindexAll.mockResolvedValueOnce(4);
    await ensureChatIndexed("p1");
    expect(mockChatReindexAll).toHaveBeenCalledTimes(2);
  });

  it("ignores empty projectId", async () => {
    await ensureChatIndexed("");
    expect(mockChatIndexStatus).not.toHaveBeenCalled();
  });
});

describe("ensureEventsIndexed", () => {
  it("reindexes pre-existing events when indexed < total", async () => {
    mockEventsIndexStatus.mockResolvedValue({
      indexedEventCount: 1,
      totalEventCount: 4,
    });
    await ensureEventsIndexed("p1");
    expect(mockEventsReindexAll).toHaveBeenCalledWith("p1");
  });

  it("skips when all events are indexed", async () => {
    mockEventsIndexStatus.mockResolvedValue({
      indexedEventCount: 4,
      totalEventCount: 4,
    });
    await ensureEventsIndexed("p1");
    expect(mockEventsReindexAll).not.toHaveBeenCalled();
  });

  it("is retriable after a failed event back-index", async () => {
    mockEventsIndexStatus.mockResolvedValue({
      indexedEventCount: 0,
      totalEventCount: 4,
    });
    mockEventsReindexAll.mockRejectedValueOnce(new Error("no model"));
    await expect(ensureEventsIndexed("p1")).resolves.toBeUndefined();
    await ensureEventsIndexed("p1");
    expect(mockEventsReindexAll).toHaveBeenCalledTimes(2);
  });
});

describe("ensureSceneIndexed", () => {
  it("reindexes when indexedSceneCount < nonemptySceneCount", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 1, nonemptySceneCount: 4 }),
    );
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith(
      "p1",
      expect.any(String),
    );
    expect(useReindexProgressStore.getState().running).toBe(false);
  });

  it("reindexes when stale chunks exist", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({
        indexedSceneCount: 4,
        nonemptySceneCount: 4,
        staleChunkCount: 2,
      }),
    );
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith(
      "p1",
      expect.any(String),
    );
  });

  it("skips when scenes fully indexed and fresh", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({
        indexedSceneCount: 4,
        nonemptySceneCount: 4,
        staleChunkCount: 0,
      }),
    );
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).not.toHaveBeenCalled();
  });

  it("skips when only empty scenes remain unindexed (indexed == nonempty, stale=0)", async () => {
    // 回帰ガード: 空 scene 14 + 実体 1 のプロジェクト。indexedSceneCount(1) は
    // total scene 数(15) より小さいが、空 scene は chunk を生まないので
    // nonemptySceneCount は 1。分母を total にしていた旧実装では 1<15 で毎回
    // 再インデックスが走っていた。nonemptySceneCount を分母にすれば発火しない。
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({
        indexedSceneCount: 1,
        nonemptySceneCount: 1,
        staleChunkCount: 0,
      }),
    );
    await ensureSceneIndexed("p1");
    expect(mockSemanticReindexAll).not.toHaveBeenCalled();
    expect(useReindexProgressStore.getState().running).toBe(false);
  });

  it("waits and rechecks status when a reindex is already running", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 1, nonemptySceneCount: 1 }),
    );
    useReindexProgressStore.getState().setRunning(true);
    const pending = ensureSceneIndexed("p1");
    await Promise.resolve();
    expect(mockSemanticIndexStatus).not.toHaveBeenCalled();
    useReindexProgressStore.getState().setRunning(false);
    await pending;
    expect(mockSemanticIndexStatus).toHaveBeenCalledTimes(1);
    expect(mockSemanticReindexAll).not.toHaveBeenCalled();
  });

  it("is silent and clears running when reindex fails", async () => {
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 0, nonemptySceneCount: 4 }),
    );
    mockSemanticReindexAll.mockRejectedValueOnce(new Error("boom"));
    await expect(ensureSceneIndexed("p1")).resolves.toBeUndefined();
    expect(useReindexProgressStore.getState().running).toBe(false);
  });

  it("retries A after its status becomes stale during an A -> B -> A switch", async () => {
    runtime.projectId = "default-project";
    let finishA: (status: ReturnType<typeof sceneStatus>) => void = () => {};
    mockSemanticIndexStatus.mockReturnValueOnce(
      new Promise((resolve) => {
        finishA = resolve;
      }),
    );

    const staleA = ensureSceneIndexed("default-project", "/workspace/a");
    runtime.workspacePath = "/workspace/b";
    finishA(sceneStatus({ indexedSceneCount: 0, nonemptySceneCount: 2 }));
    await staleA;

    runtime.workspacePath = "/workspace/a";
    mockSemanticIndexStatus.mockResolvedValueOnce(
      sceneStatus({ indexedSceneCount: 2, nonemptySceneCount: 2 }),
    );
    await ensureSceneIndexed("default-project", "/workspace/a");
    expect(mockSemanticIndexStatus).toHaveBeenCalledTimes(2);
    expect(mockSemanticReindexAll).not.toHaveBeenCalled();
  });

  it("queues the new-language rebuild until the previous run finishes", async () => {
    runtime.projectId = "default-project";
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 0, nonemptySceneCount: 2 }),
    );
    let finishOldRun: (count: number) => void = () => {};
    mockSemanticReindexAll
      .mockReturnValueOnce(
        new Promise<number>((resolve) => {
          finishOldRun = resolve;
        }),
      )
      .mockResolvedValueOnce(2);

    const oldRun = ensureSceneIndexed("default-project", "/workspace/a");
    await vi.waitFor(() => {
      expect(mockSemanticReindexAll).toHaveBeenCalledTimes(1);
    });

    // Language change clears the old once-per-session guard. Its immediate
    // rebuild request must wait rather than disappear behind `running=true`.
    resetIndexGuards("default-project", "/workspace/a");
    const newLanguageRun = ensureSceneIndexed(
      "default-project",
      "/workspace/a",
    );
    await Promise.resolve();
    expect(mockSemanticReindexAll).toHaveBeenCalledTimes(1);

    finishOldRun(2);
    await Promise.all([oldRun, newLanguageRun]);
    expect(mockSemanticReindexAll).toHaveBeenCalledTimes(2);
  });

  it("keeps A and B isolated when workspace changes in-flight with the same project id", async () => {
    runtime.projectId = "default-project";
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 0, nonemptySceneCount: 4 }),
    );
    let rejectA: (error: Error) => void = () => {};
    const aInFlight = new Promise<number>((_resolve, reject) => {
      rejectA = reject;
    });
    mockSemanticReindexAll.mockReturnValueOnce(aInFlight);

    const aDone = ensureSceneIndexed("default-project", "/workspace/a");
    await vi.waitFor(() => {
      expect(mockSemanticReindexAll).toHaveBeenCalledTimes(1);
    });

    runtime.workspacePath = "/workspace/b";
    activateSemanticIndexScope("/workspace/b", "default-project");
    await ensureSceneIndexed("default-project", "/workspace/b");
    expect(mockSemanticReindexAll).toHaveBeenCalledTimes(2);
    const bRunId = mockSemanticReindexAll.mock.calls[1]?.[1] as string;
    useReindexProgressStore
      .getState()
      .begin(
        "/workspace/b",
        runtime.workspaceOpenRevision,
        "default-project",
        bRunId,
      );
    useReindexProgressStore.getState().setProgress({
      projectId: "default-project",
      runId: bRunId,
      sceneIndex: 1,
      sceneId: "b-scene",
      totalScenes: 2,
      chunksIndexed: 3,
      done: false,
    });

    rejectA(new Error("old workspace failed"));
    await aDone;
    expect(useReindexProgressStore.getState().current?.sceneId).toBe("b-scene");
    expect(useReindexProgressStore.getState().activeRunId).toBe(bRunId);
  });
});

describe("ensureSemanticIndexesOnOpen", () => {
  it("does not start derived indexing while a lifecycle lease is active", async () => {
    const lease = acquireQuiescenceLease("window-close");
    await ensureSemanticIndexesOnOpen("p1", "/workspace/a");
    lease.release({ disposition: "renderer-teardown" });
    // The native close IPC may resolve before React unmounts. The released
    // lease still leaves this renderer in a terminal state during that gap.
    await ensureSemanticIndexesOnOpen("p1", "/workspace/a");

    expect(mockDownloadSemanticModel).not.toHaveBeenCalled();
    expect(mockCodexIndexStatus).not.toHaveBeenCalled();
    expect(mockEventsIndexStatus).not.toHaveBeenCalled();
  });

  it("does not advance a cancelled pipeline after close quiescence begins", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 0,
      totalEntryCount: 0,
    });
    mockEventsIndexStatus.mockResolvedValue({
      indexedEventCount: 0,
      totalEventCount: 1,
    });
    let finishEvents: (count: number) => void = () => {};
    mockEventsReindexAll.mockReturnValueOnce(
      new Promise<number>((resolve) => {
        finishEvents = resolve;
      }),
    );
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 0,
      totalMessageCount: 1,
    });
    mockSemanticIndexStatus.mockResolvedValue(sceneStatus());

    const pending = ensureSemanticIndexesOnOpen("p1", "/workspace/a");
    await vi.waitFor(() => expect(mockEventsReindexAll).toHaveBeenCalledOnce());
    const lease = acquireQuiescenceLease("window-close");
    finishEvents(1);
    await pending;

    expect(mockChatIndexStatus).not.toHaveBeenCalled();
    expect(mockSemanticIndexStatus).not.toHaveBeenCalled();
    lease.release({ disposition: "renderer-teardown" });
  });

  it("runs codex, events, chat and scene back-index", async () => {
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 0,
      totalEntryCount: 2,
    });
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 0,
      totalMessageCount: 3,
    });
    mockEventsIndexStatus.mockResolvedValue({
      indexedEventCount: 0,
      totalEventCount: 4,
    });
    mockSemanticIndexStatus.mockResolvedValue(
      sceneStatus({ indexedSceneCount: 0, nonemptySceneCount: 3 }),
    );
    await ensureSemanticIndexesOnOpen("p1", "/workspace/a");
    expect(mockCodexReindexAll).toHaveBeenCalledWith("p1");
    expect(mockEventsReindexAll).toHaveBeenCalledWith("p1");
    expect(mockChatReindexAll).toHaveBeenCalledWith("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith(
      "p1",
      expect.any(String),
    );
  });

  it("rechecks every domain after an asynchronous model download completes", async () => {
    mockCodexIndexStatus
      .mockResolvedValueOnce({ indexedEntryCount: 0, totalEntryCount: 0 })
      .mockResolvedValueOnce({ indexedEntryCount: 0, totalEntryCount: 1 });
    mockEventsIndexStatus
      .mockResolvedValueOnce({ indexedEventCount: 0, totalEventCount: 0 })
      .mockResolvedValueOnce({ indexedEventCount: 0, totalEventCount: 1 });
    mockChatIndexStatus
      .mockResolvedValueOnce({ indexedMessageCount: 0, totalMessageCount: 0 })
      .mockResolvedValueOnce({ indexedMessageCount: 0, totalMessageCount: 1 });
    mockSemanticIndexStatus
      .mockResolvedValueOnce(sceneStatus())
      .mockResolvedValueOnce(
        sceneStatus({ indexedSceneCount: 0, nonemptySceneCount: 1 }),
      );

    await ensureSemanticIndexesOnOpen("p1", "/workspace/a");
    resetBackIndexGuards("p1", "/workspace/a");
    await ensureSemanticIndexesOnOpen("p1", "/workspace/a");

    expect(mockDownloadSemanticModel).toHaveBeenCalledTimes(1);
    expect(mockCodexReindexAll).toHaveBeenCalledWith("p1");
    expect(mockEventsReindexAll).toHaveBeenCalledWith("p1");
    expect(mockChatReindexAll).toHaveBeenCalledWith("p1");
    expect(mockSemanticReindexAll).toHaveBeenCalledWith(
      "p1",
      expect.any(String),
    );
  });

  it("does nothing in a panel window", async () => {
    runtime.panelWindow = true;
    await ensureSemanticIndexesOnOpen("p1", "/workspace/a");
    expect(mockDownloadSemanticModel).not.toHaveBeenCalled();
    expect(mockCodexIndexStatus).not.toHaveBeenCalled();
    expect(mockEventsIndexStatus).not.toHaveBeenCalled();
    expect(mockChatIndexStatus).not.toHaveBeenCalled();
    expect(mockSemanticIndexStatus).not.toHaveBeenCalled();
  });

  it("rejects an explicit stale workspace key before starting model download", async () => {
    runtime.workspacePath = "/workspace/b";
    await ensureSemanticIndexesOnOpen("p1", "/workspace/a");
    expect(mockDownloadSemanticModel).not.toHaveBeenCalled();
    expect(mockCodexIndexStatus).not.toHaveBeenCalled();
  });

  it("runs again for a newly opened DB at the same path and project id", async () => {
    runtime.projectId = "default-project";
    mockCodexIndexStatus.mockResolvedValue({
      indexedEntryCount: 0,
      totalEntryCount: 0,
    });
    mockEventsIndexStatus.mockResolvedValue({
      indexedEventCount: 0,
      totalEventCount: 0,
    });
    mockChatIndexStatus.mockResolvedValue({
      indexedMessageCount: 0,
      totalMessageCount: 0,
    });
    mockSemanticIndexStatus.mockResolvedValue(sceneStatus());

    await ensureSemanticIndexesOnOpen("default-project", "/workspace/a");
    runtime.workspaceOpenRevision = 2;
    await ensureSemanticIndexesOnOpen("default-project", "/workspace/a");

    expect(mockDownloadSemanticModel).toHaveBeenCalledTimes(2);
    expect(mockCodexIndexStatus).toHaveBeenCalledTimes(2);
    expect(mockEventsIndexStatus).toHaveBeenCalledTimes(2);
    expect(mockChatIndexStatus).toHaveBeenCalledTimes(2);
    expect(mockSemanticIndexStatus).toHaveBeenCalledTimes(2);
  });

  it("stops an old pipeline during the native-swap hydration gap", async () => {
    let finishModel: () => void = () => {};
    mockDownloadSemanticModel.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishModel = () => resolve("installed");
      }),
    );
    const pending = ensureSemanticIndexesOnOpen("p1", "/workspace/a");
    runtime.workspaceSwitchInProgress = true;
    finishModel();
    await pending;
    expect(mockCodexIndexStatus).not.toHaveBeenCalled();
  });

  it("does not continue to the next stage after the workspace changes", async () => {
    let finishModel: () => void = () => {};
    mockDownloadSemanticModel.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        finishModel = () => resolve("installed");
      }),
    );
    const pending = ensureSemanticIndexesOnOpen("p1", "/workspace/a");
    runtime.workspacePath = "/workspace/b";
    finishModel();
    await pending;
    expect(mockCodexIndexStatus).not.toHaveBeenCalled();
  });
});
