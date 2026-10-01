// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const refreshImeExportMock = vi.fn();
const setActiveImeProjectMock = vi.fn();
const clearImeExportsMock = vi.fn();
const cancelScheduledImeExportsMock = vi.fn();
const listenMock = vi.fn();
const workspaceEventHandlers = new Map<string, (payload: unknown) => void>();

let projectState: { currentProjectId: string | null };
let settingsState: {
  projectLanguage: string;
  get: (key: string, fallback?: string) => string;
  getBoolean: (key: string, fallback?: boolean) => boolean;
};
let panelWindow = false;
let integrationMode = "auto";
let workspaceState: {
  activeWorkspacePath: string | null;
  workspaceOpenRevision: number;
  workspaceSwitchInProgress: boolean;
  workspaceHydrated: boolean;
};

vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: (selector: (state: typeof projectState) => unknown) =>
    selector(projectState),
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) =>
    selector(settingsState),
}));

vi.mock("@/features/workspace/store", () => ({
  useWorkspaceStore: (selector: (state: typeof workspaceState) => unknown) =>
    selector(workspaceState),
}));

vi.mock("@/lib/tauri", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

vi.mock("./scheduler", () => ({
  cancelScheduledImeExports: (...args: unknown[]) =>
    cancelScheduledImeExportsMock(...args),
}));

vi.mock("@/features/layout/multiwindow/panelWindow", () => ({
  isPanelWindow: () => panelWindow,
}));

vi.mock("./api", () => ({
  refreshImeExport: (...args: unknown[]) => refreshImeExportMock(...args),
  setActiveImeProject: (...args: unknown[]) => setActiveImeProjectMock(...args),
  clearImeExports: (...args: unknown[]) => clearImeExportsMock(...args),
}));

import { useImeExportSync } from "./useImeExportSync";
import { getCurrentImeWorkspaceIdentity } from "./workspaceScope";

describe("useImeExportSync", () => {
  beforeEach(() => {
    projectState = { currentProjectId: "p1" };
    settingsState = {
      projectLanguage: "ja",
      get: (key, fallback = "") =>
        key === "ime.integrationMode" ? integrationMode : fallback,
      getBoolean: (_key, fallback = false) => fallback,
    };
    panelWindow = false;
    integrationMode = "auto";
    workspaceState = {
      activeWorkspacePath: "/workspaces/a",
      workspaceOpenRevision: 1,
      workspaceSwitchInProgress: false,
      workspaceHydrated: true,
    };
    workspaceEventHandlers.clear();
    listenMock
      .mockReset()
      .mockImplementation(
        async (event: string, handler: (payload: unknown) => void) => {
          workspaceEventHandlers.set(event, handler);
          return () => workspaceEventHandlers.delete(event);
        },
      );
    cancelScheduledImeExportsMock.mockReset();
    refreshImeExportMock.mockReset().mockResolvedValue({});
    setActiveImeProjectMock.mockReset().mockResolvedValue({});
    clearImeExportsMock.mockReset().mockResolvedValue(undefined);
  });

  it("refreshes before activating a Japanese project", async () => {
    renderHook(() => useImeExportSync());
    await waitFor(() => {
      expect(refreshImeExportMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 1,
      });
      expect(setActiveImeProjectMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 1,
      });
    });
  });

  it("refreshes again after a same-path reopen changes only the workspace revision", async () => {
    const { rerender } = renderHook(() => useImeExportSync());
    await waitFor(() =>
      expect(setActiveImeProjectMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 1,
      }),
    );
    refreshImeExportMock.mockClear();

    workspaceState.workspaceOpenRevision = 2;
    rerender();

    await waitFor(() =>
      expect(refreshImeExportMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 2,
      }),
    );
  });

  it("deactivates and cancels pending refreshes as soon as workspace switching starts", async () => {
    const { rerender } = renderHook(() => useImeExportSync());
    await waitFor(() => expect(refreshImeExportMock).toHaveBeenCalled());
    expect(getCurrentImeWorkspaceIdentity()).toEqual({
      path: "/workspaces/a",
      openRevision: 1,
    });
    refreshImeExportMock.mockClear();
    setActiveImeProjectMock.mockClear();
    cancelScheduledImeExportsMock.mockClear();

    workspaceState.workspaceSwitchInProgress = true;
    workspaceState.workspaceHydrated = false;
    rerender();

    await waitFor(() => {
      expect(cancelScheduledImeExportsMock).toHaveBeenCalled();
      expect(setActiveImeProjectMock).toHaveBeenCalledWith(null);
    });
    expect(refreshImeExportMock).not.toHaveBeenCalled();
    // The old identity belongs to in-flight turns until strict quiescence
    // finishes; the workspace open lifecycle then clears it for the swap.
    expect(getCurrentImeWorkspaceIdentity()).toEqual({
      path: "/workspaces/a",
      openRevision: 1,
    });
  });

  it("keeps the active pointer null when the replacement project refresh fails", async () => {
    refreshImeExportMock.mockRejectedValueOnce(new Error("missing project"));

    renderHook(() => useImeExportSync());

    await waitFor(() =>
      expect(setActiveImeProjectMock).toHaveBeenCalledWith(null),
    );
    expect(setActiveImeProjectMock).not.toHaveBeenCalledWith(
      "p1",
      expect.anything(),
    );
  });

  it("does not activate an old same-project request after a same-path reopen", async () => {
    let resolveOld!: (value: object) => void;
    const oldRefresh = new Promise<object>((resolve) => {
      resolveOld = resolve;
    });
    refreshImeExportMock
      .mockReturnValueOnce(oldRefresh)
      .mockResolvedValueOnce({});
    const { rerender } = renderHook(() => useImeExportSync());
    await waitFor(() => expect(refreshImeExportMock).toHaveBeenCalledTimes(1));

    workspaceState.workspaceOpenRevision = 2;
    rerender();
    await waitFor(() =>
      expect(setActiveImeProjectMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 2,
      }),
    );
    const activationsBeforeOldCompletion =
      setActiveImeProjectMock.mock.calls.filter(
        ([projectId]) => projectId === "p1",
      ).length;

    resolveOld({});
    await act(async () => Promise.resolve());

    expect(
      setActiveImeProjectMock.mock.calls.filter(
        ([projectId]) => projectId === "p1",
      ),
    ).toHaveLength(activationsBeforeOldCompletion);
  });

  it("does not let a stale off-mode effect clear exports after mode returns on", async () => {
    integrationMode = "off";
    let resolveOldDeactivate!: (value: object) => void;
    setActiveImeProjectMock
      .mockReturnValueOnce(
        new Promise<object>((resolve) => {
          resolveOldDeactivate = resolve;
        }),
      )
      .mockResolvedValue({});
    const { rerender } = renderHook(() => useImeExportSync());
    await waitFor(() =>
      expect(setActiveImeProjectMock).toHaveBeenCalledWith(null),
    );

    integrationMode = "on";
    rerender();
    await waitFor(() =>
      expect(refreshImeExportMock).toHaveBeenCalledWith(
        "p1",
        expect.anything(),
      ),
    );

    resolveOldDeactivate({});
    await act(async () => Promise.resolve());

    expect(clearImeExportsMock).not.toHaveBeenCalled();
  });

  it("waits for an already-issued off-mode clear before refreshing in on mode", async () => {
    integrationMode = "off";
    let resolveClear!: () => void;
    clearImeExportsMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveClear = resolve;
      }),
    );
    const { rerender } = renderHook(() => useImeExportSync());
    await waitFor(() => expect(clearImeExportsMock).toHaveBeenCalledTimes(1));

    integrationMode = "on";
    rerender();
    await waitFor(() =>
      expect(setActiveImeProjectMock.mock.calls.length).toBeGreaterThan(1),
    );
    expect(refreshImeExportMock).not.toHaveBeenCalled();

    resolveClear();

    await waitFor(() =>
      expect(refreshImeExportMock).toHaveBeenCalledWith(
        "p1",
        expect.anything(),
      ),
    );
    await waitFor(() =>
      expect(setActiveImeProjectMock).toHaveBeenCalledWith(
        "p1",
        expect.anything(),
      ),
    );
  });

  it("refreshes a non-Japanese project so native can remove an old snapshot", async () => {
    settingsState.projectLanguage = "en";
    renderHook(() => useImeExportSync());
    await waitFor(() => {
      expect(refreshImeExportMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 1,
      });
      expect(setActiveImeProjectMock).toHaveBeenCalledWith(null);
    });
  });

  it("refreshes again on focus so a late auto-mode consumer is detected", async () => {
    renderHook(() => useImeExportSync());
    await waitFor(() => expect(refreshImeExportMock).toHaveBeenCalled());
    refreshImeExportMock.mockClear();
    setActiveImeProjectMock.mockClear();

    act(() => window.dispatchEvent(new Event("focus")));
    await waitFor(() => {
      expect(refreshImeExportMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 1,
      });
      expect(setActiveImeProjectMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 1,
      });
    });
  });

  it("keeps IME pointer ownership in the main renderer and makes a floating panel lifecycle a no-op", async () => {
    panelWindow = true;
    const { unmount } = renderHook(() => useImeExportSync());
    await act(async () => Promise.resolve());

    expect(refreshImeExportMock).not.toHaveBeenCalled();
    expect(setActiveImeProjectMock).not.toHaveBeenCalled();
    unmount();
    expect(setActiveImeProjectMock).not.toHaveBeenCalledWith(null);
  });

  it("cancels a stale panel's pending timers when another window opens or restores a workspace", async () => {
    panelWindow = true;
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    renderHook(() => useImeExportSync());
    await waitFor(() =>
      expect(workspaceEventHandlers.has("workspace:opened")).toBe(true),
    );

    act(() => {
      workspaceEventHandlers.get("workspace:opened")?.({
        path: "/workspaces/b",
      });
    });

    expect(cancelScheduledImeExportsMock).toHaveBeenCalled();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });

  it("keeps a panel scope for its own late same-path open event but invalidates it on restore", async () => {
    panelWindow = true;
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    renderHook(() => useImeExportSync());
    await waitFor(() =>
      expect(getCurrentImeWorkspaceIdentity()).toEqual({
        path: "/workspaces/a",
        openRevision: 1,
      }),
    );
    await waitFor(() =>
      expect(workspaceEventHandlers.has("workspace:opened")).toBe(true),
    );

    act(() => {
      workspaceEventHandlers.get("workspace:opened")?.({
        path: "/workspaces/a",
      });
    });
    expect(getCurrentImeWorkspaceIdentity()).toEqual({
      path: "/workspaces/a",
      openRevision: 1,
    });
    expect(closeSpy).not.toHaveBeenCalled();

    act(() => {
      workspaceEventHandlers.get("workspace:opened")?.({
        path: "/workspaces/a",
        reason: "restore",
      });
    });
    expect(getCurrentImeWorkspaceIdentity()).toBeNull();
    expect(closeSpy).toHaveBeenCalledTimes(1);
    closeSpy.mockRestore();
  });

  it("does not close a panel for its own in-progress workspace open", async () => {
    panelWindow = true;
    workspaceState.workspaceSwitchInProgress = true;
    workspaceState.workspaceHydrated = false;
    const closeSpy = vi.spyOn(window, "close").mockImplementation(() => {});
    renderHook(() => useImeExportSync());
    await waitFor(() =>
      expect(workspaceEventHandlers.has("workspace:opened")).toBe(true),
    );

    act(() => {
      workspaceEventHandlers.get("workspace:opened")?.({
        path: "/workspaces/b",
      });
    });

    expect(closeSpy).not.toHaveBeenCalled();
    closeSpy.mockRestore();
  });

  it("reactivates the main pointer after a panel redundantly opens the same workspace", async () => {
    renderHook(() => useImeExportSync());
    await waitFor(() =>
      expect(workspaceEventHandlers.has("workspace:opened")).toBe(true),
    );
    await waitFor(() =>
      expect(setActiveImeProjectMock).toHaveBeenCalledWith(
        "p1",
        expect.anything(),
      ),
    );
    refreshImeExportMock.mockClear();
    setActiveImeProjectMock.mockClear();

    act(() => {
      workspaceEventHandlers.get("workspace:opened")?.({
        path: "/workspaces/a",
      });
    });

    await waitFor(() => {
      expect(refreshImeExportMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 1,
      });
      expect(setActiveImeProjectMock).toHaveBeenCalledWith("p1", {
        path: "/workspaces/a",
        openRevision: 1,
      });
    });
  });

  it("does not reactivate stale renderer state for a restore event", async () => {
    renderHook(() => useImeExportSync());
    await waitFor(() =>
      expect(workspaceEventHandlers.has("workspace:opened")).toBe(true),
    );
    await waitFor(() => expect(refreshImeExportMock).toHaveBeenCalled());
    refreshImeExportMock.mockClear();
    setActiveImeProjectMock.mockClear();

    act(() => {
      workspaceEventHandlers.get("workspace:opened")?.({
        path: "/workspaces/a",
        reason: "restore",
      });
    });

    expect(refreshImeExportMock).not.toHaveBeenCalled();
    expect(setActiveImeProjectMock).not.toHaveBeenCalled();
  });
});
