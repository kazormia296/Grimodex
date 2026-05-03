import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { GlobalSettings } from "@/features/workspace/store";
import {
  loadContainerId,
  saveContainerId,
  clearContainerId,
} from "./gridContainerPersistence";
import { useTreeStore } from "@/features/tree/treeStore";
import { toggleSceneSelection, rangeSelectScenes } from "./gridSelection";

export interface GridDisplaySettings {
  showSynopsis: boolean;
  showBeats: boolean;
  showCodex: boolean;
  showStatusLabel: boolean; // StatusBadge のラベル文字表示 (旧 showLabel)
  showLabelBar: boolean; // Label カラーバー表示
  showForeshadow: boolean; // Foreshadow indicator 表示
  compactCards: boolean;
}

export interface GridFilterSettings {
  emptyOnly: boolean;
  hideCompleted: boolean;
  codexFilter: string | null;
  labelFilter: string[];
}

export interface GridPersistentState {
  display: GridDisplaySettings;
  filter: GridFilterSettings;
  toolbarOpen: boolean;
}

interface GridState {
  containerId: string | null;
  display: GridDisplaySettings;
  filter: GridFilterSettings;
  searchQuery: string;
  /** Folder IDs explicitly collapsed (session-only). */
  collapsedFolderIds: Set<string>;
  /** Currently selected scene IDs (session-only, not persisted). */
  selectedSceneIds: Set<string>;
  /** Anchor for Shift+Click range selection. */
  selectionAnchorId: string | null;
  /** Set by requestRevealScene; GridPanel's useEffect consumes and clears this. */
  pendingRevealSceneId: string | null;
  /** Set by GridPanel after scrollIntoView; cleared after highlight duration. */
  revealedSceneId: string | null;

  toolbarOpen: boolean;
  setToolbarOpen: (open: boolean) => void;

  loadForProject: (projectId: string) => Promise<void>;
  setContainerId: (projectId: string, id: string | null) => Promise<void>;
  setDisplay: (updates: Partial<GridDisplaySettings>) => void;
  setFilter: (updates: Partial<GridFilterSettings>) => void;
  setSearchQuery: (q: string) => void;
  clearFilter: () => void;
  toggleFolderCollapsed: (folderId: string) => void;
  expandAllFolders: () => void;
  collapseAllFolders: (folderIds: string[]) => void;
  loadFromSettings: (settings: GlobalSettings) => void;
  /** Select a single scene, resetting any previous selection. */
  selectOnly: (id: string) => void;
  /** Toggle a scene in/out of the selection. */
  toggleSelection: (id: string) => void;
  /** Range-select from current anchor to targetId using the given flat order. */
  rangeSelect: (targetId: string, flatOrder: string[]) => void;
  /** Replace selection with all given IDs. */
  selectAll: (ids: string[]) => void;
  /** Clear all selected scenes. */
  clearSelection: () => void;
  /** Signal Grid panel to reveal this scene (open panel + scroll to card). */
  requestRevealScene: (id: string) => void;
  clearPendingReveal: () => void;
  setRevealedSceneId: (id: string) => void;
  clearRevealedSceneId: () => void;
}

const DEFAULT_DISPLAY: GridDisplaySettings = {
  showSynopsis: true,
  showBeats: true,
  showCodex: true,
  showStatusLabel: true,
  showLabelBar: true,
  showForeshadow: true,
  compactCards: false,
};

const DEFAULT_FILTER: GridFilterSettings = {
  emptyOnly: false,
  hideCompleted: false,
  codexFilter: null,
  labelFilter: [],
};

