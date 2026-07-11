import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.fn();
const settingValues: Record<string, string> = {
  "ime.integrationMode": "auto",
  "ime.excludeHidden": "false",
  "ime.includeProfile": "true",
};

vi.mock("@/lib/tauri", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      get: (key: string, fallback = "") => settingValues[key] ?? fallback,
      getBoolean: (key: string, fallback = false) => {
        const value = settingValues[key];
        if (value === "true") return true;
        if (value === "false") return false;
        return fallback;
      },
    }),
  },
}));

import {
  clearImeExports,
  getImeExportStatus,
  refreshImeExport,
  removeImeProjectExport,
  setActiveImeProject,
} from "./api";
import {
  setCurrentImeWorkspaceIdentity,
  type ImeWorkspaceIdentity,
} from "./workspaceScope";

const workspaceA: ImeWorkspaceIdentity = {
  path: "/workspaces/a",
  openRevision: 7,
};

const status = {
  rootPath: "/tmp/grimodex/ime",
  consumers: [
    {
      consumerId: "test-ime",
      name: "Test IME",
      version: "1.0.0",
      lastSeen: "2026-07-11T00:00:00.000Z",
      capabilities: { profile: true },
    },
  ],
  activeProjectId: "p1",
  exportedProjectCount: 1,
  effectiveEnabled: true,
};

describe("IME export invoke API", () => {
  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(status);
    settingValues["ime.integrationMode"] = "auto";
    settingValues["ime.excludeHidden"] = "false";
    settingValues["ime.includeProfile"] = "true";
    setCurrentImeWorkspaceIdentity(workspaceA);
  });

  it("refreshes with the current mode and privacy options", async () => {
    settingValues["ime.integrationMode"] = "on";
    settingValues["ime.excludeHidden"] = "true";
    settingValues["ime.includeProfile"] = "false";

    await expect(refreshImeExport("p1")).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("ime_export_refresh", {
      projectId: "p1",
      expectedWorkspacePath: "/workspaces/a",
      options: {
        mode: "on",
        excludeHidden: true,
        includeProfile: false,
      },
    });
  });

  it("sets and clears the active project with the current mode", async () => {
    await setActiveImeProject("p1");
    await setActiveImeProject(null);
    expect(invokeMock.mock.calls).toEqual([
      [
        "ime_export_set_active_project",
        {
          projectId: "p1",
          expectedWorkspacePath: "/workspaces/a",
          mode: "auto",
        },
      ],
      [
        "ime_export_set_active_project",
        { projectId: null, expectedWorkspacePath: null, mode: "auto" },
      ],
    ]);
  });

  it("reads status using the current integration mode", async () => {
    await expect(getImeExportStatus()).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("ime_export_get_status", {
      mode: "auto",
    });
  });

  it("clears generated exports and removes one project", async () => {
    invokeMock.mockResolvedValue(undefined);
    await clearImeExports();
    await removeImeProjectExport("p1");
    expect(invokeMock.mock.calls).toEqual([
      ["ime_export_clear_all"],
      [
        "ime_export_remove_project",
        { projectId: "p1", expectedWorkspacePath: "/workspaces/a" },
      ],
    ]);
  });

  it("rejects a late result after a same-path workspace reopen", async () => {
    let resolveInvoke!: (value: typeof status) => void;
    invokeMock.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveInvoke = resolve;
      }),
    );

    const pending = refreshImeExport("p1");
    setCurrentImeWorkspaceIdentity({
      path: workspaceA.path,
      openRevision: workspaceA.openRevision + 1,
    });
    resolveInvoke(status);

    await expect(pending).rejects.toThrow(/workspace changed/i);
  });

  it("does not retry a failed removal in a replacement workspace with the same project id", async () => {
    vi.useFakeTimers();
    invokeMock.mockRejectedValueOnce(new Error("locked"));
    const { removeImeProjectExportWithRetry } = await import("./api");

    await removeImeProjectExportWithRetry("default-project");
    setCurrentImeWorkspaceIdentity({ path: "/workspaces/b", openRevision: 8 });
    await vi.runAllTimersAsync();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("does not re-resolve an explicit null deletion scope to a later workspace", async () => {
    const { removeImeProjectExportWithRetry } = await import("./api");

    await removeImeProjectExportWithRetry("default-project", null);

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("allows delayed cleanup across a same-path reopen and leaves reuse safety to native DB validation", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    setCurrentImeWorkspaceIdentity({
      path: workspaceA.path,
      openRevision: workspaceA.openRevision + 1,
    });

    await removeImeProjectExport("default-project", workspaceA);

    expect(invokeMock).toHaveBeenCalledWith("ime_export_remove_project", {
      projectId: "default-project",
      expectedWorkspacePath: workspaceA.path,
    });
  });

  it("bounds scope-settle polling when a failed removal has no workspace again", async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockRejectedValueOnce(new Error("locked"));
    const { removeImeProjectExportWithRetry } = await import("./api");
    try {
      await removeImeProjectExportWithRetry("default-project", workspaceA);
      setCurrentImeWorkspaceIdentity(null);
      await vi.runAllTimersAsync();

      expect(invokeMock).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("scope did not settle"),
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });
});
