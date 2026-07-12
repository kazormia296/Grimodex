import { create } from "zustand";
import i18next from "@/lib/i18n";
import { guardInlineAiPending } from "@/features/editor/inlineAi/pendingGuard";
import type { GlobalSettings } from "@/lib/globalSettings/GlobalSettings";
import { globalSettingsRepository } from "@/lib/globalSettings/repository";
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
  collectPanelsInLayoutRegion,
  cloneLayoutState,
  clampLayoutStateForViewport,
  ensureLayoutStateV3,
  findPanelLocation,
  generateCenterToolSegmentId,
  generateSlotId,
  getBottomCorners,
  getCenterContentWidthPx,
  getCenterHorizontalReserve,
  getOpenSlotPixelSizes,
  nudgeAdjacentCenterSegmentPixelSizes,
  getOpenSlots,
  isCenterContentVisible,
  migrateLayoutStateV2toV3,
  normalizeCenterSegmentRatios,
  normalizeSlotRatios,
  redistributeSpaceOnEditorClose,
  removePanelFromCenterSegment,
  removePanelFromSlot,
  reorderPanelInCenterSegment,
  reorderPanelInSlot,
  resetLayoutStateToDefault,
  updateCenter,
  updateCenterToolSegment,
  updateRegion,
  validateLayoutState,
} from "./layoutStateUtils";
import { clampRegionSize, MIN_SLOT_SIZE } from "./layoutConstants";
import {
  getBuiltinPresetHiddenPanels,
  getBuiltinPresetState,
  getBuiltinPresets,
  isBuiltinPresetId,
  resolveBuiltinPresetHiddenPanels,
  resolveBuiltinPresetState,
  type BuiltinPresetId,
} from "./layoutPresets";
import type {
  BuiltinPresetOverride,
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
import { recordLayoutSnapshot } from "@/features/timelapse/captureLayout";

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

function getViewport(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1200, height: 800 };
  return { width: window.innerWidth, height: window.innerHeight };
}

/**
 * 候補レイアウトを clamp + validate し、有効ならそれを、無効なら fallback を
 * 返す。validate 失敗は構造上 mutation のバグであり、ユーザーのレイアウトを
 * 既定値で破壊する代わりに遷移自体を棄却する。in-app の mutation では
 * fallback に直前の有効レイアウト（state.layout）を渡すこと。永続データの
 * ロード等、直前状態が無い場面でのみ resetLayoutStateToDefault() を渡す。
 */
