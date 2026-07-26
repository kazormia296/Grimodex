// @vitest-environment happy-dom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { runtime, listenMock } = vi.hoisted(() => ({
  runtime: {
    panelWindow: false,
    workspacePath: "/workspace/a" as string | null,
    workspaceOpenRevision: 1,
    workspaceSwitchInProgress: false,
    workspaceHydrated: true,
    projectId: "p1" as string | null,
    handler: null as ((payload: unknown) => void) | null,
  },
  listenMock: vi.fn(
    async (_event: string, handler: (payload: unknown) => void) => {
      runtime.handler = handler;
      return vi.fn();
    },
  ),
}));

vi.mock("@/lib/tauri", () => ({ listen: listenMock }));
vi.mock("@/features/layout/multiwindow/panelWindow", () => ({
  isPanelWindow: () => runtime.panelWindow,
}));
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
  useProjectStore: {
    getState: () => ({ currentProjectId: runtime.projectId }),
  },
}));

import { useReindexProgressStore } from "./reindexProgressStore";
import { useReindexProgressListener } from "./useReindexProgressListener";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    projectId: "p1",
    runId: "run-1",
    sceneIndex: 1,
    sceneId: "scene-1",
    totalScenes: 3,
    chunksIndexed: 5,
    done: false,
    ...overrides,
  };
}

beforeEach(() => {
  listenMock.mockClear();
  runtime.handler = null;
  runtime.panelWindow = false;
  runtime.workspacePath = "/workspace/a";
  runtime.workspaceOpenRevision = 1;
  runtime.workspaceSwitchInProgress = false;
  runtime.workspaceHydrated = true;
  runtime.projectId = "p1";
  useReindexProgressStore.getState().clear();
});

afterEach(() => cleanup());

describe("useReindexProgressListener", () => {
  it("does not subscribe in a panel window", () => {
    runtime.panelWindow = true;
    renderHook(() => useReindexProgressListener());
    expect(listenMock).not.toHaveBeenCalled();
  });

  it("accepts progress for the active workspace/project/run", () => {
    useReindexProgressStore.getState().begin("/workspace/a", 1, "p1", "run-1");
    renderHook(() => useReindexProgressListener());
    runtime.handler?.(payload());
    expect(useReindexProgressStore.getState().current?.sceneId).toBe("scene-1");
  });

  it("ignores foreign project and foreign run events", () => {
    useReindexProgressStore.getState().begin("/workspace/a", 1, "p1", "run-1");
    renderHook(() => useReindexProgressListener());
    runtime.handler?.(payload({ projectId: "p2" }));
    runtime.handler?.(payload({ runId: "run-old" }));
    expect(useReindexProgressStore.getState().current).toBeNull();
  });

  it("rejects the old workspace even when projectId is the same", () => {
    useReindexProgressStore
      .getState()
      .begin("/workspace/a", 1, "default-project", "run-a");
    runtime.workspacePath = "/workspace/b";
    runtime.projectId = "default-project";
    renderHook(() => useReindexProgressListener());
    runtime.handler?.(
      payload({ projectId: "default-project", runId: "run-a" }),
    );
    expect(useReindexProgressStore.getState().current).toBeNull();
  });

  it("rejects an old DB revision when path and projectId are unchanged", () => {
    useReindexProgressStore
      .getState()
      .begin("/workspace/a", 1, "default-project", "run-a");
    runtime.workspaceOpenRevision = 2;
    runtime.projectId = "default-project";
    renderHook(() => useReindexProgressListener());
    runtime.handler?.(
      payload({ projectId: "default-project", runId: "run-a" }),
    );
    expect(useReindexProgressStore.getState().current).toBeNull();
  });

  it("rejects progress while workspace hydration is in flight", () => {
    useReindexProgressStore.getState().begin("/workspace/a", 1, "p1", "run-1");
    runtime.workspaceSwitchInProgress = true;
    renderHook(() => useReindexProgressListener());
    runtime.handler?.(payload());
    expect(useReindexProgressStore.getState().current).toBeNull();
  });

  it("rejects a legacy payload with no projectId/runId", () => {
    useReindexProgressStore
      .getState()
      .begin("/workspace/a", 1, "p1", "legacy-active-run");
    renderHook(() => useReindexProgressListener());
    const { projectId: _projectId, runId: _runId, ...legacy } = payload();
    runtime.handler?.(legacy);
    expect(useReindexProgressStore.getState().current).toBeNull();
  });

  it("rejects a legacy payload when there is no active run", () => {
    renderHook(() => useReindexProgressListener());
    const { projectId: _projectId, runId: _runId, ...legacy } = payload();
    runtime.handler?.(legacy);
    expect(useReindexProgressStore.getState().current).toBeNull();
  });

  it("rejects a legacy payload left behind by the previous workspace", () => {
    useReindexProgressStore
      .getState()
      .begin("/workspace/a", 1, "default-project", "legacy-run-a");
    runtime.workspacePath = "/workspace/b";
    runtime.projectId = "default-project";
    renderHook(() => useReindexProgressListener());
    const { projectId: _projectId, runId: _runId, ...legacy } = payload();
    runtime.handler?.(legacy);
    expect(useReindexProgressStore.getState().current).toBeNull();
  });

  it("does not misattribute an old project's legacy event to a new active run", () => {
    runtime.projectId = "project-b";
    useReindexProgressStore
      .getState()
      .begin("/workspace/a", 1, "project-b", "new-run-with-legacy-backend");
    renderHook(() => useReindexProgressListener());
    const {
      projectId: _projectId,
      runId: _runId,
      ...legacy
    } = payload({
      done: true,
    });
    runtime.handler?.(legacy);
    expect(useReindexProgressStore.getState().current).toBeNull();
  });
});
