import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { SPLITTER_GUTTER_PX, STRIPE_SIZE } from "./layoutConstants";
import { useLayoutStore } from "./layoutStore";
import {
  buildDefaultLayoutState,
  findPanelLocation,
  getOverlays,
  restorePanelFromOverlay,
  validateLayoutState,
} from "./layoutStateUtils";
import { TOOL_WINDOW_PANEL_IDS } from "./toolWindowDefaults";
import { getBuiltinPresetHiddenPanels } from "./layoutPresets";
import type { LayoutState, RegionId, ToolWindowPanelId } from "./layoutTypes";

vi.mock("@/lib/tauri", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@/lib/tauri";
import { useInlineAiStore } from "@/features/editor/inlineAi/inlineAiStore";
const mockInvoke = vi.mocked(invoke);

const VIEWPORT = { width: 1200, height: 800 };

afterEach(() => {
  useInlineAiStore.getState().reset();
});

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
    openOverlay: null,
    maximizedPanelId: null,
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
    useInlineAiStore.getState().reset();
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
    it("keeps the source slot open with the next panel when the active panel moves away", () => {
      useLayoutStore.getState().showPanel("codex");
      useLayoutStore.getState().showPanel("chat");

      useLayoutStore.getState().movePanelToRegion("codex", "right");

      const sourceSlot = useLayoutStore
        .getState()
        .layout.regions.left.slots.find((s) => s.id === "l1");
      expect(sourceSlot?.activePanel).toBe("codex-quick");
      expect(sourceSlot?.panels).toEqual([
        "codex-quick",
        "command-center-results",
      ]);
      assertValidLayout(useLayoutStore.getState().layout);
    });

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

    it("opens a visible panel in the source bottom slot after moving the active panel away", () => {
      useLayoutStore.getState().showPanel("timeline");
      useLayoutStore.setState({
        hiddenStripePanels: new Set<ToolWindowPanelId>(["chronicle"]),
      });

      useLayoutStore.getState().movePanelToNewSlot("timeline", "bottom", 1);

      const sourceSlot = useLayoutStore
        .getState()
        .layout.regions.bottom.slots.find((slot) => slot.id === "b0");
      expect(sourceSlot?.panels).toEqual([
        "chronicle",
        "map",
        "grid",
        "matrix",
      ]);
      expect(sourceSlot?.activePanel).toBe("map");
      assertValidLayout(useLayoutStore.getState().layout);
    });

    it("does not open a hidden panel when the last visible panel leaves the source slot", () => {
      useLayoutStore.getState().showPanel("grid");
      useLayoutStore.setState({
        hiddenStripePanels: new Set<ToolWindowPanelId>([
          "timeline",
          "chronicle",
          "map",
          "matrix",
        ]),
      });

      useLayoutStore.getState().movePanelToNewSlot("grid", "bottom", 1);

      const sourceSlot = useLayoutStore
        .getState()
        .layout.regions.bottom.slots.find((slot) => slot.id === "b0");
      expect(sourceSlot?.panels).toEqual([
        "timeline",
        "chronicle",
        "map",
        "matrix",
      ]);
      expect(sourceSlot?.activePanel).toBeNull();
      assertValidLayout(useLayoutStore.getState().layout);
    });
  });

  describe("reorderPanelInSlot", () => {
    it("reorders panels within a multi-panel slot and keeps activePanel", () => {
      useLayoutStore.getState().showPanel("codex");
      const layout = useLayoutStore.getState().layout;
      const slot = layout.regions.left.slots.find((s) =>
        s.panels.includes("codex"),
      )!;
      expect(slot.panels.length).toBeGreaterThan(1);
      const activeBefore = slot.activePanel;

      useLayoutStore
        .getState()
        .reorderPanelInSlot("codex", "left", slot.id, slot.panels.length);

      const after = useLayoutStore
        .getState()
        .layout.regions.left.slots.find((s) => s.id === slot.id)!;
      expect(after.panels.at(-1)).toBe("codex");
      expect(after.activePanel).toBe(activeBefore);
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
      ).toEqual([
        "map",
        "matrix",
        "chronicle",
        "trash-bin",
        "writing-stats",
        "chat",
      ]);

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
      // Append (not prepend) so panels[0] stays "scenes": the sentinel
      // activePanel must differ from the slot's first panel, otherwise
      // stripUnknownPanels' orphan-fallback (-> panels[0]) would mask a wrong
      // reset. "grid" is a registered panel, so sanitize must preserve it.
      state.regions.left.slots[0].panels = [
        ...state.regions.left.slots[0].panels,
        "grid",
      ];
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

    // overlays を知らない古い版が書き戻した保存データ。自己修復で overlay のパネルが
    // slot に戻り、overlays が消えている（A）／そのまま残っている（B）。
    describe("overlays を知らない古い版が書き戻した保存データ", () => {
      function p1Saved(): LayoutState {
        const base = buildDefaultLayoutState({ allInactive: true });
        useLayoutStore.setState({ layout: base });
        useLayoutStore.getState().movePanelToOverlay("scenes", "left");
        useLayoutStore.getState().movePanelToOverlay("chat", "right");
        const saved = structuredClone(useLayoutStore.getState().layout);
        resetStore();
        return saved;
      }

      /** 古い版の自己修復: パネルを既定の slot に戻す。overlays は keep の指定で残す。 */
      function oldAppWriteback(keepOverlays: boolean): LayoutState {
        const saved = p1Saved();
        const overlays = saved.overlays;
        let healed = saved;
        for (const panel of ["scenes", "chat"] as const) {
          healed = restorePanelFromOverlay(healed, panel);
        }
        const next = structuredClone(healed);
        if (keepOverlays) next.overlays = overlays;
        else delete next.overlays;
        return next;
      }

      function mockSaved(state: LayoutState) {
        mockInvoke.mockResolvedValue({
          recentWorkspaces: [],
          lastActiveWorkspace: null,
          theme: "system",
          showLauncherOnStartup: false,
          layout: { layoutVersion: 3, state },
          layoutPresets: [],
        });
      }

      function expectEachPanelOnce(state: LayoutState) {
        const inOverlays = Object.values(getOverlays(state))
          .map((o) => o.panel)
          .filter((p): p is ToolWindowPanelId => p !== null);
        const all = [...collectPanels(state), ...inOverlays];
        expect(all.slice().sort()).toEqual([...TOOL_WINDOW_PANEL_IDS].sort());
        expect(new Set(all).size).toBe(all.length);
        expect(validateLayoutState(state, { viewport: VIEWPORT }).valid).toBe(
          true,
        );
      }

      it("A: overlays が消えていて、パネルが slot に戻っている。slot の配置が残る", async () => {
        const stale = oldAppWriteback(false);
        expect(stale.overlays).toBeUndefined();
        mockSaved(stale);
        await useLayoutStore.getState().initializeLayout();
        const { layout } = useLayoutStore.getState();
        expect(findPanelLocation(layout, "scenes")).not.toBeNull();
        expect(findPanelLocation(layout, "chat")).not.toBeNull();
        expectEachPanelOnce(layout);
      });

      it("B: overlays が残っていてもパネルが slot に戻っているなら、二重登録にせず slot 側を残す", async () => {
        const stale = oldAppWriteback(true);
        expect(getOverlays(stale).left.panel).toBe("scenes");
        // 生データのままなら二重登録で validate に落ちる（読み込み時に除去される）
        expect(validateLayoutState(stale, { viewport: VIEWPORT }).valid).toBe(
          false,
        );
        mockSaved(stale);
        await useLayoutStore.getState().initializeLayout();
        const { layout } = useLayoutStore.getState();
        expect(findPanelLocation(layout, "scenes")).not.toBeNull();
        expect(getOverlays(layout).left.panel).toBeNull();
        expect(getOverlays(layout).right.panel).toBeNull();
        expectEachPanelOnce(layout);
      });

      it("C: 古い版が触れていない保存データ（overlays に配置、slot には無い）は配置が残る", async () => {
        const saved = p1Saved();
        mockSaved(saved);
        await useLayoutStore.getState().initializeLayout();
        const { layout } = useLayoutStore.getState();
        expect(getOverlays(layout).left.panel).toBe("scenes");
        expect(getOverlays(layout).right.panel).toBe("chat");
        expect(findPanelLocation(layout, "scenes")).toBeNull();
        expectEachPanelOnce(layout);
      });
    });

    it("hydrates a desktop layout on a phone without shrinking its saved dimensions", async () => {
      vi.stubGlobal("innerWidth", 390);
      vi.stubGlobal("innerHeight", 844);
      const saved = buildDefaultLayoutState({
        activePanels: {
          scenes: true,
          chat: true,
          timeline: true,
        },
      });
      saved.regions.left.size = 947;
      saved.regions.right.size = 989;
      saved.regions.bottom.size = 871;
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: {
          layoutVersion: 3,
          state: saved,
          activePresetId: "builtin:default",
        },
        layoutPresets: [],
      });

      await useLayoutStore.getState().initializeLayout();

      const { layout } = useLayoutStore.getState();
      expect(layout.regions.left.size).toBe(947);
      expect(layout.regions.right.size).toBe(989);
      expect(layout.regions.bottom.size).toBe(871);
    });

    it("restores a collapsed region snapshot after reloading persisted layout", async () => {
      const saved = buildDefaultLayoutState({ allInactive: true });
      saved.regions.left.slots[0].activePanel = "scenes";
      useLayoutStore.setState({ layout: saved });
      useLayoutStore.getState().collapseLayoutRegion("left");
      const collapsed = structuredClone(useLayoutStore.getState().layout);

      resetStore();
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: {
          layoutVersion: 3,
          state: collapsed,
        },
        layoutPresets: [],
      });

      await useLayoutStore.getState().initializeLayout();
      useLayoutStore.getState().expandLayoutRegion("left");

      const left = useLayoutStore.getState().layout.regions.left.slots;
      expect(left.find((slot) => slot.id === "l0")?.activePanel).toBe("scenes");
      expect(left.find((slot) => slot.id === "l1")?.activePanel).toBeNull();
    });

    it("loads a deleted snapshot panel as a safe null restore", async () => {
      const saved = buildDefaultLayoutState({ allInactive: true });
      saved.regions.left.collapsedActivePanels = {
        l0: "retired-panel" as ToolWindowPanelId,
        l1: null,
      };
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: {
          layoutVersion: 3,
          state: saved,
        },
        layoutPresets: [],
      });

      await useLayoutStore.getState().initializeLayout();
      useLayoutStore.getState().expandLayoutRegion("left");

      expect(
        useLayoutStore
          .getState()
          .layout.regions.left.slots.every((slot) => slot.activePanel === null),
      ).toBe(true);
      assertValidLayout(useLayoutStore.getState().layout);
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

  it("maintains valid layout across random operations including overlay", () => {
    let seed = 20261031;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0xffffffff;
    };

    for (let i = 0; i < 300; i++) {
      const store = useLayoutStore.getState();
      const panel =
        TOOL_WINDOW_PANEL_IDS[
          Math.floor(rand() * TOOL_WINDOW_PANEL_IDS.length)
        ];
      const region = REGIONS[Math.floor(rand() * REGIONS.length)];
      const overlay = rand() < 0.5 ? "left" : "right";
      const op = Math.floor(rand() * 9);

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
        case 4:
        case 5:
          store.movePanelToOverlay(panel, overlay);
          break;
        case 6:
          store.restorePanelFromOverlay(panel);
          break;
        case 7:
          store.toggleOverlay(overlay);
          break;
        case 8:
          store.removePanelFromStripe(panel);
          break;
      }

      const { layout, openOverlay } = useLayoutStore.getState();
      assertValidLayout(layout);
      if (openOverlay !== null) {
        expect(getOverlays(layout)[openOverlay].panel).not.toBeNull();
      }
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
    expect(useLayoutStore.getState().stripeSwapMode).toBeNull();
  });

  it("setStripeSwapPreview clears on setDraggingPanel(null)", () => {
    useLayoutStore.getState().setStripeSwapPreview({
      mode: "axis-locked",
      slotId: "l0",
      offsets: { chat: 30 },
    });
    useLayoutStore.getState().setDraggingPanel("chat", "pointer");
    useLayoutStore.getState().setDraggingPanel(null);
    expect(useLayoutStore.getState().stripeSwapOffsets).toEqual({});
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

  describe("collapseLayoutRegion", () => {
    it("collapses all panels in a side region", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().showPanel("codex");
      useLayoutStore.getState().collapseLayoutRegion("left");
      const left = useLayoutStore.getState().layout.regions.left.slots;
      expect(left.every((slot) => slot.activePanel === null)).toBe(true);
    });

    it("collapses editor and center tool panels", () => {
      useLayoutStore.getState().setEditorOpen(true);
      useLayoutStore.getState().showPanel("grid");
      useLayoutStore.getState().collapseLayoutRegion("center");
      const { center } = useLayoutStore.getState().layout;
      expect(center.editorOpen).toBe(false);
      for (const segment of center.segments) {
        if (segment.kind === "tool") {
          expect(segment.activePanel).toBeNull();
        }
      }
    });

    it("pending inline AI 中の center collapse は tool も editor も変更しない", () => {
      useLayoutStore.getState().setEditorOpen(true);
      useLayoutStore.getState().movePanelToNewSlot("grid", "center", 1);
      useLayoutStore.getState().showPanel("grid");
      expect(
        useLayoutStore
          .getState()
          .layout.center.segments.some(
            (segment) =>
              segment.kind === "tool" && segment.activePanel === "grid",
          ),
      ).toBe(true);
      useInlineAiStore.getState().startGeneration({
        commandId: "continue",
        mode: "insert",
        originalRange: null,
        originalText: "",
        insertPos: 1,
        abortController: new AbortController(),
      });
      useInlineAiStore.getState().finishGeneration("m");

      const before = useLayoutStore.getState().layout.center;
      useLayoutStore.getState().collapseLayoutRegion("center");

      expect(useLayoutStore.getState().layout.center).toEqual(before);
    });
  });

  describe("expandLayoutRegion", () => {
    it("restores only the slots that were open before a collapse", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().collapseLayoutRegion("left");
      useLayoutStore.getState().expandLayoutRegion("left");
      const left = useLayoutStore.getState().layout.regions.left.slots;
      expect(left.find((slot) => slot.id === "l0")?.activePanel).toBe("scenes");
      expect(left.find((slot) => slot.id === "l1")?.activePanel).toBeNull();
      expect(
        useLayoutStore.getState().layout.regions.left.collapsedActivePanels,
      ).toBeUndefined();
      assertValidLayout(useLayoutStore.getState().layout);
    });

    it("restores the exact active panel in a multi-panel slot", () => {
      useLayoutStore.getState().showPanel("codex-quick");
      useLayoutStore.getState().collapseLayoutRegion("left");
      useLayoutStore.getState().expandLayoutRegion("left");

      expect(
        useLayoutStore
          .getState()
          .layout.regions.left.slots.find((slot) => slot.id === "l1")
          ?.activePanel,
      ).toBe("codex-quick");
    });

    it("does not clobber a slot that is already open", () => {
      useLayoutStore.getState().showPanel("codex");
      const codexSlotId = useLayoutStore
        .getState()
        .layout.regions.left.slots.find((s) => s.activePanel === "codex")?.id;
      useLayoutStore.getState().expandLayoutRegion("left");
      const codexSlot = useLayoutStore
        .getState()
        .layout.regions.left.slots.find((s) => s.id === codexSlotId);
      expect(codexSlot?.activePanel).toBe("codex");
    });

    it("restores the right region without opening its other slots", () => {
      useLayoutStore.getState().showPanel("chat-history");
      useLayoutStore.getState().collapseLayoutRegion("right");
      expect(
        useLayoutStore
          .getState()
          .layout.regions.right.slots.every((s) => s.activePanel === null),
      ).toBe(true);
      useLayoutStore.getState().expandLayoutRegion("right");
      const right = useLayoutStore.getState().layout.regions.right.slots;
      expect(right.find((slot) => slot.id === "r0")?.activePanel).toBe(
        "chat-history",
      );
      expect(right.find((slot) => slot.id === "r1")?.activePanel).toBeNull();
    });

    it("discards the old snapshot after an explicit panel open", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().collapseLayoutRegion("left");

      useLayoutStore.getState().showPanel("codex");
      useLayoutStore.getState().collapseLayoutRegion("left");
      useLayoutStore.getState().expandLayoutRegion("left");

      const left = useLayoutStore.getState().layout.regions.left.slots;
      expect(left.find((slot) => slot.id === "l0")?.activePanel).toBeNull();
      expect(left.find((slot) => slot.id === "l1")?.activePanel).toBe("codex");
    });

    it("does not revive source or target snapshots after a panel moves", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().collapseLayoutRegion("left");
      useLayoutStore.getState().showPanel("chat");
      useLayoutStore.getState().collapseLayoutRegion("right");

      useLayoutStore.getState().movePanelToSlot("scenes", "right", "r0");
      useLayoutStore.getState().collapseLayoutRegion("right");
      useLayoutStore.getState().expandLayoutRegion("right");
      useLayoutStore.getState().expandLayoutRegion("left");

      expect(
        useLayoutStore
          .getState()
          .layout.regions.left.slots.every((slot) => slot.activePanel === null),
      ).toBe(true);
      expect(
        useLayoutStore
          .getState()
          .layout.regions.right.slots.find((slot) => slot.id === "r0")
          ?.activePanel,
      ).toBe("scenes");
      expect(
        useLayoutStore
          .getState()
          .layout.regions.right.slots.find((slot) => slot.id === "r1")
          ?.activePanel,
      ).toBeNull();
    });

    it("does not restore a collapsed panel removed from the stripe", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().showPanel("codex");
      useLayoutStore.getState().collapseLayoutRegion("left");

      useLayoutStore.getState().removePanelFromStripe("scenes");
      useLayoutStore.getState().expandLayoutRegion("left");

      const left = useLayoutStore.getState().layout.regions.left.slots;
      expect(left.find((slot) => slot.id === "l0")?.activePanel).toBeNull();
      expect(left.find((slot) => slot.id === "l1")?.activePanel).toBe("codex");
    });

    it("keeps the original snapshot across a repeated collapse", () => {
      useLayoutStore.getState().showPanel("codex-quick");
      useLayoutStore.getState().collapseLayoutRegion("left");
      const snapshot = structuredClone(
        useLayoutStore.getState().layout.regions.left.collapsedActivePanels,
      );

      useLayoutStore.getState().collapseLayoutRegion("left");

      expect(
        useLayoutStore.getState().layout.regions.left.collapsedActivePanels,
      ).toEqual(snapshot);
      useLayoutStore.getState().expandLayoutRegion("left");
      expect(
        useLayoutStore
          .getState()
          .layout.regions.left.slots.find((slot) => slot.id === "l1")
          ?.activePanel,
      ).toBe("codex-quick");
    });

    it("uses the first-panel fallback only when no snapshot exists", () => {
      useLayoutStore.getState().expandLayoutRegion("left");

      for (const slot of useLayoutStore.getState().layout.regions.left.slots) {
        expect(slot.activePanel).toBe(slot.panels[0] ?? null);
      }
    });

    it("falls back to null when a saved panel no longer belongs to its slot", () => {
      const layout = buildDefaultLayoutState({ allInactive: true });
      layout.regions.left.collapsedActivePanels = {
        l0: "codex-quick",
        l1: null,
      };
      useLayoutStore.setState({ layout });

      useLayoutStore.getState().expandLayoutRegion("left");

      expect(
        useLayoutStore
          .getState()
          .layout.regions.left.slots.every((slot) => slot.activePanel === null),
      ).toBe(true);
    });
  });

  describe("removeAllPanelsFromStripeRegion", () => {
    it("hides all panels in a region from the stripe", () => {
      useLayoutStore.getState().showPanel("chat");
      useLayoutStore.getState().showPanel("chat-history");
      useLayoutStore.getState().removeAllPanelsFromStripeRegion("right");
      const hidden = useLayoutStore.getState().hiddenStripePanels;
      expect(hidden.has("chat")).toBe(true);
      expect(hidden.has("chat-history")).toBe(true);
      expect(
        useLayoutStore
          .getState()
          .layout.regions.right.slots.every((s) => s.activePanel === null),
      ).toBe(true);
    });

    it("no-ops when layout is locked", () => {
      useLayoutStore.getState().showPanel("chat");
      useLayoutStore.setState({ layoutLocked: true });
      useLayoutStore.getState().removeAllPanelsFromStripeRegion("right");
      expect(useLayoutStore.getState().hiddenStripePanels.has("chat")).toBe(
        false,
      );
    });
  });

  describe("addPanelToCenterStripe", () => {
    it("inserts a new center tool segment at the end", () => {
      useLayoutStore.getState().addPanelToCenterStripe("codex");
      const toolSegments = useLayoutStore
        .getState()
        .layout.center.segments.filter((s) => s.kind === "tool");
      expect(toolSegments).toHaveLength(1);
      expect(toolSegments[0]?.panels).toContain("codex");
      expect(toolSegments[0]?.activePanel).toBe("codex");
    });

    it("reopens a panel already in center", () => {
      useLayoutStore.getState().addPanelToCenterStripe("codex");
      useLayoutStore.getState().togglePanel("codex");
      useLayoutStore.getState().addPanelToCenterStripe("codex");
      expect(useLayoutStore.getState().isPanelActive("codex")).toBe(true);
    });
  });

  describe("addPanelToStripeSlot", () => {
    it("moves a panel into the target slot and unhides it", () => {
      useLayoutStore.getState().showPanel("chat");
      useLayoutStore.getState().removePanelFromStripe("scenes");
      const leftSlotId =
        useLayoutStore.getState().layout.regions.left.slots[0].id;
      useLayoutStore
        .getState()
        .addPanelToStripeSlot("scenes", "left", leftSlotId);
      const loc = findPanelLocation(useLayoutStore.getState().layout, "scenes");
      expect(loc?.slot.id).toBe(leftSlotId);
      expect(loc?.slot.activePanel).toBe("scenes");
      expect(useLayoutStore.getState().hiddenStripePanels.has("scenes")).toBe(
        false,
      );
    });

    it("reopens a panel already in the same slot", () => {
      useLayoutStore.getState().showPanel("scenes");
      useLayoutStore.getState().togglePanel("scenes");
      const leftSlotId =
        useLayoutStore.getState().layout.regions.left.slots[0].id;
      useLayoutStore
        .getState()
        .addPanelToStripeSlot("scenes", "left", leftSlotId);
      expect(useLayoutStore.getState().isPanelActive("scenes")).toBe(true);
    });

    it("no-ops when layout is locked", () => {
      useLayoutStore.setState({ layoutLocked: true });
      const leftSlotId =
        useLayoutStore.getState().layout.regions.left.slots[0].id;
      useLayoutStore
        .getState()
        .addPanelToStripeSlot("scenes", "left", leftSlotId);
      expect(useLayoutStore.getState().isPanelActive("scenes")).toBe(false);
    });
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

// perf レビュー 2026-06-10 残項目の契約 gate:
// - applyPreset は settings 全量書き込みを 1 回に畳む (scheduleSave が
//   activeLayoutPresetId を含むため、即時の persistActivePresetId は冗長)
// - structuredClone 連鎖の上限 (冗長 clone の再発防止)
// - clone 削減後も preset 原本と live layout がエイリアスしない
describe("applyPreset の perf 契約", () => {
  function makeCustomPreset(id: string) {
    return {
      id,
      name: id,
      state: buildDefaultLayoutState({ allInactive: true }),
    };
  }

  beforeEach(() => {
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
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applyPreset は settings を 1 回だけ書き込む (debounce 後・activeLayoutPresetId を含む)", async () => {
    vi.useFakeTimers();
    useLayoutStore.setState({ customPresets: [makeCustomPreset("c1")] });

    useLayoutStore.getState().applyPreset("c1");
    await vi.runAllTimersAsync();

    const saves = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "save_global_settings",
    );
    expect(saves).toHaveLength(1);
    const payload = saves[0][1] as {
      settings: { activeLayoutPresetId?: string | null };
    };
    expect(payload.settings.activeLayoutPresetId).toBe("c1");
  });

  it("builtin preset 適用も settings 書き込みは 1 回", async () => {
    vi.useFakeTimers();

    useLayoutStore.getState().applyPreset("builtin:plan");
    await vi.runAllTimersAsync();

    const saves = mockInvoke.mock.calls.filter(
      ([cmd]) => cmd === "save_global_settings",
    );
    expect(saves).toHaveLength(1);
    const payload = saves[0][1] as {
      settings: { activeLayoutPresetId?: string | null };
    };
    expect(payload.settings.activeLayoutPresetId).toBe("builtin:plan");
  });

  it("applyPreset の structuredClone は custom で 2 回以下", () => {
    useLayoutStore.setState({ customPresets: [makeCustomPreset("c1")] });
    const spy = vi.spyOn(globalThis, "structuredClone");

    useLayoutStore.getState().applyPreset("c1");

    // 必要なのは「原本からの分離 (ensureLayoutStateV3)」と「clamp 用の
    // 作業コピー (clampLayoutStateForViewport)」のみ。それ以上は冗長連鎖。
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    spy.mockRestore();
  });

  it("applyPreset の structuredClone は builtin (override 有無とも) で 3 回以下", () => {
    const spy = vi.spyOn(globalThis, "structuredClone");

    useLayoutStore.getState().applyPreset("builtin:plan");
    const plainCount = spy.mock.calls.length;
    expect(plainCount).toBeLessThanOrEqual(3);

    // override 付き builtin
    useLayoutStore.getState().saveCurrentAsBuiltinPreset("builtin:plan");
    spy.mockClear();
    useLayoutStore.getState().applyPreset("builtin:plan");
    expect(spy.mock.calls.length).toBeLessThanOrEqual(3);
    spy.mockRestore();
  });

  it("custom preset の原本は適用後の layout 操作でエイリアス汚染されない", () => {
    const original = buildDefaultLayoutState({ allInactive: true });
    useLayoutStore.setState({
      customPresets: [
        {
          id: "c1",
          name: "c1",
          state: buildDefaultLayoutState({ allInactive: true }),
        },
      ],
    });

    useLayoutStore.getState().applyPreset("c1");
    useLayoutStore.getState().togglePanel("scenes");
    useLayoutStore.getState().setRegionSize("left", 333, VIEWPORT);

    expect(useLayoutStore.getState().customPresets[0].state).toEqual(original);
  });

  it("builtin override の原本も適用後の layout 操作でエイリアス汚染されない", () => {
    useLayoutStore.getState().togglePanel("scenes");
    useLayoutStore.getState().saveCurrentAsBuiltinPreset("builtin:plan");
    const savedSnapshot = structuredClone(
      useLayoutStore.getState().builtinPresetOverrides["builtin:plan"]!.state,
    );

    useLayoutStore.getState().applyPreset("builtin:plan");
    useLayoutStore.getState().togglePanel("codex");
    useLayoutStore.getState().setRegionSize("left", 333, VIEWPORT);

    expect(
      useLayoutStore.getState().builtinPresetOverrides["builtin:plan"]!.state,
    ).toEqual(savedSnapshot);
  });
});

describe("overlay（画面端の左右オーバーレイ）", () => {
  const store = () => useLayoutStore.getState();
  const layout = () => useLayoutStore.getState().layout;

  beforeEach(() => {
    resetStore();
    vi.clearAllMocks();
    mockInvoke.mockResolvedValue(undefined);
  });

  describe("movePanelToOverlay", () => {
    it("slot に 1 枚だけのパネルを移すと、slot を空にして overlay に置く", () => {
      store().movePanelToOverlay("scenes", "left");
      expect(getOverlays(layout()).left.panel).toBe("scenes");
      expect(findPanelLocation(layout(), "scenes")).toBeNull();
      expect(layout().regions.left.slots.map((s) => s.id)).toEqual(["l1"]);
      assertValidLayout(layout());
    });

    it("center の tool segment のパネルも移せる", () => {
      store().addPanelToCenterStripe("grid");
      store().movePanelToOverlay("grid", "right");
      expect(getOverlays(layout()).right.panel).toBe("grid");
      expect(
        layout().center.segments.some(
          (s) => s.kind === "tool" && s.panels.includes("grid"),
        ),
      ).toBe(false);
      assertValidLayout(layout());
    });

    it("移動先に別のパネルがあれば、元の位置へ入れ替え、Stripe のアイコン順を変えない", () => {
      store().movePanelToOverlay("command-center-results", "left");
      expect(layout().regions.left.slots[1].panels).toEqual([
        "codex",
        "codex-quick",
      ]);

      store().movePanelToOverlay("codex", "left");
      expect(getOverlays(layout()).left.panel).toBe("codex");
      expect(layout().regions.left.slots[1].panels).toEqual([
        "command-center-results",
        "codex-quick",
      ]);
      assertValidLayout(layout());
    });

    it("入れ替えでは元のパネルの表示状態（active と region 幅）を引き継ぐ", () => {
      store().movePanelToOverlay("chat-history", "right");
      store().showPanel("chat");
      const sizeBefore = layout().regions.right.size;

      store().movePanelToOverlay("chat", "right");

      const slot = layout().regions.right.slots[0];
      expect(slot.panels).toEqual(["chat-history"]);
      expect(slot.activePanel).toBe("chat-history");
      expect(layout().regions.right.size).toBe(sizeBefore);
      assertValidLayout(layout());
    });

    it("overlay どうしの移動は左右を入れ替える（移動先が空なら移すだけ）", () => {
      store().movePanelToOverlay("scenes", "left");
      store().movePanelToOverlay("chat", "right");

      store().movePanelToOverlay("scenes", "right");
      expect(getOverlays(layout()).left.panel).toBe("chat");
      expect(getOverlays(layout()).right.panel).toBe("scenes");

      store().movePanelToOverlay("chat", "right");
      store().movePanelToOverlay("chat", "left");
      expect(getOverlays(layout()).left.panel).toBe("chat");
      expect(getOverlays(layout()).right.panel).toBe("scenes");
      assertValidLayout(layout());
    });

    it("同じ overlay にあるパネルを同じ overlay へ移しても何も変わらない", () => {
      store().movePanelToOverlay("scenes", "left");
      const before = layout();
      store().movePanelToOverlay("scenes", "left");
      expect(layout()).toBe(before);
    });

    it("Stripe に表示していないパネルは移せない", () => {
      store().removePanelFromStripe("chat");
      const before = layout();
      store().movePanelToOverlay("chat", "right");
      expect(layout()).toBe(before);
      expect(getOverlays(layout()).right.panel).toBeNull();
    });

    it("レイアウトのロック中は移せない", () => {
      useLayoutStore.setState({ layoutLocked: true });
      const before = layout();
      store().movePanelToOverlay("scenes", "left");
      store().restorePanelFromOverlay("scenes");
      expect(layout()).toBe(before);
    });

    it("editor は移せない", () => {
      const before = layout();
      store().movePanelToOverlay("editor", "left");
      expect(layout()).toBe(before);
    });
  });

  describe("overlay から slot へ戻す", () => {
    it("movePanelToSlot／addPanelToStripeSlot で overlay から外れ、slot に入る", () => {
      store().movePanelToOverlay("codex", "left");
      store().movePanelToSlot("codex", "left", "l0");
      expect(getOverlays(layout()).left.panel).toBeNull();
      expect(findPanelLocation(layout(), "codex")?.slot.id).toBe("l0");
      assertValidLayout(layout());

      store().movePanelToOverlay("chat", "right");
      store().addPanelToStripeSlot("chat", "right", "r1");
      expect(getOverlays(layout()).right.panel).toBeNull();
      expect(findPanelLocation(layout(), "chat")?.slot.id).toBe("r1");
      assertValidLayout(layout());
    });

    it("movePanelToRegion／movePanelToNewSlot でも overlay を空にする", () => {
      store().movePanelToOverlay("scenes", "left");
      store().movePanelToRegion("scenes", "bottom");
      expect(getOverlays(layout()).left.panel).toBeNull();
      expect(findPanelLocation(layout(), "scenes")?.region).toBe("bottom");

      store().movePanelToOverlay("scenes", "left");
      store().movePanelToNewSlot("scenes", "right", 0);
      expect(getOverlays(layout()).left.panel).toBeNull();
      expect(findPanelLocation(layout(), "scenes")?.region).toBe("right");
      assertValidLayout(layout());
    });

    it("restorePanelFromOverlay は既定の領域の最後の slot の末尾へ戻す", () => {
      store().movePanelToOverlay("codex", "left");
      store().restorePanelFromOverlay("codex");
      const left = layout().regions.left.slots;
      expect(getOverlays(layout()).left.panel).toBeNull();
      expect(left[left.length - 1].panels.at(-1)).toBe("codex");
      assertValidLayout(layout());
    });

    it("既定の領域に slot が無くても戻せる", () => {
      store().movePanelToOverlay("scenes", "left");
      store().movePanelToOverlay("codex", "right");
      // left の slot を全部 overlay に出した状態（codex 系は slot に残る）
      store().restorePanelFromOverlay("scenes");
      expect(findPanelLocation(layout(), "scenes")?.region).toBe("left");
      assertValidLayout(layout());
    });
  });

  describe("開閉（layout を変えない）", () => {
    beforeEach(() => {
      store().movePanelToOverlay("chat", "right");
    });

    it("togglePanel／showPanel で openOverlay だけが変わり、layout の参照は不変", () => {
      const before = layout();
      expect(store().isPanelActive("chat")).toBe(false);

      store().togglePanel("chat");
      expect(store().openOverlay).toBe("right");
      expect(store().isPanelActive("chat")).toBe(true);
      expect(layout()).toBe(before);

      store().togglePanel("chat");
      expect(store().openOverlay).toBeNull();
      expect(store().isPanelActive("chat")).toBe(false);

      store().showPanel("chat");
      expect(store().openOverlay).toBe("right");
      store().showPanel("chat");
      expect(store().openOverlay).toBe("right");
      expect(layout()).toBe(before);
    });

    it("toggleOverlay／closeOverlay も layout を変えない", () => {
      const before = layout();
      store().toggleOverlay("right");
      expect(store().openOverlay).toBe("right");
      store().closeOverlay();
      expect(store().openOverlay).toBeNull();
      expect(layout()).toBe(before);
    });

    it("空の overlay は開かない", () => {
      store().toggleOverlay("left");
      store().showOverlay("left");
      expect(store().openOverlay).toBeNull();
    });

    it("zoom 中に開くと zoom を解く（専用キー以外の経路でも overlay が隠れない）", () => {
      store().showPanel("scenes");
      store().toggleMaximizePanel("scenes");
      expect(store().maximizedPanelId).toBe("scenes");
      store().togglePanel("chat");
      expect(store().openOverlay).toBe("right");
      expect(store().maximizedPanelId).toBeNull();

      store().closeOverlay();
      store().toggleMaximizePanel("scenes");
      store().showPanel("chat");
      expect(store().openOverlay).toBe("right");
      expect(store().maximizedPanelId).toBeNull();

      store().closeOverlay();
      store().toggleMaximizePanel("scenes");
      store().toggleOverlay("right");
      expect(store().maximizedPanelId).toBeNull();

      store().closeOverlay();
      store().toggleMaximizePanel("scenes");
      store().showOverlay("right");
      expect(store().maximizedPanelId).toBeNull();
    });

    it("ロック中でも開閉はできる", () => {
      useLayoutStore.setState({ layoutLocked: true });
      store().togglePanel("chat");
      expect(store().openOverlay).toBe("right");
    });

    it("別の overlay を開くと切り替わり、開閉は永続化しない", async () => {
      store().movePanelToOverlay("scenes", "left");
      mockInvoke.mockClear();
      store().toggleOverlay("right");
      store().toggleOverlay("left");
      expect(store().openOverlay).toBe("left");
      await Promise.resolve();
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  describe("自動で閉じる", () => {
    beforeEach(() => {
      store().movePanelToOverlay("chat", "right");
      store().toggleOverlay("right");
      expect(store().openOverlay).toBe("right");
    });

    it("layout の参照が変わる操作（パネル開閉・リサイズ・移動）で閉じる", () => {
      store().togglePanel("scenes");
      expect(store().openOverlay).toBeNull();

      store().toggleOverlay("right");
      store().setRegionSize("left", 300, VIEWPORT);
      expect(store().openOverlay).toBeNull();

      store().toggleOverlay("right");
      store().movePanelToOverlay("scenes", "left");
      expect(store().openOverlay).toBeNull();
    });

    it("overlay のパネルを slot に戻すと閉じる", () => {
      store().restorePanelFromOverlay("chat");
      expect(store().openOverlay).toBeNull();
    });

    it("zoom に入ると閉じる", () => {
      store().showPanel("scenes");
      store().toggleOverlay("right");
      expect(store().openOverlay).toBe("right");
      store().toggleMaximizePanel("scenes");
      expect(store().maximizedPanelId).toBe("scenes");
      expect(store().openOverlay).toBeNull();
    });

    it("zoom の対象にならないパネル（overlay）の zoom は拒否され、閉じない", () => {
      store().toggleMaximizePanel("chat");
      expect(store().maximizedPanelId).toBeNull();
      expect(store().openOverlay).toBe("right");
    });
  });

  describe("読み込みとプリセットの後の整合", () => {
    it("保存済みの overlay は initializeLayout 後もそのまま読める", async () => {
      useLayoutStore.getState().movePanelToOverlay("chat", "right");
      const saved = structuredClone(layout());
      resetStore();
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: { layoutVersion: 3, state: saved },
        layoutPresets: [],
      });

      await store().initializeLayout();

      expect(getOverlays(layout()).right.panel).toBe("chat");
      expect(findPanelLocation(layout(), "chat")).toBeNull();
      expect(store().openOverlay).toBeNull();
      assertValidLayout(layout());
    });

    it("非表示のパネルが overlay に入った保存データは、読み込み時に既定の領域へ戻す", async () => {
      useLayoutStore.getState().movePanelToOverlay("chat", "right");
      const saved = structuredClone(layout());
      resetStore();
      mockInvoke.mockResolvedValue({
        recentWorkspaces: [],
        lastActiveWorkspace: null,
        theme: "system",
        showLauncherOnStartup: false,
        layout: {
          layoutVersion: 3,
          state: saved,
          hiddenStripePanels: ["chat"],
        },
        layoutPresets: [],
      });

      await store().initializeLayout();

      expect(getOverlays(layout()).right.panel).toBeNull();
      expect(findPanelLocation(layout(), "chat")?.region).toBe("right");
      assertValidLayout(layout());
    });

    it("applyPreset：カスタムの非表示パネルが overlay にあれば、適用時に戻す", () => {
      useLayoutStore.getState().movePanelToOverlay("chat", "right");
      const state = structuredClone(layout());
      resetStore();
      useLayoutStore.setState({
        customPresets: [
          { id: "c-ovl", name: "c-ovl", state, hiddenStripePanels: ["chat"] },
        ],
      });

      store().applyPreset("c-ovl");

      expect(getOverlays(layout()).right.panel).toBeNull();
      expect(findPanelLocation(layout(), "chat")).not.toBeNull();
      expect(store().hiddenStripePanels.has("chat")).toBe(true);
      assertValidLayout(layout());
    });

    it("applyPreset：overlay を持つ表示中のプリセットは overlay ごと適用する", () => {
      useLayoutStore.getState().movePanelToOverlay("chat", "right");
      const state = structuredClone(layout());
      resetStore();
      useLayoutStore.setState({
        customPresets: [{ id: "c-ovl2", name: "c-ovl2", state }],
      });

      store().applyPreset("c-ovl2");

      expect(getOverlays(layout()).right.panel).toBe("chat");
      assertValidLayout(layout());
    });

    it("組込みプリセットの上書きでも、非表示のパネルを overlay から外す", () => {
      useLayoutStore.getState().movePanelToOverlay("chat", "right");
      const state = structuredClone(layout());
      resetStore();
      useLayoutStore.setState({
        builtinPresetOverrides: {
          "builtin:default": { state, hiddenStripePanels: ["chat"] },
        },
      });

      store().applyPreset("builtin:default");

      expect(getOverlays(layout()).right.panel).toBeNull();
      assertValidLayout(layout());
    });
  });
});
