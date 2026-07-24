// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/tauri";
import { useLayoutStore } from "./layoutStore";
import {
  buildDefaultLayoutState,
  cloneLayoutState,
  validateLayoutState,
} from "./layoutStateUtils";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

vi.mock("@/features/timelapse/captureLayout", () => ({
  recordLayoutSnapshot: vi.fn(),
}));

const mockInvoke = vi.mocked(invoke);

describe("mobile layout persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("innerWidth", 390);
    vi.stubGlobal("innerHeight", 844);
    vi.clearAllMocks();
    useLayoutStore.setState({
      layout: buildDefaultLayoutState({ allInactive: true }),
      layoutLocked: false,
      draggingPanel: null,
      dragOverTarget: null,
      panelDragSource: null,
      activePresetId: null,
      customPresets: [],
      builtinPresetOverrides: {},
      initialized: false,
      hiddenStripePanels: new Set(),
      maximizedPanelId: null,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not overwrite a saved desktop layout after phone hydration debounce", async () => {
    const desktopLayout = buildDefaultLayoutState({
      activePanels: {
        scenes: true,
        chat: true,
        timeline: true,
      },
    });
    desktopLayout.regions.left.size = 347;
    desktopLayout.regions.right.size = 389;
    desktopLayout.regions.bottom.size = 271;

    mockInvoke.mockResolvedValue({
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "system",
      showLauncherOnStartup: false,
      layout: {
        layoutVersion: 3,
        state: desktopLayout,
        activePresetId: "builtin:default",
      },
      layoutPresets: [],
    });

    await useLayoutStore.getState().initializeLayout();
    await vi.advanceTimersByTimeAsync(500);

    const saveCalls = mockInvoke.mock.calls.filter(
      ([command]) => command === "save_global_settings",
    );
    expect(saveCalls).toHaveLength(0);
  });

  it("clamps the desktop baseline when a phone widens to compact", async () => {
    mockInvoke.mockResolvedValue({
      recentWorkspaces: [],
      lastActiveWorkspace: null,
      theme: "system",
      showLauncherOnStartup: false,
      layoutPresets: [],
    });

    await useLayoutStore.getState().initializeLayout();
    const phoneBaseline = {
      layout: cloneLayoutState(useLayoutStore.getState().layout),
      activePresetId: useLayoutStore.getState().activePresetId,
      hiddenStripePanels: new Set(useLayoutStore.getState().hiddenStripePanels),
      maximizedPanelId: "editor" as const,
    };
    const compactViewport = { width: 720, height: 844 };

    expect(
      validateLayoutState(phoneBaseline.layout, {
        viewport: compactViewport,
      }).valid,
    ).toBe(false);

    vi.stubGlobal("innerWidth", compactViewport.width);
    vi.stubGlobal("innerHeight", compactViewport.height);
    useLayoutStore.getState().restoreViewportBaseline(phoneBaseline);

    const restored = useLayoutStore.getState();
    expect(
      validateLayoutState(restored.layout, {
        viewport: compactViewport,
      }).valid,
    ).toBe(true);
    expect(restored.layout.regions.left.size).toBeLessThan(
      phoneBaseline.layout.regions.left.size,
    );
    expect(restored.layout.regions.right.size).toBeLessThan(
      phoneBaseline.layout.regions.right.size,
    );
    expect(restored.activePresetId).toBe(phoneBaseline.activePresetId);
    expect(restored.maximizedPanelId).toBe("editor");
  });
});
