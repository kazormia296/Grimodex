import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type { GlobalSettings } from "@/features/workspace/store";

export type AxisMode = "reading" | "story" | "write";
export type SpacingMode = "uniform" | "proportional";
/** シーン年表(scenes) か、プロットスレッドのレーン表示(threads) か。 */
export type TimelineViewMode = "scenes" | "threads";

export interface TimelineSettings {
  axisMode: AxisMode;
  spacingMode: SpacingMode;
  viewMode: TimelineViewMode;
  zoom: number;
  scrollOffset: number;
  display: {
    showTitles: boolean;
    showChapterNumbers: boolean;
    showPhasePins: boolean;
  };
}

/** 最後に単一選択したノードの id (rangeSelectTo の基準点) */
let lastSingleSelectId: string | null = null;

const DEFAULT_DISPLAY: TimelineSettings["display"] = {
  showTitles: true,
  showChapterNumbers: true,
  showPhasePins: false,
};

interface TimelineState {
  axisMode: AxisMode;
  spacingMode: SpacingMode;
  viewMode: TimelineViewMode;
  zoom: number;
  scrollOffset: number;
  selectedNodeIds: string[];
  inspectorOpen: boolean;
  display: TimelineSettings["display"];
  /** F2 ラベル編集ターゲット。インスペクターが読んで input にフォーカスする */
  pendingEditNodeId: string | null;
  /** threads モードで選択中のプロットマーカー(plot_thread_scene_links.id)。 */
  selectedPlotLinkId: string | null;
  /** threads モードで選択中のスレッド(plot_threads.id)。レーン見出しクリックで設定。 */
  selectedPlotThreadId: string | null;
  setAxisMode: (mode: AxisMode) => void;
  setViewMode: (mode: TimelineViewMode) => void;
  setSelectedPlotLinkId: (id: string | null) => void;
  setSelectedPlotThreadId: (id: string | null) => void;
  setSpacingMode: (mode: SpacingMode) => void;
  setZoom: (zoom: number) => void;
  setScrollOffset: (offset: number) => void;
  selectNode: (id: string) => void;
  toggleSelect: (id: string) => void;
  rangeSelectTo: (id: string, orderedIds: string[]) => void;
  clearSelection: () => void;
  toggleInspector: () => void;
  toggleDisplay: (key: keyof TimelineState["display"]) => void;
  setPendingEditNodeId: (id: string | null) => void;
  loadFromSettings: (settings: Partial<TimelineSettings>) => void;
}

export const useTimelineStore = create<TimelineState>((set, get) => ({
  axisMode: "reading",
  spacingMode: "uniform",
  viewMode: "scenes",
  zoom: 1,
  scrollOffset: 0,
  selectedNodeIds: [],
  inspectorOpen: false,
  display: { ...DEFAULT_DISPLAY },
  pendingEditNodeId: null,
  selectedPlotLinkId: null,
  selectedPlotThreadId: null,
  setAxisMode: (mode) =>
    set({
      axisMode: mode,
      spacingMode: mode === "reading" ? "uniform" : "proportional",
    }),
  setViewMode: (viewMode) => set({ viewMode }),
  setSelectedPlotLinkId: (selectedPlotLinkId) => set({ selectedPlotLinkId }),
  setSelectedPlotThreadId: (selectedPlotThreadId) =>
    set({ selectedPlotThreadId }),
  setSpacingMode: (spacingMode) => set({ spacingMode }),
  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(4, zoom)) }),
  setScrollOffset: (scrollOffset) => set({ scrollOffset }),
  selectNode: (id) => {
    lastSingleSelectId = id;
    set({ selectedNodeIds: [id] });
  },
  toggleSelect: (id) =>
    set((s) => ({
      selectedNodeIds: s.selectedNodeIds.includes(id)
        ? s.selectedNodeIds.filter((x) => x !== id)
        : [...s.selectedNodeIds, id],
    })),
  rangeSelectTo: (id, orderedIds) => {
    // Prefer the last explicitly single-selected node as anchor;
    // fall back to the first currently selected node.
    const anchor =
      lastSingleSelectId ?? get().selectedNodeIds[0] ?? orderedIds[0];
    const anchorIdx = orderedIds.indexOf(anchor);
    const targetIdx = orderedIds.indexOf(id);
    if (anchorIdx === -1 || targetIdx === -1) {
      set({ selectedNodeIds: [id] });
      return;
    }
    const lo = Math.min(anchorIdx, targetIdx);
    const hi = Math.max(anchorIdx, targetIdx);
    set({ selectedNodeIds: orderedIds.slice(lo, hi + 1) });
  },
  clearSelection: () => {
    lastSingleSelectId = null;
    set({
      selectedNodeIds: [],
      selectedPlotLinkId: null,
      selectedPlotThreadId: null,
    });
  },
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  toggleDisplay: (key) =>
    set((s) => ({ display: { ...s.display, [key]: !s.display[key] } })),
  setPendingEditNodeId: (id) => set({ pendingEditNodeId: id }),
  loadFromSettings: (settings) =>
    set({
      axisMode: settings.axisMode ?? "reading",
      spacingMode: settings.spacingMode ?? "uniform",
      viewMode: settings.viewMode ?? "scenes",
      zoom: Math.max(0.25, Math.min(4, settings.zoom ?? 1)),
      scrollOffset: settings.scrollOffset ?? 0,
      display: settings.display ?? { ...DEFAULT_DISPLAY },
    }),
}));

function snapshotPersistent(
  state: ReturnType<typeof useTimelineStore.getState>,
): TimelineSettings {
  return {
    axisMode: state.axisMode,
    spacingMode: state.spacingMode,
    viewMode: state.viewMode,
    zoom: state.zoom,
    scrollOffset: state.scrollOffset,
    display: state.display,
  };
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let prevPersistent = snapshotPersistent(useTimelineStore.getState());

useTimelineStore.subscribe((state) => {
  const next = snapshotPersistent(state);
  if (JSON.stringify(next) === JSON.stringify(prevPersistent)) return;
  prevPersistent = next;

  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const current = await invoke<GlobalSettings>("get_global_settings");
      await invoke("save_global_settings", {
        settings: { ...current, timeline: next },
      });
    } catch (e) {
      if (import.meta.env.MODE !== "test") {
        console.warn("[timeline] save failed:", e);
      }
    }
  }, 500);
});

/**
 * Load persisted timeline settings and immediately sync prevPersistent,
 * cancelling the spurious save-back IPC that loadFromSettings would otherwise schedule.
 * Use this instead of calling loadFromSettings() directly.
 */
export function loadAndSyncTimelineSettings(
  settings: Partial<TimelineSettings>,
) {
  useTimelineStore.getState().loadFromSettings(settings);
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  prevPersistent = snapshotPersistent(useTimelineStore.getState());
}
