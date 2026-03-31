import { create } from "zustand";

interface AttributionState {
  showAttribution: boolean;
  toggleAttribution: () => void;
}

export const useAttributionStore = create<AttributionState>()((set) => ({
  showAttribution: false,
  toggleAttribution: () =>
    set((s) => ({ showAttribution: !s.showAttribution })),
}));
