import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceStore } from "./store";
import { useProjectStore } from "@/features/project/projectStore";
import {
  createAutoSave,
  registerAutoSaveForQuiesce,
} from "@/hooks/useAutoSave";
import { useEditorSessionStore } from "@/features/editor/editorSessionStore";
import { createEditorInstanceId } from "@/features/editor/document/documentKey";
import { trackPendingEditorWrite } from "@/lib/editorQuiescence";
import {
  isProjectLoading,
  resetProjectLoadGateForTests,
  withProjectLoad,
} from "@/features/project/projectLoadGate";
import {
  _resetQuiescenceLeasesForTests,
  isQuiescenceLeaseActive,
} from "@/application/lifecycle/quiescenceLease";
import { createCloseQuiescenceController } from "@/application/lifecycle/closeQuiescenceController";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
import { useSettingsStore } from "@/features/settings/settingsStore";
import {
  getCurrentImeWorkspaceIdentity,
  setCurrentImeWorkspaceIdentity,
} from "@/features/ime/workspaceScope";

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
const realLoadProjectWithinLifecycle =
  useProjectStore.getState().loadProjectWithinLifecycle;

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
    _resetQuiescenceLeasesForTests();
    resetProjectLoadGateForTests();
    resetStore();
    setCurrentImeWorkspaceIdentity(null);
    useInlineAiStore.getState().reset();
    useEditorSessionStore.getState().resetForProject();
    useProjectStore.setState({
      loadProjectWithinLifecycle: vi.fn(async () => {}),
    });
    vi.clearAllMocks();
  });

  afterEach(() => {
    useProjectStore.setState({
      loadProjectWithinLifecycle: realLoadProjectWithinLifecycle,
    });
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
      const path = "D:\\Novels\\Test";
      const settings = {
        recentWorkspaces: [{ path, lastOpened: "2026-03-30T12:00:00Z" }],
        lastActiveWorkspace: path,
        theme: "system",
        showLauncherOnStartup: false,
        // Pre-trust the path so migration is skipped
        trustedWorkspaces: [path],
      };
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "get_global_settings") return settings;
        if (command === "validate_workspace_path") return true;
        if (command === "open_workspace") {
          return { name: "Test", isExisting: true };
        }
        return { rows: [] };
      });

      await useWorkspaceStore.getState().initialize();
      const state = useWorkspaceStore.getState();
      expect(state.view).toBe("editor");
      expect(state.activeWorkspacePath).toBe(path);
    });

    it("shows launcher when last workspace is invalid", async () => {
      const settings = {
        recentWorkspaces: [
          { path: "D:\\Novels\\Gone", lastOpened: "2026-03-30T12:00:00Z" },
        ],
        lastActiveWorkspace: "D:\\Novels\\Gone",
        theme: "system",
        showLauncherOnStartup: false,
      };
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "get_global_settings") return settings;
        if (command === "validate_workspace_path") return false;
        return undefined;
      });

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
    it("blocks Workspace replacement before state changes while inline AI is pending", async () => {
      useWorkspaceStore.setState({
        view: "editor",
        activeWorkspacePath: "D:\\Novels\\Existing",
        workspaceHydrated: true,
      });
      useInlineAiStore.setState({ status: "diffShown" });

      await useWorkspaceStore
        .getState()
        .openWorkspace("D:\\Novels\\Replacement");

      expect(cancelScheduledImeExportsMock).not.toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "open_workspace",
        expect.anything(),
      );
      expect(useWorkspaceStore.getState()).toMatchObject({
        view: "editor",
        activeWorkspacePath: "D:\\Novels\\Existing",
        workspaceSwitchInProgress: false,
        workspaceHydrated: true,
      });
      expect(isQuiescenceLeaseActive()).toBe(false);
    });

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

    it("keeps window-close waiting until the full Workspace lifecycle completes", async () => {
      let resolveOpen!: (result: { name: string; isExisting: boolean }) => void;
      const openGate = new Promise<{
        name: string;
        isExisting: boolean;
      }>((resolve) => {
        resolveOpen = resolve;
      });
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "open_workspace") return openGate;
        if (command === "get_global_settings") {
          return {
            recentWorkspaces: [],
            lastActiveWorkspace: "D:\\Novels\\Replacement",
            theme: "system",
            uiLanguage: "ja",
            uiScale: 100,
            showLauncherOnStartup: false,
          };
        }
        return { rows: [] };
      });

      const opening = useWorkspaceStore
        .getState()
        .openWorkspace("D:\\Novels\\Replacement");
      await vi.waitFor(() =>
        expect(mockInvoke).toHaveBeenCalledWith("open_workspace", {
          path: "D:\\Novels\\Replacement",
        }),
      );

      const closeFlush = vi.fn(async () => {});
      const close = vi.fn(async () => {});
      const closeController = createCloseQuiescenceController({
        hasImmediateVeto: () => false,
        flush: closeFlush,
        close,
        onFailure: vi.fn(),
      });
      closeController.handleCloseRequest({ preventDefault: vi.fn() });
      await Promise.resolve();
      expect(closeFlush).not.toHaveBeenCalled();

      resolveOpen({ name: "Replacement", isExisting: true });
      await opening;
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(closeFlush).toHaveBeenCalledOnce();
      expect(isQuiescenceLeaseActive()).toBe(false);
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
      expect(isQuiescenceLeaseActive()).toBe(false);
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

    it("publishes the replacement identity only after mandatory hydration completes", async () => {
      const previousPath = "D:\\Novels\\Existing";
      const replacementPath = "D:\\Novels\\Replacement";
      useWorkspaceStore.setState({
        view: "editor",
        activeWorkspacePath: previousPath,
        activeWorkspaceName: "Existing",
        workspaceOpenRevision: 3,
        workspaceHydrated: true,
      });
      setCurrentImeWorkspaceIdentity({
        path: previousPath,
        openRevision: 3,
      });
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "open_workspace") {
          return { name: "Replacement", isExisting: true };
        }
        if (command === "get_global_settings") {
          return {
            recentWorkspaces: [],
            lastActiveWorkspace: replacementPath,
            theme: "system",
            uiLanguage: "ja",
            uiScale: 1,
            showLauncherOnStartup: false,
            trustedWorkspaces: [replacementPath],
          };
        }
        return { rows: [] };
      });
      let releaseHydration!: () => void;
      const hydrationGate = new Promise<void>((resolve) => {
        releaseHydration = resolve;
      });
      const previousLoadAll = useSettingsStore.getState().loadAll;
      const loadAll = vi.fn(() => hydrationGate);
      useSettingsStore.setState({ loadAll });
      const opening = useWorkspaceStore
        .getState()
        .openWorkspace(replacementPath);

      try {
        await vi.waitFor(() => expect(loadAll).toHaveBeenCalledOnce());

        expect(useWorkspaceStore.getState()).toMatchObject({
          view: "editor",
          activeWorkspacePath: previousPath,
          activeWorkspaceName: "Existing",
          workspaceOpenRevision: 3,
          workspaceSwitchInProgress: true,
          workspaceHydrated: false,
        });
        expect(getCurrentImeWorkspaceIdentity()).toBeNull();
        expect(isQuiescenceLeaseActive()).toBe(true);

        releaseHydration();
        await opening;

        expect(useWorkspaceStore.getState()).toMatchObject({
          view: "editor",
          activeWorkspacePath: replacementPath,
          activeWorkspaceName: "Replacement",
          workspaceOpenRevision: 4,
          workspaceSwitchInProgress: false,
          workspaceHydrated: true,
        });
        expect(getCurrentImeWorkspaceIdentity()).toEqual({
          path: replacementPath,
          openRevision: 4,
        });
      } finally {
        releaseHydration();
        await opening;
        useSettingsStore.setState({ loadAll: previousLoadAll });
      }
    });

    it("keeps the UI unhydrated when mandatory post-swap hydration fails", async () => {
      const previousPath = "D:\\Novels\\Existing";
      const replacementPath = "D:\\Novels\\Replacement";
      useWorkspaceStore.setState({
        view: "editor",
        activeWorkspacePath: previousPath,
        activeWorkspaceName: "Existing",
        workspaceOpenRevision: 3,
        workspaceHydrated: true,
      });
      setCurrentImeWorkspaceIdentity({
        path: previousPath,
        openRevision: 3,
      });
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "open_workspace") {
          return { name: "Replacement", isExisting: true };
        }
        if (command === "get_global_settings") {
          return {
            recentWorkspaces: [],
            lastActiveWorkspace: replacementPath,
            theme: "system",
            uiLanguage: "ja",
            uiScale: 1,
            showLauncherOnStartup: false,
            trustedWorkspaces: [replacementPath],
          };
        }
        return { rows: [] };
      });
      const previousLoadAll = useSettingsStore.getState().loadAll;
      useSettingsStore.setState({
        loadAll: vi
          .fn()
          .mockRejectedValue(new Error("settings hydration failed")),
      });

      try {
        await useWorkspaceStore.getState().openWorkspace(replacementPath);

        expect(useWorkspaceStore.getState()).toMatchObject({
          view: "launcher",
          activeWorkspacePath: previousPath,
          activeWorkspaceName: "Existing",
          workspaceOpenRevision: 3,
          workspaceSwitchInProgress: false,
          workspaceHydrated: false,
          error: "settings hydration failed",
        });
        expect(getCurrentImeWorkspaceIdentity()).toBeNull();
        expect(isQuiescenceLeaseActive()).toBe(false);
      } finally {
        useSettingsStore.setState({ loadAll: previousLoadAll });
      }
    });

    it("releases both lifecycle leases when Project listing fails after the native swap", async () => {
      const previousPath = "D:\\Novels\\Existing";
      const replacementPath = "D:\\Novels\\Replacement";
      useWorkspaceStore.setState({
        view: "editor",
        activeWorkspacePath: previousPath,
        activeWorkspaceName: "Existing",
        workspaceOpenRevision: 3,
        workspaceHydrated: true,
      });
      setCurrentImeWorkspaceIdentity({
        path: previousPath,
        openRevision: 3,
      });
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "open_workspace") {
          return { name: "Replacement", isExisting: true };
        }
        if (command === "db_execute") {
          throw new Error("project list unavailable after swap");
        }
        return undefined;
      });

      await useWorkspaceStore.getState().openWorkspace(replacementPath);

      expect(useWorkspaceStore.getState()).toMatchObject({
        view: "launcher",
        activeWorkspacePath: previousPath,
        activeWorkspaceName: "Existing",
        workspaceOpenRevision: 3,
        workspaceSwitchInProgress: false,
        workspaceHydrated: false,
        error: expect.stringContaining("Failed query: select"),
      });
      expect(getCurrentImeWorkspaceIdentity()).toBeNull();
      expect(isQuiescenceLeaseActive()).toBe(false);
      expect(isProjectLoading()).toBe(false);

      const nextProjectLoad = vi.fn(async () => {});
      await withProjectLoad(nextProjectLoad);
      expect(nextProjectLoad).toHaveBeenCalledOnce();
    });

    it("keeps a same-path reopen unhydrated when the Project rebind fails", async () => {
      const samePath = "D:\\Novels\\Same";
      useWorkspaceStore.setState({
        view: "editor",
        activeWorkspacePath: samePath,
        activeWorkspaceName: "Same",
        workspaceOpenRevision: 7,
        workspaceHydrated: true,
      });
      setCurrentImeWorkspaceIdentity({
        path: samePath,
        openRevision: 7,
      });
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "open_workspace") {
          return { name: "Same", isExisting: true };
        }
        if (command === "get_global_settings") {
          return {
            recentWorkspaces: [],
            lastActiveWorkspace: samePath,
            theme: "system",
            uiLanguage: "ja",
            uiScale: 1,
            showLauncherOnStartup: false,
            trustedWorkspaces: [samePath],
          };
        }
        return { rows: [] };
      });
      const previousLoadProject =
        useProjectStore.getState().loadProjectWithinLifecycle;
      useProjectStore.setState({
        loadProjectWithinLifecycle: vi
          .fn()
          .mockRejectedValue(new Error("Project rebind failed")),
      });

      try {
        await useWorkspaceStore.getState().openWorkspace(samePath);

        expect(useWorkspaceStore.getState()).toMatchObject({
          view: "launcher",
          activeWorkspacePath: samePath,
          activeWorkspaceName: "Same",
          workspaceOpenRevision: 7,
          workspaceSwitchInProgress: false,
          workspaceHydrated: false,
          error: "Project rebind failed",
        });
        expect(getCurrentImeWorkspaceIdentity()).toBeNull();
        expect(isQuiescenceLeaseActive()).toBe(false);
      } finally {
        useProjectStore.setState({
          loadProjectWithinLifecycle: previousLoadProject,
        });
      }
    });

    it("pre-switch save が失敗したら native open を呼ばず旧 workspace を維持する", async () => {
      const previousPath = "D:\\Novels\\Existing";
      useWorkspaceStore.setState({
        view: "editor",
        activeWorkspacePath: previousPath,
        activeWorkspaceName: "Existing",
        workspaceOpenRevision: 3,
        workspaceHydrated: true,
      });
      const save = vi.fn().mockRejectedValue(new Error("disk full"));
      const autoSave = createAutoSave(save, 2000);
      const unregister = registerAutoSaveForQuiesce(autoSave);
      autoSave.schedule();

      try {
        await useWorkspaceStore
          .getState()
          .openWorkspace("D:\\Novels\\Replacement");

        const state = useWorkspaceStore.getState();
        expect(save).toHaveBeenCalledOnce();
        expect(mockInvoke).not.toHaveBeenCalledWith(
          "open_workspace",
          expect.anything(),
        );
        expect(state.view).toBe("editor");
        expect(state.activeWorkspacePath).toBe(previousPath);
        expect(state.activeWorkspaceName).toBe("Existing");
        expect(state.workspaceOpenRevision).toBe(3);
        expect(state.workspaceHydrated).toBe(true);
        expect(state.workspaceSwitchInProgress).toBe(false);
        expect(state.error).toBe("disk full");
        expect(isQuiescenceLeaseActive()).toBe(false);
      } finally {
        unregister();
        autoSave.cancel();
      }
    });

    it("dirty が解消しない文書があれば native open 前に切替を中断する", async () => {
      const previousPath = "D:\\Novels\\Existing";
      useWorkspaceStore.setState({
        view: "editor",
        activeWorkspacePath: previousPath,
        activeWorkspaceName: "Existing",
        workspaceOpenRevision: 3,
        workspaceHydrated: true,
      });
      useEditorSessionStore
        .getState()
        .setDocumentDirty(
          { kind: "snippet", id: "snippet-1" },
          true,
          createEditorInstanceId("test-editor"),
        );

      await useWorkspaceStore
        .getState()
        .openWorkspace("D:\\Novels\\Replacement");

      const state = useWorkspaceStore.getState();
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "open_workspace",
        expect.anything(),
      );
      expect(state.view).toBe("editor");
      expect(state.activeWorkspacePath).toBe(previousPath);
      expect(state.workspaceOpenRevision).toBe(3);
      expect(state.workspaceHydrated).toBe(true);
      expect(state.error).toBe(
        "未保存または競合中の変更があるため、ワークスペースを切り替えませんでした",
      );
    });

    it("本文外のtracked writeも完了するまでnative swapを待つ", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const tracked = trackPendingEditorWrite(gate);
      mockInvoke.mockResolvedValue({ name: "Replacement" });

      const opening = useWorkspaceStore
        .getState()
        .openWorkspace("D:\\Novels\\Replacement");
      await Promise.resolve();
      expect(isQuiescenceLeaseActive()).toBe(true);
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "open_workspace",
        expect.anything(),
      );

      release();
      await tracked;
      await opening;
      expect(isQuiescenceLeaseActive()).toBe(false);
      expect(mockInvoke).toHaveBeenCalledWith("open_workspace", {
        path: "D:\\Novels\\Replacement",
      });
    });

    it("進行中のProject loadを完了させ、新規loadをleaseで止めてからnative swapする", async () => {
      const order: string[] = [];
      setCurrentImeWorkspaceIdentity({
        path: "D:\\Novels\\Existing",
        openRevision: 9,
      });
      let releaseExisting!: () => void;
      const existingGate = new Promise<void>((resolve) => {
        releaseExisting = resolve;
      });
      const existingLoad = withProjectLoad(async () => {
        order.push("existing-project-start");
        await existingGate;
        order.push("existing-project-finish");
      });
      await Promise.resolve();

      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "open_workspace") {
          order.push("native-workspace-swap");
          return { name: "Replacement", isExisting: true };
        }
        if (command === "get_global_settings") {
          return {
            recentWorkspaces: [],
            lastActiveWorkspace: "D:\\Novels\\Replacement",
            theme: "system",
            uiLanguage: "ja",
            uiScale: 1,
            showLauncherOnStartup: false,
            trustedWorkspaces: ["D:\\Novels\\Replacement"],
          };
        }
        return { rows: [] };
      });

      const opening = useWorkspaceStore
        .getState()
        .openWorkspace("D:\\Novels\\Replacement");
      await Promise.resolve();
      expect(order).toEqual(["existing-project-start"]);
      expect(getCurrentImeWorkspaceIdentity()).toEqual({
        path: "D:\\Novels\\Existing",
        openRevision: 9,
      });

      let lateProjectStarted = false;
      let identityAtLateProjectStart:
        | ReturnType<typeof getCurrentImeWorkspaceIdentity>
        | undefined;
      const lateLoad = withProjectLoad(async () => {
        lateProjectStarted = true;
        identityAtLateProjectStart = getCurrentImeWorkspaceIdentity();
        order.push("late-project-start");
      });
      await Promise.resolve();
      expect(lateProjectStarted).toBe(false);

      releaseExisting();
      await existingLoad;
      await opening;
      await lateLoad;

      expect(order).toEqual([
        "existing-project-start",
        "existing-project-finish",
        "native-workspace-swap",
        "late-project-start",
      ]);
      expect(identityAtLateProjectStart).toEqual({
        path: "D:\\Novels\\Replacement",
        openRevision: 1,
      });
    });

    it("hydrates the Project under the Workspace lease before every ready publication", async () => {
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
      const hydrateProject = vi.fn(
        async (
          _projectId: string,
          context: { owner: string },
          options?: {
            skipStrictQuiescence?: boolean;
            workspaceOpenRevision?: number;
          },
        ) => {
          expect(context.owner).toBe("workspace");
          expect(options?.skipStrictQuiescence).toBe(true);
          expect(getCurrentImeWorkspaceIdentity()).toBeNull();
        },
      );
      const previousLoadProject =
        useProjectStore.getState().loadProjectWithinLifecycle;
      useProjectStore.setState({
        loadProjectWithinLifecycle: hydrateProject,
      });

      try {
        useWorkspaceStore.setState({
          view: "editor",
          activeWorkspacePath: samePath,
          workspaceOpenRevision: 4,
        });
        await useWorkspaceStore.getState().openWorkspace(samePath);
        expect(useWorkspaceStore.getState().error).toBeNull();
        expect(useWorkspaceStore.getState().workspaceOpenRevision).toBe(5);
        expect(hydrateProject).toHaveBeenCalledTimes(1);
        expect(hydrateProject.mock.calls[0]?.[2]).toMatchObject({
          workspaceOpenRevision: 5,
        });

        hydrateProject.mockClear();
        useWorkspaceStore.setState({
          view: "editor",
          activeWorkspacePath: "D:\\Novels\\Other",
        });
        await useWorkspaceStore.getState().openWorkspace(samePath);
        expect(useWorkspaceStore.getState().workspaceOpenRevision).toBe(6);
        expect(hydrateProject).toHaveBeenCalledTimes(1);
        expect(hydrateProject.mock.calls[0]?.[2]).toMatchObject({
          workspaceOpenRevision: 6,
        });
      } finally {
        useProjectStore.setState({
          loadProjectWithinLifecycle: previousLoadProject,
        });
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
      const openedSettings = {
        recentWorkspaces: [
          { path: newPath, lastOpened: "2026-04-16T00:00:00Z" },
        ],
        lastActiveWorkspace: newPath,
        theme: "system",
        uiLanguage: "ja",
        uiScale: 1,
        showLauncherOnStartup: false,
        trustedWorkspaces: [],
      };
      mockInvoke.mockImplementation(async (command: string) => {
        if (command === "validate_workspace_path") return false;
        if (command === "open_workspace") {
          return { name: "NewProject", isExisting: false };
        }
        if (command === "get_global_settings") return openedSettings;
        if (command === "db_execute") return { rows: [] };
        if (command === "save_global_settings") return undefined;
        return undefined;
      });

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
      const originalLoadProject = useProjectStore.getState().loadProject;
      const openWorkspace = vi.fn().mockResolvedValue(undefined);
      const loadProject = vi.fn(async (projectId: string) => {
        useProjectStore.setState({ currentProjectId: projectId });
      });
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
      useProjectStore.setState({
        currentProjectId: "user-project",
        loadProject,
      });
      mockInvoke
        .mockResolvedValueOnce({
          path: newSample,
          projectId: "grimodex-tutorial-project",
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
        expect(loadProject).toHaveBeenCalledWith("grimodex-tutorial-project");
        expect(useWorkspaceStore.getState().showSampleTour).toBe(true);
      } finally {
        useWorkspaceStore.setState({ openWorkspace: originalOpenWorkspace });
        useProjectStore.setState({ loadProject: originalLoadProject });
      }
    });

    it("does not show the tour when sample seeding fails", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("sample seed failed"));

      await useWorkspaceStore
        .getState()
        .seedAndOpenSample("ja", '{"preset":"full"}');

      expect(useWorkspaceStore.getState().showSampleTour).toBe(false);
      expect(useWorkspaceStore.getState().error).toBe("sample seed failed");
    });

    it("does not show the tour when the seeded project cannot become active", async () => {
      const samplePath = "/data/sample-workspace";
      const originalOpenWorkspace = useWorkspaceStore.getState().openWorkspace;
      const originalLoadProject = useProjectStore.getState().loadProject;
      const openWorkspace = vi.fn().mockResolvedValue(undefined);
      const loadProject = vi.fn().mockResolvedValue(undefined);
      useWorkspaceStore.setState({
        openWorkspace,
        globalSettings: {
          recentWorkspaces: [],
          lastActiveWorkspace: samplePath,
          theme: "system",
          uiLanguage: "ja",
          uiScale: 100,
          showLauncherOnStartup: false,
          trustedWorkspaces: [samplePath],
          sampleWorkspacePath: samplePath,
        },
      });
      useProjectStore.setState({
        currentProjectId: "user-project",
        loadProject,
      });
      mockInvoke.mockResolvedValueOnce({
        path: samplePath,
        projectId: "grimodex-tutorial-project",
      });

      try {
        await useWorkspaceStore
          .getState()
          .seedAndOpenSample("ja", '{"preset":"full"}');

        expect(loadProject).toHaveBeenCalledWith("grimodex-tutorial-project");
        expect(useWorkspaceStore.getState().showSampleTour).toBe(false);
        expect(useWorkspaceStore.getState().error).toBe(
          "Tutorial project did not become active",
        );
      } finally {
        useWorkspaceStore.setState({ openWorkspace: originalOpenWorkspace });
        useProjectStore.setState({ loadProject: originalLoadProject });
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
