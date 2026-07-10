// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";

const refreshImeExportMock = vi.fn();
const setActiveImeProjectMock = vi.fn();
const clearImeExportsMock = vi.fn();

let projectState: { currentProjectId: string | null };
let settingsState: {
  projectLanguage: string;
  get: (key: string, fallback?: string) => string;
  getBoolean: (key: string, fallback?: boolean) => boolean;
};
let panelWindow = false;

vi.mock("@/features/project/projectStore", () => ({
  useProjectStore: (selector: (state: typeof projectState) => unknown) =>
    selector(projectState),
}));

vi.mock("@/features/settings/settingsStore", () => ({
  useSettingsStore: (selector: (state: typeof settingsState) => unknown) =>
    selector(settingsState),
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

describe("useImeExportSync", () => {
  beforeEach(() => {
    projectState = { currentProjectId: "p1" };
    settingsState = {
      projectLanguage: "ja",
      get: (_key, fallback = "") => fallback,
      getBoolean: (_key, fallback = false) => fallback,
    };
    panelWindow = false;
    refreshImeExportMock.mockReset().mockResolvedValue({});
    setActiveImeProjectMock.mockReset().mockResolvedValue({});
    clearImeExportsMock.mockReset().mockResolvedValue(undefined);
  });

  it("refreshes before activating a Japanese project", async () => {
    renderHook(() => useImeExportSync());
    await waitFor(() => {
      expect(refreshImeExportMock).toHaveBeenCalledWith("p1");
      expect(setActiveImeProjectMock).toHaveBeenCalledWith("p1");
    });
  });

  it("refreshes a non-Japanese project so native can remove an old snapshot", async () => {
    settingsState.projectLanguage = "en";
    renderHook(() => useImeExportSync());
    await waitFor(() => {
      expect(refreshImeExportMock).toHaveBeenCalledWith("p1");
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
      expect(refreshImeExportMock).toHaveBeenCalledWith("p1");
      expect(setActiveImeProjectMock).toHaveBeenCalledWith("p1");
    });
  });

  it("does not let a floating panel clear the main window pointer on unmount", async () => {
    panelWindow = true;
    const { unmount } = renderHook(() => useImeExportSync());
    await waitFor(() =>
      expect(setActiveImeProjectMock).toHaveBeenCalledWith("p1"),
    );
    setActiveImeProjectMock.mockClear();
    unmount();
    expect(setActiveImeProjectMock).not.toHaveBeenCalledWith(null);
  });
});
