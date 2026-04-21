import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { GlobalSettings } from "@/features/workspace/store";
import type {
  MapMode,
  ShowFlags,
  MapPersistentState,
  SceneDisplayVariant,
  ColorByAxis,
} from "./types";
import { resolveSceneVariant } from "./types";

const DEFAULT_SCENE_DISPLAY: Record<MapMode, SceneDisplayVariant> = {
  free: "auto",
  time: "auto",
  theme: "auto",
  pov: "auto",
  place: "auto",
};

interface MapState {
  mode: MapMode;
  viewport: { x: number; y: number; zoom: number };
  show: ShowFlags;
  gridSnap: boolean;
  minimapVisible: boolean;
  sceneDisplayByMode: Record<MapMode, SceneDisplayVariant>;
  colorBy: ColorByAxis;
  corkboardFeel: boolean;
  // transient UI state (not persisted)
  searchVisible: boolean;

  setMode: (mode: MapMode) => void;
  setViewport: (viewport: { x: number; y: number; zoom: number }) => void;
  setShow: (show: Partial<ShowFlags>) => void;
  setGridSnap: (v: boolean) => void;
  setMinimapVisible: (v: boolean) => void;
  setSceneDisplayForMode: (mode: MapMode, variant: SceneDisplayVariant) => void;
  setColorBy: (axis: ColorByAxis) => void;
  setCorkboardFeel: (v: boolean) => void;
  setSearchVisible: (v: boolean) => void;
  effectiveSceneVariant: (mode: MapMode) => "compact" | "card" | "image";
  loadFromSettings: (settings: GlobalSettings) => void;
}

const DEFAULT_SHOW: ShowFlags = {
  scenes: true,
  codex: true,
  notes: false,
  ai: false,
  derivedEdges: true,
  userEdges: false,
  frames: true,
};

export const useMapStore = create<MapState>((set, get) => ({
  mode: "free",
  viewport: { x: 0, y: 0, zoom: 1 },
  show: DEFAULT_SHOW,
  gridSnap: false,
  minimapVisible: false,
  sceneDisplayByMode: { ...DEFAULT_SCENE_DISPLAY },
  colorBy: "none",
  corkboardFeel: false,
  searchVisible: false,

  setMode: (mode) => set({ mode }),
  setViewport: (viewport) => set({ viewport }),
  setShow: (partial) => set((s) => ({ show: { ...s.show, ...partial } })),
  setGridSnap: (v) => set({ gridSnap: v }),
  setMinimapVisible: (v) => set({ minimapVisible: v }),
  setSceneDisplayForMode: (mode, variant) =>
    set((s) => ({
      sceneDisplayByMode: { ...s.sceneDisplayByMode, [mode]: variant },
    })),
  setColorBy: (axis) => set({ colorBy: axis }),
  setCorkboardFeel: (v) => set({ corkboardFeel: v }),
  setSearchVisible: (v) => set({ searchVisible: v }),
  effectiveSceneVariant: (mode) =>
    resolveSceneVariant(get().sceneDisplayByMode[mode], mode),

  loadFromSettings: (settings) => {
    const saved = settings.map as MapPersistentState | undefined;
    if (!saved) return;
    set({
      mode: saved.mode ?? "free",
      viewport: saved.viewport ?? { x: 0, y: 0, zoom: 1 },
      show: { ...DEFAULT_SHOW, ...saved.show },
      gridSnap: saved.gridSnap ?? false,
      minimapVisible: saved.minimapVisible ?? false,
      sceneDisplayByMode: {
        ...DEFAULT_SCENE_DISPLAY,
        ...(saved.sceneDisplayByMode ?? {}),
      },
      colorBy: saved.colorBy ?? "none",
      corkboardFeel: saved.corkboardFeel ?? false,
    });
  },
}));

// Snapshot helper — only fields that should be persisted
function snapshotPersistent(s: MapState): MapPersistentState {
  return {
    mode: s.mode,
    viewport: s.viewport,
    show: s.show,
    gridSnap: s.gridSnap,
    minimapVisible: s.minimapVisible,
    sceneDisplayByMode: s.sceneDisplayByMode,
    colorBy: s.colorBy,
    corkboardFeel: s.corkboardFeel,
  };
}

// Subscribe for auto-persistence to global-settings.json
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
