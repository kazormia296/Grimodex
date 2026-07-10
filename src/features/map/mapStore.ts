import { create } from "zustand";
import { invoke } from "@/lib/tauri";
import type { GlobalSettings } from "@/features/workspace/store";
import { parseShowConfig } from "./mapApi";
import { DEFAULT_SHOW, DEFAULT_GALAXY_FILTERS } from "./types";
import type {
  MapMode,
  ShowFlags,
  MapPersistentState,
  ColorByAxis,
  VisualTheme,
  MapViewKind,
  GalaxyDimension,
  GalaxyFilters,
  GalaxyFiltersPatch,
  MapBoardRecord,
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
  viewKind: MapViewKind;
  galaxyFilters: GalaxyFilters;
  galaxyDimension: GalaxyDimension;
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
  setViewKind: (kind: MapViewKind) => void;
  setGalaxyDimension: (dimension: GalaxyDimension) => void;
  setGalaxyFilters: (patch: GalaxyFiltersPatch) => void;
  setSearchVisible: (v: boolean) => void;
  setPendingAutoArrange: (type: AutoArrangeType | null) => void;
  setFocusedNode: (id: string | null) => void;
  setPendingExport: (type: "svg" | "png" | "json" | null) => void;
  bumpBoardDataVersion: () => void;
  loadFromSettings: (settings: GlobalSettings) => void;
  hydrateFromBoard: (board: MapBoardRecord) => void;
}

// Import here to avoid circular dep — autoArrange types live in layouts
type AutoArrangeType = import("./layouts/autoArrange").AutoArrangeType;

export const useMapStore = create<MapState>((set) => ({
  activeBoardId: null,
  mode: "free",
  viewport: { x: 0, y: 0, zoom: 1 },
  show: DEFAULT_SHOW,
  gridSnap: false,
  minimapVisible: false,
  colorBy: "none",
  visualTheme: "default",
  viewKind: "board",
  galaxyFilters: DEFAULT_GALAXY_FILTERS,
  galaxyDimension: "3d",
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
  setViewKind: (kind) => set({ viewKind: kind }),
  setGalaxyDimension: (dimension) => set({ galaxyDimension: dimension }),
  setGalaxyFilters: (patch) =>
    set((s) => ({
      galaxyFilters: {
        nodes: { ...s.galaxyFilters.nodes, ...patch.nodes },
        edges: { ...s.galaxyFilters.edges, ...patch.edges },
        hideOrphans: patch.hideOrphans ?? s.galaxyFilters.hideOrphans,
      },
    })),
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
      visualTheme: saved.visualTheme ?? "default",
      viewKind: saved.viewKind ?? "board",
      galaxyDimension: saved.galaxyDimension ?? "3d",
      // 旧設定や部分的な保存値でも欠けたフラグはデフォルトで補完する
      galaxyFilters: saved.galaxyFilters
        ? {
            nodes: {
              ...DEFAULT_GALAXY_FILTERS.nodes,
              ...saved.galaxyFilters.nodes,
            },
            edges: {
              ...DEFAULT_GALAXY_FILTERS.edges,
              ...saved.galaxyFilters.edges,
            },
            hideOrphans:
              saved.galaxyFilters.hideOrphans ??
              DEFAULT_GALAXY_FILTERS.hideOrphans,
          }
        : DEFAULT_GALAXY_FILTERS,
    });
  },

  hydrateFromBoard: (board) => {
    set({
      mode: board.mode,
      viewport: {
        x: board.viewportX,
        y: board.viewportY,
        zoom: board.viewportZoom,
      },
      show: parseShowConfig(board.showConfig),
      colorBy: (board.colorBy as ColorByAxis) ?? "none",
    });
  },
}));

function snapshotPersistent(s: MapState): MapPersistentState {
  return {
    activeBoardId: s.activeBoardId,
    gridSnap: s.gridSnap,
    minimapVisible: s.minimapVisible,
    visualTheme: s.visualTheme,
    viewKind: s.viewKind,
    galaxyFilters: s.galaxyFilters,
    galaxyDimension: s.galaxyDimension,
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
