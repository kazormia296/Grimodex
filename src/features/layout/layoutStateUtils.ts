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
  OUTER_PAD_PX,
  regionSplitterPx,
  STRIPE_GAP_PX,
  STRIPE_SIZE,
  type RegionSizeClampContext,
} from "./layoutConstants";
import { isCardLayout } from "./cardLayout";
import {
  applyAdjacentItemPixelSizes,
  getOpenItemPixelSizes,
  normalizeOpenItemRatios,
  redistributeRatiosAfterRemoval,
} from "./layoutTrackMath";
import type {
  BottomCornerOwnership,
  CenterSegment,
  CenterState,
  CenterToolSegment,
  LayoutState,
  LayoutStateV2,
  LayoutValidationResult,
  LayoutRegionId,
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
  const v3 = isLayoutStateV2(state)
    ? stripUnknownPanels(migrateLayoutStateV2toV3(state))
    : stripUnknownPanels(cloneLayoutState(state));
  return ensureRegisteredPanels(v3);
}

/**
 * 新しく登録されたが保存済みレイアウト/カスタムプリセットに含まれないパネルを、
 * その既定リージョンの slot へ注入する。`validateLayoutState` は全
 * `TOOL_WINDOW_PANEL_IDS` がどこかの slot に登録されていることを必須とするため、
 * これが無いと新パネル追加で既存ユーザーのレイアウトが invalid → builtin:default
 * へリセット（カスタム配置喪失）になる。汎用＝将来の新パネルにも効く。冪等。
 *
 * `stripUnknownPanels` と対の関係: あちらは未知パネルを除去し、こちらは未登録の
 * 既知パネルを補充する。`ensureLayoutStateV3` で strip の後に必ず呼ぶこと。
 * builtin プリセット解決（layoutPresets）でも、新パネルが全プリセットに自動で
 * 現れるよう同関数を通す。
 */
export function ensureRegisteredPanels(state: LayoutState): LayoutState {
  const seen = new Set<string>();
  for (const regionId of ALL_REGIONS)
    for (const slot of state.regions[regionId]?.slots ?? [])
      for (const p of slot.panels) seen.add(p);
  for (const seg of state.center.segments)
    if (seg.kind === "tool") for (const p of seg.panels) seen.add(p);

  for (const panelId of TOOL_WINDOW_PANEL_IDS) {
    if (seen.has(panelId)) continue;
    const regionId = DEFAULT_REGION_MAP[panelId];
    const region = state.regions[regionId];
    if (!region) continue;
    const idx = DEFAULT_INDEX_MAP[panelId];
    let target = region.slots[idx] ?? region.slots[0];
    if (!target) {
      target = {
        id: `auto-${panelId}`,
        sizeRatio: 1,
        panels: [] as ToolWindowPanelId[],
        activePanel: null,
      };
      region.slots.push(target);
    }
    target.panels.push(panelId);
    region.slots = normalizeSlotRatios(region.slots);
    seen.add(panelId);
  }
  return state;
}

/**
 * Drop panels that are no longer registered (e.g. a removed tool window like
 * `timelapse`) from a persisted layout, so stale ids can't reach the renderer —
 * `panelIcons[id]` / `PANEL_COMPONENT_MAP[id]` would be `undefined` and crash.
 *
 * Surgical: every other customization is preserved. An orphaned `activePanel`
 * falls back to the slot's first remaining panel (or null); slots / tool
 * segments left empty are removed and the surviving ratios renormalized. The
 * editor segment is always kept. Idempotent (re-running changes nothing).
 *
 * Mutates and returns `state` — callers (`ensureLayoutStateV3`) pass a fresh
 * clone, so this never leaks into a shared object.
 */
function stripUnknownPanels(state: LayoutState): LayoutState {
  const known = new Set<string>(TOOL_WINDOW_PANEL_IDS);

  for (const regionId of ALL_REGIONS) {
    const region = state.regions[regionId];
    if (!region) continue;
    for (const slot of region.slots) {
      slot.panels = slot.panels.filter((p) => known.has(p));
      if (slot.activePanel && !slot.panels.includes(slot.activePanel)) {
        slot.activePanel = slot.panels[0] ?? null;
      }
    }
    region.slots = normalizeSlotRatios(
      region.slots.filter((s) => s.panels.length > 0),
    );
  }

  for (const seg of state.center.segments) {
    if (seg.kind === "tool") {
      seg.panels = seg.panels.filter((p) => known.has(p));
      if (seg.activePanel && !seg.panels.includes(seg.activePanel)) {
        seg.activePanel = seg.panels[0] ?? null;
      }
    }
  }
  state.center.segments = normalizeCenterSegmentRatios(
    state.center.segments.filter(
      (s) => s.kind === "editor" || s.panels.length > 0,
    ),
    state.center.editorOpen,
  );

  return state;
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
    bottomCorners: { left: false, right: false },
  };
}

