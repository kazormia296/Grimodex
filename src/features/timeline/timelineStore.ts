import { create } from "zustand";

export type AxisMode = "reading" | "story" | "write";
export type SpacingMode = "uniform" | "proportional";

interface TimelineState {
  axisMode: AxisMode;
  spacingMode: SpacingMode;
  zoom: number;
  scrollOffset: number;
  selectedNodeIds: string[];
  inspectorOpen: boolean;
  display: {
    showTitles: boolean;
    showChapterNumbers: boolean;
    showPhasePins: boolean;
  };
  setAxisMode: (mode: AxisMode) => void;
  setSpacingMode: (mode: SpacingMode) => void;
  setZoom: (zoom: number) => void;
  setScrollOffset: (offset: number) => void;
  selectNode: (id: string) => void;
  clearSelection: () => void;
  toggleInspector: () => void;
  toggleDisplay: (key: keyof TimelineState["display"]) => void;
}

export const useTimelineStore = create<TimelineState>((set) => ({
  axisMode: "reading",
  spacingMode: "uniform",
  zoom: 1,
  scrollOffset: 0,
  selectedNodeIds: [],
  inspectorOpen: false,
  display: {
    showTitles: true,
    showChapterNumbers: true,
    showPhasePins: false,
  },
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
}));
