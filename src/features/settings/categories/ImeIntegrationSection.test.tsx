// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";

const { clipboardWriteTextMock, openExternalUrlMock, platformRuntime } =
  vi.hoisted(() => ({
    clipboardWriteTextMock: vi.fn(),
    openExternalUrlMock: vi.fn(),
    platformRuntime: { linux: false },
  }));

const modeSetMock = vi.fn();
const excludeHiddenSetMock = vi.fn();
const includeProfileSetMock = vi.fn();
const flushPendingMock = vi.fn();
const loadAllMock = vi.fn();
const refreshImeExportMock = vi.fn();
const setActiveImeProjectMock = vi.fn();
const clearImeExportsMock = vi.fn();
const getImeExportStatusMock = vi.fn();

vi.mock("@/features/ime/linuxPlatform", () => ({
  isLinuxImeHost: () => platformRuntime.linux,
}));

vi.mock("@/lib/safeUrl", () => ({
  openExternalUrl: (...args: unknown[]) => openExternalUrlMock(...args),
}));

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
    clipboardWriteTextMock.mockReset().mockResolvedValue(undefined);
    openExternalUrlMock.mockReset();
    platformRuntime.linux = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: clipboardWriteTextMock },
    });
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

  it("identifies a Linux Phase 3 consumer and its negotiated capabilities", async () => {
    getImeExportStatusMock.mockResolvedValueOnce({
      rootPath: "/tmp/ime",
      consumers: [
        {
          consumerId: "fcitx5-grimodex",
          name: "Grimodex IME",
          version: "0.1.0",
          platform: "linux",
          lastSeen: "2026-07-11T00:00:00.000Z",
          capabilities: {
            profile: true,
            dynamicDictionary: true,
            zenzaiV3Conditions: true,
            applicationScoping: true,
          },
        },
      ],
      activeProjectId: "p1",
      exportedProjectCount: 1,
      effectiveEnabled: true,
    });

    render(<ImeIntegrationSection />);

    expect(await screen.findByText("Grimodex IME")).toBeInTheDocument();
    expect(screen.getByText("Linux")).toBeInTheDocument();
    expect(screen.getByText("動的辞書")).toBeInTheDocument();
    expect(screen.getByText("Zenzai v3")).toBeInTheDocument();
    expect(screen.getByText("アプリ限定")).toBeInTheDocument();
  });

  it("shows Linux install and enable guidance when fcitx5-grimodex is absent", async () => {
    platformRuntime.linux = true;

    render(<ImeIntegrationSection />);

    expect(
      await screen.findByText("Linux 用 Grimodex IME が見つかりません"),
    ).toBeInTheDocument();
    expect(screen.getByText("fcitx5-grimodex")).toBeInTheDocument();
    expect(screen.getByText(/Fcitx 5/)).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "パッケージ名をコピー" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "インストール手順を開く" }),
    ).toBeInTheDocument();
  });

  it("does not show Linux guidance on another OS", async () => {
    render(<ImeIntegrationSection />);

    await waitFor(() => expect(getImeExportStatusMock).toHaveBeenCalled());
    expect(
      screen.queryByText("Linux 用 Grimodex IME が見つかりません"),
    ).not.toBeInTheDocument();
  });

  it("hides Linux guidance when the fresh fcitx5-grimodex consumer is present", async () => {
    platformRuntime.linux = true;
    getImeExportStatusMock.mockResolvedValueOnce({
      rootPath: "/tmp/ime",
      consumers: [
        {
          consumerId: "fcitx5-grimodex",
          name: "Grimodex IME",
          version: "0.1.0",
          platform: "linux",
          lastSeen: "2026-07-11T00:00:00.000Z",
          capabilities: {
            profile: true,
            dynamicDictionary: true,
            zenzaiV3Conditions: true,
            applicationScoping: true,
          },
        },
      ],
      activeProjectId: "p1",
      exportedProjectCount: 1,
      effectiveEnabled: true,
    });

    render(<ImeIntegrationSection />);

    expect(await screen.findByText("Grimodex IME")).toBeInTheDocument();
    expect(
      screen.queryByText("Linux 用 Grimodex IME が見つかりません"),
    ).not.toBeInTheDocument();
  });

  it("copies only the package name and opens the HTTPS installation guide", async () => {
    platformRuntime.linux = true;
    render(<ImeIntegrationSection />);

    fireEvent.click(
      await screen.findByRole("button", { name: "パッケージ名をコピー" }),
    );
    await waitFor(() =>
      expect(clipboardWriteTextMock).toHaveBeenCalledWith("fcitx5-grimodex"),
    );

    fireEvent.click(
      screen.getByRole("button", { name: "インストール手順を開く" }),
    );
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://github.com/kazormia296/hazkey#source-build-and-install",
    );
  });

  it("ships the Linux guidance in Japanese and English", () => {
    expect(ja.settings.codex.imeLinuxInstallTitle).toContain("Linux");
    expect(ja.settings.codex.imeLinuxInstallDescription).toContain("Fcitx 5");
    expect(en.settings.codex.imeLinuxInstallTitle).toContain("Linux");
    expect(en.settings.codex.imeLinuxInstallDescription).toContain("Fcitx 5");
  });
});
