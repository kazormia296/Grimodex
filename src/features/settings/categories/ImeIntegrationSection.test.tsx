// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const modeSetMock = vi.fn();
const excludeHiddenSetMock = vi.fn();
const includeProfileSetMock = vi.fn();
const flushPendingMock = vi.fn();
const loadAllMock = vi.fn();
const refreshImeExportMock = vi.fn();
const setActiveImeProjectMock = vi.fn();
const clearImeExportsMock = vi.fn();
const getImeExportStatusMock = vi.fn();

vi.mock("../useSettingControl", () => ({
  useSettingControl: () => ({ value: "auto", setValue: modeSetMock }),
  useSettingBoolean: (key: string) => ({
    value: key === "ime.includeProfile",
    setValue:
      key === "ime.includeProfile"
        ? includeProfileSetMock
        : excludeHiddenSetMock,
  }),
}));

vi.mock("../settingsStore", () => ({
  useSettingsStore: {
    getState: () => ({
      flushPending: flushPendingMock,
      loadAll: loadAllMock,
    }),
  },
}));

vi.mock("@/features/project/projectStore", () => ({
  getCurrentProjectId: () => "p1",
}));

vi.mock("@/features/ime/api", () => ({
  clearImeExports: (...args: unknown[]) => clearImeExportsMock(...args),
  getImeExportStatus: (...args: unknown[]) => getImeExportStatusMock(...args),
  refreshImeExport: (...args: unknown[]) => refreshImeExportMock(...args),
  setActiveImeProject: (...args: unknown[]) => setActiveImeProjectMock(...args),
}));

import { ImeIntegrationSection } from "./ImeIntegrationSection";

describe("ImeIntegrationSection", () => {
  beforeEach(() => {
    modeSetMock.mockReset();
    excludeHiddenSetMock.mockReset();
    includeProfileSetMock.mockReset();
    flushPendingMock.mockReset().mockResolvedValue(undefined);
    loadAllMock.mockReset().mockResolvedValue(undefined);
    refreshImeExportMock.mockReset().mockResolvedValue({});
    setActiveImeProjectMock.mockReset().mockResolvedValue({});
    clearImeExportsMock.mockReset().mockResolvedValue(undefined);
    getImeExportStatusMock.mockReset().mockResolvedValue({
      rootPath: "/tmp/ime",
      consumers: [],
      activeProjectId: null,
      exportedProjectCount: 0,
      effectiveEnabled: false,
    });
  });

  it("persists off before clearing native exports", async () => {
    render(<ImeIntegrationSection />);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "off" },
    });

    await waitFor(() => {
      expect(modeSetMock).toHaveBeenCalledWith("off");
      expect(flushPendingMock).toHaveBeenCalledTimes(1);
      expect(clearImeExportsMock).toHaveBeenCalledTimes(1);
      expect(setActiveImeProjectMock).toHaveBeenCalledWith(null);
    });
    expect(flushPendingMock.mock.invocationCallOrder[0]).toBeLessThan(
      clearImeExportsMock.mock.invocationCallOrder[0]!,
    );
  });

  it("does not mutate native state when persistence fails and reloads the UI cache", async () => {
    flushPendingMock.mockRejectedValueOnce(new Error("disk full"));
    render(<ImeIntegrationSection />);
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "on" },
    });

    await waitFor(() => expect(loadAllMock).toHaveBeenCalledTimes(1));
    expect(refreshImeExportMock).not.toHaveBeenCalled();
    expect(setActiveImeProjectMock).not.toHaveBeenCalled();
  });

  it("clears every prior snapshot before applying a global privacy change", async () => {
    render(<ImeIntegrationSection />);
    fireEvent.click(
      screen.getByRole("switch", { name: "作品プロファイルを書き出す" }),
    );

    await waitFor(() => {
      expect(includeProfileSetMock).toHaveBeenCalledWith(false);
      expect(flushPendingMock).toHaveBeenCalledTimes(1);
      expect(clearImeExportsMock).toHaveBeenCalledTimes(1);
      expect(refreshImeExportMock).toHaveBeenCalledWith("p1");
      expect(setActiveImeProjectMock).toHaveBeenCalledWith("p1");
    });
    expect(flushPendingMock.mock.invocationCallOrder[0]).toBeLessThan(
      clearImeExportsMock.mock.invocationCallOrder[0]!,
    );
    expect(clearImeExportsMock.mock.invocationCallOrder[0]).toBeLessThan(
      refreshImeExportMock.mock.invocationCallOrder[0]!,
    );
  });
});
