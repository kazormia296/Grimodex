import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SPLITTER_GUTTER_PX, STRIPE_SIZE } from "./layoutConstants";
import { useLayoutStore } from "./layoutStore";
import {
  buildDefaultLayoutState,
  findPanelLocation,
  validateLayoutState,
} from "./layoutStateUtils";
import { TOOL_WINDOW_PANEL_IDS } from "./toolWindowDefaults";
import { getBuiltinPresetHiddenPanels } from "./layoutPresets";
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
    builtinPresetOverrides: {},
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

  describe("setEditorOpen", () => {
    it("preserves center segment ratios across hide and show", () => {
      // editor + 1 center tool（editor を広め 0.7 / tool 0.3 に設定）
      useLayoutStore.getState().movePanelToNewSlot("scenes", "center", 1);
      useLayoutStore.setState((s) => ({
        layout: {
          ...s.layout,
          center: {
            ...s.layout.center,
            segments: s.layout.center.segments.map((seg) =>
              seg.kind === "editor"
                ? { ...seg, sizeRatio: 0.7 }
                : { ...seg, sizeRatio: 0.3 },
            ),
          },
        },
      }));

      useLayoutStore.getState().setEditorOpen(false);
      useLayoutStore.getState().setEditorOpen(true);

      const segments = useLayoutStore.getState().layout.center.segments;
      const editor = segments.find((s) => s.kind === "editor");
      const tool = segments.find((s) => s.kind === "tool");
      expect(editor?.sizeRatio).toBeCloseTo(0.7, 5);
      expect(tool?.sizeRatio).toBeCloseTo(0.3, 5);
      assertValidLayout(useLayoutStore.getState().layout);
    });

    it("restores side region sizes across an editor-only hide and show", () => {
      // editor 単独 (center tool 無し)、左右 region を固定サイズで開く
      const base = buildDefaultLayoutState({ editorOpen: true });
      useLayoutStore.setState({
        layout: {
          ...base,
          regions: {
            ...base.regions,
            left: { ...base.regions.left, size: 200 },
            right: { ...base.regions.right, size: 180 },
          },
        },
      });

      useLayoutStore.getState().setEditorOpen(false);
      useLayoutStore.getState().setEditorOpen(true);

      const { regions } = useLayoutStore.getState().layout;
      expect(regions.left.size).toBe(200);
      expect(regions.right.size).toBe(180);
      assertValidLayout(useLayoutStore.getState().layout);
    });

    it("clears the restore memory when a region is resized while collapsed", () => {
      const base = buildDefaultLayoutState({ editorOpen: true });
      useLayoutStore.setState({
        layout: {
          ...base,
          regions: {
            ...base.regions,
            left: { ...base.regions.left, size: 200 },
            right: { ...base.regions.right, size: 180 },
          },
        },
      });

      useLayoutStore.getState().setEditorOpen(false);
      expect(
        useLayoutStore.getState().layout.collapsedEditorRegionSizes,
      ).toBeTruthy();

      // collapse 中に region を手動リサイズ → 復元メモリは破棄される
      useLayoutStore.getState().nudgeRegionSize("left", -40);
      expect(
        useLayoutStore.getState().layout.collapsedEditorRegionSizes,
      ).toBeUndefined();
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

    it("is a no-op when a single-panel center tool segment is dropped onto itself", () => {
      useLayoutStore.getState().movePanelToNewSlot("scenes", "center", 1);
      const segment = useLayoutStore
        .getState()
        .layout.center.segments.find((s) => s.id !== "ceditor")!;
      const layoutBefore = useLayoutStore.getState().layout;

      useLayoutStore.getState().movePanelToSlot("scenes", "center", segment.id);

      const layoutAfter = useLayoutStore.getState().layout;
      expect(layoutAfter.center.segments).toEqual(layoutBefore.center.segments);
      expect(layoutAfter.center.editorOpen).toBe(true);
      expect(findPanelLocation(layoutAfter, "scenes")?.region).toBe("center");
      assertValidLayout(layoutAfter);
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

    it("allows left region past 50% when the editor band is fully hidden", () => {
      const vp = { width: 1366, height: 768 };
      vi.stubGlobal("innerWidth", vp.width);
      vi.stubGlobal("innerHeight", vp.height);
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().showPanel("chat");
      useLayoutStore.getState().setEditorOpen(false);
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

  describe("builtin preset overrides", () => {
    it("saveCurrentAsBuiltinPreset and applyPreset restore overridden layout", async () => {
      useLayoutStore.getState().applyPreset("builtin:default");
      useLayoutStore.getState().showPanel("grid");
      useLayoutStore.getState().removePanelFromStripe("chat");
      expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(
        true,
      );

      await useLayoutStore
        .getState()
        .saveCurrentAsBuiltinPreset("builtin:default");

      expect(
        useLayoutStore.getState().hasBuiltinPresetOverride("builtin:default"),
      ).toBe(true);
      expect(
        useLayoutStore.getState().builtinPresetOverrides["builtin:default"]
          ?.hiddenStripePanels,
      ).toEqual(["map", "matrix", "trash-bin", "chat"]);

      useLayoutStore.getState().applyPreset("builtin:plan");
      expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(
        false,
      );

      useLayoutStore.getState().applyPreset("builtin:default");
      expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(
        true,
      );
      const loc = findPanelLocation(useLayoutStore.getState().layout, "grid");
      expect(loc).not.toBeNull();
    });

    it("resetBuiltinPresetToDefault restores factory builtin layout", async () => {
      useLayoutStore.getState().applyPreset("builtin:default");
      useLayoutStore.getState().showPanel("grid");
      await useLayoutStore
        .getState()
        .saveCurrentAsBuiltinPreset("builtin:default");

      await useLayoutStore
        .getState()
        .resetBuiltinPresetToDefault("builtin:default");

      expect(
        useLayoutStore.getState().hasBuiltinPresetOverride("builtin:default"),
      ).toBe(false);
      expect(
        findPanelLocation(useLayoutStore.getState().layout, "grid")?.slot
          .activePanel,
      ).toBeNull();
      expect(
        useLayoutStore
          .getState()
          .layout.regions.left.slots.find((s) => s.id === "l0")?.activePanel,
      ).toBe("scenes");
    });

    it("loadPresets restores builtinLayoutPresetOverrides", async () => {
      const state = buildDefaultLayoutState({ allInactive: true });
      state.regions.left.slots[0].activePanel = "grid";
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        builtinLayoutPresetOverrides: {
          "builtin:plan": { state, hiddenStripePanels: ["timeline"] },
        },
      });

      await useLayoutStore.getState().loadPresets();

      expect(
        useLayoutStore.getState().builtinPresetOverrides["builtin:plan"]?.state
          .regions.left.slots[0].activePanel,
      ).toBe("grid");
      expect(
        useLayoutStore.getState().builtinPresetOverrides["builtin:plan"]
          ?.hiddenStripePanels,
      ).toEqual(["timeline"]);
    });
  });

  describe("custom preset hiddenStripePanels", () => {
    it("saveCurrentAsPreset and applyPreset restore hidden stripe panels", async () => {
      vi.stubGlobal("crypto", {
        ...globalThis.crypto,
        randomUUID: () => "preset-hidden-chat",
      });

      useLayoutStore.getState().showPanel("chat");
      useLayoutStore.getState().removePanelFromStripe("chat");
      expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(
        true,
      );

      await useLayoutStore.getState().saveCurrentAsPreset("Hidden Chat");

      const saved = useLayoutStore
        .getState()
        .customPresets.find((p) => p.id === "preset-hidden-chat");
      expect(saved?.hiddenStripePanels).toEqual(["chat"]);

      useLayoutStore.getState().showPanel("chat");
      expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(
        false,
      );

      useLayoutStore.getState().applyPreset("preset-hidden-chat");
      expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(
        true,
      );

      vi.unstubAllGlobals();
    });

    it("loadPresets restores hiddenStripePanels on custom presets", async () => {
      const state = buildDefaultLayoutState({ allInactive: true });
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layoutPresets: [
          {
            id: "loaded-preset",
            name: "Loaded",
            state,
            hiddenStripePanels: ["codex"],
          },
        ],
      });

      await useLayoutStore.getState().loadPresets();

      expect(
        useLayoutStore
          .getState()
          .customPresets.find((p) => p.id === "loaded-preset")
          ?.hiddenStripePanels,
      ).toEqual(["codex"]);
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
        layout.center.segments.some(
          (s) => s.kind === "tool" && s.activePanel === "grid",
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

    // Regression: the screenshot preset path used to set `layout`/`activePresetId`
    // but not `hiddenStripePanels`, so preset captures rendered a stripe with
    // panels that the real preset hides.
    it("applies the preset's hiddenStripePanels for preset screenshot captures", async () => {
      const data = new Map<string, string>([
        ["grimodex:screenshot-mode", "true"],
        ["grimodex:screenshot-capture", "preset-review-1920x1080"],
        ["grimodex:screenshot-preset", "builtin:review"],
      ]);
      vi.stubGlobal("localStorage", {
        getItem: (k: string) => data.get(k) ?? null,
        setItem: (k: string, v: string) => void data.set(k, v),
        removeItem: (k: string) => void data.delete(k),
        clear: () => data.clear(),
        key: () => null,
        length: 0,
      });
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
      });

      await useLayoutStore.getState().initializeLayout();

      const { hiddenStripePanels, activePresetId } = useLayoutStore.getState();
      expect(activePresetId).toBe("builtin:review");
      const expected = getBuiltinPresetHiddenPanels("builtin:review");
      expect(expected.length).toBeGreaterThan(0);
      expect(hiddenStripePanels).toEqual(new Set(expected));
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
