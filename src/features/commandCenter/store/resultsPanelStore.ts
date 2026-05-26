import { create } from "zustand";

/**
 * 検索パネル (Dockview `command-center-results`) のローカル UI 状態。
 * 検索クエリ・結果は `usePanelStore` (SearchStore) が SSoT で、ここは
 * panel 専用 UI 状態 (フィルタ・hover/selected・focus signal) のみ。
 *
 * フィルタは **exclude 方式** (multi-select)。一度クリックで除外、もう一度で復帰。
 * - excludedSources: scene/codex/snippet のうち非表示にしたい kind の集合
 * - excludedTypes: lexical/semantic のうち非表示にしたい検索種別の集合
 */

export type SourceKind = "scene" | "codex" | "snippet";
export type SearchTypeKind = "lexical" | "semantic";

interface ResultsPanelState {
  excludedSources: SourceKind[];
  excludedTypes: SearchTypeKind[];
  selectedItemId: string | null;
  hoveredItemId: string | null;
  /** Ctrl+Shift+F → CommandCenterResultsPanel が watch して input.focus() */
  focusRequest: number;

  toggleSource: (kind: SourceKind) => void;
  toggleType: (kind: SearchTypeKind) => void;
  setSelected: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  requestFocus: () => void;
  reset: () => void;
}

function toggle<T extends string>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export const useResultsPanelStore = create<ResultsPanelState>()((set) => ({
  excludedSources: [],
  excludedTypes: [],
  selectedItemId: null,
  hoveredItemId: null,
  focusRequest: 0,

  toggleSource: (kind) =>
    set((s) => ({ excludedSources: toggle(s.excludedSources, kind) })),
  toggleType: (kind) =>
    set((s) => ({ excludedTypes: toggle(s.excludedTypes, kind) })),
  setSelected: (id) => set({ selectedItemId: id }),
  setHovered: (id) => set({ hoveredItemId: id }),
  requestFocus: () => set((s) => ({ focusRequest: s.focusRequest + 1 })),
  reset: () =>
    set({
      excludedSources: [],
      excludedTypes: [],
      selectedItemId: null,
      hoveredItemId: null,
    }),
}));
