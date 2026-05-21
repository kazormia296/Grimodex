import { create } from "zustand";
import i18next from "@/lib/i18n";
import { invoke } from "@/lib/tauri";
import type { GlobalSettings } from "@/features/workspace/store";
import {
  getScreenshotCaptureId,
  getScreenshotPanelId,
  getScreenshotPresetId,
} from "@/screenshot-scenes/screenshotBootstrap";
import {
  addPanelToCenterToolSegment,
  addPanelToSlot,
  applyAdjacentCenterSegmentPixelSizes,
  applyAdjacentSlotPixelSizes,
  buildDefaultLayoutState,
  buildRegionSizeClampContext,
  cloneLayoutState,
  clampLayoutStateForViewport,
  ensureLayoutStateV3,
  findPanelLocation,
  generateCenterToolSegmentId,
  generateSlotId,
  getOpenCenterSegmentPixelSizes,
  getOpenSlotPixelSizes,
  getOpenSlots,
  migrateLayoutStateV2toV3,
  normalizeCenterSegmentRatios,
  normalizeSlotRatios,
  redistributeSpaceOnEditorClose,
  removePanelFromCenterSegment,
  removePanelFromSlot,
  resetLayoutStateToDefault,
  updateCenter,
  updateCenterToolSegment,
  updateRegion,
  validateLayoutState,
} from "./layoutStateUtils";
import { clampRegionSize, MIN_SLOT_SIZE } from "./layoutConstants";
import { getBuiltinPresetState, getBuiltinPresets } from "./layoutPresets";
import type {
  CenterSegment,
  CenterToolSegment,
  CustomLayoutPreset,
  LayoutRegionId,
  LayoutState,
  PersistedLayout,
  RegionId,
  SlotState,
  ToolWindowPanelId,
} from "./layoutTypes";
import { LAYOUT_SCHEMA_VERSION } from "./layoutTypes";
import { dragTargetsEqual, type DragOverTarget } from "./layoutDnD";
import type { PanelId } from "./panelIds";

export type { PanelId };
export { PANEL_DRAG_TYPE } from "./panelIds";
export { dragTargetsEqual, TOOL_WINDOW_REASSIGN_TYPE } from "./layoutDnD";

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let editorFocusHandler: (() => void) | null = null;

export function registerEditorFocusHandler(handler: (() => void) | null) {
  editorFocusHandler = handler;
}

export function getPanelTitle(id: PanelId): string {
  return i18next.t(`layout.panel.${id}`);
}

/** @deprecated v2 has no dockview titles — kept for call-site compat */
export function refreshPanelTitles() {
  /* no-op */
}

function getViewport(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1200, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function applyValidatedLayout(
  layout: LayoutState,
  viewport?: { width: number; height: number },
): LayoutState {
  const vp = viewport ?? getViewport();
  const clamped = clampLayoutStateForViewport(cloneLayoutState(layout), vp);
  const result = validateLayoutState(clamped, { viewport: vp });
  if (result.valid) return clamped;
  return resetLayoutStateToDefault();
}

function scheduleEditorFocus() {
  const focus = () => editorFocusHandler?.();
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(focus);
  } else {
    focus();
  }
}

function removePanelFromSource(
  layout: LayoutState,
  panel: ToolWindowPanelId,
): LayoutState {
  const source = findPanelLocation(layout, panel);
  if (!source) return layout;

  if (source.region === "center") {
    return updateCenter(layout, (center) => ({
      ...center,
      segments: removePanelFromCenterSegment(
        center.segments,
        source.slotIndex,
        panel,
        center.editorOpen,
      ),
    }));
  }

  return updateRegion(layout, source.region, (region) => ({
    ...region,
    slots: removePanelFromSlot(region.slots, source.slotIndex, panel).slots,
  }));
}

