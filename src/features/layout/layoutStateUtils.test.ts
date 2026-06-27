import { describe, it, expect } from "vitest";
import {
  buildDefaultLayoutState,
  buildCenterSegmentsWithTools,
  ensureLayoutStateV3,
  findPanelLocation,
  isRegionOpen,
  normalizeSlotRatios,
  normalizeFlexGrow,
  redistributeRatiosAfterRemovingOpenSlot,
  validateLayoutState,
  clampLayoutStateForViewport,
  applyAdjacentSlotPixelSizes,
  getOpenCenterSegmentPixelSizes,
  getOpenSlotPixelSizes,
  nudgeAdjacentCenterSegmentPixelSizes,
  reorderPanelInSlot,
  removePanelFromSlot,
  removePanelFromCenterSegment,
  DEFAULT_EDITOR_SEGMENT_ID,
} from "./layoutStateUtils";
import {
  DEFAULT_INDEX_MAP,
  DEFAULT_REGION_MAP,
  TOOL_WINDOW_PANEL_IDS,
} from "./toolWindowDefaults";
import type { LayoutState, RegionId, ToolWindowPanelId } from "./layoutTypes";
import {
  DEFAULT_REGION_SIZES,
  MIN_EDITOR_SIZE,
  MIN_REGION_SIZE,
  PANEL_GAP_PX,
} from "./layoutConstants";

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

  it("includes default center state with editor segment", () => {
    const state = buildDefaultLayoutState();
    expect(state.center.editorOpen).toBe(true);
    expect(state.center.segments.some((s) => s.kind === "editor")).toBe(true);
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
    // 2 open slots → 1 inter-slot gutter of panel-gap width.
    expect(sum).toBeCloseTo(layoutBudget - PANEL_GAP_PX, 0);
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

describe("nudgeAdjacentCenterSegmentPixelSizes", () => {
  it("preserves total width and respects MIN_EDITOR_SIZE", () => {
    const segments = buildCenterSegmentsWithTools(["kouetsu"], {
      kouetsu: true,
    });
    const center = { editorOpen: true, segments };
    const budget = 900;
    const before = getOpenCenterSegmentPixelSizes(center, budget);
    const toolId = segments.find((s) => s.kind === "tool")!.id;
    const toolBefore = before.get(toolId) ?? 0;
    const editorBefore = before.get(DEFAULT_EDITOR_SEGMENT_ID) ?? 0;

    const nudged = nudgeAdjacentCenterSegmentPixelSizes(
      center,
      toolId,
      DEFAULT_EDITOR_SEGMENT_ID,
      500,
      budget,
    );
    expect(nudged).not.toBeNull();
    expect(nudged!.pxB).toBeGreaterThanOrEqual(MIN_EDITOR_SIZE);
    expect(nudged!.pxA + nudged!.pxB).toBeCloseTo(toolBefore + editorBefore, 5);
  });
});

describe("removePanelFromSlot", () => {
  it("promotes the next panel when the active panel is removed", () => {
    const slots = [
      {
        id: "l1",
        sizeRatio: 1,
        panels: [
          "codex",
          "codex-quick",
          "command-center-results",
        ] as ToolWindowPanelId[],
        activePanel: "codex" as ToolWindowPanelId,
      },
    ];

    const { slots: next } = removePanelFromSlot(slots, 0, "codex");

    expect(next[0].panels).toEqual(["codex-quick", "command-center-results"]);
    expect(next[0].activePanel).toBe("codex-quick");
  });

  it("promotes the first remaining panel when the last active panel is removed", () => {
    const slots = [
      {
        id: "l1",
        sizeRatio: 1,
        panels: ["codex", "codex-quick"] as ToolWindowPanelId[],
        activePanel: "codex-quick" as ToolWindowPanelId,
      },
    ];

    const { slots: next } = removePanelFromSlot(slots, 0, "codex-quick");

    expect(next[0].panels).toEqual(["codex"]);
    expect(next[0].activePanel).toBe("codex");
  });

  it("leaves activePanel unchanged when a background panel is removed", () => {
    const slots = [
      {
        id: "l1",
        sizeRatio: 1,
        panels: ["codex", "codex-quick"] as ToolWindowPanelId[],
        activePanel: "codex" as ToolWindowPanelId,
      },
    ];

    const { slots: next } = removePanelFromSlot(slots, 0, "codex-quick");

    expect(next[0].panels).toEqual(["codex"]);
    expect(next[0].activePanel).toBe("codex");
  });

  it("promotes the previous visible panel when the last active panel is removed", () => {
    const slots = [
      {
        id: "b0",
        sizeRatio: 1,
        panels: ["map", "grid", "matrix"] as ToolWindowPanelId[],
        activePanel: "matrix" as ToolWindowPanelId,
      },
    ];
    const isVisible = (panel: ToolWindowPanelId) => panel !== "map";

    const { slots: next } = removePanelFromSlot(slots, 0, "matrix", isVisible);

    expect(next[0].panels).toEqual(["map", "grid"]);
    expect(next[0].activePanel).toBe("grid");
  });

  it("promotes the panel before the removed one when all panels are visible", () => {
    const slots = [
      {
        id: "b0",
        sizeRatio: 1,
        panels: ["map", "grid", "matrix"] as ToolWindowPanelId[],
        activePanel: "matrix" as ToolWindowPanelId,
      },
    ];

    const { slots: next } = removePanelFromSlot(slots, 0, "matrix");

    expect(next[0].panels).toEqual(["map", "grid"]);
    expect(next[0].activePanel).toBe("grid");
  });

  it("does not activate a hidden panel when the last visible panel is removed", () => {
    const slots = [
      {
        id: "b0",
        sizeRatio: 1,
        panels: ["chronicle", "grid"] as ToolWindowPanelId[],
        activePanel: "grid" as ToolWindowPanelId,
      },
    ];
    const isVisible = (panel: ToolWindowPanelId) => panel !== "chronicle";

    const { slots: next } = removePanelFromSlot(slots, 0, "grid", isVisible);

    expect(next[0].panels).toEqual(["chronicle"]);
    expect(next[0].activePanel).toBeNull();
  });
});

describe("removePanelFromCenterSegment", () => {
  it("promotes the next panel when the active panel is removed", () => {
    const segments = [
      { id: DEFAULT_EDITOR_SEGMENT_ID, kind: "editor" as const, sizeRatio: 1 },
      {
        id: "ctool0",
        kind: "tool" as const,
        sizeRatio: 1,
        panels: ["scenes", "grid"] as ToolWindowPanelId[],
        activePanel: "scenes" as ToolWindowPanelId,
      },
    ];
    const toolIndex = segments.findIndex((s) => s.kind === "tool");

    const next = removePanelFromCenterSegment(
      segments,
      toolIndex,
      "scenes",
      true,
    );
    const tool = next.find((s) => s.kind === "tool");

    expect(tool?.panels).toEqual(["grid"]);
    expect(tool?.activePanel).toBe("grid");
  });
});

describe("reorderPanelInSlot", () => {
  it("moves a panel within the same slot without changing activePanel", () => {
    const state = buildDefaultLayoutState();
    const slot = state.regions.left.slots.find((s) => s.panels.length > 1);
    expect(slot).toBeDefined();
    if (!slot) return;

    const panel = slot.panels[0];
    const nextSlots = reorderPanelInSlot(
      state.regions.left.slots,
      slot.id,
      panel,
      slot.panels.length,
    );
    const nextSlot = nextSlots.find((s) => s.id === slot.id)!;
    expect(nextSlot.panels.at(-1)).toBe(panel);
    expect(nextSlot.activePanel).toBe(slot.activePanel);
  });
});

describe("ensureLayoutStateV3 auto-injects newly registered panels", () => {
  it("未登録パネルを既定リージョンへ注入し validateLayoutState を通す", () => {
    const base = buildDefaultLayoutState();
    const victim = TOOL_WINDOW_PANEL_IDS[TOOL_WINDOW_PANEL_IDS.length - 1];
    // 全 slot から victim を除去して「保存済みレイアウトに新パネルが無い」状況を作る
    for (const region of Object.values(base.regions)) {
      for (const slot of region.slots) {
        slot.panels = slot.panels.filter((p) => p !== victim);
        if (slot.activePanel === victim)
          slot.activePanel = slot.panels[0] ?? null;
      }
      region.slots = region.slots.filter((s) => s.panels.length > 0);
    }
    expect(validateLayoutState(base).valid).toBe(false);

    const fixed = ensureLayoutStateV3(base);
    const seen = new Set<string>();
    for (const region of Object.values(fixed.regions))
      for (const slot of region.slots) for (const p of slot.panels) seen.add(p);
    expect(seen.has(victim)).toBe(true);
    expect(validateLayoutState(fixed).valid).toBe(true);
  });

  it("全パネル登録済みなら何も足さない（冪等）", () => {
    const base = buildDefaultLayoutState();
    const before = Object.values(base.regions).flatMap((r) =>
      r.slots.flatMap((s) => s.panels),
    ).length;
    const fixed = ensureLayoutStateV3(base);
    const after = Object.values(fixed.regions).flatMap((r) =>
      r.slots.flatMap((s) => s.panels),
    ).length;
    expect(after).toBe(before);
    expect(validateLayoutState(fixed).valid).toBe(true);
  });

  // データ整合の回帰ガード: chronicle 追加前 (= TOOL_WINDOW_PANEL_IDS に
  // chronicle が無かった時代) に保存された v3 カスタムレイアウトは、chronicle
  // 未登録のままだと validateLayoutState に弾かれ、loadLayout が builtin:default
  // へリセット (= カスタム配置の永久喪失) してしまう。修正後の load 経路が通す
  // ensureLayoutStateV3 が、ユーザーのカスタムスロットを保持したまま chronicle
  // を既定位置 (DEFAULT_REGION_MAP/DEFAULT_INDEX_MAP) へ自己修復注入することを
  // 名指しで検証する (末尾 id 任せにしない)。
  it("chronicle 追加前の v3 カスタムレイアウトに chronicle を既定位置へ注入しつつカスタム配置を保持する", () => {
    const base = buildDefaultLayoutState();

    // --- ユーザーのカスタム配置を再現 ---
    // attribution を right 領域から外し、left 領域の独自スロットへ移す。
    const right = base.regions.right;
    for (const slot of right.slots) {
      slot.panels = slot.panels.filter((p) => p !== "attribution");
      if (slot.activePanel === "attribution") {
        slot.activePanel = slot.panels[0] ?? null;
      }
    }
    right.slots = right.slots.filter((s) => s.panels.length > 0);
    base.regions.left.slots.push({
      id: "custom-attr",
      sizeRatio: 1,
      panels: ["attribution"],
      activePanel: "attribution",
    });
    // この時点では全パネル登録済みなので valid。
    expect(validateLayoutState(base).valid).toBe(true);

    // --- chronicle 追加前の保存状態を再現: chronicle を全 slot から除去 ---
    for (const region of Object.values(base.regions)) {
      for (const slot of region.slots) {
        slot.panels = slot.panels.filter((p) => p !== "chronicle");
        if (slot.activePanel === "chronicle") {
          slot.activePanel = slot.panels[0] ?? null;
        }
      }
      region.slots = region.slots.filter((s) => s.panels.length > 0);
    }
    // chronicle 欠落で validate に弾かれる (= リセット対象になるバグの起点)。
    expect(validateLayoutState(base).valid).toBe(false);

    // --- 修正後の load 経路が通す自己修復 ---
    const fixed = ensureLayoutStateV3(base);

    // (a) ユーザーのカスタムスロットが生き残る。
    const customSlot = fixed.regions.left.slots.find(
      (s) => s.id === "custom-attr",
    );
    expect(customSlot?.panels).toEqual(["attribution"]);

    // (b) chronicle が DEFAULT_REGION_MAP/DEFAULT_INDEX_MAP の既定位置へ注入。
    const chronicleRegion = DEFAULT_REGION_MAP.chronicle;
    const chronicleIndex = DEFAULT_INDEX_MAP.chronicle;
    expect(
      fixed.regions[chronicleRegion].slots[chronicleIndex].panels,
    ).toContain("chronicle");

    // 自己修復後は validate を通る (リセットされない)。
    expect(validateLayoutState(fixed).valid).toBe(true);
  });
});