export const useGridStore = create<GridState>((set, get) => ({
  containerId: null,
  display: { ...DEFAULT_DISPLAY },
  filter: { ...DEFAULT_FILTER },
  toolbarOpen: false,
  searchQuery: "",
  collapsedFolderIds: new Set<string>(),
  selectedSceneIds: new Set<string>(),
  selectionAnchorId: null,
  pendingRevealSceneId: null,
  revealedSceneId: null,

  async loadForProject(projectId) {
    const stored = await loadContainerId(projectId);
    if (stored === null) {
      set({ containerId: null });
      return;
    }
    // Validate: node must exist and be a folder
    const nodes = useTreeStore.getState().nodes;
    const node = nodes.find((n) => n.id === stored);
    if (!node || node.nodeType !== "folder") {
      // Stale ID — remove it
      await clearContainerId(projectId);
      set({ containerId: null });
    } else {
      set({ containerId: stored });
    }
  },

  async setContainerId(projectId, id) {
    set({ containerId: id });
    if (id === null) {
      await clearContainerId(projectId);
    } else {
      await saveContainerId(projectId, id);
    }
  },

  setToolbarOpen(open) {
    set({ toolbarOpen: open });
  },

  setDisplay(updates) {
    set((s) => ({ display: { ...s.display, ...updates } }));
  },

  setFilter(updates) {
    set((s) => ({ filter: { ...s.filter, ...updates } }));
  },

  setSearchQuery(q) {
    set({ searchQuery: q });
  },

  clearFilter() {
    set({ filter: { ...DEFAULT_FILTER } });
  },

  toggleFolderCollapsed(folderId) {
    set((s) => {
      const next = new Set(s.collapsedFolderIds);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      return { collapsedFolderIds: next };
    });
  },

  expandAllFolders() {
    set({ collapsedFolderIds: new Set<string>() });
  },

  collapseAllFolders(folderIds) {
    set({ collapsedFolderIds: new Set<string>(folderIds) });
  },

  loadFromSettings(settings) {
    const saved = (settings as GlobalSettings & { grid?: GridPersistentState })
      .grid;
    if (!saved) return;
    const savedDisplay = (saved.display ?? {}) as unknown as Record<
      string,
      unknown
    >;
    // Backwards compat: old 'showLabel' key → showStatusLabel
    const showStatusLabel =
      (savedDisplay.showStatusLabel as boolean | undefined) ??
      (savedDisplay.showLabel as boolean | undefined) ??
      DEFAULT_DISPLAY.showStatusLabel;
    set({
      display: { ...DEFAULT_DISPLAY, ...savedDisplay, showStatusLabel },
      filter: { ...DEFAULT_FILTER, ...(saved.filter ?? {}) },
      toolbarOpen: saved.toolbarOpen ?? false,
    });
  },

  selectOnly(id) {
    set({ selectedSceneIds: new Set([id]), selectionAnchorId: id });
  },

  toggleSelection(id) {
    set((s) => ({
      selectedSceneIds: toggleSceneSelection(s.selectedSceneIds, id),
      selectionAnchorId: id,
    }));
  },

  rangeSelect(targetId, flatOrder) {
    const anchorId = get().selectionAnchorId;
    if (!anchorId) {
      set({
        selectedSceneIds: new Set([targetId]),
        selectionAnchorId: targetId,
      });
      return;
    }
    set({
      selectedSceneIds: rangeSelectScenes(flatOrder, anchorId, targetId),
    });
  },

  selectAll(ids) {
    set({
      selectedSceneIds: new Set(ids),
      selectionAnchorId: ids[0] ?? null,
    });
  },

  clearSelection() {
    set({ selectedSceneIds: new Set<string>(), selectionAnchorId: null });
  },

  requestRevealScene(id) {
    set({ pendingRevealSceneId: id });
  },

  clearPendingReveal() {
    set({ pendingRevealSceneId: null });
  },

  setRevealedSceneId(id) {
    set({ revealedSceneId: id });
  },

  clearRevealedSceneId() {
    set({ revealedSceneId: null });
  },
}));

// Auto-persist display + filter + toolbar state to global-settings.json
function snapshotPersistent(s: GridState): GridPersistentState {
  return { display: s.display, filter: s.filter, toolbarOpen: s.toolbarOpen };
}

let prevSnapshot = JSON.stringify(snapshotPersistent(useGridStore.getState()));
let saveTimer: ReturnType<typeof setTimeout> | null = null;

useGridStore.subscribe((state) => {
  const next = JSON.stringify(snapshotPersistent(state));
  if (next === prevSnapshot) return;
  prevSnapshot = next;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const current = await invoke<GlobalSettings>("get_global_settings");
      const updated = { ...current, grid: JSON.parse(next) };
      await invoke("save_global_settings", { settings: updated });
    } catch {
      // non-fatal
    }
  }, 600);
});
