import type { PanelId } from "./panelIds";
import {
  DEFAULT_INDEX_MAP,
  DEFAULT_REGION_MAP,
  TOOL_WINDOW_PANEL_IDS,
} from "./toolWindowDefaults";
import {
  clampRegionSize,
  computeFillerRegion,
  DEFAULT_REGION_SIZES,
  MIN_EDITOR_SIZE,
  MIN_REGION_SIZE,
  MIN_SLOT_SIZE,
  SPLITTER_GUTTER_PX,
  STRIPE_SIZE,
  type RegionSizeClampContext,
} from "./layoutConstants";
import type {
  CenterSegment,
  CenterState,
  CenterToolSegment,
  LayoutState,
  LayoutStateV2,
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

export const DEFAULT_EDITOR_SEGMENT_ID = "ceditor";

export interface BuildDefaultLayoutOptions {
  allInactive?: boolean;
  activePanels?: Partial<Record<ToolWindowPanelId, boolean>>;
  editorOpen?: boolean;
}

export const EMPTY_LAYOUT: LayoutState = buildDefaultLayoutState({
  allInactive: true,
});

export function createDefaultCenterState(editorOpen = true): CenterState {
  return {
    editorOpen,
    segments: [{ id: DEFAULT_EDITOR_SEGMENT_ID, kind: "editor", sizeRatio: 1 }],
  };
}

export function isLayoutStateV2(state: unknown): state is LayoutStateV2 {
  if (!state || typeof state !== "object") return false;
  const obj = state as LayoutStateV2;
  return obj.regions != null && !("center" in obj);
}

export function migrateLayoutStateV2toV3(state: LayoutStateV2): LayoutState {
  return {
    regions: structuredClone(state.regions),
    center: createDefaultCenterState(true),
  };
}

export function ensureLayoutStateV3(
  state: LayoutState | LayoutStateV2,
): LayoutState {
  if (isLayoutStateV2(state)) {
    return migrateLayoutStateV2toV3(state);
  }
  return cloneLayoutState(state);
}

export function buildDefaultLayoutState(
  options: BuildDefaultLayoutOptions = {},
): LayoutState {
  const { allInactive = false, activePanels = {}, editorOpen = true } = options;

  const regions = {} as Record<RegionId, RegionState>;
  for (const regionId of ALL_REGIONS) {
    regions[regionId] = {
      size: DEFAULT_REGION_SIZES[regionId],
      slots: buildSlotsForRegion(regionId, allInactive, activePanels),
    };
  }

  return {
    regions,
    center: createDefaultCenterState(editorOpen),
  };
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

export function getToolSegments(center: CenterState): CenterToolSegment[] {
  return center.segments.filter(
    (s): s is CenterToolSegment => s.kind === "tool",
  );
}

export function getEditorSegment(
  center: CenterState,
): Extract<CenterSegment, { kind: "editor" }> | undefined {
  return center.segments.find(
    (s): s is Extract<CenterSegment, { kind: "editor" }> => s.kind === "editor",
  );
}

export function hasCenterTools(state: LayoutState): boolean {
  return getToolSegments(state.center).some((s) => s.panels.length > 0);
}

/** center content（エディタ / center tool 列）が表示中か */
export function isCenterContentVisible(state: LayoutState): boolean {
  if (state.center.editorOpen) return true;
  return getToolSegments(state.center).some((s) => s.activePanel !== null);
}

/** @deprecated use isCenterContentVisible — 後方互換のエイリアス */
export function isCenterBandVisible(state: LayoutState): boolean {
  return isCenterContentVisible(state);
}

export function getCenterHorizontalReserve(state: LayoutState): number {
  if (!isCenterContentVisible(state)) return 0;

  let reserve = 0;
  if (state.center.editorOpen) {
    reserve += MIN_EDITOR_SIZE;
  }

  const openToolCount = getToolSegments(state.center).filter(
    (s) => s.activePanel !== null,
  ).length;
  reserve += openToolCount * MIN_SLOT_SIZE;

  return reserve;
}

export function centerToolSegmentToSlot(segment: CenterToolSegment): SlotState {
  return {
    id: segment.id,
    sizeRatio: segment.sizeRatio,
    panels: segment.panels,
    activePanel: segment.activePanel,
  };
}

export function validateLayoutState(
  state: LayoutState,
  options: { viewport?: { width: number; height: number } } = {},
): LayoutValidationResult {
  const viewport = options.viewport ?? { width: 4096, height: 4096 };
  const seenPanels = new Set<ToolWindowPanelId>();

  if (!state.center) {
    return { valid: false, reason: "missing center state" };
  }

  const editorSegments = state.center.segments.filter(
    (s) => s.kind === "editor",
  );
  if (editorSegments.length > 1) {
    return { valid: false, reason: "multiple editor segments" };
  }
  if (editorSegments.length === 0) {
    return { valid: false, reason: "missing editor segment" };
  }

  const centerSegmentIds = new Set<string>();
  for (const segment of state.center.segments) {
    if (centerSegmentIds.has(segment.id)) {
      return {
        valid: false,
        reason: `duplicate center segment id: ${segment.id}`,
      };
    }
    centerSegmentIds.add(segment.id);

    if (!Number.isFinite(segment.sizeRatio) || segment.sizeRatio <= 0) {
      return {
        valid: false,
        reason: `invalid sizeRatio for center segment ${segment.id}`,
      };
    }

    if (segment.kind === "tool") {
      if (
        segment.activePanel !== null &&
        !segment.panels.includes(segment.activePanel)
      ) {
        return {
          valid: false,
          reason: `activePanel ${segment.activePanel} not in center segment ${segment.id}`,
        };
      }

      for (const panel of segment.panels) {
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

    const maxSize = clampRegionSize(
      regionId,
      Infinity,
      viewport,
      buildRegionSizeClampContext(state),
    );
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

export function normalizeCenterSegmentRatios(
  segments: CenterSegment[],
  editorOpen: boolean,
): CenterSegment[] {
  const openSegments = segments.filter((s) => {
    if (s.kind === "editor") return editorOpen;
    return s.activePanel !== null;
  });
  if (openSegments.length === 0) return segments;

  const sum = openSegments.reduce((acc, s) => acc + s.sizeRatio, 0);
  if (sum <= 0) return segments;

  const openIds = new Set(openSegments.map((s) => s.id));
  return segments.map((segment) => {
    if (!openIds.has(segment.id)) return segment;
    return { ...segment, sizeRatio: segment.sizeRatio / sum };
  });
}

export function normalizeFlexGrow(ratios: number[]): number[] {
  if (ratios.length === 0) return [];
  const sum = ratios.reduce((acc, r) => acc + r, 0);
  if (sum <= 0) return ratios.map(() => 1 / ratios.length);
  return ratios.map((r) => r / sum);
}

export function redistributeRatiosAfterRemovingOpenSlot(
  remainingSlots: SlotState[],
  removedSlot: SlotState,
): SlotState[] {
  if (removedSlot.activePanel === null) {
    return remainingSlots;
  }

  const openRemaining = remainingSlots.filter(
    (slot) => slot.activePanel !== null,
  );
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

export function redistributeRatiosAfterRemovingOpenCenterSegment(
  remainingSegments: CenterSegment[],
  removedSegment: CenterToolSegment,
  editorOpen: boolean,
): CenterSegment[] {
  if (removedSegment.activePanel === null) {
    return remainingSegments;
  }

  const openRemaining = remainingSegments.filter((segment) => {
    if (segment.kind === "editor") return editorOpen;
    return segment.activePanel !== null;
  });
  if (openRemaining.length === 0) {
    return remainingSegments;
  }

  const removedRatio = removedSegment.sizeRatio;
  const openSum = openRemaining.reduce((sum, s) => sum + s.sizeRatio, 0);

  const updated =
    openSum <= 0
      ? remainingSegments.map((segment) => {
          if (segment.kind === "editor" && editorOpen) {
            return { ...segment, sizeRatio: 1 };
          }
          if (segment.kind === "tool" && segment.activePanel !== null) {
            return { ...segment, sizeRatio: 1 };
          }
          return segment;
        })
      : remainingSegments.map((segment) => {
          const isOpen =
            segment.kind === "editor"
              ? editorOpen
              : segment.activePanel !== null;
          if (!isOpen) return segment;
          return {
            ...segment,
            sizeRatio:
              segment.sizeRatio + removedRatio * (segment.sizeRatio / openSum),
          };
        });

  return normalizeCenterSegmentRatios(updated, editorOpen);
}

export function getRegionContentSize(
  regionId: RegionId,
  layout: LayoutState,
): number {
  const region = layout.regions[regionId];
  const hasOpen = region.slots.some((s) => s.activePanel !== null);
  return hasOpen ? region.size : 0;
}

export function getSlotLayoutBudget(
  openSlotCount: number,
  layoutBudgetPx: number,
  gutterPx: number = SPLITTER_GUTTER_PX,
): number {
  if (openSlotCount <= 0) return 0;
  const gutterTotal = Math.max(0, openSlotCount - 1) * gutterPx;
  return Math.max(0, layoutBudgetPx - gutterTotal);
}

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

export function getOpenCenterSegmentPixelSizes(
  center: CenterState,
  layoutBudgetPx: number,
): Map<string, number> {
  const openSegments = center.segments.filter((s) => {
    if (s.kind === "editor") return center.editorOpen;
    return s.activePanel !== null;
  });
  const budget = getSlotLayoutBudget(openSegments.length, layoutBudgetPx);
  const ratioSum = openSegments.reduce((sum, s) => sum + s.sizeRatio, 0);
  const sizes = new Map<string, number>();

  for (const segment of openSegments) {
    sizes.set(
      segment.id,
      ratioSum > 0 ? budget * (segment.sizeRatio / ratioSum) : 0,
    );
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

export function redistributeSpaceOnEditorClose(
  state: LayoutState,
  viewport: { width: number; height: number },
): LayoutState {
  if (isCenterContentVisible(state)) return state;

  const next = cloneLayoutState(state);
  const leftOpen = isRegionOpen(next.regions.left);
  const rightOpen = isRegionOpen(next.regions.right);
  if (!leftOpen && !rightOpen) return next;

  const fixedHorizontal =
    (regionHasRegisteredPanels(next.regions.left) ? STRIPE_SIZE : 0) +
    (regionHasRegisteredPanels(next.regions.right) ? STRIPE_SIZE : 0) +
    (leftOpen ? SPLITTER_GUTTER_PX : 0) +
    (rightOpen ? SPLITTER_GUTTER_PX : 0);

  const available = Math.max(0, viewport.width - fixedHorizontal);
  const leftSize = leftOpen ? next.regions.left.size : 0;
  const rightSize = rightOpen ? next.regions.right.size : 0;
  const total = leftSize + rightSize;

  if (total <= 0 || available <= total) return next;

  const extra = available - total;
  const clampContext = buildRegionSizeClampContext(next);
  const fillerRegion = computeFillerRegion({
    centerBandVisible: false,
    leftOpen,
    rightOpen,
  });

  if (leftOpen && rightOpen) {
    if (fillerRegion === "right") {
      next.regions.left.size = clampRegionSize(
        "left",
        Math.round(leftSize + extra),
        viewport,
        clampContext,
      );
    } else if (fillerRegion === "left") {
      next.regions.right.size = clampRegionSize(
        "right",
        Math.round(rightSize + extra),
        viewport,
        clampContext,
      );
    } else {
      const leftShare = leftSize / total;
      next.regions.left.size = clampRegionSize(
        "left",
        Math.round(leftSize + extra * leftShare),
        viewport,
        clampContext,
      );
      next.regions.right.size = clampRegionSize(
        "right",
        Math.round(rightSize + extra * (1 - leftShare)),
        viewport,
        clampContext,
      );
    }
  } else if (leftOpen) {
    next.regions.left.size = clampRegionSize(
      "left",
      Math.round(leftSize + extra),
      viewport,
      clampContext,
    );
  } else if (rightOpen) {
    next.regions.right.size = clampRegionSize(
      "right",
      Math.round(rightSize + extra),
      viewport,
      clampContext,
    );
  }

  return next;
}

export function clampLayoutStateForViewport(
  state: LayoutState,
  viewport: { width: number; height: number },
): LayoutState {
  const next = cloneLayoutState(state);
  const clampContext = buildRegionSizeClampContext(next);

  for (const regionId of ALL_REGIONS) {
    next.regions[regionId].size = clampRegionSize(
      regionId,
      next.regions[regionId].size,
      viewport,
      clampContext,
    );
  }

  const fillerRegion = computeFillerRegion({
    centerBandVisible: clampContext.centerBandVisible,
    leftOpen: clampContext.leftOpen,
    rightOpen: clampContext.rightOpen,
  });

  // filler あり: 固定側だけ px、相手は 1fr のため合算スケール不要
  if (fillerRegion !== null) return next;

  const leftSize = next.regions.left.size;
  const rightSize = next.regions.right.size;
  const horizontalTotal = leftSize + rightSize;
  const leftOpen = clampContext.leftOpen;
  const rightOpen = clampContext.rightOpen;
  const fixedHorizontal =
    (regionHasRegisteredPanels(next.regions.left) ? STRIPE_SIZE : 0) +
    (regionHasRegisteredPanels(next.regions.right) ? STRIPE_SIZE : 0) +
    (leftOpen ? SPLITTER_GUTTER_PX : 0) +
    (rightOpen ? SPLITTER_GUTTER_PX : 0);
  const centerReserve = getCenterHorizontalReserve(next);
  const maxHorizontal = viewport.width - centerReserve - fixedHorizontal;

  if (horizontalTotal > maxHorizontal && horizontalTotal > 0) {
    const scale = maxHorizontal / horizontalTotal;
    next.regions.left.size = clampRegionSize(
      "left",
      Math.round(leftSize * scale),
      viewport,
      clampContext,
    );
    next.regions.right.size = clampRegionSize(
      "right",
      Math.round(rightSize * scale),
      viewport,
      clampContext,
    );
  }

  return next;
}

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

export function applyAdjacentCenterSegmentPixelSizes(
  layout: LayoutState,
  segmentIdA: string,
  segmentIdB: string,
  pxA: number,
  pxB: number,
  layoutBudgetPx: number,
): LayoutState {
  const { center } = layout;
  const openSegments = center.segments.filter((s) => {
    if (s.kind === "editor") return center.editorOpen;
    return s.activePanel !== null;
  });
  const budget = getSlotLayoutBudget(openSegments.length, layoutBudgetPx);
  const otherSegments = openSegments.filter(
    (s) => s.id !== segmentIdA && s.id !== segmentIdB,
  );
  const remainingBudget = Math.max(0, budget - pxA - pxB);
  const otherRatioSum = otherSegments.reduce((sum, s) => sum + s.sizeRatio, 0);

  const pixelSizes = new Map<string, number>();
  pixelSizes.set(segmentIdA, pxA);
  pixelSizes.set(segmentIdB, pxB);
  for (const segment of otherSegments) {
    pixelSizes.set(
      segment.id,
      otherRatioSum > 0
        ? remainingBudget * (segment.sizeRatio / otherRatioSum)
        : 0,
    );
  }

  return updateCenter(layout, (center) => ({
    ...center,
    segments: normalizeCenterSegmentRatios(
      center.segments.map((segment) => {
        const isOpen =
          segment.kind === "editor"
            ? center.editorOpen
            : segment.activePanel !== null;
        if (!isOpen) return segment;
        const px = pixelSizes.get(segment.id);
        return px != null ? { ...segment, sizeRatio: px } : segment;
      }),
      center.editorOpen,
    ),
  }));
}

export function buildRegionSizeClampContext(
  state: LayoutState,
): RegionSizeClampContext {
  return {
    centerBandVisible: isCenterContentVisible(state),
    leftOpen: isRegionOpen(state.regions.left),
    rightOpen: isRegionOpen(state.regions.right),
    hasLeft: state.regions.left.slots.some((slot) => slot.panels.length > 0),
    hasRight: state.regions.right.slots.some((slot) => slot.panels.length > 0),
  };
}

export function isRegionOpen(region: RegionState): boolean {
  return region.slots.some((s) => s.activePanel !== null);
}

export function findPanelLocation(
  state: LayoutState,
  panelId: PanelId,
): PanelLocation | null {
  if (panelId === "editor") return null;

  for (const segment of getToolSegments(state.center)) {
    const segmentIndex = state.center.segments.indexOf(segment);
    if (segment.panels.includes(panelId)) {
      return {
        region: "center",
        slotIndex: segmentIndex,
        slot: centerToolSegmentToSlot(segment),
      };
    }
  }

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

export function removePanelFromSideSlots(
  state: LayoutState,
  panelIds: ToolWindowPanelId[],
): LayoutState {
  let next = cloneLayoutState(state);
  for (const panelId of panelIds) {
    const location = findPanelLocation(next, panelId);
    if (!location || location.region === "center") continue;
    next = updateRegion(next, location.region, (region) => ({
      ...region,
      slots: removePanelFromSlot(region.slots, location.slotIndex, panelId)
        .slots,
    }));
  }
  return next;
}

export function removePanelFromSlot(
  slots: SlotState[],
  slotIndex: number,
  panel: ToolWindowPanelId,
): { slots: SlotState[] } {
  const slot = slots[slotIndex];
  const removedActive = slot.activePanel === panel;
  const nextPanels = slot.panels.filter((p) => p !== panel);

  if (nextPanels.length === 0) {
    const removedSlot = slot;
    const remainingSlots = slots.filter((_, i) => i !== slotIndex);
    return {
      slots: redistributeRatiosAfterRemovingOpenSlot(
        remainingSlots,
        removedSlot,
      ),
    };
  }

  return {
    slots: slots.map((s, i) =>
      i === slotIndex
        ? {
            ...s,
            panels: nextPanels,
            activePanel: removedActive ? null : s.activePanel,
          }
        : s,
    ),
  };
}

export function removePanelFromCenterSegment(
  segments: CenterSegment[],
  segmentIndex: number,
  panel: ToolWindowPanelId,
  editorOpen: boolean,
): CenterSegment[] {
  const segment = segments[segmentIndex];
  if (segment.kind !== "tool") return segments;

  const removedActive = segment.activePanel === panel;
  const nextPanels = segment.panels.filter((p) => p !== panel);

  if (nextPanels.length === 0) {
    const removedSegment = segment;
    const remaining = segments.filter((_, i) => i !== segmentIndex);
    return redistributeRatiosAfterRemovingOpenCenterSegment(
      remaining,
      removedSegment,
      editorOpen,
    );
  }

  return segments.map((s, i) => {
    if (i !== segmentIndex || s.kind !== "tool") return s;
    return {
      ...s,
      panels: nextPanels,
      activePanel: removedActive ? null : s.activePanel,
    };
  });
}

export function getOpenSlots(slots: SlotState[]): SlotState[] {
  return slots.filter((s) => s.activePanel !== null);
}

export function resetLayoutStateToDefault(): LayoutState {
  return buildDefaultLayoutState({ allInactive: true });
}

export function cloneLayoutState(state: LayoutState): LayoutState {
  return structuredClone(state);
}

export function updateRegion(
  state: LayoutState,
  regionId: RegionId,
  updater: (region: RegionState) => RegionState,
): LayoutState {
  return {
    ...state,
    regions: {
      ...state.regions,
      [regionId]: updater(state.regions[regionId]),
    },
  };
}

export function updateCenter(
  state: LayoutState,
  updater: (center: CenterState) => CenterState,
): LayoutState {
  return {
    ...state,
    center: updater(state.center),
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

export function updateCenterToolSegment(
  state: LayoutState,
  segmentId: string,
  updater: (segment: CenterToolSegment) => CenterToolSegment,
): LayoutState {
  return updateCenter(state, (center) => ({
    ...center,
    segments: center.segments.map((segment) =>
      segment.id === segmentId && segment.kind === "tool"
        ? updater(segment)
        : segment,
    ),
  }));
}

export function generateSlotId(region: RegionId): string {
  return `${REGION_SLOT_PREFIX[region]}${crypto.randomUUID().slice(0, 8)}`;
}

export function generateCenterToolSegmentId(): string {
  return `ct${crypto.randomUUID().slice(0, 8)}`;
}

export function addPanelToSlot(
  slot: SlotState,
  panel: ToolWindowPanelId,
): SlotState {
  const panels = slot.panels.includes(panel)
    ? slot.panels
    : [...slot.panels, panel];
  return { ...slot, panels, activePanel: panel };
}

export function addPanelToCenterToolSegment(
  segment: CenterToolSegment,
  panel: ToolWindowPanelId,
): CenterToolSegment {
  const panels = segment.panels.includes(panel)
    ? segment.panels
    : [...segment.panels, panel];
  return { ...segment, panels, activePanel: panel };
}

export function buildCenterSegmentsWithTools(
  toolPanels: ToolWindowPanelId[],
  activePanels: Partial<Record<ToolWindowPanelId, boolean>>,
): CenterSegment[] {
  const segments: CenterSegment[] = [
    { id: DEFAULT_EDITOR_SEGMENT_ID, kind: "editor", sizeRatio: 1 },
  ];

  for (const panelId of toolPanels) {
    const active = activePanels[panelId] === true ? panelId : null;
    segments.push({
      id: generateCenterToolSegmentId(),
      kind: "tool",
      sizeRatio: 1,
      panels: [panelId],
      activePanel: active,
    });
  }

  return normalizeCenterSegmentRatios(segments, true);
}
