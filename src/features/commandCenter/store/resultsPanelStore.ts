import { create } from "zustand";

/**
 * 専用ビュー (Dockview パネル `command-center-results`) のローカル状態。
 * バー (commandCenterStore) とは独立 — フィルタ・選択・hover は panel 専用。
 *
 * バーが書く sections は `commandCenterStore` の SSoT で読む。
 */

export type SourceFilter = "all" | "scene" | "codex" | "snippet";
export type SearchTypeFilter = "all" | "lexical" | "semantic";

interface ResultsPanelState {
  /** Dockview にパネルが mount 中か。limit 切替 (10 ↔ 50) の判定に使う。 */
  mounted: boolean;
  sourceFilter: SourceFilter;
  searchTypeFilter: SearchTypeFilter;
  selectedItemId: string | null;
  hoveredItemId: string | null;

  setMounted: (v: boolean) => void;
  setSourceFilter: (v: SourceFilter) => void;
  setSearchTypeFilter: (v: SearchTypeFilter) => void;
  setSelected: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  reset: () => void;
}

export const useResultsPanelStore = create<ResultsPanelState>()((set) => ({
  mounted: false,
  sourceFilter: "all",
  searchTypeFilter: "all",
  selectedItemId: null,
  hoveredItemId: null,

  setMounted: (v) => set({ mounted: v }),
  setSourceFilter: (v) => set({ sourceFilter: v }),
  setSearchTypeFilter: (v) => set({ searchTypeFilter: v }),
  setSelected: (id) => set({ selectedItemId: id }),
  setHovered: (id) => set({ hoveredItemId: id }),
  reset: () =>
    set({
      sourceFilter: "all",
      searchTypeFilter: "all",
      selectedItemId: null,
      hoveredItemId: null,
    }),
}));
