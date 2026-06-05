import { create } from "zustand";
import { persist } from "zustand/middleware";

export type KouetsuTab = "issues" | "editorial" | "comments" | "blocker";
export type IssuesScope = "current" | "project" | "ignored";
export type ProjectGroupBy = "scene" | "codex";

interface KouetsuState {
  activeTab: KouetsuTab;
  activeIssuesScope: IssuesScope;
  /** Editorial タブ (レビュー/疑似コメント/メタ構造) のスコープ。Issues とは独立。 */
  activeEditorialScope: IssuesScope;
  projectGroupBy: ProjectGroupBy;
  /**
   * AnimatedSlotPanel keepalive 中の KouetsuPanel の active 状態。
   * 実行時 UI 状態なので永続化しない (partialize で除外)。CurrentScenePseudoCommentView
   * の scene 追従 reload を hidden 中に bail するために使う。
   */
  panelActive: boolean;
  setActiveTab: (tab: KouetsuTab) => void;
  setActiveIssuesScope: (scope: IssuesScope) => void;
  setActiveEditorialScope: (scope: IssuesScope) => void;
  setProjectGroupBy: (mode: ProjectGroupBy) => void;
  setPanelActive: (active: boolean) => void;
}

export const useKouetsuStore = create<KouetsuState>()(
  persist(
    (set) => ({
      activeTab: "issues",
      activeIssuesScope: "current",
      activeEditorialScope: "current",
      projectGroupBy: "scene",
      panelActive: true,
      setActiveTab: (tab) => set({ activeTab: tab }),
      setActiveIssuesScope: (scope) => set({ activeIssuesScope: scope }),
      setActiveEditorialScope: (scope) => set({ activeEditorialScope: scope }),
      setProjectGroupBy: (mode) => set({ projectGroupBy: mode }),
      setPanelActive: (active) => set({ panelActive: active }),
    }),
    {
      name: "kouetsu-store",
      // panelActive は実行時状態なので永続化しない。
      partialize: (s) => ({
        activeTab: s.activeTab,
        activeIssuesScope: s.activeIssuesScope,
        activeEditorialScope: s.activeEditorialScope,
        projectGroupBy: s.projectGroupBy,
      }),
    },
  ),
);
