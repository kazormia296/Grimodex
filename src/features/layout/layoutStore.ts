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
  buildDefaultLayoutState,
  cloneLayoutState,
  clampLayoutStateForViewport,
  findPanelLocation,
  generateSlotId,
  getOpenSlots,
  applyAdjacentSlotPixelSizes,
  getOpenSlotPixelSizes,
  normalizeSlotRatios,
  resetLayoutStateToDefault,
  updateRegion,
  validateLayoutState,
} from "./layoutStateUtils";
import { clampRegionSize, MIN_SLOT_SIZE } from "./layoutConstants";
import {
  getBuiltinPresetState,
  getBuiltinPresets,
} from "./layoutPresets";
import type {
  CustomLayoutPreset,
  LayoutState,
  PersistedLayout,
  RegionId,
  SlotState,
  ToolWindowPanelId,
} from "./layoutTypes";
import type { PanelId } from "./panelIds";
import { PANEL_DRAG_TYPE } from "./panelIds";

export type { PanelId };
export { PANEL_DRAG_TYPE };

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

function removePanelFromSlot(
  slots: SlotState[],
  slotIndex: number,
  panel: ToolWindowPanelId,
): { slots: SlotState[] } {
  const slot = slots[slotIndex];
  const removedActive = slot.activePanel === panel;
  const nextPanels = slot.panels.filter((p) => p !== panel);

  if (nextPanels.length === 0) {
    return { slots: slots.filter((_, i) => i !== slotIndex) };
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

function addPanelToSlot(
  slot: SlotState,
  panel: ToolWindowPanelId,
): SlotState {
  const panels = slot.panels.includes(panel)
    ? slot.panels
    : [...slot.panels, panel];
  return { ...slot, panels, activePanel: panel };
}

function movePanelInLayout(
  layout: LayoutState,
  panel: ToolWindowPanelId,
  targetRegion: RegionId,
  targetSlotId: string | null,
  insertIndex: number | null,
): LayoutState {
  const source = findPanelLocation(layout, panel);
  let next = cloneLayoutState(layout);

  if (source) {
    next = updateRegion(next, source.region, (region) => ({
      ...region,
      slots: removePanelFromSlot(region.slots, source.slotIndex, panel).slots,
    }));
  }

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
      insertIndex == null
        ? slots.length
        : Math.max(0, Math.min(insertIndex, slots.length));
    slots.splice(index, 0, newSlot);

    const openSlots = getOpenSlots(slots);
    return {
      ...region,
      slots: openSlots.length > 1 ? normalizeSlotRatios(slots) : slots,
    };
  });

  return next;
}

function isPersistedLayoutV2(
  data: unknown,
): data is PersistedLayout {
  if (!data || typeof data !== "object") return false;
  const obj = data as PersistedLayout;
  return (
    obj.layoutVersion === 2 &&
    obj.state != null &&
    typeof obj.state === "object" &&
    obj.state.regions != null
  );
}