/**
 * ボトム角オーナーシップを取得（未指定の永続データは both false 既定）。
 * true = bottom region が角を取る / false = side stripe。
 */
export function getBottomCorners(state: LayoutState): BottomCornerOwnership {
  return state.bottomCorners ?? { left: false, right: false };
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

/**
 * center content 列の実効幅(px)。editor が開いていれば filler region は
 * 生じないため、viewport から固定 chrome と side region 幅を引いて算出する。
 */
export function getCenterContentWidthPx(
  state: LayoutState,
  viewport: { width: number },
): number {
  const cardLayout = isCardLayout();
  const splitterPx = regionSplitterPx(cardLayout);
  const stripeChrome = STRIPE_SIZE + (cardLayout ? STRIPE_GAP_PX : 0);
  const leftOpen = isRegionOpen(state.regions.left);
  const rightOpen = isRegionOpen(state.regions.right);
  const sideChrome =
    (cardLayout ? OUTER_PAD_PX * 2 : 0) +
    (regionHasRegisteredPanels(state.regions.left) ? stripeChrome : 0) +
    (regionHasRegisteredPanels(state.regions.right) ? stripeChrome : 0) +
    (leftOpen ? splitterPx + state.regions.left.size : 0) +
    (rightOpen ? splitterPx + state.regions.right.size : 0);
  return viewport.width - sideChrome;
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

/** slot が開いている（アクティブパネルを持つ）か。 */
function slotIsOpen(slot: SlotState): boolean {
  return slot.activePanel !== null;
}

/** center segment が開いているか（editor は editorOpen、tool は activePanel）。 */
function centerSegmentIsOpen(
  segment: CenterSegment,
  editorOpen: boolean,
): boolean {
  return segment.kind === "editor" ? editorOpen : segment.activePanel !== null;
}

export function normalizeSlotRatios(slots: SlotState[]): SlotState[] {
  return normalizeOpenItemRatios(slots, slotIsOpen);
}

export function normalizeCenterSegmentRatios(
  segments: CenterSegment[],
  editorOpen: boolean,
): CenterSegment[] {
  return normalizeOpenItemRatios(segments, (s) =>
    centerSegmentIsOpen(s, editorOpen),
  );
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
  return redistributeRatiosAfterRemoval(
    remainingSlots,
    removedSlot,
    slotIsOpen,
  );
}

export function redistributeRatiosAfterRemovingOpenCenterSegment(
  remainingSegments: CenterSegment[],
  removedSegment: CenterToolSegment,
  editorOpen: boolean,
): CenterSegment[] {
  return redistributeRatiosAfterRemoval(
    remainingSegments,
    removedSegment,
    (s) => centerSegmentIsOpen(s, editorOpen),
  );
}

export function getRegionContentSize(
  regionId: RegionId,
  layout: LayoutState,
): number {
  const region = layout.regions[regionId];
  const hasOpen = region.slots.some((s) => s.activePanel !== null);
  return hasOpen ? region.size : 0;
}

export function getOpenSlotPixelSizesForRegion(
  region: RegionState,
  layoutBudgetPx: number,
): Map<string, number> {
  return getOpenItemPixelSizes(region.slots, slotIsOpen, layoutBudgetPx);
}

export function getOpenCenterSegmentPixelSizes(
  center: CenterState,
  layoutBudgetPx: number,
): Map<string, number> {
  return getOpenItemPixelSizes(
    center.segments,
    (s) => centerSegmentIsOpen(s, center.editorOpen),
    layoutBudgetPx,
  );
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

  const cardLayout = isCardLayout();
  const splitterPx = regionSplitterPx(cardLayout);
  const stripeChrome = STRIPE_SIZE + (cardLayout ? STRIPE_GAP_PX : 0);
  const fixedHorizontal =
    (cardLayout ? OUTER_PAD_PX * 2 : 0) +
    (regionHasRegisteredPanels(next.regions.left) ? stripeChrome : 0) +
    (regionHasRegisteredPanels(next.regions.right) ? stripeChrome : 0) +
    (leftOpen ? splitterPx : 0) +
    (rightOpen ? splitterPx : 0);

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
  const cardLayout = isCardLayout();
  const splitterPx = regionSplitterPx(cardLayout);
  const stripeChrome = STRIPE_SIZE + (cardLayout ? STRIPE_GAP_PX : 0);
  const fixedHorizontal =
    (cardLayout ? OUTER_PAD_PX * 2 : 0) +
    (regionHasRegisteredPanels(next.regions.left) ? stripeChrome : 0) +
    (regionHasRegisteredPanels(next.regions.right) ? stripeChrome : 0) +
    (leftOpen ? splitterPx : 0) +
    (rightOpen ? splitterPx : 0);
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
  return updateRegion(layout, regionId, (region) => ({
    ...region,
    slots: applyAdjacentItemPixelSizes(
      region.slots,
      slotIsOpen,
      slotIdA,
      slotIdB,
      pxA,
      pxB,
      layoutBudgetPx,
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
  return updateCenter(layout, (center) => ({
    ...center,
    segments: applyAdjacentItemPixelSizes(
      center.segments,
      (s) => centerSegmentIsOpen(s, center.editorOpen),
      segmentIdA,
      segmentIdB,
      pxA,
      pxB,
      layoutBudgetPx,
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
    leftSize: state.regions.left.size,
    rightSize: state.regions.right.size,
    centerReserve: getCenterHorizontalReserve(state),
    cardLayout: isCardLayout(),
  };
}

export function getCenterSegmentMinSize(
  center: CenterState,
  segmentId: string,
): number {
  const segment = center.segments.find((s) => s.id === segmentId);
  if (segment?.kind === "editor") return MIN_EDITOR_SIZE;
  return MIN_SLOT_SIZE;
}

export function nudgeAdjacentCenterSegmentPixelSizes(
  center: CenterState,
  segmentIdA: string,
  segmentIdB: string,
  deltaPx: number,
  layoutBudgetPx: number,
): { pxA: number; pxB: number } | null {
  const pixelSizes = getOpenCenterSegmentPixelSizes(center, layoutBudgetPx);
  const prevPx = pixelSizes.get(segmentIdA) ?? 0;
  const currPx = pixelSizes.get(segmentIdB) ?? 0;
  const minA = getCenterSegmentMinSize(center, segmentIdA);
  const minB = getCenterSegmentMinSize(center, segmentIdB);
  const total = prevPx + currPx;
  const newPrev = Math.min(Math.max(prevPx + deltaPx, minA), total - minB);
  const newCurr = total - newPrev;
  if (newPrev === prevPx && newCurr === currPx) return null;
  return { pxA: newPrev, pxB: newCurr };
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

function nextActivePanelAfterRemoval(
  panels: ToolWindowPanelId[],
  removedPanel: ToolWindowPanelId,
  remainingPanels: ToolWindowPanelId[],
): ToolWindowPanelId {
  const removedIdx = panels.indexOf(removedPanel);
  for (let i = removedIdx + 1; i < panels.length; i++) {
    const candidate = panels[i];
    if (remainingPanels.includes(candidate)) {
      return candidate;
    }
  }
  return remainingPanels[0];
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

  const nextActivePanel = removedActive
    ? nextActivePanelAfterRemoval(slot.panels, panel, nextPanels)
    : slot.activePanel;

  return {
    slots: slots.map((s, i) =>
      i === slotIndex
        ? {
            ...s,
            panels: nextPanels,
            activePanel: nextActivePanel,
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

  const nextActivePanel = removedActive
    ? nextActivePanelAfterRemoval(segment.panels, panel, nextPanels)
    : segment.activePanel;

  return segments.map((s, i) => {
    if (i !== segmentIndex || s.kind !== "tool") return s;
    return {
      ...s,
      panels: nextPanels,
      activePanel: nextActivePanel,
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

/** region 内に登録されている tool panel id（stripe 一括操作の対象収集用） */
export function collectPanelsInLayoutRegion(
  layout: LayoutState,
  region: LayoutRegionId,
): ToolWindowPanelId[] {
  const panels = new Set<ToolWindowPanelId>();
  if (region === "center") {
    for (const segment of getToolSegments(layout.center)) {
      for (const panelId of segment.panels) {
        panels.add(panelId);
      }
    }
    return [...panels];
  }
  for (const slot of layout.regions[region].slots) {
    for (const panelId of slot.panels) {
      panels.add(panelId);
    }
  }
  return [...panels];
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

function reorderPanelsArray(
  panels: ToolWindowPanelId[],
  panel: ToolWindowPanelId,
  insertIndex: number,
): ToolWindowPanelId[] {
  const currentIndex = panels.indexOf(panel);
  if (currentIndex < 0) return panels;

  let targetIndex = Math.max(0, Math.min(insertIndex, panels.length));
  if (currentIndex < targetIndex) {
    targetIndex -= 1;
  }
  if (targetIndex === currentIndex) return panels;

  const next = [...panels];
  next.splice(currentIndex, 1);
  next.splice(targetIndex, 0, panel);
  return next;
}

export function reorderPanelInSlot(
  slots: SlotState[],
  slotId: string,
  panel: ToolWindowPanelId,
  insertIndex: number,
): SlotState[] {
  return slots.map((slot) =>
    slot.id === slotId
      ? {
          ...slot,
          panels: reorderPanelsArray(slot.panels, panel, insertIndex),
        }
      : slot,
  );
}

export function reorderPanelInCenterSegment(
  segments: CenterSegment[],
  segmentId: string,
  panel: ToolWindowPanelId,
  insertIndex: number,
): CenterSegment[] {
  return segments.map((segment) =>
    segment.id === segmentId && segment.kind === "tool"
      ? {
          ...segment,
          panels: reorderPanelsArray(segment.panels, panel, insertIndex),
        }
      : segment,
  );
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
