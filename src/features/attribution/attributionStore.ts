import { create } from "zustand";

export type AttributionScope = "scene" | "project";
export type FilterSource = "human" | "ai" | "unknown" | null;

interface AttributionState {
  showAttribution: boolean;
  scope: AttributionScope;
  filterSource: FilterSource;
  toggleAttribution: () => void;
  setScope: (scope: AttributionScope) => void;
  setFilterSource: (source: FilterSource) => void;
}

export const useAttributionStore = create<AttributionState>()((set) => ({
  showAttribution: false,
  scope: "scene",
  filterSource: null,
  toggleAttribution: () =>
    set((s) => ({ showAttribution: !s.showAttribution })),
  setScope: (scope) => set({ scope }),
  setFilterSource: (source) =>
    set((s) => ({
      filterSource: source,
      showAttribution: source !== null ? true : s.showAttribution,
    })),
}));
