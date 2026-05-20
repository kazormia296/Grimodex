import type { PanelId } from "./panelIds";
import {
  DEFAULT_INDEX_MAP,
  DEFAULT_REGION_MAP,
  TOOL_WINDOW_PANEL_IDS,
} from "./toolWindowDefaults";
import {
  clampRegionSize,
  DEFAULT_REGION_SIZES,
  MIN_EDITOR_SIZE,
  MIN_REGION_SIZE,
  SPLITTER_GUTTER_PX,
  STRIPE_SIZE,
} from "./layoutConstants";
import type {
  LayoutState,
  LayoutValidationResult,
  PanelLocation,
  RegionId,
  RegionState,
  SlotState,
  ToolWindowPanelId,
} from "./layoutTypes";

const REGION_SLOT_PREFIX: Record<RegionId, string> = {
  left: "l",
  right: "r",
  bottom: "b",
};

const ALL_REGIONS: RegionId[] = ["left", "right", "bottom"];

export interface BuildDefaultLayoutOptions {
  /** true = 全 activePanel null（初回起動・リセット用） */
  allInactive?: boolean;
  /** プリセット適用時に個別 panel を開く */
  activePanels?: Partial<Record<ToolWindowPanelId, boolean>>;
}

/** マイグレーション・リセット用。全 activePanel = null */
export const EMPTY_LAYOUT: LayoutState = buildDefaultLayoutState({
  allInactive: true,
});

export function buildDefaultLayoutState(
  options: BuildDefaultLayoutOptions = {},
): LayoutState {
  const { allInactive = false, activePanels = {} } = options;

  const regions = {} as Record<RegionId, RegionState>;
  for (const regionId of ALL_REGIONS) {
    regions[regionId] = {
      size: DEFAULT_REGION_SIZES[regionId],
      slots: buildSlotsForRegion(regionId, allInactive, activePanels),
    };
  }

  return { regions };
}

function buildSlotsForRegion(
  region: RegionId,
  allInactive: boolean,
  activePanels: Partial<Record<ToolWindowPanelId, boolean>>,
): SlotState[] {
  const byIndex = new Map<number, ToolWindowPanelId[]>();

  for (const panelId of TOOL_WINDOW_PANEL_IDS) {
    if (DEFAULT_REGION_MAP[panelId] !== region) continue;
    const idx = DEFAULT_INDEX_MAP[panelId];
    const list = byIndex.get(idx) ?? [];
    list.push(panelId);
    byIndex.set(idx, list);
  }

  const indices = [...byIndex.keys()].sort((a, b) => a - b);
  const prefix = REGION_SLOT_PREFIX[region];

  return indices.map((idx) => {
    const panels = byIndex.get(idx)!;
    const explicitActive = panels.find((p) => activePanels[p] === true);
    const activePanel =
      allInactive && !explicitActive ? null : (explicitActive ?? null);

    return {
      id: `${prefix}${idx}`,
      sizeRatio: 1,
      panels,
      activePanel,
    };
  });
}

export function validateLayoutState(
  state: LayoutState,
  options: { viewport?: { width: number; height: number } } = {},
): LayoutValidationResult {
  const viewport = options.viewport ?? { width: 4096, height: 4096 };
  const seenPanels = new Set<ToolWindowPanelId>();

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region) {
      return { valid: false, reason: `missing region: ${regionId}` };
    }

    if (!Number.isFinite(region.size) || region.size < MIN_REGION_SIZE) {
      return {
        valid: false,
        reason: `region ${regionId} size out of range: ${region.size}`,
      };
    }

    const maxSize = clampRegionSize(regionId, Infinity, viewport);
    if (region.size > maxSize) {
      return {
        valid: false,
        reason: `region ${regionId} size exceeds max: ${region.size}`,
      };
    }

    const slotIds = new Set<string>();
    for (const slot of region.slots) {
      if (slotIds.has(slot.id)) {
        return {
          valid: false,
          reason: `duplicate slot id in ${regionId}: ${slot.id}`,
        };
      }
      slotIds.add(slot.id);

      if (!Number.isFinite(slot.sizeRatio) || slot.sizeRatio <= 0) {
        return {
          valid: false,
          reason: `invalid sizeRatio for slot ${slot.id}`,
        };
      }

      if (
        slot.activePanel !== null &&
        !slot.panels.includes(slot.activePanel)
      ) {
        return {
          valid: false,
          reason: `activePanel ${slot.activePanel} not in slot ${slot.id}`,
        };
      }

      for (const panel of slot.panels) {
        if (seenPanels.has(panel)) {
          return {
            valid: false,
            reason: `panel ${panel} registered in multiple slots`,
          };
        }
        seenPanels.add(panel);
      }
    }
  }

  for (const panelId of TOOL_WINDOW_PANEL_IDS) {
    if (!seenPanels.has(panelId)) {
      return { valid: false, reason: `panel ${panelId} not registered` };
    }
  }

  return { valid: true };
}

