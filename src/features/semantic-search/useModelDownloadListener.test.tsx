// @vitest-environment happy-dom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runtime, listenMock, ensureMock, resetBackIndexMock, resetIndexMock } =
  vi.hoisted(() => ({
    runtime: {
      panelWindow: false,
      workspacePath: "/workspace/a" as string | null,
      projectId: "p1" as string | null,
      handler: null as ((payload: unknown) => void) | null,
    },
    listenMock: vi.fn(
      async (_event: string, handler: (payload: unknown) => void) => {
        runtime.handler = handler;
        return vi.fn();
      },
    ),
    ensureMock: vi.fn(() => Promise.resolve()),
    resetBackIndexMock: vi.fn(),
    resetIndexMock: vi.fn(),
  }));

vi.mock("@/lib/tauri", () => ({ listen: listenMock }));
vi.mock("@/features/layout/multiwindow/panelWindow", () => ({
  isPanelWindow: () => runtime.panelWindow,
}));
vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: {
    getState: () => ({ activeWorkspacePath: runtime.workspacePath }),
  },
}));
vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: {
    getState: () => ({ currentProjectId: runtime.projectId }),
  },
}));
vi.mock("./autoIndex", () => ({
  ensureSemanticIndexesOnOpen: ensureMock,
  resetBackIndexGuards: resetBackIndexMock,
  resetIndexGuards: resetIndexMock,
}));

import { _resetModelDownloadForTests } from "./modelDownloadStore";
import { useModelDownloadListener } from "./useModelDownloadListener";

const donePayload = {
  dirName: "ruri-v3-30m",
  downloaded: 10,
  total: 10,
  done: true,
  error: null,
};

beforeEach(() => {
  listenMock.mockClear();
  ensureMock.mockClear();
  resetBackIndexMock.mockClear();
  resetIndexMock.mockClear();
  runtime.handler = null;
  runtime.panelWindow = false;
  runtime.workspacePath = "/workspace/a";
  runtime.projectId = "p1";
  _resetModelDownloadForTests();
});

afterEach(() => cleanup());

describe("useModelDownloadListener", () => {
  it("does not subscribe in a panel window", () => {
    runtime.panelWindow = true;
    renderHook(() => useModelDownloadListener());
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("restarts indexing with the captured active workspace identity", () => {
    renderHook(() => useModelDownloadListener());
    runtime.handler?.(donePayload);
    expect(resetBackIndexMock).toHaveBeenCalledWith("p1", "/workspace/a");
    expect(ensureMock).toHaveBeenCalledWith("p1", "/workspace/a");
  });

  it("does not restart when project initialization is incomplete", () => {
    runtime.projectId = null;
    renderHook(() => useModelDownloadListener());
    runtime.handler?.(donePayload);
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("releases the current model guard after an asynchronous failure", () => {
    renderHook(() => useModelDownloadListener());
    runtime.handler?.({
      ...donePayload,
      error: "network timeout",
    });

    expect(resetIndexMock).toHaveBeenCalledWith("p1", "/workspace/a");
    expect(ensureMock).not.toHaveBeenCalled();
  });
});
