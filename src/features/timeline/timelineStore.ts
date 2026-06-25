import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type { GlobalSettings } from "@/features/workspace/store";

export type AxisMode = "reading" | "story" | "write";
export type SpacingMode = "uniform" | "proportional";
/** プロットスレッドの描画レイアウト。
 *  subway = AeonTimeline 風（1イベント1駅・路線が合流分岐・重要度センター配置）。
 *  separated = 各スレッド独立ホーム行・段階チップ（従来）。 */
export type PlotLayout = "subway" | "separated";
/** 旧: シーン年表(scenes) か、プロットスレッドのレーン表示(threads) か。
 *  オーバーレイ化（2026-06-24）で showThreads(boolean) に移行。永続化の後方互換
 *  読み取り（threads → showThreads=true）にのみ残す。 */
export type TimelineViewMode = "scenes" | "threads";

export interface TimelineSettings {
  axisMode: AxisMode;
  spacingMode: SpacingMode;
  /** シーン年表に加えてプロットスレッドのレーンをオーバーレイ表示するか。 */
  showThreads: boolean;
  /** プロットスレッドの描画レイアウト（subway / separated）。 */
  plotLayout: PlotLayout;
  /** separated の並びを subway 式（重要度＋center-out）にするか。 */
  plotSubwaySort?: boolean;
  zoom: number;
  scrollOffset: number;
  /** インスペクタ列の幅(px)。Splitter でドラッグ可変・永続化。 */
  inspectorWidth: number;
  display: {
    showTitles: boolean;
    showChapterNumbers: boolean;
    showPhasePins: boolean;
  };
}

export const INSPECTOR_WIDTH_MIN = 160;
export const INSPECTOR_WIDTH_MAX = 480;
export const INSPECTOR_WIDTH_DEFAULT = 224;
const clampInspectorWidth = (px: number): number =>
  Math.round(Math.max(INSPECTOR_WIDTH_MIN, Math.min(INSPECTOR_WIDTH_MAX, px)));

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
  showThreads: boolean;
  plotLayout: PlotLayout;
  /** separated レイアウトのスレッド並びを subway と同じ「重要度＋center-out」にするか。
   *  false = sortOrder の線形（既定）。 */
  plotSubwaySort: boolean;
  zoom: number;
  scrollOffset: number;
  inspectorWidth: number;
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
  setShowThreads: (show: boolean) => void;
  toggleShowThreads: () => void;
  setPlotLayout: (layout: PlotLayout) => void;
  togglePlotSubwaySort: () => void;
  setSelectedPlotLinkId: (id: string | null) => void;
  setSelectedPlotThreadId: (id: string | null) => void;
  setSpacingMode: (mode: SpacingMode) => void;
  setZoom: (zoom: number) => void;
  setScrollOffset: (offset: number) => void;
  setInspectorWidth: (px: number) => void;
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
  showThreads: false,
  plotLayout: "subway",
  plotSubwaySort: false,
  zoom: 1,
  scrollOffset: 0,
  inspectorWidth: INSPECTOR_WIDTH_DEFAULT,
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
  setShowThreads: (showThreads) => set({ showThreads }),
  toggleShowThreads: () => set((s) => ({ showThreads: !s.showThreads })),
  setPlotLayout: (plotLayout) => set({ plotLayout }),
  togglePlotSubwaySort: () =>
    set((s) => ({ plotSubwaySort: !s.plotSubwaySort })),
  setSelectedPlotLinkId: (selectedPlotLinkId) => set({ selectedPlotLinkId }),
  setSelectedPlotThreadId: (selectedPlotThreadId) =>
    set({ selectedPlotThreadId }),
  setSpacingMode: (spacingMode) => set({ spacingMode }),
  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(4, zoom)) }),
  setScrollOffset: (scrollOffset) => set({ scrollOffset }),
  setInspectorWidth: (px) => set({ inspectorWidth: clampInspectorWidth(px) }),
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
      // 後方互換: 旧 viewMode==="threads" を showThreads=true として読む。
      showThreads:
        settings.showThreads ??
        (settings as { viewMode?: TimelineViewMode }).viewMode === "threads",
      plotLayout: settings.plotLayout ?? "subway",
      plotSubwaySort: settings.plotSubwaySort ?? false,
      zoom: Math.max(0.25, Math.min(4, settings.zoom ?? 1)),
      scrollOffset: settings.scrollOffset ?? 0,
      inspectorWidth: clampInspectorWidth(
        settings.inspectorWidth ?? INSPECTOR_WIDTH_DEFAULT,
      ),
      display: settings.display ?? { ...DEFAULT_DISPLAY },
    }),
}));

function snapshotPersistent(
  state: ReturnType<typeof useTimelineStore.getState>,
): TimelineSettings {
  return {
    axisMode: state.axisMode,
    spacingMode: state.spacingMode,
    showThreads: state.showThreads,
    plotLayout: state.plotLayout,
    plotSubwaySort: state.plotSubwaySort,
    zoom: state.zoom,
    scrollOffset: state.scrollOffset,
    inspectorWidth: state.inspectorWidth,
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
