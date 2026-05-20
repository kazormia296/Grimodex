import { describe, it, expect } from "vitest";
import {
  buildDefaultLayoutState,
  findPanelLocation,
  isRegionOpen,
  normalizeSlotRatios,
  normalizeFlexGrow,
  redistributeRatiosAfterRemovingOpenSlot,
  validateLayoutState,
  clampLayoutStateForViewport,
  applyAdjacentSlotPixelSizes,
  getOpenSlotPixelSizes,
} from "./layoutStateUtils";
import { TOOL_WINDOW_PANEL_IDS } from "./toolWindowDefaults";
import type { LayoutState, RegionId, ToolWindowPanelId } from "./layoutTypes";
import { DEFAULT_REGION_SIZES, MIN_REGION_SIZE } from "./layoutConstants";

const VIEWPORT = { width: 1200, height: 800 };
const LAPTOP_VIEWPORT = { width: 1366, height: 768 };

describe("buildDefaultLayoutState", () => {
  it("registers all 15 tool windows across 6 default slots", () => {
    const state = buildDefaultLayoutState();
    const allPanels = Object.values(state.regions).flatMap((r) =>
      r.slots.flatMap((s) => s.panels),
    );
    expect(allPanels).toHaveLength(TOOL_WINDOW_PANEL_IDS.length);
    expect(new Set(allPanels)).toEqual(new Set(TOOL_WINDOW_PANEL_IDS));
  });

  it("starts with all activePanel null when allInactive", () => {
    const state = buildDefaultLayoutState({ allInactive: true });
    for (const region of Object.values(state.regions)) {
      for (const slot of region.slots) {
        expect(slot.activePanel).toBeNull();
      }
    }
  });

  it("uses default region sizes", () => {
    const state = buildDefaultLayoutState();
    expect(state.regions.left.size).toBe(DEFAULT_REGION_SIZES.left);
    expect(state.regions.right.size).toBe(DEFAULT_REGION_SIZES.right);
    expect(state.regions.bottom.size).toBe(DEFAULT_REGION_SIZES.bottom);
  });

  it("groups panels by region and slot index from DEFAULT_SLOT_MAP", () => {
    const state = buildDefaultLayoutState();
    const leftTop = state.regions.left.slots.find((s) => s.id === "l0");
    const leftBottom = state.regions.left.slots.find((s) => s.id === "l1");
    expect(leftTop?.panels).toEqual(["scenes"]);
    expect(leftBottom?.panels).toEqual([
      "codex",
      "codex-quick",
      "command-center-results",
    ]);
  });
});

describe("validateLayoutState", () => {
  it("accepts a valid default layout", () => {
    const state = buildDefaultLayoutState();
    expect(validateLayoutState(state, { viewport: VIEWPORT })).toEqual({
      valid: true,
    });
  });

  it("rejects duplicate panel registration", () => {
    const state = buildDefaultLayoutState();
    state.regions.left.slots[0].panels.push("codex");
    const result = validateLayoutState(state, { viewport: VIEWPORT });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toMatch(/codex/);
    }
  });

  it("rejects activePanel not in panels", () => {
    const state = buildDefaultLayoutState();
    state.regions.left.slots[0].activePanel = "chat";
    expect(validateLayoutState(state, { viewport: VIEWPORT }).valid).toBe(
      false,
    );
  });

  it("rejects non-positive sizeRatio", () => {
    const state = buildDefaultLayoutState();
    state.regions.left.slots[0].sizeRatio = 0;
    expect(validateLayoutState(state, { viewport: VIEWPORT }).valid).toBe(
      false,
    );
  });

  it("rejects region size below MIN_REGION_SIZE", () => {
    const state = buildDefaultLayoutState();
    state.regions.left.size = MIN_REGION_SIZE - 1;
    expect(validateLayoutState(state, { viewport: VIEWPORT }).valid).toBe(
      false,
    );
  });

  it("rejects duplicate slot ids within a region", () => {
    const state = buildDefaultLayoutState();
    state.regions.left.slots[1].id = state.regions.left.slots[0].id;
    expect(validateLayoutState(state, { viewport: VIEWPORT }).valid).toBe(
      false,
    );
  });
});

