import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { GlobalSettings } from "@/features/workspace/store";
import type {
  MapMode,
  ShowFlags,
  MapPersistentState,
  ColorByAxis,
  VisualTheme,
} from "./types";

interface MapState {
  activeBoardId: string | null;
  mode: MapMode;
  viewport: { x: number; y: number; zoom: number };
  show: ShowFlags;
  gridSnap: boolean;
  minimapVisible: boolean;
  colorBy: ColorByAxis;
  visualTheme: VisualTheme;
  // transient UI state (not persisted)
  searchVisible: boolean;
  pendingAutoArrange: AutoArrangeType | null;
  focusedNodeId: string | null;
  pendingExport: "svg" | "png" | "json" | null;
  // Bumped when an external action (cross-panel "add to board") modifies
  // map data and the open MapCanvas needs to reload its state.
  boardDataVersion: number;

  setActiveBoardId: (id: string | null) => void;
  setMode: (mode: MapMode) => void;
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  setShow: (show: Partial<ShowFlags>) => void;
  setGridSnap: (v: boolean) => void;
  setMinimapVisible: (v: boolean) => void;
  setColorBy: (axis: ColorByAxis) => void;
  setVisualTheme: (theme: VisualTheme) => void;
  setSearchVisible: (v: boolean) => void;
  setPendingAutoArrange: (type: AutoArrangeType | null) => void;
  setFocusedNode: (id: string | null) => void;
  setPendingExport: (type: "svg" | "png" | "json" | null) => void;
  bumpBoardDataVersion: () => void;
  loadFromSettings: (settings: GlobalSettings) => void;
}

// Import here to avoid circular dep — autoArrange types live in layouts
type AutoArrangeType = import("./layouts/autoArrange").AutoArrangeType;

const DEFAULT_SHOW: ShowFlags = {
  scenes: true,
  codex: true,
  snippets: true,
  notes: false,
  stickies: true,
  aiBranch: false,
  derivedEdges: true,
  userEdges: true,
  frames: true,
};

export const useMapStore = create<MapState>((set) => ({
  activeBoardId: null,
  mode: "free",
  viewport: { x: 0, y: 0, zoom: 1 },
  show: DEFAULT_SHOW,
  gridSnap: false,
  minimapVisible: false,
  colorBy: "none",
  visualTheme: "default",
  searchVisible: false,
  pendingAutoArrange: null,
  focusedNodeId: null,
  pendingExport: null,
  boardDataVersion: 0,

  setActiveBoardId: (id) => set({ activeBoardId: id }),
  setMode: (mode) => set({ mode }),
  setViewport: (viewport) => set({ viewport }),
  setShow: (partial) => set((s) => ({ show: { ...s.show, ...partial } })),
  setGridSnap: (v) => set({ gridSnap: v }),
  setMinimapVisible: (v) => set({ minimapVisible: v }),
  setColorBy: (axis) => set({ colorBy: axis }),
  setVisualTheme: (theme) => set({ visualTheme: theme }),
  setSearchVisible: (v) => set({ searchVisible: v }),
  setPendingAutoArrange: (type) => set({ pendingAutoArrange: type }),
  setFocusedNode: (id) => set({ focusedNodeId: id }),
  setPendingExport: (type) => set({ pendingExport: type }),
  bumpBoardDataVersion: () =>
    set((s) => ({ boardDataVersion: s.boardDataVersion + 1 })),

  loadFromSettings: (settings) => {
    const saved = settings.map as MapPersistentState | undefined;
    if (!saved) return;
    set({
      activeBoardId: saved.activeBoardId ?? null,
      gridSnap: saved.gridSnap ?? false,
      minimapVisible: saved.minimapVisible ?? false,
      colorBy: saved.colorBy ?? "none",
      visualTheme: saved.visualTheme ?? "default",
    });
  },
}));

function snapshotPersistent(s: MapState): MapPersistentState {
  return {
    activeBoardId: s.activeBoardId,
    gridSnap: s.gridSnap,
    minimapVisible: s.minimapVisible,
    colorBy: s.colorBy,
    visualTheme: s.visualTheme,
  };
}

let prevSnapshot = JSON.stringify(snapshotPersistent(useMapStore.getState()));
let saveTimer: ReturnType<typeof setTimeout> | null = null;

useMapStore.subscribe((state) => {
  const next = JSON.stringify(snapshotPersistent(state));
  if (next === prevSnapshot) return;
  prevSnapshot = next;

  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const current = await invoke<GlobalSettings>("get_global_settings");
      const updated = { ...current, map: JSON.parse(next) };
      await invoke("save_global_settings", { settings: updated });
    } catch {
      // persistence errors are non-fatal
    }
  }, 600);
});
