import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { useLayoutStore } from "./layoutStore";
import {
  buildDefaultLayoutState,
  findPanelLocation,
  validateLayoutState,
} from "./layoutStateUtils";
import { TOOL_WINDOW_PANEL_IDS } from "./toolWindowDefaults";
import type { LayoutState, RegionId, ToolWindowPanelId } from "./layoutTypes";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
const mockInvoke = vi.mocked(invoke);

const VIEWPORT = { width: 1200, height: 800 };

function resetStore() {
  useLayoutStore.setState({
    layout: buildDefaultLayoutState({ allInactive: true }),
    layoutLocked: false,
    draggingPanel: null,
    activePresetId: null,
    customPresets: [],
    initialized: false,
  });
}

function assertValidLayout(state: LayoutState) {
  const result = validateLayoutState(state, { viewport: VIEWPORT });
  expect(result.valid, result.valid ? "" : (result as { reason: string }).reason).toBe(
    true,
  );
}

function collectPanels(state: LayoutState): ToolWindowPanelId[] {
  return Object.values(state.regions).flatMap((r) =>
    r.slots.flatMap((s) => s.panels),
  );
}

describe("useLayoutStore", () => {
  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
  });

  describe("togglePanel", () => {
    it("activates a collapsed panel", () => {
      useLayoutStore.getState().togglePanel("scenes");
      const slot = useLayoutStore
        .getState()
        .layout.regions.left.slots.find((s) => s.id === "l0");
      expect(slot?.activePanel).toBe("scenes");
      assertValidLayout(useLayoutStore.getState().layout);
    });

    it("collapses an active panel", () => {
      useLayoutStore.getState().togglePanel("scenes");
      useLayoutStore.getState().togglePanel("scenes");
      const slot = useLayoutStore
        .getState()
        .layout.regions.left.slots.find((s) => s.id === "l0");
      expect(slot?.activePanel).toBeNull();
    });
  });

  describe("showPanel", () => {
    it("switches active panel within slot", () => {
      useLayoutStore.getState().showPanel("codex");
      useLayoutStore.getState().showPanel("codex-quick");
      const slot = useLayoutStore
        .getState()
        .layout.regions.left.slots.find((s) => s.id === "l1");
      expect(slot?.activePanel).toBe("codex-quick");
    });

    it("showPanel('editor') is a no-op crash", () => {
      expect(() => useLayoutStore.getState().showPanel("editor")).not.toThrow();
    });
  });

  describe("movePanelToRegion", () => {
    it("moves panel and activates in target region", () => {
      useLayoutStore.getState().movePanelToRegion("scenes", "right");
      const { layout } = useLayoutStore.getState();
      expect(
        layout.regions.left.slots.some((s) => s.panels.includes("scenes")),
      ).toBe(false);
      expect(layout.regions.right.slots.at(-1)?.activePanel).toBe("scenes");
      assertValidLayout(layout);
    });
  });

  describe("setRegionSize", () => {
    it("clamps region size", () => {
      useLayoutStore.getState().setRegionSize("left", 50, VIEWPORT);
      expect(useLayoutStore.getState().layout.regions.left.size).toBe(120);
    });
  });

  describe("applyPreset", () => {
    it("applies builtin write preset with active panels", () => {
      useLayoutStore.getState().applyPreset("builtin:default");
      const { layout } = useLayoutStore.getState();
      expect(
        layout.regions.left.slots.find((s) => s.id === "l0")?.activePanel,
      ).toBe("scenes");
      expect(useLayoutStore.getState().activePresetId).toBe("builtin:default");
    });

    it("applies plan preset on laptop viewport without empty fallback", () => {
      vi.stubGlobal("innerWidth", 1366);
      vi.stubGlobal("innerHeight", 768);
      useLayoutStore.getState().applyPreset("builtin:plan");
      const { layout } = useLayoutStore.getState();
      expect(
        validateLayoutState(layout, { viewport: { width: 1366, height: 768 } })
          .valid,
      ).toBe(true);
      expect(
        layout.regions.bottom.slots.some(
          (s) => s.activePanel === "grid" || s.activePanel === "timeline",
        ),
      ).toBe(true);
      expect(
        layout.regions.right.slots.some((s) => s.activePanel === "chat"),
      ).toBe(true);
      vi.unstubAllGlobals();
    });
  });

  describe("initializeLayout migration", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("resets to default when old Dockview layout is stored", async () => {
      mockInvoke.mockResolvedValueOnce({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: { grid: { root: {} }, panels: {} },
        toolWindows: { scenes: { slot: "LT" } },
      });

      await useLayoutStore.getState().initializeLayout();
      const { layout } = useLayoutStore.getState();
      assertValidLayout(layout);
      expect(collectPanels(layout)).toHaveLength(TOOL_WINDOW_PANEL_IDS.length);
      for (const region of Object.values(layout.regions)) {
        for (const slot of region.slots) {
          expect(slot.activePanel).toBeNull();
        }
      }
    });

    it("loads v2 persisted layout when valid", async () => {
      const saved = buildDefaultLayoutState({ allInactive: true });
      saved.regions.left.slots[0].activePanel = "scenes";
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: { layoutVersion: 2, state: saved },
        layoutPresets: [],
      });

      await useLayoutStore.getState().initializeLayout();
      expect(
        useLayoutStore
          .getState()
          .layout.regions.left.slots.find((s) => s.id === "l0")?.activePanel,
      ).toBe("scenes");
    });
  });
});

describe("layout store property invariants", () => {
  const REGIONS: RegionId[] = ["left", "right", "bottom"];

  beforeEach(() => {
    resetStore();
  });

  it("maintains valid layout across random operations", () => {
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    for (let i = 0; i < 100; i++) {
      const store = useLayoutStore.getState();
      const panel =
        TOOL_WINDOW_PANEL_IDS[Math.floor(rand() * TOOL_WINDOW_PANEL_IDS.length)];
      const region = REGIONS[Math.floor(rand() * REGIONS.length)];
      const op = Math.floor(rand() * 4);

      switch (op) {
        case 0:
          store.togglePanel(panel);
          break;
        case 1:
          store.showPanel(panel);
          break;
        case 2:
          store.movePanelToRegion(panel, region);
          break;
        case 3:
          store.setRegionSize(region, 100 + Math.floor(rand() * 500), VIEWPORT);
          break;
      }

      assertValidLayout(useLayoutStore.getState().layout);
    }
  });

  it("toggle twice collapses panel", () => {
    useLayoutStore.getState().togglePanel("chat");
    useLayoutStore.getState().togglePanel("chat");
    const loc = findPanelLocation(useLayoutStore.getState().layout, "chat");
    expect(loc?.slot.activePanel).toBeNull();
  });

  it("setSlotRatios keeps third slot visible with 3 open slots", () => {
    useLayoutStore.getState().showPanel("scenes");
    useLayoutStore.getState().showPanel("codex");
    useLayoutStore.getState().movePanelToNewSlot("chat", "left", 2);
    useLayoutStore.getState().setRegionSize("left", 300, VIEWPORT);
    useLayoutStore
      .getState()
      .setSlotRatios("left", "l0", "l1", 150, 100);
    const open = useLayoutStore
      .getState()
      .layout.regions.left.slots.filter((s) => s.activePanel !== null);
    expect(open).toHaveLength(3);
    const minRatio = Math.min(...open.map((s) => s.sizeRatio));
    expect(minRatio).toBeGreaterThan(0.05);
  });
});