describe("normalizeSlotRatios", () => {
  it("normalizes open slot ratios to sum to 1", () => {
    const slots = [
      {
        id: "a",
        sizeRatio: 2,
        panels: ["scenes"] as ToolWindowPanelId[],
        activePanel: "scenes" as ToolWindowPanelId,
      },
      {
        id: "b",
        sizeRatio: 1,
        panels: ["codex"] as ToolWindowPanelId[],
        activePanel: "codex" as ToolWindowPanelId,
      },
      {
        id: "c",
        sizeRatio: 99,
        panels: ["chat"] as ToolWindowPanelId[],
        activePanel: null,
      },
    ];
    const normalized = normalizeSlotRatios(slots);
    const openSum = normalized
      .filter((s) => s.activePanel !== null)
      .reduce((sum, s) => sum + s.sizeRatio, 0);
    expect(openSum).toBeCloseTo(1);
    expect(normalized[2].sizeRatio).toBe(99);
  });
});

describe("redistributeRatiosAfterRemovingOpenSlot", () => {
  it("redistributes removed open slot ratio to remaining open slots", () => {
    const removed = {
      id: "b",
      sizeRatio: 0.4,
      panels: ["chat"] as ToolWindowPanelId[],
      activePanel: "chat" as ToolWindowPanelId,
    };
    const remaining = [
      {
        id: "a",
        sizeRatio: 0.36,
        panels: ["scenes"] as ToolWindowPanelId[],
        activePanel: "scenes" as ToolWindowPanelId,
      },
      {
        id: "c",
        sizeRatio: 0.24,
        panels: ["codex"] as ToolWindowPanelId[],
        activePanel: "codex" as ToolWindowPanelId,
      },
      {
        id: "d",
        sizeRatio: 5,
        panels: ["grid"] as ToolWindowPanelId[],
        activePanel: null,
      },
    ];

    const next = redistributeRatiosAfterRemovingOpenSlot(remaining, removed);
    const open = next.filter((slot) => slot.activePanel !== null);

    expect(open.find((slot) => slot.id === "a")?.sizeRatio).toBeCloseTo(0.6);
    expect(open.find((slot) => slot.id === "c")?.sizeRatio).toBeCloseTo(0.4);
    expect(next.find((slot) => slot.id === "d")?.sizeRatio).toBe(5);
  });

  it("leaves slots unchanged when removed slot was collapsed", () => {
    const removed = {
      id: "b",
      sizeRatio: 0.4,
      panels: ["chat"] as ToolWindowPanelId[],
      activePanel: null,
    };
    const remaining = [
      {
        id: "a",
        sizeRatio: 0.6,
        panels: ["scenes"] as ToolWindowPanelId[],
        activePanel: "scenes" as ToolWindowPanelId,
      },
    ];

    const next = redistributeRatiosAfterRemovingOpenSlot(remaining, removed);
    expect(next[0].sizeRatio).toBe(0.6);
  });
});

describe("findPanelLocation / isRegionOpen", () => {
  it("finds panel in default layout", () => {
    const state = buildDefaultLayoutState();
    const loc = findPanelLocation(state, "scenes");
    expect(loc?.region).toBe("left");
    expect(loc?.slot.id).toBe("l0");
  });

  it("returns null for editor", () => {
    const state = buildDefaultLayoutState();
    expect(findPanelLocation(state, "editor")).toBeNull();
  });

  it("isRegionOpen is false when all slots collapsed", () => {
    const state = buildDefaultLayoutState({ allInactive: true });
    expect(isRegionOpen(state.regions.left)).toBe(false);
  });

  it("isRegionOpen is true when any slot is open", () => {
    const state = buildDefaultLayoutState();
    state.regions.left.slots[0].activePanel = "scenes";
    expect(isRegionOpen(state.regions.left)).toBe(true);
  });
});

describe("clampLayoutStateForViewport", () => {
  it("clamps oversized preset regions to viewport max", () => {
    const state = buildDefaultLayoutState({ activePanels: { grid: true } });
    state.regions.left.size = 800;
    state.regions.right.size = 400;
    const clamped = clampLayoutStateForViewport(state, LAPTOP_VIEWPORT);
    expect(clamped.regions.left.size).toBeLessThanOrEqual(683);
    expect(
      validateLayoutState(clamped, { viewport: LAPTOP_VIEWPORT }).valid,
    ).toBe(true);
  });

  it("scales left+right to preserve MIN_EDITOR_SIZE", () => {
    const state = buildDefaultLayoutState({
      activePanels: { scenes: true, chat: true },
    });
    state.regions.left.size = 600;
    state.regions.right.size = 600;
    const clamped = clampLayoutStateForViewport(state, LAPTOP_VIEWPORT);
    const fixedChrome = 32 * 2 + 6 * 2;
    expect(
      clamped.regions.left.size + clamped.regions.right.size,
    ).toBeLessThanOrEqual(LAPTOP_VIEWPORT.width - 320 - fixedChrome);
  });
});

