import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { GlobalSettings } from "@/features/workspace/store";
import type { ShowMode } from "./lib/deriveColumns";

export type SortMode = "reading" | "story-time" | "word-count" | "last-edited";
export type DisplayMode =
  | "dot"
  | "count"
  | "heatmap"
  | "pov-color"
  | "role-aware";

export interface CustomSet {
  id: string;
  name: string;
  codexEntryIds: string[];
}

export interface MatrixSettings {
  showMode: ShowMode;
  sortMode: SortMode;
  displayMode: DisplayMode;
  groupCodexByType: boolean;
  hiddenColumnIds: string[];
  pinnedColumnIds: string[];
  collapsedTypeSections: string[];
  subplotTagName: string;
  tagFilter: Record<ShowMode, string[]>;
  customSets: CustomSet[];
  activeCustomSetId: string | null;
  hideEmptyRows: boolean;
  onlyUneditedRows: boolean;
  bodyBackfillCompleted: boolean;
}

const DEFAULT_TAG_FILTER: Record<ShowMode, string[]> = {
  "codex-all": [],
  "codex-characters": [],
  "codex-locations": [],
  "codex-items": [],
  "codex-lore": [],
  pov: [],
  location: [],
  subplot: [],
  custom: [],
};

const DEFAULT_SETTINGS: MatrixSettings = {
  showMode: "codex-all",
  sortMode: "reading",
  displayMode: "dot",
  groupCodexByType: true,
  hiddenColumnIds: [],
  pinnedColumnIds: [],
  collapsedTypeSections: [],
  subplotTagName: "subplot",
  tagFilter: { ...DEFAULT_TAG_FILTER },
  customSets: [],
  activeCustomSetId: null,
  hideEmptyRows: false,
  onlyUneditedRows: false,
  bodyBackfillCompleted: false,
};

interface MatrixState extends MatrixSettings {
  searchQuery: string;
  collapsedRowIds: Set<string>;
  settingsSaved: boolean;

  setShowMode: (mode: ShowMode) => void;
  setSortMode: (mode: SortMode) => void;
  setDisplayMode: (mode: DisplayMode) => void;
  setTagFilter: (mode: ShowMode, tags: string[]) => void;
  setGroupCodexByType: (v: boolean) => void;
  setHideEmptyRows: (v: boolean) => void;
  setOnlyUneditedRows: (v: boolean) => void;
  togglePinnedColumn: (id: string) => void;
  toggleHiddenColumn: (id: string) => void;
  toggleTypeSection: (type: string) => void;
  setSearchQuery: (q: string) => void;
  toggleRowCollapsed: (id: string) => void;
  loadFromSettings: (settings: GlobalSettings) => void;
  markSettingsSaved: () => void;
}