export function applyValidatedLayout(
  layout: LayoutState,
  fallback: LayoutState,
  viewport?: { width: number; height: number },
): LayoutState {
  const vp = viewport ?? getViewport();
  // clampLayoutStateForViewport は内部で clone してから作業するため、
  // ここで事前に clone すると純粋な二重コピーになる (perf 2026-06-10)。
  const clamped = clampLayoutStateForViewport(layout, vp);
  const result = validateLayoutState(clamped, { viewport: vp });
  if (result.valid) return clamped;
  return fallback;
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
  hiddenStripePanels?: ReadonlySet<ToolWindowPanelId>,
): LayoutState {
  const source = findPanelLocation(layout, panel);
  if (!source) return layout;
  const isVisibleInStripe = (candidate: ToolWindowPanelId) =>
    !hiddenStripePanels?.has(candidate);

  if (source.region === "center") {
    return updateCenter(layout, (center) => ({
      ...center,
      segments: removePanelFromCenterSegment(
        center.segments,
        source.slotIndex,
        panel,
        center.editorOpen,
        isVisibleInStripe,
      ),
    }));
  }

  return updateRegion(layout, source.region, (region) => ({
    ...region,
    slots: removePanelFromSlot(
      region.slots,
      source.slotIndex,
      panel,
      isVisibleInStripe,
    ).slots,
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
  hiddenStripePanels?: ReadonlySet<ToolWindowPanelId>,
): LayoutState {
  const source = findPanelLocation(layout, panel);

  // 自身が唯一のパネルである slot/segment へ、その slot/segment 自体を
  // ドロップした場合は no-op。removePanelFromSource が slot を先に削除し、
  // 再追加先 ID が失われて panel が宙に浮く → validate 失敗で
  // applyValidatedLayout が全レイアウトをリセットしてしまうため。
  if (
    source != null &&
    targetSlotId != null &&
    source.region === targetRegion &&
    source.slot.id === targetSlotId &&
    source.slot.panels.length === 1
  ) {
    return layout;
  }

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
    next = removePanelFromSource(next, panel, hiddenStripePanels);
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

function serializeBuiltinOverrides(
  overrides: Partial<Record<BuiltinPresetId, BuiltinPresetOverride>>,
): GlobalSettings["builtinLayoutPresetOverrides"] {
  const entries = Object.entries(overrides).filter(
    ([id, o]) => isBuiltinPresetId(id) && o != null,
  ) as [BuiltinPresetId, BuiltinPresetOverride][];
  if (entries.length === 0) return undefined;
  return Object.fromEntries(
    entries.map(([id, o]) => [
      id,
      {
        state: o.state,
        hiddenStripePanels: o.hiddenStripePanels,
      },
    ]),
  );
}

function parseBuiltinOverrides(
  raw: GlobalSettings["builtinLayoutPresetOverrides"],
): Partial<Record<BuiltinPresetId, BuiltinPresetOverride>> {
  if (raw == null || typeof raw !== "object") return {};
  const result: Partial<Record<BuiltinPresetId, BuiltinPresetOverride>> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isBuiltinPresetId(id) || value == null || typeof value !== "object") {
      continue;
    }
    const entry = value as { state?: unknown; hiddenStripePanels?: unknown };
    if (entry.state == null) continue;
    const rawHidden = entry.hiddenStripePanels;
    result[id] = {
      state: ensureLayoutStateV3(entry.state as LayoutState),
      hiddenStripePanels: Array.isArray(rawHidden)
        ? (rawHidden as ToolWindowPanelId[])
        : undefined,
    };
  }
  return result;
}

function scheduleSave(get: () => LayoutStoreState) {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const {
        layout,
        activePresetId,
        customPresets,
        builtinPresetOverrides,
        hiddenStripePanels,
      } = get();
      const check = validateLayoutState(layout, { viewport: getViewport() });
      if (!check.valid) return;

      // 執筆タイムラプス: 確定したレイアウト状態を forward-only 記録 (§17 P0)。
      // scheduleSave は live ドラッグ(setRegionSizeLive)では呼ばれず、500ms
      // デバウンスが burst を 1 スナップショットに畳むため volume bomb にならない。
      // recorder は flush 時に payload を stringify するので clone を渡す
      // (queue から flush までの間に layout が mutate しても記録が壊れない)。
      recordLayoutSnapshot({
        layout: cloneLayoutState(layout),
        activePresetId,
        hiddenStripePanels:
          hiddenStripePanels.size > 0 ? [...hiddenStripePanels] : undefined,
      });

      const persisted: PersistedLayout = {
        layoutVersion: LAYOUT_SCHEMA_VERSION,
        state: cloneLayoutState(layout),
        activePresetId: activePresetId ?? undefined,
        hiddenStripePanels:
          hiddenStripePanels.size > 0 ? [...hiddenStripePanels] : undefined,
      };

      await globalSettingsRepository.patch((current) => ({
        ...current,
        layoutVersion: LAYOUT_SCHEMA_VERSION,
        layout: persisted,
        activeLayoutPresetId: activePresetId ?? null,
        layoutPresets: customPresets.map((p) => ({
          id: p.id,
          name: p.name,
          state: p.state,
          hiddenStripePanels: p.hiddenStripePanels,
        })),
        builtinLayoutPresetOverrides: serializeBuiltinOverrides(
          builtinPresetOverrides,
        ),
      }));
    } catch {
      /* ignore */
    }
  }, 500);
}

async function persistPresets(
  presets: CustomLayoutPreset[],
  activeId: string | null,
  builtinOverrides?: Partial<Record<BuiltinPresetId, BuiltinPresetOverride>>,
) {
  try {
    await globalSettingsRepository.patch((current) => ({
      ...current,
      layoutPresets: presets.map((p) => ({
        id: p.id,
        name: p.name,
        state: p.state,
        hiddenStripePanels: p.hiddenStripePanels,
      })),
      activeLayoutPresetId: activeId,
      ...(builtinOverrides !== undefined
        ? {
            builtinLayoutPresetOverrides:
              serializeBuiltinOverrides(builtinOverrides),
          }
        : {}),
    }));
  } catch {
    /* ignore */
  }
}