/** open slot の sizeRatio を合計 1 に正規化。折りたたみ slot は ratio を保持 */
export function normalizeSlotRatios(slots: SlotState[]): SlotState[] {
  const openSlots = slots.filter((s) => s.activePanel !== null);
  if (openSlots.length === 0) return slots;

  const sum = openSlots.reduce((acc, s) => acc + s.sizeRatio, 0);
  if (sum <= 0) return slots;

  return slots.map((slot) => {
    if (slot.activePanel === null) return slot;
    return { ...slot, sizeRatio: slot.sizeRatio / sum };
  });
}

/**
 * open slot 削除後、削除 slot の ratio を残り open slot へ按分する。
 * 折りたたみ slot の ratio は保持（§6.2）。
 */
export function redistributeRatiosAfterRemovingOpenSlot(
  remainingSlots: SlotState[],
  removedSlot: SlotState,
): SlotState[] {
  if (removedSlot.activePanel === null) {
    return remainingSlots;
  }

  const openRemaining = remainingSlots.filter((slot) => slot.activePanel !== null);
  if (openRemaining.length === 0) {
    return remainingSlots;
  }

  const removedRatio = removedSlot.sizeRatio;
  const openSum = openRemaining.reduce((sum, slot) => sum + slot.sizeRatio, 0);

  const updated =
    openSum <= 0
      ? remainingSlots.map((slot) =>
          slot.activePanel !== null ? { ...slot, sizeRatio: 1 } : slot,
        )
      : remainingSlots.map((slot) => {
          if (slot.activePanel === null) return slot;
          return {
            ...slot,
            sizeRatio:
              slot.sizeRatio + removedRatio * (slot.sizeRatio / openSum),
          };
        });

  return normalizeSlotRatios(updated);
}

export function getRegionContentSize(
  regionId: RegionId,
  layout: LayoutState,
): number {
  const region = layout.regions[regionId];
  const hasOpen = region.slots.some((s) => s.activePanel !== null);
  return hasOpen ? region.size : 0;
}

/** open slot に割り当て可能な px（splitter 厚みを除く） */
export function getSlotLayoutBudget(
  openSlotCount: number,
  layoutBudgetPx: number,
  gutterPx: number = SPLITTER_GUTTER_PX,
): number {
  if (openSlotCount <= 0) return 0;
  const gutterTotal = Math.max(0, openSlotCount - 1) * gutterPx;
  return Math.max(0, layoutBudgetPx - gutterTotal);
}

/**
 * slot 分割軸上のコンテナサイズから open slot の px を算出する。
 * left/right の region.size は幅なので、高さ方向の分割には使わない。
 */
export function getOpenSlotPixelSizesForRegion(
  region: RegionState,
  layoutBudgetPx: number,
): Map<string, number> {
  const openSlots = region.slots.filter((s) => s.activePanel !== null);
  const budget = getSlotLayoutBudget(openSlots.length, layoutBudgetPx);
  const ratioSum = openSlots.reduce((sum, s) => sum + s.sizeRatio, 0);
  const sizes = new Map<string, number>();

  for (const slot of openSlots) {
    sizes.set(slot.id, ratioSum > 0 ? budget * (slot.sizeRatio / ratioSum) : 0);
  }
  return sizes;
}

export function getOpenSlotPixelSizes(
  regionId: RegionId,
  layout: LayoutState,
  layoutBudgetPx: number,
): Map<string, number> {
  return getOpenSlotPixelSizesForRegion(
    layout.regions[regionId],
    layoutBudgetPx,
  );
}

function regionHasRegisteredPanels(region: RegionState): boolean {
  return region.slots.some((slot) => slot.panels.length > 0);
}

/**
 * region サイズを viewport 制約内に収め、左右 content 合算で MIN_EDITOR_SIZE を確保する。
 * bottom region は side stripe 間の広い帯を占有するため、stripe / splitter 幅を差し引く。
 */
