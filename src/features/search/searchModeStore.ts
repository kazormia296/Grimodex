import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * Ctrl+Shift+F で開く検索 Dialog のモード。
 * - `lexical`: 既存の FTS5 全文検索 (`GlobalSearchDialog`)。
 * - `semantic`: ruri-v3 ベースの本文セマンティック検索 (`SemanticSearchDialog`)。
 *
 * 2 つは完全に別 Dialog (結果単位もモードも違う) だが、同じショートカットの
 * 中でタブ切替できるようにし、最後に使ったモードを localStorage に覚えておく。
 */
export type SearchMode = "lexical" | "semantic";

interface SearchModeState {
  mode: SearchMode;
  setMode: (mode: SearchMode) => void;
}

export const useSearchModeStore = create<SearchModeState>()(
  persist(
    (set) => ({
      mode: "lexical",
      setMode: (mode) => set({ mode }),
    }),
    { name: "search-mode-store" },
  ),
);
