import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SPLITTER_GUTTER_PX, STRIPE_SIZE } from "./layoutConstants";
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
    dragOverTarget: null,
    panelDragSource: null,
    activePresetId: null,
    customPresets: [],
    initialized: false,
    hiddenStripePanels: new Set(),
  });
}

function assertValidLayout(state: LayoutState) {
  const result = validateLayoutState(state, { viewport: VIEWPORT });
  expect(
    result.valid,
    result.valid ? "" : (result as { reason: string }).reason,
  ).toBe(true);
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

    it("showPanel('editor') opens the editor column", () => {
      useLayoutStore.getState().setEditorOpen(false);
      useLayoutStore.getState().showPanel("editor");
      expect(useLayoutStore.getState().layout.center.editorOpen).toBe(true);
    });
  });

  describe("togglePanel editor", () => {
    it("toggles editor open state", () => {
      expect(useLayoutStore.getState().layout.center.editorOpen).toBe(true);
      useLayoutStore.getState().togglePanel("editor");
      expect(useLayoutStore.getState().layout.center.editorOpen).toBe(false);
      useLayoutStore.getState().togglePanel("editor");
      expect(useLayoutStore.getState().layout.center.editorOpen).toBe(true);
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

  describe("movePanelToSlot", () => {
    it("redistributes ratios when an open slot is removed from the source region", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().showPanel("codex");

      const layoutBefore = useLayoutStore.getState().layout;
      layoutBefore.regions.left.slots.find(
        (slot) => slot.id === "l0",
      )!.sizeRatio = 0.6;
      layoutBefore.regions.left.slots.find(
        (slot) => slot.id === "l1",
      )!.sizeRatio = 0.4;
      useLayoutStore.setState({ layout: layoutBefore });

      useLayoutStore.getState().movePanelToRegion("scenes", "right");

      const openLeft = useLayoutStore
        .getState()
        .layout.regions.left.slots.filter((slot) => slot.activePanel !== null);
      expect(openLeft).toHaveLength(1);
      expect(openLeft[0]?.id).toBe("l1");
      expect(openLeft[0]?.sizeRatio).toBeCloseTo(1);
      assertValidLayout(useLayoutStore.getState().layout);
    });
  });

  describe("movePanelToNewSlot", () => {
    const slotOrder = () =>
      useLayoutStore
        .getState()
        .layout.regions.left.slots.map((s) =>
          s.panels.includes("scenes")
            ? "scenes"
            : s.panels.includes("chat")
              ? "chat"
              : s.panels.includes("codex")
                ? "codex"
                : "other",
        );

    it("inserts at the dropped position when a same-region source slot is removed", () => {
      // left: [l0(scenes), l1(codex…), chatSlot]
      useLayoutStore.getState().movePanelToNewSlot("chat", "left", 2);
      // Move scenes (l0, index 0, single-panel → l0 removed) before the chat slot.
      // insertIndex 2 is pre-removal; after l0 is removed it must become 1.
      useLayoutStore.getState().movePanelToNewSlot("scenes", "left", 2);

      expect(slotOrder()).toEqual(["codex", "scenes", "chat"]);
      assertValidLayout(useLayoutStore.getState().layout);
    });

    it("does not shift the insert position when the source slot sits after it", () => {
      useLayoutStore.getState().movePanelToNewSlot("chat", "left", 2);
      // chat slot is at index 2; dropping at index 0 must not be decremented.
      useLayoutStore.getState().movePanelToNewSlot("chat", "left", 0);

      expect(slotOrder()[0]).toBe("chat");
      assertValidLayout(useLayoutStore.getState().layout);
    });
  });

  describe("setRegionSize", () => {
    it("clamps region size", () => {
      useLayoutStore.getState().setRegionSize("left", 50, VIEWPORT);
      expect(useLayoutStore.getState().layout.regions.left.size).toBe(120);
    });
  });

  describe("nudgeRegionSize", () => {
    it("accumulates drag deltas from current store size", () => {
      useLayoutStore.getState().showPanel("scenes");
      const start = useLayoutStore.getState().layout.regions.left.size;
      useLayoutStore.getState().nudgeRegionSize("left", 20, VIEWPORT);
      useLayoutStore.getState().nudgeRegionSize("left", 15, VIEWPORT);
      expect(useLayoutStore.getState().layout.regions.left.size).toBe(
        start + 35,
      );
    });

    it("no-ops when layout is locked", () => {
      useLayoutStore.getState().showPanel("scenes");
      const start = useLayoutStore.getState().layout.regions.left.size;
      useLayoutStore.setState({ layoutLocked: true });
      useLayoutStore.getState().nudgeRegionSize("left", 40, VIEWPORT);
      expect(useLayoutStore.getState().layout.regions.left.size).toBe(start);
    });

    it("shrinks right region when nudged with negative delta", () => {
      useLayoutStore.getState().showPanel("chat");
      const start = useLayoutStore.getState().layout.regions.right.size;
      useLayoutStore.getState().nudgeRegionSize("right", -30, VIEWPORT);
      expect(useLayoutStore.getState().layout.regions.right.size).toBe(
        start - 30,
      );
    });

    it("allows right region beyond 50% viewport when center band is visible", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().showPanel("chat");
      const vp = { width: 1366, height: 768 };
      useLayoutStore.getState().setRegionSize("left", 200, vp);
      const halfCap = Math.floor(vp.width * 0.5);
      useLayoutStore.getState().setRegionSize("right", halfCap + 120, vp);
      expect(
        useLayoutStore.getState().layout.regions.right.size,
      ).toBeGreaterThan(halfCap);
    });

    it("grows bottom region when nudged with positive delta", () => {
      useLayoutStore.getState().showPanel("grid");
      const start = useLayoutStore.getState().layout.regions.bottom.size;
      useLayoutStore.getState().nudgeRegionSize("bottom", 40, VIEWPORT);
      expect(useLayoutStore.getState().layout.regions.bottom.size).toBe(
        start + 40,
      );
    });
  });

  describe("nudgeAdjacentSlotSizes", () => {
    it("updates slot ratios from current pixel sizes", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().showPanel("codex");
      useLayoutStore.getState().setRegionSize("left", 300, VIEWPORT);
      useLayoutStore
        .getState()
        .nudgeAdjacentSlotSizes("left", "l0", "l1", 30, 800);
      const open = useLayoutStore
        .getState()
        .layout.regions.left.slots.filter((s) => s.activePanel !== null);
      const l0 = open.find((s) => s.id === "l0");
      const l1 = open.find((s) => s.id === "l1");
      expect(l0?.sizeRatio).toBeGreaterThan(l1?.sizeRatio ?? 0);
    });
  });

  describe("finalizeLayoutResize", () => {
    it("clamps combined horizontal regions after drag", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().showPanel("chat");
      useLayoutStore.getState().setRegionSize("left", 500, VIEWPORT);
      useLayoutStore.getState().setRegionSize("right", 500, VIEWPORT);
      useLayoutStore.getState().finalizeLayoutResize();
      const { left, right } = useLayoutStore.getState().layout.regions;
      const fixedChrome = STRIPE_SIZE * 2 + SPLITTER_GUTTER_PX * 2;
      expect(left.size + right.size).toBeLessThanOrEqual(
        VIEWPORT.width - 320 - fixedChrome,
      );
      assertValidLayout(useLayoutStore.getState().layout);
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

    it("plan preset allows left region past 50% when editor band is hidden", () => {
      const vp = { width: 1366, height: 768 };
      vi.stubGlobal("innerWidth", vp.width);
      vi.stubGlobal("innerHeight", vp.height);
      useLayoutStore.getState().applyPreset("builtin:plan");
      const halfCap = Math.floor(vp.width * 0.5);
      useLayoutStore.getState().setRegionSize("left", halfCap + 250, vp);
      useLayoutStore.getState().finalizeLayoutResize();
      expect(
        useLayoutStore.getState().layout.regions.left.size,
      ).toBeGreaterThan(halfCap);
      expect(
        validateLayoutState(useLayoutStore.getState().layout, { viewport: vp })
          .valid,
      ).toBe(true);
      vi.unstubAllGlobals();
    });
  });

  describe("initializeLayout migration", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("applies write preset when old Dockview layout is stored", async () => {
      mockInvoke.mockResolvedValueOnce({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: { grid: { root: {} }, panels: {} },
        toolWindows: { scenes: { slot: "LT" } },
      });

      await useLayoutStore.getState().initializeLayout();
      const { layout, activePresetId } = useLayoutStore.getState();
      assertValidLayout(layout);
      expect(collectPanels(layout)).toHaveLength(TOOL_WINDOW_PANEL_IDS.length);
      expect(activePresetId).toBe("builtin:default");
      expect(
        layout.regions.left.slots.find((s) => s.id === "l0")?.activePanel,
      ).toBe("scenes");
      expect(
        layout.regions.right.slots.some((s) => s.activePanel === "chat"),
      ).toBe(true);
    });

    it("migrates v2 persisted layout to v3 center state", async () => {
      const full = buildDefaultLayoutState({ allInactive: true });
      full.regions.left.slots[0].activePanel = "scenes";
      const savedV2 = { regions: full.regions };
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: { layoutVersion: 2, state: savedV2 },
        layoutPresets: [],
      });

      await useLayoutStore.getState().initializeLayout();
      const { layout } = useLayoutStore.getState();
      expect(
        layout.regions.left.slots.find((s) => s.id === "l0")?.activePanel,
      ).toBe("scenes");
      expect(layout.center.editorOpen).toBe(true);
      expect(layout.center.segments.some((s) => s.kind === "editor")).toBe(
        true,
      );
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
        TOOL_WINDOW_PANEL_IDS[
          Math.floor(rand() * TOOL_WINDOW_PANEL_IDS.length)
        ];
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

  it("setDragOverTarget tracks hovered drop zone and clears on drag end", () => {
    useLayoutStore.getState().setDraggingPanel("chat");
    useLayoutStore.getState().setDragOverTarget({
      type: "slot",
      region: "left",
      slotId: "l0",
    });
    expect(useLayoutStore.getState().dragOverTarget).toEqual({
      type: "slot",
      region: "left",
      slotId: "l0",
    });

    useLayoutStore.getState().setDraggingPanel(null);
    expect(useLayoutStore.getState().dragOverTarget).toBeNull();
  });

  it("toggle twice collapses panel", () => {
    useLayoutStore.getState().togglePanel("chat");
    useLayoutStore.getState().togglePanel("chat");
    const loc = findPanelLocation(useLayoutStore.getState().layout, "chat");
    expect(loc?.slot.activePanel).toBeNull();
  });

  it("removePanelFromStripe hides icon and re-shows on showPanel", () => {
    useLayoutStore.getState().showPanel("chat");
    useLayoutStore.getState().removePanelFromStripe("chat");
    expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(true);
    expect(useLayoutStore.getState().isPanelActive("chat")).toBe(false);

    useLayoutStore.getState().showPanel("chat");
    expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(
      false,
    );
    expect(useLayoutStore.getState().isPanelActive("chat")).toBe(true);
  });

  it("setSlotRatios keeps third slot visible with 3 open slots", () => {
    useLayoutStore.getState().showPanel("scenes");
    useLayoutStore.getState().showPanel("codex");
    useLayoutStore.getState().movePanelToNewSlot("chat", "left", 2);
    useLayoutStore.getState().setRegionSize("left", 300, VIEWPORT);
    useLayoutStore.getState().setSlotRatios("left", "l0", "l1", 150, 100, 800);
    const open = useLayoutStore
      .getState()
      .layout.regions.left.slots.filter((s) => s.activePanel !== null);
    expect(open).toHaveLength(3);
    const minRatio = Math.min(...open.map((s) => s.sizeRatio));
    expect(minRatio).toBeGreaterThan(0.05);
  });
});
