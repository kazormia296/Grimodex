import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type { GlobalSettings } from "@/features/workspace/store";

export type AxisMode = "reading" | "story" | "write";
export type SpacingMode = "uniform" | "proportional";

export interface TimelineSettings {
  axisMode: AxisMode;
  spacingMode: SpacingMode;
  zoom: number;
  scrollOffset: number;
  display: {
    showTitles: boolean;
    showChapterNumbers: boolean;
    showPhasePins: boolean;
  };
}

const DEFAULT_DISPLAY: TimelineSettings["display"] = {
  showTitles: true,
  showChapterNumbers: true,
  showPhasePins: false,
};

interface TimelineState {
  axisMode: AxisMode;
  spacingMode: SpacingMode;
  zoom: number;
  scrollOffset: number;
  selectedNodeIds: string[];
  inspectorOpen: boolean;
  display: TimelineSettings["display"];
  setAxisMode: (mode: AxisMode) => void;
  setSpacingMode: (mode: SpacingMode) => void;
  setZoom: (zoom: number) => void;
  setScrollOffset: (offset: number) => void;
  selectNode: (id: string) => void;
  clearSelection: () => void;
  toggleInspector: () => void;
  toggleDisplay: (key: keyof TimelineState["display"]) => void;
  loadFromSettings: (settings: Partial<TimelineSettings>) => void;
}

export const useTimelineStore = create<TimelineState>((set) => ({
  axisMode: "reading",
  spacingMode: "uniform",
  zoom: 1,
  scrollOffset: 0,
  selectedNodeIds: [],
  inspectorOpen: false,
  display: { ...DEFAULT_DISPLAY },
  setAxisMode: (mode) =>
    set({
      axisMode: mode,
      spacingMode: mode === "reading" ? "uniform" : "proportional",
    }),
  setSpacingMode: (spacingMode) => set({ spacingMode }),
  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(4, zoom)) }),
  setScrollOffset: (scrollOffset) => set({ scrollOffset }),
  selectNode: (id) => set({ selectedNodeIds: [id] }),
  clearSelection: () => set({ selectedNodeIds: [] }),
  toggleInspector: () => set((s) => ({ inspectorOpen: !s.inspectorOpen })),
  toggleDisplay: (key) =>
    set((s) => ({ display: { ...s.display, [key]: !s.display[key] } })),
  loadFromSettings: (settings) =>
    set({
      axisMode: settings.axisMode ?? "reading",
      spacingMode: settings.spacingMode ?? "uniform",
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