function addPanelToCenterSegmentById(
  segments: CenterSegment[],
  segmentId: string,
  panel: ToolWindowPanelId,
): CenterSegment[] {
  return segments.map((segment) =>
    segment.id === segmentId && segment.kind === "tool"
      ? addPanelToCenterToolSegment(segment, panel)
      : segment,
  );
}

function insertCenterToolSegment(
  segments: CenterSegment[],
  panel: ToolWindowPanelId,
  insertIndex: number,
  editorOpen: boolean,
): CenterSegment[] {
  const newSegment: CenterToolSegment = {
    id: generateCenterToolSegmentId(),
    kind: "tool",
    sizeRatio: 1,
    panels: [panel],
    activePanel: panel,
  };

  const next = [...segments];
  const index = Math.max(0, Math.min(insertIndex, next.length));
  next.splice(index, 0, newSegment);

  const openCount = next.filter((s) => {
    if (s.kind === "editor") return editorOpen;
    return s.activePanel !== null;
  }).length;

  return openCount > 1 ? normalizeCenterSegmentRatios(next, editorOpen) : next;
}

function movePanelInLayout(
  layout: LayoutState,
  panel: ToolWindowPanelId,
  targetRegion: LayoutRegionId,
  targetSlotId: string | null,
  insertIndex: number | null,
): LayoutState {
  const source = findPanelLocation(layout, panel);
  let next = cloneLayoutState(layout);

  const sourceSegmentRemoved =
    source != null &&
    source.region === "center" &&
    source.slot.panels.filter((p) => p !== panel).length === 0;

  const sourceSlotRemoved =
    source != null &&
    source.region !== "center" &&
    source.slot.panels.filter((p) => p !== panel).length === 0;

  if (source) {
    next = removePanelFromSource(next, panel);
  }

  if (targetRegion === "center") {
    const adjustedInsertIndex =
      insertIndex != null &&
      sourceSegmentRemoved &&
      source != null &&
      source.region === "center" &&
      source.slotIndex < insertIndex
        ? insertIndex - 1
        : insertIndex;

    next = updateCenter(next, (center) => {
      if (targetSlotId) {
        return {
          ...center,
          segments: addPanelToCenterSegmentById(
            center.segments,
            targetSlotId,
            panel,
          ),
        };
      }

      return {
        ...center,
        segments: insertCenterToolSegment(
          center.segments,
          panel,
          adjustedInsertIndex ?? center.segments.length,
          center.editorOpen,
        ),
      };
    });

    return next;
  }

  const adjustedInsertIndex =
    insertIndex != null &&
    sourceSlotRemoved &&
    source != null &&
    source.region === targetRegion &&
    source.slotIndex < insertIndex
      ? insertIndex - 1
      : insertIndex;

  next = updateRegion(next, targetRegion, (region) => {
    if (targetSlotId) {
      return {
        ...region,
        slots: region.slots.map((slot) =>
          slot.id === targetSlotId ? addPanelToSlot(slot, panel) : slot,
        ),
      };
    }

    const newSlot: SlotState = {
      id: generateSlotId(targetRegion),
      sizeRatio: 1,
      panels: [panel],
      activePanel: panel,
    };

    const slots = [...region.slots];
    const index =
      adjustedInsertIndex == null
        ? slots.length
        : Math.max(0, Math.min(adjustedInsertIndex, slots.length));
    slots.splice(index, 0, newSlot);

    const openSlots = getOpenSlots(slots);
    return {
      ...region,
      slots: openSlots.length > 1 ? normalizeSlotRatios(slots) : slots,
    };
  });

  return next;
}

function isPersistedLayoutV3(data: unknown): data is PersistedLayout {
  if (!data || typeof data !== "object") return false;
  const obj = data as PersistedLayout;
  return (
    obj.layoutVersion === LAYOUT_SCHEMA_VERSION &&
    obj.state != null &&
    typeof obj.state === "object" &&
    obj.state.regions != null &&
    obj.state.center != null
  );
}