async function persistBuiltinOverrides(
  overrides: Partial<Record<BuiltinPresetId, BuiltinPresetOverride>>,
) {
  try {
    await globalSettingsRepository.patch((current) => ({
      ...current,
      builtinLayoutPresetOverrides: serializeBuiltinOverrides(overrides),
    }));
  } catch {
    /* ignore */
  }
}

export async function clearSavedLayout() {
  try {
    await globalSettingsRepository.patch((current) => {
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
      return {
        ...rest,
        layoutVersion: LAYOUT_SCHEMA_VERSION,
        layout: {
          layoutVersion: LAYOUT_SCHEMA_VERSION,
          state: buildDefaultLayoutState({ allInactive: true }),
        },
      };
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
  panelDragOffset: { x: number; y: number } | null;
  stripeSwapMode: "axis-locked" | "free" | null;
  stripeSwapSlotId: string | null;
  stripeSwapOffsets: Partial<Record<ToolWindowPanelId, number>>;
  activePresetId: string | null;
  customPresets: CustomLayoutPreset[];
  builtinPresetOverrides: Partial<
    Record<BuiltinPresetId, BuiltinPresetOverride>
  >;
  initialized: boolean;
  hiddenStripePanels: Set<ToolWindowPanelId>;
  /**
   * 視覚 zoom（最大化）対象パネル。transient — scheduleSave の明示列挙に
   * 含めないため永続化されない。LayoutState は一切変更せず、LayoutShell 側が
   * grid template の差し替えだけで全面表示する（DOM identity 保持）。
   * layout 参照が変わる mutation（パネル開閉/プリセット/リサイズ/DnD）で
   * 自動解除される（store 定義直後の subscribe 参照）。
   */
  maximizedPanelId: PanelId | null;

  togglePanel: (panel: PanelId) => void;
  showPanel: (panel: PanelId) => void;
  isPanelActive: (panel: PanelId) => boolean;
  requestEditorFocus: () => void;
  setEditorOpen: (open: boolean) => void;
  /** 対象パネルが表示中のときのみ視覚 zoom をトグルする（非表示は no-op）。 */
  toggleMaximizePanel: (panel: PanelId) => void;
  clearMaximize: () => void;

  movePanelToSlot: (
    panel: PanelId,
    region: LayoutRegionId,
    slotId: string,
  ) => void;
  movePanelToRegion: (panel: PanelId, region: RegionId) => void;
  removePanelFromStripe: (panel: PanelId) => void;
  collapseLayoutRegion: (region: LayoutRegionId) => void;
  expandLayoutRegion: (region: RegionId) => void;
  removeAllPanelsFromStripeRegion: (region: LayoutRegionId) => void;
  addPanelToStripeSlot: (
    panel: PanelId,
    region: LayoutRegionId,
    slotId: string,
  ) => void;
  /** center stripe の editor バンド等、特定 slot が無い場合に末尾へ tool segment を追加 */
  addPanelToCenterStripe: (panel: PanelId, insertIndex?: number) => void;
  movePanelToNewSlot: (
    panel: PanelId,
    region: LayoutRegionId,
    insertIndex: number,
  ) => void;
  reorderPanelInSlot: (
    panel: PanelId,
    region: LayoutRegionId,
    slotId: string,
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
  /** 現在のビューポート＋カードレイアウトモードで region サイズを再クランプする。 */
  reclampForViewport: () => void;
  /** ボトム指定側の角を side stripe ↔ bottom region で切り替える。 */
  toggleBottomCorner: (side: "left" | "right") => void;

  setDraggingPanel: (
    panel: ToolWindowPanelId | null,
    source?: "html5" | "pointer" | null,
    offset?: { x: number; y: number } | null,
  ) => void;
  setDragOverTarget: (target: DragOverTarget | null) => void;
  setStripeSwapPreview: (
    preview: {
      mode: "axis-locked" | "free";
      slotId: string;
      offsets: Partial<Record<ToolWindowPanelId, number>>;
    } | null,
  ) => void;
  toggleLayoutLock: () => void;

  initializeLayout: () => Promise<void>;
  saveLayout: () => void;
  resetToDefaultLayout: () => void;

  applyPreset: (presetId: string) => void;
  saveCurrentAsPreset: (name: string) => Promise<void>;
  saveCurrentAsBuiltinPreset: (presetId: string) => Promise<void>;
  resetBuiltinPresetToDefault: (presetId: string) => Promise<void>;
  hasBuiltinPresetOverride: (presetId: string) => boolean;
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
  panelDragOffset: null,
  stripeSwapMode: null,
  stripeSwapSlotId: null,
  stripeSwapOffsets: {},
  activePresetId: null,
  customPresets: [],
  builtinPresetOverrides: {},
  initialized: false,
  hiddenStripePanels: new Set<ToolWindowPanelId>(),
  maximizedPanelId: null,

  setEditorOpen: (open) => {
    // editor を閉じる正本。togglePanel("editor") / collapseLayoutRegion("center")
    // / preset 適用後の close もここに集約されるため、pending 中のエディタ消失を
    // 一括で止める。開く側 (open===true) は安全なのでブロックしない。
    if (
      open === false &&
      get().layout.center.editorOpen &&
      guardInlineAiPending()
    )
      return;
    const vp = getViewport();
    set((state) => {
      const wasOpen = state.layout.center.editorOpen;
      if (wasOpen === open) return state;

      // toggle で sizeRatio を再正規化すると hide→show が非可逆になり、
      // editor の幅が復元されない。比率は描画側 (normalizeFlexGrow 等) が
      // 都度正規化するため、ここでは editorOpen フラグのみを変更する。
      let next = updateCenter(state.layout, (center) => ({
        ...center,
        editorOpen: open,
      }));

      if (!open) {
        // center が完全に隠れる場合 redistributeSpaceOnEditorClose が region を
        // 破壊的に拡大する。再表示で editor 幅を復元できるよう、閉じる直前の
        // region サイズを記憶しておく。
        if (!isCenterContentVisible(next)) {
          next = {
            ...next,
            collapsedEditorRegionSizes: {
              left: state.layout.regions.left.size,
              right: state.layout.regions.right.size,
            },
          };
        }
        next = redistributeSpaceOnEditorClose(next, vp);
      } else if (state.layout.collapsedEditorRegionSizes) {
        // 再表示: 記憶した region サイズを復元し editor 幅を再現する。
        const memory = state.layout.collapsedEditorRegionSizes;
        next = {
          ...next,
          regions: {
            ...next.regions,
            left: { ...next.regions.left, size: memory.left },
            right: { ...next.regions.right, size: memory.right },
          },
        };
        delete next.collapsedEditorRegionSizes;
      }

      return { layout: applyValidatedLayout(next, state.layout, vp) };
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
        layout: applyValidatedLayout(next, state.layout),
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
        layout: applyValidatedLayout(next, state.layout),
        hiddenStripePanels: unhideStripePanel(
          state.hiddenStripePanels,
          toolPanel,
        ),
      };
    });
    scheduleSave(get);
  },

  isPanelActive: (panel) => {
    if (panel === "editor") return get().layout.center.editorOpen;
    const location = findPanelLocation(get().layout, panel);
    return location?.slot.activePanel === panel;
  },

  requestEditorFocus: () => {
    scheduleEditorFocus();
  },

  toggleMaximizePanel: (panel) => {
    set((state) => {
      if (state.maximizedPanelId === panel) return { maximizedPanelId: null };
      // 非表示パネルの zoom は無意味（zoom 対象セルが空になる）なので拒否する。
      if (panel === "editor") {
        if (!state.layout.center.editorOpen) return state;
      } else {
        const location = findPanelLocation(
          state.layout,
          panel as ToolWindowPanelId,
        );
        if (location?.slot.activePanel !== panel) return state;
      }
      return { maximizedPanelId: panel };
    });
  },

  clearMaximize: () => {
    if (get().maximizedPanelId === null) return;
    set({ maximizedPanelId: null });
  },

  movePanelToSlot: (panel, region, slotId) => {
    if (panel === "editor" || get().layoutLocked) return;
    const toolPanel = panel as ToolWindowPanelId;
    set((state) => ({
      layout: applyValidatedLayout(
        movePanelInLayout(
          state.layout,
          toolPanel,
          region,
          slotId,
          null,
          state.hiddenStripePanels,
        ),
        state.layout,
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
          state.hiddenStripePanels,
        ),
        state.layout,
      ),
    }));
    scheduleSave(get);
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
            state.layout,
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
            state.layout,
          );
        }
      }

      return { layout, hiddenStripePanels: hidden };
    });
    scheduleSave(get);
  },

  collapseLayoutRegion: (region) => {
    if (region === "center") {
      const wasEditorOpen = get().layout.center.editorOpen;
      if (wasEditorOpen && guardInlineAiPending()) return;
      set((state) => {
        const next = updateCenter(state.layout, (center) => ({
          ...center,
          segments: center.segments.map((segment) =>
            segment.kind === "tool"
              ? { ...segment, activePanel: null }
              : segment,
          ),
        }));
        return { layout: applyValidatedLayout(next, state.layout) };
      });
      if (wasEditorOpen) {
        get().setEditorOpen(false);
      } else {
        scheduleSave(get);
      }
      return;
    }

    set((state) => ({
      layout: applyValidatedLayout(
        updateRegion(state.layout, region, (r) => ({
          ...r,
          slots: r.slots.map((slot) => ({ ...slot, activePanel: null })),
        })),
        state.layout,
      ),
    }));
    scheduleSave(get);
  },

  // collapseLayoutRegion の逆操作。collapse は activePanel を null 化する
  // だけで panels 配列は保持するため、各 slot を先頭 panel で開き直す。
  // collapse 前に開いていた panel は記憶しない（multi-panel slot では
  // 先頭 panel に戻る）。既に開いている slot は上書きしない。
  expandLayoutRegion: (region) => {
    set((state) => ({
      layout: applyValidatedLayout(
        updateRegion(state.layout, region, (r) => ({
          ...r,
          slots: r.slots.map((slot) =>
            slot.activePanel === null && slot.panels.length > 0
              ? { ...slot, activePanel: slot.panels[0] }
              : slot,
          ),
        })),
        state.layout,
      ),
    }));
    scheduleSave(get);
  },

  removeAllPanelsFromStripeRegion: (region) => {
    if (get().layoutLocked) return;
    const panels = collectPanelsInLayoutRegion(get().layout, region);
    if (panels.length === 0) return;
    const panelSet = new Set(panels);

    set((state) => {
      const hidden = new Set(state.hiddenStripePanels);
      for (const panelId of panels) {
        hidden.add(panelId);
      }

      let layout = state.layout;
      if (region === "center") {
        layout = updateCenter(layout, (center) => ({
          ...center,
          segments: center.segments.map((segment) => {
            if (segment.kind !== "tool") return segment;
            return {
              ...segment,
              activePanel:
                segment.activePanel != null && panelSet.has(segment.activePanel)
                  ? null
                  : segment.activePanel,
            };
          }),
        }));
      } else {
        layout = updateRegion(layout, region, (r) => ({
          ...r,
          slots: r.slots.map((slot) => ({
            ...slot,
            activePanel:
              slot.activePanel != null && panelSet.has(slot.activePanel)
                ? null
                : slot.activePanel,
          })),
        }));
      }

      return {
        layout: applyValidatedLayout(layout, state.layout),
        hiddenStripePanels: hidden,
      };
    });
    scheduleSave(get);
  },

  addPanelToStripeSlot: (panel, region, slotId) => {
    if (panel === "editor" || get().layoutLocked) return;
    const toolPanel = panel as ToolWindowPanelId;
    const location = findPanelLocation(get().layout, toolPanel);

    if (location?.region === region && location.slot.id === slotId) {
      get().showPanel(toolPanel);
      return;
    }

    set((state) => ({
      layout: applyValidatedLayout(
        movePanelInLayout(
          state.layout,
          toolPanel,
          region,
          slotId,
          null,
          state.hiddenStripePanels,
        ),
        state.layout,
      ),
      hiddenStripePanels: unhideStripePanel(
        state.hiddenStripePanels,
        toolPanel,
      ),
    }));
    scheduleSave(get);
  },

  addPanelToCenterStripe: (panel, insertIndex) => {
    if (panel === "editor" || get().layoutLocked) return;
    const toolPanel = panel as ToolWindowPanelId;
    const location = findPanelLocation(get().layout, toolPanel);

    if (location?.region === "center") {
      get().showPanel(toolPanel);
      return;
    }

    const index = insertIndex ?? get().layout.center.segments.length;
    const vp = getViewport();
    set((state) => {
      const moved = movePanelInLayout(
        state.layout,
        toolPanel,
        "center",
        null,
        index,
        state.hiddenStripePanels,
      );
      if (moved.center.editorOpen) {
        const clamped = clampLayoutStateForViewport(moved, vp);
        if (
          getCenterContentWidthPx(clamped, vp) <
          getCenterHorizontalReserve(clamped)
        ) {
          return state;
        }
      }
      return {
        layout: applyValidatedLayout(moved, state.layout, vp),
        hiddenStripePanels: unhideStripePanel(
          state.hiddenStripePanels,
          toolPanel,
        ),
      };
    });
    scheduleSave(get);
  },

  movePanelToNewSlot: (panel, region, insertIndex) => {
    if (panel === "editor" || get().layoutLocked) return;
    const toolPanel = panel as ToolWindowPanelId;
    const vp = getViewport();
    set((state) => {
      const moved = movePanelInLayout(
        state.layout,
        toolPanel,
        region,
        null,
        insertIndex,
        state.hiddenStripePanels,
      );
      // 分割で editor が最低幅(MIN_EDITOR_SIZE)を割り込む場合は追加を拒否する。
      if (region === "center" && moved.center.editorOpen) {
        const clamped = clampLayoutStateForViewport(moved, vp);
        if (
          getCenterContentWidthPx(clamped, vp) <
          getCenterHorizontalReserve(clamped)
        ) {
          return state;
        }
      }
      return { layout: applyValidatedLayout(moved, state.layout, vp) };
    });
    scheduleSave(get);
  },

  reorderPanelInSlot: (panel, region, slotId, insertIndex) => {
    if (panel === "editor" || get().layoutLocked) return;
    const toolPanel = panel as ToolWindowPanelId;
    const vp = getViewport();
    set((state) => {
      const location = findPanelLocation(state.layout, toolPanel);
      if (!location || location.slot.id !== slotId) return state;

      let next = cloneLayoutState(state.layout);
      if (region === "center") {
        next = updateCenter(next, (center) => ({
          ...center,
          segments: reorderPanelInCenterSegment(
            center.segments,
            slotId,
            toolPanel,
            insertIndex,
          ),
        }));
      } else {
        next = updateRegion(next, region, (regionState) => ({
          ...regionState,
          slots: reorderPanelInSlot(
            regionState.slots,
            slotId,
            toolPanel,
            insertIndex,
          ),
        }));
      }

      return { layout: applyValidatedLayout(next, state.layout, vp) };
    });
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
    set((state) => {
      const clamped = clampRegionSize(
        region,
        size,
        vp,
        buildRegionSizeClampContext(state.layout),
      );
      const current = state.layout.regions[region].size;
      if (clamped === current) return state;
      const next = cloneLayoutState(state.layout);
      next.regions[region] = { ...next.regions[region], size: clamped };
      // 手動リサイズしたら editor collapse の復元メモリは破棄する。
      delete next.collapsedEditorRegionSizes;
      return { layout: applyValidatedLayout(next, state.layout, vp) };
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
      const next = cloneLayoutState(state.layout);
      next.regions[region] = { ...regionState, size: nextSize };
      // 手動リサイズしたら editor collapse の復元メモリは破棄する。
      delete next.collapsedEditorRegionSizes;
      return { layout: applyValidatedLayout(next, state.layout, vp) };
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
      return { layout: applyValidatedLayout(next, state.layout) };
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
      return { layout: applyValidatedLayout(next, state.layout) };
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
      const nudged = nudgeAdjacentCenterSegmentPixelSizes(
        state.layout.center,
        segmentIdA,
        segmentIdB,
        deltaPx,
        layoutBudgetPx,
      );
      if (!nudged) return state;

      const next = applyAdjacentCenterSegmentPixelSizes(
        state.layout,
        segmentIdA,
        segmentIdB,
        nudged.pxA,
        nudged.pxB,
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
        state.layout,
        vp,
      ),
    }));
    scheduleSave(get);
  },

  reclampForViewport: () => {
    // カードレイアウト ON/OFF 切替で chrome 量が変わるため、保存済みの region
    // サイズを現在のモードに合わせて即座に再クランプする。
    set((state) => ({
      layout: applyValidatedLayout(
        cloneLayoutState(state.layout),
        state.layout,
      ),
    }));
    scheduleSave(get);
  },

  toggleBottomCorner: (side) => {
    if (get().layoutLocked) return;
    set((state) => {
      const current = getBottomCorners(state.layout);
      const next = cloneLayoutState(state.layout);
      next.bottomCorners = { ...current, [side]: !current[side] };
      return { layout: next };
    });
    scheduleSave(get);
  },

  setDraggingPanel: (panel, source, offset) => {
    if (panel === null) {
      set({
        draggingPanel: null,
        dragOverTarget: null,
        panelDragSource: null,
        panelDragOffset: null,
        stripeSwapMode: null,
        stripeSwapSlotId: null,
        stripeSwapOffsets: {},
      });
      return;
    }
    set({
      draggingPanel: panel,
      panelDragSource: source ?? get().panelDragSource,
      panelDragOffset: offset ?? get().panelDragOffset,
    });
  },

  setStripeSwapPreview: (preview) => {
    if (preview === null) {
      set({
        stripeSwapMode: null,
        stripeSwapSlotId: null,
        stripeSwapOffsets: {},
      });
      return;
    }
    set({
      stripeSwapMode: preview.mode,
      stripeSwapSlotId: preview.slotId,
      stripeSwapOffsets: preview.offsets,
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
        set({
          layout: applyValidatedLayout(layout, resetLayoutStateToDefault()),
          initialized: true,
        });
        return;
      }

      const presetId = getScreenshotPresetId();
      const presetState = getBuiltinPresetState(presetId, getViewport());
      if (presetState) {
        set({
          layout: applyValidatedLayout(
            cloneLayoutState(presetState),
            resetLayoutStateToDefault(),
          ),
          activePresetId: presetId,
          hiddenStripePanels: new Set(getBuiltinPresetHiddenPanels(presetId)),
          initialized: true,
        });
        return;
      }
    }

    try {
      const settings = await globalSettingsRepository.read();

      const rawLayout = settings.layout;
      if (isPersistedLayoutV3(rawLayout)) {
        // chronicle 等の新パネルが TOOL_WINDOW_PANEL_IDS に追加されると、それ
        // 以前に保存された v3 カスタムレイアウトは新パネル未登録で
        // validateLayoutState に弾かれ、applyValidatedLayout が builtin:default
        // へリセット (= カスタム配置の永久喪失) してしまう。custom/preset 経路
        // (applyPreset / parseBuiltinOverrides / loadPresets) と同じく、ここでも
        // ensureLayoutStateV3 を通して新パネルを既定スロットへ自己修復注入して
        // から validate する。
        const validated = applyValidatedLayout(
          ensureLayoutStateV3(rawLayout.state),
          resetLayoutStateToDefault(),
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
        // custom/preset 経路と同じ ensureLayoutStateV3 を使う。v2→v3 移行 +
        // 未知パネル除去に加え、新パネル (chronicle 等) の自己修復注入も同時に
        // 行うため、active な v2→v3 アップグレード経路でも chronicle が
        // 注入され validate に弾かれない。
        const migrated = ensureLayoutStateV3(v2Persisted.state);
        const validated = applyValidatedLayout(
          migrated,
          resetLayoutStateToDefault(),
        );
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
        resetLayoutStateToDefault(),
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
    // activeLayoutPresetId は scheduleSave の全量書き込みに含まれる
    scheduleSave(get);
  },

  // 注: applyPreset では preset 原本 (override.state / custom.state) を
  // そのまま ensureLayoutStateV3 に渡してよい — ensureLayoutStateV3 が
  // clone してから strip するため原本は変異しない (エイリアス不変条件は
  // layoutStore.test.ts の「perf 契約」describe が gate)。事前 clone は
  // 純粋な二重コピーだった。activePresetId の永続化は scheduleSave の
  // 全量書き込みに含まれるため、即時の persistActivePresetId は冗長な
  // settings 二重書き込み (= get/save 全量 round-trip ×2) で廃止。
  applyPreset: (presetId) => {
    // preset は editor segment を消す/閉じる可能性があるため pending 中は全ブロック。
    if (guardInlineAiPending()) return;
    const vp = getViewport();
    if (isBuiltinPresetId(presetId)) {
      const override = get().builtinPresetOverrides[presetId];
      const builtin = resolveBuiltinPresetState(presetId, vp, override);
      if (!builtin) return;
      set({
        layout: applyValidatedLayout(
          ensureLayoutStateV3(builtin),
          resetLayoutStateToDefault(),
          vp,
        ),
        activePresetId: presetId,
        hiddenStripePanels: new Set(
          resolveBuiltinPresetHiddenPanels(presetId, override),
        ),
      });
      scheduleSave(get);
      return;
    }

    const custom = get().customPresets.find((p) => p.id === presetId);
    if (custom) {
      set({
        layout: applyValidatedLayout(
          ensureLayoutStateV3(custom.state),
          resetLayoutStateToDefault(),
          vp,
        ),
        activePresetId: presetId,
        hiddenStripePanels: new Set(custom.hiddenStripePanels ?? []),
      });
      scheduleSave(get);
    }
  },

  async saveCurrentAsBuiltinPreset(presetId) {
    if (!isBuiltinPresetId(presetId)) return;
    const { layout, hiddenStripePanels } = get();
    const override: BuiltinPresetOverride = {
      state: cloneLayoutState(layout),
      hiddenStripePanels:
        hiddenStripePanels.size > 0 ? [...hiddenStripePanels] : undefined,
    };
    const builtinPresetOverrides = {
      ...get().builtinPresetOverrides,
      [presetId]: override,
    };
    set({ builtinPresetOverrides, activePresetId: presetId });
    await persistBuiltinOverrides(builtinPresetOverrides);
    // activeLayoutPresetId は scheduleSave の全量書き込みに含まれる
    scheduleSave(get);
  },

  hasBuiltinPresetOverride: (presetId) =>
    isBuiltinPresetId(presetId) &&
    get().builtinPresetOverrides[presetId] != null,

  async resetBuiltinPresetToDefault(presetId) {
    if (!isBuiltinPresetId(presetId)) return;
    const { [presetId]: _removed, ...rest } = get().builtinPresetOverrides;
    set({ builtinPresetOverrides: rest });
    await persistBuiltinOverrides(rest);
    if (get().activePresetId === presetId) {
      const vp = getViewport();
      const builtin = getBuiltinPresetState(presetId, vp);
      if (builtin) {
        set({
          layout: applyValidatedLayout(
            builtin,
            resetLayoutStateToDefault(),
            vp,
          ),
          hiddenStripePanels: new Set(getBuiltinPresetHiddenPanels(presetId)),
        });
        scheduleSave(get);
      }
    }
  },

  async saveCurrentAsPreset(name) {
    const id = crypto.randomUUID();
    const { layout, hiddenStripePanels } = get();
    const preset: CustomLayoutPreset = {
      id,
      name,
      state: cloneLayoutState(layout),
      hiddenStripePanels:
        hiddenStripePanels.size > 0 ? [...hiddenStripePanels] : undefined,
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
      const settings = await globalSettingsRepository.read();
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
            .map((p) => {
              const rawHidden = (p as { hiddenStripePanels?: unknown })
                .hiddenStripePanels;
              return {
                id: p.id,
                name: p.name,
                state: ensureLayoutStateV3(p.state),
                hiddenStripePanels: Array.isArray(rawHidden)
                  ? (rawHidden as ToolWindowPanelId[])
                  : undefined,
              };
            })
        : [];

      const builtinPresetOverrides = parseBuiltinOverrides(
        settings.builtinLayoutPresetOverrides,
      );

      set({
        customPresets,
        builtinPresetOverrides,
        activePresetId: settings.activeLayoutPresetId ?? null,
      });
    } catch {
      /* ignore */
    }
  },
}));

// 視覚 zoom（最大化）はレイアウト操作で自動解除する。全 mutation が layout の
// 参照を必ず差し替えること（no-op パスは state をそのまま返し参照不変）を利用
// し、togglePanel/applyPreset/リサイズ/DnD 等への個別配線なしで網羅する。
// reclampForViewport も layout 参照を差し替えるため、カードレイアウト設定の
// トグルでも zoom は解除される（chrome 量が変わるレイアウト変更なので仕様）。
// setState はここで maximizedPanelId のみ変えるため再帰発火しない
// （2回目の呼び出しでは layout 参照が同一）。
useLayoutStore.subscribe((state, prev) => {
  if (state.maximizedPanelId !== null && state.layout !== prev.layout) {
    useLayoutStore.setState({ maximizedPanelId: null });
  }
});

export { getBuiltinPresets };
