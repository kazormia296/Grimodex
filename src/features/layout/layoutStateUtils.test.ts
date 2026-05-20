import { describe, it, expect } from "vitest";
import {
  buildDefaultLayoutState,
  findPanelLocation,
  isRegionOpen,
  normalizeSlotRatios,
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
    expect(
      clamped.regions.left.size + clamped.regions.right.size,
    ).toBeLessThanOrEqual(LAPTOP_VIEWPORT.width - 320);
  });
});

describe("applyAdjacentSlotPixelSizes", () => {
  it("preserves third open slot ratio when dragging two adjacent slots", () => {
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

    const before = getOpenSlotPixelSizes("left", state);
    const thirdPxBefore = before.get("l2") ?? 0;
    expect(thirdPxBefore).toBeGreaterThan(50);

    const next = applyAdjacentSlotPixelSizes(
      state,
      "left",
      "l0",
      "l1",
      120,
      80,
    );
    const after = getOpenSlotPixelSizes("left", next);
    const thirdPxAfter = after.get("l2") ?? 0;
    expect(thirdPxAfter).toBeCloseTo(thirdPxBefore, 0);
    expect(thirdPxAfter).toBeGreaterThan(40);
  });
});


describe("getOpenSlots pixel distribution invariant", () => {
  it("open slot pixel sizes sum to region content size", () => {
    const state = buildDefaultLayoutState();
    state.regions.left.slots[0].activePanel = "scenes";
    state.regions.left.slots[1].activePanel = "codex";
    const regionSize = state.regions.left.size;
    const openSlots = state.regions.left.slots.filter(
      (s) => s.activePanel !== null,
    );
    const ratioSum = openSlots.reduce((s, slot) => s + slot.sizeRatio, 0);
    const pixels = openSlots.map(
      (slot) => regionSize * (slot.sizeRatio / ratioSum),
    );
    expect(pixels.reduce((a, b) => a + b, 0)).toBeCloseTo(regionSize);
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
    expect(validateLayoutState(cloneLayout(state), { viewport: VIEWPORT }).valid).toBe(
      true,
    );
  });
});
