import { describe, it, expect, vi, beforeEach } from "vitest";

const currentProject = { value: "p1" };
vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => currentProject.value,
}));
vi.mock("@/features/timelapse/recorder", () => ({
  recordChangeEvent: vi.fn(),
}));
vi.mock("./api", () => ({
  listPlotThreads: vi.fn(async () => []),
  listPlotThreadLinks: vi.fn(async () => []),
  listPlotThreadBranches: vi.fn(async () => []),
  createPlotThread: vi.fn(),
  updatePlotThread: vi.fn(async () => {}),
  deletePlotThread: vi.fn(async () => {}),
  createPlotThreadLink: vi.fn(),
  updatePlotThreadLink: vi.fn(async () => {}),
  deletePlotThreadLink: vi.fn(async () => {}),
  createPlotThreadBranch: vi.fn(),
  updatePlotThreadBranch: vi.fn(),
  deletePlotThreadBranch: vi.fn(async () => {}),
  restorePlotThreadSnapshot: vi.fn(async (payload) => ({
    id: payload.requestId ?? "restore",
    thread: payload.thread ?? null,
    links: payload.links ?? [],
    branches: payload.branches ?? [],
  })),
  deletePlotThreadSnapshot: vi.fn(async (payload) => ({
    id: payload.requestId ?? "delete",
    deleted: true,
  })),
  movePlotMarkerBundle: vi.fn(),
}));

import {
  listPlotThreads,
  listPlotThreadLinks,
  listPlotThreadBranches,
  createPlotThread,
  updatePlotThread,
  deletePlotThread,
  createPlotThreadLink,
  updatePlotThreadLink,
  deletePlotThreadLink,
  createPlotThreadBranch,
  updatePlotThreadBranch,
  deletePlotThreadBranch,
  restorePlotThreadSnapshot,
  deletePlotThreadSnapshot,
  movePlotMarkerBundle,
  type PlotThreadRow,
  type PlotThreadLinkRow,
  type PlotThreadBranchRow,
} from "./api";
import { usePlotThreadStore } from "./plotThreadStore";
import { useGlobalHistoryStore } from "@/store/globalHistoryStore";
import type { PlotPhaseType } from "@/db/schema";
import { attachCreateResultMetadata } from "@/lib/createResultMetadata";
import { IpcInvokeError } from "@/lib/tauri";
import { recordChangeEvent } from "@/features/timelapse/recorder";
import {
  _resetQuiescenceLeasesForTests,
  acquireQuiescenceLease,
} from "@/application/lifecycle/quiescenceLease";

const mock = (fn: unknown) => fn as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function unknownCreateError(command: string): IpcInvokeError {
  return new IpcInvokeError(command, {
    code: "IPC_TIMEOUT",
    message: `IPC timeout: ${command}`,
    retryable: true,
    outcome: "unknown",
  });
}

const row = (
  id: string,
  sortOrder: string,
  projectId = "p1",
): PlotThreadRow => ({
  id,
  projectId,
  name: id,
  color: null,
  description: null,
  sortOrder,
  startNodeId: null,
  endNodeId: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
});

const linkRow = (id: string): PlotThreadLinkRow => ({
  id,
  threadId: "t1",
  nodeId: "s1",
  phaseType: "develop",
  note: null,
  sortOrder: null,
  createdAt: "2026-01-01T01:00:00.000Z",
  updatedAt: "2026-01-02T01:00:00.000Z",
});

const branchRow = (
  id: string,
  fromThreadId = "t1",
  toThreadId = "t2",
): PlotThreadBranchRow => ({
  id,
  projectId: "p1",
  fromThreadId,
  toThreadId,
  atNodeId: "s1",
  kind: "branch",
  createdAt: "2026-01-01T02:00:00.000Z",
  updatedAt: "2026-01-02T02:00:00.000Z",
});

