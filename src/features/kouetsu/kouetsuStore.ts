import { create } from "zustand";
import { persist } from "zustand/middleware";

export type KouetsuTab = "issues" | "editorial" | "comments";
export type IssuesScope = "current" | "project" | "ignored";
export type ProjectGroupBy = "scene" | "codex";

interface KouetsuState {
  activeTab: KouetsuTab;
  activeIssuesScope: IssuesScope;
  projectGroupBy: ProjectGroupBy;
  setActiveTab: (tab: KouetsuTab) => void;
  setActiveIssuesScope: (scope: IssuesScope) => void;
  setProjectGroupBy: (mode: ProjectGroupBy) => void;
}

export const useKouetsuStore = create<KouetsuState>()(
  persist(
    (set) => ({
      activeTab: "issues",
      activeIssuesScope: "current",
      projectGroupBy: "scene",
      setActiveTab: (tab) => set({ activeTab: tab }),
      setActiveIssuesScope: (scope) => set({ activeIssuesScope: scope }),
      setProjectGroupBy: (mode) => set({ projectGroupBy: mode }),
    }),
    { name: "kouetsu-store" },
  ),
);
