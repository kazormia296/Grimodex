import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { GlobalSettings } from "@/features/workspace/store";
import {
  loadContainerId,
  saveContainerId,
  clearContainerId,
} from "./gridContainerPersistence";
import { useTreeStore } from "@/features/tree/treeStore";

export interface GridDisplaySettings {
  showSynopsis: boolean;
  showBeats: boolean;
  showCodex: boolean;
  showLabel: boolean;
  compactCards: boolean;
}

export interface GridFilterSettings {
  emptyOnly: boolean;
  hideCompleted: boolean;
  codexFilter: string | null;
}

export interface GridPersistentState {
  display: GridDisplaySettings;
  filter: GridFilterSettings;
}

interface GridState {
  containerId: string | null;
  display: GridDisplaySettings;
  filter: GridFilterSettings;
  searchQuery: string;
  /**
   * Folder IDs explicitly collapsed (session-only). Default-expanded semantics:
   * a folder is considered expanded iff its ID is NOT in this set.
   */
  collapsedFolderIds: Set<string>;

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
}

const DEFAULT_DISPLAY: GridDisplaySettings = {
  showSynopsis: true,
  showBeats: true,
  showCodex: true,
  showLabel: true,
  compactCards: false,
};

const DEFAULT_FILTER: GridFilterSettings = {
  emptyOnly: false,
  hideCompleted: false,
  codexFilter: null,
};

export const useGridStore = create<GridState>((set, _get) => ({
  containerId: null,
  display: { ...DEFAULT_DISPLAY },
  filter: { ...DEFAULT_FILTER },
  searchQuery: "",
  collapsedFolderIds: new Set<string>(),

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
    set({
      display: { ...DEFAULT_DISPLAY, ...(saved.display ?? {}) },
      filter: { ...DEFAULT_FILTER, ...(saved.filter ?? {}) },
    });
  },
}));

// Auto-persist display + filter settings to global-settings.json
function snapshotPersistent(s: GridState): GridPersistentState {
  return { display: s.display, filter: s.filter };
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
