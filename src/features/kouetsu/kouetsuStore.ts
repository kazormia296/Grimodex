import { create } from "zustand";

export type KouetsuTab = "issues" | "editorial" | "comments";

interface KouetsuState {
  activeTab: KouetsuTab;
  setActiveTab: (tab: KouetsuTab) => void;
}

export const useKouetsuStore = create<KouetsuState>()((set) => ({
  activeTab: "issues",
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
