// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@/lib/tauri";
import { useLayoutStore } from "./layoutStore";
import { buildDefaultLayoutState } from "./layoutStateUtils";

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
});
