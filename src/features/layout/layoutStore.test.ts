import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  useLayoutStore,
  clearSavedLayout,
  resolveInsertPosition,
  resolveInsertPositionForRegion,
} from "./layoutStore";
import {
  DEFAULT_STRIPE_SIZES,
  DEFAULT_STRIPE_VISIBILITY,
} from "./toolWindowDefaults";
import type { DockviewApi } from "dockview-react";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

function resetStore() {
  useLayoutStore.setState({
    dockviewApi: null,
    toolWindows: {},
    undockedPanels: new Set(),
    stripePanelIds: new Set(),
    stripeSizes: { ...DEFAULT_STRIPE_SIZES },
    stripeVisibility: { ...DEFAULT_STRIPE_VISIBILITY },
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

  describe("togglePanel", () => {
    it("removes panel when it is the active tab", () => {
      const mockSetActive = vi.fn();
      const mockRemovePanel = vi.fn();
      const mockPanel = {
        api: { setActive: mockSetActive },
        group: { activePanel: null as unknown },
      };
      mockPanel.group.activePanel = mockPanel; // panel is its own active
      const mockApi = {
        getPanel: vi.fn().mockReturnValue(mockPanel),
        removePanel: mockRemovePanel,
        addPanel: vi.fn(),
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().togglePanel("scenes");
      expect(mockRemovePanel).toHaveBeenCalledWith(mockPanel);
      expect(mockSetActive).not.toHaveBeenCalled();
    });

    it("calls setActive when panel exists but is not the active tab", () => {
      const mockSetActive = vi.fn();
      const mockRemovePanel = vi.fn();
      const mockPanel = {
        api: { setActive: mockSetActive },
        group: { activePanel: { id: "codex" } },
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

  describe("resolveInsertPositionForRegion", () => {
    function makeApi(existing: string[]): Pick<DockviewApi, "getPanel"> {
      return {
        getPanel: vi
          .fn()
          .mockImplementation((id: string) =>
            existing.includes(id) ? { id } : undefined,
          ),
      } as unknown as Pick<DockviewApi, "getPanel">;
    }

    it("joins existing left-region panel when present", () => {
      // scenes は left region のデフォルトメンバー
      const api = makeApi(["scenes"]);
      expect(
        resolveInsertPositionForRegion(api as DockviewApi, "left"),
      ).toEqual({ referencePanel: "scenes", direction: "within" });
    });

    it("joins existing right-region panel when present", () => {
      const api = makeApi(["chat"]);
      expect(
        resolveInsertPositionForRegion(api as DockviewApi, "right"),
      ).toEqual({ referencePanel: "chat", direction: "within" });
    });

    it("joins existing bottom-region panel when present", () => {
      const api = makeApi(["timeline"]);
      expect(
        resolveInsertPositionForRegion(api as DockviewApi, "bottom"),
      ).toEqual({ referencePanel: "timeline", direction: "within" });
    });

    it("falls back to direction:left when no left panels exist", () => {
      const api = makeApi([]);
      expect(
        resolveInsertPositionForRegion(api as DockviewApi, "left"),
      ).toEqual({ direction: "left" });
    });

    it("falls back to direction:right when no right panels exist", () => {
      const api = makeApi([]);
      expect(
        resolveInsertPositionForRegion(api as DockviewApi, "right"),
      ).toEqual({ direction: "right" });
    });

    it("falls back to direction:below when no bottom panels exist", () => {
      const api = makeApi([]);
      expect(
        resolveInsertPositionForRegion(api as DockviewApi, "bottom"),
      ).toEqual({ direction: "below" });
    });

    it("ignores editor when joining (editor split invariant)", () => {
      // editor が左にあっても left region の join anchor にはならない
      const api = makeApi(["editor"]);
      expect(
        resolveInsertPositionForRegion(api as DockviewApi, "left"),
      ).toEqual({ direction: "left" });
    });

    it("uses effective slot (user override) when finding region anchors", () => {
      // snippets はデフォルト BR (bottom) だが LT (left) に override されている。
      // left region の anchor を探すと snippets がヒットすべき。
      const api = makeApi(["snippets"]);
      const toolWindows = {
        snippets: { slot: "LT" as const, viewMode: "docked-pinned" as const },
      };
      expect(
        resolveInsertPositionForRegion(api as DockviewApi, "left", toolWindows),
      ).toEqual({ referencePanel: "snippets", direction: "within" });
    });

    it("ignores panels moved out of region via override", () => {
      // scenes はデフォルト LT (left) だが RT (right) に移動されている。
      // left region の anchor を探しても scenes はヒットしない。
      const api = makeApi(["scenes"]);
      const toolWindows = {
        scenes: { slot: "RT" as const, viewMode: "docked-pinned" as const },
      };
      expect(
        resolveInsertPositionForRegion(api as DockviewApi, "left", toolWindows),
      ).toEqual({ direction: "left" });
    });
  });

  describe("openPanelAtSlot", () => {
    it("adds command-center-results to the left region (within scenes if present)", () => {
      const mockAddPanel = vi.fn();
      const mockApi = {
        getPanel: vi
          .fn()
          .mockImplementation((id: string) =>
            id === "scenes" ? { id: "scenes" } : undefined,
          ),
        addPanel: mockAddPanel,
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().openPanelAtSlot("command-center-results");
      expect(mockAddPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "command-center-results",
          position: { referencePanel: "scenes", direction: "within" },
        }),
      );
    });

    it("adds command-center-results to direction:left when no left anchors", () => {
      const mockAddPanel = vi.fn();
      const mockApi = {
        getPanel: vi.fn().mockReturnValue(undefined),
        addPanel: mockAddPanel,
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().openPanelAtSlot("command-center-results");
      expect(mockAddPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "command-center-results",
          position: { direction: "left" },
        }),
      );
    });

    it("setActive when panel already exists (saved layout 優先)", () => {
      const mockSetActive = vi.fn();
      const mockAddPanel = vi.fn();
      const mockApi = {
        getPanel: vi.fn().mockReturnValue({
          api: { setActive: mockSetActive },
        }),
        addPanel: mockAddPanel,
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().openPanelAtSlot("scenes");
      expect(mockSetActive).toHaveBeenCalled();
      expect(mockAddPanel).not.toHaveBeenCalled();
    });

    it("respects user override slot (codex moved to right region)", () => {
      const mockAddPanel = vi.fn();
      const mockApi = {
        getPanel: vi
          .fn()
          .mockImplementation((id: string) =>
            id === "chat" ? { id: "chat" } : undefined,
          ),
        addPanel: mockAddPanel,
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({
        dockviewApi: mockApi as never,
        toolWindows: {
          codex: { slot: "RT", viewMode: "docked-pinned" },
        },
      });
      useLayoutStore.getState().openPanelAtSlot("codex");
      // RT は right region。chat (right) と within
      expect(mockAddPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "codex",
          position: { referencePanel: "chat", direction: "within" },
        }),
      );
    });

    it("editor goes to direction:right with minimumWidth (legacy fallback)", () => {
      const mockAddPanel = vi.fn();
      const mockApi = {
        getPanel: vi.fn().mockReturnValue(undefined),
        addPanel: mockAddPanel,
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().openPanelAtSlot("editor");
      expect(mockAddPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "editor",
          minimumWidth: 320,
          position: { direction: "right" },
        }),
      );
    });

    it("skips when panel is undocked (Phase 3 overlay 担当)", () => {
      const mockAddPanel = vi.fn();
      const mockSetActive = vi.fn();
      const mockApi = {
        getPanel: vi.fn().mockReturnValue(undefined),
        addPanel: mockAddPanel,
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({
        dockviewApi: mockApi as never,
        undockedPanels: new Set(["chat"]),
      });
      useLayoutStore.getState().openPanelAtSlot("chat");
      expect(mockAddPanel).not.toHaveBeenCalled();
      expect(mockSetActive).not.toHaveBeenCalled();
    });
  });

  describe("showPanel routes through openPanelAtSlot", () => {
    it("setActive when panel exists", () => {
      const mockSetActive = vi.fn();
      const mockApi = {
        getPanel: vi.fn().mockReturnValue({
          api: { setActive: mockSetActive },
        }),
        addPanel: vi.fn(),
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().showPanel("scenes");
      expect(mockSetActive).toHaveBeenCalled();
    });

    it("adds panel via region resolver when absent", () => {
      const mockAddPanel = vi.fn();
      const mockApi = {
        getPanel: vi.fn().mockReturnValue(undefined),
        addPanel: mockAddPanel,
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().showPanel("command-center-results");
      expect(mockAddPanel).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "command-center-results",
          position: { direction: "left" },
        }),
      );
    });
  });

  describe("setToolWindowSlot persists with layout", () => {
    it("calls save_global_settings with toolWindows merged", async () => {
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
      const mockApi = {
        toJSON: vi.fn().mockReturnValue(validLayout),
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };

      mockInvoke
        .mockResolvedValueOnce({
          recentWorkspaces: [],
          lastActiveWorkspace: null,
          theme: "system",
          showLauncherOnStartup: false,
        })
        .mockResolvedValueOnce(undefined);

      useLayoutStore.setState({ dockviewApi: mockApi as never });
      useLayoutStore.getState().setToolWindowSlot("snippets", "RT");

      await vi.advanceTimersByTimeAsync(600);

      expect(mockInvoke).toHaveBeenCalledWith("save_global_settings", {
        settings: expect.objectContaining({
          layout: validLayout,
          toolWindows: expect.objectContaining({
            snippets: { slot: "RT", viewMode: "docked-pinned" },
          }),
        }),
      });
    });
  });

  describe("setDockviewApi auto-tracks stripePanelIds", () => {
    it("adds panel id to stripePanelIds when onDidAddPanel fires", () => {
      let addPanelHandler: ((panel: { id: string }) => void) | null = null;
      const mockApi = {
        onDidAddGroup: vi.fn(),
        onDidAddPanel: vi.fn().mockImplementation((cb) => {
          addPanelHandler = cb;
          return { dispose: vi.fn() };
        }),
        onDidLayoutChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      };
      useLayoutStore.getState().setDockviewApi(mockApi as never);
      expect(addPanelHandler).not.toBeNull();
      addPanelHandler!({ id: "scenes" });
      expect(useLayoutStore.getState().stripePanelIds.has("scenes")).toBe(true);
    });

    it("does not register editor in stripePanelIds", () => {
      let addPanelHandler: ((panel: { id: string }) => void) | null = null;
      const mockApi = {
        onDidAddGroup: vi.fn(),
        onDidAddPanel: vi.fn().mockImplementation((cb) => {
          addPanelHandler = cb;
          return { dispose: vi.fn() };
        }),
        onDidLayoutChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
      };
      useLayoutStore.getState().setDockviewApi(mockApi as never);
      addPanelHandler!({ id: "editor" });
      expect(useLayoutStore.getState().stripePanelIds.has("editor")).toBe(
        false,
      );
    });
  });

  describe("removePanelFromStripe", () => {
    it("removes id from stripePanelIds and schedules save", async () => {
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
      const mockApi = {
        toJSON: vi.fn().mockReturnValue(validLayout),
        onDidAddGroup: vi.fn(),
        onDidLayoutChange: vi.fn(),
      };
      mockInvoke
        .mockResolvedValueOnce({
          recentWorkspaces: [],
          lastActiveWorkspace: null,
          theme: "system",
          showLauncherOnStartup: false,
        })
        .mockResolvedValueOnce(undefined);

      useLayoutStore.setState({
        dockviewApi: mockApi as never,
        stripePanelIds: new Set(["scenes", "chat"]),
      });
      useLayoutStore.getState().removePanelFromStripe("scenes");
      expect(useLayoutStore.getState().stripePanelIds.has("scenes")).toBe(
        false,
      );
      expect(useLayoutStore.getState().stripePanelIds.has("chat")).toBe(true);

      await vi.advanceTimersByTimeAsync(600);
      expect(mockInvoke).toHaveBeenCalledWith("save_global_settings", {
        settings: expect.objectContaining({
          stripePanelIds: ["chat"],
        }),
      });
    });

    it("is a no-op when panel is not in stripePanelIds", () => {
      useLayoutStore.setState({
        stripePanelIds: new Set(["scenes"]),
      });
      const before = useLayoutStore.getState().stripePanelIds;
      useLayoutStore.getState().removePanelFromStripe("chat");
      expect(useLayoutStore.getState().stripePanelIds).toBe(before);
    });
  });
});
