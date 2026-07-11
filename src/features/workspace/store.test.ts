import { describe, it, expect, beforeEach, vi } from "vitest";
import { useWorkspaceStore } from "./store";
import { useProjectStore } from "@/features/project/projectStore";

const cancelScheduledImeExportsMock = vi.hoisted(() => vi.fn());

vi.mock("@/features/ime/scheduler", () => ({
  cancelScheduledImeExports: cancelScheduledImeExportsMock,
}));

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
    workspaceOpenRevision: 0,
    workspaceSwitchInProgress: false,
    workspaceHydrated: false,
    activeWorkspaceName: null,
    error: null,
    pendingTrustPath: null,
    showSampleTour: false,
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
    it("cancels pending IME exports before invoking the native workspace swap", async () => {
      const order: string[] = [];
      cancelScheduledImeExportsMock.mockImplementation(() => {
        order.push("cancel-ime");
      });
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "open_workspace") {
          order.push("open-workspace");
          return { name: "MyNovel", isExisting: true };
        }
        if (command === "get_global_settings") {
          return {
            recentWorkspaces: [],
            lastActiveWorkspace: "D:\\Novels\\MyNovel",
            theme: "system",
            uiLanguage: "ja",
            uiScale: 100,
            showLauncherOnStartup: false,
          };
        }
        return { rows: [] };
      });

      await useWorkspaceStore.getState().openWorkspace("D:\\Novels\\MyNovel");

      expect(order).toContain("cancel-ime");
      expect(order.indexOf("cancel-ime")).toBeLessThan(
        order.indexOf("open-workspace"),
      );
    });

    it("sets editor view and active workspace on success", async () => {
      mockInvoke.mockResolvedValueOnce({ name: "MyNovel" });

      await useWorkspaceStore.getState().openWorkspace("D:\\Novels\\MyNovel");
      const state = useWorkspaceStore.getState();
      expect(state.view).toBe("editor");
      expect(state.activeWorkspacePath).toBe("D:\\Novels\\MyNovel");
      expect(state.activeWorkspaceName).toBe("MyNovel");
      expect(state.workspaceOpenRevision).toBe(1);
      expect(state.workspaceSwitchInProgress).toBe(false);
      expect(state.workspaceHydrated).toBe(true);
    });

    it("sets error on failure", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("DB open failed"));

      await useWorkspaceStore.getState().openWorkspace("D:\\Bad\\Path");
      const state = useWorkspaceStore.getState();
      expect(state.view).not.toBe("editor");
      expect(state.error).toBeTruthy();
      expect(state.workspaceOpenRevision).toBe(0);
      expect(state.workspaceSwitchInProgress).toBe(false);
      expect(state.workspaceHydrated).toBe(false);
    });

    it("restores the previous hydrated workspace when native open rejects before swap", async () => {
      useWorkspaceStore.setState({
        view: "editor",
        activeWorkspacePath: "D:\\Novels\\Existing",
        activeWorkspaceName: "Existing",
        workspaceOpenRevision: 3,
        workspaceHydrated: true,
      });
      mockInvoke.mockRejectedValueOnce(new Error("new DB rejected"));

      await useWorkspaceStore.getState().openWorkspace("D:\\Novels\\Broken");
      const state = useWorkspaceStore.getState();
      expect(state.activeWorkspacePath).toBe("D:\\Novels\\Existing");
      expect(state.workspaceOpenRevision).toBe(3);
      expect(state.workspaceHydrated).toBe(true);
      expect(state.workspaceSwitchInProgress).toBe(false);
    });

    // R4-1 系列A: 同一パス再オープン (例: チュートリアル再実行) では
    // EditorScreen の key (activeWorkspacePath) が変わらず remount しないため、
    // mount 時の loadProject (recorder resume を含む rebind の唯一の経路) が
    // 走らない。openWorkspace が明示的に再ロードする契約を検証する。
    it("同一パス再オープンでは loadProject を明示的に再実行する (R4-1 系列A)", async () => {
      const samePath = "D:\\Novels\\Same";
      const settingsShape = {
        recentWorkspaces: [],
        lastActiveWorkspace: samePath,
        theme: "system",
        uiLanguage: "ja",
        uiScale: 1,
        showLauncherOnStartup: false,
        trustedWorkspaces: [samePath],
      };
      mockInvoke.mockImplementation((cmd: string) => {
        switch (cmd) {
          case "open_workspace":
            return Promise.resolve({ name: "Same", isExisting: true });
          case "get_global_settings":
            return Promise.resolve(settingsShape);
          case "db_execute":
            return Promise.resolve({ rows: [] });
          default:
            return Promise.resolve(undefined);
        }
      });
      const loadProjectSpy = vi.fn(async () => {});
      const prevLoadProject = useProjectStore.getState().loadProject;
      useProjectStore.setState({ loadProject: loadProjectSpy });
      try {
        // 1) エディタ表示中 + 同一パス → 明示再ロードされる
        useWorkspaceStore.setState({
          view: "editor",
          activeWorkspacePath: samePath,
          workspaceOpenRevision: 4,
        });
        await useWorkspaceStore.getState().openWorkspace(samePath);
        expect(useWorkspaceStore.getState().error).toBeNull();
        expect(useWorkspaceStore.getState().workspaceOpenRevision).toBe(5);
        expect(loadProjectSpy).toHaveBeenCalledTimes(1);

        // 2) 別パスへの切替 → remount (mount 時の loadProject) に任せる
        loadProjectSpy.mockClear();
        useWorkspaceStore.setState({
          view: "editor",
          activeWorkspacePath: "D:\\Novels\\Other",
        });
        await useWorkspaceStore.getState().openWorkspace(samePath);
        expect(useWorkspaceStore.getState().workspaceOpenRevision).toBe(6);
        expect(loadProjectSpy).not.toHaveBeenCalled();
      } finally {
        useProjectStore.setState({ loadProject: prevLoadProject });
      }
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
        // db_execute (initCurrentProject → getSetting workspace.lastActiveProjectId)
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

  describe("seedAndOpenSample", () => {
    it("replaces the previous immutable sample generation in trusted workspaces", async () => {
      const oldSample =
        "/data/sample-workspace-11111111-1111-1111-1111-111111111111";
      const newSample =
        "/data/sample-workspace-22222222-2222-2222-2222-222222222222";
      const userWorkspace = "/novels/main";
      const originalOpenWorkspace = useWorkspaceStore.getState().openWorkspace;
      const openWorkspace = vi.fn().mockResolvedValue(undefined);
      useWorkspaceStore.setState({
        openWorkspace,
        globalSettings: {
          recentWorkspaces: [],
          lastActiveWorkspace: oldSample,
          theme: "system",
          uiLanguage: "ja",
          uiScale: 100,
          showLauncherOnStartup: false,
          trustedWorkspaces: [userWorkspace, oldSample],
          sampleWorkspacePath: oldSample,
        },
      });
      mockInvoke
        .mockResolvedValueOnce({
          path: newSample,
          projectId: "default-project",
        })
        .mockResolvedValueOnce({
          ...useWorkspaceStore.getState().globalSettings,
          sampleWorkspacePath: newSample,
        })
        .mockResolvedValueOnce(undefined);

      try {
        await useWorkspaceStore
          .getState()
          .seedAndOpenSample("ja", '{"preset":"full"}');

        expect(mockInvoke).toHaveBeenNthCalledWith(3, "save_global_settings", {
          settings: expect.objectContaining({
            trustedWorkspaces: [userWorkspace, newSample],
            sampleWorkspacePath: newSample,
          }),
        });
        expect(openWorkspace).toHaveBeenCalledWith(newSample);
        expect(useWorkspaceStore.getState().showSampleTour).toBe(true);
      } finally {
        useWorkspaceStore.setState({ openWorkspace: originalOpenWorkspace });
      }
    });
  });

  // 保存成否を戻り値で返す契約（呼び出し側が失敗をユーザーへ通知できるように）。
  describe("updateGlobalSettings — 保存成否の戻り値", () => {
    beforeEach(() => {
      useWorkspaceStore.setState({
        globalSettings: {
          recentWorkspaces: [],
          lastActiveWorkspace: null,
          theme: "system",
          showLauncherOnStartup: false,
          uiLanguage: "ja",
          uiScale: 100,
        },
      });
    });

    it("成功時は true を返し設定を保持する", async () => {
      mockInvoke.mockResolvedValueOnce(undefined);
      const ok = await useWorkspaceStore
        .getState()
        .updateGlobalSettings({ theme: "dark" });
      expect(ok).toBe(true);
      expect(useWorkspaceStore.getState().globalSettings?.theme).toBe("dark");
    });

    it("失敗時は false を返し楽観的変更をリバートする", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("save failed"));
      const ok = await useWorkspaceStore
        .getState()
        .updateGlobalSettings({ theme: "dark" });
      expect(ok).toBe(false);
      // リバートされ元の "system" に戻る。
      expect(useWorkspaceStore.getState().globalSettings?.theme).toBe("system");
    });
  });
});