describe("applyAdjacentSlotPixelSizes", () => {
  it("preserves other open slots when adjacent sizes shift without budget change", () => {
    const state = buildDefaultLayoutState({ allInactive: true });
    state.regions.left.size = 300;
    state.regions.left.slots[0].activePanel = "scenes";
    state.regions.left.slots[1].activePanel = "codex";
    state.regions.left.slots.push({
      id: "l2",
      sizeRatio: 1,
      panels: ["chat"],
      activePanel: "chat",
    });

    const before = getOpenSlotPixelSizes("left", state, 600);
    const l0Before = before.get("l0") ?? 0;
    const l1Before = before.get("l1") ?? 0;
    const thirdPxBefore = before.get("l2") ?? 0;
    expect(thirdPxBefore).toBeGreaterThan(50);

    const next = applyAdjacentSlotPixelSizes(
      state,
      "left",
      "l0",
      "l1",
      l0Before + 30,
      l1Before - 30,
      600,
    );
    const after = getOpenSlotPixelSizes("left", next, 600);
    expect(after.get("l2")).toBeCloseTo(thirdPxBefore, 5);
  });
});

describe("getOpenSlots pixel distribution invariant", () => {
  it("open slot pixel sizes sum to layout budget excluding splitter gutters", () => {
    const state = buildDefaultLayoutState();
    state.regions.left.slots[0].activePanel = "scenes";
    state.regions.left.slots[1].activePanel = "codex";
    const layoutBudget = 800;
    const pixels = getOpenSlotPixelSizes("left", state, layoutBudget);
    const sum = [...pixels.values()].reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(layoutBudget - 6, 0);
  });

  it("region width resize does not change slot heights when layout budget is fixed", () => {
    const state = buildDefaultLayoutState();
    state.regions.left.slots[0].activePanel = "scenes";
    state.regions.left.slots[1].activePanel = "codex";
    state.regions.left.size = 260;
    const at260 = getOpenSlotPixelSizes("left", state, 800);
    state.regions.left.size = 420;
    const at420 = getOpenSlotPixelSizes("left", state, 800);
    expect(at420.get("l0")).toBeCloseTo(at260.get("l0") ?? 0, 5);
    expect(at420.get("l1")).toBeCloseTo(at260.get("l1") ?? 0, 5);
  });
});

function cloneLayout(state: LayoutState): LayoutState {
  return structuredClone(state);
}

describe("layout state structural helpers", () => {
  const REGIONS: RegionId[] = ["left", "right", "bottom"];

  it("default layout passes validation for each region independently", () => {
    const state = buildDefaultLayoutState();
    for (const region of REGIONS) {
      expect(state.regions[region].slots.length).toBeGreaterThan(0);
    }
    expect(
      validateLayoutState(cloneLayout(state), { viewport: VIEWPORT }).valid,
    ).toBe(true);
  });
});

describe("normalizeFlexGrow", () => {
  it("normalizes ratios summing below 1 so the total becomes 1", () => {
    // Open-slot sizeRatios drift below 1 as sibling slots collapse.
    const result = normalizeFlexGrow([0.0439, 0.1239]);
    expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
  });

  it("preserves relative proportions", () => {
    const result = normalizeFlexGrow([0.0439, 0.1239]);
    expect(result[1] / result[0]).toBeCloseTo(0.1239 / 0.0439, 10);
  });

  it("normalizes ratios summing above 1 down to 1", () => {
    const result = normalizeFlexGrow([2, 3, 5]);
    expect(result.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(result).toEqual([0.2, 0.3, 0.5]);
  });

  it("returns a single value of 1 for one entry", () => {
    expect(normalizeFlexGrow([0.04])).toEqual([1]);
  });

  it("falls back to equal split when the sum is non-positive", () => {
    expect(normalizeFlexGrow([0, 0])).toEqual([0.5, 0.5]);
  });

  it("returns an empty array for no entries", () => {
    expect(normalizeFlexGrow([])).toEqual([]);
  });
});
