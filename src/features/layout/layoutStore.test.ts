import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useLayoutStore,
  clearSavedLayout,
  resolveInsertPosition,
} from "./layoutStore";
import type { DockviewApi } from "dockview-react";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

function resetStore() {
  useLayoutStore.setState({
    dockviewApi: null,
  });
}

describe("useLayoutStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("loadLayout", () => {
    it("returns layout from global settings when present", async () => {
      const mockLayout = { grid: { root: {} } };
      mockInvoke.mockResolvedValueOnce({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: mockLayout,
      });

      const result = await useLayoutStore.getState().loadLayout();

      expect(mockInvoke).toHaveBeenCalledWith("get_global_settings");
      expect(result).toEqual(mockLayout);
    });

    it("returns null when global settings have no layout", async () => {
      mockInvoke.mockResolvedValueOnce({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
      });

      const result = await useLayoutStore.getState().loadLayout();

      expect(result).toBeNull();
    });

    it("returns null when invoke fails", async () => {
      mockInvoke.mockRejectedValueOnce(new Error("DB error"));

      const result = await useLayoutStore.getState().loadLayout();

      expect(result).toBeNull();
    });
  });

  describe("saveLayout (via scheduleSave)", () => {
    it("saves layout to global settings via invoke", async () => {
      const validLayout = {
        grid: {
          root: {
            type: "branch",
            data: [
              { type: "leaf", data: {}, size: 600 },
              { type: "leaf", data: {}, size: 600 },
            ],
          },
          width: 1200,
          height: 800,
          orientation: 0,
        },
        panels: { p1: {}, p2: {} },
      };
      const mockToJSON = vi.fn().mockReturnValue(validLayout);
      const mockApi = {
        toJSON: mockToJSON,
        onDidLayoutChange: vi.fn(),
      };

      // First call: get_global_settings (to read current)
      // Second call: save_global_settings (to write back)
      mockInvoke
        .mockResolvedValueOnce({
          recentWorkspaces: [],
          lastActiveWorkspace: null,
          theme: "system",
          showLauncherOnStartup: false,
        })
        .mockResolvedValueOnce(undefined);

      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().saveLayout();

      // Advance past debounce timer
      await vi.advanceTimersByTimeAsync(600);

      expect(mockToJSON).toHaveBeenCalled();
      expect(mockInvoke).toHaveBeenCalledWith("get_global_settings");
      expect(mockInvoke).toHaveBeenCalledWith("save_global_settings", {
        settings: expect.objectContaining({
          layout: validLayout,
        }),
      });
    });

    it("does not save when dockviewApi is null", async () => {
      useLayoutStore.setState({ dockviewApi: null });
      useLayoutStore.getState().saveLayout();

      await vi.advanceTimersByTimeAsync(600);

      expect(mockInvoke).not.toHaveBeenCalled();
    });

    it("merges layout into existing global settings", async () => {
      const mockApi = {
        toJSON: vi.fn().mockReturnValue({
          grid: {
            root: {
              type: "branch",
              data: [
                { type: "leaf", data: {}, size: 600 },
                { type: "leaf", data: {}, size: 600 },
              ],
            },
            width: 1200,
            height: 800,
            orientation: 0,
          },
          panels: { p1: {}, p2: {} },
        }),
        onDidLayoutChange: vi.fn(),
      };

      mockInvoke
        .mockResolvedValueOnce({
          recentWorkspaces: [{ path: "/test", lastOpened: "2026-01-01" }],
          lastActiveWorkspace: "/test",
          theme: "dark",
          showLauncherOnStartup: true,
        })
        .mockResolvedValueOnce(undefined);

      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().saveLayout();

      await vi.advanceTimersByTimeAsync(600);

      // Verify existing settings are preserved
      expect(mockInvoke).toHaveBeenCalledWith("save_global_settings", {
        settings: expect.objectContaining({
          recentWorkspaces: [{ path: "/test", lastOpened: "2026-01-01" }],
          lastActiveWorkspace: "/test",
          theme: "dark",
          showLauncherOnStartup: true,
        }),
      });
    });

    it("skips save when layout is degenerate (single leaf root)", async () => {
      const degenerateLayout = {
        grid: {
          root: { type: "leaf", data: {}, size: 1200 },
          width: 1200,
          height: 800,
          orientation: 0,
        },
        panels: { p1: {} },
      };

      const mockApi = {
        toJSON: vi.fn().mockReturnValue(degenerateLayout),
        onDidLayoutChange: vi.fn(),
      };

      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().saveLayout();

      await vi.advanceTimersByTimeAsync(600);

      // Should NOT call save_global_settings
      expect(mockInvoke).not.toHaveBeenCalledWith(
        "save_global_settings",
        expect.anything(),
      );
    });

    it("skips save when panels count is less than 2", async () => {
      const degenerateLayout = {
        grid: {
          root: {
            type: "branch",
            data: [
              { type: "leaf", data: {}, size: 600 },
              { type: "leaf", data: {}, size: 600 },
            ],
          },
          width: 1200,
          height: 800,
          orientation: 0,
        },
        panels: { p1: {} }, // only 1 panel
      };

      const mockApi = {
        toJSON: vi.fn().mockReturnValue(degenerateLayout),
        onDidLayoutChange: vi.fn(),
      };

      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().saveLayout();

      await vi.advanceTimersByTimeAsync(600);

      expect(mockInvoke).not.toHaveBeenCalledWith(
        "save_global_settings",
        expect.anything(),
      );
    });
  });

  describe("clearSavedLayout", () => {
    it("removes layout key from global settings", async () => {
      mockInvoke
        .mockResolvedValueOnce({
          recentWorkspaces: [],
          lastActiveWorkspace: null,
          theme: "system",
          showLauncherOnStartup: false,
          layout: { grid: { root: {} } },
        })
        .mockResolvedValueOnce(undefined);

      await clearSavedLayout();

      expect(mockInvoke).toHaveBeenCalledWith("save_global_settings", {
        settings: expect.not.objectContaining({ layout: expect.anything() }),
      });
    });

    it("preserves other settings when removing layout", async () => {
      mockInvoke
        .mockResolvedValueOnce({
          recentWorkspaces: [{ path: "/ws", lastOpened: "2026-01-01" }],
          theme: "dark",
          layout: { grid: { root: {} } },
        })
        .mockResolvedValueOnce(undefined);

      await clearSavedLayout();

      expect(mockInvoke).toHaveBeenCalledWith("save_global_settings", {
        settings: expect.objectContaining({
          recentWorkspaces: [{ path: "/ws", lastOpened: "2026-01-01" }],
          theme: "dark",
        }),
      });
    });
  });

  describe("resolveInsertPosition", () => {
    function makeApi(existing: string[]): Pick<DockviewApi, "getPanel"> {
      return {
        getPanel: vi
          .fn()
          .mockImplementation((id: string) =>
            existing.includes(id) ? { id } : undefined,
          ),
      } as unknown as Pick<DockviewApi, "getPanel">;
    }

    it("returns fallback direction when no anchor panels exist for scenes", () => {
      const api = makeApi([]);
      expect(resolveInsertPosition(api as DockviewApi, "scenes")).toEqual({
        direction: "left",
      });
    });

    it("uses first available anchor for scenes (codex present)", () => {
      const api = makeApi(["codex"]);
      expect(resolveInsertPosition(api as DockviewApi, "scenes")).toEqual({
        referencePanel: "codex",
        direction: "within",
      });
    });

    it("skips unavailable anchor and falls through to next for scenes", () => {
      const api = makeApi(["codex-quick"]); // codex absent, codex-quick present
      expect(resolveInsertPosition(api as DockviewApi, "scenes")).toEqual({
        referencePanel: "codex-quick",
        direction: "within",
      });
    });

    it("places chat-history within chat when chat exists", () => {
      const api = makeApi(["chat"]);
      expect(resolveInsertPosition(api as DockviewApi, "chat-history")).toEqual(
        {
          referencePanel: "chat",
          direction: "within",
        },
      );
    });

    it("falls back to right for chat-history when chat absent", () => {
      const api = makeApi([]);
      expect(resolveInsertPosition(api as DockviewApi, "chat-history")).toEqual(
        {
          direction: "right",
        },
      );
    });

    it("places codex-quick within codex when codex exists", () => {
      const api = makeApi(["codex"]);
      expect(resolveInsertPosition(api as DockviewApi, "codex-quick")).toEqual({
        referencePanel: "codex",
        direction: "within",
      });
    });

    it("places editor to the right of scenes when scenes exists", () => {
      const api = makeApi(["scenes"]);
      expect(resolveInsertPosition(api as DockviewApi, "editor")).toEqual({
        referencePanel: "scenes",
        direction: "right",
      });
    });

    it("places editor with right fallback when no left-column panels exist", () => {
      const api = makeApi([]);
      expect(resolveInsertPosition(api as DockviewApi, "editor")).toEqual({
        direction: "right",
      });
    });
  });

  describe("togglePanel — focuses panel without removing it", () => {
    it("calls setActive when panel is already visible and active", () => {
      const mockSetActive = vi.fn();
      const mockRemovePanel = vi.fn();
      const mockPanel = {
        api: { setActive: mockSetActive },
        group: { activePanel: { id: "scenes" } },
      };
      const mockApi = {
        getPanel: vi.fn().mockReturnValue(mockPanel),
        removePanel: mockRemovePanel,
        addPanel: vi.fn(),
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().togglePanel("scenes");
      expect(mockSetActive).toHaveBeenCalled();
      expect(mockRemovePanel).not.toHaveBeenCalled();
    });

    it("calls setActive when panel exists but is not the active tab", () => {
      const mockSetActive = vi.fn();
      const mockRemovePanel = vi.fn();
      const mockPanel = {
        api: { setActive: mockSetActive },
        group: { activePanel: { id: "codex" } }, // different active panel
      };
      const mockApi = {
        getPanel: vi.fn().mockReturnValue(mockPanel),
        removePanel: mockRemovePanel,
        addPanel: vi.fn(),
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().togglePanel("scenes");
      expect(mockSetActive).toHaveBeenCalled();
      expect(mockRemovePanel).not.toHaveBeenCalled();
    });

    it("adds panel with registry position when panel does not exist", () => {
      const mockAddPanel = vi.fn();
      const mockApi = {
        getPanel: vi.fn().mockReturnValue(undefined),
        addPanel: mockAddPanel,
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().togglePanel("scenes");
      expect(mockAddPanel).toHaveBeenCalledWith(
        expect.objectContaining({ id: "scenes" }),
      );
    });
  });
});
