import { create } from "zustand";
import { persist } from "zustand/middleware";

export type KouetsuTab = "issues" | "editorial" | "comments";
export type IssuesScope = "current" | "project" | "ignored";

interface KouetsuState {
  activeTab: KouetsuTab;
  activeIssuesScope: IssuesScope;
  setActiveTab: (tab: KouetsuTab) => void;
  setActiveIssuesScope: (scope: IssuesScope) => void;
}

export const useKouetsuStore = create<KouetsuState>()(
  persist(
    (set) => ({
      activeTab: "issues",
      activeIssuesScope: "current",
      setActiveTab: (tab) => set({ activeTab: tab }),
      setActiveIssuesScope: (scope) => set({ activeIssuesScope: scope }),
    }),
    { name: "kouetsu-store" },
  ),
);
