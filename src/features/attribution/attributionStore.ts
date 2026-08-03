import { create } from "zustand";
import {
  readRuntimeSettingBoolean,
  writeRuntimeSetting,
} from "@/features/settings/runtimeSettings";
import type { LayerSetOptions } from "@/features/post-effect/types";

export type AttributionScope = "scene" | "project";
export type FilterSource = "human" | "ai" | "unknown" | null;

interface AttributionState {
  showAttribution: boolean;
  scope: AttributionScope;
  filterSource: FilterSource;
  setShowAttribution: (visible: boolean, opts?: LayerSetOptions) => void;
  toggleAttribution: () => void;
  setScope: (scope: AttributionScope) => void;
  setFilterSource: (source: FilterSource) => void;
  /** Sync runtime state from persisted settings (call after loadAll). */
  initFromSettings: () => void;
}

export const useAttributionStore = create<AttributionState>()((set, get) => ({
  showAttribution: false,
  scope: "scene",
  filterSource: null,
  setShowAttribution: (visible, opts) => {
    if (opts?.persist !== false) {
      writeRuntimeSetting("display.layerAttribution", String(visible));
    }
    set({ showAttribution: visible });
  },
  toggleAttribution: () => get().setShowAttribution(!get().showAttribution),
  setScope: (scope) => set({ scope }),
  setFilterSource: (source) =>
    set((s) => ({
      filterSource: source,
      showAttribution: source !== null ? true : s.showAttribution,
    })),
  initFromSettings: () => {
    set({
      showAttribution: readRuntimeSettingBoolean(
        "display.layerAttribution",
        false,
      ),
    });
  },
}));
