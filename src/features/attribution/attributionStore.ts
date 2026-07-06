import { create } from "zustand";
import { useSettingsStore } from "@/features/settings/settingsStore";

export type AttributionScope = "scene" | "project";
export type FilterSource = "human" | "ai" | "unknown" | null;

interface AttributionState {
  showAttribution: boolean;
  scope: AttributionScope;
  filterSource: FilterSource;
  toggleAttribution: () => void;
  setScope: (scope: AttributionScope) => void;
  setFilterSource: (source: FilterSource) => void;
  /** Sync runtime state from persisted settings (call after loadAll). */
  initFromSettings: () => void;
}

export const useAttributionStore = create<AttributionState>()((set) => ({
  showAttribution: false,
  scope: "scene",
  filterSource: null,
  toggleAttribution: () =>
    set((s) => {
      const next = !s.showAttribution;
      useSettingsStore.getState().set("display.layerAttribution", String(next));
      return { showAttribution: next };
    }),
  setScope: (scope) => set({ scope }),
  setFilterSource: (source) =>
    set((s) => ({
      filterSource: source,
      showAttribution: source !== null ? true : s.showAttribution,
    })),
  initFromSettings: () => {
    set({
      showAttribution: useSettingsStore
        .getState()
        .getBoolean("display.layerAttribution", false),
    });
  },
}));
