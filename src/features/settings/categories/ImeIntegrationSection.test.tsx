// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import en from "@/locales/en.json";
import ja from "@/locales/ja.json";

const { downloadAndInstallMozkeyMock, openExternalUrlMock, platformRuntime } =
  vi.hoisted(() => ({
    downloadAndInstallMozkeyMock: vi.fn(),
    openExternalUrlMock: vi.fn(),
    platformRuntime: { linux: false, desktop: true },
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

vi.mock("@/features/ime/mozkeyInstaller", () => ({
  canInstallMozkeyFromApp: () => platformRuntime.desktop,
  downloadAndInstallMozkey: (...args: unknown[]) =>
    downloadAndInstallMozkeyMock(...args),
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
    openExternalUrlMock.mockReset();
    downloadAndInstallMozkeyMock.mockReset().mockResolvedValue({
      version: "1.2.3",
      assetName: "MozkeyIbG_v1.2.3_x64.msi",
    });
    platformRuntime.linux = false;
    platformRuntime.desktop = true;
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

  it("identifies the current Mozkey IbG Linux consumer and its capabilities", async () => {
    getImeExportStatusMock.mockResolvedValueOnce({
      rootPath: "/tmp/ime",
      consumers: [
        {
          consumerId: "fcitx5-mozkey-ibg",
          name: "Mozkey IbG for Grimodex on Linux",
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

    expect(
      await screen.findByText("Mozkey IbG for Grimodex on Linux"),
    ).toBeInTheDocument();
    expect(screen.getByText("Linux")).toBeInTheDocument();
    expect(screen.getByText("動的辞書")).toBeInTheDocument();
    expect(screen.getByText("Zenzai v3")).toBeInTheDocument();
    expect(screen.getByText("アプリ限定")).toBeInTheDocument();
  });

  it("shows generic Linux IME guidance when no consumer is present", async () => {
    platformRuntime.linux = true;
    platformRuntime.desktop = false;

    render(<ImeIntegrationSection />);

    expect(
      await screen.findByText("対応する Linux IME が見つかりません"),
    ).toBeInTheDocument();
    expect(screen.getByText(/Fcitx 5/)).toBeInTheDocument();
    expect(screen.getByText(/IBus/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /パッケージ/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "IME の配布元を開く" }),
    ).toBeInTheDocument();
  });

  it("does not show Linux guidance on another OS", async () => {
    render(<ImeIntegrationSection />);

    await waitFor(() => expect(getImeExportStatusMock).toHaveBeenCalled());
    expect(
      screen.queryByText("対応する Linux IME が見つかりません"),
    ).not.toBeInTheDocument();
  });

  it("hides Linux guidance when any fresh consumer is present", async () => {
    platformRuntime.linux = true;
    getImeExportStatusMock.mockResolvedValueOnce({
      rootPath: "/tmp/ime",
      consumers: [
        {
          consumerId: "other-compatible-linux-ime",
          name: "Other Compatible Linux IME",
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

    expect(
      await screen.findByText("Other Compatible Linux IME"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("対応する Linux IME が見つかりません"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: ja.settings.codex.imeMozkeyInstallAction,
      }),
    ).toBeInTheDocument();
  });

  it("opens the IME distribution page without assuming a package name", async () => {
    platformRuntime.linux = true;
    platformRuntime.desktop = false;
    render(<ImeIntegrationSection />);

    fireEvent.click(
      await screen.findByRole("button", { name: "IME の配布元を開く" }),
    );
    expect(openExternalUrlMock).toHaveBeenCalledWith(
      "https://github.com/kazormia296/mozkey-ibg",
    );
  });

  it("downloads and starts the Mozkey IbG installer from desktop settings", async () => {
    render(<ImeIntegrationSection />);

    fireEvent.click(
      await screen.findByRole("button", {
        name: ja.settings.codex.imeMozkeyInstallAction,
      }),
    );

    await waitFor(() =>
      expect(downloadAndInstallMozkeyMock).toHaveBeenCalledOnce(),
    );
    expect(
      await screen.findByText(
        ja.settings.codex.imeMozkeyInstallStarted.replace(
          "{{version}}",
          "1.2.3",
        ),
      ),
    ).toBeInTheDocument();
  });

  it("keeps the installer failure visible and retryable", async () => {
    downloadAndInstallMozkeyMock.mockRejectedValueOnce(
      new Error("No public release"),
    );
    render(<ImeIntegrationSection />);

    const installButton = await screen.findByRole("button", {
      name: ja.settings.codex.imeMozkeyInstallAction,
    });
    fireEvent.click(installButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "No public release",
    );
    expect(installButton).toBeEnabled();
  });

  it("ships the Linux guidance in Japanese and English", () => {
    expect(ja.settings.codex.imeLinuxInstallTitle).toContain("Linux");
    expect(ja.settings.codex.imeLinuxInstallDescription).toContain("Fcitx 5");
    expect(ja.settings.codex.imeLinuxInstallDescription).toContain("IBus");
    expect(en.settings.codex.imeLinuxInstallTitle).toContain("Linux");
    expect(en.settings.codex.imeLinuxInstallDescription).toContain("Fcitx 5");
    expect(en.settings.codex.imeLinuxInstallDescription).toContain("IBus");
  });
});