function scheduleSave(get: () => LayoutStoreState) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const { layout, activePresetId, customPresets } = get();
      const check = validateLayoutState(layout, { viewport: getViewport() });
      if (!check.valid) return;

      const current = await invoke<GlobalSettings>("get_global_settings");
      const persisted: PersistedLayout = {
        layoutVersion: 2,
        state: cloneLayoutState(layout),
        activePresetId: activePresetId ?? undefined,
      };

      await invoke("save_global_settings", {
        settings: {
          ...current,
          layoutVersion: 2,
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
    const { layout: _l, toolWindows: _t, stripePanelIds: _s, ...rest } =
      current as GlobalSettings & {
        layout?: unknown;
        toolWindows?: unknown;
        stripePanelIds?: unknown;
      };
    await invoke("save_global_settings", {
      settings: {
        ...rest,
        layoutVersion: 2,
        layout: {
          layoutVersion: 2,
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
  activePresetId: string | null;
  customPresets: CustomLayoutPreset[];
  initialized: boolean;

  togglePanel: (panel: PanelId) => void;
  showPanel: (panel: PanelId) => void;
  isPanelVisible: (panel: PanelId) => boolean;
  isPanelActive: (panel: PanelId) => boolean;
  openPanelAtSlot: (panel: PanelId) => void;
  requestEditorFocus: () => void;

  movePanelToSlot: (
    panel: PanelId,
    region: RegionId,
    slotId: string,
  ) => void;
  movePanelToRegion: (panel: PanelId, region: RegionId) => void;
  moveToRegion: (panel: PanelId, region: RegionId) => void;
  movePanelToNewSlot: (
    panel: PanelId,
    region: RegionId,
    insertIndex: number,
  ) => void;

  setRegionSize: (
    region: RegionId,
    size: number,
    viewport?: { width: number; height: number },
  ) => void;
  /** ドラッグ中の live 更新（永続化は finalizeLayoutResize まで遅延） */
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
  ) => void;
  nudgeAdjacentSlotSizes: (
    region: RegionId,
    slotIdA: string,
    slotIdB: string,
    deltaPx: number,
  ) => void;
  /** Run after resize drag ends: clamp, validate, persist once. */
  finalizeLayoutResize: () => void;

  setDraggingPanel: (panel: ToolWindowPanelId | null) => void;
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
  activePresetId: null,
  customPresets: [],
  initialized: false,

  togglePanel: (panel) => {
    if (panel === "editor") {
      get().requestEditorFocus();
      return;
    }
    const toolPanel = panel as ToolWindowPanelId;
    const location = findPanelLocation(get().layout, toolPanel);
    if (!location) return;

    set((state) => {
      const next = updateRegion(state.layout, location.region, (region) => ({
        ...region,
        slots: region.slots.map((slot) => {
          if (slot.id !== location.slot.id) return slot;
          return {
            ...slot,
            activePanel: slot.activePanel === toolPanel ? null : toolPanel,
          };
        }),
      }));
      return { layout: applyValidatedLayout(next) };
    });
    scheduleSave(get);
  },

  showPanel: (panel) => {
    if (panel === "editor") {
      get().requestEditorFocus();
      return;
    }
    const toolPanel = panel as ToolWindowPanelId;
    const location = findPanelLocation(get().layout, toolPanel);
    if (!location) return;
    if (location.slot.activePanel === toolPanel) return;

    set((state) => {
      const next = updateRegion(state.layout, location.region, (region) => ({
        ...region,
        slots: region.slots.map((slot) =>
          slot.id === location.slot.id
            ? { ...slot, activePanel: toolPanel }
            : slot,
        ),
      }));
      return { layout: applyValidatedLayout(next) };
    });
    scheduleSave(get);
  },

  isPanelVisible: (panel) => get().isPanelActive(panel),

  isPanelActive: (panel) => {
    if (panel === "editor") return true;
    const location = findPanelLocation(get().layout, panel);
    return location?.slot.activePanel === panel;
  },

  openPanelAtSlot: (panel) => {
    get().showPanel(panel);
  },

  requestEditorFocus: () => {
    editorFocusHandler?.();
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
    const clamped = clampRegionSize(region, size, vp);
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
      const nextSize = clampRegionSize(region, current + deltaPx, vp);
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

  setSlotRatios: (region, slotIdA, slotIdB, ratioA, ratioB) => {
    if (get().layoutLocked) return;
    if (ratioA <= 0 || ratioB <= 0) return;

    set((state) => {
      const next = applyAdjacentSlotPixelSizes(
        state.layout,
        region,
        slotIdA,
        slotIdB,
        ratioA,
        ratioB,
      );
      return { layout: applyValidatedLayout(next) };
    });
    scheduleSave(get);
  },

  nudgeAdjacentSlotSizes: (region, slotIdA, slotIdB, deltaPx) => {
    if (get().layoutLocked || deltaPx === 0) return;

    set((state) => {
      const pixelSizes = getOpenSlotPixelSizes(region, state.layout);
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

  setDraggingPanel: (panel) => set({ draggingPanel: panel }),

  toggleLayoutLock: () => set((state) => ({ layoutLocked: !state.layoutLocked })),

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
      if (isPersistedLayoutV2(rawLayout)) {
        const validated = applyValidatedLayout(
          cloneLayoutState(rawLayout.state),
        );
        set({
          layout: validated,
          activePresetId: rawLayout.activePresetId ?? settings.activeLayoutPresetId ?? null,
          initialized: true,
        });
        if (validateLayoutState(rawLayout.state).valid) {
          scheduleSave(get);
        }
        return;
      }
    } catch {
      /* fall through to default */
    }

    const presetLayout = getBuiltinPresetState("builtin:default", getViewport());
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
      });
      scheduleSave(get);
      void persistActivePresetId(presetId);
      return;
    }

    const custom = get().customPresets.find((p) => p.id === presetId);
    if (custom) {
      set({
        layout: applyValidatedLayout(cloneLayoutState(custom.state), vp),
        activePresetId: presetId,
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
              state: p.state,
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
