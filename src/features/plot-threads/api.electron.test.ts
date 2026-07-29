// @vitest-environment happy-dom
/**
 * plot-threads api の Electron 分岐（Electron 移行 Phase 3 バッチ1）。
 *
 * 従来 `isTauri()` 単独ゲートだったため Electron は renderer 直 Drizzle 分岐に
 * 落ち、link_create / link_update の XPROJ ガードを素通ししていた。ゲートを
 * `isTauri() || isElectron()` へ広げた結果、Electron では napi コマンドへ invoke
 * するようになる（= サーバサイドの XPROJ / phase_type 検証が効く）ことを gate する。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const invoke = vi.fn();
vi.mock("@/lib/tauri", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tauri")>();
  return {
    ...actual,
    invoke: (...args: unknown[]) => invoke(...args),
    isTauri: () => false,
  };
});

import { IpcInvokeError } from "@/lib/tauri";
import {
  createPlotThread,
  createPlotThreadLink,
  createPlotThreadBranch,
  restorePlotThreadSnapshot,
  deletePlotThreadSnapshot,
  listPlotThreads,
  deletePlotThread,
} from "./api";
import { getCreateResultMetadata } from "@/lib/createResultMetadata";

beforeEach(() => {
  invoke.mockReset();
  // Electron マーカー（nativeBackend の inline "grimodex" in window 判定）。
  // isTauri()=false のため、これで invoke（napi）パスに載る。
  (window as unknown as Record<string, unknown>).grimodex = {
    shell: "electron",
  };
});
afterEach(() => {
  delete (window as unknown as Record<string, unknown>).grimodex;
});

describe("plot-threads api は Electron でネイティブ backend (napi) へ invoke する", () => {
  it("createPlotThread は plot_thread_create を invoke（Drizzle 分岐に落ちない）", async () => {
    invoke.mockResolvedValue({
      id: "pt1",
      project_id: "p1",
      name: "糸",
      sort_order: "a0",
    });
    const row = await createPlotThread({
      id: "pt1",
      projectId: "p1",
      name: "糸",
      sortOrder: "a0",
    });
    expect(invoke).toHaveBeenCalledWith("plot_thread_create", {
      payload: {
        id: "pt1",
        projectId: "p1",
        name: "糸",
        color: null,
        description: null,
        sortOrder: "a0",
      },
    });
    // 生行 snake_case を normalize して返す。
    expect(row.projectId).toBe("p1");
  });

  it("createPlotThreadLink は XPROJ ガードの効く plot_thread_link_create を invoke", async () => {
    invoke.mockResolvedValue({
      id: "pl1",
      thread_id: "t1",
      node_id: "s1",
      phase_type: "introduce",
    });
    await createPlotThreadLink({
      id: "pl1",
      threadId: "t1",
      nodeId: "s1",
      phaseType: "introduce",
    });
    expect(invoke).toHaveBeenCalledWith("plot_thread_link_create", {
      payload: {
        id: "pl1",
        threadId: "t1",
        nodeId: "s1",
        phaseType: "introduce",
        note: null,
        sortOrder: null,
      },
    });
  });

  it("createPlotThreadBranch は native transaction route を使い replay metadata を保持する", async () => {
    invoke.mockResolvedValue({
      id: "pb1",
      project_id: "p1",
      from_thread_id: "t1",
      to_thread_id: "t2",
      at_node_id: "s1",
      kind: "branch",
      __idempotency: { replayed: true, entityPresent: false },
    });

    const row = await createPlotThreadBranch({
      id: "pb1",
      projectId: "p1",
      fromThreadId: "t1",
      toThreadId: "t2",
      atNodeId: "s1",
      kind: "branch",
    });

    expect(invoke).toHaveBeenCalledWith("plot_thread_branch_create", {
      payload: {
        id: "pb1",
        projectId: "p1",
        fromThreadId: "t1",
        toThreadId: "t2",
        atNodeId: "s1",
        kind: "branch",
      },
    });
    expect(getCreateResultMetadata(row)).toEqual({
      replayed: true,
      entityPresent: false,
    });
  });

  it("create timeout exposes the reusable domain request ID without claiming failure", async () => {
    invoke.mockRejectedValue(
      new IpcInvokeError("plot_thread_create", {
        code: "IPC_TIMEOUT",
        message: "IPC timeout after 10000ms: plot_thread_create",
        retryable: false,
        outcome: "unknown",
      }),
    );

    const error = await createPlotThread({
      id: "request-1",
      projectId: "p1",
      name: "retryable identity",
      sortOrder: "a0",
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IpcInvokeError);
    expect((error as IpcInvokeError).outcome).toBe("unknown");
    expect((error as IpcInvokeError).retryable).toBe(true);
    expect((error as IpcInvokeError).details).toMatchObject({
      requestId: "request-1",
      idempotencyDomain: "plot-thread-create",
    });
  });

  it("atomic restore/delete snapshot commands preserve payload and replay metadata", async () => {
    invoke
      .mockResolvedValueOnce({
        id: "restore-1",
        thread: {
          id: "pt1",
          project_id: "p1",
          name: "thread",
          sort_order: "a0",
          start_node_id: null,
          end_node_id: null,
          created_at: "2026-01-01T00:00:00.000Z",
          updated_at: "2026-01-02T00:00:00.000Z",
        },
        links: [],
        branches: [],
        __idempotency: { replayed: true, entityPresent: true },
      })
      .mockResolvedValueOnce({
        id: "delete-1",
        deleted: true,
        __idempotency: { replayed: false, entityPresent: true },
      });
    const thread = {
      id: "pt1",
      projectId: "p1",
      name: "thread",
      color: null,
      description: null,
      sortOrder: "a0",
      startNodeId: null,
      endNodeId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    const link = {
      id: "link-1",
      threadId: "pt1",
      nodeId: "scene-1",
      phaseType: "turn" as const,
      note: "marker",
      sortOrder: "a0",
      createdAt: "2026-01-01T01:00:00.000Z",
      updatedAt: "2026-01-02T01:00:00.000Z",
    };
    const branch = {
      id: "branch-1",
      projectId: "p1",
      fromThreadId: "source",
      toThreadId: "pt1",
      atNodeId: "scene-1",
      kind: "branch" as const,
      createdAt: "2026-01-01T02:00:00.000Z",
      updatedAt: "2026-01-02T02:00:00.000Z",
    };

    const restored = await restorePlotThreadSnapshot({
      requestId: "restore-1",
      projectId: "p1",
      thread,
      links: [],
      branches: [],
    });
    const deleted = await deletePlotThreadSnapshot({
      requestId: "delete-1",
      projectId: "p1",
      link,
      branches: [branch],
    });

    expect(invoke).toHaveBeenNthCalledWith(1, "plot_thread_restore_snapshot", {
      payload: {
        requestId: "restore-1",
        projectId: "p1",
        thread,
        links: [],
        branches: [],
      },
    });
    expect(invoke).toHaveBeenNthCalledWith(2, "plot_thread_delete_snapshot", {
      payload: {
        requestId: "delete-1",
        projectId: "p1",
        link,
        branches: [branch],
      },
    });
    expect(restored.thread?.projectId).toBe("p1");
    expect(getCreateResultMetadata(restored)).toEqual({
      replayed: true,
      entityPresent: true,
    });
    expect(deleted.deleted).toBe(true);
  });

  it("snapshot unknown outcome exposes the exact reusable requestId", async () => {
    invoke.mockRejectedValue(
      new IpcInvokeError("plot_thread_restore_snapshot", {
        code: "IPC_TIMEOUT",
        message: "unknown restore",
        retryable: false,
        outcome: "unknown",
      }),
    );
    const error = await restorePlotThreadSnapshot({
      requestId: "restore-request",
      projectId: "p1",
      thread: null,
      links: [
        {
          id: "link",
          threadId: "thread",
          nodeId: "scene",
          phaseType: "turn",
          note: null,
          sortOrder: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
      ],
      branches: [],
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IpcInvokeError);
    expect((error as IpcInvokeError).details).toMatchObject({
      requestId: "restore-request",
      idempotencyDomain: "plot-thread-restore-snapshot",
    });
  });

  it("listPlotThreads は plot_thread_list を invoke し normalize する", async () => {
    invoke.mockResolvedValue([
      { id: "pt1", project_id: "p1", name: "糸", sort_order: "a0" },
    ]);
    const rows = await listPlotThreads("p1");
    expect(invoke).toHaveBeenCalledWith("plot_thread_list", {
      projectId: "p1",
    });
    expect(rows[0].projectId).toBe("p1");
  });

  it("deletePlotThread は plot_thread_delete を invoke する", async () => {
    invoke.mockResolvedValue(null);
    await deletePlotThread("pt1");
    expect(invoke).toHaveBeenCalledWith("plot_thread_delete", { id: "pt1" });
  });
});
