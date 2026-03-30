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
        })
        // validate_workspace_path
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

  describe("showLauncher", () => {
    it("switches view to launcher", () => {
      useWorkspaceStore.setState({ view: "editor" });
      useWorkspaceStore.getState().showLauncher();
      expect(useWorkspaceStore.getState().view).toBe("launcher");
    });
  });
});