function isPersistedLayoutV2(data: unknown): data is {
  layoutVersion: 2;
  state: LayoutState;
} {
  if (!data || typeof data !== "object") return false;
  const obj = data as { layoutVersion?: number; state?: unknown };
  return (
    obj.layoutVersion === 2 &&
    obj.state != null &&
    typeof obj.state === "object"
  );
}

function unhideStripePanel(
  hidden: Set<ToolWindowPanelId>,
  panel: ToolWindowPanelId,
): Set<ToolWindowPanelId> {
  if (!hidden.has(panel)) return hidden;
  const next = new Set(hidden);
  next.delete(panel);
  return next;
}

function scheduleSave(get: () => LayoutStoreState) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const { layout, activePresetId, customPresets, hiddenStripePanels } =
        get();
      const check = validateLayoutState(layout, { viewport: getViewport() });
      if (!check.valid) return;

      const current = await invoke<GlobalSettings>("get_global_settings");
      const persisted: PersistedLayout = {
        layoutVersion: LAYOUT_SCHEMA_VERSION,
        state: cloneLayoutState(layout),
        activePresetId: activePresetId ?? undefined,
        hiddenStripePanels:
          hiddenStripePanels.size > 0 ? [...hiddenStripePanels] : undefined,
      };

      await invoke("save_global_settings", {
        settings: {
          ...current,
          layoutVersion: LAYOUT_SCHEMA_VERSION,
          layout: persisted,
          activeLayoutPresetId: activePresetId ?? null,
          layoutPresets: customPresets.map((p) => ({
            id: p.id,
            name: p.name,
            state: p.state,
          })),
        },
      });
    } catch {
      /* ignore */
    }
  }, 500);
}

async function persistActivePresetId(id: string | null) {
  try {
    const current = await invoke<GlobalSettings>("get_global_settings");
    await invoke("save_global_settings", {
      settings: { ...current, activeLayoutPresetId: id },
    });
  } catch {
    /* ignore */
  }
}

async function persistPresets(
  presets: CustomLayoutPreset[],
  activeId: string | null,
) {
  try {
    const current = await invoke<GlobalSettings>("get_global_settings");
    await invoke("save_global_settings", {
      settings: {
        ...current,
        layoutPresets: presets.map((p) => ({
          id: p.id,
          name: p.name,
          state: p.state,
        })),
        activeLayoutPresetId: activeId,
      },
    });
  } catch {
    /* ignore */
  }
}

export async function clearSavedLayout() {
  try {
    const current = await invoke<GlobalSettings>("get_global_settings");
    const {
      layout: _l,
      toolWindows: _t,
      stripePanelIds: _s,
      ...rest
    } = current as GlobalSettings & {
      layout?: unknown;
      toolWindows?: unknown;
      stripePanelIds?: unknown;
    };
    await invoke("save_global_settings", {
      settings: {
        ...rest,
        layoutVersion: LAYOUT_SCHEMA_VERSION,
        layout: {
          layoutVersion: LAYOUT_SCHEMA_VERSION,
          state: buildDefaultLayoutState({ allInactive: true }),
        },
      },
    });
  } catch {
    /* ignore */
  }
}

export interface LayoutStoreState {
  layout: LayoutState;
  layoutLocked: boolean;
  draggingPanel: ToolWindowPanelId | null;
  dragOverTarget: DragOverTarget | null;
  panelDragSource: "html5" | "pointer" | null;
  activePresetId: string | null;
  customPresets: CustomLayoutPreset[];
  initialized: boolean;
  hiddenStripePanels: Set<ToolWindowPanelId>;

  togglePanel: (panel: PanelId) => void;
  showPanel: (panel: PanelId) => void;
  isPanelVisible: (panel: PanelId) => boolean;
  isPanelActive: (panel: PanelId) => boolean;
  openPanelAtSlot: (panel: PanelId) => void;
  requestEditorFocus: () => void;
  setEditorOpen: (open: boolean) => void;

