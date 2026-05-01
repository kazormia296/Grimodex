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

export interface GridPersistentState {
  display: GridDisplaySettings;
}

interface GridState {
  containerId: string | null;
  display: GridDisplaySettings;

  loadForProject: (projectId: string) => Promise<void>;
  setContainerId: (projectId: string, id: string | null) => Promise<void>;
  setDisplay: (updates: Partial<GridDisplaySettings>) => void;
  loadFromSettings: (settings: GlobalSettings) => void;
}

const DEFAULT_DISPLAY: GridDisplaySettings = {
  showSynopsis: true,
  showBeats: true,
  showCodex: true,
  showLabel: true,
  compactCards: false,
};

export const useGridStore = create<GridState>((set, _get) => ({
  containerId: null,
  display: { ...DEFAULT_DISPLAY },

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

  loadFromSettings(settings) {
    const saved = (settings as GlobalSettings & { grid?: GridPersistentState })
      .grid;
    if (!saved) return;
    set({
      display: { ...DEFAULT_DISPLAY, ...(saved.display ?? {}) },
    });
  },
}));

// Auto-persist display settings to global-settings.json
function snapshotPersistent(s: GridState): GridPersistentState {
  return { display: s.display };
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
