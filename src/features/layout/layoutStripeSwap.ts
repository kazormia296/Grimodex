/**
 * Grid-aligned stripe icon swap within a slot (axis-lock reorder).
 * Mirrors src/features/grid/gridDndUtils.ts scene/column axis-lock helpers.
 */

import type {
  LayoutRegionId,
  LayoutState,
  ToolWindowPanelId,
} from "./layoutTypes";

export type StripeDragMode = "axis-locked" | "free";

export type StripeAxis = "vertical" | "horizontal";

export interface StripeIconRect {
  start: number;
  end: number;
}

export function stripeAxisForRegion(region: LayoutRegionId): StripeAxis {
  if (region === "bottom" || region === "center") return "horizontal";
  return "vertical";
}

export function resolveStripeDragMode(
  currentMode: StripeDragMode,
  deltaOffAxis: number,
  thresholdPx: number,
): StripeDragMode {
  if (currentMode === "free") return "free";
  return Math.abs(deltaOffAxis) >= thresholdPx ? "free" : "axis-locked";
}

export function offAxisDelta(
  axis: StripeAxis,
  deltaX: number,
  deltaY: number,
): number {
  return axis === "vertical" ? deltaX : deltaY;
}

export function axisPointerCoord(
  axis: StripeAxis,
  clientX: number,
  clientY: number,
): number {
  return axis === "vertical" ? clientY : clientX;
}

export function collectStripeIconRects(
  segmentEl: HTMLElement,
  panels: ToolWindowPanelId[],
  axis: StripeAxis,
): Record<string, StripeIconRect> {
  const rects: Record<string, StripeIconRect> = {};
  for (const panelId of panels) {
    const el = segmentEl.querySelector(`[data-stripe-icon="${panelId}"]`);
    if (!(el instanceof HTMLElement)) continue;
    const r = el.getBoundingClientRect();
    rects[panelId] =
      axis === "vertical"
        ? { start: r.top, end: r.bottom }
        : { start: r.left, end: r.right };
  }
  return rects;
}

/**
 * Midpoint-based insert index for axis-locked stripe reorder.
 * Returns null when the active icon would stay in its current slot (no-op).
 */
export function computeStripeAxisLockInsertIndex(
  activePanelId: ToolWindowPanelId,
  pointerCoord: number,
  panels: ToolWindowPanelId[],
  siblingRects: Record<string, StripeIconRect>,
): number | null {
  const activeIdx = panels.indexOf(activePanelId);
  if (activeIdx < 0 || panels.length <= 1) return null;

  const panelsExcl = panels.filter((id) => id !== activePanelId);
  let targetIdx = 0;
  let sawRect = false;
  for (const panelId of panelsExcl) {
    const rect = siblingRects[panelId];
    if (!rect) continue;
    sawRect = true;
    const mid = (rect.start + rect.end) / 2;
    if (pointerCoord > mid) targetIdx++;
  }
  if (!sawRect) return null;

  const equivalentFullIdx = targetIdx <= activeIdx ? targetIdx : targetIdx + 1;
  if (equivalentFullIdx === activeIdx) return null;

  return equivalentFullIdx;
}

type StripeShiftDir = "toward-start" | "toward-end";

/**
 * Which siblings should visually slide during axis-locked drag.
 * toward-start = toward column top / row left; toward-end = bottom / right.
 */
export function computeStripeAxisLockShifts(
  activePanelId: ToolWindowPanelId,
  pointerCoord: number,
  panels: ToolWindowPanelId[],
  siblingRects: Record<string, StripeIconRect>,
): Map<ToolWindowPanelId, StripeShiftDir> {
  const result = new Map<ToolWindowPanelId, StripeShiftDir>();
  const activeIdx = panels.indexOf(activePanelId);
  if (activeIdx < 0) return result;

  for (let i = 0; i < panels.length; i++) {
    if (i === activeIdx) continue;
    const panelId = panels[i];
    const rect = siblingRects[panelId];
    if (!rect) continue;
    const mid = (rect.start + rect.end) / 2;
    if (i < activeIdx && pointerCoord < mid) {
      result.set(panelId, "toward-end");
    } else if (i > activeIdx && pointerCoord > mid) {
      result.set(panelId, "toward-start");
    }
  }
  return result;
}

export function computeStripeAxisLockPxOffsets(
  activePanelId: ToolWindowPanelId,
  pointerCoord: number,
  panels: ToolWindowPanelId[],
  siblingRects: Record<string, StripeIconRect>,
  gapPx: number,
): Partial<Record<ToolWindowPanelId, number>> {
  const result: Partial<Record<ToolWindowPanelId, number>> = {};
  const activeRect = siblingRects[activePanelId];
  if (!activeRect) return result;

  const activeSlot = activeRect.end - activeRect.start + gapPx;
  const directions = computeStripeAxisLockShifts(
    activePanelId,
    pointerCoord,
    panels,
    siblingRects,
  );

  let activeOffset = 0;
  for (const [panelId, dir] of directions) {
    const rect = siblingRects[panelId];
    if (!rect) continue;
    const sibSlot = rect.end - rect.start + gapPx;
    if (dir === "toward-start") {
      result[panelId] = -activeSlot;
      activeOffset += sibSlot;
    } else {
      result[panelId] = activeSlot;
      activeOffset -= sibSlot;
    }
  }
  if (activeOffset !== 0) {
    result[activePanelId] = activeOffset;
  }
  return result;
}

export function getSlotPanelIds(
  layout: LayoutState,
  region: LayoutRegionId,
  slotId: string,
): ToolWindowPanelId[] | null {
  if (region === "center") {
    const segment = layout.center.segments.find((seg) => seg.id === slotId);
    if (!segment || segment.kind !== "tool") return null;
    return segment.panels;
  }
  const slot = layout.regions[region].slots.find((s) => s.id === slotId);
  return slot?.panels ?? null;
}