export const useMatrixStore = create<MatrixState>()((set, get) => ({
  ...DEFAULT_SETTINGS,
  searchQuery: "",
  collapsedRowIds: new Set<string>(),
  settingsSaved: true,

  setShowMode(mode) {
    set({ showMode: mode, settingsSaved: false });
  },
  setSortMode(mode) {
    set({ sortMode: mode, settingsSaved: false });
  },
  setDisplayMode(mode) {
    set({ displayMode: mode, settingsSaved: false });
  },
  setTagFilter(mode, tags) {
    const tf = { ...get().tagFilter, [mode]: tags };
    set({ tagFilter: tf, settingsSaved: false });
  },
  setGroupCodexByType(v) {
    set({ groupCodexByType: v, settingsSaved: false });
  },
  setHideEmptyRows(v) {
    set({ hideEmptyRows: v, settingsSaved: false });
  },
  setOnlyUneditedRows(v) {
    set({ onlyUneditedRows: v, settingsSaved: false });
  },
  togglePinnedColumn(id) {
    set((s) => {
      const pinned = s.pinnedColumnIds.includes(id)
        ? s.pinnedColumnIds.filter((x) => x !== id)
        : [...s.pinnedColumnIds, id];
      return { pinnedColumnIds: pinned, settingsSaved: false };
    });
  },
  toggleHiddenColumn(id) {
    set((s) => {
      const hidden = s.hiddenColumnIds.includes(id)
        ? s.hiddenColumnIds.filter((x) => x !== id)
        : [...s.hiddenColumnIds, id];
      return { hiddenColumnIds: hidden, settingsSaved: false };
    });
  },
  toggleTypeSection(type) {
    set((s) => {
      const collapsed = s.collapsedTypeSections.includes(type)
        ? s.collapsedTypeSections.filter((x) => x !== type)
        : [...s.collapsedTypeSections, type];
      return { collapsedTypeSections: collapsed, settingsSaved: false };
    });
  },
  setSearchQuery(q) {
    set({ searchQuery: q });
  },
  toggleRowCollapsed(id) {
    set((s) => {
      const next = new Set(s.collapsedRowIds);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return { collapsedRowIds: next };
    });
  },
  loadFromSettings(settings) {
    const saved = (
      settings as GlobalSettings & { matrix?: Partial<MatrixSettings> }
    ).matrix;
    if (!saved) return;
    set({
      showMode: saved.showMode ?? DEFAULT_SETTINGS.showMode,
      sortMode: saved.sortMode ?? DEFAULT_SETTINGS.sortMode,
      displayMode: saved.displayMode ?? DEFAULT_SETTINGS.displayMode,
      groupCodexByType:
        saved.groupCodexByType ?? DEFAULT_SETTINGS.groupCodexByType,
      hiddenColumnIds: saved.hiddenColumnIds ?? [],
      pinnedColumnIds: saved.pinnedColumnIds ?? [],
      collapsedTypeSections: saved.collapsedTypeSections ?? [],
      subplotTagName: saved.subplotTagName ?? DEFAULT_SETTINGS.subplotTagName,
      tagFilter: { ...DEFAULT_TAG_FILTER, ...(saved.tagFilter ?? {}) },
      customSets: saved.customSets ?? [],
      activeCustomSetId: saved.activeCustomSetId ?? null,
      hideEmptyRows: saved.hideEmptyRows ?? false,
      onlyUneditedRows: saved.onlyUneditedRows ?? false,
      bodyBackfillCompleted: saved.bodyBackfillCompleted ?? false,
      settingsSaved: true,
    });
  },
  markSettingsSaved() {
    set({ settingsSaved: true });
  },
}));

// ---------------------------------------------------------------------------
// Auto-persist to global-settings.json (600ms debounce)
// ---------------------------------------------------------------------------

function snapshotPersistent(s: MatrixState): MatrixSettings {
  return {
    showMode: s.showMode,
    sortMode: s.sortMode,
    displayMode: s.displayMode,
    groupCodexByType: s.groupCodexByType,
    hiddenColumnIds: s.hiddenColumnIds,
    pinnedColumnIds: s.pinnedColumnIds,
    collapsedTypeSections: s.collapsedTypeSections,
    subplotTagName: s.subplotTagName,
    tagFilter: s.tagFilter,
    customSets: s.customSets,
    activeCustomSetId: s.activeCustomSetId,
    hideEmptyRows: s.hideEmptyRows,
    onlyUneditedRows: s.onlyUneditedRows,
    bodyBackfillCompleted: s.bodyBackfillCompleted,
  };
}

let prevSnapshot = JSON.stringify(
  snapshotPersistent(useMatrixStore.getState()),
);
let saveTimer: ReturnType<typeof setTimeout> | null = null;

useMatrixStore.subscribe((state) => {
  const next = JSON.stringify(snapshotPersistent(state));
  if (next === prevSnapshot) return;
  prevSnapshot = next;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const current = await invoke<GlobalSettings>("get_global_settings");
      const updated = { ...current, matrix: JSON.parse(next) };
      await invoke("save_global_settings", { settings: updated });
      useMatrixStore.getState().markSettingsSaved();
    } catch {
      // non-fatal
    }
  }, 600);
});
