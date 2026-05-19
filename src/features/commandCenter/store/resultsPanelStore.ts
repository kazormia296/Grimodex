import { create } from "zustand";

/**
 * 専用ビュー (Dockview パネル `command-center-results`) のローカル状態。
 * バー (commandCenterStore) とは独立 — フィルタ・選択・hover は panel 専用。
 *
 * バーが書く sections は `commandCenterStore` の SSoT で読む。
 *
 * フィルタは **exclude 方式** (multi-select)。一度クリックで除外、もう一度で復帰。
 * - excludedSources: scene/codex/snippet のうち非表示にしたい kind の集合
 * - excludedTypes: lexical/semantic のうち非表示にしたい検索種別の集合
 */

export type SourceKind = "scene" | "codex" | "snippet";
export type SearchTypeKind = "lexical" | "semantic";

interface ResultsPanelState {
  /** Dockview にパネルが mount 中か。limit 切替 (10 ↔ 50) の判定に使う。 */
  mounted: boolean;
  excludedSources: SourceKind[];
  excludedTypes: SearchTypeKind[];
  selectedItemId: string | null;
  hoveredItemId: string | null;

  setMounted: (v: boolean) => void;
  toggleSource: (kind: SourceKind) => void;
  toggleType: (kind: SearchTypeKind) => void;
  setSelected: (id: string | null) => void;
  setHovered: (id: string | null) => void;
  reset: () => void;
}

function toggle<T extends string>(list: T[], item: T): T[] {
  return list.includes(item) ? list.filter((x) => x !== item) : [...list, item];
}

export const useResultsPanelStore = create<ResultsPanelState>()((set) => ({
  mounted: false,
  excludedSources: [],
  excludedTypes: [],
  selectedItemId: null,
  hoveredItemId: null,

  setMounted: (v) => set({ mounted: v }),
  toggleSource: (kind) =>
    set((s) => ({ excludedSources: toggle(s.excludedSources, kind) })),
  toggleType: (kind) =>
    set((s) => ({ excludedTypes: toggle(s.excludedTypes, kind) })),
  setSelected: (id) => set({ selectedItemId: id }),
  setHovered: (id) => set({ hoveredItemId: id }),
  reset: () =>
    set({
      excludedSources: [],
      excludedTypes: [],
      selectedItemId: null,
      hoveredItemId: null,
    }),
}));