export function clampLayoutStateForViewport(
  state: LayoutState,
  viewport: { width: number; height: number },
): LayoutState {
  const next = cloneLayoutState(state);

  for (const regionId of ALL_REGIONS) {
    next.regions[regionId].size = clampRegionSize(
      regionId,
      next.regions[regionId].size,
      viewport,
    );
  }

  const leftSize = next.regions.left.size;
  const rightSize = next.regions.right.size;
  const horizontalTotal = leftSize + rightSize;
  const leftOpen = isRegionOpen(next.regions.left);
  const rightOpen = isRegionOpen(next.regions.right);
  const fixedHorizontal =
    (regionHasRegisteredPanels(next.regions.left) ? STRIPE_SIZE : 0) +
    (regionHasRegisteredPanels(next.regions.right) ? STRIPE_SIZE : 0) +
    (leftOpen ? SPLITTER_GUTTER_PX : 0) +
    (rightOpen ? SPLITTER_GUTTER_PX : 0);
  const maxHorizontal = viewport.width - MIN_EDITOR_SIZE - fixedHorizontal;

  if (horizontalTotal > maxHorizontal && horizontalTotal > 0) {
    const scale = maxHorizontal / horizontalTotal;
    next.regions.left.size = clampRegionSize(
      "left",
      Math.round(leftSize * scale),
      viewport,
    );
    next.regions.right.size = clampRegionSize(
      "right",
      Math.round(rightSize * scale),
      viewport,
    );
  }

  return next;
}

/**
 * 隣接 2 slot の px サイズを更新し、他 open slot は現行 px を保持したまま ratio を再計算。
 */
export function applyAdjacentSlotPixelSizes(
  layout: LayoutState,
  regionId: RegionId,
  slotIdA: string,
  slotIdB: string,
  pxA: number,
  pxB: number,
  layoutBudgetPx: number,
): LayoutState {
  const region = layout.regions[regionId];
  const openSlots = region.slots.filter((s) => s.activePanel !== null);
  const budget = getSlotLayoutBudget(openSlots.length, layoutBudgetPx);
  const otherSlots = openSlots.filter(
    (s) => s.id !== slotIdA && s.id !== slotIdB,
  );
  const remainingBudget = Math.max(0, budget - pxA - pxB);
  const otherRatioSum = otherSlots.reduce((sum, s) => sum + s.sizeRatio, 0);

  const pixelSizes = new Map<string, number>();
  pixelSizes.set(slotIdA, pxA);
  pixelSizes.set(slotIdB, pxB);
  for (const slot of otherSlots) {
    pixelSizes.set(
      slot.id,
      otherRatioSum > 0
        ? remainingBudget * (slot.sizeRatio / otherRatioSum)
        : 0,
    );
  }

  return updateRegion(layout, regionId, (region) => ({
    ...region,
    slots: normalizeSlotRatios(
      region.slots.map((slot) => {
        if (slot.activePanel === null) return slot;
        const px = pixelSizes.get(slot.id);
        return px != null ? { ...slot, sizeRatio: px } : slot;
      }),
    ),
  }));
}

export function isRegionOpen(region: RegionState): boolean {
  return region.slots.some((s) => s.activePanel !== null);
}

export function findPanelLocation(
  state: LayoutState,
  panelId: PanelId,
): PanelLocation | null {
  if (panelId === "editor") return null;

  for (const region of ALL_REGIONS) {
    const regionState = state.regions[region];
    for (let slotIndex = 0; slotIndex < regionState.slots.length; slotIndex++) {
      const slot = regionState.slots[slotIndex];
      if (slot.panels.includes(panelId)) {
        return { region, slotIndex, slot };
      }
    }
  }
  return null;
}

export function getOpenSlots(slots: SlotState[]): SlotState[] {
  return slots.filter((s) => s.activePanel !== null);
}

/** 検証失敗時に呼ぶフォールバック */
export function resetLayoutStateToDefault(): LayoutState {
  return buildDefaultLayoutState({ allInactive: true });
}

/** LayoutState の shallow clone（store 更新用） */
export function cloneLayoutState(state: LayoutState): LayoutState {
  return structuredClone(state);
}

export function updateRegion(
  state: LayoutState,
  regionId: RegionId,
  updater: (region: RegionState) => RegionState,
): LayoutState {
  return {
    regions: {
      ...state.regions,
      [regionId]: updater(state.regions[regionId]),
    },
  };
}

export function updateSlot(
  state: LayoutState,
  regionId: RegionId,
  slotId: string,
  updater: (slot: SlotState) => SlotState,
): LayoutState {
  return updateRegion(state, regionId, (region) => ({
    ...region,
    slots: region.slots.map((slot) =>
      slot.id === slotId ? updater(slot) : slot,
    ),
  }));
}

export function generateSlotId(region: RegionId): string {
  return `${REGION_SLOT_PREFIX[region]}${crypto.randomUUID().slice(0, 8)}`;
}
