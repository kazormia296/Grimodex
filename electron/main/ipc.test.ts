import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Envelope, NapiBackendLike } from "../shared/ipcContract.js";
import { IPC } from "../shared/ipcContract.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (
      event: { sender: unknown },
      cmd: unknown,
      args: unknown,
    ) => Promise<Envelope>
  >(),
  buildShellCommandHandlers: vi.fn(() => ({})),
  registerShellBridgeHandlers: vi.fn(),
  focusPanelWindow: vi.fn(),
  hasPanelWindow: vi.fn(),
  openPanelWindow: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: vi.fn(() => null),
  },
  ipcMain: {
    handle: (
      channel: string,
      handler: (
        event: { sender: unknown },
        cmd: unknown,
        args: unknown,
      ) => Promise<Envelope>,
    ) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));

vi.mock("./shellCommands.js", () => ({
  buildShellCommandHandlers: mocks.buildShellCommandHandlers,
  registerShellBridgeHandlers: mocks.registerShellBridgeHandlers,
}));

vi.mock("./windows.js", () => ({
  focusPanelWindow: mocks.focusPanelWindow,
  hasPanelWindow: mocks.hasPanelWindow,
  openPanelWindow: mocks.openPanelWindow,
}));

const { registerIpcRouter } = await import("./ipc.js");

function invokeHandler(): (
  event: { sender: unknown },
  cmd: unknown,
  args: unknown,
) => Promise<Envelope> {
  const handler = mocks.handlers.get(IPC.invoke);
  if (!handler) throw new Error("grim:invoke handler was not registered");
  return handler;
}

beforeEach(() => {
  mocks.handlers.clear();
  vi.clearAllMocks();
  delete process.env.GRIMODEX_WORKSPACE_OPEN_TRACE;
});

afterEach(() => {
  delete process.env.GRIMODEX_WORKSPACE_OPEN_TRACE;
  vi.restoreAllMocks();
});

describe("registerIpcRouter fail-soft logging", () => {
  it("injects the side-effect-free panel existence delegate", () => {
    registerIpcRouter(null);

    expect(mocks.registerShellBridgeHandlers).toHaveBeenCalledWith({
      open: mocks.openPanelWindow,
      focusByLabel: mocks.focusPanelWindow,
      existsByLabel: mocks.hasPanelWindow,
    });
  });

  it("does not copy an unimplemented renderer command into production logs", async () => {
    const sentinel = "SECRET_NOVEL_SENTINEL";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerIpcRouter(null);

    const envelope = await invokeHandler()({ sender: {} }, sentinel, {
      text: "private draft",
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: `IPC_UNIMPLEMENTED: ${sentinel}`,
    });
    expect(warn).toHaveBeenCalledWith("[grim:invoke] IPC_UNIMPLEMENTED");
    expect(warn.mock.calls.flat().join(" ")).not.toContain(sentinel);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("private draft");
    warn.mockRestore();
  });

  it("logs only a fixed outcome when the native backend is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    registerIpcRouter(null);

    const envelope = await invokeHandler()({ sender: {} }, "db_execute", {
      sql: "SECRET SQL",
      params: [],
      method: "all",
    });

    expect(envelope).toMatchObject({
      ok: false,
      error: "IPC_BACKEND_UNAVAILABLE: db_execute",
    });
    expect(warn).toHaveBeenCalledWith("[grim:invoke] IPC_BACKEND_UNAVAILABLE");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("db_execute");
    expect(warn.mock.calls.flat().join(" ")).not.toContain("SECRET SQL");
    warn.mockRestore();
  });
});

describe("registerIpcRouter workspace-open main trace", () => {
  function backendWithOpenWorkspace(
    openWorkspace: (path: string) => Promise<string>,
  ): NapiBackendLike {
    return { openWorkspace } as unknown as NapiBackendLike;
  }

  it("emits one safe success summary when the dev trace is enabled", async () => {
    process.env.GRIMODEX_WORKSPACE_OPEN_TRACE = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    registerIpcRouter(
      backendWithOpenWorkspace(async () =>
        JSON.stringify({
          name: "SECRET_WORKSPACE_NAME",
          isExisting: true,
          workspaceId: "SECRET_WORKSPACE_ID",
        }),
      ),
    );

    const envelope = await invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/secret/workspace/path",
    });

    expect(envelope.ok).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]?.[0]).toBe("[workspace-open-main]");
    const summary = info.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(summary).sort()).toEqual([
      "durationMs",
      "result",
      "version",
    ]);
    expect(summary).toMatchObject({ version: 1, result: "success" });
    expect(summary.durationMs).toEqual(expect.any(Number));
    expect(Number.isFinite(summary.durationMs)).toBe(true);
    expect(summary.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(info.mock.calls)).not.toMatch(
      /SECRET|\/secret\/workspace\/path/,
    );
  });

  it("emits one safe failure summary without copying the native error", async () => {
    process.env.GRIMODEX_WORKSPACE_OPEN_TRACE = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    registerIpcRouter(
      backendWithOpenWorkspace(async () => {
        throw new Error("SECRET_NATIVE_ERROR at /secret/workspace/path");
      }),
    );

    const envelope = await invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/secret/workspace/path",
    });

    expect(envelope.ok).toBe(false);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[workspace-open-main]",
      expect.objectContaining({
        version: 1,
        result: "failure",
        durationMs: expect.any(Number),
      }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toMatch(
      /SECRET|\/secret\/workspace\/path/,
    );
  });

  it("does not emit a summary when the dev trace is disabled", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    registerIpcRouter(
      backendWithOpenWorkspace(async () =>
        JSON.stringify({
          name: "workspace",
          isExisting: true,
          workspaceId: "workspace-id",
        }),
      ),
    );

    await invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/secret/workspace/path",
    });

    expect(info).not.toHaveBeenCalled();
  });

  it("emits one failure terminal when synchronous handler construction throws", async () => {
    process.env.GRIMODEX_WORKSPACE_OPEN_TRACE = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const constructionError = new Error("handler construction failed");
    registerIpcRouter(
      backendWithOpenWorkspace(async () => {
        throw new Error("backend must not be reached");
      }),
      () => {
        throw constructionError;
      },
    );

    await expect(
      invokeHandler()({ sender: {} }, "open_workspace", {
        path: "/secret/workspace/path",
      }),
    ).rejects.toBe(constructionError);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith(
      "[workspace-open-main]",
      expect.objectContaining({
        version: 1,
        result: "failure",
        durationMs: expect.any(Number),
      }),
    );
  });

  it("preserves the successful envelope when the trace logger throws", async () => {
    process.env.GRIMODEX_WORKSPACE_OPEN_TRACE = "1";
    const info = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("logger unavailable");
    });
    registerIpcRouter(
      backendWithOpenWorkspace(async () =>
        JSON.stringify({
          name: "workspace",
          isExisting: true,
          workspaceId: "workspace-id",
        }),
      ),
    );

    const envelope = await invokeHandler()({ sender: {} }, "open_workspace", {
      path: "/secret/workspace/path",
    });

    expect(envelope.ok).toBe(true);
    expect(info).toHaveBeenCalledTimes(1);
  });
});
