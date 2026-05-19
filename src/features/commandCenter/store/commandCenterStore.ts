import { create } from "zustand";
import { nextSearchResultIndex } from "@/features/semantic-search/searchResultSelection";
import { flattenSections } from "../lib/flattenSections";
import { BAR_VISIBLE_LIMIT_PER_SECTION } from "../lib/constants";
import type {
  CommandCenterItem,
  CommandCenterMode,
  CommandCenterSection,
} from "../providers/types";

/**
 * ヘッダー常駐バーの状態。専用ビュー (Dockview パネル) はこの store を購読する。
 *
 * 設計上の主要決定:
 * - `open` は「input がアクティブ / popover を開きたい意思」のみを表す。
 *   空クエリでこれを落とさない (再度 Ctrl+Shift+F しなくても文字を打てば popover が出る UX)。
 * - 実際の popover 表示は `selectPopoverOpen()` の派生値で計算する。
 * - `upsertSection` は provider 単位の差分マージ。`hideWhenEmpty` true かつ 0 件で
 *   loading/error 状態も無いなら section を結果配列から除外する。
 */

interface CommandCenterState {
  open: boolean;
  mode: CommandCenterMode;
  /** input の raw 値 (prefix 含む) */
  query: string;
  /** prefix を剥がした検索本文 */
  parsedQuery: string;
  sections: CommandCenterSection[];
  /** flatItems index (空のときは 0) */
  selectedIndex: number;
  /** Ctrl+Shift+F → CommandCenterBar が watch して input.focus() */
  focusRequest: number;

  setOpen: (v: boolean) => void;
  setQuery: (q: string) => void;
  setMode: (m: CommandCenterMode) => void;
  setParsedQuery: (q: string) => void;
  upsertSection: (
    section: CommandCenterSection,
    hideWhenEmpty: boolean,
  ) => void;
  removeSection: (sectionId: string) => void;
  moveSelection: (dir: "up" | "down") => void;
  executeSelected: () => void;
  requestFocus: () => void;
  /** クエリ + sections + selectedIndex をクリア。open/mode は維持。 */
  reset: () => void;
}

export const useCommandCenterStore = create<CommandCenterState>()(
  (set, get) => ({
    open: false,
    mode: "search",
    query: "",
    parsedQuery: "",
    sections: [],
    selectedIndex: 0,
    focusRequest: 0,

    setOpen: (v) => set({ open: v }),
    setQuery: (q) => set({ query: q }),
    setMode: (m) => set({ mode: m }),
    setParsedQuery: (q) => set({ parsedQuery: q }),

    upsertSection: (section, hideWhenEmpty) => {
      set((state) => {
        const filtered = state.sections.filter((s) => s.id !== section.id);
        const stateKind = section.state?.kind ?? "idle";
        const isEmpty = section.items.length === 0;
        const shouldHide =
          hideWhenEmpty &&
          isEmpty &&
          stateKind !== "loading" &&
          stateKind !== "error";
        const next = shouldHide ? filtered : [...filtered, section];
        next.sort((a, b) => a.order - b.order);
        const flatLen = barVisibleFlat(next).length;
        const clampedIdx =
          flatLen === 0 ? 0 : Math.min(state.selectedIndex, flatLen - 1);
        return { sections: next, selectedIndex: clampedIdx };
      });
    },

    removeSection: (sectionId) => {
      set((state) => {
        const next = state.sections.filter((s) => s.id !== sectionId);
        const flatLen = barVisibleFlat(next).length;
        const clampedIdx =
          flatLen === 0 ? 0 : Math.min(state.selectedIndex, flatLen - 1);
        return { sections: next, selectedIndex: clampedIdx };
      });
    },

    moveSelection: (dir) => {
      const { sections, selectedIndex } = get();
      // selectedIndex は **バーが表示中の** flat items に対する index。
      // パネル mount 中 store の各 section に 50 件入っていても、バー側は
      // BAR_VISIBLE_LIMIT_PER_SECTION で slice したものを表示するので、
      // ↑↓ の境界もそれに合わせる。
      const flat = barVisibleFlat(sections);
      const nextIdx = nextSearchResultIndex(selectedIndex, dir, flat.length);
      if (nextIdx !== null) set({ selectedIndex: nextIdx });
    },

    executeSelected: () => {
      const { sections, selectedIndex } = get();
      const flat = barVisibleFlat(sections);
      const item = flat[selectedIndex];
      if (item) item.onSelect();
    },

    requestFocus: () =>
      set((state) => ({ focusRequest: state.focusRequest + 1 })),

    reset: () =>
      set({ query: "", parsedQuery: "", sections: [], selectedIndex: 0 }),
  }),
);

/**
 * popover の実際の表示有無は `open` 単独ではなく、parsedQuery が非空であるかも見る。
 * 空クエリ時に open を false にしない設計を補完する派生 selector。
 */
export function selectPopoverOpen(state: {
  open: boolean;
  parsedQuery: string;
}): boolean {
  return state.open && state.parsedQuery.trim().length > 0;
}

/**
 * バーが popover に表示する範囲の flat items。
 * Store 内の sections は panel 用に 50 件入りうるが、バー側は
 * BAR_VISIBLE_LIMIT_PER_SECTION で slice した範囲のみナビゲートする。
 *
 * `useCommandCenterKeyboard` のテストおよび `selectedIndex` の clamp で共有。
 */
export function barVisibleFlat(
  sections: readonly CommandCenterSection[],
): CommandCenterItem[] {
  const sliced = sections.map((s) => ({
    ...s,
    items: s.items.slice(0, BAR_VISIBLE_LIMIT_PER_SECTION),
  }));
  return flattenSections(sliced);
}