describe("plotThreadStore", () => {
  beforeEach(() => {
    currentProject.value = "p1";
    vi.clearAllMocks();
    mock(createPlotThread).mockReset();
    mock(createPlotThreadLink).mockReset();
    mock(createPlotThreadBranch).mockReset();
    mock(updatePlotThread).mockReset();
    mock(updatePlotThreadLink).mockReset();
    mock(updatePlotThreadBranch).mockReset();
    mock(restorePlotThreadSnapshot).mockReset();
    mock(deletePlotThreadSnapshot).mockReset();
    mock(movePlotMarkerBundle).mockReset();
    mock(createPlotThread).mockImplementation(async (data) => ({
      ...row(data.id ?? "thread-created", data.sortOrder, data.projectId),
      name: data.name,
      color: data.color ?? null,
      description: data.description ?? null,
    }));
    mock(createPlotThreadLink).mockImplementation(async (data) => ({
      ...linkRow(data.id ?? "link-created"),
      threadId: data.threadId,
      nodeId: data.nodeId,
      phaseType: data.phaseType,
      note: data.note ?? null,
      sortOrder: data.sortOrder ?? null,
    }));
    mock(createPlotThreadBranch).mockImplementation(async (data) => ({
      ...branchRow(
        data.id ?? "branch-created",
        data.fromThreadId,
        data.toThreadId,
      ),
      projectId: data.projectId,
      atNodeId: data.atNodeId,
      kind: data.kind,
    }));
    mock(updatePlotThread).mockImplementation(async (id, patch) => {
      const current =
        usePlotThreadStore
          .getState()
          .threads.find((thread) => thread.id === id) ?? row(id, "a0");
      return {
        ...current,
        ...patch,
        updatedAt: "2026-01-03T00:00:00.000Z",
      };
    });
    mock(updatePlotThreadLink).mockImplementation(async (id, patch) => {
      const current =
        usePlotThreadStore.getState().links.find((link) => link.id === id) ??
        linkRow(id);
      return {
        ...current,
        ...patch,
        updatedAt: "2026-01-03T01:00:00.000Z",
      };
    });
    mock(updatePlotThreadBranch).mockImplementation(async (id, patch) => {
      const current =
        usePlotThreadStore
          .getState()
          .branches.find((branch) => branch.id === id) ?? branchRow(id);
      return {
        ...current,
        ...patch,
        updatedAt: "2026-01-03T02:00:00.000Z",
      };
    });
    mock(movePlotMarkerBundle).mockImplementation(async (payload) => ({
      id: payload.requestId ?? "move",
      marker: payload.markerAfter,
      branches: payload.branchTransitions.flatMap(
        (transition: { after: PlotThreadBranchRow | null }) =>
          transition.after ? [transition.after] : [],
      ),
      deletedBranchIds: payload.branchTransitions.flatMap(
        (transition: {
          before: PlotThreadBranchRow | null;
          after: PlotThreadBranchRow | null;
        }) =>
          transition.before && !transition.after ? [transition.before.id] : [],
      ),
    }));
    mock(restorePlotThreadSnapshot).mockImplementation(async (payload) => ({
      id: payload.requestId ?? "restore",
      thread: payload.thread ?? null,
      links: payload.links ?? [],
      branches: payload.branches ?? [],
    }));
    mock(deletePlotThreadSnapshot).mockImplementation(async (payload) => ({
      id: payload.requestId ?? "delete",
      deleted: true,
    }));
    usePlotThreadStore.getState().resetForProject("p1");
    (listPlotThreads as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (listPlotThreadLinks as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    (listPlotThreadBranches as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    _resetQuiescenceLeasesForTests();
    useGlobalHistoryStore.getState().clear();
  });

  it("loads threads and links for the current project", async () => {
    (listPlotThreads as ReturnType<typeof vi.fn>).mockResolvedValue([
      row("t1", "a0"),
    ]);
    await usePlotThreadStore.getState().load("p1");
    expect(usePlotThreadStore.getState().threads).toHaveLength(1);
    expect(usePlotThreadStore.getState().loading).toBe(false);
  });

  it("drops a stale load when the project switched mid-flight", async () => {
    (listPlotThreads as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        currentProject.value = "p2"; // ロード中にプロジェクト切替
        return [row("t1", "a0")];
      },
    );
    await usePlotThreadStore.getState().load("p1");
    // p1 のロード結果は破棄される（現在 p2 のため）
    expect(usePlotThreadStore.getState().threads).toHaveLength(0);
  });

  it("Project commit clears old rows before optional hydration settles", async () => {
    const targetThreads = deferred<PlotThreadRow[]>();
    usePlotThreadStore.setState({
      activeProjectId: "p1",
      threads: [row("old", "a0")],
      links: [linkRow("old-link")],
      branches: [branchRow("old-branch")],
    });
    currentProject.value = "p2";
    usePlotThreadStore.getState().resetForProject("p2");
    mock(listPlotThreads).mockReturnValueOnce(targetThreads.promise);

    const load = usePlotThreadStore.getState().load("p2");
    expect(usePlotThreadStore.getState()).toMatchObject({
      activeProjectId: "p2",
      threads: [],
      links: [],
      branches: [],
      loading: true,
    });

    targetThreads.resolve([row("new", "a0", "p2")]);
    await load;
    expect(usePlotThreadStore.getState().threads.map(({ id }) => id)).toEqual([
      "new",
    ]);
  });

  it("reports a current optional-hydration failure without restoring old rows", async () => {
    currentProject.value = "p2";
    usePlotThreadStore.getState().resetForProject("p2");
    mock(listPlotThreads).mockRejectedValueOnce(new Error("load failed"));

    await expect(usePlotThreadStore.getState().load("p2")).rejects.toThrow(
      "load failed",
    );
    expect(usePlotThreadStore.getState()).toMatchObject({
      activeProjectId: "p2",
      threads: [],
      links: [],
      branches: [],
      loading: false,
    });
  });

  it("rejects an old Project callback after the synchronous commit reset", async () => {
    usePlotThreadStore.setState({ threads: [row("old", "a0")] });
    const renameFromOldRender = usePlotThreadStore.getState().renameThread;

    currentProject.value = "p2";
    usePlotThreadStore.getState().resetForProject("p2");
    await renameFromOldRender("old", "must-not-write");

    expect(updatePlotThread).not.toHaveBeenCalled();
    expect(usePlotThreadStore.getState().threads).toEqual([]);
  });

  it("appends a new thread with a sortOrder after the last", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")], links: [] });
    (createPlotThread as ReturnType<typeof vi.fn>).mockImplementation(
      async (data: { sortOrder: string }) => row("t2", data.sortOrder),
    );
    await usePlotThreadStore.getState().addThread("p1", "second");
    const threads = usePlotThreadStore.getState().threads;
    expect(threads).toHaveLength(2);
    // 新キーは末尾（"a0" より後）であること
    expect(threads[1].sortOrder > "a0").toBe(true);
  });

  it("removes a thread and its links locally on delete", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
      links: [
        {
          id: "l1",
          threadId: "t1",
          nodeId: "s1",
          phaseType: "introduce",
          note: null,
          sortOrder: null,
          createdAt: "",
          updatedAt: "",
        },
      ],
    });
    await usePlotThreadStore.getState().deleteThread("t1");
    expect(usePlotThreadStore.getState().threads.map((t) => t.id)).toEqual([
      "t2",
    ]);
    expect(usePlotThreadStore.getState().links).toHaveLength(0);
  });

  it("addMarker が作成結果を links に追加する", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
    (createPlotThreadLink as ReturnType<typeof vi.fn>).mockResolvedValue(
      linkRow("l1"),
    );
    await usePlotThreadStore.getState().addMarker("t1", "s1", "develop");
    expect(createPlotThreadLink).toHaveBeenCalledWith({
      id: expect.any(String),
      threadId: "t1",
      nodeId: "s1",
      phaseType: "develop",
    });
    expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
      "l1",
    ]);
  });

  it("updateMarker が links を楽観更新する", async () => {
    usePlotThreadStore.setState({ links: [linkRow("l1")] });
    await usePlotThreadStore.getState().updateMarker("l1", {
      phaseType: "climax",
    });
    expect(usePlotThreadStore.getState().links[0].phaseType).toBe("climax");
  });

  it("marker/branch 更新後の persisted timestamp を delete precondition に渡す", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1"), row("t3", "a2")],
      links: [linkRow("m1")],
      branches: [branchRow("br1", "t2", "t1")],
    });
    await usePlotThreadStore
      .getState()
      .updateMarker("m1", { note: "updated marker" });
    await usePlotThreadStore
      .getState()
      .updateBranch("br1", { fromThreadId: "t3" });
    await usePlotThreadStore.getState().deleteMarker("m1");

    expect(deletePlotThreadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({
          id: "m1",
          note: "updated marker",
          updatedAt: "2026-01-03T01:00:00.000Z",
        }),
        branches: [
          expect.objectContaining({
            id: "br1",
            fromThreadId: "t3",
            updatedAt: "2026-01-03T02:00:00.000Z",
          }),
        ],
      }),
    );
  });

  it("reorderThread は IPC 完了前に threads の sortOrder を楽観更新する", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
    });
    let resolveIpc: (value: PlotThreadRow) => void = () => {};
    mock(updatePlotThread).mockImplementationOnce(
      () => new Promise<PlotThreadRow>((r) => (resolveIpc = r)),
    );
    // await せずに発火（ドロップ時の void 呼び出しと同じ）。
    const p = usePlotThreadStore.getState().reorderThread("t1", "a2");
    // IPC 未完了でも store の sortOrder は即時反映されている。
    expect(
      usePlotThreadStore.getState().threads.find((t) => t.id === "t1")
        ?.sortOrder,
    ).toBe("a2");
    resolveIpc({
      ...row("t1", "a2"),
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    await p;
    expect(mock(updatePlotThread)).toHaveBeenCalledWith("t1", {
      sortOrder: "a2",
    });
  });

  it("reorderThread は IPC 失敗時に sortOrder を元へ戻す", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
    mock(updatePlotThread).mockRejectedValueOnce(new Error("ipc fail"));
    await expect(
      usePlotThreadStore.getState().reorderThread("t1", "a9"),
    ).rejects.toThrow();
    expect(
      usePlotThreadStore.getState().threads.find((t) => t.id === "t1")
        ?.sortOrder,
    ).toBe("a0");
  });

  it("reorderThread は lifecycle barrier に拒否された楽観更新を戻す", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
    const lease = acquireQuiescenceLease("project-load");
    try {
      await usePlotThreadStore.getState().reorderThread("t1", "a9");
    } finally {
      lease.release();
    }

    expect(updatePlotThread).not.toHaveBeenCalled();
    expect(
      usePlotThreadStore.getState().threads.find((thread) => thread.id === "t1")
        ?.sortOrder,
    ).toBe("a0");
  });

  it("deleteMarker が links から除外する", async () => {
    usePlotThreadStore.setState({ links: [linkRow("l1"), linkRow("l2")] });
    await usePlotThreadStore.getState().deleteMarker("l1");
    expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
      "l2",
    ]);
  });

  it("addBranch が作成結果を branches に追加する", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
    });
    (createPlotThreadBranch as ReturnType<typeof vi.fn>).mockResolvedValue(
      branchRow("br1"),
    );
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch",
    });
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br1",
    ]);
  });

  it("削除済み create replay を thread/link/branch と history に再公開しない", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
      links: [],
      branches: [],
    });
    mock(createPlotThread).mockResolvedValue(
      attachCreateResultMetadata(row("deleted-thread", "a2"), {
        __idempotency: { replayed: true, entityPresent: false },
      }),
    );
    mock(createPlotThreadLink).mockResolvedValue(
      attachCreateResultMetadata(linkRow("deleted-link"), {
        __idempotency: { replayed: true, entityPresent: false },
      }),
    );
    mock(createPlotThreadBranch).mockResolvedValue(
      attachCreateResultMetadata(branchRow("deleted-branch"), {
        __idempotency: { replayed: true, entityPresent: false },
      }),
    );

    await usePlotThreadStore.getState().addThread("p1", "deleted");
    await usePlotThreadStore.getState().addMarker("t1", "s1", "develop");
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch",
    });

    expect(usePlotThreadStore.getState().threads.map(({ id }) => id)).toEqual([
      "t1",
      "t2",
    ]);
    expect(usePlotThreadStore.getState().links).toHaveLength(0);
    expect(usePlotThreadStore.getState().branches).toHaveLength(0);
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
  });

  it("存在中の create replay を store/history/timelapse に二重反映しない", async () => {
    const existingThread = row("replayed-thread", "a2");
    const existingLink = linkRow("replayed-link");
    const existingBranch = branchRow("replayed-branch");
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1"), existingThread],
      links: [existingLink],
      branches: [existingBranch],
    });
    mock(createPlotThread).mockResolvedValue(
      attachCreateResultMetadata(row("replayed-thread", "a2"), {
        __idempotency: { replayed: true, entityPresent: true },
      }),
    );
    mock(createPlotThreadLink).mockResolvedValue(
      attachCreateResultMetadata(linkRow("replayed-link"), {
        __idempotency: { replayed: true, entityPresent: true },
      }),
    );
    mock(createPlotThreadBranch).mockResolvedValue(
      attachCreateResultMetadata(branchRow("replayed-branch"), {
        __idempotency: { replayed: true, entityPresent: true },
      }),
    );

    await usePlotThreadStore.getState().addThread("p1", "replayed");
    await usePlotThreadStore.getState().addMarker("t1", "s1", "develop");
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch",
    });

    expect(
      usePlotThreadStore
        .getState()
        .threads.filter(({ id }) => id === "replayed-thread"),
    ).toHaveLength(1);
    expect(
      usePlotThreadStore
        .getState()
        .links.filter(({ id }) => id === "replayed-link"),
    ).toHaveLength(1);
    expect(
      usePlotThreadStore
        .getState()
        .branches.filter(({ id }) => id === "replayed-branch"),
    ).toHaveLength(1);
    expect(useGlobalHistoryStore.getState().past).toHaveLength(0);
    expect(recordChangeEvent).not.toHaveBeenCalled();
  });

  it("unknown 後の thread 明示リトライは同じ ID と元の payload を再利用し、成功後は解放する", async () => {
    mock(createPlotThread)
      .mockRejectedValueOnce(unknownCreateError("plot_thread_create"))
      .mockImplementationOnce(async (data) =>
        attachCreateResultMetadata(row(data.id!, data.sortOrder), {
          __idempotency: { replayed: true, entityPresent: true },
        }),
      )
      .mockImplementationOnce(async (data) => row(data.id!, data.sortOrder));

    await expect(
      usePlotThreadStore.getState().addThread("p1", "retry", "#123456"),
    ).rejects.toBeInstanceOf(IpcInvokeError);
    await usePlotThreadStore.getState().addThread("p1", "retry", "#123456");

    const [firstPayload] = mock(createPlotThread).mock.calls[0];
    const [retryPayload] = mock(createPlotThread).mock.calls[1];
    expect(retryPayload).toEqual(firstPayload);
    expect(firstPayload.id).toBeTruthy();
    expect(
      usePlotThreadStore
        .getState()
        .threads.filter(({ id }) => id === firstPayload.id),
    ).toHaveLength(1);
    expect(useGlobalHistoryStore.getState().past).toHaveLength(1);
    expect(recordChangeEvent).toHaveBeenCalledTimes(1);

    await usePlotThreadStore.getState().addThread("p1", "retry", "#123456");
    const [afterSuccessPayload] = mock(createPlotThread).mock.calls[2];
    expect(afterSuccessPayload.id).not.toBe(firstPayload.id);
  });

  it("unknown 後に thread payload を変更すると保留 ID を解放する", async () => {
    mock(createPlotThread)
      .mockRejectedValueOnce(unknownCreateError("plot_thread_create"))
      .mockImplementationOnce(async (data) => row(data.id!, data.sortOrder));

    await expect(
      usePlotThreadStore.getState().addThread("p1", "before"),
    ).rejects.toBeInstanceOf(IpcInvokeError);
    await usePlotThreadStore.getState().addThread("p1", "after");

    const [firstPayload] = mock(createPlotThread).mock.calls[0];
    const [changedPayload] = mock(createPlotThread).mock.calls[1];
    expect(changedPayload.name).toBe("after");
    expect(changedPayload.id).not.toBe(firstPayload.id);
  });

  it("unknown 後の marker/branch 明示リトライは各 create ID を再利用する", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
    });
    mock(createPlotThreadLink)
      .mockRejectedValueOnce(unknownCreateError("plot_thread_link_create"))
      .mockImplementationOnce(async (data) =>
        attachCreateResultMetadata(linkRow(data.id!), {
          __idempotency: { replayed: true, entityPresent: true },
        }),
      );
    mock(createPlotThreadBranch)
      .mockRejectedValueOnce(unknownCreateError("plot_thread_branch_create"))
      .mockImplementationOnce(async (data) =>
        attachCreateResultMetadata(branchRow(data.id!), {
          __idempotency: { replayed: true, entityPresent: true },
        }),
      );

    await expect(
      usePlotThreadStore.getState().addMarker("t1", "s1", "develop"),
    ).rejects.toBeInstanceOf(IpcInvokeError);
    await usePlotThreadStore.getState().addMarker("t1", "s1", "develop");
    const [firstLinkPayload] = mock(createPlotThreadLink).mock.calls[0];
    const [retryLinkPayload] = mock(createPlotThreadLink).mock.calls[1];
    expect(retryLinkPayload).toEqual(firstLinkPayload);
    expect(firstLinkPayload.id).toBeTruthy();

    const branchPayload = {
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch" as const,
    };
    await expect(
      usePlotThreadStore.getState().addBranch(branchPayload),
    ).rejects.toBeInstanceOf(IpcInvokeError);
    await usePlotThreadStore.getState().addBranch(branchPayload);
    const [firstBranchPayload] = mock(createPlotThreadBranch).mock.calls[0];
    const [retryBranchPayload] = mock(createPlotThreadBranch).mock.calls[1];
    expect(retryBranchPayload).toEqual(firstBranchPayload);
    expect(firstBranchPayload.id).toBeTruthy();

    expect(useGlobalHistoryStore.getState().past).toHaveLength(2);
    expect(recordChangeEvent).toHaveBeenCalledTimes(2);
  });

  it("異なる unknown create を並べても各 thread の retry ID を保持する", async () => {
    mock(createPlotThread)
      .mockRejectedValueOnce(unknownCreateError("plot_thread_create"))
      .mockRejectedValueOnce(unknownCreateError("plot_thread_create"))
      .mockImplementationOnce(async (data) =>
        attachCreateResultMetadata(row(data.id!, data.sortOrder), {
          __idempotency: { replayed: true, entityPresent: true },
        }),
      );

    await expect(
      usePlotThreadStore.getState().addThread("p1", "thread-a"),
    ).rejects.toBeInstanceOf(IpcInvokeError);
    await expect(
      usePlotThreadStore.getState().addThread("p1", "thread-b"),
    ).rejects.toBeInstanceOf(IpcInvokeError);
    await usePlotThreadStore.getState().addThread("p1", "thread-a");

    const [threadA] = mock(createPlotThread).mock.calls[0];
    const [threadB] = mock(createPlotThread).mock.calls[1];
    const [threadARetry] = mock(createPlotThread).mock.calls[2];
    expect(threadARetry).toEqual(threadA);
    expect(threadB.id).not.toBe(threadA.id);
  });

  it("addBranch は自己参照(from===to)を弾く", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t1",
      atNodeId: "s1",
      kind: "branch",
    });
    expect(createPlotThreadBranch).not.toHaveBeenCalled();
    expect(usePlotThreadStore.getState().branches).toHaveLength(0);
  });

  it("addBranch は未知スレッド(別 project 等)を弾く", async () => {
    usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "ghost", // store に無い
      atNodeId: "s1",
      kind: "branch",
    });
    expect(createPlotThreadBranch).not.toHaveBeenCalled();
  });

  it("addBranch は同一(from,to,atNode,kind)の重複を弾く", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1")],
      branches: [branchRow("br1", "t1", "t2")], // atNode=s1, kind=branch
    });
    await usePlotThreadStore.getState().addBranch({
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch",
    });
    expect(createPlotThreadBranch).not.toHaveBeenCalled();
    expect(usePlotThreadStore.getState().branches).toHaveLength(1);
  });

  it("updateBranch が branches を楽観更新する（at_node・付け替え）", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1"), row("t3", "a2")],
      branches: [branchRow("br1", "t1", "t2")],
    });
    await usePlotThreadStore
      .getState()
      .updateBranch("br1", { toThreadId: "t3", atNodeId: "s9" });
    const b = usePlotThreadStore.getState().branches[0];
    expect(b.toThreadId).toBe("t3");
    expect(b.atNodeId).toBe("s9");
  });

  it("deleteBranch が branches から除外する", async () => {
    usePlotThreadStore.setState({
      branches: [branchRow("br1"), branchRow("br2")],
    });
    await usePlotThreadStore.getState().deleteBranch("br1");
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br2",
    ]);
  });

  it("deleteThread が from/to に絡む branch も除外する（CASCADE 反映）", async () => {
    usePlotThreadStore.setState({
      threads: [row("t1", "a0"), row("t2", "a1"), row("t3", "a2")],
      branches: [
        branchRow("br1", "t1", "t2"), // t1 が from → 消える
        branchRow("br2", "t3", "t1"), // t1 が to → 消える
        branchRow("br3", "t2", "t3"), // t1 無関係 → 残る
      ],
    });
    await usePlotThreadStore.getState().deleteThread("t1");
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br3",
    ]);
  });

  it("deleteMarker がアンカー側エッジをカスケード削除する（#4）", async () => {
    // br1 = branch(t2→t1)@s1。アンカー側 = to = t1。t1@s1 のマーカー削除で消える。
    usePlotThreadStore.setState({
      links: [linkRow("m1")], // t1 / s1
      branches: [branchRow("br1", "t2", "t1"), branchRow("br2", "t2", "t3")],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "p1",
        link: expect.objectContaining({ id: "m1" }),
        branches: [expect.objectContaining({ id: "br1" })],
        requestId: expect.any(String),
      }),
    );
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br2",
    ]);
    expect(usePlotThreadStore.getState().links).toHaveLength(0);
  });

  it("deleteMarker は非アンカー側マーカーの削除ではエッジを残す", async () => {
    // br1 = branch(t1→t2)@s1。アンカー側 = to = t2。from 側(t1)のマーカー削除では消えない。
    usePlotThreadStore.setState({
      links: [linkRow("m1")], // t1 / s1（branch の from 側）
      branches: [branchRow("br1", "t1", "t2")],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({ id: "m1" }),
        branches: [],
      }),
    );
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br1",
    ]);
  });

  it("deleteMarker は同一(thread,scene)に別 phase が残るならエッジを残す（取り残し防止）", async () => {
    // m1/m2 とも t1@s1（別 phase）。br1 のアンカーは to=t1@s1。m1 を消しても m2 が残るので維持。
    usePlotThreadStore.setState({
      links: [linkRow("m1"), { ...linkRow("m2"), phaseType: "turn" }],
      branches: [branchRow("br1", "t2", "t1")],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({ id: "m1" }),
        branches: [],
      }),
    );
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br1",
    ]);
  });

  it("deleteMarker は merge も to 側マーカーでカスケード削除する（統一アンカー）", async () => {
    // br1 = merge(t2→t1)@s1。統一モデルでアンカー = to = t1。t1@s1 のマーカー削除で消える。
    usePlotThreadStore.setState({
      links: [linkRow("m1")], // t1 / s1
      branches: [{ ...branchRow("br1", "t2", "t1"), kind: "merge" }],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({ id: "m1" }),
        branches: [expect.objectContaining({ id: "br1" })],
      }),
    );
    expect(usePlotThreadStore.getState().branches).toHaveLength(0);
  });

  it("deleteMarker は merge の from 側マーカー削除ではエッジを残す（統一アンカー）", async () => {
    // br1 = merge(t1→t2)@s1。アンカー = to = t2。from 側(t1)のマーカー削除では消えない。
    usePlotThreadStore.setState({
      links: [linkRow("m1")], // t1 / s1（merge の from 側）
      branches: [{ ...branchRow("br1", "t1", "t2"), kind: "merge" }],
    });
    await usePlotThreadStore.getState().deleteMarker("m1");
    expect(deletePlotThreadSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        link: expect.objectContaining({ id: "m1" }),
        branches: [],
      }),
    );
    expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
      "br1",
    ]);
  });

  // ───────────────────────── Undo / Redo wiring ─────────────────────────
  describe("Undo/Redo (globalHistoryStore wiring)", () => {
    const history = () => useGlobalHistoryStore.getState();

    it("addMarker pushes an undoable entry; undo deletes, redo restores", async () => {
      usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
      mock(createPlotThreadLink).mockResolvedValue(linkRow("l1"));
      await usePlotThreadStore.getState().addMarker("t1", "s1", "develop");
      expect(history().canUndo).toBe(true);
      expect(history().past).toHaveLength(1);

      await history().undo();
      expect(deletePlotThreadLink).toHaveBeenCalledWith("l1");
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
      expect(history().canRedo).toBe(true);

      await history().redo();
      expect(restorePlotThreadSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          thread: null,
          links: [expect.objectContaining({ id: "l1" })],
          branches: [],
          requestId: expect.any(String),
        }),
      );
      expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
        "l1",
      ]);
    });

    it("updateMarker undo restores the previous fields; redo re-applies", async () => {
      usePlotThreadStore.setState({ links: [linkRow("l1")] }); // phaseType=develop
      await usePlotThreadStore
        .getState()
        .updateMarker("l1", { phaseType: "climax" });
      expect(usePlotThreadStore.getState().links[0].phaseType).toBe("climax");
      expect(history().canUndo).toBe(true);

      await history().undo();
      expect(updatePlotThreadLink).toHaveBeenLastCalledWith("l1", {
        phaseType: "develop",
      });
      expect(usePlotThreadStore.getState().links[0].phaseType).toBe("develop");

      await history().redo();
      expect(usePlotThreadStore.getState().links[0].phaseType).toBe("climax");
    });

    it("deleteMarker undo restores the link AND its cascaded branch", async () => {
      // br1 = branch(t2→t1)@s1。アンカー側 to=t1 → deleteMarker で消える。
      usePlotThreadStore.setState({
        links: [linkRow("m1")], // t1 / s1
        branches: [branchRow("br1", "t2", "t1")],
      });
      await usePlotThreadStore.getState().deleteMarker("m1");
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);
      expect(history().canUndo).toBe(true);

      await history().undo();
      expect(restorePlotThreadSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          thread: null,
          links: [expect.objectContaining({ id: "m1" })],
          branches: [expect.objectContaining({ id: "br1" })],
          requestId: expect.any(String),
        }),
      );
      expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
        "m1",
      ]);
      expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
        "br1",
      ]);

      await history().redo();
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);
    });

    it("addBranch undo deletes the branch; redo restores it", async () => {
      usePlotThreadStore.setState({
        threads: [row("t1", "a0"), row("t2", "a1")],
      });
      mock(createPlotThreadBranch).mockResolvedValue(branchRow("br1"));
      await usePlotThreadStore.getState().addBranch({
        projectId: "p1",
        fromThreadId: "t1",
        toThreadId: "t2",
        atNodeId: "s1",
        kind: "branch",
      });
      expect(history().canUndo).toBe(true);

      await history().undo();
      expect(deletePlotThreadBranch).toHaveBeenCalledWith("br1");
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);

      await history().redo();
      expect(restorePlotThreadSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          thread: null,
          links: [],
          branches: [expect.objectContaining({ id: "br1" })],
          requestId: expect.any(String),
        }),
      );
      expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
        "br1",
      ]);
    });

    it("addBranch that is rejected (dup/self) does NOT push history", async () => {
      usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
      await usePlotThreadStore.getState().addBranch({
        projectId: "p1",
        fromThreadId: "t1",
        toThreadId: "t1", // self → rejected
        atNodeId: "s1",
        kind: "branch",
      });
      expect(history().canUndo).toBe(false);
    });

    it("updateBranch undo restores previous endpoints; redo re-applies", async () => {
      usePlotThreadStore.setState({
        threads: [row("t1", "a0"), row("t2", "a1"), row("t3", "a2")],
        branches: [branchRow("br1", "t1", "t2")],
      });
      await usePlotThreadStore
        .getState()
        .updateBranch("br1", { toThreadId: "t3", atNodeId: "s9" });
      expect(usePlotThreadStore.getState().branches[0].toThreadId).toBe("t3");

      await history().undo();
      const restored = usePlotThreadStore.getState().branches[0];
      expect(restored.toThreadId).toBe("t2");
      expect(restored.atNodeId).toBe("s1");

      await history().redo();
      expect(usePlotThreadStore.getState().branches[0].toThreadId).toBe("t3");
    });

    it("deleteBranch undo restores it; redo deletes again", async () => {
      usePlotThreadStore.setState({ branches: [branchRow("br1")] });
      await usePlotThreadStore.getState().deleteBranch("br1");
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);

      await history().undo();
      expect(restorePlotThreadSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          thread: null,
          links: [],
          branches: [expect.objectContaining({ id: "br1" })],
          requestId: expect.any(String),
        }),
      );
      expect(usePlotThreadStore.getState().branches.map((b) => b.id)).toEqual([
        "br1",
      ]);

      await history().redo();
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);
    });

    it("addThread undo deletes; redo restores with the same id", async () => {
      mock(createPlotThread).mockImplementation(
        async (data: { sortOrder: string }) => row("t1", data.sortOrder),
      );
      await usePlotThreadStore.getState().addThread("p1", "first");
      expect(history().canUndo).toBe(true);

      await history().undo();
      expect(deletePlotThread).toHaveBeenCalledWith("t1");
      expect(usePlotThreadStore.getState().threads).toHaveLength(0);

      await history().redo();
      expect(restorePlotThreadSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          thread: expect.objectContaining({ id: "t1" }),
          links: [],
          branches: [],
          requestId: expect.any(String),
        }),
      );
      expect(usePlotThreadStore.getState().threads.map((t) => t.id)).toEqual([
        "t1",
      ]);
    });

    it("restore unknown keeps the history command and requestId; later deliberate cycles use fresh IDs", async () => {
      await usePlotThreadStore.getState().addThread("p1", "retry restore");
      await history().undo();
      mock(restorePlotThreadSnapshot)
        .mockRejectedValueOnce(
          unknownCreateError("plot_thread_restore_snapshot"),
        )
        .mockImplementation(async (payload) => ({
          id: payload.requestId,
          thread: payload.thread ?? null,
          links: payload.links ?? [],
          branches: payload.branches ?? [],
        }));

      await expect(history().redo()).rejects.toBeInstanceOf(IpcInvokeError);
      expect(history().future).toHaveLength(1);
      expect(history().past).toHaveLength(0);
      expect(history().isReplaying).toBe(false);
      const firstRequestId = mock(restorePlotThreadSnapshot).mock.calls[0][0]
        .requestId;

      await history().redo();
      const retryRequestId = mock(restorePlotThreadSnapshot).mock.calls[1][0]
        .requestId;
      expect(retryRequestId).toBe(firstRequestId);
      expect(history().past).toHaveLength(1);

      await history().undo();
      await history().redo();
      const nextCycleRequestId = mock(restorePlotThreadSnapshot).mock
        .calls[2][0].requestId;
      expect(nextCycleRequestId).not.toBe(firstRequestId);
    });

    it("marker delete unknown reuses one request and redo cycles use fresh delete request IDs", async () => {
      usePlotThreadStore.setState({
        links: [linkRow("m1")],
        branches: [branchRow("br1", "t2", "t1")],
      });
      mock(deletePlotThreadSnapshot)
        .mockRejectedValueOnce(
          unknownCreateError("plot_thread_delete_snapshot"),
        )
        .mockImplementation(async (payload) => ({
          id: payload.requestId,
          deleted: true,
        }));

      await expect(
        usePlotThreadStore.getState().deleteMarker("m1"),
      ).rejects.toBeInstanceOf(IpcInvokeError);
      expect(usePlotThreadStore.getState().links).toHaveLength(1);
      expect(history().past).toHaveLength(0);

      await usePlotThreadStore.getState().deleteMarker("m1");
      const initialRequestId = mock(deletePlotThreadSnapshot).mock.calls[0][0]
        .requestId;
      expect(mock(deletePlotThreadSnapshot).mock.calls[1][0].requestId).toBe(
        initialRequestId,
      );
      expect(history().past).toHaveLength(1);

      await history().undo();
      await history().redo();
      const firstRedoRequestId = mock(deletePlotThreadSnapshot).mock.calls[2][0]
        .requestId;
      expect(firstRedoRequestId).not.toBe(initialRequestId);

      await history().undo();
      await history().redo();
      const nextRedoRequestId = mock(deletePlotThreadSnapshot).mock.calls[3][0]
        .requestId;
      expect(nextRedoRequestId).not.toBe(firstRedoRequestId);
    });

    it("renameThread undo restores the previous name; redo re-applies", async () => {
      usePlotThreadStore.setState({ threads: [row("t1", "a0")] }); // name="t1"
      await usePlotThreadStore.getState().renameThread("t1", "renamed");
      expect(usePlotThreadStore.getState().threads[0].name).toBe("renamed");

      await history().undo();
      expect(updatePlotThread).toHaveBeenLastCalledWith("t1", { name: "t1" });
      expect(usePlotThreadStore.getState().threads[0].name).toBe("t1");

      await history().redo();
      expect(usePlotThreadStore.getState().threads[0].name).toBe("renamed");
    });

    it("setThreadColor undo restores the previous color", async () => {
      usePlotThreadStore.setState({ threads: [row("t1", "a0")] }); // color=null
      await usePlotThreadStore.getState().setThreadColor("t1", "#abc");
      expect(usePlotThreadStore.getState().threads[0].color).toBe("#abc");

      await history().undo();
      expect(usePlotThreadStore.getState().threads[0].color).toBeNull();
    });

    it("deleteThread undo restores thread + its links + its branches (CASCADE)", async () => {
      usePlotThreadStore.setState({
        threads: [row("t1", "a0"), row("t2", "a1")],
        links: [linkRow("l1")], // threadId=t1
        branches: [
          branchRow("br1", "t1", "t2"), // t1 from → cascaded
          branchRow("br2", "t2", "t1"), // t1 to   → cascaded
        ],
      });
      await usePlotThreadStore.getState().deleteThread("t1");
      expect(usePlotThreadStore.getState().threads.map((t) => t.id)).toEqual([
        "t2",
      ]);
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);

      await history().undo();
      expect(restorePlotThreadSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "p1",
          thread: expect.objectContaining({ id: "t1" }),
          links: [expect.objectContaining({ id: "l1" })],
          branches: expect.arrayContaining([
            expect.objectContaining({ id: "br1" }),
            expect.objectContaining({ id: "br2" }),
          ]),
          requestId: expect.any(String),
        }),
      );
      expect(
        usePlotThreadStore
          .getState()
          .threads.map((t) => t.id)
          .sort(),
      ).toEqual(["t1", "t2"]);
      expect(usePlotThreadStore.getState().links.map((l) => l.id)).toEqual([
        "l1",
      ]);
      expect(
        usePlotThreadStore
          .getState()
          .branches.map((b) => b.id)
          .sort(),
      ).toEqual(["br1", "br2"]);
    });

    it("compound marker drag uses one atomic API call for apply, undo, and redo", async () => {
      usePlotThreadStore.setState({
        threads: [row("t1", "a0"), row("t2", "a1")],
        links: [linkRow("l1")],
        branches: [],
      });
      await usePlotThreadStore.getState().moveMarkerBundle({
        markerId: "l1",
        markerPatch: { threadId: "t2", nodeId: "s2" },
        branchCreates: [
          {
            fromThreadId: "t1",
            toThreadId: "t2",
            atNodeId: "s2",
            kind: "branch",
          },
        ],
      });

      expect(movePlotMarkerBundle).toHaveBeenCalledTimes(1);
      const applied = mock(movePlotMarkerBundle).mock.calls[0][0];
      expect(applied).toMatchObject({
        requestId: expect.any(String),
        projectId: "p1",
        markerBefore: { id: "l1", threadId: "t1", nodeId: "s1" },
        markerAfter: { id: "l1", threadId: "t2", nodeId: "s2" },
        branchTransitions: [
          {
            before: null,
            after: {
              id: expect.any(String),
              fromThreadId: "t1",
              toThreadId: "t2",
              atNodeId: "s2",
            },
          },
        ],
      });
      expect(history().past).toHaveLength(1);
      expect(usePlotThreadStore.getState().links[0].threadId).toBe("t2");
      expect(usePlotThreadStore.getState().branches).toHaveLength(1);

      await history().undo();
      expect(movePlotMarkerBundle).toHaveBeenCalledTimes(2);
      expect(mock(movePlotMarkerBundle).mock.calls[1][0]).toMatchObject({
        markerBefore: { threadId: "t2", nodeId: "s2" },
        markerAfter: { threadId: "t1", nodeId: "s1" },
        branchTransitions: [
          {
            before: { id: applied.branchTransitions[0].after.id },
            after: null,
          },
        ],
      });
      expect(usePlotThreadStore.getState().links[0].threadId).toBe("t1");
      expect(usePlotThreadStore.getState().links[0].nodeId).toBe("s1");
      expect(usePlotThreadStore.getState().branches).toHaveLength(0);

      await history().redo();
      expect(movePlotMarkerBundle).toHaveBeenCalledTimes(3);
      expect(usePlotThreadStore.getState().links[0].threadId).toBe("t2");
      expect(usePlotThreadStore.getState().branches).toHaveLength(1);
    });

    it("does not publish partial marker state or history when the atomic API fails", async () => {
      usePlotThreadStore.setState({
        threads: [row("t1", "a0"), row("t2", "a1")],
        links: [linkRow("l1")],
        branches: [],
      });
      mock(movePlotMarkerBundle).mockRejectedValueOnce(
        new Error("branch insert failed"),
      );

      await expect(
        usePlotThreadStore.getState().moveMarkerBundle({
          markerId: "l1",
          markerPatch: { threadId: "t2", nodeId: "s2" },
          branchCreates: [
            {
              fromThreadId: "t1",
              toThreadId: "t2",
              atNodeId: "s2",
              kind: "branch",
            },
          ],
        }),
      ).rejects.toThrow("branch insert failed");
      expect(usePlotThreadStore.getState().links[0]).toMatchObject({
        threadId: "t1",
        nodeId: "s1",
      });
      expect(usePlotThreadStore.getState().branches).toEqual([]);
      expect(history().past).toEqual([]);
    });

    it("reuses the exact atomic bundle after an unknown IPC outcome", async () => {
      usePlotThreadStore.setState({
        threads: [row("t1", "a0"), row("t2", "a1")],
        links: [linkRow("l1")],
        branches: [],
      });
      mock(movePlotMarkerBundle)
        .mockRejectedValueOnce(
          unknownCreateError("plot_thread_move_marker_bundle"),
        )
        .mockImplementationOnce(async (payload) => ({
          id: payload.requestId,
          marker: payload.markerAfter,
          branches: payload.branchTransitions.flatMap(
            (transition: { after: PlotThreadBranchRow | null }) =>
              transition.after ? [transition.after] : [],
          ),
          deletedBranchIds: [],
        }));
      const plan = {
        markerId: "l1",
        markerPatch: { threadId: "t2", nodeId: "s2" },
        branchCreates: [
          {
            fromThreadId: "t1",
            toThreadId: "t2",
            atNodeId: "s2",
            kind: "branch" as const,
          },
        ],
      };

      await expect(
        usePlotThreadStore.getState().moveMarkerBundle(plan),
      ).rejects.toBeInstanceOf(IpcInvokeError);
      const first = mock(movePlotMarkerBundle).mock.calls[0][0];
      await usePlotThreadStore.getState().moveMarkerBundle(plan);
      const retried = mock(movePlotMarkerBundle).mock.calls[1][0];
      expect(retried).toEqual(first);
    });

    it("importPlotThreads bulk-imports as a SINGLE undo (dedup + phase validation)", async () => {
      let threadSeq = 0;
      mock(createPlotThread).mockImplementation(
        async (data: {
          sortOrder: string;
          name: string;
          description?: string | null;
          projectId: string;
        }) => ({
          ...row(`th${++threadSeq}`, data.sortOrder),
          name: data.name,
          description: data.description ?? null,
        }),
      );
      let linkSeq = 0;
      mock(createPlotThreadLink).mockImplementation(
        async (data: {
          threadId: string;
          nodeId: string;
          phaseType: PlotPhaseType;
          note?: string | null;
        }) => ({
          id: `lk${++linkSeq}`,
          threadId: data.threadId,
          nodeId: data.nodeId,
          phaseType: data.phaseType,
          note: data.note ?? null,
          sortOrder: null,
          createdAt: "",
          updatedAt: "",
        }),
      );

      const result = await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", [
          {
            name: "Aの真実",
            markers: [
              { nodeId: "s1", phaseType: "introduce" },
              { nodeId: "s1", phaseType: "introduce" }, // 重複 → skip
              { nodeId: "s2", phaseType: "bogus" as PlotPhaseType }, // 不正 phase → skip
              { nodeId: "s3", phaseType: "climax" },
            ],
          },
          // name 空 → skip
          { name: "  ", markers: [{ nodeId: "s9", phaseType: "develop" }] },
        ]);

      const st = usePlotThreadStore.getState();
      expect(st.threads).toHaveLength(1);
      expect(st.threads[0].name).toBe("Aの真実");
      expect(st.links.map((l) => `${l.nodeId}:${l.phaseType}`)).toEqual([
        "s1:introduce",
        "s3:climax",
      ]);
      expect(result.createdThreads.map((thread) => thread.id)).toEqual(["th1"]);
      expect(result.createdMarkers.map((marker) => marker.id)).toEqual([
        "lk1",
        "lk2",
      ]);
      expect(result.skipped.map((issue) => issue.code)).toEqual([
        "DUPLICATE",
        "INVALID_PHASE",
        "INVALID_PROPOSAL",
      ]);
      expect(result.failed).toEqual([]);
      expect(result.aborted).toBe(false);
      // 取込全体で履歴エントリは 1 つ。
      expect(history().past).toHaveLength(1);

      await history().undo();
      expect(usePlotThreadStore.getState().threads).toHaveLength(0);
      expect(usePlotThreadStore.getState().links).toHaveLength(0);

      await history().redo();
      expect(usePlotThreadStore.getState().threads).toHaveLength(1);
      expect(usePlotThreadStore.getState().links).toHaveLength(2);
    });

    it("importPlotThreads forwards the per-proposal color to createPlotThread", async () => {
      const seenColors: Array<string | null | undefined> = [];
      mock(createPlotThread).mockImplementation(
        async (data: {
          sortOrder: string;
          name: string;
          color?: string | null;
        }) => {
          seenColors.push(data.color);
          return {
            ...row(`th-${seenColors.length}`, data.sortOrder),
            name: data.name,
          };
        },
      );

      await usePlotThreadStore.getState().importPlotThreads("p1", [
        {
          name: "Blue",
          color: "#2045AA",
          markers: [{ nodeId: "s1", phaseType: "introduce" }],
        },
        {
          name: "Red",
          color: "#AA2020",
          markers: [{ nodeId: "s2", phaseType: "introduce" }],
        },
        // color 未指定 → null にフォールバック
        { name: "Plain", markers: [{ nodeId: "s3", phaseType: "introduce" }] },
      ]);

      expect(seenColors).toEqual(["#2045AA", "#AA2020", null]);
    });

    it("importPlotThreads は unknown thread retry で同じ ID と payload を再利用する", async () => {
      mock(createPlotThread)
        .mockRejectedValueOnce(unknownCreateError("plot_thread_create"))
        .mockImplementationOnce(async (data) =>
          attachCreateResultMetadata(
            {
              ...row(data.id!, data.sortOrder),
              name: data.name,
            },
            {
              __idempotency: { replayed: true, entityPresent: true },
            },
          ),
        );
      const proposals = [
        {
          name: "Retry thread",
          markers: [{ nodeId: "s1", phaseType: "introduce" as const }],
        },
      ];

      const failed = await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", proposals);
      const retried = await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", proposals);

      expect(failed.failed.map(({ kind }) => kind)).toEqual(["thread"]);
      expect(retried.failed).toEqual([]);
      const [firstPayload] = mock(createPlotThread).mock.calls[0];
      const [retryPayload] = mock(createPlotThread).mock.calls[1];
      expect(retryPayload).toEqual(firstPayload);
      expect(usePlotThreadStore.getState().threads).toHaveLength(1);
      expect(useGlobalHistoryStore.getState().past).toHaveLength(1);

      await useGlobalHistoryStore.getState().undo();
      expect(usePlotThreadStore.getState().threads).toHaveLength(0);
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
    });

    it("partial import の unknown marker retry は作成済み thread と同じ link ID を再利用する", async () => {
      mock(createPlotThreadLink)
        .mockRejectedValueOnce(unknownCreateError("plot_thread_link_create"))
        .mockImplementationOnce(async (data) =>
          attachCreateResultMetadata(
            {
              ...linkRow(data.id!),
              threadId: data.threadId,
              nodeId: data.nodeId,
              phaseType: data.phaseType,
            },
            {
              __idempotency: { replayed: true, entityPresent: true },
            },
          ),
        );
      const proposals = [
        {
          name: "Partial thread",
          markers: [{ nodeId: "s1", phaseType: "develop" as const }],
        },
      ];

      const partial = await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", proposals);
      const retried = await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", proposals);

      expect(partial.failed.map(({ kind }) => kind)).toEqual(["marker"]);
      expect(retried.failed).toEqual([]);
      expect(mock(createPlotThread)).toHaveBeenCalledTimes(1);
      const [firstPayload] = mock(createPlotThreadLink).mock.calls[0];
      const [retryPayload] = mock(createPlotThreadLink).mock.calls[1];
      expect(retryPayload).toEqual(firstPayload);
      expect(usePlotThreadStore.getState().threads).toHaveLength(1);
      expect(usePlotThreadStore.getState().links).toHaveLength(1);
      expect(useGlobalHistoryStore.getState().past).toHaveLength(2);

      await useGlobalHistoryStore.getState().undo();
      expect(usePlotThreadStore.getState().threads).toHaveLength(1);
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
      await useGlobalHistoryStore.getState().undo();
      expect(usePlotThreadStore.getState().threads).toHaveLength(0);
    });

    it("multi-proposal partial retry は成功済み proposal を重複作成しない", async () => {
      mock(createPlotThread)
        .mockImplementationOnce(async (data) => ({
          ...row(data.id!, data.sortOrder),
          name: data.name,
          color: data.color ?? null,
        }))
        .mockRejectedValueOnce(unknownCreateError("plot_thread_create"))
        .mockImplementationOnce(async (data) =>
          attachCreateResultMetadata(
            {
              ...row(data.id!, data.sortOrder),
              name: data.name,
              color: data.color ?? null,
            },
            {
              __idempotency: { replayed: true, entityPresent: true },
            },
          ),
        );
      const proposals = [
        {
          retryKey: "candidate-a",
          name: "Already completed",
          color: "#111111",
          markers: [{ nodeId: "s1", phaseType: "introduce" as const }],
        },
        {
          retryKey: "candidate-b",
          name: "Unknown response",
          color: "#222222",
          markers: [{ nodeId: "s2", phaseType: "develop" as const }],
        },
      ];

      const partial = await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", proposals);
      const retried = await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", proposals);

      expect(partial.failed).toEqual([
        expect.objectContaining({ kind: "thread", proposalIndex: 1 }),
      ]);
      expect(retried.failed).toEqual([]);
      expect(retried.skipped).toEqual([]);
      expect(mock(createPlotThread)).toHaveBeenCalledTimes(3);
      const [failedPayload] = mock(createPlotThread).mock.calls[1];
      const [retryPayload] = mock(createPlotThread).mock.calls[2];
      expect(retryPayload).toEqual(failedPayload);
      expect(
        usePlotThreadStore
          .getState()
          .threads.map(({ name }) => name)
          .sort(),
      ).toEqual(["Already completed", "Unknown response"]);
      expect(usePlotThreadStore.getState().links).toHaveLength(2);
      expect(useGlobalHistoryStore.getState().past).toHaveLength(2);

      await useGlobalHistoryStore.getState().undo();
      await useGlobalHistoryStore.getState().undo();
      expect(usePlotThreadStore.getState().threads).toHaveLength(0);
      expect(usePlotThreadStore.getState().links).toHaveLength(0);
    });

    it("importPlotThreads drops the composite undo when the project switches mid-import (XPROJ)", async () => {
      mock(createPlotThread).mockImplementation(
        async (data: { sortOrder: string; name: string }) => ({
          ...row("th-x", data.sortOrder),
          name: data.name,
        }),
      );
      // 最初のリンク作成中にプロジェクト切替（reloadProjectData 相当）が起きる。
      mock(createPlotThreadLink).mockImplementation(
        async (data: {
          threadId: string;
          nodeId: string;
          phaseType: PlotPhaseType;
        }) => {
          currentProject.value = "p2";
          return {
            id: "lkx",
            threadId: data.threadId,
            nodeId: data.nodeId,
            phaseType: data.phaseType,
            note: null,
            sortOrder: null,
            createdAt: "",
            updatedAt: "",
          };
        },
      );

      const result = await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", [
          { name: "A", markers: [{ nodeId: "s1", phaseType: "introduce" }] },
        ]);

      // 旧プロジェクトの行を参照する合成エントリは新プロジェクト履歴へ commit されない。
      expect(history().past).toHaveLength(0);
      expect(result.aborted).toBe(true);
    });

    it("importPlotThreads reports partial persistence without claiming failed items", async () => {
      let threadSeq = 0;
      mock(createPlotThread).mockImplementation(
        async (data: { sortOrder: string; name: string }) => {
          if (data.name === "broken thread") throw new Error("sensitive db");
          return {
            ...row(`th${++threadSeq}`, data.sortOrder),
            name: data.name,
          };
        },
      );
      mock(createPlotThreadLink).mockImplementation(
        async (data: {
          threadId: string;
          nodeId: string;
          phaseType: PlotPhaseType;
        }) => {
          if (data.nodeId === "broken-scene") throw new Error("raw sql");
          return {
            ...linkRow(`lk-${data.nodeId}`),
            threadId: data.threadId,
            nodeId: data.nodeId,
            phaseType: data.phaseType,
          };
        },
      );

      const result = await usePlotThreadStore
        .getState()
        .importPlotThreads("p1", [
          {
            name: "partial",
            markers: [
              { nodeId: "ok-scene", phaseType: "introduce" },
              { nodeId: "broken-scene", phaseType: "develop" },
            ],
          },
          {
            name: "broken thread",
            markers: [{ nodeId: "unused", phaseType: "turn" }],
          },
        ]);

      expect(result.createdThreads).toHaveLength(1);
      expect(result.createdMarkers).toHaveLength(1);
      expect(result.failed).toEqual([
        {
          kind: "marker",
          proposalIndex: 0,
          markerIndex: 1,
          label: "broken-scene",
          code: "CREATE_FAILED",
        },
        {
          kind: "thread",
          proposalIndex: 1,
          label: "broken thread",
          code: "CREATE_FAILED",
        },
      ]);
      expect(JSON.stringify(result)).not.toContain("raw sql");
      expect(JSON.stringify(result)).not.toContain("sensitive db");
      expect(history().past).toHaveLength(1);
    });

    it("does not push a second entry while replaying (undo closures use the API directly)", async () => {
      usePlotThreadStore.setState({ threads: [row("t1", "a0")] });
      mock(createPlotThreadLink).mockResolvedValue(linkRow("l1"));
      await usePlotThreadStore.getState().addMarker("t1", "s1", "develop");
      await history().undo();
      // After undo, the entry is in `future`, NOT re-pushed onto `past`.
      expect(history().past).toHaveLength(0);
      expect(history().future).toHaveLength(1);
    });
  });
});
