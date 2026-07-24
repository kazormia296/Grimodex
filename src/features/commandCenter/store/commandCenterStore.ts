import { create } from "zustand";
import type { CommandCenterSection } from "../providers/types";

interface SearchState {
  /** input の raw 値。 */
  query: string;
  /** `-word` を除いた検索本文。 */
  parsedQuery: string;
  /** title/subtitle に含む結果を落とす除外語。 */
  excludes: string[];
  /**
   * Semantic 検索の dialogue penalty。true なら会話文の比率が高い chunk を
   * 減点し、地の文を優先する。Lexical 検索には影響しない。
   */
  descriptionMode: boolean;
  sections: CommandCenterSection[];

  setQuery: (query: string) => void;
  setParsedQuery: (query: string) => void;
  setExcludes: (excludes: string[]) => void;
  setDescriptionMode: (value: boolean) => void;
  upsertSection: (
    section: CommandCenterSection,
    hideWhenEmpty: boolean,
  ) => void;
  removeSection: (sectionId: string) => void;
  /** 検索条件と結果を消す。descriptionMode の利用者設定は維持する。 */
  reset: () => void;
}

/** 独立した検索パネルを追加するときにも再利用できる store factory。 */
export function createSearchStore() {
  return create<SearchState>()((set) => ({
    query: "",
    parsedQuery: "",
    excludes: [],
    descriptionMode: false,
    sections: [],

    setQuery: (query) => set({ query }),
    setParsedQuery: (query) => set({ parsedQuery: query }),
    setExcludes: (excludes) => set({ excludes }),
    setDescriptionMode: (descriptionMode) => set({ descriptionMode }),

    upsertSection: (section, hideWhenEmpty) => {
      set((state) => {
        const withoutCurrent = state.sections.filter(
          (current) => current.id !== section.id,
        );
        const stateKind = section.state?.kind ?? "idle";
        const shouldHide =
          hideWhenEmpty &&
          section.items.length === 0 &&
          stateKind !== "loading" &&
          stateKind !== "error";
        const sections = shouldHide
          ? withoutCurrent
          : [...withoutCurrent, section];
        sections.sort((a, b) => a.order - b.order);
        return { sections };
      });
    },

    removeSection: (sectionId) =>
      set((state) => ({
        sections: state.sections.filter((section) => section.id !== sectionId),
      })),

    reset: () =>
      set({
        query: "",
        parsedQuery: "",
        excludes: [],
        sections: [],
      }),
  }));
}

export type SearchStore = ReturnType<typeof createSearchStore>;

/** Dockview の全文検索パネル用 store。 */
export const usePanelStore = createSearchStore();
