import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "./store";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

// Import the mocked module to configure per-test
import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

function resetStore() {
  useWorkspaceStore.setState({
    view: "loading",
    globalSettings: null,
    activeWorkspacePath: null,
    activeWorkspaceName: null,
    error: null,
    pendingTrustPath: null,
  });
}

describe("useWorkspaceStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe("initialize", () => {
    it("shows welcome screen when no workspaces exist", async () => {
      mockInvoke.mockResolvedValueOnce({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
      });

      await useWorkspaceStore.getState().initialize();
      const state = useWorkspaceStore.getState();
      expect(state.view).toBe("welcome");
      expect(state.globalSettings).not.toBeNull();
    });

    it("opens last workspace when valid", async () => {
      mockInvoke
        .mockResolvedValueOnce({
          recentWorkspaces: [
            { path: "D:\\Novels\\Test", lastOpened: "2026-03-30T12:00:00Z" },
          ],
          lastActiveWorkspace: "D:\\Novels\\Test",
          theme: "system",
          showLauncherOnStartup: false,
          // Pre-trust the path so migration is skipped
          trustedWorkspaces: ["D:\\Novels\\Test"],
        })
        // validate_workspace_path (initialize: lastActiveWorkspace check)
        .mockResolvedValueOnce(true)
        // validate_workspace_path (requestOpenWorkspace: existing check)
        .mockResolvedValueOnce(true)
        // open_workspace
        .mockResolvedValueOnce({ name: "Test" });

      await useWorkspaceStore.getState().initialize();
      const state = useWorkspaceStore.getState();
      expect(state.view).toBe("editor");
      expect(state.activeWorkspacePath).toBe("D:\\Novels\\Test");
    });

    it("shows launcher when last workspace is invalid", async () => {
      mockInvoke
        .mockResolvedValueOnce({
          recentWorkspaces: [
            { path: "D:\\Novels\\Gone", lastOpened: "2026-03-30T12:00:00Z" },
          ],
          lastActiveWorkspace: "D:\\Novels\\Gone",
          theme: "system",
          showLauncherOnStartup: false,
        })
        // validate_workspace_path returns false
        .mockResolvedValueOnce(false);

      await useWorkspaceStore.getState().initialize();
      expect(useWorkspaceStore.getState().view).toBe("launcher");
    });

    it("falls back to launcher when openWorkspace fails during initialize", async () => {
      mockInvoke
        .mockResolvedValueOnce({
          recentWorkspaces: [
            { path: "D:\\Novels\\Test", lastOpened: "2026-03-30T12:00:00Z" },
          ],
          lastActiveWorkspace: "D:\\Novels\\Test",
          theme: "system",
          showLauncherOnStartup: false,
          // Pre-trust the path so migration is skipped
          trustedWorkspaces: ["D:\\Novels\\Test"],
        })
        // validate_workspace_path (initialize: lastActiveWorkspace check)
        .mockResolvedValueOnce(true)
        // validate_workspace_path (requestOpenWorkspace: existing check)
        .mockResolvedValueOnce(true)
        // open_workspace fails
        .mockRejectedValueOnce(new Error("DB open failed"));

      await useWorkspaceStore.getState().initialize();
      const state = useWorkspaceStore.getState();
      expect(state.view).toBe("launcher");
      expect(state.error).toBeTruthy();
    });

    it("shows launcher when showLauncherOnStartup is true", async () => {
      mockInvoke.mockResolvedValueOnce({
        recentWorkspaces: [
          { path: "D:\\Novels\\Test", lastOpened: "2026-03-30T12:00:00Z" },
        ],
        lastActiveWorkspace: "D:\\Novels\\Test",
        theme: "system",
        showLauncherOnStartup: true,
      });

      await useWorkspaceStore.getState().initialize();
      expect(useWorkspaceStore.getState().view).toBe("launcher");
    });
  });

  describe("openWorkspace", () => {
    it("sets editor view and active workspace on success", async () => {
      mockInvoke.mockResolvedValueOnce({ name: "MyNovel" });

      await useWorkspaceStore.getState().openWorkspace("D:\\Novels\\MyNovel");
      const state = useWorkspaceStore.getState();
      expect(state.view).toBe("editor");
      expect(state.activeWorkspacePath).toBe("D:\\Novels\\MyNovel");
      expect(state.activeWorkspaceName).toBe("MyNovel");
    });

    it("sets error on failure", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("DB open failed"));

      await useWorkspaceStore.getState().openWorkspace("D:\\Bad\\Path");
      const state = useWorkspaceStore.getState();
      expect(state.view).not.toBe("editor");
      expect(state.error).toBeTruthy();
    });
  });

  describe("requestOpenWorkspace", () => {
    it("auto-trusts a brand-new workspace so next launch skips the trust dialog", async () => {
      useWorkspaceStore.setState({
        globalSettings: {
          recentWorkspaces: [],
          lastActiveWorkspace: null,
          theme: "system",
          uiLanguage: "ja",
          uiScale: 1,
          showLauncherOnStartup: false,
          trustedWorkspaces: [],
        },
      });

      const newPath = "D:\\Novels\\NewProject";
      mockInvoke
        // validate_workspace_path → false (new workspace)
        .mockResolvedValueOnce(false)
        // open_workspace
        .mockResolvedValueOnce({ name: "NewProject" })
        // db_execute (initCurrentProject → listProjects)
        .mockResolvedValueOnce({ rows: [] })
        // get_global_settings (re-read after open_workspace)
        .mockResolvedValueOnce({
          recentWorkspaces: [
            { path: newPath, lastOpened: "2026-04-16T00:00:00Z" },
          ],
          lastActiveWorkspace: newPath,
          theme: "system",
          uiLanguage: "ja",
          uiScale: 1,
          showLauncherOnStartup: false,
          trustedWorkspaces: [],
        })
        // save_global_settings (updateGlobalSettings)
        .mockResolvedValueOnce(undefined);

      await useWorkspaceStore.getState().requestOpenWorkspace(newPath);

      const state = useWorkspaceStore.getState();
      expect(state.view).toBe("editor");
      expect(state.globalSettings?.trustedWorkspaces).toContain(newPath);
    });

    it("shows trust dialog for existing untrusted workspace", async () => {
      useWorkspaceStore.setState({
        globalSettings: {
          recentWorkspaces: [],
          lastActiveWorkspace: null,
          theme: "system",
          uiLanguage: "ja",
          uiScale: 1,
          showLauncherOnStartup: false,
          trustedWorkspaces: [],
        },
      });

      const untrustedPath = "D:\\Novels\\OtherProject";
      mockInvoke
        // validate_workspace_path → true (exists but not trusted)
        .mockResolvedValueOnce(true);

      await useWorkspaceStore.getState().requestOpenWorkspace(untrustedPath);

      const state = useWorkspaceStore.getState();
      expect(state.pendingTrustPath).toBe(untrustedPath);
      expect(state.view).not.toBe("editor");
    });
  });

  describe("showLauncher", () => {
    it("switches view to launcher", () => {
      useWorkspaceStore.setState({ view: "editor" });
      useWorkspaceStore.getState().showLauncher();
      expect(useWorkspaceStore.getState().view).toBe("launcher");
    });
  });
});