  movePanelToSlot: (
    panel: PanelId,
    region: LayoutRegionId,
    slotId: string,
  ) => void;
  movePanelToRegion: (panel: PanelId, region: RegionId) => void;
  moveToRegion: (panel: PanelId, region: RegionId) => void;
  removePanelFromStripe: (panel: PanelId) => void;
  movePanelToNewSlot: (
    panel: PanelId,
    region: LayoutRegionId,
    insertIndex: number,
  ) => void;

  setRegionSize: (
    region: RegionId,
    size: number,
    viewport?: { width: number; height: number },
  ) => void;
  setRegionSizeLive: (
    region: RegionId,
    size: number,
    viewport?: { width: number; height: number },
  ) => void;
  nudgeRegionSize: (
    region: RegionId,
    deltaPx: number,
    viewport?: { width: number; height: number },
  ) => void;
  setSlotRatios: (
    region: RegionId,
    slotIdA: string,
    slotIdB: string,
    ratioA: number,
    ratioB: number,
    layoutBudgetPx: number,
  ) => void;
  nudgeAdjacentSlotSizes: (
    region: RegionId,
    slotIdA: string,
    slotIdB: string,
    deltaPx: number,
    layoutBudgetPx: number,
  ) => void;
  setCenterSegmentRatios: (
    segmentIdA: string,
    segmentIdB: string,
    ratioA: number,
    ratioB: number,
    layoutBudgetPx: number,
  ) => void;
  nudgeAdjacentCenterSegmentSizes: (
    segmentIdA: string,
    segmentIdB: string,
    deltaPx: number,
    layoutBudgetPx: number,
  ) => void;
  finalizeLayoutResize: () => void;

  setDraggingPanel: (
    panel: ToolWindowPanelId | null,
    source?: "html5" | "pointer" | null,
  ) => void;
  setDragOverTarget: (target: DragOverTarget | null) => void;
  toggleLayoutLock: () => void;

  initializeLayout: () => Promise<void>;
  saveLayout: () => void;
  resetToDefaultLayout: () => void;

  applyPreset: (presetId: string) => void;
  saveCurrentAsPreset: (name: string) => Promise<void>;
  deletePreset: (id: string) => Promise<void>;
  renamePreset: (id: string, name: string) => Promise<void>;
  loadPresets: () => Promise<void>;
}

