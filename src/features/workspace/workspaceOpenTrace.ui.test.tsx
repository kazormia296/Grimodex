// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LauncherScreen } from "./LauncherScreen";
import { WelcomeScreen } from "./WelcomeScreen";
import { WorkspaceMenu } from "./WorkspaceMenu";

const mocks = vi.hoisted(() => ({
  openFolderDialog: vi.fn<() => Promise<string | null>>(),
  requestOpenWorkspace: vi.fn<() => Promise<void>>(),
  openRecentWorkspace: vi.fn<() => Promise<void>>(),
  recordLauncherPaint: vi.fn(),
  state: {
    activeWorkspaceName: "Current Workspace",
    activeWorkspacePath: "/work/current",
    workspaceOpenRevision: 1,
    workspaceOpenRequestInProgress: false,
    workspaceSwitchInProgress: false,
    globalSettings: {
      hasSeenWelcome: true,
      uiLanguage: "ja",
      recentWorkspaces: [
        { path: "/work/current", lastOpened: "2026-08-03T00:00:00Z" },
        { path: "/work/recent", lastOpened: "2026-08-02T00:00:00Z" },
      ],
    },
    error: null as string | null,
    clearError: vi.fn(),
    showLauncher: vi.fn(),
    updateGlobalSettings: vi.fn<() => Promise<boolean>>(),
  },
}));

vi.mock("@/lib/dialog", () => ({
  openFolderDialog: mocks.openFolderDialog,
}));

vi.mock("./store", () => ({
  useWorkspaceStore: (
    selector: (
      state: typeof mocks.state & {
        requestOpenWorkspace: typeof mocks.requestOpenWorkspace;
        openRecentWorkspace: typeof mocks.openRecentWorkspace;
      },
    ) => unknown,
  ) =>
    selector({
      ...mocks.state,
      requestOpenWorkspace: mocks.requestOpenWorkspace,
      openRecentWorkspace: mocks.openRecentWorkspace,
    }),
}));

vi.mock("./workspaceOpenTrace", () => ({
  recordActiveWorkspaceLauncherPaint: mocks.recordLauncherPaint,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/runtime/runtimeCapabilitiesContext", () => ({
  useRuntimeCapabilities: () => ({ genericProjectTransfer: false }),
}));

vi.mock("@/components/TitleBar", () => ({ TitleBar: () => null }));
vi.mock("@/components/GrimodexLogo", () => ({ GrimodexLogo: () => null }));

vi.mock("@/lib/debugLog", () => ({
  debugLog: { error: vi.fn() },
  errorDetail: vi.fn(() => "error"),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn(() => 1),
  );
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  mocks.openFolderDialog.mockResolvedValue("/work/picked");
  mocks.requestOpenWorkspace.mockResolvedValue(undefined);
  mocks.openRecentWorkspace.mockResolvedValue(undefined);
  mocks.state.updateGlobalSettings.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("workspace open trace UI sources", () => {
  it("records LauncherScreen after two animation frames", () => {
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 1;
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        const id = nextFrame;
        nextFrame += 1;
        frames.set(id, callback);
        return id;
      }),
    );
    vi.stubGlobal(
      "cancelAnimationFrame",
      vi.fn((id: number) => frames.delete(id)),
    );

    render(<LauncherScreen />);
    expect(mocks.recordLauncherPaint).not.toHaveBeenCalled();

    frames.get(1)?.(1);
    expect(mocks.recordLauncherPaint).not.toHaveBeenCalled();
    frames.get(2)?.(2);

    expect(mocks.recordLauncherPaint).toHaveBeenCalledTimes(1);
  });

  it("labels Launcher recent and folder opens", async () => {
    render(<LauncherScreen />);

    fireEvent.click(screen.getByText("recent"));
    await waitFor(() =>
      expect(mocks.openRecentWorkspace).toHaveBeenCalledWith(
        "/work/recent",
        "launcher-card",
      ),
    );

    fireEvent.click(screen.getByText("launcher.openFolder"));
    await waitFor(() =>
      expect(mocks.requestOpenWorkspace).toHaveBeenCalledWith(
        "/work/picked",
        "folder-picker",
      ),
    );
  });

  it("labels the returning Welcome folder open", async () => {
    render(<WelcomeScreen />);

    fireEvent.click(screen.getByText("welcome.selectFolder"));
    await screen.findByText("/work/picked");
    fireEvent.click(screen.getByText("welcome.start"));

    await waitFor(() =>
      expect(mocks.requestOpenWorkspace).toHaveBeenCalledWith(
        "/work/picked",
        "folder-picker",
      ),
    );
  });

  it("labels WorkspaceMenu recent and folder opens", async () => {
    render(<WorkspaceMenu />);

    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    fireEvent.click(screen.getByText("recent"));
    expect(mocks.openRecentWorkspace).toHaveBeenCalledWith(
      "/work/recent",
      "workspace-menu-recent",
    );

    fireEvent.click(screen.getByTestId("workspace-menu-trigger"));
    fireEvent.click(screen.getByText("workspaceMenu.openOther"));
    await waitFor(() =>
      expect(mocks.requestOpenWorkspace).toHaveBeenCalledWith(
        "/work/picked",
        "folder-picker",
      ),
    );
  });
});
