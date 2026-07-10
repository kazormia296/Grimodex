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
  });

  it("refreshes with the current mode and privacy options", async () => {
    settingValues["ime.integrationMode"] = "on";
    settingValues["ime.excludeHidden"] = "true";
    settingValues["ime.includeProfile"] = "false";

    await expect(refreshImeExport("p1")).resolves.toEqual(status);
    expect(invokeMock).toHaveBeenCalledWith("ime_export_refresh", {
      projectId: "p1",
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
      ["ime_export_set_active_project", { projectId: "p1", mode: "auto" }],
      ["ime_export_set_active_project", { projectId: null, mode: "auto" }],
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
      ["ime_export_remove_project", { projectId: "p1" }],
    ]);
  });
});