export const useLayoutStore = create<LayoutStoreState>((set, get) => ({
  layout: buildDefaultLayoutState({ allInactive: true }),
  layoutLocked: false,
  draggingPanel: null,
  dragOverTarget: null,
  panelDragSource: null,
  activePresetId: null,
  customPresets: [],
  initialized: false,
  hiddenStripePanels: new Set<ToolWindowPanelId>(),

  setEditorOpen: (open) => {
    const vp = getViewport();
    set((state) => {
      const wasOpen = state.layout.center.editorOpen;
      if (wasOpen === open) return state;

      let next = updateCenter(state.layout, (center) => ({
        ...center,
        editorOpen: open,
        segments: normalizeCenterSegmentRatios(center.segments, open),
      }));

      if (!open) {
        next = redistributeSpaceOnEditorClose(next, vp);
      }

      return { layout: applyValidatedLayout(next, vp) };
    });
    scheduleSave(get);
    if (open) scheduleEditorFocus();
  },

  togglePanel: (panel) => {
    if (panel === "editor") {
      const open = get().layout.center.editorOpen;
      get().setEditorOpen(!open);
      return;
    }

    const toolPanel = panel as ToolWindowPanelId;
    const location = findPanelLocation(get().layout, toolPanel);
    if (!location) return;

    set((state) => {
      const opening = location.slot.activePanel !== toolPanel;
      let next = state.layout;

      if (location.region === "center") {
        next = updateCenterToolSegment(next, location.slot.id, (segment) => ({
          ...segment,
          activePanel: segment.activePanel === toolPanel ? null : toolPanel,
        }));
      } else {
        next = updateRegion(next, location.region, (region) => ({
          ...region,
          slots: region.slots.map((slot) => {
            if (slot.id !== location.slot.id) return slot;
            return {
              ...slot,
              activePanel: slot.activePanel === toolPanel ? null : toolPanel,
            };
          }),
        }));
      }

      return {
        layout: applyValidatedLayout(next),
        hiddenStripePanels: opening
          ? unhideStripePanel(state.hiddenStripePanels, toolPanel)
          : state.hiddenStripePanels,
      };
    });
    scheduleSave(get);
  },

  showPanel: (panel) => {
    if (panel === "editor") {
      get().setEditorOpen(true);
      return;
    }

    const toolPanel = panel as ToolWindowPanelId;
    const location = findPanelLocation(get().layout, toolPanel);
    if (!location) return;
    if (location.slot.activePanel === toolPanel) return;

    set((state) => {
      let next = state.layout;

      if (location.region === "center") {
        next = updateCenterToolSegment(next, location.slot.id, (segment) => ({
          ...segment,
          activePanel: toolPanel,
        }));
      } else {
        next = updateRegion(next, location.region, (region) => ({
          ...region,
          slots: region.slots.map((slot) =>
            slot.id === location.slot.id
              ? { ...slot, activePanel: toolPanel }
              : slot,
          ),
        }));
      }

      return {
        layout: applyValidatedLayout(next),
        hiddenStripePanels: unhideStripePanel(
          state.hiddenStripePanels,
          toolPanel,
        ),
      };
    });
    scheduleSave(get);
  },

  isPanelVisible: (panel) => get().isPanelActive(panel),

  isPanelActive: (panel) => {
    if (panel === "editor") return get().layout.center.editorOpen;
    const location = findPanelLocation(get().layout, panel);
    return location?.slot.activePanel === panel;
  },

  openPanelAtSlot: (panel) => {
    get().showPanel(panel);
  },

  requestEditorFocus: () => {
    scheduleEditorFocus();
  },

  movePanelToSlot: (panel, region, slotId) => {
    if (panel === "editor" || get().layoutLocked) return;
    const toolPanel = panel as ToolWindowPanelId;
    set((state) => ({
      layout: applyValidatedLayout(
        movePanelInLayout(state.layout, toolPanel, region, slotId, null),
      ),
    }));
    scheduleSave(get);
  },

  movePanelToRegion: (panel, region) => {
    if (panel === "editor" || get().layoutLocked) return;
    const toolPanel = panel as ToolWindowPanelId;
    const targetSlots = get().layout.regions[region].slots;
    const lastSlot = targetSlots.at(-1);

    set((state) => ({
      layout: applyValidatedLayout(
        movePanelInLayout(
          state.layout,
          toolPanel,
          region,
          lastSlot?.id ?? null,
          lastSlot ? null : targetSlots.length,
        ),
      ),
    }));
    scheduleSave(get);
  },

  moveToRegion: (panel, region) => {
    get().movePanelToRegion(panel, region);
  },

  removePanelFromStripe: (panel) => {
    if (panel === "editor" || get().layoutLocked) return;
    const toolPanel = panel as ToolWindowPanelId;
    const location = findPanelLocation(get().layout, toolPanel);
    if (!location) return;

    set((state) => {
      const hidden = new Set(state.hiddenStripePanels);
      hidden.add(toolPanel);

      let layout = state.layout;
      if (location.slot.activePanel === toolPanel) {
        if (location.region === "center") {
          layout = applyValidatedLayout(
            updateCenterToolSegment(layout, location.slot.id, (segment) => ({
              ...segment,
              activePanel: null,
            })),
          );
        } else {
          layout = applyValidatedLayout(
            updateRegion(layout, location.region, (region) => ({
              ...region,
              slots: region.slots.map((slot) =>
                slot.id === location.slot.id
                  ? { ...slot, activePanel: null }
                  : slot,
              ),
            })),
          );
        }
      }

      return { layout, hiddenStripePanels: hidden };
    });
    scheduleSave(get);
  },

  movePanelToNewSlot: (panel, region, insertIndex) => {
    if (panel === "editor" || get().layoutLocked) return;
    const toolPanel = panel as ToolWindowPanelId;
    set((state) => ({
      layout: applyValidatedLayout(
        movePanelInLayout(state.layout, toolPanel, region, null, insertIndex),
      ),
    }));
    scheduleSave(get);
  },

  setRegionSize: (region, size, viewport) => {
    if (get().layoutLocked) return;
    get().setRegionSizeLive(region, size, viewport);
    scheduleSave(get);
  },

  setRegionSizeLive: (region, size, viewport) => {
    if (get().layoutLocked) return;
    const vp = viewport ?? getViewport();
    const clamped = clampRegionSize(
      region,
      size,
      vp,
      buildRegionSizeClampContext(get().layout),
    );
    set((state) => {
      const current = state.layout.regions[region].size;
      if (clamped === current) return state;
      return {
        layout: {
          ...state.layout,
          regions: {
            ...state.layout.regions,
            [region]: { ...state.layout.regions[region], size: clamped },
          },
        },
      };
    });
  },

  nudgeRegionSize: (region, deltaPx, viewport) => {
    if (get().layoutLocked || deltaPx === 0) return;
    const vp = viewport ?? getViewport();
    set((state) => {
      const regionState = state.layout.regions[region];
      const current = regionState.size;
      const nextSize = clampRegionSize(
        region,
        current + deltaPx,
        vp,
        buildRegionSizeClampContext(state.layout),
      );
      if (nextSize === current) return state;

      return {
        layout: {
          ...state.layout,
          regions: {
            ...state.layout.regions,
            [region]: { ...regionState, size: nextSize },
          },
        },
      };
    });
  },

  setSlotRatios: (region, slotIdA, slotIdB, ratioA, ratioB, layoutBudgetPx) => {
    if (get().layoutLocked) return;
    if (ratioA <= 0 || ratioB <= 0 || layoutBudgetPx <= 0) return;

    set((state) => {
      const next = applyAdjacentSlotPixelSizes(
        state.layout,
        region,
        slotIdA,
        slotIdB,
        ratioA,
        ratioB,
        layoutBudgetPx,
      );
      return { layout: applyValidatedLayout(next) };
    });
    scheduleSave(get);
  },

  nudgeAdjacentSlotSizes: (
    region,
    slotIdA,
    slotIdB,
    deltaPx,
    layoutBudgetPx,
  ) => {
    if (get().layoutLocked || deltaPx === 0 || layoutBudgetPx <= 0) return;

    set((state) => {
      const pixelSizes = getOpenSlotPixelSizes(
        region,
        state.layout,
        layoutBudgetPx,
      );
      const prevPx = pixelSizes.get(slotIdA) ?? 0;
      const currPx = pixelSizes.get(slotIdB) ?? 0;
      const newPrev = Math.max(MIN_SLOT_SIZE, prevPx + deltaPx);
      const newCurr = Math.max(MIN_SLOT_SIZE, currPx - deltaPx);
      if (newPrev === prevPx && newCurr === currPx) return state;

      const next = applyAdjacentSlotPixelSizes(
        state.layout,
        region,
        slotIdA,
        slotIdB,
        newPrev,
        newCurr,
        layoutBudgetPx,
      );
      return { layout: next };
    });
  },

  setCenterSegmentRatios: (
    segmentIdA,
    segmentIdB,
    ratioA,
    ratioB,
    layoutBudgetPx,
  ) => {
    if (get().layoutLocked) return;
    if (ratioA <= 0 || ratioB <= 0 || layoutBudgetPx <= 0) return;

    set((state) => {
      const next = applyAdjacentCenterSegmentPixelSizes(
        state.layout,
        segmentIdA,
        segmentIdB,
        ratioA,
        ratioB,
        layoutBudgetPx,
      );
      return { layout: applyValidatedLayout(next) };
    });
    scheduleSave(get);
  },

  nudgeAdjacentCenterSegmentSizes: (
    segmentIdA,
    segmentIdB,
    deltaPx,
    layoutBudgetPx,
  ) => {
    if (get().layoutLocked || deltaPx === 0 || layoutBudgetPx <= 0) return;

    set((state) => {
      const pixelSizes = getOpenCenterSegmentPixelSizes(
        state.layout.center,
        layoutBudgetPx,
      );
      const prevPx = pixelSizes.get(segmentIdA) ?? 0;
      const currPx = pixelSizes.get(segmentIdB) ?? 0;
      const newPrev = Math.max(MIN_SLOT_SIZE, prevPx + deltaPx);
      const newCurr = Math.max(MIN_SLOT_SIZE, currPx - deltaPx);
      if (newPrev === prevPx && newCurr === currPx) return state;

      const next = applyAdjacentCenterSegmentPixelSizes(
        state.layout,
        segmentIdA,
        segmentIdB,
        newPrev,
        newCurr,
        layoutBudgetPx,
      );
      return { layout: next };
    });
  },

  finalizeLayoutResize: () => {
    if (get().layoutLocked) return;
    const vp = getViewport();
    set((state) => ({
      layout: applyValidatedLayout(
        clampLayoutStateForViewport(cloneLayoutState(state.layout), vp),
        vp,
      ),
    }));
    scheduleSave(get);
  },

  setDraggingPanel: (panel, source) => {
    if (panel === null) {
      set({ draggingPanel: null, dragOverTarget: null, panelDragSource: null });
      return;
    }
    set({
      draggingPanel: panel,
      panelDragSource: source ?? get().panelDragSource,
    });
  },

  setDragOverTarget: (target) => {
    if (dragTargetsEqual(get().dragOverTarget, target)) return;
    set({ dragOverTarget: target });
  },

  toggleLayoutLock: () =>
    set((state) => ({ layoutLocked: !state.layoutLocked })),

  async initializeLayout() {
    if (get().initialized) return;

    await get().loadPresets();

    const screenshotPanel = getScreenshotPanelId();
    const screenshotCapture = getScreenshotCaptureId();

    if (screenshotCapture) {
      if (screenshotPanel && screenshotPanel !== "editor") {
        const layout = buildDefaultLayoutState({ allInactive: true });
        const loc = findPanelLocation(layout, screenshotPanel);
        if (loc) {
          loc.slot.activePanel = screenshotPanel as ToolWindowPanelId;
        }
        set({ layout: applyValidatedLayout(layout), initialized: true });
        return;
      }

      const presetState = getBuiltinPresetState(
        getScreenshotPresetId(),
        getViewport(),
      );
      if (presetState) {
        set({
          layout: applyValidatedLayout(cloneLayoutState(presetState)),
          activePresetId: getScreenshotPresetId(),
          initialized: true,
        });
        return;
      }
    }

    try {
      const settings = await invoke<
        GlobalSettings & {
          layout?: unknown;
          layoutVersion?: number;
        }
      >("get_global_settings");

      const rawLayout = settings.layout;
      if (isPersistedLayoutV3(rawLayout)) {
        const validated = applyValidatedLayout(
          cloneLayoutState(rawLayout.state),
        );
        set({
          layout: validated,
          activePresetId:
            rawLayout.activePresetId ?? settings.activeLayoutPresetId ?? null,
          hiddenStripePanels: new Set(rawLayout.hiddenStripePanels ?? []),
          initialized: true,
        });
        if (validateLayoutState(rawLayout.state).valid) {
          scheduleSave(get);
        }
        return;
      }

      if (isPersistedLayoutV2(rawLayout)) {
        const v2Persisted = rawLayout as {
          layoutVersion: 2;
          state: Parameters<typeof migrateLayoutStateV2toV3>[0];
          activePresetId?: string;
          hiddenStripePanels?: ToolWindowPanelId[];
        };
        const migrated = migrateLayoutStateV2toV3(v2Persisted.state);
        const validated = applyValidatedLayout(migrated);
        set({
          layout: validated,
          activePresetId:
            v2Persisted.activePresetId ?? settings.activeLayoutPresetId ?? null,
          hiddenStripePanels: new Set(v2Persisted.hiddenStripePanels ?? []),
          initialized: true,
        });
        scheduleSave(get);
        return;
      }
    } catch {
      /* fall through to default */
    }

    const presetLayout = getBuiltinPresetState(
      "builtin:default",
      getViewport(),
    );
    set({
      layout: applyValidatedLayout(
        presetLayout ?? buildDefaultLayoutState({ allInactive: true }),
      ),
      activePresetId: presetLayout ? "builtin:default" : null,
      initialized: true,
    });
    scheduleSave(get);
  },

  saveLayout: () => scheduleSave(get),

  resetToDefaultLayout: () => {
    set({
      layout: buildDefaultLayoutState({ allInactive: true }),
      activePresetId: null,
      hiddenStripePanels: new Set(),
    });
    scheduleSave(get);
    void persistActivePresetId(null);
  },

  applyPreset: (presetId) => {
    const vp = getViewport();
    const builtin = getBuiltinPresetState(presetId, vp);
    if (builtin) {
      set({
        layout: applyValidatedLayout(builtin, vp),
        activePresetId: presetId,
        hiddenStripePanels: new Set(),
      });
      scheduleSave(get);
      void persistActivePresetId(presetId);
      return;
    }

    const custom = get().customPresets.find((p) => p.id === presetId);
    if (custom) {
      set({
        layout: applyValidatedLayout(
          ensureLayoutStateV3(cloneLayoutState(custom.state)),
          vp,
        ),
        activePresetId: presetId,
        hiddenStripePanels: new Set(),
      });
      scheduleSave(get);
      void persistActivePresetId(presetId);
    }
  },

  async saveCurrentAsPreset(name) {
    const id = crypto.randomUUID();
    const preset: CustomLayoutPreset = {
      id,
      name,
      state: cloneLayoutState(get().layout),
    };
    const presets = [...get().customPresets, preset];
    set({ customPresets: presets, activePresetId: id });
    await persistPresets(presets, id);
    scheduleSave(get);
  },

  async deletePreset(id) {
    const presets = get().customPresets.filter((p) => p.id !== id);
    const activeId = get().activePresetId === id ? null : get().activePresetId;
    set({ customPresets: presets, activePresetId: activeId });
    await persistPresets(presets, activeId);
  },

  async renamePreset(id, name) {
    const presets = get().customPresets.map((p) =>
      p.id === id ? { ...p, name } : p,
    );
    set({ customPresets: presets });
    await persistPresets(presets, get().activePresetId);
  },

  async loadPresets() {
    try {
      const settings = await invoke<GlobalSettings>("get_global_settings");
      const raw = settings.layoutPresets;
      const customPresets: CustomLayoutPreset[] = Array.isArray(raw)
        ? raw
            .filter(
              (p): p is { id: string; name: string; state: LayoutState } =>
                p != null &&
                typeof p === "object" &&
                "state" in p &&
                (p as { state: unknown }).state != null,
            )
            .map((p) => ({
              id: p.id,
              name: p.name,
              state: ensureLayoutStateV3(p.state),
            }))
        : [];

      set({
        customPresets,
        activePresetId: settings.activeLayoutPresetId ?? null,
      });
    } catch {
      /* ignore */
    }
  },
}));

export { getBuiltinPresets };
